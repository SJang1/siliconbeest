/**
 * Fedify Object Dispatchers + Hono activity route handler
 *
 * - Note dispatcher: /users/{identifier}/statuses/{id}
 * - Activity handler (Hono route): /users/{identifier}/statuses/{id}/activity
 *   (Hono because Fedify only allows one type per path, and we need Create + Announce)
 */

import {
  Article,
  Note,
  Question,
  Create,
  Announce,
  Hashtag,
  Mention,
  QuoteAuthorization,
} from '@fedify/vocab';
import type { Federation } from '@fedify/fedify';
import type { FedifyContextData } from '../fedify';
import type { AccountRow, StatusRow, PollRow } from '../../types/db';
import {
  buildFedifyArticle,
  buildFedifyNote,
  buildFedifyQuestion,
  toTemporalInstant,
  AS_PUBLIC,
} from './collections';
import {
  canExposeActivityPubPublicStatusRecord,
  canExposeLocalAccountActivityPubResources,
} from '../../services/permissions';
import { env } from 'cloudflare:workers';

// ============================================================
// SETUP: Register Note object dispatcher on Federation
// ============================================================

export function setupObjectDispatchers(
  federation: Federation<FedifyContextData>,
): void {
  federation.setObjectDispatcher(
    QuoteAuthorization,
    '/users/{identifier}/stamps/{id}',
    async (_ctx, values) => {
      const { identifier, id } = values;

      const row = await env.DB.prepare(
        `SELECT qa.*, a.id AS account_id, a.username,
                a.domain AS account_domain, a.uri AS account_uri
         FROM quote_authorizations qa
         JOIN accounts a ON a.id = qa.attributed_to_account_id
         WHERE qa.id = ?1 AND a.username = ?2 AND a.domain IS NULL AND qa.revoked_at IS NULL
         LIMIT 1`,
      ).bind(id, identifier).first<{
        account_id: string;
        uri: string;
        account_uri: string;
        interacting_object_uri: string;
        interaction_target_uri: string;
      }>();

      if (
        !row
        || !await canExposeLocalAccountActivityPubResources(row.account_id)
      ) return null;

      return new QuoteAuthorization({
        id: new URL(row.uri),
        attribution: new URL(row.account_uri),
        interactingObject: new URL(row.interacting_object_uri),
        interactionTarget: new URL(row.interaction_target_uri),
      });
    },
  );

  federation.setObjectDispatcher(
    Note,
    '/users/{identifier}/statuses/{id}',
    async (ctx, values) => {
      const { identifier, id } = values;
      const domain = env.INSTANCE_DOMAIN;

      const row = await env.DB.prepare(
        `SELECT s.*, a.username, a.domain AS account_domain
         FROM statuses s
         JOIN accounts a ON a.id = s.account_id
         WHERE s.id = ?1
           AND a.username = ?2
           AND a.domain IS NULL
           AND s.visibility IN ('public', 'unlisted')`,
      )
        .bind(id, identifier)
        .first<StatusRow & { username: string; account_domain: string | null }>();

      if (!row) return null;
      const authorAvailable = await canExposeLocalAccountActivityPubResources(
        row.account_id,
      );
      if (!canExposeActivityPubPublicStatusRecord(row, authorAvailable)) return null;
      // Reblogs are Announce activities, not Note objects
      if (row.reblog_of_id) return null;

      const account = await env.DB.prepare(
        'SELECT * FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1',
      )
        .bind(identifier)
        .first<AccountRow>();
      if (!account) return null;

      // Load supporting data
      const { convMap, mediaMap, replyUriMap, quoteUriMap } = await loadStatusContext(row, id, domain);

      // Load mention and hashtag tags (shared by Note and Question)
      const tags: (Mention | Hashtag)[] = [];
      const { results: mentionRows } = await env.DB.prepare(
        `SELECT a.uri AS account_uri, a.username, a.domain
         FROM mentions m JOIN accounts a ON a.id = m.account_id
         WHERE m.status_id = ?1`,
      ).bind(id).all();
      for (const mr of (mentionRows ?? []) as Record<string, unknown>[]) {
        const mentionDomain = mr.domain as string | null;
        tags.push(new Mention({
          href: new URL(mr.account_uri as string),
          name: mentionDomain ? `@${mr.username}@${mentionDomain}` : `@${mr.username}@${domain}`,
        }));
      }
      const { results: tagRows } = await env.DB.prepare(
        'SELECT t.name FROM status_tags st JOIN tags t ON t.id = st.tag_id WHERE st.status_id = ?1',
      ).bind(id).all();
      for (const tr of (tagRows ?? []) as Record<string, unknown>[]) {
        tags.push(new Hashtag({
          href: new URL(`https://${domain}/tags/${tr.name}`),
          name: `#${tr.name}`,
        }));
      }

      // If status has a poll, build a Question instead of a Note
      if (row.poll_id) {
        const poll = await env.DB.prepare(
          'SELECT * FROM polls WHERE id = ?1 LIMIT 1',
        ).bind(row.poll_id).first<PollRow>();
        if (poll) {
          const { question } = buildFedifyQuestion(row as StatusRow, account, poll, domain, {
            convMap, mediaMap, replyUriMap, quoteUriMap,
          });
          return tags.length > 0 ? question.clone({ tags }) : question;
        }
      }

      if (row.object_type === 'Article') {
        const { article } = buildFedifyArticle(row as StatusRow, account, domain, {
          convMap, mediaMap, replyUriMap, quoteUriMap,
        });
        // Fedify associates one vocabulary class with a path. The concrete
        // object remains an Article at runtime and therefore serializes as one.
        return (tags.length > 0 ? article.clone({ tags }) : article) as unknown as Note;
      }

      // Build core Note
      const { note } = buildFedifyNote(row as StatusRow, account, domain, {
        convMap, mediaMap, replyUriMap, quoteUriMap,
      });

      return tags.length > 0 ? note.clone({ tags }) : note;
    },
  );
}

