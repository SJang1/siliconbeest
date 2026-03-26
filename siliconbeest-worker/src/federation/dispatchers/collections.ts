/**
 * Fedify Collection Dispatchers
 *
 * Registers followers, following, outbox, featured, and featured-tags
 * collection dispatchers on the Fedify Federation instance.
 *
 * Each dispatcher queries D1 with the same SQL as the existing Hono
 * endpoints and returns Fedify vocabulary objects.  Fedify handles
 * the OrderedCollection / OrderedCollectionPage wrapper, @context,
 * and content-negotiation automatically.
 */

import {
  Note,
  Create,
  Announce,
  Hashtag,
  Image,
  Document as APDocument,
  Source,
} from '@fedify/vocab';
import { Temporal } from '@js-temporal/polyfill';
import type { Federation } from '@fedify/fedify';
import type { FedifyContextData } from '../fedify';
import type { AccountRow, StatusRow } from '../../types/db';

export const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

// Page sizes matching existing endpoints
const FOLLOWERS_PAGE_SIZE = 40;
const FOLLOWING_PAGE_SIZE = 40;
const OUTBOX_PAGE_SIZE = 20;

// ============================================================
// PUBLIC SETUP
// ============================================================

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
}

// ============================================================
// FOLLOWERS
// ============================================================

function setupFollowersDispatcher(
  federation: Federation<FedifyContextData>,
): void {
  federation
    .setFollowersDispatcher(
      '/users/{identifier}/followers',
      async (ctx, identifier, cursor) => {
        const db = ctx.data.env.DB;

        const account = await db
          .prepare(
            `SELECT id, followers_count FROM accounts
             WHERE username = ?1 AND domain IS NULL
             LIMIT 1`,
          )
          .bind(identifier)
          .first<{ id: string; followers_count: number }>();

        if (!account) return null;

        // First-page request when cursor is null is handled by Fedify via
        // setFirstCursor; when cursor is provided we paginate.
        const conditions: string[] = ['f.target_account_id = ?1'];
        const binds: (string | number)[] = [account.id];

        if (cursor) {
          conditions.push('f.id < ?2');
          binds.push(cursor);
        }

        const sql = `
          SELECT f.id AS follow_id, a.uri, a.inbox_url, a.shared_inbox_url
          FROM follows f
          JOIN accounts a ON a.id = f.account_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY f.id DESC
          LIMIT ?${binds.length + 1}
        `;
        binds.push(FOLLOWERS_PAGE_SIZE + 1);

        const { results } = await db
          .prepare(sql)
          .bind(...binds)
          .all<{ follow_id: string; uri: string; inbox_url: string; shared_inbox_url: string | null }>();

        const rows = results ?? [];
        const hasNext = rows.length > FOLLOWERS_PAGE_SIZE;
        const items = hasNext ? rows.slice(0, FOLLOWERS_PAGE_SIZE) : rows;

        const nextCursor = hasNext
          ? items[items.length - 1].follow_id
          : null;

        return {
          items: items.map((r) => ({
            id: new URL(r.uri),
            inboxId: r.inbox_url ? new URL(r.inbox_url) : null,
            endpoints: r.shared_inbox_url
              ? { sharedInbox: new URL(r.shared_inbox_url) }
              : null,
          })),
          nextCursor,
        };
      },
    )
    .setCounter(async (ctx, identifier) => {
      const db = ctx.data.env.DB;
      const account = await db
        .prepare(
          `SELECT followers_count FROM accounts
           WHERE username = ?1 AND domain IS NULL LIMIT 1`,
        )
        .bind(identifier)
        .first<{ followers_count: number }>();
      return account?.followers_count ?? 0;
    })
    .setFirstCursor(async (_ctx, _identifier) => {
      // Empty string signals "start from the beginning" (no cursor offset)
      return '';
    });
}

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
        const db = ctx.data.env.DB;

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
      const db = ctx.data.env.DB;
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
        const db = ctx.data.env.DB;
        const domain = ctx.data.env.INSTANCE_DOMAIN;

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
          // Reblogs become Announce activities
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

          // Regular posts become Create(Note) activities
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
      const db = ctx.data.env.DB;
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
      const db = ctx.data.env.DB;
      const domain = ctx.data.env.INSTANCE_DOMAIN;

      const account = await db
        .prepare(
          `SELECT * FROM accounts
           WHERE username = ?1 AND domain IS NULL LIMIT 1`,
        )
        .bind(identifier)
        .first<AccountRow>();

      if (!account) return null;

      // Fetch pinned statuses (no pagination; featured is typically small)
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
      const db = ctx.data.env.DB;

      const account = await db
        .prepare(
          `SELECT id FROM accounts
           WHERE username = ?1 AND domain IS NULL LIMIT 1`,
        )
        .bind(identifier)
        .first<{ id: string }>();

      if (!account) return null;

      // Currently returns an empty collection (matches existing endpoint)
      return { items: [] as Hashtag[] };
    },
  );
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Convert an ISO 8601 date string to a Temporal.Instant.
 */
