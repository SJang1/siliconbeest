import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const DOMAIN = 'test.siliconbeest.local';

describe('ActivityPub Collection Pagination', () => {
	let user: { accountId: string; userId: string; token: string };

	beforeAll(async () => {
		await applyMigration();
		user = await createTestUser('colluser');
	});

	// ---------------------------------------------------------------
	// Followers Collection
	// ---------------------------------------------------------------
	describe('GET /users/:username/followers', () => {
		it('returns OrderedCollection without cursor param', async () => {
			const res = await SELF.fetch(`${BASE}/users/colluser/followers`, {
				headers: { Accept: 'application/activity+json' },
			});
			expect(res.status).toBe(200);

			const body = await res.json<Record<string, any>>();
			expect(body.type).toBe('OrderedCollection');
			expect(typeof body.totalItems).toBe('number');
			expect(body.first).toBeDefined();
			// Fedify uses ?cursor= for pagination
			expect(body.first).toContain('/followers?cursor=');
			expect(body.id).toBe(`https://${DOMAIN}/users/colluser/followers`);
		});

		it('returns OrderedCollectionPage with cursor param', async () => {
			const res = await SELF.fetch(`${BASE}/users/colluser/followers?cursor=`, {
				headers: { Accept: 'application/activity+json' },
			});
			expect(res.status).toBe(200);

			const body = await res.json<Record<string, any>>();
			expect(body.type).toBe('OrderedCollectionPage');
			// Fedify omits orderedItems when empty
			expect(body.partOf).toBe(`https://${DOMAIN}/users/colluser/followers`);
		});

		it('shows followers in the page after creating follows', async () => {
			// Create a remote follower account
			const now = new Date().toISOString();
			const followerAccountId = crypto.randomUUID();
			await env.DB.prepare(
				`INSERT INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at)
				 VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`,
			)
				.bind(
					followerAccountId,
					'remotefollower',
					'remote.example.com',
					'Remote Follower',
					'https://remote.example.com/users/remotefollower',
					'https://remote.example.com/@remotefollower',
					now,
					now,
				)
				.run();

			// Create a follow relationship
			await env.DB.prepare(
				`INSERT INTO follows (id, account_id, target_account_id, uri, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
				.bind(
					crypto.randomUUID(),
					followerAccountId,
					user.accountId,
					`https://remote.example.com/users/remotefollower#follow-1`,
					now,
					now,
				)
				.run();

			// Update followers count
			await env.DB.prepare(
				`UPDATE accounts SET followers_count = followers_count + 1 WHERE id = ?`,
			)
				.bind(user.accountId)
				.run();

			// Check the followers page (Fedify uses ?cursor= for first page)
			const res = await SELF.fetch(`${BASE}/users/colluser/followers?cursor=`, {
				headers: { Accept: 'application/activity+json' },
			});
			expect(res.status).toBe(200);

			const body = await res.json<Record<string, any>>();
			expect(body.type).toBe('OrderedCollectionPage');
			expect(body.orderedItems).toContain('https://remote.example.com/users/remotefollower');
		});

		it('returns empty collection for unknown user', async () => {
			// Fedify returns 200 with an empty collection for unknown users
			const res = await SELF.fetch(`${BASE}/users/unknownuser/followers`, {
				headers: { Accept: 'application/activity+json' },
			});
			expect(res.status).toBe(200);
			const body = await res.json<Record<string, any>>();
			expect(body.type).toBe('OrderedCollection');
			expect(body.totalItems).toBe(0);
		});
	});

	// ---------------------------------------------------------------
	// Following Collection
	// ---------------------------------------------------------------
	describe('GET /users/:username/following', () => {
		it('returns OrderedCollection without cursor param', async () => {
			const res = await SELF.fetch(`${BASE}/users/colluser/following`, {
				headers: { Accept: 'application/activity+json' },
			});
			expect(res.status).toBe(200);

			const body = await res.json<Record<string, any>>();
			expect(body.type).toBe('OrderedCollection');
			expect(typeof body.totalItems).toBe('number');
			expect(body.first).toBeDefined();
			// Fedify uses ?cursor= for pagination
			expect(body.first).toContain('/following?cursor=');
			expect(body.id).toBe(`https://${DOMAIN}/users/colluser/following`);
		});

		it('returns OrderedCollectionPage with cursor param', async () => {
			const res = await SELF.fetch(`${BASE}/users/colluser/following?cursor=`, {
				headers: { Accept: 'application/activity+json' },
			});
			expect(res.status).toBe(200);

			const body = await res.json<Record<string, any>>();
			expect(body.type).toBe('OrderedCollectionPage');
			// Fedify omits orderedItems when empty
			expect(body.partOf).toBe(`https://${DOMAIN}/users/colluser/following`);
		});

		it('shows following accounts after creating follows', async () => {
			const now = new Date().toISOString();
			const followedAccountId = crypto.randomUUID();
			await env.DB.prepare(
				`INSERT INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at)
				 VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`,
			)
				.bind(
					followedAccountId,
					'followeduser',
					'remote.example.com',
					'Followed User',
					'https://remote.example.com/users/followeduser',
					'https://remote.example.com/@followeduser',
					now,
					now,
				)
				.run();

			await env.DB.prepare(
				`INSERT INTO follows (id, account_id, target_account_id, uri, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
				.bind(
					crypto.randomUUID(),
					user.accountId,
					followedAccountId,
					`https://${DOMAIN}/users/colluser#follow-out-1`,
					now,
					now,
				)
				.run();

			await env.DB.prepare(
				`UPDATE accounts SET following_count = following_count + 1 WHERE id = ?`,
			)
				.bind(user.accountId)
				.run();

			// Fedify uses ?cursor= for first page
			const res = await SELF.fetch(`${BASE}/users/colluser/following?cursor=`, {
				headers: { Accept: 'application/activity+json' },
			});
			expect(res.status).toBe(200);

			const body = await res.json<Record<string, any>>();
			expect(body.type).toBe('OrderedCollectionPage');
			expect(body.orderedItems).toContain('https://remote.example.com/users/followeduser');
		});
	});

	// ---------------------------------------------------------------
	// Outbox Collection
	// ---------------------------------------------------------------
	describe('GET /users/:username/outbox', () => {
		beforeAll(async () => {
			// Create a public status so the outbox has content
			await SELF.fetch(`${BASE}/api/v1/statuses`, {
				method: 'POST',
				headers: authHeaders(user.token),
				body: JSON.stringify({ status: 'Outbox test post', visibility: 'public' }),
			});
		});

		it('returns OrderedCollection without cursor param', async () => {
			const res = await SELF.fetch(`${BASE}/users/colluser/outbox`, {
				headers: { Accept: 'application/activity+json' },
			});
			expect(res.status).toBe(200);

			const body = await res.json<Record<string, any>>();
			expect(body.type).toBe('OrderedCollection');
			expect(typeof body.totalItems).toBe('number');
			expect(body.totalItems).toBeGreaterThanOrEqual(1);
			expect(body.first).toBeDefined();
			// Fedify uses ?cursor= for pagination
			expect(body.first).toContain('/outbox?cursor=');
			expect(body.id).toBe(`https://${DOMAIN}/users/colluser/outbox`);
		});

		it('returns OrderedCollectionPage with Create activities', async () => {
			// Fedify uses ?cursor= for first page
			const res = await SELF.fetch(`${BASE}/users/colluser/outbox?cursor=`, {
				headers: { Accept: 'application/activity+json' },
			});
			expect(res.status).toBe(200);

			const body = await res.json<Record<string, any>>();
			expect(body.type).toBe('OrderedCollectionPage');
			expect(body.orderedItems).toBeDefined();
			expect(Array.isArray(body.orderedItems)).toBe(true);
			expect(body.orderedItems.length).toBeGreaterThanOrEqual(1);
			expect(body.partOf).toBe(`https://${DOMAIN}/users/colluser/outbox`);

			// Each item should be a Create activity wrapping a Note
			const firstItem = body.orderedItems[0];
			expect(firstItem.type).toBe('Create');
			expect(firstItem.actor).toContain('/users/colluser');
			expect(firstItem.object).toBeDefined();
			expect(firstItem.object.type).toBe('Note');
		});

		it('returns empty collection for unknown user', async () => {
			// Fedify returns 200 with an empty collection for unknown users
			const res = await SELF.fetch(`${BASE}/users/unknownuser/outbox`, {
				headers: { Accept: 'application/activity+json' },
			});
			expect(res.status).toBe(200);
			const body = await res.json<Record<string, any>>();
			expect(body.type).toBe('OrderedCollection');
			expect(body.totalItems).toBe(0);
		});
	});
});
