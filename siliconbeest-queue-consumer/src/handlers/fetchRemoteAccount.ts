/**
 * Fetch Remote Account Handler
 *
 * Resolves a remote ActivityPub actor URI:
 * 1. Resolve WebFinger for the actor's acct URI
 * 2. Fetch the actor document via the self link
 * 3. Upsert into accounts table (domain IS NOT NULL for remote)
 * 4. Cache the actor in KV
 */

import { env } from 'cloudflare:workers';
import { getDocumentLoader } from '@fedify/fedify';
import { Collection, isActor } from '@fedify/vocab';
import { createFed } from '../fedify';
import type { FetchRemoteAccountMessage } from '../shared/types/queue';
import { getUserAgent } from '../utils/repository';
import { ensureInstanceRecord } from '../../../packages/shared/services/instance';
import { pickSignerUsername } from '../../../packages/shared/services/signer';
import { emojiTagToCustomEmoji } from '../../../packages/shared/utils/customEmoji';
import { lookupRemoteSoftware } from '../utils/nodeinfo';
import { getSuspendedDomains } from '../../../packages/shared/domain-blocks';
import {
  canStoreFetchedRemoteActor,
  shouldHideRemoteAccountCollections,
} from '../../../packages/shared/permissions';

/** Cache TTL for remote actor documents (5 minutes). */
const ACTOR_CACHE_TTL = 300;

/** Minimum seconds between re-fetches unless forceRefresh is set. */
const MIN_REFETCH_INTERVAL = 300; // 5 minutes

interface ExistingRemoteAccountState {
  id: string;
  fetched_at: string | null;
  suspended_at: string | null;
}

async function getExistingRemoteAccountState(
  actorUri: string,
): Promise<ExistingRemoteAccountState | null> {
  return env.DB.prepare(
    `SELECT id, fetched_at, suspended_at
     FROM accounts
     WHERE uri = ? AND domain IS NOT NULL`,
  )
    .bind(actorUri)
    .first<ExistingRemoteAccountState>();
}

