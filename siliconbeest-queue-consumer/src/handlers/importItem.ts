/**
 * Import Item Handler
 *
 * Processes a single import_item message from CSV import:
 * 1. WebFinger resolve the acct address
 * 2. If account not in DB, enqueue fetch_remote_account
 * 3. Create follow/block/mute depending on action
 * 4. For follow: also enqueue federation delivery of Follow activity
 */

import { env } from 'cloudflare:workers';
import type { ImportItemMessage } from '../shared/types/queue';
import { generateUlid } from '../../../packages/shared/utils/ulid';
import { getSuspendedDomains } from '../../../packages/shared/domain-blocks';
import {
  canActAsAccount,
  canCreateBlockOrMuteAccountRelationship,
  canFollowAccount,
} from '../../../packages/shared/permissions';

const AP_CONTEXT = 'https://www.w3.org/ns/activitystreams';

/**
 * WebFinger resolve an acct to get the AP actor URI.
 */
async function webfingerResolve(acct: string): Promise<string | null> {
  // acct may be "user@domain" or just "user" (local)
  const parts = acct.split('@');
  if (parts.length < 2) return null; // local accounts don't need WebFinger

  const domain = parts[parts.length - 1];
  const resource = `acct:${acct}`;

  try {
    const res = await fetch(
      `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
      { headers: { Accept: 'application/jrd+json, application/json' } },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      links?: Array<{ rel?: string; type?: string; href?: string }>;
    };

    const selfLink = data.links?.find(
      (l) => l.rel === 'self' && l.type?.includes('activity'),
    );
    return selfLink?.href ?? null;
  } catch {
    return null;
  }
}

export async function handleImportItem(
  msg: ImportItemMessage,
): Promise<void> {
  const { acct, action, accountId } = msg;

  // Parse acct parts
  const parts = acct.split('@');
  const username = parts[0];
  // Domains are DNS names (case-insensitive); accounts.domain stores the
  // lowercase URL host, so normalize here or known accounts are silently
  // missed and the import item dropped. Username casing stays exact (AP).
  const domain = parts.length >= 2 ? parts[parts.length - 1].toLowerCase() : null;
  const normalizedAcct = domain ? `${username}@${domain}` : acct;

  // Look up the target account in DB
  let targetAccount: {
    id: string;
    username: string;
    domain: string | null;
    uri: string | null;
    inbox_url: string | null;
    shared_inbox_url: string | null;
    locked: number;
    manually_approves_followers: number;
    suspended_at: string | null;
    memorial: number;
    moved_to_account_id: string | null;
    user_approved: number | null;
  } | null = null;

  if (domain) {
    targetAccount = await env.DB_META_C000.prepare(
      `SELECT target.id, target.username, target.domain, target.uri,
              target.inbox_url, target.shared_inbox_url, target.locked,
              COALESCE(target.manually_approves_followers, 0) AS manually_approves_followers,
              target.suspended_at, target.memorial, target.moved_to_account_id,
              target_user.approved AS user_approved
       FROM accounts target
       LEFT JOIN users target_user ON target_user.account_id = target.id
       WHERE target.username = ? AND target.domain = ?`,
    )
      .bind(username, domain)
      .first();
  } else {
    targetAccount = await env.DB_META_C000.prepare(
      `SELECT target.id, target.username, target.domain, target.uri,
              target.inbox_url, target.shared_inbox_url, target.locked,
              COALESCE(target.manually_approves_followers, 0) AS manually_approves_followers,
              target.suspended_at, target.memorial, target.moved_to_account_id,
              target_user.approved AS user_approved
       FROM accounts target
       LEFT JOIN users target_user ON target_user.account_id = target.id
       WHERE target.username = ? AND target.domain IS NULL`,
    )
      .bind(username)
      .first();
  }

  // If not found and it's a remote account, try WebFinger and enqueue fetch
  if (!targetAccount && domain) {
    const importingActor = await env.DB_META_C000.prepare(
      `SELECT importing_actor.suspended_at, importing_actor.memorial,
              importing_user.disabled AS user_disabled,
              importing_user.approved AS user_approved
       FROM accounts importing_actor
       LEFT JOIN users importing_user
         ON importing_user.account_id = importing_actor.id
       WHERE importing_actor.id = ?1 AND importing_actor.domain IS NULL
       LIMIT 1`,
    )
      .bind(accountId)
      .first<{
        suspended_at: string | null;
        memorial: number | null;
        user_disabled: number | null;
        user_approved: number | null;
      }>();
    if (!canActAsAccount({
      accountSuspended: importingActor
        ? importingActor.suspended_at !== null
        : null,
      userDisabled: importingActor?.user_disabled === null
        || importingActor?.user_disabled === undefined
        ? null
        : importingActor.user_disabled !== 0,
      userApproved: importingActor?.user_approved === null
        || importingActor?.user_approved === undefined
        ? null
        : importingActor.user_approved !== 0,
      memorial: importingActor?.memorial === null
        || importingActor?.memorial === undefined
        ? null
        : importingActor.memorial !== 0,
    })) {
      console.log(`[import] Skipping remote lookup for inactive account ${accountId}`);
      return;
    }

    const suspendedDomains = await getSuspendedDomains(env.DB_META_C000, [domain]);
    if (suspendedDomains.has(domain)) {
      console.log(`[import] Skipping remote lookup for suspended domain ${domain}`);
      return;
    }

    // Use the domain-lowercased acct: it feeds both the WebFinger host and the
    // acct: resource, which some remote servers match case-sensitively.
    const actorUri = await webfingerResolve(normalizedAcct);
    if (!actorUri) {
      console.warn(`WebFinger resolve failed for ${acct}, skipping import`);
      return;
    }

    // Enqueue fetch_remote_account (don't re-enqueue self to avoid queue explosion)
    try {
      await env.QUEUE_INTERNAL.send({
        type: 'fetch_remote_account',
        actorUri,
        forceRefresh: false,
      });
    } catch { /* Queue overloaded — will be retried via queue retry mechanism */ }
    // Skip this import item — the account will be fetched asynchronously
    // The user can re-import later if needed
    console.log(`[import] Skipping ${acct} — account not found, enqueued fetch`);
    return;
  }

  if (!targetAccount) {
    console.warn(`Account not found for import: ${acct}, skipping`);
    return;
  }

  if (targetAccount.id === accountId) {
    // Can't follow/block/mute yourself
    return;
  }

  if (action === 'following' && targetAccount.domain) {
    const targetDomain = targetAccount.domain.toLowerCase();
    const suspendedDomains = await getSuspendedDomains(env.DB_META_C000, [targetDomain]);
    if (suspendedDomains.has(targetDomain)) {
      console.log(`[import] Skipping follow import for suspended domain ${targetDomain}`);
      return;
    }
  }

  const actorPermission = await env.DB_META_C000.prepare(
    `SELECT actor.suspended_at, actor.memorial,
            actor_user.disabled AS user_disabled,
            actor_user.approved AS user_approved,
            EXISTS (
              SELECT 1 FROM blocks actor_block
              WHERE actor_block.account_id = actor.id
                AND actor_block.target_account_id = ?2
            ) AS actor_blocks_target,
            EXISTS (
              SELECT 1 FROM blocks target_block
              WHERE target_block.account_id = ?2
                AND target_block.target_account_id = actor.id
            ) AS target_blocks_actor,
            EXISTS (
              SELECT 1 FROM user_domain_blocks actor_domain_block
              WHERE actor_domain_block.account_id = actor.id
                AND ?3 IS NOT NULL
                AND lower(?3) = lower(actor_domain_block.domain)
            ) AS actor_blocks_target_domain
     FROM accounts actor
     LEFT JOIN users actor_user ON actor_user.account_id = actor.id
     WHERE actor.id = ?1
     LIMIT 1`,
  ).bind(accountId, targetAccount.id, targetAccount.domain).first<{
    suspended_at: string | null;
    memorial: number | null;
    user_disabled: number | null;
    user_approved: number | null;
    actor_blocks_target: number;
    target_blocks_actor: number;
    actor_blocks_target_domain: number;
  }>();
  const actorOperational = canActAsAccount({
    accountSuspended: actorPermission
      ? actorPermission.suspended_at !== null
      : null,
    userDisabled: actorPermission?.user_disabled === null
      || actorPermission?.user_disabled === undefined
      ? null
      : actorPermission.user_disabled !== 0,
    userApproved: actorPermission?.user_approved === null
      || actorPermission?.user_approved === undefined
      ? null
      : actorPermission.user_approved !== 0,
    memorial: actorPermission?.memorial === null
      || actorPermission?.memorial === undefined
      ? null
      : actorPermission.memorial !== 0,
  });
  const targetViewable = targetAccount.suspended_at === null
    && (targetAccount.domain !== null || targetAccount.user_approved === 1);

  const now = new Date().toISOString();
  const id = generateUlid();

  switch (action) {
    case 'following': {
      if (!actorOperational || !canFollowAccount({
        actorAccountId: accountId,
        targetAccountId: targetAccount.id,
        targetViewable,
        targetMemorial: targetAccount.memorial !== 0,
        targetMoved: targetAccount.moved_to_account_id !== null,
        actorBlocksTarget: actorPermission
          ? actorPermission.actor_blocks_target !== 0
          : null,
        actorBlocksTargetDomain: actorPermission
          ? actorPermission.actor_blocks_target_domain !== 0
          : null,
        targetBlocksActor: actorPermission
          ? actorPermission.target_blocks_actor !== 0
          : null,
      })) {
        console.log(`[import] Skipping unauthorized follow import for ${normalizedAcct}`);
        return;
      }

      // Check if already following or requested
      const existing = await env.DB_META_C000.prepare(
        `SELECT id FROM follows WHERE account_id = ? AND target_account_id = ?`,
      )
        .bind(accountId, targetAccount.id)
        .first();
      if (existing) return;

      const existingRequest = await env.DB_META_C000.prepare(
        `SELECT id FROM follow_requests WHERE account_id = ? AND target_account_id = ?`,
      )
        .bind(accountId, targetAccount.id)
        .first();
      if (existingRequest) return;

      // Get current account info for AP activity
      const currentAccount = await env.DB_META_C000.prepare(
        `SELECT id, username, uri FROM accounts WHERE id = ?`,
      )
        .bind(accountId)
        .first<{ id: string; username: string; uri: string }>();
      if (!currentAccount) return;

      const actorUri = currentAccount.uri;
      const targetUri = targetAccount.uri || '';
      const isRemote = !!targetAccount.domain;
      const needsApproval = !!(targetAccount.locked || targetAccount.manually_approves_followers);

      // Build Follow activity
      const followActivity = {
        '@context': AP_CONTEXT,
        id: `${actorUri}#follows/${crypto.randomUUID()}`,
        type: 'Follow',
        actor: actorUri,
        object: targetUri,
      };

      if (isRemote || needsApproval) {
        // Create follow request
        const insertResult = await env.DB_META_C000.prepare(
          `INSERT OR IGNORE INTO follow_requests (id, account_id, target_account_id, uri, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(id, accountId, targetAccount.id, followActivity.id, now, now)
          .run();
        if (insertResult.meta.changes !== 1) return;

        // Send Follow activity to remote
        if (isRemote) {
          const inbox =
            targetAccount.inbox_url ||
            targetAccount.shared_inbox_url ||
            `https://${targetAccount.domain}/inbox`;

          await env.QUEUE_FEDERATION.send({
            type: 'deliver_activity',
            activity: followActivity,
            inboxUrl: inbox,
            actorAccountId: accountId,
          });
        }
      } else {
        // Local non-locked: auto-accept
        const insertResult = await env.DB_META_C000.prepare(
          `INSERT OR IGNORE INTO follows (
             id, account_id, target_account_id, uri,
             show_reblogs, notify, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
        ).bind(id, accountId, targetAccount.id, followActivity.id, now, now).run();
        if (insertResult.meta.changes !== 1) return;

        await env.DB_META_C000.batch([
          env.DB_META_C000.prepare(
            'UPDATE accounts SET following_count = following_count + 1 WHERE id = ?',
          ).bind(accountId),
          env.DB_META_C000.prepare(
            'UPDATE accounts SET followers_count = followers_count + 1 WHERE id = ?',
          ).bind(targetAccount.id),
        ]);
      }
      break;
    }

    case 'blocks': {
      if (!canCreateBlockOrMuteAccountRelationship({
        actorAccountId: accountId,
        targetAccountId: targetAccount.id,
        actorOperational,
        targetExists: true,
      })) {
        console.log(`[import] Skipping unauthorized block import for ${normalizedAcct}`);
        return;
      }

      // Blocking tears down both relationship directions. Count updates are
      // conditional on the rows that still exist, so retries cannot drift.
      await env.DB_META_C000.batch([
        env.DB_META_C000.prepare(
          `INSERT OR IGNORE INTO blocks (
             id, account_id, target_account_id, created_at
           ) VALUES (?, ?, ?, ?)`,
        ).bind(id, accountId, targetAccount.id, now),
        env.DB_META_C000.prepare(
          `UPDATE accounts SET following_count = MAX(0, following_count - 1)
           WHERE id = ?1 AND EXISTS (
             SELECT 1 FROM follows
             WHERE account_id = ?1 AND target_account_id = ?2
           )`,
        ).bind(accountId, targetAccount.id),
        env.DB_META_C000.prepare(
          `UPDATE accounts SET followers_count = MAX(0, followers_count - 1)
           WHERE id = ?2 AND EXISTS (
             SELECT 1 FROM follows
             WHERE account_id = ?1 AND target_account_id = ?2
           )`,
        ).bind(accountId, targetAccount.id),
        env.DB_META_C000.prepare(
          `UPDATE accounts SET following_count = MAX(0, following_count - 1)
           WHERE id = ?2 AND EXISTS (
             SELECT 1 FROM follows
             WHERE account_id = ?2 AND target_account_id = ?1
           )`,
        ).bind(accountId, targetAccount.id),
        env.DB_META_C000.prepare(
          `UPDATE accounts SET followers_count = MAX(0, followers_count - 1)
           WHERE id = ?1 AND EXISTS (
             SELECT 1 FROM follows
             WHERE account_id = ?2 AND target_account_id = ?1
           )`,
        ).bind(accountId, targetAccount.id),
        env.DB_META_C000.prepare(
          'DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2',
        ).bind(accountId, targetAccount.id),
        env.DB_META_C000.prepare(
          'DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2',
        ).bind(targetAccount.id, accountId),
        env.DB_META_C000.prepare(
          'DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2',
        ).bind(accountId, targetAccount.id),
        env.DB_META_C000.prepare(
          'DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2',
        ).bind(targetAccount.id, accountId),
        env.DB_META_C000.prepare(
          `DELETE FROM list_accounts
           WHERE account_id = ?1
             AND list_id IN (SELECT id FROM lists WHERE account_id = ?2)`,
        ).bind(targetAccount.id, accountId),
        env.DB_META_C000.prepare(
          `DELETE FROM list_accounts
           WHERE account_id = ?1
             AND list_id IN (SELECT id FROM lists WHERE account_id = ?2)`,
        ).bind(accountId, targetAccount.id),
        env.DB_META_C000.prepare(
          `DELETE FROM account_pins
           WHERE (account_id = ?1 AND target_account_id = ?2)
              OR (account_id = ?2 AND target_account_id = ?1)`,
        ).bind(accountId, targetAccount.id),
      ]);
      break;
    }

    case 'mutes': {
      if (!canCreateBlockOrMuteAccountRelationship({
        actorAccountId: accountId,
        targetAccountId: targetAccount.id,
        actorOperational,
        targetExists: true,
      })) {
        console.log(`[import] Skipping unauthorized mute import for ${normalizedAcct}`);
        return;
      }

      const existing = await env.DB_META_C000.prepare(
        `SELECT id FROM mutes WHERE account_id = ? AND target_account_id = ?`,
      )
        .bind(accountId, targetAccount.id)
        .first();
      if (existing) return;

      const insertResult = await env.DB_META_C000.prepare(
        `INSERT OR IGNORE INTO mutes (
           id, account_id, target_account_id, hide_notifications,
           created_at, updated_at
         )
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
        .bind(id, accountId, targetAccount.id, now, now)
        .run();
      if (insertResult.meta.changes !== 1) return;
      break;
    }
  }

  console.log(`Import ${action}: ${acct} for account ${accountId}`);
}
