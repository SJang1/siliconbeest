/**
 * Debug instrumentation for Cloudflare binding objects (D1, KV, R2, Queues).
 *
 * Each `instrument*ForDebug` function patches the methods of a live binding
 * object in place so every operation logs the method name, its arguments,
 * its result, and the call duration through `debugLog` — covering the
 * hundreds of `env.DB` / `env.CACHE` / … call sites without touching them.
 * `debugLog` applies ultra-sensitive redaction before anything is
 * serialized, and two gaps field-name redaction cannot see are closed here:
 *
 * - KV/R2 keys that embed credentials after a prefix (`oauth_session:<token>`,
 *   `token:<hash>`) are redacted after the prefix.
 * - D1 bind parameters are positional; when a statement references any
 *   sensitive-looking column (`password_hash`, `token_hash`, `code`,
 *   `client_secret`, …) its parameters are withheld wholesale. All other
 *   statements log their parameters verbatim.
 *
 * Instrumentation is idempotent per binding object and, because bindings
 * are isolate-wide singletons, one call covers the whole isolate. Callers
 * gate on `isDebugEnabled()` (see each worker's `ensureDebugBindingLogging`),
 * so production isolates never pay for any of this.
 */

import {
	debugLog,
	isDebugEnabled,
	shouldRedactField,
	truncateForDebugLog,
} from './debugLog';

const REDACTED = '[REDACTED]';

/** Cap on rows/keys/objects included in a single logged result. */
export const DEBUG_LOG_MAX_ROWS = 50;

type AnyMethod = (...args: unknown[]) => unknown;

const instrumented = new WeakSet<object>();

/**
 * Replace `target[method]` with a wrapped version bound to the original
 * receiver. Native binding objects are ordinary extensible JS objects in
 * workerd, but if one ever refuses the patch we degrade gracefully rather
 * than break the binding.
 */
function patchMethod(
	target: object,
	method: string,
	wrap: (original: AnyMethod) => AnyMethod,
): void {
	const original = (target as Record<string, unknown>)[method];
	if (typeof original !== 'function') return;
	try {
		Object.defineProperty(target, method, {
			value: wrap((original as AnyMethod).bind(target)),
			writable: true,
			configurable: true,
		});
	} catch (err) {
		console.warn(`[debug] could not instrument ${method}() for debug logging:`, err);
	}
}

/**
 * Run one binding operation, logging its arguments and (summarized) result
 * on success or its error on failure. The original result/error always
 * passes through unchanged.
 */
async function runLoggedOp<T>(
	scope: string,
	message: string,
	details: Record<string, unknown>,
	run: () => Promise<T> | T,
	summarize: (result: T) => unknown,
): Promise<T> {
	if (!isDebugEnabled()) return run();
	const started = performance.now();
	try {
		const result = await run();
		debugLog(scope, message, {
			...details,
			durationMs: Math.round(performance.now() - started),
			result: summarize(result),
		});
		return result;
	} catch (err) {
		debugLog(scope, `${message} threw`, {
			...details,
			durationMs: Math.round(performance.now() - started),
			error: err,
		});
		throw err;
	}
}

// ----------------------------------------------------------------
// Shared summarizers
// ----------------------------------------------------------------

/**
 * Redact the remainder of a storage key whose prefix looks credential-bearing
 * (`oauth_session:<raw token>`, `token:<hash>`, …); positional key strings
 * are invisible to field-name redaction.
 */
function redactStorageKey(key: unknown): unknown {
	if (typeof key !== 'string') return key;
	const separator = key.indexOf(':');
	if (separator === -1) return key;
	const prefix = key.slice(0, separator);
	return shouldRedactField(prefix) || prefix.toLowerCase().includes('session')
		? `${prefix}:${REDACTED}`
		: key;
}

/** Human-readable key for the one-line message (redacted like the details). */
function describeKey(key: unknown): string {
	if (Array.isArray(key)) return `[${key.length} keys]`;
	return String(redactStorageKey(key));
}

function redactKeyArgument(key: unknown): unknown {
	return Array.isArray(key) ? key.map(redactStorageKey) : redactStorageKey(key);
}

/**
 * Summarize a stored value (KV/R2/queue payloads): JSON strings are parsed
 * so field-level redaction reaches inside them, plain strings are truncated,
 * and binary/stream values are described rather than dumped.
 */
