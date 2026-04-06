/**
 * Fedify Collection Dispatcher Registration
 *
 * Registers followers, following, outbox, featured, featured-tags, and liked
 * collection dispatchers on the Fedify Federation instance.
 */

import {
  Create,
  Announce,
  Hashtag,
} from '@fedify/vocab';
import type { Federation } from '@fedify/fedify';
import type { FedifyContextData } from '../../fedify';
import type { AccountRow, StatusRow } from '../../../types/db';
import { AS_PUBLIC, toTemporalInstant, buildFedifyNote } from './helpers';
import { setupFollowersDispatcher } from '../../../../../../packages/shared/federation/collection-dispatchers';
import { env } from 'cloudflare:workers';

// Page sizes matching existing endpoints
const FOLLOWING_PAGE_SIZE = 40;
const OUTBOX_PAGE_SIZE = 20;
const LIKED_PAGE_SIZE = 20;

/**
 * Register all collection dispatchers on the federation instance.
 */
export function setupCollectionDispatchers(
  federation: Federation<FedifyContextData>,
): void {
  setupFollowersDispatcher(federation);
  setupFollowingDispatcher(federation);
  setupOutboxDispatcher(federation);
  setupFeaturedDispatcher(federation);
  setupFeaturedTagsDispatcher(federation);
  setupLikedDispatcher(federation);
}

// ============================================================
// FOLLOWERS (delegated to shared implementation)
// ============================================================

// ============================================================
// FOLLOWING
// ============================================================

function setupFollowingDispatcher(
  federation: Federation<FedifyContextData>,
): void {
  federation
    .setFollowingDispatcher(
      '/users/{identifier}/following',
      async (ctx, identifier, cursor) => {
        const db = env.DB;

        const account = await db
          .prepare(
            `SELECT id, following_count FROM accounts
             WHERE username = ?1 AND domain IS NULL
             LIMIT 1`,
          )
          .bind(identifier)
          .first<{ id: string; following_count: number }>();

        if (!account) return null;

        const conditions: string[] = ['f.account_id = ?1'];
        const binds: (string | number)[] = [account.id];

        if (cursor) {
          conditions.push('f.id < ?2');
          binds.push(cursor);
        }

        const sql = `
          SELECT f.id AS follow_id, a.uri
          FROM follows f
          JOIN accounts a ON a.id = f.target_account_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY f.id DESC
          LIMIT ?${binds.length + 1}
        `;
        binds.push(FOLLOWING_PAGE_SIZE + 1);

        const { results } = await db
          .prepare(sql)
          .bind(...binds)
          .all<{ follow_id: string; uri: string }>();

        const rows = results ?? [];
        const hasNext = rows.length > FOLLOWING_PAGE_SIZE;
        const items = hasNext ? rows.slice(0, FOLLOWING_PAGE_SIZE) : rows;

        const nextCursor = hasNext
          ? items[items.length - 1].follow_id
          : null;

        return {
          items: items.map((r) => new URL(r.uri)),
          nextCursor,
        };
      },
    )
    .setCounter(async (ctx, identifier) => {
      const db = env.DB;
      const account = await db
        .prepare(
          `SELECT following_count FROM accounts
           WHERE username = ?1 AND domain IS NULL LIMIT 1`,
        )
        .bind(identifier)
        .first<{ following_count: number }>();
      return account?.following_count ?? 0;
    })
    .setFirstCursor(async (_ctx, _identifier) => {
      return '';
    });
}

// ============================================================
// OUTBOX
// ============================================================

