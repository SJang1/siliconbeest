/**
 * Shared Followers Collection Dispatcher
 *
 * Single definition of the followers collection dispatcher logic, shared
 * between the main worker and the queue consumer.
 *
 * This module uses `import { env } from 'cloudflare:workers'` for DB access.
 */

import { env } from 'cloudflare:workers';
import {
  canOriginateAccountActivity,
  canViewAccountCollection,
} from '../permissions';

// ============================================================
// STRUCTURAL TYPES (match Fedify's API without importing it)
// ============================================================

/** Minimal shape of the Fedify collection dispatcher context. */
interface CollectionContextLike<TData> {
  data: TData;
}

interface CollectionRequestContextLike<TData> extends CollectionContextLike<TData> {
  getSignedKeyOwner(): Promise<{ readonly id: URL | null } | null>;
}

/** Matches the builder returned by Federation.setFollowersDispatcher(). */
interface FollowersDispatcherBuilder<TData> {
  setCounter(handler: (ctx: CollectionContextLike<TData>, identifier: string) => Promise<bigint | number | null>): FollowersDispatcherBuilder<TData>;
  setFirstCursor(handler: (ctx: CollectionContextLike<TData>, identifier: string) => Promise<string | null>): FollowersDispatcherBuilder<TData>;
  authorize(handler: (ctx: CollectionRequestContextLike<TData>, identifier: string) => Promise<boolean>): FollowersDispatcherBuilder<TData>;
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

/**
 * Fedify skips a paginated collection dispatcher on the collection root when
 * a first cursor is present. Returning null for an unknown owner makes Fedify
 * invoke the dispatcher, whose null result is then translated to HTTP 404.
 */
export async function getLocalAccountCollectionFirstCursor(
  identifier: string,
): Promise<string | null> {
  const account = await env.DB.prepare(
    `SELECT id FROM accounts
     WHERE username = ?1 AND domain IS NULL
     LIMIT 1`,
  ).bind(identifier).first<{ id: string }>();
  return account ? '' : null;
}

/**
 * HTTP access to a hidden local social graph requires a verified signature
 * owned by that exact actor. Collection dispatch itself remains unchanged so
 * internal followers-only delivery can still expand the real relationship.
 */
export async function authorizeAccountCollectionRequest<TData>(
  ctx: CollectionRequestContextLike<TData>,
  identifier: string,
): Promise<boolean> {
  const account = await env.DB.prepare(
    `SELECT a.uri, a.hide_collections, a.domain, a.suspended_at, a.memorial,
            u.disabled AS user_disabled, u.approved AS user_approved
     FROM accounts a
     LEFT JOIN users u ON u.account_id = a.id
     WHERE a.username = ?1 AND a.domain IS NULL
     LIMIT 1`,
  ).bind(identifier).first<{
    uri: string;
    hide_collections: number | null;
    domain: string | null;
    suspended_at: string | null;
    memorial: number | null;
    user_disabled: number | null;
    user_approved: number | null;
  }>();
  if (!account) return false;
  if (!canOriginateAccountActivity({
    accountSuspended: account.suspended_at !== null,
    accountMemorial: account.memorial === null ? null : account.memorial !== 0,
    isLocalAccount: account.domain === null,
    userDisabled: account.user_disabled === null ? null : account.user_disabled !== 0,
    userApproved: account.user_approved === null ? null : account.user_approved !== 0,
  })) return false;

  const collectionsHidden = account.hide_collections === null
    ? null
    : account.hide_collections === 1;
  if (canViewAccountCollection({
    ownerAccountId: account.uri,
    viewerAccountId: null,
    collectionsHidden,
  })) {
    return true;
  }

  try {
    const signedOwner = await ctx.getSignedKeyOwner();
    return canViewAccountCollection({
      ownerAccountId: account.uri,
      viewerAccountId: signedOwner?.id?.href ?? null,
      collectionsHidden,
    });
  } catch {
    return false;
  }
}

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
      return account?.followers_count ?? null;
    })
    .setFirstCursor((_ctx, identifier) =>
      getLocalAccountCollectionFirstCursor(identifier)
    )
    .authorize(authorizeAccountCollectionRequest);
}
