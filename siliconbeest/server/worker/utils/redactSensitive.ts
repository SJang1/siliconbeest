const REDACTED = '[REDACTED]';

const SENSITIVE_FIELD_NAMES = new Set([
	'authorization',
	'auth',
	'cookie',
	'setcookie',
	'credentials',
	'credential',
	'key',
	'apikey',
	'privatekey',
	'signingkey',
	'encryptionkey',
	'secret',
	'secretkey',
	'clientsecret',
	'otpsecret',
	'password',
	'passwordhash',
	'encryptedpassword',
	'passphrase',
	'signature',
	'token',
	'tokenhash',
	'accesstoken',
	'refreshtoken',
]);

const TEXT_BODY_FIELD_NAMES = new Set([
	'content',
	'contentmap',
	'description',
	'html',
	'note',
	'rawbody',
	'source',
	'spoilertext',
	'subject',
	'summary',
	'summarymap',
	'text',
]);

function normalizeFieldName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function shouldRedactField(name: string): boolean {
	const normalized = normalizeFieldName(name);
	return SENSITIVE_FIELD_NAMES.has(normalized)
		|| TEXT_BODY_FIELD_NAMES.has(normalized)
		|| normalized.includes('privatekey')
		|| normalized.endsWith('password')
		|| normalized.endsWith('secret')
		|| normalized.endsWith('token')
		|| normalized.endsWith('authorization')
		|| normalized.endsWith('cookie')
		|| normalized.endsWith('credential')
		|| normalized.endsWith('credentials')
		|| normalized.endsWith('passphrase')
		|| normalized.endsWith('signature');
}

/**
 * Return a display-safe copy of a parsed DLQ payload.
 *
 * The parked payload itself must remain untouched because replay uses the
 * original bytes stored in D1. Public identifiers and public keys stay visible
 * for diagnosis, while secrets, credentials, signatures, and authored text are
 * replaced at every nesting level.
 */
export function redactSensitiveForDisplay(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(redactSensitiveForDisplay);
	}

	if (value === null || typeof value !== 'object') {
		return value;
	}

	return Object.fromEntries(
		Object.entries(value).map(([key, nestedValue]) => [
			key,
			shouldRedactField(key) ? REDACTED : redactSensitiveForDisplay(nestedValue),
		]),
	);
}

export function redactDlqBodyForDisplay(rawBody: string): unknown {
	try {
		const parsed: unknown = JSON.parse(rawBody);
		// A structured object/array can be selectively redacted. An unstructured
		// primitive gives us no field names to classify, so do not expose it.
		if (parsed !== null && typeof parsed === 'object') {
			return redactSensitiveForDisplay(parsed);
		}
	} catch {
		// Invalid JSON may itself be text or a secret; do not echo it to clients.
	}

	return REDACTED;
}
