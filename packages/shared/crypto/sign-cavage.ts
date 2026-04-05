/**
 * Draft-Cavage HTTP Signatures (Signing)
 *
 * Implements outbound request signing using the draft-cavage-http-signatures
 * specification, which is the legacy standard used by most ActivityPub servers.
 *
 * See: https://docs.joinmastodon.org/spec/security/
 */

import { importPrivateKey } from './keys';
import { bytesToBase64, computeDigest } from './digest';

/**
 * Sign an outgoing HTTP request using draft-cavage-http-signatures.
 *
 * Builds a signing string from (request-target), host, date, digest
 * (when a body is present), and content-type. Signs with RSASSA-PKCS1-v1_5
 * SHA-256 and returns headers that should be merged into the fetch request.
 */
export async function signRequestCavage(
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

	const privateKey = await importPrivateKey(privateKeyPem);
	const encoder = new TextEncoder();
	const signatureBuffer = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		privateKey,
		encoder.encode(signingString),
	);
	const signatureBase64 = bytesToBase64(new Uint8Array(signatureBuffer));

	headers['Signature'] =
		`keyId="${keyId}",algorithm="rsa-sha256",headers="${signedHeaderNames.join(' ')}",signature="${signatureBase64}"`;

	return headers;
}