function setupOutboxDispatcher(
  federation: Federation<FedifyContextData>,
): void {
  federation
    .setOutboxDispatcher(
      '/users/{identifier}/outbox',
      async (ctx, identifier, cursor) => {
        const db = env.DB;
        const domain = env.INSTANCE_DOMAIN;

        const account = await db
          .prepare(
            `SELECT * FROM accounts
             WHERE username = ?1 AND domain IS NULL
             LIMIT 1`,
          )
          .bind(identifier)
          .first<AccountRow>();

        if (!account) return null;

        const actorUri = `https://${domain}/users/${identifier}`;
        const followersUri = `${actorUri}/followers`;

        const conditions: string[] = [
          'account_id = ?',
          `visibility IN ('public', 'unlisted')`,
          'deleted_at IS NULL',
        ];
        const binds: (string | number)[] = [account.id];

        if (cursor) {
          conditions.push('id < ?');
          binds.push(cursor);
        }

        const sql = `
          SELECT * FROM statuses
          WHERE ${conditions.join(' AND ')}
          ORDER BY id DESC
          LIMIT ?
        `;
        binds.push(OUTBOX_PAGE_SIZE + 1);

        const { results } = await db.prepare(sql).bind(...binds).all();
        const rows = (results ?? []) as unknown as StatusRow[];
        const hasNext = rows.length > OUTBOX_PAGE_SIZE;
        const pageRows = hasNext ? rows.slice(0, OUTBOX_PAGE_SIZE) : rows;

        // Batch-fetch conversation AP URIs
        const convIds = [
          ...new Set(
            pageRows.map((r) => r.conversation_id).filter(Boolean),
          ),
        ] as string[];
        const convMap = new Map<string, string | null>();
        for (const cid of convIds) {
          const row = await db
            .prepare('SELECT ap_uri FROM conversations WHERE id = ?1')
            .bind(cid)
            .first<{ ap_uri: string | null }>();
          convMap.set(cid, row?.ap_uri ?? null);
        }

        // Resolve URIs for reblogged statuses
        const reblogIds = pageRows
          .filter((r) => r.reblog_of_id)
          .map((r) => r.reblog_of_id!);
        const reblogUriMap = new Map<string, string>();
        for (const reblogId of reblogIds) {
          const reblogRow = await db
            .prepare('SELECT uri FROM statuses WHERE id = ?1 LIMIT 1')
            .bind(reblogId)
            .first<{ uri: string }>();
          if (reblogRow) {
            reblogUriMap.set(reblogId, reblogRow.uri);
          }
        }

        // Batch fetch media attachments
        const statusIds = pageRows.map((s) => s.id);
        const mediaMap = new Map<
          string,
          {
            url: string;
            mediaType: string;
            description: string;
            width: number | null;
            height: number | null;
            blurhash: string | null;
            type: string;
          }[]
        >();
        if (statusIds.length > 0) {
          const ph = statusIds.map(() => '?').join(',');
          const { results: allMedia } = await db
            .prepare(
              `SELECT * FROM media_attachments WHERE status_id IN (${ph})`,
            )
            .bind(...statusIds)
            .all();
          for (const m of (allMedia ?? []) as Record<string, unknown>[]) {
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
        }

        // Batch-fetch in_reply_to URIs
        const replyIds = pageRows
          .filter((r) => r.in_reply_to_id && !r.in_reply_to_id.startsWith('http'))
          .map((r) => r.in_reply_to_id!);
        const replyUriMap = new Map<string, string>();
        for (const rid of replyIds) {
          const rr = await db
            .prepare('SELECT uri FROM statuses WHERE id = ?1 LIMIT 1')
            .bind(rid)
            .first<{ uri: string }>();
          if (rr) replyUriMap.set(rid, rr.uri);
        }

        const activities = pageRows.map((status) => {
          if (status.reblog_of_id) {
            const originalUri =
              reblogUriMap.get(status.reblog_of_id) ?? status.reblog_of_id;
            return new Announce({
              id: new URL(`${status.uri}/activity`),
              actor: new URL(actorUri),
              published: toTemporalInstant(status.created_at),
              tos: [new URL(AS_PUBLIC)],
              ccs: [new URL(followersUri)],
              object: new URL(originalUri),
            });
          }

          const note = buildFedifyNote(status, account, domain, {
            convMap,
            mediaMap,
            replyUriMap,
          });

          return new Create({
            id: new URL(`${status.uri}/activity`),
            actor: new URL(actorUri),
            published: toTemporalInstant(status.created_at),
            tos: note.tos,
            ccs: note.ccs,
            object: note.note,
          });
        });

        const nextCursor = hasNext
          ? pageRows[pageRows.length - 1].id
          : null;

        return {
          items: activities,
          nextCursor,
        };
      },
    )
    .setCounter(async (ctx, identifier) => {
      const db = env.DB;
      const account = await db
        .prepare(
          `SELECT id FROM accounts
           WHERE username = ?1 AND domain IS NULL LIMIT 1`,
        )
        .bind(identifier)
        .first<{ id: string }>();
      if (!account) return 0;
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM statuses
           WHERE account_id = ?1 AND visibility IN ('public', 'unlisted')
             AND deleted_at IS NULL`,
        )
        .bind(account.id)
        .first<{ cnt: number }>();
      return row?.cnt ?? 0;
    })
    .setFirstCursor(async (_ctx, _identifier) => {
      return '';
    });
}

// ============================================================
// FEATURED (PINNED POSTS)
// ============================================================

function setupFeaturedDispatcher(
  federation: Federation<FedifyContextData>,
): void {
  federation.setFeaturedDispatcher(
    '/users/{identifier}/collections/featured',
    async (ctx, identifier, _cursor) => {
      const db = env.DB;
      const domain = env.INSTANCE_DOMAIN;

      const account = await db
        .prepare(
          `SELECT * FROM accounts
           WHERE username = ?1 AND domain IS NULL LIMIT 1`,
        )
        .bind(identifier)
        .first<AccountRow>();

      if (!account) return null;

      const { results } = await db
        .prepare(
          `SELECT * FROM statuses
           WHERE account_id = ?1 AND pinned = 1
             AND deleted_at IS NULL AND reblog_of_id IS NULL
           ORDER BY created_at DESC`,
        )
        .bind(account.id)
        .all();

      const rows = (results ?? []) as unknown as StatusRow[];

      // Batch-fetch conversation AP URIs
      const convIds = [
        ...new Set(rows.map((r) => r.conversation_id).filter(Boolean)),
      ] as string[];
      const convMap = new Map<string, string | null>();
      for (const cid of convIds) {
        const row = await db
          .prepare('SELECT ap_uri FROM conversations WHERE id = ?1')
          .bind(cid)
          .first<{ ap_uri: string | null }>();
        convMap.set(cid, row?.ap_uri ?? null);
      }

      // Batch fetch media
      const sIds = rows.map((s) => s.id);
      const mediaMap = new Map<
        string,
        {
          url: string;
          mediaType: string;
          description: string;
          width: number | null;
          height: number | null;
          blurhash: string | null;
          type: string;
        }[]
      >();
      if (sIds.length > 0) {
        const ph = sIds.map(() => '?').join(',');
        const { results: fm } = await db
          .prepare(
            `SELECT * FROM media_attachments WHERE status_id IN (${ph})`,
          )
          .bind(...sIds)
          .all();
        for (const m of (fm ?? []) as Record<string, unknown>[]) {
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
      }

      // Batch-fetch in_reply_to URIs
      const replyIds = rows
        .filter((r) => r.in_reply_to_id && !r.in_reply_to_id.startsWith('http'))
        .map((r) => r.in_reply_to_id!);
      const replyUriMap = new Map<string, string>();
      for (const rid of replyIds) {
        const rr = await db
          .prepare('SELECT uri FROM statuses WHERE id = ?1 LIMIT 1')
          .bind(rid)
          .first<{ uri: string }>();
        if (rr) replyUriMap.set(rid, rr.uri);
      }

      const items = rows.map((status) => {
        const { note } = buildFedifyNote(status, account, domain, {
          convMap,
          mediaMap,
          replyUriMap,
        });
        return note;
      });

      return { items };
    },
  );
}

// ============================================================
// FEATURED TAGS
// ============================================================

function setupFeaturedTagsDispatcher(
  federation: Federation<FedifyContextData>,
): void {
  federation.setFeaturedTagsDispatcher(
    '/users/{identifier}/collections/tags',
    async (ctx, identifier, _cursor) => {
      const db = env.DB;

      const account = await db
        .prepare(
          `SELECT id FROM accounts
           WHERE username = ?1 AND domain IS NULL LIMIT 1`,
        )
        .bind(identifier)
        .first<{ id: string }>();

      if (!account) return null;

      const domain = env.INSTANCE_DOMAIN;

      try {
        const { results } = await db
          .prepare(
            `SELECT t.name FROM featured_tags ft
             JOIN tags t ON t.id = ft.tag_id
             WHERE ft.account_id = ?1
             ORDER BY ft.created_at DESC`,
          )
          .bind(account.id)
          .all<{ name: string }>();

        const items = (results ?? []).map(
          (r) =>
            new Hashtag({
              name: `#${r.name}`,
              href: new URL(`https://${domain}/tags/${r.name}`),
            }),
        );

        return { items };
      } catch {
        return { items: [] as Hashtag[] };
      }
    },
  );
}

