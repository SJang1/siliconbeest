/**
 * Forward Activity Handler
 *
 * Forwards an ActivityPub activity to a target inbox, preserving the
 * original HTTP signature headers. This enables relay-like behaviour
 * where activities addressed to a remote actor's followers collection
 * can be forwarded to other servers that also host followers of that actor.
 */

import { env } from 'cloudflare:workers';
import type { ForwardActivityMessage } from '../shared/types/queue';
import { getUserAgent } from '../utils/repository';
import { ensureInstanceRecord, recordDeliverySuccess, recordDeliveryFailure } from '../../../packages/shared/services/instance';
import {
	getDeliveryTargetDomains,
	getSuspendedDomains,
} from '../../../packages/shared/domain-blocks';

export async function handleForwardActivity(
	msg: ForwardActivityMessage,
): Promise<void> {
	const { rawBody, originalHeaders, targetInboxUrl } = msg;
	const targetUrl = new URL(targetInboxUrl);
	const targetDomain = targetUrl.hostname.toLowerCase();
	const deliveryDomains = await getDeliveryTargetDomains(env.DB, targetInboxUrl);
	const suspendedDomains = await getSuspendedDomains(env.DB, deliveryDomains);
	if (suspendedDomains.size > 0) {
		console.log(`[forward] Dropping delivery to suspended domain ${[...suspendedDomains].join(', ')}`);
		return;
	}

	// Reconstruct headers for the forwarded request
	const headers: Record<string, string> = {
		...originalHeaders,
		// Ensure content-type is set
		'Content-Type': originalHeaders['content-type'] || 'application/activity+json',
		'User-Agent': originalHeaders['user-agent'] || getUserAgent('ActivityPub'),
	};

	// Update the Host header for the target
	headers['Host'] = targetUrl.host;

	const response = await fetch(targetInboxUrl, {
		method: 'POST',
		headers,
		body: rawBody,
	});

	// Ensure instance record exists
	await ensureInstanceRecord(env.DB, targetDomain);

	if (response.ok || response.status === 202) {
		await recordDeliverySuccess(env.DB, targetDomain);
		console.log(`Forwarded activity to ${targetInboxUrl} (${response.status})`);
		return;
	}

	if (response.status >= 500) {
		await recordDeliveryFailure(env.DB, targetDomain);
		const text = await response.text().catch(() => '');
		throw new Error(
			`Forward to ${targetInboxUrl} failed with ${response.status}: ${text.slice(0, 200)}`,
		);
	}

	// 4xx — client error, don't retry
	await recordDeliveryFailure(env.DB, targetDomain);
	const text = await response.text().catch(() => '');
	console.warn(
		`Forward to ${targetInboxUrl} rejected with ${response.status}: ${text.slice(0, 200)}`,
	);
}
