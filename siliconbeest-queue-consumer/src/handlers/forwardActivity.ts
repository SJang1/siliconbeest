/**
 * Forward Activity Handler
 *
 * Forwards an ActivityPub activity to a target inbox, preserving the
 * original HTTP signature headers. This enables relay-like behaviour
 * where activities addressed to a remote actor's followers collection
 * can be forwarded to other servers that also host followers of that actor.
 */

import type { Env } from '../env';
import type { ForwardActivityMessage } from '../shared/types/queue';

export async function handleForwardActivity(
	msg: ForwardActivityMessage,
	env: Env,
): Promise<void> {
	const { rawBody, originalHeaders, targetInboxUrl } = msg;

	// Reconstruct headers for the forwarded request
	const headers: Record<string, string> = {
		...originalHeaders,
		// Ensure content-type is set
		'Content-Type': originalHeaders['content-type'] || 'application/activity+json',
		'User-Agent': originalHeaders['user-agent'] || 'SiliconBeest/1.0 (ActivityPub; +https://github.com/SJang1/siliconbeest)',
	};

	// Update the Host header for the target
	const targetUrl = new URL(targetInboxUrl);
	headers['Host'] = targetUrl.host;

	const response = await fetch(targetInboxUrl, {
		method: 'POST',
		headers,
		body: rawBody,
	});

	const targetDomain = targetUrl.hostname;

	// Ensure instance record exists
	await env.DB.prepare(
		`INSERT OR IGNORE INTO instances (id, domain, created_at, updated_at)
		 VALUES (?, ?, datetime('now'), datetime('now'))`,
	)
		.bind(crypto.randomUUID(), targetDomain)
		.run();

	if (response.ok || response.status === 202) {
		await env.DB.prepare(
			`UPDATE instances SET last_successful_at = datetime('now'), failure_count = 0, updated_at = datetime('now') WHERE domain = ?`,
		)
			.bind(targetDomain)
			.run();
		console.log(`Forwarded activity to ${targetInboxUrl} (${response.status})`);
		return;
	}

	if (response.status >= 500) {
		await env.DB.prepare(
			`UPDATE instances SET last_failed_at = datetime('now'), failure_count = failure_count + 1, updated_at = datetime('now') WHERE domain = ?`,
		)
			.bind(targetDomain)
			.run();

		const text = await response.text().catch(() => '');
		throw new Error(
			`Forward to ${targetInboxUrl} failed with ${response.status}: ${text.slice(0, 200)}`,
		);
	}

	// 4xx — client error, don't retry
	await env.DB.prepare(
		`UPDATE instances SET last_failed_at = datetime('now'), failure_count = failure_count + 1, updated_at = datetime('now') WHERE domain = ?`,
	)
		.bind(targetDomain)
		.run();
	const text = await response.text().catch(() => '');
	console.warn(
		`Forward to ${targetInboxUrl} rejected with ${response.status}: ${text.slice(0, 200)}`,
	);
}
