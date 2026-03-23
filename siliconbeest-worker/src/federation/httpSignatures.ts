/**
 * HTTP Signatures for ActivityPub Federation
 *
 * Implements draft-cavage-http-signatures for signing and verifying
 * ActivityPub requests. Uses Web Crypto API only (no node:crypto).
 *
 * See: https://docs.joinmastodon.org/spec/security/
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
