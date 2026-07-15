/**
 * Fetch Remote Status Handler
 *
 * Fetches a remote ActivityPub Note/Article by URI,
 * parses it, and upserts into the statuses table.
 * Also resolves the author account if not already known.
 */

import { env } from 'cloudflare:workers';
import { createFed } from '../fedify';
import type { FetchRemoteStatusMessage } from '../shared/types/queue';
import { pickSignerUsername } from '../../../packages/shared/services/signer';
import { parseQuotePolicyFromInteractionPolicy } from '../../../packages/shared/utils/quotePolicy';
import { getSuspendedDomains } from '../../../packages/shared/domain-blocks';

export async function handleFetchRemoteStatus(
  msg: FetchRemoteStatusMessage,
): Promise<void> {
  const { statusUri, signerAccountId } = msg;

  let statusDomain: string;
  try {
    statusDomain = new URL(statusUri).hostname.toLowerCase();
  } catch {
    console.error(`Invalid status URI: ${statusUri}`);
    return;
  }

  const suspendedDomains = await getSuspendedDomains(env.DB, [statusDomain]);
  if (suspendedDomains.has(statusDomain)) {
    console.log(`[remote-status] Skipping lookup for suspended domain ${statusDomain}`);
    return;
  }

  // Check if we already have this status
  const existing = await env.DB.prepare(
    `SELECT id FROM statuses WHERE uri = ?`,
  )
    .bind(statusUri)
    .first<{ id: string }>();

  if (existing) {
    console.log(`Status ${statusUri} already exists locally, skipping`);
    return;
  }

  // Fetch the object via Fedify's authenticated document loader
  // (signed with a real local user's key — not `__instance__` because of
  // its keyId/publicKey.id mismatch — so authorized-fetch / secure-mode
  // remote servers respond instead of returning 401).
  let objectDoc: Record<string, unknown>;
  try {
    const signerUsername = await pickSignerUsername(env.DB, signerAccountId ?? null);
    if (!signerUsername) {
      console.warn(`No local signer available to fetch ${statusUri}, dropping`);
      return;
    }
    const fed = createFed();
    const ctx = fed.createContext(new URL(`https://${env.INSTANCE_DOMAIN}`), { env });
    const documentLoader = await ctx.getDocumentLoader({ identifier: signerUsername });
    const obj = await ctx.lookupObject(statusUri, { documentLoader });
    if (!obj) {
      console.warn(`Status lookup for ${statusUri} returned null, dropping`);
      return;
    }
    objectDoc = (await obj.toJsonLd()) as Record<string, unknown>;
  } catch (err) {
    console.error(`Failed to fetch status ${statusUri}:`, err);
    throw err; // Retry on transient/auth errors
  }

  // Validate type
  const objectType = objectDoc.type as string | undefined;
  if (!objectType || !['Note', 'Article', 'Question'].includes(objectType)) {
    console.warn(`Object ${statusUri} has unsupported type: ${objectType}, dropping`);
    return;
  }

  // Extract author (attributedTo)
  const attributedTo = objectDoc.attributedTo as string | Record<string, unknown> | undefined;
  const authorUri = typeof attributedTo === 'string'
    ? attributedTo
    : (attributedTo?.id as string | undefined);

  if (!authorUri) {
    console.warn(`Status ${statusUri} has no attributedTo, dropping`);
    return;
  }

  let authorDomain: string;
  try {
    authorDomain = new URL(authorUri).hostname.toLowerCase();
  } catch {
    console.warn(`Status ${statusUri} has an invalid attributedTo URL, dropping`);
    return;
  }

  const suspendedAuthorDomains = await getSuspendedDomains(env.DB, [authorDomain]);
  if (suspendedAuthorDomains.has(authorDomain)) {
    console.log(
      `[remote-status] Skipping status ${statusUri} attributed to suspended domain ${authorDomain}`,
    );
    return;
  }

  // Resolve author account — check if we know them
  let authorAccountId: string | null = null;
  const authorRow = await env.DB.prepare(
    `SELECT id FROM accounts WHERE uri = ?`,
  )
    .bind(authorUri)
    .first<{ id: string }>();

  if (authorRow) {
    authorAccountId = authorRow.id;
  } else {
    // Enqueue fetch of the remote account
    await env.QUEUE_INTERNAL.send({
      type: 'fetch_remote_account',
      actorUri: authorUri,
      ...(signerAccountId ? { signerAccountId } : {}),
    });
    // We still need an account_id — create a placeholder
    authorAccountId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO accounts (id, username, domain, uri, created_at, updated_at)
       VALUES (?, '', ?, ?, datetime('now'), datetime('now'))`,
    )
      .bind(authorAccountId, authorDomain, authorUri)
      .run();
  }

  // Parse the AP Note fields
  const statusId = crypto.randomUUID();
  const content = (objectDoc.content as string) || '';
  const contentWarning = (objectDoc.summary as string) || null;
  const uri = (objectDoc.id as string) || statusUri;
  const url = (objectDoc.url as string) || uri;
  const published = (objectDoc.published as string) || new Date().toISOString();
  const inReplyTo = (objectDoc.inReplyTo as string) || null;
  const sensitive = (objectDoc.sensitive as boolean) || false;
  const language = extractLanguage(objectDoc);

  // Determine visibility from addressing
  const visibility = determineVisibility(objectDoc);
  const quotePolicy = parseQuotePolicyFromInteractionPolicy(
    objectDoc.interactionPolicy,
    authorUri,
    `${authorUri}/followers`,
  );

  // Extract emoji tags for lazy-load rendering (no caching, just store tag array)
  const allTags = objectDoc.tag as Record<string, unknown>[] | undefined;
  const emojiTags = Array.isArray(allTags)
    ? allTags.filter(t => (t as Record<string, unknown>)?.type === 'Emoji')
    : [];

  // Insert into statuses table
  await env.DB.prepare(
    `INSERT OR IGNORE INTO statuses (
       id, account_id, uri, url, content, content_warning,
       visibility, language, in_reply_to_id, sensitive,
       local, quote_policy, emoji_tags, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      statusId,
      authorAccountId,
      uri,
      url,
      content,
      contentWarning,
      visibility,
      language,
      inReplyTo,
      sensitive ? 1 : 0,
      quotePolicy,
      JSON.stringify(emojiTags), // Store emoji tag array for lazy-load
      published,
    )
    .run();

  // Handle attachments if present
  const attachments = objectDoc.attachment as Record<string, unknown>[] | undefined;
  if (Array.isArray(attachments)) {
    const stmts: D1PreparedStatement[] = [];
    for (const att of attachments) {
      const attObj = att as Record<string, unknown>;
      if (attObj.type !== 'Document' && attObj.type !== 'Image') continue;
      const mediaUrl = attObj.url as string;
      if (!mediaUrl) continue;

      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO media_attachments (
             id, status_id, account_id, remote_url, content_type, description,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        ).bind(
          crypto.randomUUID(),
          statusId,
          authorAccountId,
          mediaUrl,
          (attObj.mediaType as string) || 'application/octet-stream',
          (attObj.name as string) || null,
        ),
      );
    }
    if (stmts.length > 0) {
      await env.DB.batch(stmts);
    }
  }

  // Handle tags/mentions/hashtags/emojis if present
  const tags = objectDoc.tag as Record<string, unknown>[] | undefined;
  if (Array.isArray(tags)) {
    const stmts: D1PreparedStatement[] = [];
    for (const tag of tags) {
      const tagObj = tag as Record<string, unknown>;
      if (tagObj.type === 'Hashtag') {
        const tagName = ((tagObj.name as string) || '').replace(/^#/, '').toLowerCase();
        if (!tagName) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO status_tags (status_id, tag_name) VALUES (?, ?)`,
          ).bind(statusId, tagName),
        );
      } else if (tagObj.type === 'Emoji') {
        // Note: Emoji NOT stored in database.
        // Extracted on-demand from status tag array during rendering.
        // Zero database writes, lazy-load on fetch.
      }
    }
    if (stmts.length > 0) {
      await env.DB.batch(stmts);
    }
  }

  console.log(`Fetched remote status ${statusUri} as ${statusId}`);
}

/**
 * Extract language from the AP object's contentMap.
 */
function extractLanguage(obj: Record<string, unknown>): string | null {
  const contentMap = obj.contentMap as Record<string, string> | undefined;
  if (contentMap) {
    const langs = Object.keys(contentMap);
    if (langs.length > 0) return langs[0];
  }
  return null;
}

/**
 * Determine visibility from AP addressing (to/cc fields).
 */
function determineVisibility(obj: Record<string, unknown>): string {
  const to = normalizeAddressing(obj.to);
  const cc = normalizeAddressing(obj.cc);

  const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
  const PUBLIC_ALT = 'as:Public';

  const isPublicTo = to.some((a) => a === PUBLIC || a === PUBLIC_ALT);
  const isPublicCc = cc.some((a) => a === PUBLIC || a === PUBLIC_ALT);

  if (isPublicTo) return 'public';
  if (isPublicCc) return 'unlisted';

  // Check if addressed to followers (unlisted/followers-only)
  const hasFollowers = [...to, ...cc].some((a) => a.endsWith('/followers'));
  if (hasFollowers) return 'private';

  return 'direct';
}

function normalizeAddressing(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}
