/**
 * Import Item Handler
 *
 * Processes a single import_item message from CSV import:
 * 1. WebFinger resolve the acct address
 * 2. If account not in DB, enqueue fetch_remote_account
 * 3. Create follow/block/mute depending on action
 * 4. For follow: also enqueue federation delivery of Follow activity
 */

import type { Env } from '../env';
import type { ImportItemMessage } from '../shared/types/queue';

const AP_CONTEXT = 'https://www.w3.org/ns/activitystreams';

function generateULID(): string {
  const t = Date.now();
  const ts = t.toString(36).padStart(10, '0');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => (b % 36).toString(36))
    .join('');
  return (ts + rand).toUpperCase();
}

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
  env: Env,
): Promise<void> {
  const { acct, action, accountId } = msg;

  // Parse acct parts
  const parts = acct.split('@');
  const username = parts[0];
  const domain = parts.length >= 2 ? parts[parts.length - 1] : null;

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
  } | null = null;

  if (domain) {
    targetAccount = await env.DB.prepare(
      `SELECT id, username, domain, uri, inbox_url, shared_inbox_url, locked,
              COALESCE(manually_approves_followers, 0) AS manually_approves_followers
       FROM accounts
       WHERE username = ? AND domain = ?`,
    )
      .bind(username, domain)
      .first();
  } else {
    targetAccount = await env.DB.prepare(
      `SELECT id, username, domain, uri, inbox_url, shared_inbox_url, locked,
              COALESCE(manually_approves_followers, 0) AS manually_approves_followers
       FROM accounts
       WHERE username = ? AND domain IS NULL`,
    )
      .bind(username)
      .first();
  }

  // If not found and it's a remote account, try WebFinger and enqueue fetch
  if (!targetAccount && domain) {
    const actorUri = await webfingerResolve(acct);
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

  const now = new Date().toISOString();
  const id = generateULID();

  switch (action) {
    case 'following': {
      // Check if already following or requested
      const existing = await env.DB.prepare(
        `SELECT id FROM follows WHERE account_id = ? AND target_account_id = ?`,
      )
        .bind(accountId, targetAccount.id)
        .first();
      if (existing) return;

      const existingRequest = await env.DB.prepare(
        `SELECT id FROM follow_requests WHERE account_id = ? AND target_account_id = ?`,
      )
        .bind(accountId, targetAccount.id)
        .first();
      if (existingRequest) return;

      // Get current account info for AP activity
      const currentAccount = await env.DB.prepare(
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
        await env.DB.prepare(
          `INSERT INTO follow_requests (id, account_id, target_account_id, uri, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(id, accountId, targetAccount.id, followActivity.id, now, now)
          .run();

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
        const batch = [
          env.DB.prepare(
            `INSERT INTO follows (id, account_id, target_account_id, uri, show_reblogs, notify, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
          ).bind(id, accountId, targetAccount.id, followActivity.id, now, now),
          env.DB.prepare(
            'UPDATE accounts SET following_count = following_count + 1 WHERE id = ?',
          ).bind(accountId),
          env.DB.prepare(
            'UPDATE accounts SET followers_count = followers_count + 1 WHERE id = ?',
          ).bind(targetAccount.id),
        ];
        await env.DB.batch(batch);
      }
      break;
    }

    case 'blocks': {
      const existing = await env.DB.prepare(
        `SELECT id FROM blocks WHERE account_id = ? AND target_account_id = ?`,
      )
        .bind(accountId, targetAccount.id)
        .first();
      if (existing) return;

      await env.DB.prepare(
        `INSERT INTO blocks (id, account_id, target_account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(id, accountId, targetAccount.id, now, now)
        .run();

      // Also remove any existing follow relationships in both directions
      await env.DB.batch([
        env.DB.prepare(
          'DELETE FROM follows WHERE account_id = ? AND target_account_id = ?',
        ).bind(accountId, targetAccount.id),
        env.DB.prepare(
          'DELETE FROM follows WHERE account_id = ? AND target_account_id = ?',
        ).bind(targetAccount.id, accountId),
      ]);
      break;
    }

    case 'mutes': {
      const existing = await env.DB.prepare(
        `SELECT id FROM mutes WHERE account_id = ? AND target_account_id = ?`,
      )
        .bind(accountId, targetAccount.id)
        .first();
      if (existing) return;

      await env.DB.prepare(
        `INSERT INTO mutes (id, account_id, target_account_id, hide_notifications, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
        .bind(id, accountId, targetAccount.id, now, now)
        .run();
      break;
    }
  }

  console.log(`Import ${action}: ${acct} for account ${accountId}`);
}
