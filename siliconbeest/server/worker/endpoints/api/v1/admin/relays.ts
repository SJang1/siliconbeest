/**
 * Admin Relay API
 *
 * Manages ActivityPub relay subscriptions:
 * GET  /  — list all relays
 * POST /  — add a relay (sends Follow to relay inbox)
 * DELETE /:id — remove a relay (sends Undo(Follow), deletes record)
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { generateUlid } from '../../../../utils/ulid';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';
import { buildFollowActivity, buildUndoActivity } from '../../../../federation/helpers/build-activity';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

interface RelayRow {
	id: string;
	inbox_url: string;
	actor_uri: string | null;
	state: string;
	follow_activity_id: string | null;
	created_at: string;
	updated_at: string;
}

function formatRelay(row: RelayRow) {
	return {
		id: row.id,
		inbox_url: row.inbox_url,
		state: row.state,
		created_at: row.created_at,
	};
}

/**
 * Ensure the instance actor keypair exists and return it.
 */
async function getInstanceActorKey(env: Env): Promise<{
	public_key: string;
	private_key: string;
	key_id: string;
}> {
	const existing = await env.DB.prepare(
		"SELECT public_key, private_key, key_id FROM actor_keys WHERE account_id = '__instance__'",
	).first<{ public_key: string; private_key: string; key_id: string }>();

	if (existing) return existing;

	// Lazy-init (same logic as instanceActor endpoint)
	const domain = env.INSTANCE_DOMAIN;
	const keyPair = await crypto.subtle.generateKey(
		{
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256',
		},
		true,
		['sign', 'verify'],
	) as CryptoKeyPair;

	const pubKeyData = await crypto.subtle.exportKey('spki', keyPair.publicKey) as ArrayBuffer;
	const privKeyData = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey) as ArrayBuffer;

	const toBase64 = (buf: ArrayBuffer) => {
		const bytes = new Uint8Array(buf);
		let binary = '';
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary);
	};
	const toPem = (b64: string, type: 'PUBLIC' | 'PRIVATE') => {
		const label = type === 'PUBLIC' ? 'PUBLIC KEY' : 'PRIVATE KEY';
		const lines: string[] = [];
		for (let i = 0; i < b64.length; i += 64) lines.push(b64.substring(i, i + 64));
		return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
	};

	const publicKeyPem = toPem(toBase64(pubKeyData), 'PUBLIC');
	const privateKeyPem = toPem(toBase64(privKeyData), 'PRIVATE');
	const keyId = `https://${domain}/actor#main-key`;
	const id = generateUlid();
	const now = new Date().toISOString();

	// Ensure __instance__ account exists (FK requirement)
	await env.DB.prepare(
		`INSERT OR IGNORE INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at)
		 VALUES ('__instance__', ?1, NULL, ?2, '', ?3, ?4, ?5, ?5)`,
	)
		.bind(domain, env.INSTANCE_TITLE || 'SiliconBeest', `https://${domain}/actor`, `https://${domain}/about`, now)
		.run();

	await env.DB.prepare(
		`INSERT INTO actor_keys (id, account_id, public_key, private_key, key_id, created_at)
		 VALUES (?1, '__instance__', ?2, ?3, ?4, ?5)`,
	)
		.bind(id, publicKeyPem, privateKeyPem, keyId, now)
		.run();

	return { public_key: publicKeyPem, private_key: privateKeyPem, key_id: keyId };
}

// -----------------------------------------------------------------------
// GET / — list all relays
// -----------------------------------------------------------------------

app.get('/', async (c) => {
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM relays ORDER BY created_at DESC',
	).all<RelayRow>();

	return c.json((results || []).map(formatRelay));
});

// -----------------------------------------------------------------------
// POST / — add a relay
// -----------------------------------------------------------------------

app.post('/', async (c) => {
	const body = await c.req.json<{ inbox_url: string }>();
	if (!body.inbox_url) throw new AppError(422, 'inbox_url is required');

	// Validate URL format
	try {
		new URL(body.inbox_url);
	} catch {
		throw new AppError(422, 'inbox_url must be a valid URL');
	}

	// Check duplicate
	const existing = await c.env.DB.prepare(
		'SELECT id FROM relays WHERE inbox_url = ?1',
	)
		.bind(body.inbox_url)
		.first();
	if (existing) throw new AppError(409, 'Relay already exists');

	const domain = c.env.INSTANCE_DOMAIN;
	const actorUri = `https://${domain}/actor`;

	// Build Follow activity
	const followActivityJson = await buildFollowActivity(actorUri, body.inbox_url);
	const followActivityParsed = JSON.parse(followActivityJson);
	const followActivityId = followActivityParsed.id as string;

	// Create relay record
	const id = generateUlid();
	const now = new Date().toISOString();

	await c.env.DB.prepare(
		`INSERT INTO relays (id, inbox_url, state, follow_activity_id, created_at, updated_at)
		 VALUES (?1, ?2, 'pending', ?3, ?4, ?5)`,
	)
		.bind(id, body.inbox_url, followActivityId, now, now)
		.run();

	// Ensure instance actor keypair exists (needed by queue consumer for signing)
	await getInstanceActorKey(c.env);

	// Queue the delivery via federation queue
	await c.env.QUEUE_FEDERATION.send({
		type: 'deliver_activity',
		activity: followActivityParsed,
		inboxUrl: body.inbox_url,
		actorAccountId: '__instance__',
	});

	const relay = await c.env.DB.prepare('SELECT * FROM relays WHERE id = ?1')
		.bind(id)
		.first<RelayRow>();

	return c.json(formatRelay(relay!), 200);
});

// -----------------------------------------------------------------------
// DELETE /:id — remove a relay
// -----------------------------------------------------------------------

app.delete('/:id', async (c) => {
	const id = c.req.param('id');

	const relay = await c.env.DB.prepare('SELECT * FROM relays WHERE id = ?1')
		.bind(id)
		.first<RelayRow>();
	if (!relay) throw new AppError(404, 'Record not found');

	const domain = c.env.INSTANCE_DOMAIN;
	const actorUri = `https://${domain}/actor`;

	// Send Undo(Follow) to the relay inbox
	if (relay.follow_activity_id) {
		const originalFollow: Record<string, unknown> = {
			'@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
			id: relay.follow_activity_id,
			type: 'Follow',
			actor: actorUri,
			object: relay.inbox_url,
		};

		const undoJson = await buildUndoActivity(actorUri, originalFollow);

		await c.env.QUEUE_FEDERATION.send({
			type: 'deliver_activity',
			activity: JSON.parse(undoJson),
			inboxUrl: relay.inbox_url,
			actorAccountId: '__instance__',
		});
	}

	// Delete from DB
	await c.env.DB.prepare('DELETE FROM relays WHERE id = ?1').bind(id).run();

	return c.json({}, 200);
});

export default app;
