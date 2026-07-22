import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { processAnnounce } from '../../server/worker/federation/inboxProcessors/announce';
import { processAccept } from '../../server/worker/federation/inboxProcessors/accept';
import { processBlock } from '../../server/worker/federation/inboxProcessors/block';
import { processCreate } from '../../server/worker/federation/inboxProcessors/create';
import { processDelete } from '../../server/worker/federation/inboxProcessors/delete';
import { processEmojiReact } from '../../server/worker/federation/inboxProcessors/emojiReact';
import { processFollow } from '../../server/worker/federation/inboxProcessors/follow';
import { processLike } from '../../server/worker/federation/inboxProcessors/like';
import { processQuoteRequest } from '../../server/worker/federation/inboxProcessors/quoteRequest';
import { processReject } from '../../server/worker/federation/inboxProcessors/reject';
import { processUndo } from '../../server/worker/federation/inboxProcessors/undo';
import { processUpdate } from '../../server/worker/federation/inboxProcessors/update';
import type { APActivity } from '../../server/worker/types/activitypub';
import { applyMigration, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

interface RemoteActor {
  id: string;
  uri: string;
}

interface StatusFixture {
  id: string;
  uri: string;
}

async function insertRemoteActor(
  id: string,
  username: string,
  suspended: boolean = false,
): Promise<RemoteActor> {
  const now = new Date().toISOString();
  const uri = `https://remote.example/users/${username}`;
  await env.DB_META_C000.prepare(
    `INSERT INTO accounts
       (id, username, domain, display_name, note, uri, url, inbox_url,
        suspended_at, created_at, updated_at)
     VALUES (?1, ?2, 'remote.example', ?2, '', ?3, ?3, ?4, ?5, ?6, ?6)`,
  ).bind(
    id,
    username,
    uri,
    `${uri}/inbox`,
    suspended ? now : null,
    now,
  ).run();
  return { id, uri };
}

async function insertStatus(
  id: string,
  accountId: string,
  visibility: string,
  deleted: boolean = false,
): Promise<StatusFixture> {
  const now = new Date().toISOString();
  const uri = `${BASE}/users/federation_author/statuses/${id}`;
  await env.DB_META_C000.prepare(
    `INSERT INTO statuses
       (id, uri, url, account_id, text, content, visibility, local,
        deleted_at, created_at, updated_at)
     VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?8)`,
  ).bind(
    id,
    uri,
    accountId,
    id,
    `<p>${id}</p>`,
    visibility,
    deleted ? now : null,
    now,
  ).run();
  return { id, uri };
}

function likeActivity(
  id: string,
  actorUri: string,
  statusUri: string,
): APActivity {
  return {
    type: 'Like',
    id: `https://remote.example/activities/${id}`,
    actor: actorUri,
    object: statusUri,
  };
}

function reactionActivity(
  id: string,
  actorUri: string,
  statusUri: string,
  shortcode: string,
): APActivity & Record<string, object | string | string[] | null | undefined> {
  return {
    type: 'EmojiReact',
    id: `https://remote.example/activities/${id}`,
    actor: actorUri,
    object: statusUri,
    content: `:${shortcode}:`,
    tag: [{
      type: 'Emoji',
      name: `:${shortcode}:`,
      icon: {
        type: 'Image',
        url: `https://emoji.example/${shortcode}.png`,
      },
    }],
  };
}

function announceActivity(
  id: string,
  actorUri: string,
  statusUri: string,
  quote: boolean,
): APActivity {
  return {
    type: 'Announce',
    id: `https://remote.example/activities/${id}`,
    actor: actorUri,
    object: statusUri,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    ...(quote ? { content: '<p>Quoted without permission</p>' } : {}),
  };
}

describe('signed federation status interaction permissions', () => {
  let localAuthorId: string;
  let stranger: RemoteActor;
  let suspendedActor: RemoteActor;
  let memorialActor: RemoteActor;
  let disabledLocalActor: Awaited<ReturnType<typeof createTestUser>>;
  let pendingLocalActor: Awaited<ReturnType<typeof createTestUser>>;
  let publicStatus: StatusFixture;
  let unlistedStatus: StatusFixture;
  let privateStatus: StatusFixture;
  let directStatus: StatusFixture;
  let invalidStatus: StatusFixture;
  let deletedStatus: StatusFixture;
  let unsupportedAddressingStatus: StatusFixture;

  beforeAll(async () => {
    await applyMigration();
    const localAuthor = await createTestUser('federation_author');
    localAuthorId = localAuthor.accountId;
    stranger = await insertRemoteActor(
      'federation_permission_stranger',
      'permission_stranger',
    );
    suspendedActor = await insertRemoteActor(
      'federation_permission_suspended',
      'permission_suspended',
      true,
    );
    memorialActor = await insertRemoteActor(
      'federation_permission_memorial',
      'permission_memorial',
    );
    await env.DB_META_C000.prepare('UPDATE accounts SET memorial = 1 WHERE id = ?1')
      .bind(memorialActor.id).run();
    disabledLocalActor = await createTestUser('federation_disabled_local');
    pendingLocalActor = await createTestUser('federation_pending_local');
    await env.DB_META_C000.prepare('UPDATE users SET disabled = 1 WHERE id = ?1')
      .bind(disabledLocalActor.userId).run();
    await env.DB_META_C000.prepare('UPDATE users SET approved = 0 WHERE id = ?1')
      .bind(pendingLocalActor.userId).run();

    publicStatus = await insertStatus(
      'federation_permission_public',
      localAuthorId,
      'public',
    );
    unlistedStatus = await insertStatus(
      'federation_permission_unlisted',
      localAuthorId,
      'unlisted',
    );
    privateStatus = await insertStatus(
      'federation_permission_private',
      localAuthorId,
      'private',
    );
    directStatus = await insertStatus(
      'federation_permission_direct',
      localAuthorId,
      'direct',
    );
    invalidStatus = await insertStatus(
      'federation_permission_invalid',
      localAuthorId,
      'circle',
    );
    deletedStatus = await insertStatus(
      'federation_permission_deleted',
      localAuthorId,
      'public',
      true,
    );
    unsupportedAddressingStatus = await insertStatus(
      'federation_permission_unsupported_addressing',
      localAuthorId,
      'public',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops denied Like, EmojiReact, ordinary Announce, and quote Announce before all side effects', async () => {
    const deniedCases = [
      { name: 'private', actor: stranger, status: privateStatus },
      { name: 'direct', actor: stranger, status: directStatus },
      { name: 'invalid', actor: stranger, status: invalidStatus },
      { name: 'deleted', actor: stranger, status: deletedStatus },
      { name: 'suspended', actor: suspendedActor, status: publicStatus },
    ];
    const queueSend = vi.spyOn(env.QUEUE_INTERNAL, 'send');

    for (const denied of deniedCases) {
      await processLike(
        likeActivity(`denied-like-${denied.name}`, denied.actor.uri, denied.status.uri),
        localAuthorId,
      );
      await processEmojiReact(
        reactionActivity(
          `denied-reaction-${denied.name}`,
          denied.actor.uri,
          denied.status.uri,
          `denied_${denied.name}`,
        ),
        localAuthorId,
      );
      await processAnnounce(
        announceActivity(
          `denied-announce-${denied.name}`,
          denied.actor.uri,
          denied.status.uri,
          false,
        ),
        localAuthorId,
      );
      await processAnnounce(
        announceActivity(
          `denied-quote-${denied.name}`,
          denied.actor.uri,
          denied.status.uri,
          true,
        ),
        localAuthorId,
      );
    }

    expect(queueSend).not.toHaveBeenCalled();

    const favourites = await env.DB_META_C000.prepare(
      `SELECT COUNT(*) AS count FROM favourites
       WHERE account_id IN (?1, ?2)`,
    ).bind(stranger.id, suspendedActor.id).first<{ count: number }>();
    expect(favourites?.count).toBe(0);

    const reactions = await env.DB_META_C000.prepare(
      `SELECT COUNT(*) AS count FROM emoji_reactions
       WHERE account_id IN (?1, ?2)`,
    ).bind(stranger.id, suspendedActor.id).first<{ count: number }>();
    expect(reactions?.count).toBe(0);

    const wrappers = await env.DB_META_C000.prepare(
      `SELECT COUNT(*) AS count FROM statuses
       WHERE account_id IN (?1, ?2)
         AND (reblog_of_id IS NOT NULL OR quote_id IS NOT NULL)`,
    ).bind(stranger.id, suspendedActor.id).first<{ count: number }>();
    expect(wrappers?.count).toBe(0);

    const customEmojis = await env.DB_META_C000.prepare(
      "SELECT COUNT(*) AS count FROM custom_emojis WHERE shortcode LIKE 'denied_%'",
    ).first<{ count: number }>();
    expect(customEmojis?.count).toBe(0);

    const counts = await env.DB_META_C000.prepare(
      `SELECT SUM(favourites_count) AS favourites, SUM(reblogs_count) AS reblogs
       FROM statuses WHERE id IN (?1, ?2, ?3, ?4, ?5)`,
    ).bind(
      privateStatus.id,
      directStatus.id,
      invalidStatus.id,
      deletedStatus.id,
      publicStatus.id,
    ).first<{ favourites: number; reblogs: number }>();
    expect(counts?.favourites).toBe(0);
    expect(counts?.reblogs).toBe(0);

    const notifications = await env.DB_META_C000.prepare(
      `SELECT COUNT(*) AS count FROM notifications
       WHERE from_account_id IN (?1, ?2)`,
    ).bind(stranger.id, suspendedActor.id).first<{ count: number }>();
    expect(notifications?.count).toBe(0);
  });

  it('binds Like, EmojiReact, and Misskey Like reactions to the exact personal inbox owner', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const otherLocal = await createTestUser(`interaction_inbox_${suffix}`);
    const target = await insertStatus(
      `interaction_inbox_target_${suffix}`,
      localAuthorId,
      'public',
    );
    const misskeyReaction: APActivity = {
      ...likeActivity(
        `wrong-inbox-misskey-${suffix}`,
        stranger.uri,
        target.uri,
      ),
      content: `:misskey_${suffix}:`,
      _misskey_reaction: `:misskey_${suffix}:`,
    };

    expect(await processLike(
      likeActivity(`wrong-inbox-like-${suffix}`, stranger.uri, target.uri),
      otherLocal.accountId,
    )).toBe(false);
    expect(await processEmojiReact(
      reactionActivity(
        `wrong-inbox-reaction-${suffix}`,
        stranger.uri,
        target.uri,
        `wrong_inbox_${suffix}`,
      ),
      otherLocal.accountId,
    )).toBe(false);
    expect(await processLike(misskeyReaction, otherLocal.accountId)).toBe(false);

    const denied = await env.DB_META_C000.prepare(
      `SELECT
         (SELECT COUNT(*) FROM favourites
          WHERE account_id = ?1 AND status_id = ?2) AS favourites,
         (SELECT COUNT(*) FROM emoji_reactions
          WHERE account_id = ?1 AND status_id = ?2) AS reactions`,
    ).bind(stranger.id, target.id).first<{
      favourites: number;
      reactions: number;
    }>();
    expect(denied).toEqual({ favourites: 0, reactions: 0 });

    expect(await processLike(misskeyReaction, localAuthorId)).toBe(true);
    const acceptedMisskey = await env.DB_META_C000.prepare(
      `SELECT COUNT(*) AS count FROM emoji_reactions
       WHERE account_id = ?1 AND status_id = ?2`,
    ).bind(stranger.id, target.id).first<{ count: number }>();
    expect(acceptedMisskey?.count).toBe(1);
  });

  it('rejects Like and EmojiReact when the target status belongs to a remote account', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const remoteAuthor = await insertRemoteActor(
      `interaction_remote_author_${suffix}`,
      `interaction_remote_author_${suffix}`,
    );
    const target = await insertStatus(
      `interaction_remote_target_${suffix}`,
      remoteAuthor.id,
      'public',
    );

    expect(await processLike(
      likeActivity(`remote-target-like-${suffix}`, stranger.uri, target.uri),
      '',
    )).toBe(false);
    expect(await processEmojiReact(
      reactionActivity(
        `remote-target-reaction-${suffix}`,
        stranger.uri,
        target.uri,
        `remote_target_${suffix}`,
      ),
      '',
    )).toBe(false);

    const relations = await env.DB_META_C000.prepare(
      `SELECT
         (SELECT COUNT(*) FROM favourites
          WHERE account_id = ?1 AND status_id = ?2) AS favourites,
         (SELECT COUNT(*) FROM emoji_reactions
          WHERE account_id = ?1 AND status_id = ?2) AS reactions`,
    ).bind(stranger.id, target.id).first<{
      favourites: number;
      reactions: number;
    }>();
    expect(relations).toEqual({ favourites: 0, reactions: 0 });
  });

  it('rejects Like and EmojiReact when the local author blocks the remote actor domain', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const target = await insertStatus(
      `interaction_domain_block_target_${suffix}`,
      localAuthorId,
      'public',
    );
    const blockId = `interaction_domain_block_${suffix}`;
    await env.DB_META_C000.prepare(
      `INSERT INTO user_domain_blocks (id, account_id, domain, created_at)
       VALUES (?1, ?2, 'REMOTE.EXAMPLE', ?3)`,
    ).bind(blockId, localAuthorId, new Date().toISOString()).run();

    const likeAccepted = await processLike(
      likeActivity(`domain-block-like-${suffix}`, stranger.uri, target.uri),
      localAuthorId,
    );
    const reactionAccepted = await processEmojiReact(
      reactionActivity(
        `domain-block-reaction-${suffix}`,
        stranger.uri,
        target.uri,
        `domain_block_${suffix}`,
      ),
      localAuthorId,
    );
    await env.DB_META_C000.prepare('DELETE FROM user_domain_blocks WHERE id = ?1')
      .bind(blockId).run();

    expect(likeAccepted).toBe(false);
    expect(reactionAccepted).toBe(false);
    const relations = await env.DB_META_C000.prepare(
      `SELECT
         (SELECT COUNT(*) FROM favourites
          WHERE account_id = ?1 AND status_id = ?2) AS favourites,
         (SELECT COUNT(*) FROM emoji_reactions
          WHERE account_id = ?1 AND status_id = ?2) AS reactions`,
    ).bind(stranger.id, target.id).first<{
      favourites: number;
      reactions: number;
    }>();
    expect(relations).toEqual({ favourites: 0, reactions: 0 });
  });

  it('rejects Like and EmojiReact across either direction of an account block', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const target = await insertStatus(
      `interaction_account_block_target_${suffix}`,
      localAuthorId,
      'public',
    );
    const now = new Date().toISOString();

    for (const [direction, blockerId, blockedId] of [
      ['author-blocks-actor', localAuthorId, stranger.id],
      ['actor-blocks-author', stranger.id, localAuthorId],
    ] satisfies [string, string, string][]) {
      const blockId = `interaction_${direction}_${suffix}`;
      await env.DB_META_C000.prepare(
        `INSERT INTO blocks (id, account_id, target_account_id, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
      ).bind(blockId, blockerId, blockedId, now).run();

      const likeAccepted = await processLike(
        likeActivity(`${direction}-like-${suffix}`, stranger.uri, target.uri),
        localAuthorId,
      );
      const reactionAccepted = await processEmojiReact(
        reactionActivity(
          `${direction}-reaction-${suffix}`,
          stranger.uri,
          target.uri,
          `${direction}_${suffix}`,
        ),
        localAuthorId,
      );
      await env.DB_META_C000.prepare('DELETE FROM blocks WHERE id = ?1').bind(blockId).run();

      expect(likeAccepted).toBe(false);
      expect(reactionAccepted).toBe(false);
    }

    const relations = await env.DB_META_C000.prepare(
      `SELECT
         (SELECT COUNT(*) FROM favourites
          WHERE account_id = ?1 AND status_id = ?2) AS favourites,
         (SELECT COUNT(*) FROM emoji_reactions
          WHERE account_id = ?1 AND status_id = ?2) AS reactions`,
    ).bind(stranger.id, target.id).first<{
      favourites: number;
      reactions: number;
    }>();
    expect(relations).toEqual({ favourites: 0, reactions: 0 });
  });

  it('allows Like and EmojiReact for an active remote actor on an exact local target', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const target = await insertStatus(
      `interaction_allowed_target_${suffix}`,
      localAuthorId,
      'public',
    );

    expect(await processLike(
      likeActivity(`interaction-allowed-like-${suffix}`, stranger.uri, target.uri),
      localAuthorId,
    )).toBe(true);
    expect(await processEmojiReact(
      reactionActivity(
        `interaction-allowed-reaction-${suffix}`,
        stranger.uri,
        target.uri,
        `interaction_allowed_${suffix}`,
      ),
      localAuthorId,
    )).toBe(true);

    const relations = await env.DB_META_C000.prepare(
      `SELECT
         (SELECT COUNT(*) FROM favourites
          WHERE account_id = ?1 AND status_id = ?2) AS favourites,
         (SELECT COUNT(*) FROM emoji_reactions
          WHERE account_id = ?1 AND status_id = ?2) AS reactions`,
    ).bind(stranger.id, target.id).first<{
      favourites: number;
      reactions: number;
    }>();
    expect(relations).toEqual({ favourites: 1, reactions: 1 });
  });

  it('drops Create from suspended, memorial, disabled, and unapproved actors before every side effect', async () => {
    const actors = [
      suspendedActor,
      memorialActor,
      { id: disabledLocalActor.accountId, uri: `${BASE}/users/federation_disabled_local` },
      { id: pendingLocalActor.accountId, uri: `${BASE}/users/federation_pending_local` },
    ];
    const beforeParent = await env.DB_META_C000.prepare(
      'SELECT replies_count FROM statuses WHERE id = ?1',
    ).bind(publicStatus.id).first<{ replies_count: number }>();
    const queueSend = vi.spyOn(env.QUEUE_INTERNAL, 'send');

    for (const [index, actor] of actors.entries()) {
      const accepted = await processCreate({
        type: 'Create',
        id: `${actor.uri}/activities/denied-create-${index}`,
        actor: actor.uri,
        object: {
          type: 'Note',
          id: `${actor.uri}/statuses/denied-create-${index}`,
          attributedTo: actor.uri,
          inReplyTo: publicStatus.uri,
          to: 'https://www.w3.org/ns/activitystreams#Public',
          content: '<p>must not be stored</p>',
          tag: [{
            type: 'Emoji',
            name: `:denied_create_${index}:`,
            icon: {
              type: 'Image',
              url: `https://emoji.example/denied-create-${index}.png`,
            },
          }],
        },
      }, localAuthorId);
      expect(accepted).toBe(false);
    }

    const statuses = await env.DB_META_C000.prepare(
      `SELECT COUNT(*) AS count FROM statuses
       WHERE uri LIKE '%/statuses/denied-create-%'`,
    ).first<{ count: number }>();
    expect(statuses?.count).toBe(0);
    const emojis = await env.DB_META_C000.prepare(
      "SELECT COUNT(*) AS count FROM custom_emojis WHERE shortcode LIKE 'denied_create_%'",
    ).first<{ count: number }>();
    expect(emojis?.count).toBe(0);
    const afterParent = await env.DB_META_C000.prepare(
      'SELECT replies_count FROM statuses WHERE id = ?1',
    ).bind(publicStatus.id).first<{ replies_count: number }>();
    expect(afterParent?.replies_count).toBe(beforeParent?.replies_count);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('allows only active remote owners to Update but lets suspended remote owners Delete cached content', async () => {
    const suffix = crypto.randomUUID();
    const now = new Date().toISOString();
    const activeStatusId = `remote_update_active_${suffix}`;
    const activeStatusUri = `${stranger.uri}/statuses/${suffix}`;
    const suspendedStatusId = `remote_update_suspended_${suffix}`;
    const suspendedStatusUri = `${suspendedActor.uri}/statuses/${suffix}`;
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
           (id, uri, url, account_id, text, content, visibility, local, created_at, updated_at)
         VALUES (?1, ?2, ?2, ?3, 'before', '<p>before</p>', 'public', 0, ?4, ?4)`,
      ).bind(activeStatusId, activeStatusUri, stranger.id, now),
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
           (id, uri, url, account_id, text, content, visibility, local, created_at, updated_at)
         VALUES (?1, ?2, ?2, ?3, 'before', '<p>before</p>', 'public', 0, ?4, ?4)`,
      ).bind(suspendedStatusId, suspendedStatusUri, suspendedActor.id, now),
    ]);

    const update = (actor: RemoteActor, uri: string, content: string): APActivity => ({
      type: 'Update',
      actor: actor.uri,
      object: {
        type: 'Note',
        id: uri,
        attributedTo: actor.uri,
        content,
      },
    });
    await processUpdate(update(stranger, activeStatusUri, '<p>active update</p>'), localAuthorId);
    await processUpdate(update(suspendedActor, suspendedStatusUri, '<p>forbidden update</p>'), localAuthorId);

    const active = await env.DB_META_C000.prepare(
      'SELECT content FROM statuses WHERE id = ?1',
    ).bind(activeStatusId).first<{ content: string }>();
    const suspended = await env.DB_META_C000.prepare(
      'SELECT content FROM statuses WHERE id = ?1',
    ).bind(suspendedStatusId).first<{ content: string }>();
    expect(active?.content).toBe('<p>active update</p>');
    expect(suspended?.content).toBe('<p>before</p>');

    const localBefore = await env.DB_META_C000.prepare(
      'SELECT content FROM statuses WHERE id = ?1',
    ).bind(publicStatus.id).first<{ content: string }>();
    await processUpdate({
      type: 'Update',
      actor: `${BASE}/users/federation_author`,
      object: {
        type: 'Note',
        id: publicStatus.uri,
        attributedTo: `${BASE}/users/federation_author`,
        content: '<p>inbound local spoof</p>',
      },
    }, localAuthorId);
    const localAfterUpdate = await env.DB_META_C000.prepare(
      'SELECT content FROM statuses WHERE id = ?1',
    ).bind(publicStatus.id).first<{ content: string }>();
    expect(localAfterUpdate).toEqual(localBefore);

    await processDelete({
      type: 'Delete',
      actor: suspendedActor.uri,
      object: suspendedStatusUri,
    }, localAuthorId);
    const deletedSuspended = await env.DB_META_C000.prepare(
      'SELECT deleted_at FROM statuses WHERE id = ?1',
    ).bind(suspendedStatusId).first<{ deleted_at: string | null }>();
    expect(deletedSuspended?.deleted_at).not.toBeNull();

    await processDelete({
      type: 'Delete',
      actor: `${BASE}/users/federation_author`,
      object: publicStatus.uri,
    }, localAuthorId);
    const localAfterDelete = await env.DB_META_C000.prepare(
      'SELECT deleted_at FROM statuses WHERE id = ?1',
    ).bind(publicStatus.id).first<{ deleted_at: string | null }>();
    expect(localAfterDelete?.deleted_at).toBeNull();
  });

  it('Undo Follow and Block require the exact stored action, actor, target, and personal inbox', async () => {
    const suffix = crypto.randomUUID();
    const now = new Date().toISOString();
    const localAuthor = await env.DB_META_C000.prepare(
      'SELECT uri FROM accounts WHERE id = ?1 LIMIT 1',
    ).bind(localAuthorId).first<{ uri: string }>();
    const otherLocal = await env.DB_META_C000.prepare(
      'SELECT uri FROM accounts WHERE id = ?1 LIMIT 1',
    ).bind(pendingLocalActor.accountId).first<{ uri: string }>();
    expect(localAuthor).not.toBeNull();
    expect(otherLocal).not.toBeNull();

    const followId = `account_undo_follow_${suffix}`;
    const followUri = `${stranger.uri}/follows/${suffix}`;
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT INTO follows
           (id, account_id, target_account_id, uri, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      ).bind(followId, stranger.id, localAuthorId, followUri, now),
      env.DB_META_C000.prepare(
        'UPDATE accounts SET following_count = following_count + 1 WHERE id = ?1',
      ).bind(stranger.id),
      env.DB_META_C000.prepare(
        'UPDATE accounts SET followers_count = followers_count + 1 WHERE id = ?1',
      ).bind(localAuthorId),
    ]);
    const undoFollow = (
      embeddedActor: string,
      embeddedTarget: string,
      embeddedId: string = followUri,
    ): APActivity => ({
      type: 'Undo',
      actor: stranger.uri,
      object: {
        type: 'Follow',
        id: embeddedId,
        actor: embeddedActor,
        object: embeddedTarget,
      },
    });
    const followExists = async (): Promise<boolean> => (await env.DB_META_C000.prepare(
      'SELECT id FROM follows WHERE id = ?1',
    ).bind(followId).first<{ id: string }>()) !== null;

    await processUndo(undoFollow(stranger.uri, localAuthor!.uri), pendingLocalActor.accountId);
    expect(await followExists()).toBe(true);
    await processUndo(undoFollow(suspendedActor.uri, localAuthor!.uri), localAuthorId);
    expect(await followExists()).toBe(true);
    await processUndo(undoFollow(stranger.uri, otherLocal!.uri), localAuthorId);
    expect(await followExists()).toBe(true);
    await processUndo(
      undoFollow(stranger.uri, localAuthor!.uri, `${stranger.uri}/follows/unknown`),
      localAuthorId,
    );
    expect(await followExists()).toBe(true);
    await processUndo(undoFollow(stranger.uri, localAuthor!.uri), localAuthorId);
    expect(await followExists()).toBe(false);

    const blockId = `account_undo_block_${suffix}`;
    const blockUri = `${stranger.uri}/blocks/${suffix}`;
    await env.DB_META_C000.prepare(
      `INSERT INTO blocks (id, account_id, target_account_id, uri, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(blockId, stranger.id, localAuthorId, blockUri, now).run();
    const undoBlock = (id: string, actor: string = stranger.uri): APActivity => ({
      type: 'Undo',
      actor: stranger.uri,
      object: {
        type: 'Block',
        id,
        actor,
        object: localAuthor!.uri,
      },
    });
    const blockExists = async (): Promise<boolean> => (await env.DB_META_C000.prepare(
      'SELECT id FROM blocks WHERE id = ?1',
    ).bind(blockId).first<{ id: string }>()) !== null;

    await processUndo(undoBlock(blockUri), pendingLocalActor.accountId);
    expect(await blockExists()).toBe(true);
    await processUndo(undoBlock(`${stranger.uri}/blocks/other`), localAuthorId);
    expect(await blockExists()).toBe(true);
    await processUndo(undoBlock(blockUri, suspendedActor.uri), localAuthorId);
    expect(await blockExists()).toBe(true);
    await processUndo(undoBlock(blockUri), localAuthorId);
    expect(await blockExists()).toBe(false);
  });

  it('guards Undo status interactions and decrements counters only after an owned relation changes', async () => {
    const suffix = crypto.randomUUID();
    const target = await insertStatus(
      `undo_permission_target_${suffix}`,
      localAuthorId,
      'public',
    );
    const now = new Date().toISOString();
    const likeUri = `${stranger.uri}/activities/undo-like-${suffix}`;
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT INTO favourites (id, account_id, status_id, uri, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(`undo_favourite_${suffix}`, stranger.id, target.id, likeUri, now),
      env.DB_META_C000.prepare(
        `INSERT INTO emoji_reactions (id, account_id, status_id, emoji, created_at)
         VALUES (?1, ?2, ?3, ':wave:', ?4)`,
      ).bind(`undo_reaction_${suffix}`, stranger.id, target.id, now),
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
         (id, uri, account_id, reblog_of_id, visibility, local, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'public', 0, ?5, ?5)`,
      ).bind(
        `undo_reblog_${suffix}`,
        `${stranger.uri}/activities/undo-announce-${suffix}`,
        stranger.id,
        target.id,
        now,
      ),
      env.DB_META_C000.prepare(
        `UPDATE statuses SET favourites_count = 1, reblogs_count = 1 WHERE id = ?1`,
      ).bind(target.id),
    ]);

    const undoLike: APActivity = {
      type: 'Undo',
      actor: stranger.uri,
      object: {
        type: 'Like',
        id: likeUri,
        actor: stranger.uri,
        object: target.uri,
      },
    };
    const undoReaction: APActivity = {
      type: 'Undo',
      actor: stranger.uri,
      object: {
        type: 'Like',
        actor: stranger.uri,
        object: target.uri,
        content: ':wave:',
      },
    };
    const undoAnnounce: APActivity = {
      type: 'Undo',
      actor: stranger.uri,
      object: {
        type: 'Announce',
        actor: stranger.uri,
        object: target.uri,
      },
    };

    expect(await processUndo(undoLike, localAuthorId)).toBe(true);
    expect(await processUndo(undoReaction, localAuthorId)).toBe(true);
    expect(await processUndo(undoAnnounce, localAuthorId)).toBe(true);
    expect(await processUndo(undoLike, localAuthorId)).toBe(false);
    expect(await processUndo(undoReaction, localAuthorId)).toBe(false);
    expect(await processUndo(undoAnnounce, localAuthorId)).toBe(false);

    const counts = await env.DB_META_C000.prepare(
      'SELECT favourites_count, reblogs_count FROM statuses WHERE id = ?1',
    ).bind(target.id).first<{ favourites_count: number; reblogs_count: number }>();
    expect(counts).toEqual({ favourites_count: 0, reblogs_count: 0 });

    const deniedLikeUri = `${suspendedActor.uri}/activities/undo-denied-${suffix}`;
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT INTO favourites (id, account_id, status_id, uri, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(
        `undo_denied_favourite_${suffix}`,
        suspendedActor.id,
        target.id,
        deniedLikeUri,
        now,
      ),
      env.DB_META_C000.prepare(
        'UPDATE statuses SET favourites_count = 1 WHERE id = ?1',
      ).bind(target.id),
    ]);
    const deniedUndo: APActivity = {
      type: 'Undo',
      actor: suspendedActor.uri,
      object: {
        type: 'Like',
        id: deniedLikeUri,
        actor: suspendedActor.uri,
        object: target.uri,
      },
    };
    expect(await processUndo(deniedUndo, localAuthorId)).toBe(false);
    const deniedRelation = await env.DB_META_C000.prepare(
      'SELECT id FROM favourites WHERE uri = ?1',
    ).bind(deniedLikeUri).first<{ id: string }>();
    expect(deniedRelation).not.toBeNull();
    const deniedCount = await env.DB_META_C000.prepare(
      'SELECT favourites_count FROM statuses WHERE id = ?1',
    ).bind(target.id).first<{ favourites_count: number }>();
    expect(deniedCount?.favourites_count).toBe(1);
  });

  it('validates poll vote visibility, exact inbox recipient, expiry, and single-choice state', async () => {
    const suffix = crypto.randomUUID();
    const openStatus = await insertStatus(
      `federation_vote_open_${suffix}`,
      localAuthorId,
      'public',
    );
    const privateVoteStatus = await insertStatus(
      `federation_vote_private_${suffix}`,
      localAuthorId,
      'private',
    );
    const expiredStatus = await insertStatus(
      `federation_vote_expired_${suffix}`,
      localAuthorId,
      'public',
    );
    const now = new Date().toISOString();
    const options = JSON.stringify([
      { title: 'One', votes_count: 0 },
      { title: 'Two', votes_count: 0 },
    ]);
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT INTO polls
         (id, status_id, expires_at, multiple, votes_count, voters_count, options, created_at)
         VALUES (?1, ?2, ?3, 0, 0, 0, ?4, ?5)`,
      ).bind(`vote_open_poll_${suffix}`, openStatus.id, '2999-01-01T00:00:00.000Z', options, now),
      env.DB_META_C000.prepare('UPDATE statuses SET poll_id = ?1 WHERE id = ?2')
        .bind(`vote_open_poll_${suffix}`, openStatus.id),
      env.DB_META_C000.prepare(
        `INSERT INTO polls
         (id, status_id, expires_at, multiple, votes_count, voters_count, options, created_at)
         VALUES (?1, ?2, ?3, 0, 0, 0, ?4, ?5)`,
      ).bind(`vote_private_poll_${suffix}`, privateVoteStatus.id, '2999-01-01T00:00:00.000Z', options, now),
      env.DB_META_C000.prepare('UPDATE statuses SET poll_id = ?1 WHERE id = ?2')
        .bind(`vote_private_poll_${suffix}`, privateVoteStatus.id),
      env.DB_META_C000.prepare(
        `INSERT INTO polls
         (id, status_id, expires_at, multiple, votes_count, voters_count, options, created_at)
         VALUES (?1, ?2, ?3, 0, 0, 0, ?4, ?5)`,
      ).bind(`vote_expired_poll_${suffix}`, expiredStatus.id, '2000-01-01T00:00:00.000Z', options, now),
      env.DB_META_C000.prepare('UPDATE statuses SET poll_id = ?1 WHERE id = ?2')
        .bind(`vote_expired_poll_${suffix}`, expiredStatus.id),
    ]);

    const vote = (id: string, target: StatusFixture, option: string): APActivity => ({
      type: 'Create',
      id: `${stranger.uri}/activities/${id}`,
      actor: stranger.uri,
      object: {
        type: 'Note',
        id: `${stranger.uri}/votes/${id}`,
        attributedTo: stranger.uri,
        name: option,
        inReplyTo: target.uri,
        to: `${BASE}/users/federation_author`,
      },
    });

    expect(await processCreate(
      vote(`wrong-recipient-${suffix}`, openStatus, 'One'),
      pendingLocalActor.accountId,
    )).toBe(false);
    expect(await processCreate(
      vote(`private-${suffix}`, privateVoteStatus, 'One'),
      localAuthorId,
    )).toBe(false);
    expect(await processCreate(
      vote(`expired-${suffix}`, expiredStatus, 'One'),
      localAuthorId,
    )).toBe(false);
    expect(await processCreate(
      vote(`allowed-${suffix}`, openStatus, 'One'),
      localAuthorId,
    )).toBe(true);
    expect(await processCreate(
      vote(`second-choice-${suffix}`, openStatus, 'Two'),
      localAuthorId,
    )).toBe(false);

    const storedVotes = await env.DB_META_C000.prepare(
      `SELECT choice FROM poll_votes
       WHERE poll_id = ?1 AND account_id = ?2`,
    ).bind(`vote_open_poll_${suffix}`, stranger.id).all<{ choice: number }>();
    expect(storedVotes.results).toEqual([{ choice: 0 }]);
    const openPoll = await env.DB_META_C000.prepare(
      'SELECT votes_count, voters_count, options FROM polls WHERE id = ?1',
    ).bind(`vote_open_poll_${suffix}`).first<{
      votes_count: number;
      voters_count: number;
      options: string;
    }>();
    expect(openPoll?.votes_count).toBe(1);
    expect(openPoll?.voters_count).toBe(1);
    expect(JSON.parse(openPoll?.options ?? '[]')).toEqual([
      { title: 'One', votes_count: 1 },
      { title: 'Two', votes_count: 0 },
    ]);
  });

  it('reuses quote policy and exact-recipient checks for inbound QuoteRequest', async () => {
    const suffix = crypto.randomUUID();
    const publicTarget = await insertStatus(
      `quote_request_public_${suffix}`,
      localAuthorId,
      'public',
    );
    const followersTarget = await insertStatus(
      `quote_request_followers_${suffix}`,
      localAuthorId,
      'public',
    );
    const nobodyTarget = await insertStatus(
      `quote_request_nobody_${suffix}`,
      localAuthorId,
      'public',
    );
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare("UPDATE statuses SET quote_policy = 'followers' WHERE id = ?1")
        .bind(followersTarget.id),
      env.DB_META_C000.prepare("UPDATE statuses SET quote_policy = 'nobody' WHERE id = ?1")
        .bind(nobodyTarget.id),
    ]);

    const request = (id: string, target: StatusFixture): APActivity => ({
      type: 'QuoteRequest',
      id: `${stranger.uri}/activities/${id}`,
      actor: stranger.uri,
      object: target.uri,
      instrument: `${stranger.uri}/statuses/${id}`,
    });
    const delivery = vi.spyOn(env.QUEUE_FEDERATION, 'send');

    await processQuoteRequest(request(`public-${suffix}`, publicTarget), localAuthorId);
    expect(delivery).toHaveBeenCalledWith(expect.objectContaining({
      type: 'deliver_activity',
      activity: expect.objectContaining({ type: 'Accept' }),
    }));

    delivery.mockClear();
    await processQuoteRequest(request(`followers-denied-${suffix}`, followersTarget), localAuthorId);
    expect(delivery).toHaveBeenCalledWith(expect.objectContaining({
      activity: expect.objectContaining({ type: 'Reject' }),
    }));

    await env.DB_META_C000.prepare(
      `INSERT INTO follows
       (id, account_id, target_account_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
    ).bind(
      `quote_request_follow_${suffix}`,
      stranger.id,
      localAuthorId,
      new Date().toISOString(),
    ).run();
    delivery.mockClear();
    await processQuoteRequest(request(`followers-allowed-${suffix}`, followersTarget), localAuthorId);
    expect(delivery).toHaveBeenCalledWith(expect.objectContaining({
      activity: expect.objectContaining({ type: 'Accept' }),
    }));

    delivery.mockClear();
    await processQuoteRequest(request(`nobody-${suffix}`, nobodyTarget), localAuthorId);
    expect(delivery).toHaveBeenCalledWith(expect.objectContaining({
      activity: expect.objectContaining({ type: 'Reject' }),
    }));

    delivery.mockClear();
    await processQuoteRequest(
      request(`wrong-recipient-${suffix}`, publicTarget),
      pendingLocalActor.accountId,
    );
    expect(delivery).not.toHaveBeenCalled();

    const authorizations = await env.DB_META_C000.prepare(
      `SELECT COUNT(*) AS count FROM quote_authorizations
       WHERE interacting_object_uri IN (?1, ?2)`,
    ).bind(
      `${stranger.uri}/statuses/public-${suffix}`,
      `${stranger.uri}/statuses/followers-allowed-${suffix}`,
    ).first<{ count: number }>();
    expect(authorizations?.count).toBe(2);
  });

  it('applies Follow Accept and Reject only to the response owner pending row and exact local inbox', async () => {
    const suffix = crypto.randomUUID();
    const attacker = await insertRemoteActor(
      `follow_response_attacker_${suffix}`,
      `follow_response_attacker_${suffix}`,
    );
    const rejectOwner = await insertRemoteActor(
      `follow_reject_owner_${suffix}`,
      `follow_reject_owner_${suffix}`,
    );
    const now = new Date().toISOString();
    const acceptRequestUri = `${BASE}/users/federation_author/follows/${suffix}`;
    const rejectRequestUri = `${BASE}/users/federation_author/follows/reject-${suffix}`;
    const inactiveRequestUri = `${BASE}/users/federation_pending_local/follows/${suffix}`;
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT INTO follow_requests
         (id, account_id, target_account_id, uri, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      ).bind(
        `follow_accept_request_${suffix}`,
        localAuthorId,
        stranger.id,
        acceptRequestUri,
        now,
      ),
      env.DB_META_C000.prepare(
        `INSERT INTO follow_requests
         (id, account_id, target_account_id, uri, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      ).bind(
        `follow_reject_request_${suffix}`,
        localAuthorId,
        rejectOwner.id,
        rejectRequestUri,
        now,
      ),
      env.DB_META_C000.prepare(
        `INSERT INTO follow_requests
         (id, account_id, target_account_id, uri, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      ).bind(
        `follow_inactive_request_${suffix}`,
        pendingLocalActor.accountId,
        rejectOwner.id,
        inactiveRequestUri,
        now,
      ),
    ]);

    const requestExists = async (uri: string): Promise<boolean> => {
      const row = await env.DB_META_C000.prepare(
        'SELECT id FROM follow_requests WHERE uri = ?1 LIMIT 1',
      ).bind(uri).first<{ id: string }>();
      return row !== null;
    };
    const followExists = async (targetAccountId: string): Promise<boolean> => {
      const row = await env.DB_META_C000.prepare(
        `SELECT id FROM follows
         WHERE account_id = ?1 AND target_account_id = ?2
         LIMIT 1`,
      ).bind(localAuthorId, targetAccountId).first<{ id: string }>();
      return row !== null;
    };
    const response = (
      type: 'Accept' | 'Reject',
      actor: RemoteActor,
      object: APActivity['object'],
    ): APActivity => ({ type, actor: actor.uri, object });

    await processAccept(response('Accept', attacker, acceptRequestUri), localAuthorId);
    expect(await requestExists(acceptRequestUri)).toBe(true);
    expect(await followExists(stranger.id)).toBe(false);

    await processAccept(response('Accept', stranger, acceptRequestUri), pendingLocalActor.accountId);
    expect(await requestExists(acceptRequestUri)).toBe(true);

    await processAccept(response('Accept', stranger, {
      type: 'Follow',
      id: acceptRequestUri,
      actor: `${BASE}/users/not-the-local-follower`,
      object: stranger.uri,
    }), localAuthorId);
    expect(await requestExists(acceptRequestUri)).toBe(true);

    const beforeCounts = await env.DB_META_C000.prepare(
      `SELECT
         (SELECT following_count FROM accounts WHERE id = ?1) AS following_count,
         (SELECT followers_count FROM accounts WHERE id = ?2) AS followers_count`,
    ).bind(localAuthorId, stranger.id).first<{
      following_count: number;
      followers_count: number;
    }>();
    await processAccept(response('Accept', stranger, acceptRequestUri), localAuthorId);
    expect(await requestExists(acceptRequestUri)).toBe(false);
    expect(await followExists(stranger.id)).toBe(true);
    const afterCounts = await env.DB_META_C000.prepare(
      `SELECT
         (SELECT following_count FROM accounts WHERE id = ?1) AS following_count,
         (SELECT followers_count FROM accounts WHERE id = ?2) AS followers_count`,
    ).bind(localAuthorId, stranger.id).first<{
      following_count: number;
      followers_count: number;
    }>();
    expect(afterCounts?.following_count).toBe((beforeCounts?.following_count ?? 0) + 1);
    expect(afterCounts?.followers_count).toBe((beforeCounts?.followers_count ?? 0) + 1);
    await processAccept(response('Accept', stranger, acceptRequestUri), localAuthorId);
    const replayCounts = await env.DB_META_C000.prepare(
      `SELECT
         (SELECT following_count FROM accounts WHERE id = ?1) AS following_count,
         (SELECT followers_count FROM accounts WHERE id = ?2) AS followers_count`,
    ).bind(localAuthorId, stranger.id).first<{
      following_count: number;
      followers_count: number;
    }>();
    expect(replayCounts).toEqual(afterCounts);

    await processReject(response('Reject', attacker, rejectRequestUri), localAuthorId);
    expect(await requestExists(rejectRequestUri)).toBe(true);
    await processReject(response('Reject', rejectOwner, rejectRequestUri), pendingLocalActor.accountId);
    expect(await requestExists(rejectRequestUri)).toBe(true);
    await processReject(response('Reject', rejectOwner, {
      type: 'Follow',
      id: rejectRequestUri,
      actor: `${BASE}/users/federation_author`,
      object: attacker.uri,
    }), localAuthorId);
    expect(await requestExists(rejectRequestUri)).toBe(true);
    await processReject(response('Reject', rejectOwner, rejectRequestUri), localAuthorId);
    expect(await requestExists(rejectRequestUri)).toBe(false);

    await processAccept(response('Accept', rejectOwner, inactiveRequestUri), pendingLocalActor.accountId);
    expect(await requestExists(inactiveRequestUri)).toBe(true);
  });

  it('accepts inbound Follow only for an active exact recipient without blocks', async () => {
    const suffix = crypto.randomUUID();
    const follower = await insertRemoteActor(
      `incoming_follow_${suffix}`,
      `incoming_follow_${suffix}`,
    );
    const localAuthor = await env.DB_META_C000.prepare(
      'SELECT uri FROM accounts WHERE id = ?1 LIMIT 1',
    ).bind(localAuthorId).first<{ uri: string }>();
    expect(localAuthor).not.toBeNull();

    const activity: APActivity = {
      type: 'Follow',
      id: `${follower.uri}/follows/${suffix}`,
      actor: follower.uri,
      object: localAuthor?.uri,
    };
    const followExists = async (): Promise<boolean> => {
      const row = await env.DB_META_C000.prepare(
        `SELECT id FROM follows
         WHERE account_id = ?1 AND target_account_id = ?2
         LIMIT 1`,
      ).bind(follower.id, localAuthorId).first<{ id: string }>();
      return row !== null;
    };

    await processFollow(activity, pendingLocalActor.accountId);
    expect(await followExists()).toBe(false);

    await env.DB_META_C000.prepare(
      'UPDATE accounts SET moved_to_account_id = ?1 WHERE id = ?2',
    ).bind(pendingLocalActor.accountId, localAuthorId).run();
    await processFollow(activity, localAuthorId);
    expect(await followExists()).toBe(false);
    await env.DB_META_C000.prepare(
      'UPDATE accounts SET moved_to_account_id = NULL WHERE id = ?1',
    ).bind(localAuthorId).run();

    await env.DB_META_C000.prepare(
      `INSERT INTO user_domain_blocks (id, account_id, domain, created_at)
       VALUES (?1, ?2, 'REMOTE.EXAMPLE', ?3)`,
    ).bind(`incoming_follow_domain_block_${suffix}`, localAuthorId, new Date().toISOString()).run();
    await processFollow(activity, localAuthorId);
    expect(await followExists()).toBe(false);
    await env.DB_META_C000.prepare(
      'DELETE FROM user_domain_blocks WHERE id = ?1',
    ).bind(`incoming_follow_domain_block_${suffix}`).run();

    await processFollow(activity, localAuthorId);
    expect(await followExists()).toBe(true);
  });

  it('records inbound Block only for its exact local inbox target', async () => {
    const suffix = crypto.randomUUID();
    const blocker = await insertRemoteActor(
      `incoming_block_${suffix}`,
      `incoming_block_${suffix}`,
    );
    const localAuthor = await env.DB_META_C000.prepare(
      'SELECT uri FROM accounts WHERE id = ?1 LIMIT 1',
    ).bind(localAuthorId).first<{ uri: string }>();
    expect(localAuthor).not.toBeNull();
    const activity: APActivity = {
      type: 'Block',
      id: `${blocker.uri}/blocks/${suffix}`,
      actor: blocker.uri,
      object: localAuthor?.uri,
    };
    const blockExists = async (): Promise<boolean> => {
      const row = await env.DB_META_C000.prepare(
        `SELECT id FROM blocks
         WHERE account_id = ?1 AND target_account_id = ?2
         LIMIT 1`,
      ).bind(blocker.id, localAuthorId).first<{ id: string }>();
      return row !== null;
    };

    await processBlock(activity, pendingLocalActor.accountId);
    expect(await blockExists()).toBe(false);

    await processBlock(activity, localAuthorId);
    expect(await blockExists()).toBe(true);
  });

  it('requires quote response and authorization revocation actors to own the target resource', async () => {
    const suffix = crypto.randomUUID();
    const attacker = await insertRemoteActor(
      `quote_response_attacker_${suffix}`,
      `quote_response_attacker_${suffix}`,
    );
    const remoteTarget = await insertStatus(
      `quote_response_target_${suffix}`,
      stranger.id,
      'public',
    );
    const localWrapper = await insertStatus(
      `quote_response_wrapper_${suffix}`,
      localAuthorId,
      'public',
    );
    await env.DB_META_C000.prepare(
      `UPDATE statuses
       SET quote_id = ?1, quote_approval_status = 'pending'
       WHERE id = ?2`,
    ).bind(remoteTarget.id, localWrapper.id).run();

    const quoteRequest = {
      type: 'QuoteRequest',
      id: `${localWrapper.uri}/quote`,
      actor: `${BASE}/users/federation_author`,
      object: remoteTarget.uri,
      instrument: localWrapper.uri,
    };
    const accept = (actor: RemoteActor): APActivity => ({
      type: 'Accept',
      actor: actor.uri,
      object: quoteRequest,
      result: `${actor.uri}/stamps/${suffix}`,
    });
    const reject = (actor: RemoteActor): APActivity => ({
      type: 'Reject',
      actor: actor.uri,
      object: quoteRequest,
    });
    const approval = async (): Promise<{
      quote_id: string | null;
      quote_approval_status: string | null;
    } | null> => env.DB_META_C000.prepare(
      'SELECT quote_id, quote_approval_status FROM statuses WHERE id = ?1',
    ).bind(localWrapper.id).first<{
      quote_id: string | null;
      quote_approval_status: string | null;
    }>();

    await processAccept(accept(attacker), localAuthorId);
    expect(await approval()).toEqual({
      quote_id: remoteTarget.id,
      quote_approval_status: 'pending',
    });
    await processAccept(accept(stranger), pendingLocalActor.accountId);
    expect(await approval()).toEqual({
      quote_id: remoteTarget.id,
      quote_approval_status: 'pending',
    });
    await processAccept(accept(stranger), localAuthorId);
    expect(await approval()).toEqual({
      quote_id: remoteTarget.id,
      quote_approval_status: 'accepted',
    });

    await env.DB_META_C000.prepare(
      `UPDATE statuses
       SET quote_approval_status = 'pending', quote_authorization_uri = NULL
       WHERE id = ?1`,
    ).bind(localWrapper.id).run();
    await processReject(reject(attacker), localAuthorId);
    expect((await approval())?.quote_approval_status).toBe('pending');
    await processReject(reject(stranger), pendingLocalActor.accountId);
    expect((await approval())?.quote_approval_status).toBe('pending');
    await processReject(reject(stranger), localAuthorId);
    expect(await approval()).toEqual({
      quote_id: null,
      quote_approval_status: 'rejected',
    });

    const revocationWrapper = await insertStatus(
      `quote_revocation_wrapper_${suffix}`,
      localAuthorId,
      'public',
    );
    const authorizationUri = `${stranger.uri}/stamps/${suffix}`;
    await env.DB_META_C000.prepare(
      `UPDATE statuses
       SET quote_id = ?1, quote_authorization_uri = ?2,
           quote_approval_status = 'accepted'
       WHERE id = ?3`,
    ).bind(remoteTarget.id, authorizationUri, revocationWrapper.id).run();
    const deleteAuthorization = (actor: RemoteActor): APActivity => ({
      type: 'Delete',
      actor: actor.uri,
      object: authorizationUri,
    });

    await processDelete(deleteAuthorization(attacker), localAuthorId);
    const afterAttackerDelete = await env.DB_META_C000.prepare(
      'SELECT quote_id, quote_approval_status FROM statuses WHERE id = ?1',
    ).bind(revocationWrapper.id).first<{
      quote_id: string | null;
      quote_approval_status: string | null;
    }>();
    expect(afterAttackerDelete).toEqual({
      quote_id: remoteTarget.id,
      quote_approval_status: 'accepted',
    });

    await processDelete(deleteAuthorization(stranger), localAuthorId);
    const afterOwnerDelete = await env.DB_META_C000.prepare(
      'SELECT quote_id, quote_approval_status FROM statuses WHERE id = ?1',
    ).bind(revocationWrapper.id).first<{
      quote_id: string | null;
      quote_approval_status: string | null;
    }>();
    expect(afterOwnerDelete).toEqual({
      quote_id: null,
      quote_approval_status: 'revoked',
    });
  });

  it('allows legitimate public and unlisted interactions with validated wrapper visibility', async () => {
    const queueSend = vi.spyOn(env.QUEUE_INTERNAL, 'send');

    await processLike(
      likeActivity('allowed-like', stranger.uri, publicStatus.uri),
      localAuthorId,
    );
    await processEmojiReact(
      reactionActivity(
        'allowed-reaction',
        stranger.uri,
        unlistedStatus.uri,
        'allowed_reaction',
      ),
      localAuthorId,
    );
    await processAnnounce({
      ...announceActivity('allowed-announce', stranger.uri, publicStatus.uri, false),
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    }, localAuthorId);
    await processAnnounce({
      ...announceActivity('allowed-quote', stranger.uri, unlistedStatus.uri, true),
      to: [`${stranger.uri}/followers`],
      cc: ['https://www.w3.org/ns/activitystreams#Public'],
      content: '<p>Allowed quote</p>',
    }, localAuthorId);

    expect(queueSend).toHaveBeenCalled();

    const favourite = await env.DB_META_C000.prepare(
      'SELECT id FROM favourites WHERE account_id = ?1 AND status_id = ?2',
    ).bind(stranger.id, publicStatus.id).first<{ id: string }>();
    expect(favourite).not.toBeNull();

    const reaction = await env.DB_META_C000.prepare(
      'SELECT id FROM emoji_reactions WHERE account_id = ?1 AND status_id = ?2',
    ).bind(stranger.id, unlistedStatus.id).first<{ id: string }>();
    expect(reaction).not.toBeNull();

    const ordinaryReblog = await env.DB_META_C000.prepare(
      'SELECT visibility FROM statuses WHERE uri = ?1',
    ).bind('https://remote.example/activities/allowed-announce')
      .first<{ visibility: string }>();
    expect(ordinaryReblog?.visibility).toBe('public');

    const quote = await env.DB_META_C000.prepare(
      'SELECT visibility FROM statuses WHERE uri = ?1',
    ).bind('https://remote.example/activities/allowed-quote')
      .first<{ visibility: string }>();
    expect(quote?.visibility).toBe('unlisted');
  });

  it('clamps remote self-quotes of private targets before storage and fanout', async () => {
    const suffix = crypto.randomUUID();
    const privateTarget = await insertStatus(
      `federation_private_self_quote_${suffix}`,
      stranger.id,
      'private',
    );

    const quoteAnnounce = announceActivity(
      `private-self-quote-announce-${suffix}`,
      stranger.uri,
      privateTarget.uri,
      true,
    );
    expect(await processAnnounce(quoteAnnounce, localAuthorId)).toBe(true);

    const storedAnnounce = await env.DB_META_C000.prepare(
      `SELECT visibility, quote_id, quote_approval_status
       FROM statuses
       WHERE uri = ?1`,
    ).bind(quoteAnnounce.id).first<{
      visibility: string;
      quote_id: string | null;
      quote_approval_status: string | null;
    }>();
    expect(storedAnnounce).toEqual({
      visibility: 'private',
      quote_id: privateTarget.id,
      quote_approval_status: 'accepted',
    });

    const createUri = `${stranger.uri}/statuses/private-self-quote-${suffix}`;
    expect(await processCreate({
      type: 'Create',
      id: `${stranger.uri}/activities/private-self-quote-${suffix}`,
      actor: stranger.uri,
      object: {
        type: 'Note',
        id: createUri,
        attributedTo: stranger.uri,
        to: 'https://www.w3.org/ns/activitystreams#Public',
        content: '<p>attempted public self-quote</p>',
        quoteUri: privateTarget.uri,
      },
    }, localAuthorId)).toBe(true);

    const storedCreate = await env.DB_META_C000.prepare(
      `SELECT visibility, quote_id, quote_approval_status
       FROM statuses
       WHERE uri = ?1`,
    ).bind(createUri).first<{
      visibility: string;
      quote_id: string | null;
      quote_approval_status: string | null;
    }>();
    expect(storedCreate).toEqual({
      visibility: 'private',
      quote_id: privateTarget.id,
      quote_approval_status: 'accepted',
    });
  });

  it('drops Announce activities whose addressing cannot produce a supported visibility', async () => {
    const activity = announceActivity(
      'unsupported-addressing',
      stranger.uri,
      unsupportedAddressingStatus.uri,
      false,
    );
    delete activity.to;

    const queueSend = vi.spyOn(env.QUEUE_INTERNAL, 'send');
    await processAnnounce(activity, localAuthorId);
    expect(queueSend).not.toHaveBeenCalled();

    const wrapper = await env.DB_META_C000.prepare(
      'SELECT id FROM statuses WHERE uri = ?1',
    ).bind('https://remote.example/activities/unsupported-addressing')
      .first<{ id: string }>();
    expect(wrapper).toBeNull();
  });
});
