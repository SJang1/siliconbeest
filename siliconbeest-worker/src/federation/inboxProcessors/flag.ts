/**
 * Inbox Processor: Flag (remote report)
 *
 * Handles incoming Flag activities from remote instances reporting
 * content or accounts on this instance. Creates a report in the
 * reports table for moderator review.
 */

import type { Env } from '../../env';
import type { APActivity } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';

export async function processFlag(
	activity: APActivity,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	// activity.object can be one or more URIs (account + optional status URIs)
	const objects = activity.object;
	if (!objects) {
		console.warn('[flag] activity.object is missing');
		return;
	}

	// Normalize to array of URIs
	const objectUris: string[] = [];
	if (typeof objects === 'string') {
		objectUris.push(objects);
	} else if (Array.isArray(objects)) {
		for (const obj of objects) {
			if (typeof obj === 'string') {
				objectUris.push(obj);
			} else if (obj && typeof obj === 'object' && 'id' in obj && obj.id) {
				objectUris.push(obj.id);
			}
		}
	}

	if (objectUris.length === 0) {
		console.warn('[flag] No object URIs found');
		return;
	}

	// Resolve the reporting actor
	const reporterAccount = await env.DB.prepare(
		`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
	)
		.bind(activity.actor)
		.first<{ id: string }>();

	let reporterAccountId: string;

	if (reporterAccount) {
		reporterAccountId = reporterAccount.id;
	} else {
		// Create a stub for the reporting actor
		const now = new Date().toISOString();
		reporterAccountId = generateUlid();
		let username = 'unknown';
		let domain = 'unknown';

		try {
			const url = new URL(activity.actor);
			domain = url.host;
			const segments = url.pathname.split('/').filter(Boolean);
			username = segments[segments.length - 1] ?? 'unknown';
		} catch {
			// leave defaults
		}

		try {
			await env.DB.prepare(
				`INSERT INTO accounts (id, username, domain, uri, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
			)
				.bind(reporterAccountId, username, domain, activity.actor, now, now)
				.run();
		} catch {
			const retry = await env.DB.prepare(
				`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
			)
				.bind(activity.actor)
				.first<{ id: string }>();
			if (retry) {
				reporterAccountId = retry.id;
			}
		}
	}

	// The first URI is usually the target account; remaining are status URIs
	const targetAccountUri = objectUris[0];
	const statusUris = objectUris.slice(1);

	// Resolve the target account
	const targetAccount = await env.DB.prepare(
		`SELECT id FROM accounts WHERE uri = ?1 AND domain IS NULL LIMIT 1`,
	)
		.bind(targetAccountUri)
		.first<{ id: string }>();

	if (!targetAccount) {
		console.warn(`[flag] Target account not found locally: ${targetAccountUri}`);
		return;
	}

	// Resolve status IDs
	const statusIds: string[] = [];
	for (const uri of statusUris) {
		const status = await env.DB.prepare(
			`SELECT id FROM statuses WHERE uri = ?1 LIMIT 1`,
		)
			.bind(uri)
			.first<{ id: string }>();
		if (status) {
			statusIds.push(status.id);
		}
	}

	// Extract content/comment from the activity
	const comment =
		(activity as APActivity & { content?: string }).content ?? '';

	const now = new Date().toISOString();
	const reportId = generateUlid();

	await env.DB.prepare(
		`INSERT INTO reports
		 (id, account_id, target_account_id, status_ids, comment, category, forwarded, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, 'other', 1, ?6, ?7)`,
	)
		.bind(
			reportId,
			reporterAccountId,
			targetAccount.id,
			statusIds.length > 0 ? JSON.stringify(statusIds) : null,
			comment,
			now,
			now,
		)
		.run();

	console.log(`[flag] Created report ${reportId} from ${activity.actor}`);
}
