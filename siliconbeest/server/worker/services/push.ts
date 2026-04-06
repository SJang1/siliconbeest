/**
 * Push Subscription Service
 *
 * Pure DB operations for Web Push subscription management.
 */

import { env } from 'cloudflare:workers';

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export interface PushAlerts {
	mention: number;
	follow: number;
	favourite: number;
	reblog: number;
	poll: number;
	status: number;
	update: number;
	follow_request: number;
	admin_sign_up: number;
	admin_report: number;
}

// ----------------------------------------------------------------
// Create subscription (replaces existing for same token)
// ----------------------------------------------------------------

export async function createPushSubscription(
	opts: {
		id: string;
		userId: string;
		tokenId: string;
		endpoint: string;
		p256dh: string;
		auth: string;
		alerts: PushAlerts;
		policy: string;
	},
): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			'DELETE FROM web_push_subscriptions WHERE access_token_id = ?1',
		).bind(opts.tokenId),
		env.DB.prepare(
			`INSERT INTO web_push_subscriptions
			   (id, user_id, access_token_id, endpoint, key_p256dh, key_auth,
			    alert_mention, alert_follow, alert_favourite, alert_reblog,
			    alert_poll, alert_status, alert_update, alert_follow_request,
			    alert_admin_sign_up, alert_admin_report, policy, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, datetime('now'), datetime('now'))`,
		).bind(
			opts.id, opts.userId, opts.tokenId, opts.endpoint, opts.p256dh, opts.auth,
			opts.alerts.mention, opts.alerts.follow, opts.alerts.favourite, opts.alerts.reblog,
			opts.alerts.poll, opts.alerts.status, opts.alerts.update, opts.alerts.follow_request,
			opts.alerts.admin_sign_up, opts.alerts.admin_report, opts.policy,
		),
	]);
}

// ----------------------------------------------------------------
// Get subscription by access token
// ----------------------------------------------------------------

export async function getPushSubscription(
	tokenId: string,
): Promise<Record<string, unknown> | null> {
	return env.DB.prepare(
		`SELECT id, endpoint, policy, created_at, updated_at,
		        alert_mention, alert_follow, alert_favourite, alert_reblog,
		        alert_poll, alert_status, alert_update, alert_follow_request,
		        alert_admin_sign_up, alert_admin_report
		 FROM web_push_subscriptions
		 WHERE access_token_id = ?1
		 LIMIT 1`,
	).bind(tokenId).first();
}

// ----------------------------------------------------------------
// Update subscription
// ----------------------------------------------------------------

export async function updatePushSubscription(
	subscriptionId: string,
	updates: { sets: string[]; params: unknown[] },
): Promise<Record<string, unknown>> {
	const sets = [...updates.sets, `updated_at = datetime('now')`];
	const params = [...updates.params, subscriptionId];
	const paramIdx = params.length;

	await env.DB.prepare(
		`UPDATE web_push_subscriptions SET ${sets.join(', ')} WHERE id = ?${paramIdx}`,
	).bind(...params).run();

	const row = await env.DB.prepare(
		`SELECT id, endpoint, policy,
		        alert_mention, alert_follow, alert_favourite, alert_reblog,
		        alert_poll, alert_status, alert_update, alert_follow_request,
		        alert_admin_sign_up, alert_admin_report
		 FROM web_push_subscriptions WHERE id = ?1`,
	).bind(subscriptionId).first();

	return row!;
}

// ----------------------------------------------------------------
// Delete subscription
// ----------------------------------------------------------------

export async function deletePushSubscription(
	tokenId: string,
): Promise<void> {
	await env.DB.prepare(
		'DELETE FROM web_push_subscriptions WHERE access_token_id = ?1',
	).bind(tokenId).run();
}
