/**
 * HTTP Signatures for ActivityPub Federation
 *
 * Implements both draft-cavage-http-signatures and RFC 9421 HTTP Message
 * Signatures for signing and verifying ActivityPub requests.
 * Uses Web Crypto API only (no node:crypto).
 *
 * See:
 *   - https://docs.joinmastodon.org/spec/security/
 *   - https://www.rfc-editor.org/rfc/rfc9421
 *   - https://www.rfc-editor.org/rfc/rfc9530
 */

// ============================================================
// PEM HELPERS
// ============================================================

/**
 * Strip PEM headers/footers and base64-decode the key material.
 */
export function parsePemKey(pem: string): ArrayBuffer {
	const lines = pem
		.replace(/-----BEGIN [A-Z ]+-----/, '')
		.replace(/-----END [A-Z ]+-----/, '')
		.replace(/\r?\n/g, '')
		.trim();
	const binaryString = atob(lines);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes.buffer;
}

/**
 * Import a PKCS8-encoded PEM private key for RSASSA-PKCS1-v1_5 SHA-256 signing.
 */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
	const keyData = parsePemKey(pem);
	return crypto.subtle.importKey(
		'pkcs8',
		keyData,
		{
			name: 'RSASSA-PKCS1-v1_5',
			hash: { name: 'SHA-256' },
		},
		false,
		['sign'],
	);
}

/**
 * Import a SPKI-encoded PEM public key for RSASSA-PKCS1-v1_5 SHA-256 verification.
 */
export async function importPublicKey(pem: string): Promise<CryptoKey> {
	const keyData = parsePemKey(pem);
	return crypto.subtle.importKey(
		'spki',
		keyData,
		{
			name: 'RSASSA-PKCS1-v1_5',
			hash: { name: 'SHA-256' },
		},
		false,
		['verify'],
	);
}

// ============================================================
// SIGNING
// ============================================================

/**
 * Compute the SHA-256 digest of a body and return it in the
 * `SHA-256=base64(...)` format used by the Digest header.
 */
async function computeDigest(body: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(body);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashBytes = new Uint8Array(hashBuffer);
	let binary = '';
	for (const byte of hashBytes) {
		binary += String.fromCharCode(byte);
	}
	return `SHA-256=${btoa(binary)}`;
}

/**
 * Sign an outgoing HTTP request for ActivityPub delivery.
 *
 * Builds a signing string from (request-target), host, date, digest
 * (when a body is present), and content-type. Signs with RSASSA-PKCS1-v1_5
 * SHA-256 and returns headers that should be merged into the fetch request.
 *
 * @param privateKeyPem - PKCS8 PEM-encoded RSA private key
 * @param keyId - The full key ID URI (e.g. https://domain/users/alice#main-key)
 * @param url - The target URL being requested
 * @param method - HTTP method (POST, GET, etc.)
 * @param body - Optional request body (typically JSON)
 * @param additionalHeaders - Extra headers to include in the signing string
 * @returns A record of headers to attach to the request
 */
export async function signRequest(
	privateKeyPem: string,
	keyId: string,
	url: string,
	method: string,
	body?: string,
	additionalHeaders?: Record<string, string>,
): Promise<Record<string, string>> {
	const parsedUrl = new URL(url);
	const date = new Date().toUTCString();
	const host = parsedUrl.host;
	const requestTarget = `${method.toLowerCase()} ${parsedUrl.pathname}${parsedUrl.search}`;

	const headers: Record<string, string> = {
		Host: host,
		Date: date,
		...(additionalHeaders ?? {}),
	};

	// Build the list of signed header names and the signing string
	const signedHeaderNames: string[] = ['(request-target)', 'host', 'date'];
	const signingParts: string[] = [
		`(request-target): ${requestTarget}`,
		`host: ${host}`,
		`date: ${date}`,
	];

	if (body) {
		const digest = await computeDigest(body);
		headers['Digest'] = digest;
		headers['Content-Type'] = 'application/activity+json';
		signedHeaderNames.push('digest', 'content-type');
		signingParts.push(`digest: ${digest}`);
		signingParts.push(`content-type: application/activity+json`);
	}

	const signingString = signingParts.join('\n');

	// Sign
	const privateKey = await importPrivateKey(privateKeyPem);
	const encoder = new TextEncoder();
	const signatureBuffer = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		privateKey,
		encoder.encode(signingString),
	);
	const signatureBytes = new Uint8Array(signatureBuffer);
	let signatureBinary = '';
	for (const byte of signatureBytes) {
		signatureBinary += String.fromCharCode(byte);
	}
	const signatureBase64 = btoa(signatureBinary);

	const signatureHeader =
		`keyId="${keyId}",algorithm="rsa-sha256",headers="${signedHeaderNames.join(' ')}",signature="${signatureBase64}"`;

	headers['Signature'] = signatureHeader;

	return headers;
}

