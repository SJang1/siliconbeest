/**
 * Deliver Activity Fanout Handler
 *
 * Loads all unique remote follower inbox URLs for the actor,
 * deduplicates by shared inbox (preferring shared inbox over individual),
 * and enqueues individual deliver_activity messages for each unique inbox.
 */

import type { Env } from '../env';
import type { DeliverActivityFanoutMessage, DeliverActivityMessage } from '../shared/types/queue';

export async function handleDeliverActivityFanout(
  msg: DeliverActivityFanoutMessage,
  env: Env,
): Promise<void> {
  const { activity, actorAccountId } = msg;

  // Load all remote followers' inbox URLs
  // Remote accounts have domain IS NOT NULL
  const rows = await env.DB.prepare(
    `SELECT DISTINCT
       a.inbox_url,
       a.shared_inbox_url,
       a.domain
     FROM follows f
     JOIN accounts a ON a.id = f.account_id
     WHERE f.target_account_id = ?
       AND a.domain IS NOT NULL`,
  )
    .bind(actorAccountId)
    .all<{
      inbox_url: string;
      shared_inbox_url: string | null;
      domain: string;
    }>();

  if (!rows.results || rows.results.length === 0) {
    console.log(`No remote followers for actor ${actorAccountId}, nothing to fan out`);
    return;
  }

  // Deduplicate: prefer shared inbox per domain, fall back to individual
  const inboxes = new Set<string>();
  const domainSharedInboxes = new Map<string, string>();

  for (const row of rows.results) {
    if (row.shared_inbox_url) {
      // Track shared inbox per domain (all accounts on same domain share it)
      if (!domainSharedInboxes.has(row.domain)) {
        domainSharedInboxes.set(row.domain, row.shared_inbox_url);
      }
    } else if (row.inbox_url) {
      // No shared inbox — use individual inbox
      inboxes.add(row.inbox_url);
    }
  }

  // Add all unique shared inboxes
  for (const sharedInbox of domainSharedInboxes.values()) {
    inboxes.add(sharedInbox);
  }

  // Remove individual inboxes whose domain already has a shared inbox
  for (const inbox of inboxes) {
    try {
      const domain = new URL(inbox).hostname;
      const sharedInbox = domainSharedInboxes.get(domain);
      if (sharedInbox && inbox !== sharedInbox) {
        inboxes.delete(inbox);
      }
    } catch {
      // Invalid URL — remove it
      inboxes.delete(inbox);
    }
  }

  // ------------------------------------------------------------------
  // Also deliver to active relays (for public posts)
  // ------------------------------------------------------------------
  const isPublic =
    (Array.isArray(activity.to) && activity.to.includes('https://www.w3.org/ns/activitystreams#Public')) ||
    (Array.isArray(activity.cc) && activity.cc.includes('https://www.w3.org/ns/activitystreams#Public'));

  if (isPublic) {
    const { results: relayRows } = await env.DB.prepare(
      "SELECT inbox_url FROM relays WHERE state = 'accepted'",
    ).all<{ inbox_url: string }>();

    for (const relay of relayRows || []) {
      inboxes.add(relay.inbox_url);
    }
  }

  if (inboxes.size === 0) {
    console.log(`No valid inboxes after deduplication for actor ${actorAccountId}`);
    return;
  }

  // Enqueue individual deliver_activity messages in batches
  // Cloudflare Queues supports up to 100 messages per sendBatch call
  const BATCH_SIZE = 100;
  const messages: { body: DeliverActivityMessage }[] = [];

  for (const inboxUrl of inboxes) {
    messages.push({
      body: {
        type: 'deliver_activity',
        activity,
        inboxUrl,
        actorAccountId,
      },
    });
  }

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    await env.QUEUE_FEDERATION.sendBatch(batch);
  }

  console.log(
    `Fanned out activity to ${inboxes.size} unique inboxes for actor ${actorAccountId}`,
  );
}
