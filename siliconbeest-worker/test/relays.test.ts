import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Relays', () => {
	let admin: { accountId: string; userId: string; token: string };
	let regularUser: { accountId: string; userId: string; token: string };

	beforeAll(async () => {
		await applyMigration();
		admin = await createTestUser('relayadmin', { role: 'admin' });
		regularUser = await createTestUser('relayuser');
	});

	// -------------------------------------------------------------------
	// GET /actor
	// -------------------------------------------------------------------
	describe('GET /actor', () => {
		it('returns Application actor with publicKey', async () => {
			const res = await SELF.fetch(`${BASE}/actor`, {
				headers: { Accept: 'application/activity+json' },
			});
			expect(res.status).toBe(200);
			const body = await res.json<any>();
			expect(body.type).toBe('Application');
			expect(body.id).toContain('/actor');
			expect(body.inbox).toContain('/inbox');
			expect(body.publicKey).toBeDefined();
			expect(body.publicKey.publicKeyPem).toContain('BEGIN PUBLIC KEY');
			expect(body.publicKey.owner).toBe(body.id);
		});

		it('returns same key on repeated requests (lazy init only once)', async () => {
			const res1 = await SELF.fetch(`${BASE}/actor`, {
				headers: { Accept: 'application/activity+json' },
			});
			const body1 = await res1.json<any>();

			const res2 = await SELF.fetch(`${BASE}/actor`, {
				headers: { Accept: 'application/activity+json' },
			});
			const body2 = await res2.json<any>();

			expect(body1.publicKey.publicKeyPem).toBe(body2.publicKey.publicKeyPem);
		});
	});

	// -------------------------------------------------------------------
	// POST /api/v1/admin/relays
	// -------------------------------------------------------------------
	describe('POST /api/v1/admin/relays', () => {
		it('creates relay with state=pending', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/admin/relays`, {
				method: 'POST',
				headers: authHeaders(admin.token),
				body: JSON.stringify({ inbox_url: 'https://relay.example.com/inbox' }),
			});
			expect(res.status).toBe(200);
			const body = await res.json<any>();
			expect(body.id).toBeDefined();
			expect(body.inbox_url).toBe('https://relay.example.com/inbox');
			expect(body.state).toBe('pending');
			expect(body.created_at).toBeDefined();
		});

		it('returns 409 for duplicate inbox_url', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/admin/relays`, {
				method: 'POST',
				headers: authHeaders(admin.token),
				body: JSON.stringify({ inbox_url: 'https://relay.example.com/inbox' }),
			});
			expect(res.status).toBe(409);
		});

		it('returns 422 for missing inbox_url', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/admin/relays`, {
				method: 'POST',
				headers: authHeaders(admin.token),
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(422);
		});

		it('returns 422 for invalid URL', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/admin/relays`, {
				method: 'POST',
				headers: authHeaders(admin.token),
				body: JSON.stringify({ inbox_url: 'not-a-url' }),
			});
			expect(res.status).toBe(422);
		});

		it('returns 403 for non-admin user', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/admin/relays`, {
				method: 'POST',
				headers: authHeaders(regularUser.token),
				body: JSON.stringify({ inbox_url: 'https://relay2.example.com/inbox' }),
			});
			expect(res.status).toBe(403);
		});

		it('returns 401 without auth', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/admin/relays`, {
				method: 'POST',
				body: JSON.stringify({ inbox_url: 'https://relay3.example.com/inbox' }),
			});
			expect(res.status).toBe(401);
		});
	});

	// -------------------------------------------------------------------
	// GET /api/v1/admin/relays
	// -------------------------------------------------------------------
	describe('GET /api/v1/admin/relays', () => {
		it('lists relays for admin', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/admin/relays`, {
				headers: authHeaders(admin.token),
			});
			expect(res.status).toBe(200);
			const body = await res.json<any[]>();
			expect(Array.isArray(body)).toBe(true);
			expect(body.length).toBeGreaterThanOrEqual(1);
			expect(body[0].inbox_url).toBeDefined();
			expect(body[0].state).toBeDefined();
		});

		it('returns 403 for non-admin', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/admin/relays`, {
				headers: authHeaders(regularUser.token),
			});
			expect(res.status).toBe(403);
		});
	});

	// -------------------------------------------------------------------
	// DELETE /api/v1/admin/relays/:id
	// -------------------------------------------------------------------
	describe('DELETE /api/v1/admin/relays/:id', () => {
		it('removes a relay', async () => {
			// First create a relay to delete
			const createRes = await SELF.fetch(`${BASE}/api/v1/admin/relays`, {
				method: 'POST',
				headers: authHeaders(admin.token),
				body: JSON.stringify({ inbox_url: 'https://relay-to-delete.example.com/inbox' }),
			});
			const created = await createRes.json<any>();
			expect(created.id).toBeDefined();

			// Delete it
			const deleteRes = await SELF.fetch(
				`${BASE}/api/v1/admin/relays/${created.id}`,
				{
					method: 'DELETE',
					headers: authHeaders(admin.token),
				},
			);
			expect(deleteRes.status).toBe(200);

			// Verify it's gone
			const listRes = await SELF.fetch(`${BASE}/api/v1/admin/relays`, {
				headers: authHeaders(admin.token),
			});
			const relays = await listRes.json<any[]>();
			const found = relays.find((r: any) => r.id === created.id);
			expect(found).toBeUndefined();
		});

		it('returns 404 for non-existent relay', async () => {
			const res = await SELF.fetch(
				`${BASE}/api/v1/admin/relays/nonexistent123`,
				{
					method: 'DELETE',
					headers: authHeaders(admin.token),
				},
			);
			expect(res.status).toBe(404);
		});

		it('returns 403 for non-admin', async () => {
			const res = await SELF.fetch(
				`${BASE}/api/v1/admin/relays/someid`,
				{
					method: 'DELETE',
					headers: authHeaders(regularUser.token),
				},
			);
			expect(res.status).toBe(403);
		});
	});
});
