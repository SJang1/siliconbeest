import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { getStatusFederationAudience } from '../../server/worker/federation/helpers/status-audience';
import { getSuspendedDeliveryInboxes } from '../../../packages/shared/domain-blocks';
import { applyMigration } from './helpers';

const now = () => new Date().toISOString();

async function insertAccount(input: {
	id: string;
	username: string;
	domain: string | null;
	uri?: string;
	inboxUrl?: string | null;
	sharedInboxUrl?: string | null;
}) {
	const createdAt = now();
	const uri = input.uri ?? (
		input.domain
			? `https://${input.domain}/users/${input.username}`
			: `https://test.siliconbeest.local/users/${input.username}`
	);

	await env.DB.prepare(
		`INSERT INTO accounts (
			id, username, domain, display_name, note, uri, url,
			inbox_url, shared_inbox_url, created_at, updated_at
		) VALUES (?1, ?2, ?3, '', '', ?4, ?4, ?5, ?6, ?7, ?7)`,
	).bind(
		input.id,
		input.username,
		input.domain,
		uri,
		input.inboxUrl ?? null,
		input.sharedInboxUrl ?? null,
		createdAt,
	).run();
}

async function insertStatus(input: {
	id: string;
	accountId: string;
	visibility: string;
	inReplyToAccountId?: string | null;
	local?: number;
}) {
	const createdAt = now();
	await env.DB.prepare(
		`INSERT INTO statuses (
			id, uri, account_id, visibility, local, in_reply_to_account_id,
			created_at, updated_at
		) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
	).bind(
		input.id,
		`https://test.siliconbeest.local/users/${input.accountId}/statuses/${input.id}`,
		input.accountId,
		input.visibility,
		input.local ?? 1,
		input.inReplyToAccountId ?? null,
		createdAt,
	).run();
}

async function insertFollow(id: string, followerId: string, targetId: string) {
	const createdAt = now();
	await env.DB.prepare(
		`INSERT INTO follows (id, account_id, target_account_id, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?4)`,
	).bind(id, followerId, targetId, createdAt).run();
}

