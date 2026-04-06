import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';
import { serializeFilter } from '../utils/mastodonSerializer';
import { AppError } from '../middleware/errorHandler';
import type { FilterRow } from '../types/db';

// ----------------------------------------------------------------
// fetchFilterWithKeywords (internal helper)
// ----------------------------------------------------------------

export async function fetchFilterWithKeywords(filterId: string) {
  const filter = await env.DB
    .prepare('SELECT * FROM filters WHERE id = ?1')
    .bind(filterId)
    .first<FilterRow>();

  if (!filter) return null;

  const { results: keywords } = await env.DB
    .prepare('SELECT id, keyword, whole_word FROM filter_keywords WHERE filter_id = ?1')
    .bind(filterId)
    .all();

  const { results: statuses } = await env.DB
    .prepare('SELECT id, status_id FROM filter_statuses WHERE filter_id = ?1')
    .bind(filterId)
    .all();

  return serializeFilter(filter, {
    keywords: (keywords ?? []) as Array<{ id: string; keyword: string; whole_word: number }>,
    statuses: (statuses ?? []) as Array<{ id: string; status_id: string }>,
  });
}

// ----------------------------------------------------------------
// listFilters
// ----------------------------------------------------------------

export async function listFilters(userId: string) {
  const { results: filters } = await env.DB
    .prepare('SELECT * FROM filters WHERE user_id = ?1 ORDER BY created_at DESC')
    .bind(userId)
    .all();

  const serialized = [];
  for (const row of filters ?? []) {
    const filter = await fetchFilterWithKeywords(row.id as string);
    if (filter) serialized.push(filter);
  }

  return serialized;
}

// ----------------------------------------------------------------
// getFilter
// ----------------------------------------------------------------

export async function getFilter(filterId: string, userId: string) {
  const filter = await env.DB
    .prepare('SELECT * FROM filters WHERE id = ?1 AND user_id = ?2')
    .bind(filterId, userId)
    .first<FilterRow>();

  if (!filter) {
    throw new AppError(404, 'Record not found');
  }

  return fetchFilterWithKeywords(filterId);
}

// ----------------------------------------------------------------
// createFilter
// ----------------------------------------------------------------

export interface CreateFilterData {
  title: string;
  context: string[];
  filter_action?: string;
  expires_in?: number;
  keywords_attributes?: Array<{ keyword: string; whole_word?: boolean }>;
}

export async function createFilter(userId: string, data: CreateFilterData) {
  const filterId = generateUlid();
  const now = new Date().toISOString();
  const filterAction = data.filter_action || 'warn';
  let expiresAt: string | null = null;

  if (data.expires_in && data.expires_in > 0) {
    expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  }

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO filters (id, user_id, title, context, action, expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    ).bind(filterId, userId, data.title, JSON.stringify(data.context), filterAction, expiresAt, now),
  ];

  if (data.keywords_attributes) {
    for (const kw of data.keywords_attributes) {
      const kwId = generateUlid();
      stmts.push(
        env.DB.prepare(
          'INSERT INTO filter_keywords (id, filter_id, keyword, whole_word, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
        ).bind(kwId, filterId, kw.keyword, kw.whole_word ? 1 : 0, now),
      );
    }
  }

  await env.DB.batch(stmts);

  return fetchFilterWithKeywords(filterId);
}

// ----------------------------------------------------------------
// updateFilter
// ----------------------------------------------------------------

export interface UpdateFilterData {
  title?: string;
  context?: string[];
  filter_action?: string;
  expires_in?: number;
  keywords_attributes?: Array<{ id?: string; keyword?: string; whole_word?: boolean; _destroy?: boolean }>;
}

