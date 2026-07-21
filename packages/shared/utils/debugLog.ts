/**
 * Verbose debug logging gated by the `DEBUG` environment variable.
 *
 * When `DEBUG` is unset or false (the default) every exported logging
 * function is a no-op, so call sites can emit exhaustive diagnostics —
 * full federation request/response payloads, user activity, HTTP
 * statuses — without any production log volume.
 *
 * Everything is logged verbatim EXCEPT ultra-sensitive values (private
 * keys, passwords, secrets, bearer tokens, cookies), which are redacted
 * at every nesting level before serialization. Public keys, HTTP
 * signatures, key IDs, and authored content stay visible because they
 * travel over the wire anyway and are exactly what federation debugging
 * needs. This is deliberately narrower than `redactSensitiveForDisplay`
 * (the DLQ admin-API redactor), which also hides authored text.
 */

import { env } from 'cloudflare:workers';

const REDACTED = '[REDACTED]';

/** Cap on logged request/response body text, in characters. */
export const DEBUG_LOG_MAX_BODY_LENGTH = 65536;

const MAX_DEPTH = 16;

/** Matches PEM-encoded private key blocks embedded anywhere in a string. */
const PEM_PRIVATE_KEY_PATTERN =
	/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g;

/** JWK members that hold private/secret key material (RFC 7518). */
const JWK_PRIVATE_MEMBERS = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']);

const ULTRA_SENSITIVE_FIELD_NAMES = new Set([
	'authorization',
	'cookie',
	'setcookie',
	'passphrase',
	'credential',
	'credentials',
	'apikey',
	'tokenhash',
	'accesstoken',
	'refreshtoken',
	// One-time / reusable credentials that live in innocuously named fields:
	// email-confirmation & OAuth codes, MFA codes and recovery codes, PKCE
	// verifiers, and the Web Push subscription auth secret (keys.auth).
	'auth',
	'code',
	'otp',
	'otpcode',
	'codeverifier',
	'onetimecode',
	'backupcode',
	'backupcodes',
	'recoverycode',
	'recoverycodes',
]);

function normalizeFieldName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function shouldRedactField(name: string): boolean {
	const normalized = normalizeFieldName(name);
	return ULTRA_SENSITIVE_FIELD_NAMES.has(normalized)
		|| normalized.includes('privatekey')
		|| normalized.includes('password')
		|| normalized.includes('secret')
		|| normalized.endsWith('token')
		|| normalized.endsWith('authorization')
		|| normalized.endsWith('cookie')
		|| normalized.endsWith('passphrase')
		|| normalized.endsWith('encryptionkey')
		|| normalized.endsWith('signingkey');
}

function looksLikeJwk(value: Record<string, unknown>): boolean {
	return typeof value.kty === 'string';
}

/**
 * Redact sensitive query parameters inside URL strings (e.g. the request
 * URL of `/auth/confirm?token=…` or an OAuth redirect carrying `code=…`),
 * which field-name redaction cannot see.
 */
function redactUrlSecrets(text: string): string {
	if (!text.includes('?') || !/^https?:\/\//i.test(text)) return text;
	try {
		const url = new URL(text);
		let changed = false;
		for (const key of [...url.searchParams.keys()]) {
			if (shouldRedactField(key)) {
				url.searchParams.set(key, 'REDACTED');
				changed = true;
			}
		}
		return changed ? url.href : text;
	} catch {
		return text;
	}
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
	if (typeof value === 'string') {
		return redactUrlSecrets(value.replace(PEM_PRIVATE_KEY_PATTERN, REDACTED));
	}

	if (value === null || typeof value !== 'object') {
		return value;
	}

	if (depth >= MAX_DEPTH) return '[MaxDepth]';
	if (seen.has(value)) return '[Circular]';
	seen.add(value);

	if (value instanceof URL) return value.href;
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack };
	}
	if (typeof Headers !== 'undefined' && value instanceof Headers) {
		return redactValue(Object.fromEntries(value), depth + 1, seen);
	}
	if (value instanceof Map) {
		return redactValue(Object.fromEntries(value), depth + 1, seen);
	}
	if (value instanceof Set) {
		return redactValue([...value], depth + 1, seen);
	}

	if (Array.isArray(value)) {
		return value.map((item) => redactValue(item, depth + 1, seen));
	}

	const record = value as Record<string, unknown>;
	const isJwk = looksLikeJwk(record);
	return Object.fromEntries(
		Object.entries(record).map(([key, nestedValue]) => {
			if (shouldRedactField(key) || (isJwk && JWK_PRIVATE_MEMBERS.has(key))) {
				return [key, REDACTED];
			}
			return [key, redactValue(nestedValue, depth + 1, seen)];
		}),
	);
}

