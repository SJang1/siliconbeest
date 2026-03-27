import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser } from './helpers';
import { processLike } from '../src/federation/inboxProcessors/like';
import { processFollow } from '../src/federation/inboxProcessors/follow';
import type { APActivity } from '../src/types/activitypub';

const DOMAIN = 'test.siliconbeest.local';

describe('Activity Idempotency (DB-based)', () => {
	let localUser: { accountId: string; userId: string; token: string };
	let remoteAccountId: string;
	let statusId: string;

	beforeAll(async () => {
		await applyMigration();
		localUser = await createTestUser('idempuser');

		const now = new Date().toISOString();
		remoteAccountId = crypto.randomUUID();

		// Insert a remote account so resolveRemoteAccount finds it by URI
		await env.DB.prepare(
			`INSERT INTO accounts (id, username, domain, display_name, note, uri, url, inbox_url, created_at, updated_at)
			 VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
		)
			.bind(
				remoteAccountId,
				'remoteactor',
				'remote.example.com',
				'Remote Actor',
				'https://remote.example.com/users/remoteactor',
				'https://remote.example.com/@remoteactor',
				'https://remote.example.com/users/remoteactor/inbox',
				now,
				now,
			)
			.run();

		// Insert a status so processLike has something to find
		statusId = crypto.randomUUID();
		const statusUri = `https://${DOMAIN}/users/idempuser/statuses/${statusId}`;
		await env.DB.prepare(
			`INSERT INTO statuses (id, account_id, uri, url, text, visibility, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'test post', 'public', ?, ?)`,
		)
			.bind(statusId, localUser.accountId, statusUri, statusUri, now, now)
			.run();
	});

	it('duplicate Like activities are handled gracefully', async () => {
		const statusUri = `https://${DOMAIN}/users/idempuser/statuses/${statusId}`;

		const activity: APActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example.com/activities/dup-like-1',
			type: 'Like',
			actor: 'https://remote.example.com/users/remoteactor',
			object: statusUri,
		};

		// First call should succeed
		await processLike(activity, localUser.accountId, env);

		// Second call with same activity should not throw (duplicate handled by DB)
		await expect(
			processLike(activity, localUser.accountId, env),
		).resolves.not.toThrow();
	});

	it('different Like activities both succeed', async () => {
		const statusUri = `https://${DOMAIN}/users/idempuser/statuses/${statusId}`;

		for (const id of ['distinct-like-a', 'distinct-like-b']) {
			const activity: APActivity = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: `https://remote.example.com/activities/${id}`,
				type: 'Like',
				actor: 'https://remote.example.com/users/remoteactor',
				object: statusUri,
			};

			await expect(
				processLike(activity, localUser.accountId, env),
			).resolves.not.toThrow();
		}
	});

	it('duplicate Follow activities are handled gracefully', async () => {
		const activity: APActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example.com/activities/dup-follow-1',
			type: 'Follow',
			actor: 'https://remote.example.com/users/remoteactor',
			object: `https://${DOMAIN}/users/idempuser`,
		};

		// First call should succeed
		await processFollow(activity, localUser.accountId, env);

		// Second call with same activity should not throw
		await expect(
			processFollow(activity, localUser.accountId, env),
		).resolves.not.toThrow();
	});
});
