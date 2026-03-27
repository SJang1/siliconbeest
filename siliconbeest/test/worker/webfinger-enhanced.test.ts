import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const DOMAIN = 'test.siliconbeest.local';

describe('Enhanced WebFinger', () => {
	beforeAll(async () => {
		await applyMigration();
		await createTestUser('webfingeruser');
	});

	it('response has correct Content-Type of application/jrd+json', async () => {
		const res = await SELF.fetch(
			`${BASE}/.well-known/webfinger?resource=acct:webfingeruser@${DOMAIN}`,
		);
		expect(res.status).toBe(200);

		const ct = res.headers.get('Content-Type') ?? '';
		expect(ct).toContain('application/jrd+json');
	});

	it('response has aliases array with at least the actor URI', async () => {
		const res = await SELF.fetch(
			`${BASE}/.well-known/webfinger?resource=acct:webfingeruser@${DOMAIN}`,
		);
		const body = await res.json<Record<string, any>>();

		expect(body.aliases).toBeDefined();
		expect(Array.isArray(body.aliases)).toBe(true);
		expect(body.aliases).toContain(`https://${DOMAIN}/users/webfingeruser`);
	});

	it('has self link with application/activity+json type', async () => {
		const res = await SELF.fetch(
			`${BASE}/.well-known/webfinger?resource=acct:webfingeruser@${DOMAIN}`,
		);
		const body = await res.json<Record<string, any>>();

		const selfLink = body.links.find((l: any) => l.rel === 'self');
		expect(selfLink).toBeDefined();
		expect(selfLink.type).toBe('application/activity+json');
		expect(selfLink.href).toBe(`https://${DOMAIN}/users/webfingeruser`);
	});

	it('has profile-page link with correct href', async () => {
		const res = await SELF.fetch(
			`${BASE}/.well-known/webfinger?resource=acct:webfingeruser@${DOMAIN}`,
		);
		const body = await res.json<Record<string, any>>();

		const profileLink = body.links.find(
			(l: any) => l.rel === 'http://webfinger.net/rel/profile-page',
		);
		expect(profileLink).toBeDefined();
		// type is optional in WebFinger spec; Fedify may or may not include it
		if (profileLink.type) {
			expect(profileLink.type).toBe('text/html');
		}
		expect(profileLink.href).toBe(`https://${DOMAIN}/@webfingeruser`);
	});

	it('has subscribe template link (OStatus)', async () => {
		const res = await SELF.fetch(
			`${BASE}/.well-known/webfinger?resource=acct:webfingeruser@${DOMAIN}`,
		);
		const body = await res.json<Record<string, any>>();

		const subscribeLink = body.links.find(
			(l: any) => l.rel === 'http://ostatus.org/schema/1.0/subscribe',
		);
		expect(subscribeLink).toBeDefined();
		expect(subscribeLink.template).toBeDefined();
		expect(subscribeLink.template).toContain(`https://${DOMAIN}/authorize_interaction`);
		expect(subscribeLink.template).toContain('{uri}');
	});

	it('subject matches the queried resource', async () => {
		const res = await SELF.fetch(
			`${BASE}/.well-known/webfinger?resource=acct:webfingeruser@${DOMAIN}`,
		);
		const body = await res.json<Record<string, any>>();

		expect(body.subject).toBe(`acct:webfingeruser@${DOMAIN}`);
	});

	it('links array has at least 3 entries (self, profile-page, subscribe)', async () => {
		const res = await SELF.fetch(
			`${BASE}/.well-known/webfinger?resource=acct:webfingeruser@${DOMAIN}`,
		);
		const body = await res.json<Record<string, any>>();

		expect(body.links.length).toBeGreaterThanOrEqual(3);
	});
});
