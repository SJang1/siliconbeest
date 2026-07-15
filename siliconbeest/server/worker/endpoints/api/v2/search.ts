import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../types';
import { authOptional } from '../../../middleware/auth';
import { serializeAccount, serializeStatus, serializeTag } from '../../../utils/mastodonSerializer';
import { enrichStatuses } from '../../../utils/statusEnrichment';
import {
  buildAccountSearchSqlPredicate,
  buildReblogOriginalSurfaceSqlPredicate,
  buildStatusRelationshipSqlPredicate,
  buildStatusVisibilitySqlPredicate,
  canResolveRemoteDomain,
  canViewStatusById,
} from '../../../services/permissions';
import { generateUlid } from '../../../utils/ulid';
import { getFedifyContext } from '../../../federation/helpers/send';
import { isActor, Note, Question } from '@fedify/fedify/vocab';
import { pickSignerUsername } from '../../../../../../packages/shared/services/signer';
import { processCreate } from '../../../federation/inboxProcessors/create';
import { resolveRemoteAccount } from '../../../federation/resolveRemoteAccount';
import type { AccountRow, StatusRow, TagRow } from '../../../types/db';
import type { APActivity, APObject } from '../../../types/activitypub';
import { parseQuotePolicyDetailsFromInteractionPolicy } from '../../../../../../packages/shared/utils/quotePolicy';
import {
  canStoreFetchedRemoteActor,
  canStoreFetchedRemoteStatus,
  hasOAuthScope,
} from '../../../../../../packages/shared/permissions';

const app = new Hono<{ Variables: AppVariables }>();

type SearchViewer = {
  id: string;
  username: string;
  uri: string;
} | null;

type SerializedAccount = ReturnType<typeof serializeAccount>;
type SerializedStatus = ReturnType<typeof serializeStatus>;
type SerializedTag = ReturnType<typeof serializeTag>;

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

async function findStatusByUriOrUrl(uriOrUrl: string): Promise<{
  id: string;
  visibility: string;
  quote_policy: string | null;
  quote_policy_automatic_approvals: string | null;
  quote_policy_manual_approvals: string | null;
} | null> {
  const row = await env.DB.prepare(
    `SELECT id, visibility, quote_policy, quote_policy_automatic_approvals, quote_policy_manual_approvals FROM statuses
     WHERE (uri = ?1 OR url = ?1)
       AND deleted_at IS NULL
     LIMIT 1`,
  ).bind(uriOrUrl).first<{
    id: string;
    visibility: string;
    quote_policy: string | null;
    quote_policy_automatic_approvals: string | null;
    quote_policy_manual_approvals: string | null;
  }>();
  return row ?? null;
}

async function fetchJoinedStatusById(
  statusId: string,
  viewerAccountId: string | null,
): Promise<Record<string, unknown> | null> {
  const now = new Date().toISOString();
  const visibility = buildStatusVisibilitySqlPredicate('status', viewerAccountId);
  const relationship = buildStatusRelationshipSqlPredicate(
    'status',
    viewerAccountId,
    now,
  );
  const reblogOriginal = buildReblogOriginalSurfaceSqlPredicate(
    viewerAccountId,
    now,
  );
  return await env.DB.prepare(
    `${STATUS_SEARCH_SELECT}
     WHERE s.id = ?
       AND ${visibility.sql}
       AND ${relationship.sql}
       AND ${reblogOriginal.sql}
     LIMIT 1`,
  ).bind(
    statusId,
    ...visibility.bindings,
    ...relationship.bindings,
    ...reblogOriginal.bindings,
  ).first<Record<string, unknown>>();
}

