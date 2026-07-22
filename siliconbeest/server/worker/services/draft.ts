import { env } from 'cloudflare:workers';

const MAX_DRAFTS_PER_USER = 50;

type DraftRow = {
  id: string;
  revision: number;
  payload: string;
  created_at: string;
  updated_at: string;
};

export type StoredDraft = Record<string, unknown> & {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type UpsertDraftResult = {
  draft: StoredDraft | null;
  conflict: boolean;
};

function serializeRow(row: DraftRow): StoredDraft | null {
  try {
    const draft: unknown = JSON.parse(row.payload);
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;
    return {
      ...(draft as Record<string, unknown>),
      id: row.id,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

export async function listDrafts(userId: string): Promise<StoredDraft[]> {
  const { results } = await env.DB_META_C000.prepare(`
    SELECT id, revision, payload, created_at, updated_at
    FROM post_drafts
    WHERE user_id = ?1
    ORDER BY updated_at DESC
    LIMIT ?2
  `).bind(userId, MAX_DRAFTS_PER_USER).all<DraftRow>();

  return results.flatMap((row) => {
    const draft = serializeRow(row);
    return draft ? [draft] : [];
  });
}

export async function upsertDraft(
  userId: string,
  id: string,
  revision: number,
  payload: string,
): Promise<UpsertDraftResult> {
  const now = new Date().toISOString();

  const statements = [
    env.DB_META_C000.prepare(`
      INSERT INTO post_drafts (user_id, id, revision, payload, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT(user_id, id) DO UPDATE SET
        revision = excluded.revision,
        payload = excluded.payload,
        updated_at = excluded.updated_at
      WHERE excluded.revision > post_drafts.revision
    `).bind(userId, id, revision, payload, now),
  ];

  if (revision === 1) {
    statements.push(
      env.DB_META_C000.prepare(`
        DELETE FROM post_drafts
        WHERE user_id = ?1
          AND id NOT IN (
            SELECT id FROM post_drafts
            WHERE user_id = ?1
            ORDER BY updated_at DESC
            LIMIT ?2
          )
      `).bind(userId, MAX_DRAFTS_PER_USER),
    );
  }

  const [writeResult] = await env.DB_META_C000.batch(statements);

  const row = await env.DB_META_C000.prepare(`
    SELECT id, revision, payload, created_at, updated_at
    FROM post_drafts
    WHERE user_id = ?1 AND id = ?2
    LIMIT 1
  `).bind(userId, id).first<DraftRow>();
  return {
    draft: row ? serializeRow(row) : null,
    conflict: writeResult?.meta.changes === 0
      && row?.revision === revision
      && row.payload !== payload,
  };
}

export async function removeDraft(userId: string, id: string): Promise<void> {
  await env.DB_META_C000.prepare(
    'DELETE FROM post_drafts WHERE user_id = ?1 AND id = ?2',
  ).bind(userId, id).run();
}