export async function handleFetchRemoteAccount(
  msg: FetchRemoteAccountMessage,
): Promise<void> {
  const { actorUri, forceRefresh, signerAccountId } = msg;

  let actorDomain: string;
  try {
    const actorUrl = new URL(actorUri);
    actorDomain = actorUrl.hostname.toLowerCase();
  } catch {
    console.error(`Invalid actor URI: ${actorUri}`);
    return;
  }

  if (!canStoreFetchedRemoteActor({
    requestedActorUri: actorUri,
    actorUri,
    localInstanceDomain: env.INSTANCE_DOMAIN,
    actorSuspended: false,
  })) {
    console.warn(`Refusing non-remote actor lookup for ${actorUri}`);
    return;
  }

  const suspendedDomains = await getSuspendedDomains(env.DB, [actorDomain]);
  if (suspendedDomains.has(actorDomain)) {
    console.log(`[remote-account] Skipping lookup for suspended domain ${actorDomain}`);
    return;
  }

  // A force refresh must not overwrite a locally suspended identity. Read the
  // account state independently of the freshness/cache shortcuts.
  const existing = await getExistingRemoteAccountState(actorUri);
  if (existing?.suspended_at) {
    console.log(`[remote-account] Skipping locally suspended actor ${actorUri}`);
    return;
  }

  // Check KV cache first (skip if forceRefresh)
  const cacheKey = `actor:${actorUri}`;
  if (!forceRefresh) {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      console.log(`Actor ${actorUri} found in cache, skipping fetch`);
      return;
    }

    if (existing?.fetched_at) {
      const fetchedAt = new Date(existing.fetched_at).getTime();
      const now = Date.now();
      if (now - fetchedAt < MIN_REFETCH_INTERVAL * 1000) {
        console.log(`Actor ${actorUri} fetched recently, skipping`);
        return;
      }
    }
  }

  // Step 1: Fetch the actor document via Fedify's authenticated document loader
  // (signed with a real local user's key) so authorized-fetch / secure-mode
  // remote servers respond instead of returning 401.
  //
  // We sign as a regular user — NOT as `__instance__` — because the instance
  // actor's `id`/`publicKey.id` (/actor#main-key) does not match Fedify's
  // signature keyId (/users/__instance__#main-key), and authorized-fetch
  // verifiers reject the mismatch.
  let actorDoc: Record<string, unknown>;
  let resolvedActorUri: string;
  let followersUrl: string | null = null;
  let followingUrl: string | null = null;
  let hideCollections = true;
  try {
    const signerUsername = await pickSignerUsername(env.DB, signerAccountId ?? null);
    if (!signerUsername) {
      console.warn(`No local signer available to fetch ${actorUri}, dropping`);
      return;
    }
    const fed = createFed();
    const ctx = fed.createContext(new URL(`https://${env.INSTANCE_DOMAIN}`), { env });
    const documentLoader = await ctx.getDocumentLoader({ identifier: signerUsername });
    const actorObj = await ctx.lookupObject(actorUri, { documentLoader });
    if (!actorObj || !isActor(actorObj)) {
      console.warn(`Actor lookup for ${actorUri} did not return an actor, dropping`);
      return;
    }
    actorDoc = (await actorObj.toJsonLd()) as Record<string, unknown>;
    const candidateActorUri = typeof actorDoc.id === 'string' ? actorDoc.id : null;
    const candidateMatchesRequest = canStoreFetchedRemoteActor({
      requestedActorUri: actorUri,
      actorUri: candidateActorUri,
      localInstanceDomain: env.INSTANCE_DOMAIN,
      actorSuspended: false,
    });

    let verifiedActorObj = actorObj;
    let expectedActorUri = actorUri;
    if (!candidateMatchesRequest) {
      // A lookup URI may be an alias for a canonical actor URI. Never persist
      // fields supplied by the alias host: first validate the candidate as a
      // remote URI, then fetch it directly and require exact self-identity.
      if (!candidateActorUri || !canStoreFetchedRemoteActor({
        requestedActorUri: candidateActorUri,
        actorUri: candidateActorUri,
        localInstanceDomain: env.INSTANCE_DOMAIN,
        actorSuspended: false,
      })) {
        console.warn(`Actor ${actorUri} has an invalid canonical id, dropping`);
        return;
      }

      const canonicalDomain = new URL(candidateActorUri).hostname.toLowerCase();
      if (canonicalDomain !== actorDomain) {
        const suspendedCanonicalDomains = await getSuspendedDomains(
          env.DB,
          [canonicalDomain],
        );
        if (suspendedCanonicalDomains.has(canonicalDomain)) {
          console.log(
            `[remote-account] Skipping actor ${actorUri} with suspended canonical domain ${canonicalDomain}`,
          );
          return;
        }
      }

      const canonicalActorObj = await ctx.lookupObject(candidateActorUri, {
        documentLoader,
      });
      if (!canonicalActorObj || !isActor(canonicalActorObj)) {
        console.warn(
          `Canonical actor lookup for ${candidateActorUri} did not return an actor, dropping`,
        );
        return;
      }
      const canonicalActorDoc = (
        await canonicalActorObj.toJsonLd()
      ) as Record<string, unknown>;
      actorDomain = canonicalDomain;
      actorDoc = canonicalActorDoc;
      verifiedActorObj = canonicalActorObj;
      expectedActorUri = candidateActorUri;
    }

    const verifiedActorUri = typeof actorDoc.id === 'string' ? actorDoc.id : null;
    if (!verifiedActorUri || !canStoreFetchedRemoteActor({
      requestedActorUri: expectedActorUri,
      actorUri: verifiedActorUri,
      localInstanceDomain: env.INSTANCE_DOMAIN,
      actorSuspended: false,
    })) {
      console.warn(
        `Actor lookup identity mismatch for ${expectedActorUri}, dropping`,
      );
      return;
    }

    // URL normalization can make two URI strings equivalent while the DB key
    // differs. Always check the exact URI that will be persisted.
    if (verifiedActorUri !== actorUri) {
      const resolvedExisting = await getExistingRemoteAccountState(
        verifiedActorUri,
      );
      if (resolvedExisting?.suspended_at) {
        console.log(
          `[remote-account] Skipping locally suspended canonical actor ${verifiedActorUri}`,
        );
        return;
      }
    }
    resolvedActorUri = verifiedActorUri;

    const followersId = verifiedActorObj.followersId;
    const followingId = verifiedActorObj.followingId;
    followersUrl = followersId?.href ?? null;
    followingUrl = followingId?.href ?? null;
    const actorOrigin = new URL(verifiedActorUri).origin;
    const anonymousDocumentLoader = getDocumentLoader({
      userAgent: getUserAgent('ActivityPub'),
    });
    const [followersResult, followingResult] = await Promise.allSettled([
      followersId?.origin === actorOrigin
        ? ctx.lookupObject(followersId, { documentLoader: anonymousDocumentLoader })
        : Promise.resolve(null),
      followingId?.origin === actorOrigin
        ? ctx.lookupObject(followingId, { documentLoader: anonymousDocumentLoader })
        : Promise.resolve(null),
    ]);
    const followersCollection = followersResult.status === 'fulfilled'
      && followersResult.value instanceof Collection
      ? followersResult.value
      : null;
    const followingCollection = followingResult.status === 'fulfilled'
      && followingResult.value instanceof Collection
      ? followingResult.value
      : null;
    hideCollections = shouldHideRemoteAccountCollections({
      followersAdvertised: followersUrl !== null,
      followingAdvertised: followingUrl !== null,
      followersFirstPageAvailable: followersCollection !== null
        && followersCollection.firstId !== null,
      followingFirstPageAvailable: followingCollection !== null
        && followingCollection.firstId !== null,
    });
  } catch (err) {
    console.error(`Failed to fetch actor ${actorUri}:`, err);
    throw err; // Retry on transient/auth errors
  }

  // Validate minimal required fields
  const actorType = actorDoc.type as string | undefined;
  const preferredUsername = actorDoc.preferredUsername as string | undefined;
  const inbox = actorDoc.inbox as string | undefined;

  if (!actorType || !inbox) {
    console.warn(`Actor ${actorUri} missing required fields (type or inbox), dropping`);
    return;
  }

  // Extract fields from the verified actor document
  const id = resolvedActorUri;

  const name = (actorDoc.name as string) || preferredUsername || '';
  const username = preferredUsername || '';
  const summary = (actorDoc.summary as string) || '';
  const url = (actorDoc.url as string) || id;
  const sharedInbox =
    (actorDoc.endpoints as Record<string, unknown>)?.sharedInbox as string | undefined;
  const outbox = actorDoc.outbox as string | undefined;

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

  // Extract profile fields (PropertyValue attachments)
  const profileFields: Array<{ name: string; value: string; verified_at: string | null }> = [];
  const attachments = actorDoc.attachment as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (att.type === 'PropertyValue' && att.name) {
        profileFields.push({
          name: String(att.name),
          value: String(att.value || ''),
          verified_at: null,
        });
      }
    }
  }
  const fieldsJson = JSON.stringify(profileFields);

  // Extract Emoji tags from the actor document
  const emojiTags: Array<{ shortcode: string; url: string; static_url: string }> = [];
  const tags = actorDoc.tag as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (tag.type !== 'Emoji') continue;
      const emoji = emojiTagToCustomEmoji(tag);
      if (emoji) emojiTags.push({ shortcode: emoji.shortcode, url: emoji.url, static_url: emoji.static_url });
    }
  }
  const emojiTagsJson = emojiTags.length > 0 ? JSON.stringify(emojiTags) : null;

  // Step 2: Upsert into accounts table
  await env.DB.prepare(
    `INSERT INTO accounts (
       id, username, domain, display_name, note, uri, url,
       avatar_url, header_url, inbox_url, outbox_url,
       shared_inbox_url, followers_url, following_url, hide_collections,
       public_key_pem, public_key_id, actor_type,
       is_bot, is_group, fields, emoji_tags, fetched_at, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now')
     )
     ON CONFLICT(uri) DO UPDATE SET
       username = excluded.username,
       domain = excluded.domain,
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
       hide_collections = excluded.hide_collections,
       public_key_pem = excluded.public_key_pem,
       public_key_id = excluded.public_key_id,
       actor_type = excluded.actor_type,
       is_bot = excluded.is_bot,
       is_group = excluded.is_group,
       fields = excluded.fields,
       emoji_tags = excluded.emoji_tags,
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
      followersUrl,
      followingUrl,
      hideCollections ? 1 : 0,
      publicKeyPem ?? null,
      publicKeyId ?? null,
      actorType,
      isBot ? 1 : 0,
      isGroup ? 1 : 0,
      fieldsJson,
      emojiTagsJson,
    )
    .run();

  // Step 4: Cache in KV (best-effort — rate limit may reject)
  try {
    await env.CACHE.put(cacheKey, JSON.stringify(actorDoc), {
      expirationTtl: ACTOR_CACHE_TTL,
    });
  } catch {
    // KV write failed (429 rate limit) — non-fatal, DB is the source of truth
  }

  // Ensure the instance record exists
  await ensureInstanceRecord(env.DB, actorDomain);

  // NodeInfo discovery — fetch software info for this instance (best-effort, never blocks)
  try {
    const nodeinfoKey = `nodeinfo:${actorDomain}`;
    const cached = await env.CACHE.get(nodeinfoKey);
    if (!cached) {
      const software = await lookupRemoteSoftware(
        actorDomain,
        getUserAgent('ActivityPub'),
      );
      if (software) {
        const { softwareName, softwareVersion } = software;
        await env.DB.prepare(
          `UPDATE instances SET software_name = ?, software_version = ?, updated_at = datetime('now') WHERE domain = ?`,
        )
          .bind(softwareName, softwareVersion, actorDomain)
          .run();
        // Cache for 2 hours (best-effort)
        try { await env.CACHE.put(nodeinfoKey, JSON.stringify({ softwareName, softwareVersion }), {
          expirationTtl: 7200,
        }); } catch { /* KV rate limit — non-fatal */ }
      }
    }
  } catch (err) {
    // NodeInfo is best-effort — never block account fetching
    console.warn(`NodeInfo fetch failed for ${actorDomain}:`, err);
  }

  console.log(`Fetched and cached remote actor: ${username}@${actorDomain}`);
}