/**
 * Return a copy of `value` with ultra-sensitive material (private keys,
 * passwords, secrets, tokens, cookies) replaced at every nesting level.
 * Safe to call on arbitrary data, including circular structures.
 */
export function redactUltraSensitive(value: unknown): unknown {
	return redactValue(value, 0, new WeakSet());
}

/** JSON.stringify that never throws (circular refs are pre-resolved by redaction). */
export function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(
			value,
			(_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
		) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Whether verbose debug logging is enabled for this worker.
 *
 * Reads the `DEBUG` environment binding: `true` (boolean) or the strings
 * "true" / "1" enable it; a missing binding or any other value disables it.
 */
export function isDebugEnabled(): boolean {
	// Read via an index signature so workers without a DEBUG binding still compile.
	const flag = (env as unknown as Record<string, unknown>).DEBUG;
	return flag === true || flag === 'true' || flag === '1';
}

/**
 * Extra destination for debug lines (e.g. Sentry). Receives the ALREADY
 * redacted details, so a sink can never leak more than the console does.
 */
export type DebugLogSink = (scope: string, message: string, redactedDetails?: unknown) => void;

let extraSink: DebugLogSink | null = null;

/**
 * Register an additional sink that receives every debug line alongside the
 * console. Workers with Sentry configured use this to mirror debug logs
 * there. Pass `null` to remove. This package stays SDK-free — the sink is
 * injected by the worker that owns the SDK dependency.
 */
export function setDebugLogSink(sink: DebugLogSink | null): void {
	extraSink = sink;
}

/**
 * Log a verbose debug line. No-op unless `DEBUG` is enabled.
 *
 * @param scope - Dot-separated area tag, e.g. `http`, `federation.inbox`,
 *   `federation.deliver`, `queue`.
 * @param message - Human-readable one-line summary.
 * @param details - Optional structured payload; serialized as JSON after
 *   ultra-sensitive redaction.
 */
export function debugLog(scope: string, message: string, details?: unknown): void {
	if (!isDebugEnabled()) return;
	const redacted = details === undefined ? undefined : redactUltraSensitive(details);
	if (redacted === undefined) {
		console.log(`[debug][${scope}] ${message}`);
	} else {
		console.log(`[debug][${scope}] ${message} ${safeStringify(redacted)}`);
	}
	if (extraSink) {
		try {
			extraSink(scope, message, redacted);
		} catch {
			// A failing sink must never break request/queue handling.
		}
	}
}

/** Convert a Headers instance into a plain object for structured logging. */
export function headersToObject(headers: Headers): Record<string, string> {
	return Object.fromEntries(headers);
}

/**
 * Truncate long body text so a single log line stays ingestible.
 * The returned string never exceeds DEBUG_LOG_MAX_BODY_LENGTH, marker included.
 */
export function truncateForDebugLog(text: string): string {
	if (text.length <= DEBUG_LOG_MAX_BODY_LENGTH) return text;
	const marker = `…[truncated; original ${text.length} chars]`;
	return `${text.slice(0, DEBUG_LOG_MAX_BODY_LENGTH - marker.length)}${marker}`;
}

/**
 * Read at most DEBUG_LOG_MAX_BODY_LENGTH characters of text from a body
 * stream, then cancel it. Unlike `Response.text()`, this never buffers an
 * oversized or unbounded payload in memory. Pass a *cloned* body so the
 * original stream stays consumable.
 */
export async function readLimitedBody(
	body: ReadableStream<Uint8Array> | null,
): Promise<string> {
	if (!body) return '';
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let result = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				result += decoder.decode();
				break;
			}
			result += decoder.decode(value, { stream: true });
			if (result.length > DEBUG_LOG_MAX_BODY_LENGTH) {
				await reader.cancel();
				break;
			}
		}
	} catch {
		// Keep whatever was read before the stream failed.
	} finally {
		reader.releaseLock();
	}
	return truncateForDebugLog(result);
}

/**
 * Parse an HTTP body for debug logging so field-level redaction applies.
 * JSON and form-urlencoded bodies become objects; anything else is logged
 * as (PEM-scrubbed, truncated) text.
 */
export function parseBodyForDebugLog(text: string, contentType: string | null | undefined): unknown {
	const type = (contentType ?? '').toLowerCase();
	if (type.includes('json')) {
		try {
			return JSON.parse(text);
		} catch {
			// fall through to raw text
		}
	}
	if (type.includes('application/x-www-form-urlencoded')) {
		return Object.fromEntries(new URLSearchParams(text));
	}
	return truncateForDebugLog(text);
}
