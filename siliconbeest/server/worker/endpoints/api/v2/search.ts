import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../types';
import { authOptional } from '../../../middleware/auth';
import { serializeAccount, serializeStatus, serializeTag } from '../../../utils/mastodonSerializer';
import { enrichStatuses } from '../../../utils/statusEnrichment';
import { generateUlid } from '../../../utils/ulid';
import { getFedifyContext } from '../../../federation/helpers/send';
import { isActor, Note, Question } from '@fedify/fedify/vocab';
import { pickSignerUsername } from '../../../../../../packages/shared/services/signer';
import { processCreate } from '../../../federation/inboxProcessors/create';
import { resolveRemoteAccount } from '../../../federation/resolveRemoteAccount';
import type { AccountRow, StatusRow, TagRow } from '../../../types/db';
import type { APActivity, APObject } from '../../../types/activitypub';

const app = new Hono<{ Variables: AppVariables }>();

type SearchViewer = {
  id: string;
  username: string;
  uri: string;
} | null;

const STATUS_SEARCH_SELECT = `
  SELECT s.*, a.id AS a_id, a.username AS a_username, a.domain AS a_domain,
         a.display_name AS a_display_name, a.note AS a_note, a.uri AS a_uri,
         a.url AS a_url, a.avatar_url AS a_avatar_url, a.avatar_static_url AS a_avatar_static_url,
         a.header_url AS a_header_url, a.header_static_url AS a_header_static_url,
         a.locked AS a_locked, a.bot AS a_bot, a.discoverable AS a_discoverable,
         a.statuses_count AS a_statuses_count, a.followers_count AS a_followers_count,
         a.following_count AS a_following_count, a.last_status_at AS a_last_status_at,
         a.created_at AS a_created_at, a.suspended_at AS a_suspended_at,
         a.memorial AS a_memorial, a.moved_to_account_id AS a_moved_to_account_id,
         a.emoji_tags AS a_emoji_tags
  FROM statuses s
  JOIN accounts a ON a.id = s.account_id
`;

function isUrlQuery(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function idsFrom(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (value instanceof URL) return [value.href];
  if (Array.isArray(value)) return value.flatMap(idsFrom);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return idsFrom(obj.id).concat(idsFrom(obj['@id'])).concat(idsFrom(obj.href));
  }
  return [];
}

function normalizeApObject(jsonLd: unknown, fallbackId: string, fallbackType: 'Note' | 'Question'): APObject {
  const obj = { ...(jsonLd as Record<string, unknown>) };
  if (typeof obj.id !== 'string') {
    obj.id = typeof obj['@id'] === 'string' ? obj['@id'] : fallbackId;
  }
  if (typeof obj.type !== 'string') {
    const typeId = typeof obj['@type'] === 'string' ? obj['@type'] : '';
    obj.type = typeId.endsWith('#Question') || typeId.endsWith('/Question') ? 'Question' : fallbackType;
  }
  return obj as APObject;
}

function isPublicCollection(value: string): boolean {
  return value === 'https://www.w3.org/ns/activitystreams#Public'
    || value === 'as:Public'
    || value === 'Public';
}

function resolveVisibilityFromObject(object: APObject): string {
  const to = idsFrom((object as Record<string, unknown>).to);
  const cc = idsFrom((object as Record<string, unknown>).cc);
  if (to.some(isPublicCollection)) return 'public';
  if (cc.some(isPublicCollection)) return 'unlisted';
  if (to.some((target) => target.endsWith('/followers'))) return 'private';
  return 'direct';
}

function tagMentionsActor(tag: unknown, actorUri: string): boolean {
  const tags = Array.isArray(tag) ? tag : tag ? [tag] : [];
  return tags.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const tag = item as Record<string, unknown>;
    if (tag.type !== 'Mention') return false;
    return idsFrom(tag.href).concat(idsFrom(tag.id)).includes(actorUri);
  });
}

async function followsAccount(viewerAccountId: string, targetAccountId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 FROM follows WHERE account_id = ?1 AND target_account_id = ?2 LIMIT 1',
  ).bind(viewerAccountId, targetAccountId).first();
  return !!row;
}

