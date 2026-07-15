import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';
import { serializeList, serializeAccount } from '../utils/mastodonSerializer';
import { AppError } from '../middleware/errorHandler';
import type { ListRow, AccountRow } from '../types/db';
import {
  assertListMemberAddable,
  listPermittedListMemberIds,
} from './permissions';

// ----------------------------------------------------------------
// listLists
// ----------------------------------------------------------------

export async function listLists(accountId: string) {
  const { results } = await env.DB
    .prepare('SELECT * FROM lists WHERE account_id = ?1 ORDER BY created_at ASC')
    .bind(accountId)
    .all();

  return (results ?? []).map((row: any) => serializeList(row as ListRow));
}

// ----------------------------------------------------------------
// getList
// ----------------------------------------------------------------

export async function getList(listId: string, accountId: string) {
  const row = await env.DB
    .prepare('SELECT * FROM lists WHERE id = ?1 AND account_id = ?2')
    .bind(listId, accountId)
    .first<ListRow>();

  if (!row) {
    throw new AppError(404, 'Record not found');
  }

  return serializeList(row);
}

// ----------------------------------------------------------------
// createList
// ----------------------------------------------------------------

export async function createList(
  accountId: string,
  title: string,
  repliesPolicy?: string,
  exclusive?: boolean,
) {
  const listId = generateUlid();
  const now = new Date().toISOString();
  const policy = repliesPolicy || 'list';
  const excl = exclusive ? 1 : 0;

  await env.DB
    .prepare(
      `INSERT INTO lists (id, account_id, title, replies_policy, exclusive, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
    )
    .bind(listId, accountId, title, policy, excl, now)
    .run();

  return {
    id: listId,
    title,
    replies_policy: policy,
    exclusive: !!excl,
  };
}

// ----------------------------------------------------------------
// updateList
// ----------------------------------------------------------------

export interface UpdateListData {
  title?: string;
  replies_policy?: string;
  exclusive?: boolean;
}

export async function updateList(listId: string, accountId: string, data: UpdateListData) {
  const existing = await env.DB
    .prepare('SELECT * FROM lists WHERE id = ?1 AND account_id = ?2')
    .bind(listId, accountId)
    .first<ListRow>();

  if (!existing) {
    throw new AppError(404, 'Record not found');
  }

  const now = new Date().toISOString();
  const title = data.title !== undefined ? data.title.trim() : existing.title;
  const repliesPolicy = data.replies_policy ?? existing.replies_policy;
  const exclusive = data.exclusive !== undefined ? (data.exclusive ? 1 : 0) : existing.exclusive;

  const update = await env.DB
    .prepare(
      `UPDATE lists
       SET title = ?1, replies_policy = ?2, exclusive = ?3, updated_at = ?4
       WHERE id = ?5
         AND (title IS NOT ?1 OR replies_policy IS NOT ?2 OR exclusive IS NOT ?3)`,
    )
    .bind(title, repliesPolicy, exclusive, now, listId)
    .run();

  return {
    list: {
      id: listId,
      title,
      replies_policy: repliesPolicy,
      exclusive: !!exclusive,
    },
    changed: (update.meta?.changes ?? 0) > 0,
  };
}

// ----------------------------------------------------------------
// deleteList
// ----------------------------------------------------------------

export async function deleteList(listId: string, accountId: string): Promise<void> {
  const existing = await env.DB
    .prepare('SELECT id FROM lists WHERE id = ?1 AND account_id = ?2')
    .bind(listId, accountId)
    .first();

  if (!existing) {
    throw new AppError(404, 'Record not found');
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM list_accounts WHERE list_id = ?1').bind(listId),
    env.DB.prepare('DELETE FROM lists WHERE id = ?1').bind(listId),
  ]);
}

// ----------------------------------------------------------------
// getListMembers
// ----------------------------------------------------------------

export async function getListMembers(listId: string, accountId: string, instanceDomain: string) {
  const memberIds = await listPermittedListMemberIds(listId, accountId);
  if (memberIds.length === 0) return [];
  const placeholders = memberIds.map(() => '?').join(', ');

  const { results } = await env.DB
    .prepare(
      `SELECT a.* FROM accounts a WHERE a.id IN (${placeholders})`,
    )
    .bind(...memberIds)
    .all<AccountRow>();

  return (results ?? []).map((row) => serializeAccount(row, { instanceDomain }));
}

// ----------------------------------------------------------------
// addListMembers
// ----------------------------------------------------------------

export async function addListMembers(
  listId: string,
  accountId: string,
  memberAccountIds: string[],
): Promise<boolean> {
  const uniqueMemberIds = [...new Set(memberAccountIds)];
  const permittedMembers = await Promise.all(uniqueMemberIds.map(async (memberId) => ({
    memberId,
    followId: await assertListMemberAddable(listId, accountId, memberId),
  })));

  const stmts: D1PreparedStatement[] = [];
  for (const member of permittedMembers) {
    stmts.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO list_accounts (list_id, account_id, follow_id) VALUES (?1, ?2, ?3)',
      ).bind(listId, member.memberId, member.followId),
    );
  }

  const results = await env.DB.batch(stmts);
  return results.some((result) => (result.meta?.changes ?? 0) > 0);
}

// ----------------------------------------------------------------
// removeListMembers
// ----------------------------------------------------------------

export async function removeListMembers(
  listId: string,
  accountId: string,
  memberAccountIds: string[],
): Promise<boolean> {
  const list = await env.DB
    .prepare('SELECT id FROM lists WHERE id = ?1 AND account_id = ?2')
    .bind(listId, accountId)
    .first();

  if (!list) {
    throw new AppError(404, 'Record not found');
  }

  const stmts: D1PreparedStatement[] = [];
  for (const memberId of memberAccountIds) {
    stmts.push(
      env.DB.prepare(
        'DELETE FROM list_accounts WHERE list_id = ?1 AND account_id = ?2',
      ).bind(listId, memberId),
    );
  }

  const results = await env.DB.batch(stmts);
  return results.some((result) => (result.meta?.changes ?? 0) > 0);
}
