/**
 * Debug instrumentation for Cloudflare binding objects (D1, KV, R2, Queues)
 * and outbound `fetch` to remote servers.
 *
 * Each `instrument*ForDebug` function patches the methods of a live binding
 * object in place so every operation logs the method name, its arguments,
 * its result, and the call duration through `debugLog` — covering the
 * hundreds of `env.DB_META_C000` / `env.CACHE` / … call sites without touching them.
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

import { env } from 'cloudflare:workers';
import {
	DEBUG_LOG_MAX_BODY_LENGTH,
	debugLog,
	headersToObject,
	isDebugEnabled,
	parseBodyForDebugLog,
	readLimitedBody,
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
		// Oversized strings are truncated as-is: parsing and recursively
		// redacting a huge JSON document could blow the CPU/memory budget of
		// a worker isolate, and truncation would break the parse anyway.
		if (value.length > DEBUG_LOG_MAX_BODY_LENGTH) return truncateForDebugLog(value);
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
 * are withheld wholesale; otherwise they are logged verbatim, capped at
 * DEBUG_LOG_MAX_ROWS so bulk inserts cannot flood a log line.
 */
function summarizeD1Params(sql: string, params: unknown[] | undefined): unknown {
	if (!params || params.length === 0) return params;
	const identifiers = sql.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
	if (identifiers.some((identifier) => shouldRedactField(identifier))) {
		return `[${params.length} params withheld: statement references sensitive columns]`;
	}
	return params.length <= DEBUG_LOG_MAX_ROWS
		? params
		: [
				...params.slice(0, DEBUG_LOG_MAX_ROWS),
				`…and ${params.length - DEBUG_LOG_MAX_ROWS} more params`,
			];
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

// ----------------------------------------------------------------
// Outbound fetch (remote servers: WebFinger, actor fetches, deliveries)
// ----------------------------------------------------------------

let fetchInstrumented = false;

/** `null` = no DSN configured; computed lazily once per isolate. */
let cachedSentryHost: string | null | undefined;

/**
 * The Sentry debug sink reports through `fetch`; logging its own ingest
 * traffic would feed the logger its own output on every flush.
 */
function sentryIngestHost(): string | null {
	if (cachedSentryHost !== undefined) return cachedSentryHost;
	const dsn = (env as unknown as Record<string, unknown>).SENTRY_DSN;
	if (typeof dsn !== 'string' || !dsn) {
		cachedSentryHost = null;
		return null;
	}
	try {
		cachedSentryHost = new URL(dsn).host;
	} catch {
		cachedSentryHost = null;
	}
	return cachedSentryHost;
}

// Body types that are safe and useful to read for logging. Streaming
// responses (SSE, media) must never be buffered here.
function isLoggableBodyType(contentType: string | null): boolean {
	const type = (contentType ?? '').toLowerCase();
	if (type.includes('text/event-stream')) return false;
	return type.includes('json')
		|| type.includes('application/x-www-form-urlencoded')
		|| type.includes('xml')
		|| type.startsWith('text/');
}

/**
 * Read a request/response body for logging via a capped clone read, so the
 * original stream stays consumable and oversized payloads never buffer.
 */
async function readFetchBodyForDebug(source: Request | Response): Promise<unknown> {
	const contentType = source.headers.get('Content-Type');
	if (!isLoggableBodyType(contentType)) {
		return source.body ? `<${contentType ?? 'unknown content type'}; body not logged>` : undefined;
	}
	try {
		const text = await readLimitedBody(source.clone().body);
		if (text.length === 0) return undefined;
		return parseBodyForDebugLog(text, contentType);
	} catch (err) {
		return `<failed to read body: ${err instanceof Error ? err.message : String(err)}>`;
	}
}

type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

/**
 * Patch `globalThis.fetch` so every outbound HTTP exchange — WebFinger and
 * actor lookups during remote acct resolution, activity deliveries, OG
 * fetches, … — logs the raw request (method, URL, headers, parsed body) and
 * raw response (status, headers, parsed body) in one line. Bodies are read
 * from capped clones; binary/streaming payloads are described, not dumped.
 * Ultra-sensitive redaction applies as everywhere else.
 */
export function instrumentFetchForDebug(): void {
	if (fetchInstrumented) return;
	const globalObj = globalThis as { fetch?: FetchLike };
	const originalFetch = globalObj.fetch;
	if (typeof originalFetch !== 'function') return;
	fetchInstrumented = true;
	const bound = originalFetch.bind(globalThis);
	try {
		globalObj.fetch = async (input: unknown, init?: unknown): Promise<Response> => {
			if (!isDebugEnabled()) return bound(input, init);
			// Normalize to a Request for a uniform, cloneable view. A bare
			// Request input passes through untouched; re-wrapping would
			// disturb its body.
			const request = input instanceof Request && init === undefined
				? input
				: new Request(input as RequestInfo, init as RequestInit | undefined);
			const requestHost = new URL(request.url).host;
			if (requestHost === sentryIngestHost()) return bound(request);
			// Query strings can carry secrets: keep them out of the message
			// line (details.url gets URL-level redaction from debugLog).
			const urlForMessage = request.url.split('?')[0];
			const requestDetails = {
				url: request.url,
				headers: headersToObject(request.headers),
				body: await readFetchBodyForDebug(request),
			};
			const started = performance.now();
			try {
				const response = await bound(request);
				debugLog('fetch', `${request.method} ${urlForMessage} -> ${response.status}`, {
					durationMs: Math.round(performance.now() - started),
					request: requestDetails,
					response: {
						status: response.status,
						headers: headersToObject(response.headers),
						body: await readFetchBodyForDebug(response),
					},
				});
				return response;
			} catch (err) {
				debugLog('fetch', `${request.method} ${urlForMessage} threw`, {
					durationMs: Math.round(performance.now() - started),
					request: requestDetails,
					error: err,
				});
				throw err;
			}
		};
	} catch (err) {
		fetchInstrumented = false;
		console.warn('[debug] could not instrument fetch() for debug logging:', err);
	}
}

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