async function canViewStoredStatus(statusId: string, viewerAccountId: string | null): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT account_id, visibility FROM statuses WHERE id = ?1 AND deleted_at IS NULL LIMIT 1',
  ).bind(statusId).first<{ account_id: string; visibility: string }>();
  if (!row) return false;
  if (row.visibility === 'public' || row.visibility === 'unlisted') return true;
  if (!viewerAccountId) return false;
  if (row.account_id === viewerAccountId) return true;
  if (row.visibility === 'private') {
    return followsAccount(viewerAccountId, row.account_id);
  }
  if (row.visibility === 'direct') {
    const mention = await env.DB.prepare(
      'SELECT 1 FROM mentions WHERE status_id = ?1 AND account_id = ?2 LIMIT 1',
    ).bind(statusId, viewerAccountId).first();
    return !!mention;
  }
  return false;
}

async function canViewRemoteObject(
  object: APObject,
  visibility: string,
  actorUri: string,
  actorAccountId: string,
  viewer: SearchViewer,
): Promise<boolean> {
  if (visibility === 'public' || visibility === 'unlisted') return true;
  if (!viewer) return false;
  if (actorUri === viewer.uri) return true;

  const obj = object as Record<string, unknown>;
  const audience = [
    ...idsFrom(obj.to),
    ...idsFrom(obj.cc),
    ...idsFrom(obj.bto),
    ...idsFrom(obj.bcc),
    ...idsFrom(obj.audience),
  ];
  if (audience.includes(viewer.uri) || tagMentionsActor(obj.tag, viewer.uri)) {
    return true;
  }
  if (visibility === 'private') {
    return followsAccount(viewer.id, actorAccountId);
  }
  return false;
}

async function findStatusByUriOrUrl(uriOrUrl: string): Promise<{ id: string; visibility: string } | null> {
  const row = await env.DB.prepare(
    `SELECT id, visibility FROM statuses
     WHERE (uri = ?1 OR url = ?1)
       AND deleted_at IS NULL
     LIMIT 1`,
  ).bind(uriOrUrl).first<{ id: string; visibility: string }>();
  return row ?? null;
}

async function fetchJoinedStatusById(statusId: string): Promise<Record<string, unknown> | null> {
  return await env.DB.prepare(
    `${STATUS_SEARCH_SELECT}
     WHERE s.id = ?1
       AND s.deleted_at IS NULL
     LIMIT 1`,
  ).bind(statusId).first<Record<string, unknown>>();
}

