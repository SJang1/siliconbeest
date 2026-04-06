/**
 * Fedify Object Dispatchers + Hono activity route handler
 *
 * - Note dispatcher: /users/{identifier}/statuses/{id}
 * - Activity handler (Hono route): /users/{identifier}/statuses/{id}/activity
 *   (Hono because Fedify only allows one type per path, and we need Create + Announce)
 */

import {
  Note,
  Create,
  Announce,
  Hashtag,
  Mention,
} from '@fedify/vocab';
import type { Federation } from '@fedify/fedify';
import type { FedifyContextData } from '../fedify';
import type { AccountRow, StatusRow } from '../../types/db';
import {
  buildFedifyNote,
  toTemporalInstant,
  AS_PUBLIC,
} from './collections';
import { env } from 'cloudflare:workers';

// ============================================================
// SETUP: Register Note object dispatcher on Federation
// ============================================================

export function setupObjectDispatchers(
  federation: Federation<FedifyContextData>,
): void {
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
         WHERE s.id = ?1 AND a.username = ?2 AND a.domain IS NULL`,
      )
        .bind(id, identifier)
        .first<StatusRow & { username: string; account_domain: string | null }>();

      if (!row) return null;
      if (row.deleted_at) return null;
      // Reblogs are Announce activities, not Note objects
      if (row.reblog_of_id) return null;

      const account = await env.DB.prepare(
        'SELECT * FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1',
      )
        .bind(identifier)
        .first<AccountRow>();
      if (!account) return null;

      // Load supporting data
      const { convMap, mediaMap, replyUriMap } = await loadStatusContext(row, id, domain);

      // Build core Note
      const { note } = buildFedifyNote(row as StatusRow, account, domain, {
        convMap, mediaMap, replyUriMap,
      });

      // Add Mention and Hashtag tags
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
     WHERE s.id = ?1 AND a.username = ?2 AND a.domain IS NULL`,
  )
    .bind(id, identifier)
    .first<StatusRow & { username: string; account_domain: string | null }>();

  if (!row || row.deleted_at) {
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
    // Regular post → Create(Note)
    const account = await env.DB.prepare(
      'SELECT * FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1',
    ).bind(identifier).first<AccountRow>();

    if (!account) {
      return new Response(JSON.stringify({ error: 'Record not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/activity+json' },
      });
    }

    const { convMap, mediaMap, replyUriMap } = await loadStatusContext(row, id, domain);
    const { note, tos, ccs } = buildFedifyNote(row as StatusRow, account, domain, {
      convMap, mediaMap, replyUriMap,
    });

    activity = new Create({
      id: new URL(activityUri),
      actor: new URL(actorUri),
      published: toTemporalInstant(row.created_at),
      tos,
      ccs,
      object: note,
    });
  }

  const jsonLd = await activity.toJsonLd();
  return new Response(JSON.stringify(jsonLd), {
    status: 200,
    headers: { 'Content-Type': 'application/activity+json; charset=utf-8' },
  });
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

  return { convMap, mediaMap, replyUriMap };
}
