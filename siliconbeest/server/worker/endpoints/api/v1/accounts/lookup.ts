import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../../types';
import { AppError } from '../../../../middleware/errorHandler';
import { getFedifyContext } from '../../../../federation/helpers/send';
import { isActor } from '@fedify/fedify/vocab';
import { getAccountByUsername } from '../../../../services/account';
import { pickSignerUsername } from '../../../../../../../packages/shared/services/signer';
import { parseCustomEmojiTagsJson } from '../../../../../../../packages/shared/utils/customEmoji';
import { sanitizeHtml } from '../../../../utils/sanitize';

type HonoEnv = { Variables: AppVariables };

function safeJsonParse<T>(val: string | null, fallback: T): T {
  if (!val) return fallback;
  return JSON.parse(val);
}

const app = new Hono<HonoEnv>();

app.get('/lookup', async (c) => {
  const acct = c.req.query('acct');
  const instanceDomain = env.INSTANCE_DOMAIN;

  if (!acct) {
    throw new AppError(400, 'Validation failed', 'acct is required');
  }

  // Parse acct: "user" (local) or "user@domain" (remote)
  const cleaned = acct.replace(/^@/, '');
  const parts = cleaned.split('@');
  const username = parts[0]!;
  // Domains are DNS names (case-insensitive): normalize to lowercase so the
  // instance-domain check, WebFinger resource, INSERT, and re-SELECT all use
  // the canonical form (remote rows store URL.host, which is lowercase).
  // The username intentionally keeps its exact case (AP identity).
  const acctDomain = parts[1]?.toLowerCase() || null;

  let row;
  if (!acctDomain || acctDomain === instanceDomain.toLowerCase()) {
    // Local account
    row = await getAccountByUsername(username);
  } else {
    // Remote account — check if we have it cached
    row = await getAccountByUsername(username, acctDomain);
  }

  // If remote account not in DB, try WebFinger + Fedify lookupObject
  if (!row && acctDomain && acctDomain !== instanceDomain.toLowerCase()) {
    console.log(`[lookup] Remote account not in DB, resolving ${username}@${acctDomain}`);
    try {
      const fed = c.get('federation');
      if (!fed) {
        console.error('[lookup] Federation not available on context');
        throw new Error('Federation not available');
      }
      const ctx = getFedifyContext(fed);
      console.log(`[lookup] Looking up WebFinger for acct:${username}@${acctDomain}`);
      const wfResult = await ctx.lookupWebFinger(`acct:${username}@${acctDomain}`);
      console.log(`[lookup] WebFinger result:`, wfResult ? 'found' : 'null');
      const selfLink = wfResult?.links?.find(
        (link) =>
          link.rel === 'self' &&
          (link.type === 'application/activity+json' ||
            link.type === 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"') &&
          link.href,
      );
      console.log(`[lookup] selfLink:`, selfLink?.href || 'not found');
      if (selfLink?.href) {
        console.log(`[lookup] Looking up actor object: ${selfLink.href}`);
        // /api/v1/accounts/lookup is an unauthenticated public endpoint;
        // sign with the oldest local account (no per-request user available).
        const signerUsername = await pickSignerUsername(env.DB, null);
        if (!signerUsername) {
          console.warn('[lookup] No local signer available, skipping remote fetch');
          return c.json({ error: 'No local signer available' }, 503);
        }
        const docLoader = await ctx.getDocumentLoader({ identifier: signerUsername });
        const actorObject = await ctx.lookupObject(selfLink.href, { documentLoader: docLoader });
        console.log(`[lookup] lookupObject result:`, actorObject ? `${actorObject.constructor.name} id=${actorObject.id}` : 'null');
        if (actorObject && isActor(actorObject) && actorObject.id) {
          // Upsert into accounts
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          const preferredUsername = actorObject.preferredUsername || username;
          const iconObj = await actorObject.getIcon({ documentLoader: docLoader });
          const imageObj = await actorObject.getImage({ documentLoader: docLoader });
          const iconUrl = iconObj?.url instanceof URL ? iconObj.url.href : '';
          const imageUrl = imageObj?.url instanceof URL ? imageObj.url.href : '';
          const actorUrl = actorObject.url instanceof URL ? actorObject.url.href : `https://${acctDomain}/@${preferredUsername}`;
          const inboxUrl = actorObject.inboxId?.href || '';
          const endpointsObj = actorObject.endpoints;
          const sharedInboxUrl = endpointsObj?.sharedInbox?.href || '';
          await env.DB.prepare(
            `INSERT OR IGNORE INTO accounts (id, username, domain, display_name, note, uri, url,
             avatar_url, header_url, locked, bot, discoverable, inbox_url, shared_inbox_url,
             followers_count, following_count, statuses_count, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?18)`,
          ).bind(
            id, preferredUsername, acctDomain,
            sanitizeHtml(actorObject.name?.toString() || ''),
            sanitizeHtml(actorObject.summary?.toString() || ''),
            actorObject.id.href,
            actorUrl,
            iconUrl, imageUrl,
            actorObject.manuallyApprovesFollowers ? 1 : 0,
            actorObject.constructor.name === 'Service' ? 1 : 0,
            actorObject.discoverable ? 1 : 0,
            inboxUrl, sharedInboxUrl,
            0, 0, 0, now,
          ).run();

          row = await env.DB.prepare(
            'SELECT * FROM accounts WHERE username = ?1 AND domain = ?2',
          ).bind(preferredUsername, acctDomain).first();
        }
      }
    } catch (e) {
      console.error(`[lookup] WebFinger resolve failed for ${username}@${acctDomain}:`, e);
    }
  }

  if (!row) throw new AppError(404, 'Record not found');
  const domain = row.domain as string | null;

  const emojis = parseCustomEmojiTagsJson(row.emoji_tags as string | null, instanceDomain);
  const displayName = sanitizeHtml((row.display_name as string) || '');
  const note = sanitizeHtml((row.note as string) || '');

  return c.json({
    id: row.id as string,
    username: row.username as string,
    acct: domain ? `${row.username}@${domain}` : (row.username as string),
    display_name: displayName,
    locked: !!(row.locked),
    bot: !!(row.bot),
    discoverable: !!(row.discoverable),
    group: false,
    created_at: row.created_at as string,
    note,
    url: (row.url as string) || `https://${instanceDomain}/@${row.username}`,
    uri: row.uri as string,
    avatar: (row.avatar_url as string) || `https://${instanceDomain}/default-avatar.svg`,
    avatar_static: (row.avatar_static_url as string) || `https://${instanceDomain}/default-avatar.svg`,
    header: (row.header_url as string) || `https://${instanceDomain}/default-header.svg`,
    header_static: (row.header_static_url as string) || `https://${instanceDomain}/default-header.svg`,
    followers_count: (row.followers_count as number) || 0,
    following_count: (row.following_count as number) || 0,
    statuses_count: (row.statuses_count as number) || 0,
    last_status_at: (row.last_status_at as string) || null,
    emojis,
    fields: safeJsonParse(row.fields as string | null, []),
  });
});

export default app;