async function resolveRemoteStatusFromUrl(
  url: string,
  fed: NonNullable<AppVariables['federation']>,
  viewer: SearchViewer,
): Promise<string | null> {
  const normalizedUrl = new URL(url).href;
  const existing = await findStatusByUriOrUrl(normalizedUrl);
  const isLocalUrl = new URL(normalizedUrl).host === env.INSTANCE_DOMAIN;
  if (existing) {
    const visible = await canViewStoredStatus(existing.id, viewer?.id ?? null);
    if (visible) return existing.id;
    if (isLocalUrl) return null;
  }
  if (isLocalUrl) return null;

  const ctx = getFedifyContext(fed);
  const signerUsername = await pickSignerUsername(env.DB, viewer?.id ?? null);
  if (!signerUsername) {
    console.warn('[search] No local signer available, skipping remote status fetch');
    return null;
  }

  const docLoader = await ctx.getDocumentLoader({ identifier: signerUsername });
  let remoteObject: unknown;
  try {
    remoteObject = await ctx.lookupObject(normalizedUrl, { documentLoader: docLoader });
  } catch (e) {
    console.warn('[search] remote status lookupObject failed:', e);
    return null;
  }

  const isStatusObject = remoteObject instanceof Note || remoteObject instanceof Question
    || (remoteObject && typeof remoteObject === 'object' && ['Note', 'Question'].includes((remoteObject as { constructor?: { name?: string } }).constructor?.name ?? ''));
  if (!isStatusObject) return null;

  const statusObject = remoteObject as Note | Question;
  const objectId = statusObject.id?.href;
  if (!objectId) return null;

  const fallbackType = remoteObject instanceof Question || (remoteObject as { constructor?: { name?: string } }).constructor?.name === 'Question'
    ? 'Question'
    : 'Note';
  const jsonLd = await statusObject.toJsonLd({ contextLoader: docLoader });
  const object = normalizeApObject(jsonLd, objectId, fallbackType);
  const actor = statusObject.attributionId?.href ?? idsFrom((object as Record<string, unknown>).attributedTo)[0];
  if (!actor) {
    console.warn(`[search] remote status has no attributedTo: ${objectId}`);
    return null;
  }
  const actorAccountId = await resolveRemoteAccount(actor, viewer?.id ?? null);
  if (!actorAccountId) return null;
  const visibility = resolveVisibilityFromObject(object);
  const remoteVisible = await canViewRemoteObject(object, visibility, actor, actorAccountId, viewer);

  const existingByObjectId = await findStatusByUriOrUrl(objectId);
  const existingStatus = existingByObjectId ?? existing;
  if (existingStatus) {
    if (!remoteVisible) return null;
    if (visibility !== existingStatus.visibility) {
      await env.DB.prepare(
        'UPDATE statuses SET visibility = ?1, updated_at = ?2 WHERE id = ?3',
      ).bind(visibility, new Date().toISOString(), existingStatus.id).run();
    }
    return await canViewStoredStatus(existingStatus.id, viewer?.id ?? null) ? existingStatus.id : null;
  }

  if (!remoteVisible) return null;

  const activity: APActivity = {
    type: 'Create',
    id: `${objectId}#search-fetch`,
    actor,
    object,
  };

  await processCreate(activity, viewer?.id ?? null, { fanout: false, notify: false });
  const stored = await findStatusByUriOrUrl(objectId);
  if (!stored || !await canViewStoredStatus(stored.id, viewer?.id ?? null)) return null;
  return stored.id;
}