async function resolveRemoteStatusFromUrl(
  url: string,
  fed: NonNullable<AppVariables['federation']>,
  viewer: SearchViewer,
): Promise<string | null> {
  const normalizedUrl = new URL(url).href;
  const existing = await findStatusByUriOrUrl(normalizedUrl);
  const isLocalUrl = new URL(normalizedUrl).host === env.INSTANCE_DOMAIN;
  const existingVisible = existing ? await canViewStatusById(existing.id, viewer?.id ?? null) : false;
  const existingSurfaceable = existingVisible && existing
    ? await fetchJoinedStatusById(existing.id, viewer?.id ?? null) !== null
    : false;
  if (existing) {
    if (isLocalUrl) return existingSurfaceable ? existing.id : null;
    if (existingVisible && !existingSurfaceable) return null;
  }
  if (isLocalUrl) return null;
  if (!await canResolveRemoteDomain(viewer?.id ?? null, new URL(normalizedUrl).hostname)) {
    return null;
  }

  const ctx = getFedifyContext(fed);
  const signerUsername = await pickSignerUsername(env.DB, viewer?.id ?? null);
  if (!signerUsername) {
    console.warn('[search] No local signer available, skipping remote status fetch');
    return existingVisible ? existing?.id ?? null : null;
  }

  const docLoader = await ctx.getDocumentLoader({ identifier: signerUsername });
  let remoteObject: unknown;
  try {
    remoteObject = await ctx.lookupObject(normalizedUrl, { documentLoader: docLoader });
  } catch (e) {
    console.warn('[search] remote status lookupObject failed:', e);
    return existingVisible ? existing?.id ?? null : null;
  }

  const isStatusObject = remoteObject instanceof Note || remoteObject instanceof Question
    || (remoteObject && typeof remoteObject === 'object' && ['Note', 'Question'].includes((remoteObject as { constructor?: { name?: string } }).constructor?.name ?? ''));
  if (!isStatusObject) return existingVisible ? existing?.id ?? null : null;

  const statusObject = remoteObject as Note | Question;
  const objectId = statusObject.id?.href;
  if (!objectId) return existingVisible ? existing?.id ?? null : null;

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
  if (!canStoreFetchedRemoteStatus({
    requestedStatusUri: normalizedUrl,
    statusUri: objectId,
    authorUri: actor,
    localInstanceDomain: env.INSTANCE_DOMAIN,
    authorSuspended: false,
  })) {
    console.warn(`[search] remote status identity or attribution mismatch: ${normalizedUrl}`);
    return null;
  }
  const actorAccountId = await resolveRemoteAccount(actor, viewer?.id ?? null);
  if (!actorAccountId) return null;
  const actorState = await env.DB.prepare(
    'SELECT suspended_at FROM accounts WHERE id = ? LIMIT 1',
  ).bind(actorAccountId).first<{ suspended_at: string | null }>();
  if (!actorState || !canStoreFetchedRemoteStatus({
    requestedStatusUri: normalizedUrl,
    statusUri: objectId,
    authorUri: actor,
    localInstanceDomain: env.INSTANCE_DOMAIN,
    authorSuspended: actorState.suspended_at !== null,
  })) {
    return null;
  }
  const visibility = resolveVisibilityFromObject(object);
  const remoteVisible = await canViewRemoteObject(object, visibility, actor, actorAccountId, viewer);
  const interactionPolicy = (object as Record<string, unknown>).interactionPolicy;
  const quotePolicyDetails = parseQuotePolicyDetailsFromInteractionPolicy(
    interactionPolicy,
    actor,
    `${actor}/followers`,
  );
  const quotePolicy = quotePolicyDetails.policy;
  const automaticApprovalsJson = interactionPolicy !== undefined
    ? JSON.stringify(quotePolicyDetails.automaticApprovals)
    : null;
  const manualApprovalsJson = interactionPolicy !== undefined
    ? JSON.stringify(quotePolicyDetails.manualApprovals)
    : null;

  const existingByObjectId = await findStatusByUriOrUrl(objectId);
  const existingStatus = existingByObjectId ?? existing;
  if (existingStatus) {
    if (!remoteVisible) return null;
    if (
      visibility !== existingStatus.visibility
      || quotePolicy !== existingStatus.quote_policy
      || automaticApprovalsJson !== existingStatus.quote_policy_automatic_approvals
      || manualApprovalsJson !== existingStatus.quote_policy_manual_approvals
    ) {
      await env.DB.prepare(
        `UPDATE statuses
         SET visibility = ?1,
             quote_policy = ?2,
             quote_policy_automatic_approvals = ?3,
             quote_policy_manual_approvals = ?4,
             updated_at = ?5
         WHERE id = ?6`,
      ).bind(visibility, quotePolicy, automaticApprovalsJson, manualApprovalsJson, new Date().toISOString(), existingStatus.id).run();
    }
    return await canViewStatusById(existingStatus.id, viewer?.id ?? null) ? existingStatus.id : null;
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
  if (!stored || !await canViewStatusById(stored.id, viewer?.id ?? null)) return null;
  return stored.id;
}

app.get('/', authOptional, async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) {
    return c.json({ accounts: [], statuses: [], hashtags: [] });
  }

  const type = c.req.query('type');
  const resolve = c.req.query('resolve') === 'true';
  const urlQuery = isUrlQuery(q);
  const offsetRequested = c.req.query('offset') !== undefined;
  const limitRaw = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Math.min(Math.max(limitRaw, 1), 40);
  const offsetRaw = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Math.max(offsetRaw, 0);
  const domain = env.INSTANCE_DOMAIN;
  const currentAccount = c.get('currentAccount');

  // Mastodon permits anonymous account/hashtag search and locally-known
  // exact-URL status lookup. Network resolution, offset pagination, and
  // status full-text search require an authorized user with read:search.
  const authenticatedMode = resolve
    || offsetRequested
    || (type === 'statuses' && !urlQuery);
  if (authenticatedMode && !currentAccount) {
    return c.json({ error: 'The access token is invalid' }, 401);
  }
  if (
    authenticatedMode
    && !hasOAuthScope(c.get('tokenScopes'), 'read:search')
  ) {
    return c.json({
      error: 'This action is outside the authorized scopes',
      required_scope: 'read:search',
    }, 403);
  }

  let accounts: SerializedAccount[] = [];
  let statuses: SerializedStatus[] = [];
  let hashtags: SerializedTag[] = [];

  // Strip leading @ for account username search (DB stores "admin" not "@admin")
  const normalizedQ = q.replace(/^@/, '');
  const searchTerm = `%${normalizedQ}%`;

  // Search accounts
  if (!type || type === 'accounts') {
    const accountPermission = buildAccountSearchSqlPredicate(
      'account',
      currentAccount?.id ?? null,
      new Date().toISOString(),
    );
    const { results } = await env.DB.prepare(`
      SELECT a.* FROM accounts a
      WHERE (a.username LIKE ? OR a.display_name LIKE ?)
        AND ${accountPermission.sql}
      ORDER BY a.followers_count DESC
      LIMIT ? OFFSET ?
    `).bind(
      searchTerm,
      searchTerm,
      ...accountPermission.bindings,
      limit,
      offset,
    ).all<AccountRow>();

    accounts = (results ?? []).map((row) => {
      return serializeAccount(row, { instanceDomain: env.INSTANCE_DOMAIN });
    });

    // WebFinger resolution: if resolve=true and query looks like user@domain
    const looksLikeAcct = /^@?[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q);
    const cleanedAcctQuery = q.replace(/^@/, '');
    const acctAtPosition = cleanedAcctQuery.lastIndexOf('@');
    const requestedAcctDomain = acctAtPosition === -1
      ? null
      : cleanedAcctQuery.slice(acctAtPosition + 1).toLowerCase();
    const canResolveRequestedAcctDomain = resolve && looksLikeAcct
      ? await canResolveRemoteDomain(currentAccount?.id ?? null, requestedAcctDomain)
      : false;
    console.log(`[search] resolve=${resolve}, looksLikeAcct=${looksLikeAcct}, q="${q}"`);
    if (resolve && looksLikeAcct && canResolveRequestedAcctDomain) {
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
      if (
        actorUri
        && canStoreFetchedRemoteActor({
          requestedActorUri: actorUri,
          actorUri,
          localInstanceDomain: env.INSTANCE_DOMAIN,
          actorSuspended: false,
        })
        && await canResolveRemoteDomain(
          currentAccount?.id ?? null,
          new URL(actorUri).hostname,
        )
      ) {
        // Check if we already have this actor in the DB
        const existingActor = await env.DB.prepare(
          'SELECT * FROM accounts WHERE uri = ?1 LIMIT 1',
        ).bind(actorUri).first<AccountRow>();

        if (existingActor) {
          const surfaceableActor = await env.DB.prepare(
            `SELECT a.id FROM accounts a
             WHERE a.id = ?
               AND ${accountPermission.sql}
             LIMIT 1`,
          ).bind(
            existingActor.id,
            ...accountPermission.bindings,
          ).first<{ id: string }>();
          // Existing but suppressed actors stay local-only: do not refetch
          // them from the remote server and do not surface them in results.
          if (surfaceableActor && !accounts.some((account) => account.id === existingActor.id)) {
            accounts.unshift(serializeAccount(existingActor, { instanceDomain: env.INSTANCE_DOMAIN }));
          }
        } else {
          // Fetch remote actor via Fedify lookupObject.
          // Sign with the authenticated user's key when available, falling
          // back to the oldest local account otherwise.
          let actorObject: Awaited<ReturnType<typeof ctx.lookupObject>> = null;
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
          if (
            actorObject
            && isActor(actorObject)
            && actorObject.id
            && canStoreFetchedRemoteActor({
              requestedActorUri: actorUri,
              actorUri: actorObject.id.href,
              localInstanceDomain: env.INSTANCE_DOMAIN,
              actorSuspended: false,
            })
            && await canResolveRemoteDomain(
              currentAccount?.id ?? null,
              actorObject.id.hostname,
            )
          ) {
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
                 followers_url, following_url, hide_collections,
                 statuses_count, followers_count, following_count,
                 created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 1, 0, 0, 0, ?19, ?19)`,
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
              actorObject.followersId?.href || '',
              actorObject.followingId?.href || '',
              now,
            ).run();

            // A concurrently-created or legacy row may have won the INSERT.
            // Close its graph before the authenticated full fetch determines
            // whether both remote collections actually expose a first page.
            await env.DB.prepare(
              `UPDATE accounts
               SET followers_url = ?, following_url = ?,
                   hide_collections = 1, updated_at = ?
               WHERE uri = ? AND domain IS NOT NULL`,
            ).bind(
              actorObject.followersId?.href || '',
              actorObject.followingId?.href || '',
              now,
              actorObject.id.href,
            ).run();

            await env.QUEUE_FEDERATION.send({
              type: 'fetch_remote_account',
              actorUri: actorObject.id.href,
              ...(currentAccount ? { signerAccountId: currentAccount.id } : {}),
            });

            // Fetch the inserted/existing account
            const insertedAccount = await env.DB.prepare(
              `SELECT a.* FROM accounts a
               WHERE a.uri = ?
                 AND ${accountPermission.sql}
               LIMIT 1`,
            ).bind(
              actorObject.id.href,
              ...accountPermission.bindings,
            ).first<AccountRow>();

            if (insertedAccount) {
              accounts.unshift(serializeAccount(insertedAccount, { instanceDomain: env.INSTANCE_DOMAIN }));
            }
          }
        }
      }
    }
  }

  // Search statuses
  if (type === 'statuses' || (!type && (currentAccount || urlQuery))) {
    const statusRows: Record<string, unknown>[] = [];
    if (urlQuery) {
      const normalizedUrl = new URL(q).href;
      const resolvedStatusId = resolve
        ? await resolveRemoteStatusFromUrl(
            normalizedUrl,
            c.get('federation'),
            currentAccount
              ? {
                  id: currentAccount.id,
                  username: currentAccount.username,
                  uri: `https://${domain}/users/${currentAccount.username}`,
                }
              : null,
          )
        : (await findStatusByUriOrUrl(normalizedUrl))?.id ?? null;

      if (
        resolvedStatusId
        && await canViewStatusById(resolvedStatusId, currentAccount?.id ?? null)
      ) {
        const resolvedRow = await fetchJoinedStatusById(
          resolvedStatusId,
          currentAccount?.id ?? null,
        );
        if (resolvedRow) statusRows.push(resolvedRow);
      }
    } else {
      const permissionNow = new Date().toISOString();
      const visibility = buildStatusVisibilitySqlPredicate(
        'status',
        currentAccount?.id ?? null,
      );
      const relationship = buildStatusRelationshipSqlPredicate(
        'status',
        currentAccount?.id ?? null,
        permissionNow,
      );
      const reblogOriginal = buildReblogOriginalSurfaceSqlPredicate(
        currentAccount?.id ?? null,
        permissionNow,
      );
      const { results } = await env.DB.prepare(`
        ${STATUS_SEARCH_SELECT}
        WHERE s.content LIKE ?
          AND ${visibility.sql}
          AND ${relationship.sql}
          AND ${reblogOriginal.sql}
        ORDER BY s.id DESC
        LIMIT ? OFFSET ?
      `).bind(
        searchTerm,
        ...visibility.bindings,
        ...relationship.bindings,
        ...reblogOriginal.bindings,
        limit,
        offset,
      ).all();
      statusRows.push(...((results ?? []) as Record<string, unknown>[]));
    }

    const reblogRows = new Map<string, Record<string, unknown>>();
    const reblogOfIds = [...new Set(statusRows
      .map((row) => row.reblog_of_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0))];
    for (const reblogOfId of reblogOfIds) {
      const original = await fetchJoinedStatusById(
        reblogOfId,
        currentAccount?.id ?? null,
      );
      if (original && original.reblog_of_id === null) {
        reblogRows.set(reblogOfId, original);
      }
    }
    const safeStatusRows = statusRows.filter((row) => {
      const reblogOfId = row.reblog_of_id;
      return reblogOfId === null
        || (typeof reblogOfId === 'string' && reblogRows.has(reblogOfId));
    });
    const statusIds = [
      ...safeStatusRows.map((row) => row.id as string),
      ...reblogRows.keys(),
    ];
    const enrichments = await enrichStatuses(
      domain,
      statusIds,
      currentAccount?.id ?? null,
      env.CACHE,
    );

    const serializeSearchStatus = (row: Record<string, unknown>) => {
      const accountRow: AccountRow = {
        id: row.a_id as string,
        username: row.a_username as string,
        domain: row.a_domain as string | null,
        display_name: (row.a_display_name as string) || '',
        note: (row.a_note as string) || '',
        uri: row.a_uri as string,
        url: (row.a_url as string) || '',
        avatar_url: (row.a_avatar_url as string) || '',
        avatar_static_url: (row.a_avatar_static_url as string) || '',
        header_url: (row.a_header_url as string) || '',
        header_static_url: (row.a_header_static_url as string) || '',
        locked: (row.a_locked as number) || 0,
        bot: (row.a_bot as number) || 0,
        discoverable: row.a_discoverable as number | null,
        manually_approves_followers: 0,
        statuses_count: (row.a_statuses_count as number) || 0,
        followers_count: (row.a_followers_count as number) || 0,
        following_count: (row.a_following_count as number) || 0,
        last_status_at: row.a_last_status_at as string | null,
        created_at: row.a_created_at as string,
        updated_at: row.a_created_at as string,
        suspended_at: row.a_suspended_at as string | null,
        silenced_at: null,
        memorial: (row.a_memorial as number) || 0,
        moved_to_account_id: row.a_moved_to_account_id as string | null,
        emoji_tags: (row.a_emoji_tags as string) || null,
      };
      const statusId = row.id as string;
      const e = enrichments.get(statusId);
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
    };

    statuses = safeStatusRows.map((row) => {
      const serialized = serializeSearchStatus(row);
      const reblogOfId = row.reblog_of_id;
      if (typeof reblogOfId === 'string') {
        const original = reblogRows.get(reblogOfId);
        if (original) serialized.reblog = serializeSearchStatus(original);
      }
      return serialized;
    });
  }

  // Search hashtags
  if (!type || type === 'hashtags') {
    const { results } = await env.DB.prepare(`
      SELECT * FROM tags
      WHERE name LIKE ?1
      ORDER BY name ASC
      LIMIT ?2 OFFSET ?3
    `).bind(searchTerm, limit, offset).all<TagRow>();

    hashtags = (results ?? []).map((row) => {
      const tag = serializeTag(row);
      tag.url = `https://${domain}/tags/${tag.name}`;
      return tag;
    });
  }

  return c.json({ accounts, statuses, hashtags });
});

export default app;