// ============================================================
// TIMESTAMP VALIDATION
// ============================================================

/**
 * Check whether a Date header string (or Unix timestamp) is within
 * ±maxAgeSeconds of the current time. Used to prevent replay attacks.
 */
export function isTimestampFresh(dateStr: string, maxAgeSeconds = 300): boolean {
	const timestamp = Date.parse(dateStr);
	if (isNaN(timestamp)) {
		return false;
	}
	const diff = Math.abs(Date.now() - timestamp);
	return diff <= maxAgeSeconds * 1000;
}

// ============================================================
// VERIFICATION
// ============================================================

/**
 * Parse the Signature header value into its components.
 */
function parseSignatureHeader(signatureHeader: string): {
	keyId: string;
	algorithm: string;
	headers: string[];
	signature: string;
} {
	const params: Record<string, string> = {};
	// Match key="value" pairs, handling values with spaces
	const regex = /(\w+)="([^"]*)"/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(signatureHeader)) !== null) {
		params[match[1]] = match[2];
	}

	return {
		keyId: params.keyId ?? '',
		algorithm: params.algorithm ?? 'rsa-sha256',
		headers: (params.headers ?? '').split(' '),
		signature: params.signature ?? '',
	};
}

/**
 * Verify the HTTP Signature on an incoming request.
 *
 * Parses the Signature header, reconstructs the signing string from the
 * listed headers, and verifies using the provided public key.
 * Also verifies the Digest header if present.
 *
 * @param request - The incoming Request object
 * @param publicKeyPem - SPKI PEM-encoded RSA public key of the sender
 * @returns true if the signature is valid, false otherwise
 */
export async function verifySignature(
	request: Request,
	publicKeyPem: string,
	rawBody?: string,
): Promise<boolean> {
	const signatureHeader = request.headers.get('Signature');
	if (!signatureHeader) {
		return false;
	}

	const parsed = parseSignatureHeader(signatureHeader);
	if (!parsed.signature || parsed.headers.length === 0) {
		return false;
	}

	// Check Date header freshness to prevent replay attacks
	const dateHeader = request.headers.get('Date');
	if (dateHeader && !isTimestampFresh(dateHeader)) {
		return false;
	}

	// Verify Digest header if present
	if (parsed.headers.includes('digest') || request.headers.has('Digest')) {
		const digestHeader = request.headers.get('Digest');
		if (!digestHeader) {
			return false;
		}

		const body = rawBody ?? await request.clone().text();
		const expectedDigest = await computeDigest(body);
		if (digestHeader !== expectedDigest) {
			return false;
		}
	}

	// Reconstruct the signing string
	const parsedUrl = new URL(request.url);
	const signingParts: string[] = [];

	for (const headerName of parsed.headers) {
		if (headerName === '(request-target)') {
			const method = request.method.toLowerCase();
			const target = `${parsedUrl.pathname}${parsedUrl.search}`;
			signingParts.push(`(request-target): ${method} ${target}`);
		} else {
			const value = request.headers.get(headerName);
			if (value === null) {
				return false;
			}
			signingParts.push(`${headerName}: ${value}`);
		}
	}

	const signingString = signingParts.join('\n');

	// Verify the signature
	try {
		const publicKey = await importPublicKey(publicKeyPem);
		const encoder = new TextEncoder();

		const signatureBinary = atob(parsed.signature);
		const signatureBytes = new Uint8Array(signatureBinary.length);
		for (let i = 0; i < signatureBinary.length; i++) {
			signatureBytes[i] = signatureBinary.charCodeAt(i);
		}

		return crypto.subtle.verify(
			'RSASSA-PKCS1-v1_5',
			publicKey,
			signatureBytes,
			encoder.encode(signingString),
		);
	} catch {
		return false;
	}
}

// ============================================================
// RFC 9530 CONTENT-DIGEST
// ============================================================

/**
 * Compute Content-Digest per RFC 9530.
 * Format: `sha-256=:BASE64:` (structured field byte sequence)
 */
export async function computeContentDigest(body: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(body);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashBytes = new Uint8Array(hashBuffer);
	let binary = '';
	for (const byte of hashBytes) {
		binary += String.fromCharCode(byte);
	}
	return `sha-256=:${btoa(binary)}:`;
}

// ============================================================
// RFC 9421 SIGNING
// ============================================================

/**
 * Helper to encode bytes to base64.
 */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/**
 * Build the RFC 9421 signature base string for the given components.
 *
 * Each component is either a derived component (starts with "@") or
 * a regular header field name. The signature-params line is appended
 * at the end per the spec.
 */