app.get('/', authOptional, async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) {
    return c.json({ accounts: [], statuses: [], hashtags: [] });
  }

  const type = c.req.query('type');
  const resolve = c.req.query('resolve') === 'true';
  const limitRaw = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Math.min(Math.max(limitRaw, 1), 40);
  const offsetRaw = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Math.max(offsetRaw, 0);
  const domain = env.INSTANCE_DOMAIN;

  let accounts: any[] = [];
  let statuses: any[] = [];
  let hashtags: any[] = [];

  // Strip leading @ for account username search (DB stores "admin" not "@admin")
  const normalizedQ = q.replace(/^@/, '');
  const searchTerm = `%${normalizedQ}%`;

  // Search accounts
  if (!type || type === 'accounts') {
    const { results } = await env.DB.prepare(`
      SELECT * FROM accounts
      WHERE (username LIKE ?1 OR display_name LIKE ?1)
        AND suspended_at IS NULL
      ORDER BY followers_count DESC
      LIMIT ?2 OFFSET ?3
    `).bind(searchTerm, limit, offset).all();

    accounts = (results ?? []).map((row: any) => {
      return serializeAccount(row as AccountRow, { instanceDomain: env.INSTANCE_DOMAIN });
    });

    // WebFinger resolution: if resolve=true and query looks like user@domain
    const looksLikeAcct = /^@?[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q);
    console.log(`[search] resolve=${resolve}, looksLikeAcct=${looksLikeAcct}, q="${q}"`);
    if (resolve && looksLikeAcct) {
      const fed = c.get('federation');
      const ctx = getFedifyContext(fed);
      // Normalize acct for WebFinger lookup: the domain part is case-insensitive
      // (RFC 7565 lowercases the acct host) — strict remotes match the resource
      // case-sensitively. Username casing is preserved. Split on the LAST '@'
      // to match Fedify's own server extraction.
      const cleanedQ = q.replace(/^@/, '');
      const atPos = cleanedQ.lastIndexOf('@');
      const normalizedAcct = atPos === -1
        ? cleanedQ
        : `${cleanedQ.slice(0, atPos)}@${cleanedQ.slice(atPos + 1).toLowerCase()}`;
      const wfResult = await ctx.lookupWebFinger(`acct:${normalizedAcct}`);
      // Extract actor URI from self link
      const selfLink = wfResult?.links?.find(
        (link) =>
          link.rel === 'self' &&
          (link.type === 'application/activity+json' ||
            link.type === 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"') &&
          link.href,
      );
      const actorUri = selfLink?.href;
      // Extract profile URL
      const profileLink = wfResult?.links?.find(
        (link) =>
          link.rel === 'http://webfinger.net/rel/profile-page' &&
          link.type === 'text/html' &&
          link.href,
      );
      const profileUrl = profileLink?.href;
      console.log(`[search] WebFinger result:`, actorUri || 'null');
      if (actorUri) {
        // Check if we already have this actor in the DB
        const existingActor = await env.DB.prepare(
          'SELECT * FROM accounts WHERE uri = ?1',
        ).bind(actorUri).first<AccountRow>();

        if (existingActor) {
          // Include existing actor in results if not already present
          const existingId = existingActor.id;
          if (!accounts.some((a: any) => a.id === existingId)) {
            accounts.unshift(serializeAccount(existingActor, { instanceDomain: env.INSTANCE_DOMAIN }));
          }
        } else {
          // Fetch remote actor via Fedify lookupObject.
          // Sign with the authenticated user's key when available, falling
          // back to the oldest local account otherwise.
          let actorObject: any = null;
          let docLoader: Awaited<ReturnType<typeof ctx.getDocumentLoader>> | null = null;
          const signerUsername = await pickSignerUsername(
            env.DB,
            c.get('currentAccount')?.id ?? null,
          );
          if (signerUsername) {
            docLoader = await ctx.getDocumentLoader({ identifier: signerUsername });
            try {
              actorObject = await ctx.lookupObject(actorUri, { documentLoader: docLoader });
            } catch (fetchErr) {
              console.error('[search] lookupObject error:', fetchErr);
            }
          } else {
            console.warn('[search] No local signer available, skipping remote fetch');
          }
          console.log('[search] actorObject:', actorObject ? `id=${actorObject.id?.href}, isActor=${isActor(actorObject)}` : 'null');
          if (actorObject && isActor(actorObject) && actorObject.id) {
            const id = generateUlid();
            const now = new Date().toISOString();
            const username = actorObject.preferredUsername || actorObject.name?.toString() || '';
            const actorDomain = actorObject.id.hostname;
            const iconObj = docLoader
              ? await actorObject.getIcon({ documentLoader: docLoader })
              : await actorObject.getIcon();
            const imageObj = docLoader
              ? await actorObject.getImage({ documentLoader: docLoader })
              : await actorObject.getImage();
            const iconUrl = iconObj?.url instanceof URL ? iconObj.url.href : '';
            const imageUrl = imageObj?.url instanceof URL ? imageObj.url.href : '';
            const actorUrl = actorObject.url instanceof URL ? actorObject.url.href : actorObject.id.href;

            const inboxUrl = actorObject.inboxId?.href || '';
            const endpointsObj = actorObject.endpoints;
            const sharedInboxUrl = endpointsObj?.sharedInbox?.href || '';

            await env.DB.prepare(
              `INSERT OR IGNORE INTO accounts
                (id, username, domain, display_name, note, uri, url,
                 avatar_url, avatar_static_url, header_url, header_static_url,
                 locked, bot, discoverable, inbox_url, shared_inbox_url,
                 statuses_count, followers_count, following_count,
                 created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, 0, 0, ?17, ?18)`,
            ).bind(
              id,
              username,
              actorDomain,
              actorObject.name?.toString() || username,
              actorObject.summary?.toString() || '',
              actorObject.id.href,
              profileUrl || actorUrl,
              iconUrl,
              iconUrl,
              imageUrl,
              imageUrl,
              actorObject.manuallyApprovesFollowers ? 1 : 0,
              actorObject.constructor.name === 'Service' ? 1 : 0,
              actorObject.discoverable !== false ? 1 : 0,
              inboxUrl,
              sharedInboxUrl,
              now,
              now,
            ).run();

            // Fetch the inserted/existing account
            const insertedAccount = await env.DB.prepare(
              'SELECT * FROM accounts WHERE uri = ?1',
            ).bind(actorObject.id.href).first<AccountRow>();

            if (insertedAccount) {
              accounts.unshift(serializeAccount(insertedAccount, { instanceDomain: env.INSTANCE_DOMAIN }));
            }
          }
        }
      }
    }
  }

  // Search statuses
  if (!type || type === 'statuses') {
    const urlQuery = isUrlQuery(q);
    const { results } = urlQuery
      ? { results: [] }
      : await env.DB.prepare(`
        ${STATUS_SEARCH_SELECT}
        WHERE s.content LIKE ?1
          AND s.visibility = 'public'
          AND s.deleted_at IS NULL
        ORDER BY s.id DESC
        LIMIT ?2 OFFSET ?3
      `).bind(searchTerm, limit, offset).all();

    const currentAccount = c.get('currentAccount');
    const viewer: SearchViewer = currentAccount
      ? {
          id: currentAccount.id,
          username: currentAccount.username,
          uri: `https://${domain}/users/${currentAccount.username}`,
        }
      : null;
    const statusRows: Record<string, unknown>[] = [...((results ?? []) as Record<string, unknown>[])];
    if (resolve && urlQuery) {
      const resolvedStatusId = await resolveRemoteStatusFromUrl(
        q,
        c.get('federation'),
        viewer,
      );
      if (resolvedStatusId && !statusRows.some((row) => row.id === resolvedStatusId)) {
        const resolvedRow = await fetchJoinedStatusById(resolvedStatusId);
        if (resolvedRow) statusRows.unshift(resolvedRow);
      }
    }

    const statusIds = statusRows.map((r) => r.id as string);
    const enrichments = await enrichStatuses(
      domain,
      statusIds,
      currentAccount?.id ?? null,
      env.CACHE,
    );

    statuses = statusRows.map((row: any) => {
      const accountRow: AccountRow = {
        id: row.a_id, username: row.a_username, domain: row.a_domain,
        display_name: row.a_display_name, note: row.a_note, uri: row.a_uri,
        url: row.a_url, avatar_url: row.a_avatar_url, avatar_static_url: row.a_avatar_static_url,
        header_url: row.a_header_url, header_static_url: row.a_header_static_url,
        locked: row.a_locked, bot: row.a_bot, discoverable: row.a_discoverable,
        manually_approves_followers: 0, statuses_count: row.a_statuses_count,
        followers_count: row.a_followers_count, following_count: row.a_following_count,
        last_status_at: row.a_last_status_at, created_at: row.a_created_at,
        updated_at: row.a_created_at, suspended_at: row.a_suspended_at,
        silenced_at: null, memorial: row.a_memorial, moved_to_account_id: row.a_moved_to_account_id,
        emoji_tags: row.a_emoji_tags || null,
      };
      const e = enrichments.get(row.id);
      return serializeStatus(row as StatusRow, {
        account: serializeAccount(accountRow, { instanceDomain: env.INSTANCE_DOMAIN }),
        mediaAttachments: e?.mediaAttachments,
        mentions: e?.mentions,
        favourited: e?.favourited,
        reblogged: e?.reblogged,
        bookmarked: e?.bookmarked,
        card: e?.card, poll: e?.poll,
        emojis: e?.emojis,
        quotePolicyAllows: e?.quotePolicyAllows,
        quotePolicyReason: e?.quotePolicyReason,
      });
    });
  }

  // Search hashtags
  if (!type || type === 'hashtags') {
    const { results } = await env.DB.prepare(`
      SELECT * FROM tags
      WHERE name LIKE ?1
      ORDER BY name ASC
      LIMIT ?2 OFFSET ?3
    `).bind(searchTerm, limit, offset).all();

    hashtags = (results ?? []).map((row: any) => {
      const tag = serializeTag(row as TagRow);
      tag.url = `https://${domain}/tags/${tag.name}`;
      return tag;
    });
  }

  return c.json({ accounts, statuses, hashtags });
});

export default app;
