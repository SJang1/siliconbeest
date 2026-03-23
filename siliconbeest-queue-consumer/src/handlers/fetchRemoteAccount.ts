/**
 * Fetch Remote Account Handler
 *
 * Resolves a remote ActivityPub actor URI:
 * 1. Resolve WebFinger for the actor's acct URI
 * 2. Fetch the actor document via the self link
 * 3. Upsert into accounts table (domain IS NOT NULL for remote)
 * 4. Cache the actor in KV
 */

import type { Env } from '../env';
import type { FetchRemoteAccountMessage } from '../shared/types/queue';

/** Cache TTL for remote actor documents (24 hours). */
const ACTOR_CACHE_TTL = 86400;

/** Minimum seconds between re-fetches unless forceRefresh is set. */
const MIN_REFETCH_INTERVAL = 3600; // 1 hour

const AP_ACCEPT = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

export async function handleFetchRemoteAccount(
  msg: FetchRemoteAccountMessage,
  env: Env,
): Promise<void> {
  const { actorUri, forceRefresh } = msg;

  // Check KV cache first (skip if forceRefresh)
  const cacheKey = `actor:${actorUri}`;
  if (!forceRefresh) {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      console.log(`Actor ${actorUri} found in cache, skipping fetch`);
      return;
    }
  }

  // Check if we recently fetched this actor (unless forced)
  if (!forceRefresh) {
    const existing = await env.DB.prepare(
      `SELECT id, fetched_at FROM accounts WHERE uri = ? AND domain IS NOT NULL`,
    )
      .bind(actorUri)
      .first<{ id: string; fetched_at: string | null }>();

    if (existing?.fetched_at) {
      const fetchedAt = new Date(existing.fetched_at).getTime();
      const now = Date.now();
      if (now - fetchedAt < MIN_REFETCH_INTERVAL * 1000) {
        console.log(`Actor ${actorUri} fetched recently, skipping`);
        return;
      }
    }
  }

  // Parse the actor URI to get the domain
  let actorDomain: string;
  try {
    actorDomain = new URL(actorUri).hostname;
  } catch {
    console.error(`Invalid actor URI: ${actorUri}`);
    return;
  }

  // Step 1: Fetch the actor document directly (most AP implementations support this)
  let actorDoc: Record<string, unknown>;
  try {
    const response = await fetch(actorUri, {
      headers: {
        Accept: AP_ACCEPT,
      },
    });

    if (!response.ok) {
      if (response.status >= 500) {
        throw new Error(`Actor fetch failed with ${response.status}`);
      }
      console.warn(`Actor fetch for ${actorUri} returned ${response.status}, dropping`);
      return;
    }

    actorDoc = (await response.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && err.message.includes('Actor fetch failed')) {
      throw err; // Retry on 5xx
    }
    console.error(`Failed to fetch actor ${actorUri}:`, err);
    throw err; // Retry on network errors
  }

  // Validate minimal required fields
  const actorType = actorDoc.type as string | undefined;
  const preferredUsername = actorDoc.preferredUsername as string | undefined;
  const inbox = actorDoc.inbox as string | undefined;

  if (!actorType || !inbox) {
    console.warn(`Actor ${actorUri} missing required fields (type or inbox), dropping`);
    return;
  }

  // Extract fields from the actor document
  const id = (actorDoc.id as string) || actorUri;
  const name = (actorDoc.name as string) || preferredUsername || '';
  const username = preferredUsername || '';
  const summary = (actorDoc.summary as string) || '';
  const url = (actorDoc.url as string) || id;
  const sharedInbox =
    (actorDoc.endpoints as Record<string, unknown>)?.sharedInbox as string | undefined;
  const outbox = actorDoc.outbox as string | undefined;
  const followersUrl = actorDoc.followers as string | undefined;
  const followingUrl = actorDoc.following as string | undefined;

  // Extract avatar and header
  const iconObj = actorDoc.icon as Record<string, unknown> | undefined;
  const avatarUrl = iconObj?.url as string | undefined;
  const imageObj = actorDoc.image as Record<string, unknown> | undefined;
  const headerUrl = imageObj?.url as string | undefined;

  // Extract public key
  const publicKeyObj = actorDoc.publicKey as Record<string, unknown> | undefined;
  const publicKeyPem = publicKeyObj?.publicKeyPem as string | undefined;
  const publicKeyId = publicKeyObj?.id as string | undefined;

  // Check for bot/group account types
  const isBot = actorType === 'Service' || actorType === 'Application';
  const isGroup = actorType === 'Group';

  // Step 2: Upsert into accounts table
  await env.DB.prepare(
    `INSERT INTO accounts (
       id, username, domain, display_name, note, uri, url,
       avatar_url, header_url, inbox_url, outbox_url,
       shared_inbox_url, followers_url, following_url,
       public_key_pem, public_key_id, actor_type,
       is_bot, is_group, fetched_at, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ?, ?, datetime('now'), datetime('now'), datetime('now')
     )
     ON CONFLICT(uri) DO UPDATE SET
       display_name = excluded.display_name,
       note = excluded.note,
       url = excluded.url,
       avatar_url = excluded.avatar_url,
       header_url = excluded.header_url,
       inbox_url = excluded.inbox_url,
       outbox_url = excluded.outbox_url,
       shared_inbox_url = excluded.shared_inbox_url,
       followers_url = excluded.followers_url,
       following_url = excluded.following_url,
       public_key_pem = excluded.public_key_pem,
       public_key_id = excluded.public_key_id,
       actor_type = excluded.actor_type,
       is_bot = excluded.is_bot,
       is_group = excluded.is_group,
       fetched_at = datetime('now'),
       updated_at = datetime('now')`,
  )
    .bind(
      crypto.randomUUID(), // id (only used on INSERT, not on conflict update)
      username,
      actorDomain,
      name,
      summary,
      id,
      url,
      avatarUrl ?? null,
      headerUrl ?? null,
      inbox,
      outbox ?? null,
      sharedInbox ?? null,
      followersUrl ?? null,
      followingUrl ?? null,
      publicKeyPem ?? null,
      publicKeyId ?? null,
      actorType,
      isBot ? 1 : 0,
      isGroup ? 1 : 0,
    )
    .run();

  // Step 3: Cache in KV
  await env.CACHE.put(cacheKey, JSON.stringify(actorDoc), {
    expirationTtl: ACTOR_CACHE_TTL,
  });

  // Ensure the instance record exists
  await env.DB.prepare(
    `INSERT OR IGNORE INTO instances (domain, created_at, updated_at)
     VALUES (?, datetime('now'), datetime('now'))`,
  )
    .bind(actorDomain)
    .run();

  console.log(`Fetched and cached remote actor: ${username}@${actorDomain}`);
}