export async function updateFilter(filterId: string, userId: string, data: UpdateFilterData) {
  const existing = await env.DB
    .prepare('SELECT * FROM filters WHERE id = ?1 AND user_id = ?2')
    .bind(filterId, userId)
    .first<FilterRow>();

  if (!existing) {
    throw new AppError(404, 'Record not found');
  }

  const now = new Date().toISOString();
  const title = data.title ?? existing.title;
  const context = data.context ? JSON.stringify(data.context) : existing.context;
  const action = data.filter_action ?? existing.action;
  let expiresAt = existing.expires_at;

  if (data.expires_in !== undefined) {
    expiresAt =
      data.expires_in && data.expires_in > 0
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : null;
  }

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      'UPDATE filters SET title = ?1, context = ?2, action = ?3, expires_at = ?4, updated_at = ?5 WHERE id = ?6',
    ).bind(title, context, action, expiresAt, now, filterId),
  ];

  if (data.keywords_attributes) {
    for (const kw of data.keywords_attributes) {
      if (kw._destroy && kw.id) {
        stmts.push(
          env.DB.prepare('DELETE FROM filter_keywords WHERE id = ?1 AND filter_id = ?2').bind(kw.id, filterId),
        );
      } else if (kw.id) {
        if (kw.keyword !== undefined) {
          stmts.push(
            env.DB.prepare(
              'UPDATE filter_keywords SET keyword = ?1, whole_word = ?2, updated_at = ?3 WHERE id = ?4 AND filter_id = ?5',
            ).bind(kw.keyword, kw.whole_word ? 1 : 0, now, kw.id, filterId),
          );
        }
      } else if (kw.keyword) {
        const kwId = generateUlid();
        stmts.push(
          env.DB.prepare(
            'INSERT INTO filter_keywords (id, filter_id, keyword, whole_word, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
          ).bind(kwId, filterId, kw.keyword, kw.whole_word ? 1 : 0, now),
        );
      }
    }
  }

  await env.DB.batch(stmts);

  return fetchFilterWithKeywords(filterId);
}

// ----------------------------------------------------------------
// deleteFilter
// ----------------------------------------------------------------

export async function deleteFilter(filterId: string, userId: string): Promise<void> {
  const existing = await env.DB
    .prepare('SELECT id FROM filters WHERE id = ?1 AND user_id = ?2')
    .bind(filterId, userId)
    .first();

  if (!existing) {
    throw new AppError(404, 'Record not found');
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM filter_keywords WHERE filter_id = ?1').bind(filterId),
    env.DB.prepare('DELETE FROM filter_statuses WHERE filter_id = ?1').bind(filterId),
    env.DB.prepare('DELETE FROM filters WHERE id = ?1').bind(filterId),
  ]);
}

// ----------------------------------------------------------------
// verifyFilterOwnership (internal helper for keyword endpoints)
// ----------------------------------------------------------------

export async function verifyFilterOwnership(filterId: string, userId: string): Promise<void> {
  const filter = await env.DB
    .prepare('SELECT id FROM filters WHERE id = ?1 AND user_id = ?2')
    .bind(filterId, userId)
    .first();

  if (!filter) {
    throw new AppError(404, 'Record not found');
  }
}

// ----------------------------------------------------------------
// addFilterKeyword
// ----------------------------------------------------------------

export async function addFilterKeyword(
  filterId: string,
  userId: string,
  keyword: string,
  wholeWord: boolean,
) {
  await verifyFilterOwnership(filterId, userId);

  const kwId = generateUlid();
  const now = new Date().toISOString();

  await env.DB
    .prepare(
      'INSERT INTO filter_keywords (id, filter_id, keyword, whole_word, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
    )
    .bind(kwId, filterId, keyword, wholeWord ? 1 : 0, now)
    .run();

  return {
    id: kwId,
    keyword,
    whole_word: wholeWord,
  };
}

// ----------------------------------------------------------------
// listFilterKeywords
// ----------------------------------------------------------------

export async function listFilterKeywords(filterId: string, userId: string) {
  await verifyFilterOwnership(filterId, userId);

  const { results } = await env.DB
    .prepare('SELECT * FROM filter_keywords WHERE filter_id = ?1 ORDER BY created_at ASC')
    .bind(filterId)
    .all();

  return (results ?? []).map((row: any) => ({
    id: row.id as string,
    keyword: row.keyword as string,
    whole_word: !!(row.whole_word as number),
  }));
}

// ----------------------------------------------------------------
// deleteFilterKeyword
// ----------------------------------------------------------------

export async function deleteFilterKeyword(
  filterId: string,
  keywordId: string,
  userId: string,
): Promise<void> {
  await verifyFilterOwnership(filterId, userId);

  const kw = await env.DB
    .prepare('SELECT id FROM filter_keywords WHERE id = ?1 AND filter_id = ?2')
    .bind(keywordId, filterId)
    .first();

  if (!kw) {
    throw new AppError(404, 'Record not found');
  }

  await env.DB.prepare('DELETE FROM filter_keywords WHERE id = ?1').bind(keywordId).run();
}
