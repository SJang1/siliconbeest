/**
 * Shared Followers Collection Dispatcher
 *
 * Single definition of the followers collection dispatcher logic, shared
 * between the main worker and the queue consumer.
 *
 * This module uses `import { env } from 'cloudflare:workers'` for DB access.
 */

import { env } from 'cloudflare:workers';

// ============================================================
// STRUCTURAL TYPES (match Fedify's API without importing it)
// ============================================================

/** Minimal shape of the Fedify collection dispatcher context. */
interface CollectionContextLike<TData> {
  data: TData;
}

/** Matches the builder returned by Federation.setFollowersDispatcher(). */
interface FollowersDispatcherBuilder<TData> {
  setCounter(handler: (ctx: CollectionContextLike<TData>, identifier: string) => Promise<bigint | number | null>): FollowersDispatcherBuilder<TData>;
  setFirstCursor(handler: (ctx: CollectionContextLike<TData>, identifier: string) => Promise<string | null>): FollowersDispatcherBuilder<TData>;
}

/** Minimal shape of a Fedify Federation for the followers dispatcher. */
interface FederationLike<TData> {
  setFollowersDispatcher(
    path: string,
    handler: (
      ctx: CollectionContextLike<TData>,
      identifier: string,
      cursor: string | null,
    ) => Promise<{
      items: { id: URL; inboxId: URL | null; endpoints: { sharedInbox: URL } | null }[];
      nextCursor: string | null;
    } | null>,
  ): FollowersDispatcherBuilder<TData>;
}

const FOLLOWERS_PAGE_SIZE = 40;

// ============================================================
// SHARED LOGIC
// ============================================================

/**
 * Register the followers collection dispatcher on a Fedify Federation instance.
 */
export function setupFollowersDispatcher<TData>(
  federation: FederationLike<TData>,
): void {
  federation
    .setFollowersDispatcher(
      '/users/{identifier}/followers',
      async (_ctx, identifier, cursor) => {
        const account = await env.DB
          .prepare(
            `SELECT id, followers_count FROM accounts
             WHERE username = ?1 AND domain IS NULL
             LIMIT 1`,
          )
          .bind(identifier)
          .first<{ id: string; followers_count: number }>();

        if (!account) return null;

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

        const { results } = await env.DB
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
    .setCounter(async (_ctx, identifier) => {
      const account = await env.DB
        .prepare(
          `SELECT followers_count FROM accounts
           WHERE username = ?1 AND domain IS NULL LIMIT 1`,
        )
        .bind(identifier)
        .first<{ followers_count: number }>();
      return account?.followers_count ?? 0;
    })
    .setFirstCursor(async (_ctx, _identifier) => {
      return '';
    });
}