// ============================================================
// HONO HANDLER: /users/:identifier/statuses/:id/activity
// Returns Create(Note) or Announce depending on whether it's a reblog
// ============================================================

export async function handleActivityRequest(
  identifier: string,
  id: string,
): Promise<Response> {
  const domain = env.INSTANCE_DOMAIN;

  const row = await env.DB.prepare(
    `SELECT s.*, a.username, a.domain AS account_domain
     FROM statuses s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.id = ?1
       AND a.username = ?2
       AND a.domain IS NULL
       AND s.visibility IN ('public', 'unlisted')`,
  )
    .bind(id, identifier)
    .first<StatusRow & { username: string; account_domain: string | null }>();

  const authorAvailable = row === null
    ? false
    : await canExposeLocalAccountActivityPubResources(row.account_id);
  if (!row || !canExposeActivityPubPublicStatusRecord(row, authorAvailable)) {
    return new Response(JSON.stringify({ error: 'Record not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/activity+json' },
    });
  }

  const actorUri = `https://${domain}/users/${identifier}`;
  const followersUri = `${actorUri}/followers`;
  const activityUri = row.uri.endsWith('/activity') ? row.uri : `${row.uri}/activity`;

  let activity: Create | Announce;

  if (row.reblog_of_id) {
    // Reblog → Announce
    const reblogRow = await env.DB.prepare(
      'SELECT uri FROM statuses WHERE id = ?1 LIMIT 1',
    ).bind(row.reblog_of_id).first<{ uri: string }>();
    const originalUri = reblogRow?.uri ?? row.reblog_of_id;

    activity = new Announce({
      id: new URL(activityUri),
      actor: new URL(actorUri),
      published: toTemporalInstant(row.created_at),
      tos: [new URL(AS_PUBLIC)],
      ccs: [new URL(followersUri)],
      object: new URL(originalUri),
    });
  } else {
    // Regular post → Create(Note) or Create(Question) for polls
    const account = await env.DB.prepare(
      'SELECT * FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1',
    ).bind(identifier).first<AccountRow>();

    if (!account) {
      return new Response(JSON.stringify({ error: 'Record not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/activity+json' },
      });
    }

    const { convMap, mediaMap, replyUriMap, quoteUriMap } = await loadStatusContext(row, id, domain);

    // Check for poll → build Question instead of Note
    let objectToWrap: Note | Article | Question;
    let tos: URL[];
    let ccs: URL[];

    if (row.poll_id) {
      const poll = await env.DB.prepare(
        'SELECT * FROM polls WHERE id = ?1 LIMIT 1',
      ).bind(row.poll_id).first<PollRow>();
      if (poll) {
        const result = buildFedifyQuestion(row as StatusRow, account, poll, domain, {
          convMap, mediaMap, replyUriMap, quoteUriMap,
        });
        objectToWrap = result.question;
        tos = result.tos;
        ccs = result.ccs;
      } else {
        const result = buildFedifyNote(row as StatusRow, account, domain, {
          convMap, mediaMap, replyUriMap, quoteUriMap,
        });
        objectToWrap = result.note;
        tos = result.tos;
        ccs = result.ccs;
      }
    } else if (row.object_type === 'Article') {
      const result = buildFedifyArticle(row as StatusRow, account, domain, {
        convMap, mediaMap, replyUriMap, quoteUriMap,
      });
      objectToWrap = result.article;
      tos = result.tos;
      ccs = result.ccs;
    } else {
      const result = buildFedifyNote(row as StatusRow, account, domain, {
        convMap, mediaMap, replyUriMap, quoteUriMap,
      });
      objectToWrap = result.note;
      tos = result.tos;
      ccs = result.ccs;
    }

    activity = new Create({
      id: new URL(activityUri),
      actor: new URL(actorUri),
      published: toTemporalInstant(row.created_at),
      tos,
      ccs,
      object: objectToWrap,
    });
  }

  const jsonLd = await activity.toJsonLd();
  return new Response(JSON.stringify(jsonLd), {
    status: 200,
    headers: { 'Content-Type': 'application/activity+json; charset=utf-8' },
  });
}