describe('status federation audience resolver', () => {
	beforeAll(async () => {
		await applyMigration();
	});

	it('resolves public local status readers, actor followers, reply author, and relays with inbox dedupe', async () => {
		const suffix = crypto.randomUUID();
		const authorId = `aud_author_${suffix}`;
		const actorId = `aud_actor_${suffix}`;
		const followerAId = `aud_follower_a_${suffix}`;
		const followerBId = `aud_follower_b_${suffix}`;
		const actorFollowerId = `aud_actor_follower_${suffix}`;
		const mentionId = `aud_mention_${suffix}`;
		const replyAuthorId = `aud_reply_${suffix}`;
		const statusId = `aud_status_${suffix}`;
		const relayInbox = `https://relay-${suffix}.example/inbox`;
		const relayActor = `https://relay-actor-${suffix}.example/actor`;

		await insertAccount({ id: authorId, username: `author_${suffix}`, domain: null });
		await insertAccount({ id: actorId, username: `actor_${suffix}`, domain: null });
		await insertAccount({
			id: followerAId,
			username: 'reader-a',
			domain: `reader-${suffix}.example`,
			inboxUrl: `https://reader-${suffix}.example/users/a/inbox`,
			sharedInboxUrl: `https://reader-${suffix}.example/inbox`,
		});
		await insertAccount({
			id: followerBId,
			username: 'reader-b',
			domain: `reader-${suffix}.example`,
			inboxUrl: `https://reader-${suffix}.example/users/b/inbox`,
			sharedInboxUrl: `https://reader-${suffix}.example/inbox`,
		});
		await insertAccount({
			id: actorFollowerId,
			username: 'actor-reader',
			domain: `actor-reader-${suffix}.example`,
			inboxUrl: `https://actor-reader-${suffix}.example/inbox`,
		});
		await insertAccount({
			id: mentionId,
			username: 'mentioned',
			domain: `mention-${suffix}.example`,
			inboxUrl: `https://mention-${suffix}.example/inbox`,
		});
		await insertAccount({
			id: replyAuthorId,
			username: 'reply',
			domain: `reply-${suffix}.example`,
			inboxUrl: `https://reply-${suffix}.example/inbox`,
		});
		await insertStatus({
			id: statusId,
			accountId: authorId,
			visibility: 'public',
			inReplyToAccountId: replyAuthorId,
		});
		await insertFollow(`aud_follow_a_${suffix}`, followerAId, authorId);
		await insertFollow(`aud_follow_b_${suffix}`, followerBId, authorId);
		await insertFollow(`aud_follow_actor_${suffix}`, actorFollowerId, actorId);
		await env.DB.prepare(
			'INSERT INTO mentions (id, status_id, account_id, created_at) VALUES (?1, ?2, ?3, ?4)',
		).bind(`aud_mention_row_${suffix}`, statusId, mentionId, now()).run();
		await env.DB.prepare(
			`INSERT INTO relays (id, inbox_url, actor_uri, state, created_at, updated_at)
			 VALUES (?1, ?2, ?3, 'accepted', ?4, ?4)`,
		).bind(`aud_relay_${suffix}`, relayInbox, relayActor, now()).run();

		const audience = await getStatusFederationAudience(
			{
				id: statusId,
				accountId: authorId,
				visibility: 'public',
				local: 1,
				accountDomain: null,
				inReplyToAccountId: replyAuthorId,
			},
			{ includeActorFollowersAccountId: actorId },
		);

		expect(audience.inboxUrls).toContain(`https://reader-${suffix}.example/inbox`);
		expect(audience.inboxUrls.filter((url) => url === `https://reader-${suffix}.example/inbox`)).toHaveLength(1);
		expect(audience.inboxUrls).toContain(`https://actor-reader-${suffix}.example/inbox`);
		expect(audience.inboxUrls).toContain(`https://mention-${suffix}.example/inbox`);
		expect(audience.inboxUrls).toContain(`https://reply-${suffix}.example/inbox`);
		expect(audience.inboxUrls).toContain(relayInbox);
		const relayRecipient = audience.recipients.find((recipient) => recipient.deliveryInbox === relayInbox);
		expect(relayRecipient?.id?.href).toBe(relayActor);
		expect(relayRecipient?.domain).toBe(`relay-actor-${suffix}.example`);
	});

	it('keeps direct local status delivery to mentioned remote inboxes only', async () => {
		const suffix = crypto.randomUUID();
		const authorId = `aud_dm_author_${suffix}`;
		const actorId = `aud_dm_actor_${suffix}`;
		const actorFollowerId = `aud_dm_actor_follower_${suffix}`;
		const mentionId = `aud_dm_mention_${suffix}`;
		const statusId = `aud_dm_status_${suffix}`;

		await insertAccount({ id: authorId, username: `dm_author_${suffix}`, domain: null });
		await insertAccount({ id: actorId, username: `dm_actor_${suffix}`, domain: null });
		await insertAccount({
			id: actorFollowerId,
			username: 'actor-reader',
			domain: `dm-actor-reader-${suffix}.example`,
			inboxUrl: `https://dm-actor-reader-${suffix}.example/inbox`,
		});
		await insertAccount({
			id: mentionId,
			username: 'mentioned',
			domain: `dm-mention-${suffix}.example`,
			inboxUrl: `https://dm-mention-${suffix}.example/inbox`,
		});
		await insertStatus({ id: statusId, accountId: authorId, visibility: 'direct' });
		await insertFollow(`aud_dm_follow_actor_${suffix}`, actorFollowerId, actorId);
		await env.DB.prepare(
			'INSERT INTO mentions (id, status_id, account_id, created_at) VALUES (?1, ?2, ?3, ?4)',
		).bind(`aud_dm_mention_row_${suffix}`, statusId, mentionId, now()).run();

		const audience = await getStatusFederationAudience(
			{
				id: statusId,
				accountId: authorId,
				visibility: 'direct',
				local: 1,
				accountDomain: null,
			},
			{ includeActorFollowersAccountId: actorId },
		);

		expect(audience.inboxUrls).toEqual([`https://dm-mention-${suffix}.example/inbox`]);
	});

	it('keeps private local status delivery to followers of the status author, not actor followers', async () => {
		const suffix = crypto.randomUUID();
		const authorId = `aud_private_author_${suffix}`;
		const actorId = `aud_private_actor_${suffix}`;
		const authorFollowerId = `aud_private_author_follower_${suffix}`;
		const actorFollowerId = `aud_private_actor_follower_${suffix}`;
		const statusId = `aud_private_status_${suffix}`;

		await insertAccount({ id: authorId, username: `private_author_${suffix}`, domain: null });
		await insertAccount({ id: actorId, username: `private_actor_${suffix}`, domain: null });
		await insertAccount({
			id: authorFollowerId,
			username: 'author-reader',
			domain: `private-author-reader-${suffix}.example`,
			inboxUrl: `https://private-author-reader-${suffix}.example/inbox`,
		});
		await insertAccount({
			id: actorFollowerId,
			username: 'actor-reader',
			domain: `private-actor-reader-${suffix}.example`,
			inboxUrl: `https://private-actor-reader-${suffix}.example/inbox`,
		});
		await insertStatus({ id: statusId, accountId: authorId, visibility: 'private' });
		await insertFollow(`aud_private_follow_author_${suffix}`, authorFollowerId, authorId);
		await insertFollow(`aud_private_follow_actor_${suffix}`, actorFollowerId, actorId);

		const audience = await getStatusFederationAudience(
			{
				id: statusId,
				accountId: authorId,
				visibility: 'private',
				local: 1,
				accountDomain: null,
			},
			{ includeActorFollowersAccountId: actorId },
		);

		expect(audience.inboxUrls).toEqual([`https://private-author-reader-${suffix}.example/inbox`]);
	});

	it('returns no local-status audience for remote-origin statuses', async () => {
		const audience = await getStatusFederationAudience({
			id: 'remote_status',
			accountId: 'remote_author',
			visibility: 'public',
			local: 0,
			accountDomain: 'remote.example',
		});

		expect(audience.recipients).toEqual([]);
		expect(audience.inboxUrls).toEqual([]);
		expect(audience.domains).toEqual([]);
	});

	it('maps every identity domain behind a deduped shared inbox before delivery', async () => {
		const suffix = crypto.randomUUID();
		const sharedInbox = `https://delivery-${suffix}.example/inbox`;
		const allowedDomain = `allowed-${suffix}.example`;
		const blockedDomain = `blocked-${suffix}.example`;

		await insertAccount({
			id: `aud_allowed_${suffix}`,
			username: 'allowed',
			domain: allowedDomain,
			inboxUrl: `${sharedInbox}/allowed`,
			sharedInboxUrl: sharedInbox,
		});
		await insertAccount({
			id: `aud_blocked_${suffix}`,
			username: 'blocked',
			domain: blockedDomain,
			inboxUrl: `${sharedInbox}/blocked`,
			sharedInboxUrl: sharedInbox,
		});
		await env.DB.prepare(
			`INSERT INTO domain_blocks (id, domain, severity, created_at, updated_at)
			 VALUES (?1, ?2, 'suspend', ?3, ?3)`,
		).bind(`aud_block_${suffix}`, blockedDomain, now()).run();

		await expect(getSuspendedDeliveryInboxes(
			env.DB,
			[sharedInbox],
		)).resolves.toEqual(new Set([sharedInbox]));
	});

	it('uses both inbox indexes for batched delivery identity lookups', async () => {
		const { results } = await env.DB.prepare(
			`EXPLAIN QUERY PLAN
			 WITH requested(inbox_url) AS (VALUES (?1), (?2))
			 SELECT DISTINCT requested.inbox_url, accounts.domain
			 FROM requested
			 JOIN accounts
			   ON accounts.inbox_url = requested.inbox_url
			   OR accounts.shared_inbox_url = requested.inbox_url
			 WHERE accounts.domain IS NOT NULL`,
		).bind(
			'https://delivery-one.example/inbox',
			'https://delivery-two.example/inbox',
		).all<{ detail: string }>();

		const plan = (results ?? []).map((row) => row.detail).join('\n');
		expect(plan).toContain('idx_accounts_inbox_url');
		expect(plan).toContain('idx_accounts_shared_inbox_url');
	});
});
