/**
 * RFC 9421 HTTP Message Signatures (Signing)
 *
 * Implements outbound request signing using RFC 9421, the modern standard
 * for HTTP Message Signatures.
 *
 * See: https://www.rfc-editor.org/rfc/rfc9421
 */

import { importPrivateKey } from './keys';
import { bytesToBase64, computeContentDigest } from './digest';

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
 * and `Signature` headers (RFC 9421 format).
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

	const componentList = components.map((c) => `"${c}"`).join(' ');
	const signatureParamsValue = `(${componentList});created=${created};keyid="${keyId}";alg="rsa-v1_5-sha256"`;

	const signatureBase = buildSignatureBase(components, values, signatureParamsValue);

	const privateKey = await importPrivateKey(privateKeyPem);
	const encoder = new TextEncoder();
	const signatureBuffer = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		privateKey,
		encoder.encode(signatureBase),
	);
	const signatureBase64 = bytesToBase64(new Uint8Array(signatureBuffer));

	headers['Signature-Input'] = `sig1=${signatureParamsValue}`;
	headers['Signature'] = `sig1=:${signatureBase64}:`;

	return headers;
}

// Re-export buildSignatureBase for verification use
export { buildSignatureBase };