type StatusCollectionName = 'replies' | 'shares' | 'likes';

function collectionResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/activity+json; charset=utf-8' },
  });
}

async function getStatusCollectionItems(
  statusId: string,
  collection: StatusCollectionName,
): Promise<string[]> {
  if (collection === 'replies') {
    const { results } = await env.DB.prepare(
      `SELECT uri
       FROM statuses
       WHERE in_reply_to_id = ?1
         AND deleted_at IS NULL
         AND visibility IN ('public', 'unlisted')
       ORDER BY created_at ASC
       LIMIT 40`,
    ).bind(statusId).all<{ uri: string }>();
    return (results ?? []).map((row) => row.uri);
  }

  if (collection === 'shares') {
    const { results } = await env.DB.prepare(
      `SELECT uri
       FROM statuses
       WHERE (reblog_of_id = ?1 OR quote_id = ?1)
         AND deleted_at IS NULL
         AND visibility IN ('public', 'unlisted')
       ORDER BY created_at ASC
       LIMIT 40`,
    ).bind(statusId).all<{ uri: string }>();
    return (results ?? []).map((row) => row.uri);
  }

  const { results } = await env.DB.prepare(
    `SELECT uri
     FROM favourites
     WHERE status_id = ?1
       AND uri IS NOT NULL
     ORDER BY created_at ASC
     LIMIT 40`,
  ).bind(statusId).all<{ uri: string | null }>();
  return (results ?? [])
    .map((row) => row.uri)
    .filter((uri): uri is string => typeof uri === 'string' && uri.length > 0);
}