function summarizeStoredValue(value: unknown): unknown {
	if (typeof value === 'string') {
		const trimmed = value.trimStart();
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			try {
				return JSON.parse(value);
			} catch {
				// fall through to truncated raw text
			}
		}
		return truncateForDebugLog(value);
	}
	if (value instanceof ArrayBuffer) return `<ArrayBuffer ${value.byteLength} bytes>`;
	if (ArrayBuffer.isView(value)) return `<${value.constructor.name} ${value.byteLength} bytes>`;
	if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) {
		return '<ReadableStream>';
	}
	if (typeof Blob !== 'undefined' && value instanceof Blob) return `<Blob ${value.size} bytes>`;
	return value;
}

function capRows(rows: readonly unknown[]): {
	rowCount: number;
	rows: unknown[];
	rowsTruncated?: boolean;
} {
	return rows.length <= DEBUG_LOG_MAX_ROWS
		? { rowCount: rows.length, rows: [...rows] }
		: { rowCount: rows.length, rows: rows.slice(0, DEBUG_LOG_MAX_ROWS), rowsTruncated: true };
}

// ----------------------------------------------------------------
// D1
// ----------------------------------------------------------------

type D1StatementLike = {
	bind: (...values: unknown[]) => unknown;
	first: (column?: string) => Promise<unknown>;
	run: () => Promise<unknown>;
	all: () => Promise<unknown>;
	raw: (options?: unknown) => Promise<unknown>;
};

type D1ResultLike = { success?: boolean; meta?: unknown; results?: unknown[] };

/**
 * Maps a statement wrapper back to the genuine D1PreparedStatement (plus the
 * SQL/params it carries) so a patched `batch()` can hand the real statements
 * to the underlying driver.
 */
const wrappedStatements = new WeakMap<
	object,
	{ statement: object; sql: string; params?: unknown[] }
>();