function buildSignatureBase(
	components: string[],
	values: Map<string, string>,
	signatureParamsValue: string,
): string {
	const lines: string[] = [];
	for (const component of components) {
		const value = values.get(component);
		if (value === undefined) {
			throw new Error(`Missing value for component: ${component}`);
		}
		lines.push(`"${component}": ${value}`);
	}
	lines.push(`"@signature-params": ${signatureParamsValue}`);
	return lines.join('\n');
}

/**
 * Sign an outgoing HTTP request using RFC 9421 HTTP Message Signatures.
 *
 * Uses derived components (@method, @target-uri, @authority) and
 * Content-Digest / Content-Type headers. Produces `Signature-Input`
 * and `Signature` headers (RFC 9421 format, not the draft-cavage
 * single `Signature` header).
 *
 * @param privateKeyPem - PKCS8 PEM-encoded RSA private key
 * @param keyId - The full key ID URI (e.g. https://domain/users/alice#main-key)
 * @param url - The target URL being requested
 * @param method - HTTP method (POST, GET, etc.)
 * @param body - Optional request body (typically JSON)
 * @returns A record of headers to attach to the request
 */
export async function signRequestRFC9421(
	privateKeyPem: string,
	keyId: string,
	url: string,
	method: string,
	body?: string,
): Promise<Record<string, string>> {
	const parsedUrl = new URL(url);
	const date = new Date().toUTCString();
	const created = Math.floor(Date.now() / 1000);

	const headers: Record<string, string> = {
		Host: parsedUrl.host,
		Date: date,
	};

	// Determine which components to sign
	const components: string[] = ['@method', '@target-uri', '@authority'];
	const values = new Map<string, string>();

	values.set('@method', method.toUpperCase());
	values.set('@target-uri', url);
	values.set('@authority', parsedUrl.host);

	if (body) {
		const contentDigest = await computeContentDigest(body);
		headers['Content-Digest'] = contentDigest;
		headers['Content-Type'] = 'application/activity+json';
		components.push('content-digest', 'content-type');
		values.set('content-digest', contentDigest);
		values.set('content-type', 'application/activity+json');
	}

	// Build the signature-params value (structured field inner list)
	const componentList = components.map((c) => `"${c}"`).join(' ');
	const signatureParamsValue = `(${componentList});created=${created};keyid="${keyId}";alg="rsa-v1_5-sha256"`;

	// Build the signature base
	const signatureBase = buildSignatureBase(components, values, signatureParamsValue);

	// Sign
	const privateKey = await importPrivateKey(privateKeyPem);
	const encoder = new TextEncoder();
	const signatureBuffer = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		privateKey,
		encoder.encode(signatureBase),
	);
	const signatureBase64 = bytesToBase64(new Uint8Array(signatureBuffer));

	// RFC 9421 uses Signature-Input and Signature as structured fields.
	// Label the signature as "sig1".
	headers['Signature-Input'] = `sig1=${signatureParamsValue}`;
	headers['Signature'] = `sig1=:${signatureBase64}:`;

	return headers;
}

// ============================================================
// RFC 9421 VERIFICATION
// ============================================================

/**
 * Parse an RFC 9421 Signature-Input header value for a given label.
 *
 * Returns the list of covered components and the raw params string,
 * or null if parsing fails.
 */
function parseSignatureInput(
	signatureInputHeader: string,
	label: string,
): { components: string[]; params: string; created?: number; keyId?: string } | null {
	// Find the label assignment: e.g. `sig1=("@method" ...);created=...`
	// The value starts after `label=`
	const prefix = `${label}=`;
	const startIdx = signatureInputHeader.indexOf(prefix);
	if (startIdx === -1) return null;

	const rest = signatureInputHeader.slice(startIdx + prefix.length);

	// Parse the inner list: everything inside the parentheses
	const openParen = rest.indexOf('(');
	const closeParen = rest.indexOf(')');
	if (openParen === -1 || closeParen === -1) return null;

	const innerList = rest.slice(openParen + 1, closeParen);
	// Extract quoted component identifiers
	const components: string[] = [];
	const componentRegex = /"([^"]*)"/g;
	let m: RegExpExecArray | null;
	while ((m = componentRegex.exec(innerList)) !== null) {
		components.push(m[1]);
	}

	// Everything after the closing paren is parameters
	const paramsStr = rest.slice(closeParen + 1).split(/\s*,\s*/)[0]; // stop at next label if present

	// Extract keyid
	const keyIdMatch = paramsStr.match(/keyid="([^"]*)"/);
	const keyId = keyIdMatch?.[1];

	// Extract created
	const createdMatch = paramsStr.match(/created=(\d+)/);
	const created = createdMatch ? parseInt(createdMatch[1], 10) : undefined;

	// Reconstruct the full signature-params value for base computation
	const fullParams = rest.slice(openParen).split(/\s*,\s*/)[0]; // from ( to end of this label's params

	return { components, params: fullParams, created, keyId };
}