export async function handleStatusCollectionRequest(
  identifier: string,
  id: string,
  collection: string,
  page = false,
): Promise<Response> {
  if (collection !== 'replies' && collection !== 'shares' && collection !== 'likes') {
    return collectionResponse({ error: 'Record not found' }, 404);
  }

  const domain = env.INSTANCE_DOMAIN;
  const row = await env.DB.prepare(
    `SELECT s.id, s.uri, s.account_id, s.visibility, s.deleted_at,
            s.replies_count, s.reblogs_count, s.favourites_count
     FROM statuses s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.id = ?1
       AND a.username = ?2
       AND a.domain IS NULL
       AND s.deleted_at IS NULL
       AND s.visibility IN ('public', 'unlisted')
       AND s.reblog_of_id IS NULL
     LIMIT 1`,
  ).bind(id, identifier).first<{
    id: string;
    uri: string;
    account_id: string;
    visibility: string;
    deleted_at: string | null;
    replies_count: number;
    reblogs_count: number;
    favourites_count: number;
  }>();

  const authorAvailable = row === null
    ? false
    : await canExposeLocalAccountActivityPubResources(row.account_id);
  if (!row || !canExposeActivityPubPublicStatusRecord(row, authorAvailable)) {
    return collectionResponse({ error: 'Record not found' }, 404);
  }

  const totalItems = collection === 'replies'
    ? row.replies_count
    : collection === 'shares'
      ? row.reblogs_count
      : row.favourites_count;
  const items = await getStatusCollectionItems(row.id, collection);
  const collectionUri = `https://${domain}/users/${identifier}/statuses/${id}/${collection}`;

  if (collection === 'replies') {
    if (!page) {
      return collectionResponse({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: collectionUri,
        type: 'Collection',
        first: {
          type: 'CollectionPage',
          id: `${collectionUri}?page=true`,
          partOf: collectionUri,
          next: `${collectionUri}?only_other_accounts=true&page=true`,
        },
      });
    }

    return collectionResponse({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${collectionUri}?page=true`,
      type: 'CollectionPage',
      partOf: collectionUri,
      items,
    });
  }

  const body: Record<string, unknown> = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: collectionUri,
    type: 'Collection',
    totalItems: totalItems ?? 0,
  };
  if (items.length > 0) body.items = items;
  return collectionResponse(body);
}

// ============================================================
// SHARED: Load conversation, media, reply context for a status
// ============================================================

async function loadStatusContext(
  row: StatusRow,
  id: string,
  domain: string,
) {
  const convMap = new Map<string, string | null>();
  if (row.conversation_id) {
    const convRow = await env.DB.prepare(
      'SELECT ap_uri FROM conversations WHERE id = ?1',
    ).bind(row.conversation_id).first<{ ap_uri: string | null }>();
    convMap.set(row.conversation_id, convRow?.ap_uri ?? null);
  }

  const mediaMap = new Map<string, { url: string; mediaType: string; description: string; width: number | null; height: number | null; blurhash: string | null; type: string }[]>();
  const { results: mediaResults } = await env.DB.prepare(
    'SELECT * FROM media_attachments WHERE status_id = ?1',
  ).bind(id).all();
  for (const m of (mediaResults ?? []) as Record<string, unknown>[]) {
    const sid = m.status_id as string;
    if (!mediaMap.has(sid)) mediaMap.set(sid, []);
    mediaMap.get(sid)!.push({
      url: `https://${domain}/media/${m.file_key}`,
      mediaType: (m.file_content_type as string) || 'image/jpeg',
      description: (m.description as string) || '',
      width: m.width as number | null,
      height: m.height as number | null,
      blurhash: m.blurhash as string | null,
      type: (m.type as string) || 'image',
    });
  }

  const replyUriMap = new Map<string, string>();
  if (row.in_reply_to_id && !row.in_reply_to_id.startsWith('http')) {
    const rr = await env.DB.prepare(
      'SELECT uri FROM statuses WHERE id = ?1 LIMIT 1',
    ).bind(row.in_reply_to_id).first<{ uri: string }>();
    if (rr) replyUriMap.set(row.in_reply_to_id, rr.uri);
  }

  const quoteUriMap = new Map<string, string>();
  if (row.quote_id) {
    const quotedRow = await env.DB.prepare(
      'SELECT uri FROM statuses WHERE id = ?1 AND deleted_at IS NULL LIMIT 1',
    ).bind(row.quote_id).first<{ uri: string }>();
    if (quotedRow) quoteUriMap.set(row.quote_id, quotedRow.uri);
  }

  return { convMap, mediaMap, replyUriMap, quoteUriMap };
}