// ============================================================
// LIKED
// ============================================================

function setupLikedDispatcher(
  federation: Federation<FedifyContextData>,
): void {
  federation
    .setLikedDispatcher(
      '/users/{identifier}/liked',
      async (ctx, identifier, cursor) => {
        const db = env.DB;

        const account = await db
          .prepare(
            `SELECT id FROM accounts
             WHERE username = ?1 AND domain IS NULL LIMIT 1`,
          )
          .bind(identifier)
          .first<{ id: string }>();

        if (!account) return null;

        const conditions: string[] = ['l.account_id = ?1'];
        const binds: (string | number)[] = [account.id];

        if (cursor) {
          conditions.push('l.id < ?2');
          binds.push(cursor);
        }

        const sql = `
          SELECT l.id AS like_id, s.uri
          FROM favourites l
          JOIN statuses s ON s.id = l.status_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY l.id DESC
          LIMIT ?${binds.length + 1}
        `;
        binds.push(LIKED_PAGE_SIZE + 1);

        const { results } = await db
          .prepare(sql)
          .bind(...binds)
          .all<{ like_id: string; uri: string }>();

        const rows = results ?? [];
        const hasNext = rows.length > LIKED_PAGE_SIZE;
        const items = hasNext ? rows.slice(0, LIKED_PAGE_SIZE) : rows;

        const nextCursor = hasNext
          ? items[items.length - 1].like_id
          : null;

        return {
          items: items.map((r) => new URL(r.uri)),
          nextCursor,
        };
      },
    )
    .setCounter(async (ctx, identifier) => {
      const db = env.DB;
      const account = await db
        .prepare(
          `SELECT id FROM accounts
           WHERE username = ?1 AND domain IS NULL LIMIT 1`,
        )
        .bind(identifier)
        .first<{ id: string }>();
      if (!account) return 0;
      const row = await db
        .prepare('SELECT COUNT(*) AS cnt FROM favourites WHERE account_id = ?1')
        .bind(account.id)
        .first<{ cnt: number }>();
      return row?.cnt ?? 0;
    })
    .setFirstCursor(async (_ctx, _identifier) => {
      return '';
    });
}
