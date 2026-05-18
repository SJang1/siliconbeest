import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { setupInboxListeners } from '../../../packages/shared/activitypub/inbox-listeners';
import { applyMigration } from './helpers';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

function now() {
	return new Date().toISOString();
}

async function insertLocalAccount(id: string, username: string) {
	const createdAt = now();
	await env.DB.prepare(
		`INSERT INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at)
		 VALUES (?1, ?2, NULL, '', '', ?3, ?4, ?5, ?5)`,
	).bind(
		id,
		username,
		`https://test.siliconbeest.local/users/${username}`,
		`https://test.siliconbeest.local/@${username}`,
		createdAt,
	).run();
}

async function insertLocalStatus(id: string, accountId: string, uri: string, visibility = 'public') {
	const createdAt = now();
	await env.DB.prepare(
		`INSERT INTO statuses (id, uri, account_id, visibility, local, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)`,
	).bind(id, uri, accountId, visibility, createdAt).run();
}

function buildListeners(processCreate = vi.fn(async () => {})) {
	const handlers = new Map<unknown, (ctx: any, activity: any) => Promise<void>>();
	const builder = {
		on: vi.fn((type: unknown, handler: (ctx: any, activity: any) => Promise<void>) => {
			handlers.set(type, handler);
			return builder;
		}),
		onError: vi.fn(),
		setSharedKeyDispatcher: vi.fn(() => builder),
		onUnverifiedActivity: vi.fn(() => builder),
	};
	const federation = {
		setInboxListeners: vi.fn(() => builder),
	};
	const vocab = {
		Follow: Symbol('Follow'),
		Create: Symbol('Create'),
		Like: Symbol('Like'),
		Announce: Symbol('Announce'),
		Delete: Symbol('Delete'),
		Update: Symbol('Update'),
		Undo: Symbol('Undo'),
		Block: Symbol('Block'),
		Flag: Symbol('Flag'),
		Move: Symbol('Move'),
		Accept: Symbol('Accept'),
		Reject: Symbol('Reject'),
		EmojiReact: Symbol('EmojiReact'),
	};
	const noop = vi.fn(async () => {});

	setupInboxListeners(
		federation,
		vocab,
		{
			processFollow: noop,
			processCreate,
			processAccept: noop,
			processReject: noop,
			processLike: noop,
			processAnnounce: noop,
			processDelete: noop,
			processUpdate: noop,
			processUndo: noop,
			processBlock: noop,
			processMove: noop,
			processFlag: noop,
			processEmojiReact: noop,
		},
	);

	return { handlers, vocab, processCreate };
}

describe('inbox activity forwarding', () => {
	beforeAll(async () => {
		await applyMigration();
	});

	it('forwards a public remote Create reply to the local parent author followers', async () => {
		const suffix = crypto.randomUUID();
		const authorId = `forward_author_${suffix}`;
		const username = `forward_author_${suffix}`;
		const parentUri = `https://test.siliconbeest.local/users/${username}/statuses/parent`;
		await insertLocalAccount(authorId, username);
		await insertLocalStatus(`forward_status_${suffix}`, authorId, parentUri);

		const { handlers, vocab, processCreate } = buildListeners();
		const forwardActivity = vi.fn(async () => {});
		const create = {
			actorId: new URL('https://remote.example/users/alice'),
			toJsonLd: async () => ({
				id: `https://remote.example/users/alice/statuses/${suffix}/activity`,
				type: 'Create',
				actor: 'https://remote.example/users/alice',
				to: [PUBLIC],
				object: {
					id: `https://remote.example/users/alice/statuses/${suffix}`,
					type: 'Note',
					attributedTo: 'https://remote.example/users/alice',
					inReplyTo: parentUri,
					to: [PUBLIC],
					content: 'reply',
				},
			}),
		};

		await handlers.get(vocab.Create)!({ recipient: null, data: {}, forwardActivity }, create);

		expect(processCreate).toHaveBeenCalledOnce();
		expect(forwardActivity).toHaveBeenCalledWith(
			{ identifier: username },
			'followers',
			{ skipIfUnsigned: true },
		);
	});

	it('does not forward a Create reply to a local direct status', async () => {
		const suffix = crypto.randomUUID();
		const authorId = `forward_dm_author_${suffix}`;
		const username = `forward_dm_author_${suffix}`;
		const parentUri = `https://test.siliconbeest.local/users/${username}/statuses/direct`;
		await insertLocalAccount(authorId, username);
		await insertLocalStatus(`forward_dm_status_${suffix}`, authorId, parentUri, 'direct');

		const { handlers, vocab } = buildListeners();
		const forwardActivity = vi.fn(async () => {});
		const create = {
			actorId: new URL('https://remote.example/users/alice'),
			toJsonLd: async () => ({
				id: `https://remote.example/users/alice/statuses/${suffix}/activity`,
				type: 'Create',
				actor: 'https://remote.example/users/alice',
				to: [PUBLIC],
				object: {
					id: `https://remote.example/users/alice/statuses/${suffix}`,
					type: 'Note',
					attributedTo: 'https://remote.example/users/alice',
					inReplyTo: parentUri,
					to: [PUBLIC],
					content: 'reply',
				},
			}),
		};

		await handlers.get(vocab.Create)!({ recipient: null, data: {}, forwardActivity }, create);

		expect(forwardActivity).not.toHaveBeenCalled();
	});
});