/** One-line SQL for the log message: whitespace collapsed, length capped. */
function headlineSql(sql: string): string {
	const collapsed = sql.replace(/\s+/g, ' ').trim();
	return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 119)}…`;
}

/**
 * D1 bind parameters are positional, so field-name redaction cannot apply.
 * If the statement references any sensitive-looking identifier the params
 * are withheld wholesale; otherwise they are logged verbatim.
 */
function summarizeD1Params(sql: string, params: unknown[] | undefined): unknown {
	if (!params || params.length === 0) return params;
	const identifiers = sql.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
	return identifiers.some((identifier) => shouldRedactField(identifier))
		? `[${params.length} params withheld: statement references sensitive columns]`
		: params;
}

/** Keep D1Result metadata verbatim but cap the number of logged rows. */
function summarizeD1Result(result: unknown): unknown {
	if (!result || typeof result !== 'object') return result;
	const { success, meta, results } = result as D1ResultLike;
	if (!Array.isArray(results)) return result;
	return { success, meta, ...capRows(results) };
}

function wrapStatement(
	binding: string,
	statement: object,
	sql: string,
	params?: unknown[],
): object {
	const inner = statement as D1StatementLike;
	const details = () => ({
		sql: truncateForDebugLog(sql),
		params: summarizeD1Params(sql, params),
	});
	const wrapper = {
		bind: (...values: unknown[]) =>
			wrapStatement(binding, inner.bind(...values) as object, sql, values),
		first: (column?: string) =>
			runLoggedOp(
				'd1',
				`${binding}.first ${headlineSql(sql)}`,
				details(),
				() => (column === undefined ? inner.first() : inner.first(column)),
				(row) => row,
			),
		run: () =>
			runLoggedOp(
				'd1',
				`${binding}.run ${headlineSql(sql)}`,
				details(),
				() => inner.run(),
				summarizeD1Result,
			),
		all: () =>
			runLoggedOp(
				'd1',
				`${binding}.all ${headlineSql(sql)}`,
				details(),
				() => inner.all(),
				summarizeD1Result,
			),
		raw: (options?: unknown) =>
			runLoggedOp(
				'd1',
				`${binding}.raw ${headlineSql(sql)}`,
				details(),
				() => (options === undefined ? inner.raw() : inner.raw(options)),
				(rows) => (Array.isArray(rows) ? capRows(rows) : rows),
			),
	};
	wrappedStatements.set(wrapper, { statement, sql, params });
	return wrapper;
}

/**
 * Patch a D1 database binding so every statement logs its SQL, bind
 * parameters, duration, and result (rows capped at DEBUG_LOG_MAX_ROWS).
 * Statements prepared through the patched binding are transparently
 * unwrapped again when passed to `batch()`.
 */
export function instrumentD1ForDebug(db: unknown, bindingName = 'DB'): void {
	if (!db || typeof db !== 'object' || instrumented.has(db)) return;
	instrumented.add(db);

	patchMethod(db, 'prepare', (prepare) => (...args: unknown[]) => {
		const sql = String(args[0]);
		return wrapStatement(bindingName, prepare(...args) as object, sql);
	});

	patchMethod(db, 'batch', (batch) => (...args: unknown[]) => {
		const statements = Array.isArray(args[0]) ? (args[0] as object[]) : [];
		const unwrapped = statements.map((s) => wrappedStatements.get(s)?.statement ?? s);
		const described = statements.map((s) => {
			const info = wrappedStatements.get(s);
			return info
				? { sql: headlineSql(info.sql), params: summarizeD1Params(info.sql, info.params) }
				: '<statement prepared before instrumentation>';
		});
		return runLoggedOp(
			'd1',
			`${bindingName}.batch (${statements.length} statements)`,
			{ statements: described },
			() => batch(unwrapped, ...args.slice(1)) as Promise<unknown>,
			(results) => (Array.isArray(results) ? results.map(summarizeD1Result) : results),
		);
	});

	patchMethod(db, 'exec', (exec) => (...args: unknown[]) => {
		const sql = String(args[0]);
		return runLoggedOp(
			'd1',
			`${bindingName}.exec ${headlineSql(sql)}`,
			{ sql: truncateForDebugLog(sql) },
			() => exec(...args) as Promise<unknown>,
			(result) => result,
		);
	});
}

// ----------------------------------------------------------------
// KV
// ----------------------------------------------------------------

function summarizeKVListResult(result: unknown): unknown {
	if (!result || typeof result !== 'object') return result;
	const record = result as Record<string, unknown>;
	if (!Array.isArray(record.keys)) return result;
	const redactedKeys = record.keys.map((key) =>
		key && typeof key === 'object'
			? { ...(key as object), name: redactStorageKey((key as { name?: unknown }).name) }
			: key,
	);
	const { rowCount, rows, rowsTruncated } = capRows(redactedKeys);
	return {
		...record,
		keyCount: rowCount,
		keys: rows,
		...(rowsTruncated ? { keysTruncated: true } : {}),
	};
}

/**
 * Patch a KV namespace binding so get/put/delete/list log their keys,
 * (summarized) values, options, durations, and results.
 */
export function instrumentKVForDebug(kv: unknown, bindingName: string): void {
	if (!kv || typeof kv !== 'object' || instrumented.has(kv)) return;
	instrumented.add(kv);

	patchMethod(kv, 'get', (get) => (...args: unknown[]) =>
		runLoggedOp(
			'kv',
			`${bindingName}.get ${describeKey(args[0])}`,
			{ key: redactKeyArgument(args[0]), options: args[1] },
			() => get(...args) as Promise<unknown>,
			summarizeStoredValue,
		));

	patchMethod(kv, 'getWithMetadata', (getWithMetadata) => (...args: unknown[]) =>
		runLoggedOp(
			'kv',
			`${bindingName}.getWithMetadata ${describeKey(args[0])}`,
			{ key: redactKeyArgument(args[0]), options: args[1] },
			() => getWithMetadata(...args) as Promise<unknown>,
			(result) =>
				result && typeof result === 'object'
					? {
							...(result as object),
							value: summarizeStoredValue((result as { value?: unknown }).value),
						}
					: result,
		));

	patchMethod(kv, 'put', (put) => (...args: unknown[]) =>
		runLoggedOp(
			'kv',
			`${bindingName}.put ${describeKey(args[0])}`,
			{
				key: redactKeyArgument(args[0]),
				value: summarizeStoredValue(args[1]),
				options: args[2],
			},
			() => put(...args) as Promise<unknown>,
			(result) => result,
		));

	patchMethod(kv, 'delete', (del) => (...args: unknown[]) =>
		runLoggedOp(
			'kv',
			`${bindingName}.delete ${describeKey(args[0])}`,
			{ key: redactKeyArgument(args[0]) },
			() => del(...args) as Promise<unknown>,
			(result) => result,
		));

	patchMethod(kv, 'list', (list) => (...args: unknown[]) =>
		runLoggedOp(
			'kv',
			`${bindingName}.list`,
			{ options: args[0] },
			() => list(...args) as Promise<unknown>,
			summarizeKVListResult,
		));
}

// ----------------------------------------------------------------
// R2
// ----------------------------------------------------------------

/** R2 objects: log identity and metadata, never the body. */
function summarizeR2Object(value: unknown): unknown {
	if (!value || typeof value !== 'object') return value;
	const object = value as Record<string, unknown>;
	if (typeof object.key !== 'string') return value;
	return {
		key: object.key,
		size: object.size,
		etag: object.etag,
		uploaded: object.uploaded,
		httpMetadata: object.httpMetadata,
		customMetadata: object.customMetadata,
	};
}

function summarizeR2ListResult(result: unknown): unknown {
	if (!result || typeof result !== 'object') return result;
	const record = result as Record<string, unknown>;
	if (!Array.isArray(record.objects)) return result;
	const { rowCount, rows, rowsTruncated } = capRows(record.objects.map(summarizeR2Object));
	return {
		objectCount: rowCount,
		objects: rows,
		...(rowsTruncated ? { objectsTruncated: true } : {}),
		truncated: record.truncated,
		delimitedPrefixes: record.delimitedPrefixes,
	};
}

/**
 * Patch an R2 bucket binding so head/get/put/delete/list log keys, sizes,
 * metadata, durations, and results. Object bodies are described, not dumped.
 */
export function instrumentR2ForDebug(bucket: unknown, bindingName: string): void {
	if (!bucket || typeof bucket !== 'object' || instrumented.has(bucket)) return;
	instrumented.add(bucket);

	const simpleOps: Array<{ method: string; summarize: (result: unknown) => unknown }> = [
		{ method: 'head', summarize: summarizeR2Object },
		{ method: 'get', summarize: summarizeR2Object },
		{ method: 'delete', summarize: (result) => result },
	];
	simpleOps.forEach(({ method, summarize }) => {
		patchMethod(bucket, method, (original) => (...args: unknown[]) =>
			runLoggedOp(
				'r2',
				`${bindingName}.${method} ${describeKey(args[0])}`,
				{ key: redactKeyArgument(args[0]) },
				() => original(...args) as Promise<unknown>,
				summarize,
			));
	});

	patchMethod(bucket, 'put', (put) => (...args: unknown[]) =>
		runLoggedOp(
			'r2',
			`${bindingName}.put ${describeKey(args[0])}`,
			{
				key: redactKeyArgument(args[0]),
				value: summarizeStoredValue(args[1]),
				options: args[2],
			},
			() => put(...args) as Promise<unknown>,
			summarizeR2Object,
		));

	patchMethod(bucket, 'list', (list) => (...args: unknown[]) =>
		runLoggedOp(
			'r2',
			`${bindingName}.list`,
			{ options: args[0] },
			() => list(...args) as Promise<unknown>,
			summarizeR2ListResult,
		));
}

// ----------------------------------------------------------------
// Queues (producer side)
// ----------------------------------------------------------------

/**
 * Patch a queue producer binding so send/sendBatch log the enqueued message
 * bodies (after redaction) and options.
 */
export function instrumentQueueForDebug(queue: unknown, bindingName: string): void {
	if (!queue || typeof queue !== 'object' || instrumented.has(queue)) return;
	instrumented.add(queue);

	patchMethod(queue, 'send', (send) => (...args: unknown[]) =>
		runLoggedOp(
			'queue.send',
			`${bindingName}.send`,
			{ message: args[0], options: args[1] },
			() => send(...args) as Promise<unknown>,
			(result) => result,
		));

	patchMethod(queue, 'sendBatch', (sendBatch) => (...args: unknown[]) =>
		runLoggedOp(
			'queue.send',
			`${bindingName}.sendBatch`,
			{
				messages: Array.isArray(args[0]) ? capRows(args[0]) : args[0],
				options: args[1],
			},
			() => sendBatch(...args) as Promise<unknown>,
			(result) => result,
		));
}