export function toTemporalInstant(isoString: string): Temporal.Instant {
  return Temporal.Instant.from(isoString);
}

/**
 * Map internal media type string to Fedify vocabulary class constructor.
 */
export function buildMediaAttachment(
  att: {
    url: string;
    mediaType: string;
    description: string;
    width: number | null;
    height: number | null;
    blurhash: string | null;
    type: string;
  },
): Image | APDocument {
  const values: Record<string, unknown> = {
    url: new URL(att.url),
    mediaType: att.mediaType,
    name: att.description || null,
  };

  if (att.type === 'image') {
    if (att.width != null) values.width = att.width;
    if (att.height != null) values.height = att.height;
    return new Image(values as ConstructorParameters<typeof Image>[0]);
  }

  return new APDocument(
    values as ConstructorParameters<typeof APDocument>[0],
  );
}

/** Result from building a Fedify Note with addressing info. */
export interface FedifyNoteResult {
  note: Note;
  tos: URL[];
  ccs: URL[];
}

/**
 * Build a Fedify Note from a StatusRow, matching the logic in noteSerializer.ts.
 * Returns the Note plus the to/cc URL arrays for the wrapping activity.
 */
export function buildFedifyNote(
  status: StatusRow,
  account: AccountRow,
  domain: string,
  helpers: {
    convMap: Map<string, string | null>;
    mediaMap: Map<
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
    >;
    replyUriMap: Map<string, string>;
  },
): FedifyNoteResult {
  const actorUri = `https://${domain}/users/${account.username}`;
  const followersUri = `${actorUri}/followers`;

  // Determine to/cc based on visibility
  const { tos, ccs } = resolveAddressing(status.visibility, followersUri);

  // Determine inReplyTo
  let replyTarget: URL | null = null;
  if (status.in_reply_to_id) {
    if (status.in_reply_to_id.startsWith('http')) {
      replyTarget = new URL(status.in_reply_to_id);
    } else {
      const resolvedUri = helpers.replyUriMap.get(status.in_reply_to_id);
      if (resolvedUri) {
        replyTarget = new URL(resolvedUri);
      } else {
        replyTarget = new URL(
          `https://${domain}/users/${account.username}/statuses/${status.in_reply_to_id}`,
        );
      }
    }
  }

  // Build attachments
  const attachments = (helpers.mediaMap.get(status.id) ?? []).map(
    buildMediaAttachment,
  );

  // Build Note values
  const noteValues: ConstructorParameters<typeof Note>[0] = {
    id: new URL(status.uri),
    attribution: new URL(actorUri),
    content: status.content,
    url: new URL(
      status.url ?? `https://${domain}/@${account.username}/${status.id}`,
    ),
    published: toTemporalInstant(status.created_at),
    tos: tos.map((u) => u),
    ccs: ccs.map((u) => u),
    sensitive: status.sensitive === 1,
    summary: status.content_warning || null,
  };

  if (replyTarget) {
    noteValues.replyTarget = replyTarget;
  }

  if (attachments.length > 0) {
    noteValues.attachments = attachments;
  }

  if (status.edited_at) {
    noteValues.updated = toTemporalInstant(status.edited_at);
  }

  if (status.text) {
    noteValues.source = new Source({
      content: status.text,
      mediaType: 'text/plain',
    });
  }

  const note = new Note(noteValues);

  return { note, tos, ccs };
}

/**
 * Determine to/cc URL arrays based on Mastodon-style visibility.
 * Mirrors resolveAddressing() in noteSerializer.ts.
 */
export function resolveAddressing(
  visibility: string,
  followersUri: string,
): { tos: URL[]; ccs: URL[] } {
  switch (visibility) {
    case 'public':
      return {
        tos: [new URL(AS_PUBLIC)],
        ccs: [new URL(followersUri)],
      };
    case 'unlisted':
      return {
        tos: [new URL(followersUri)],
        ccs: [new URL(AS_PUBLIC)],
      };
    case 'private':
      return {
        tos: [new URL(followersUri)],
        ccs: [],
      };
    case 'direct':
      return {
        tos: [],
        ccs: [],
      };
    default:
      return {
        tos: [new URL(AS_PUBLIC)],
        ccs: [new URL(followersUri)],
      };
  }
}