/**
 * Extract the base64-encoded signature bytes for a given label
 * from the RFC 9421 Signature header (structured field dictionary).
 *
 * Format: `sig1=:BASE64:`
 */
function extractSignatureBytes(signatureHeader: string, label: string): Uint8Array | null {
	const prefix = `${label}=:`;
	const startIdx = signatureHeader.indexOf(prefix);
	if (startIdx === -1) return null;

	const afterPrefix = signatureHeader.slice(startIdx + prefix.length);
	const endColon = afterPrefix.indexOf(':');
	if (endColon === -1) return null;

	const base64Str = afterPrefix.slice(0, endColon);
	try {
		const binaryStr = atob(base64Str);
		const bytes = new Uint8Array(binaryStr.length);
		for (let i = 0; i < binaryStr.length; i++) {
			bytes[i] = binaryStr.charCodeAt(i);
		}
		return bytes;
	} catch {
		return null;
	}
}

/**
 * Verify an RFC 9421 HTTP Message Signature on an incoming request.
 *
 * Parses the `Signature-Input` header, reconstructs the signature base,
 * verifies Content-Digest if present, and checks the cryptographic
 * signature using the actor's public key.
 *
 * @param request - The incoming Request object
 * @param publicKeyPem - SPKI PEM-encoded RSA public key of the sender
 * @param rawBody - The raw request body string (optional, will be read from request if not provided)
 * @returns true if the signature is valid, false otherwise
 */
export async function verifySignatureRFC9421(
	request: Request,
	publicKeyPem: string,
	rawBody?: string,
): Promise<boolean> {
	const signatureInputHeader = request.headers.get('Signature-Input');
	const signatureHeader = request.headers.get('Signature');
	if (!signatureInputHeader || !signatureHeader) {
		return false;
	}

	// Find the first label (typically "sig1")
	const labelMatch = signatureInputHeader.match(/^(\w+)=/);
	if (!labelMatch) return false;
	const label = labelMatch[1];

	const parsed = parseSignatureInput(signatureInputHeader, label);
	if (!parsed || parsed.components.length === 0) {
		return false;
	}

	// Check created timestamp freshness to prevent replay attacks
	if (parsed.created !== undefined) {
		const createdMs = parsed.created * 1000;
		const diff = Math.abs(Date.now() - createdMs);
		if (diff > 300 * 1000) {
			return false;
		}
	}

	// Verify Content-Digest if the component list includes it
	if (parsed.components.includes('content-digest')) {
		const contentDigestHeader = request.headers.get('Content-Digest');
		if (!contentDigestHeader) {
			return false;
		}

		const body = rawBody ?? await request.clone().text();
		const expectedDigest = await computeContentDigest(body);
		if (contentDigestHeader !== expectedDigest) {
			return false;
		}
	}

	// Resolve component values
	const parsedUrl = new URL(request.url);
	const values = new Map<string, string>();

	for (const component of parsed.components) {
		switch (component) {
			case '@method':
				values.set(component, request.method.toUpperCase());
				break;
			case '@target-uri':
				values.set(component, request.url);
				break;
			case '@authority':
				values.set(component, parsedUrl.host);
				break;
			case '@path':
				values.set(component, parsedUrl.pathname);
				break;
			case '@query':
				values.set(component, parsedUrl.search || '?');
				break;
			case '@scheme':
				values.set(component, parsedUrl.protocol.replace(':', ''));
				break;
			default: {
				// Regular header field
				const headerValue = request.headers.get(component);
				if (headerValue === null) {
					return false;
				}
				values.set(component, headerValue);
				break;
			}
		}
	}

	// Build signature base
	const signatureBase = buildSignatureBase(parsed.components, values, parsed.params);

	// Extract signature bytes
	const sigBytes = extractSignatureBytes(signatureHeader, label);
	if (!sigBytes) return false;

	// Verify
	try {
		const publicKey = await importPublicKey(publicKeyPem);
		const encoder = new TextEncoder();
		return crypto.subtle.verify(
			'RSASSA-PKCS1-v1_5',
			publicKey,
			sigBytes,
			encoder.encode(signatureBase),
		);
	} catch {
		return false;
	}
}

/**
 * Extract the keyId from an RFC 9421 Signature-Input header.
 * Returns null if not found.
 */
export function extractKeyIdFromSignatureInput(signatureInputHeader: string): string | null {
	const keyIdMatch = signatureInputHeader.match(/keyid="([^"]*)"/);
	return keyIdMatch?.[1] ?? null;
}
