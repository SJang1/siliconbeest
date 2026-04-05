/**
 * HTTP Signature Verification
 *
 * Verifies incoming ActivityPub requests signed with either
 * draft-cavage or RFC 9421 HTTP signatures.
 */

import { importPublicKey } from './keys';
import { computeDigest, computeContentDigest } from './digest';
import { buildSignatureBase } from './sign-rfc9421';

// ============================================================
// TIMESTAMP VALIDATION
// ============================================================

/**
 * Check whether a Date header string (or Unix timestamp) is within
 * +/-maxAgeSeconds of the current time. Used to prevent replay attacks.
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
// DRAFT-CAVAGE VERIFICATION
// ============================================================

/**
 * Parse the draft-cavage Signature header value into its components.
 */
function parseSignatureHeader(signatureHeader: string): {
	keyId: string;
	algorithm: string;
	headers: string[];
	signature: string;
} {
	const params: Record<string, string> = {};
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
 * Verify the draft-cavage HTTP Signature on an incoming request.
 *
 * Parses the Signature header, reconstructs the signing string from the
 * listed headers, and verifies using the provided public key.
 * Also verifies the Digest header if present.
 */
export async function verifySignatureCavage(
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

	// Check Date header freshness
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
// RFC 9421 VERIFICATION
// ============================================================

/**
 * Parse an RFC 9421 Signature-Input header value for a given label.
 */
function parseSignatureInput(
	signatureInputHeader: string,
	label: string,
): { components: string[]; params: string; created?: number; keyId?: string } | null {
	const prefix = `${label}=`;
	const startIdx = signatureInputHeader.indexOf(prefix);
	if (startIdx === -1) return null;

	const rest = signatureInputHeader.slice(startIdx + prefix.length);

	const openParen = rest.indexOf('(');
	const closeParen = rest.indexOf(')');
	if (openParen === -1 || closeParen === -1) return null;

	const innerList = rest.slice(openParen + 1, closeParen);
	const components: string[] = [];
	const componentRegex = /"([^"]*)"/g;
	let m: RegExpExecArray | null;
	while ((m = componentRegex.exec(innerList)) !== null) {
		components.push(m[1]);
	}

	const paramsStr = rest.slice(closeParen + 1).split(/\s*,\s*/)[0];

	const keyIdMatch = paramsStr.match(/keyid="([^"]*)"/);
	const keyId = keyIdMatch?.[1];

	const createdMatch = paramsStr.match(/created=(\d+)/);
	const created = createdMatch ? parseInt(createdMatch[1], 10) : undefined;

	const fullParams = rest.slice(openParen).split(/\s*,\s*/)[0];

	return { components, params: fullParams, created, keyId };
}

/**
 * Extract the base64-encoded signature bytes for a given label
 * from the RFC 9421 Signature header.
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

	const labelMatch = signatureInputHeader.match(/^(\w+)=/);
	if (!labelMatch) return false;
	const label = labelMatch[1];

	const parsed = parseSignatureInput(signatureInputHeader, label);
	if (!parsed || parsed.components.length === 0) {
		return false;
	}

	// Check created timestamp freshness
	if (parsed.created !== undefined) {
		const createdMs = parsed.created * 1000;
		const diff = Math.abs(Date.now() - createdMs);
		if (diff > 300 * 1000) {
			return false;
		}
	}

	// Verify Content-Digest if included
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
				const headerValue = request.headers.get(component);
				if (headerValue === null) {
					return false;
				}
				values.set(component, headerValue);
				break;
			}
		}
	}

	const signatureBase = buildSignatureBase(parsed.components, values, parsed.params);

	const sigBytes = extractSignatureBytes(signatureHeader, label);
	if (!sigBytes) return false;

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
 */
export function extractKeyIdFromSignatureInput(signatureInputHeader: string): string | null {
	const keyIdMatch = signatureInputHeader.match(/keyid="([^"]*)"/);
	return keyIdMatch?.[1] ?? null;
}
