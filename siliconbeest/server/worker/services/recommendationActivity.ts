import { env } from 'cloudflare:workers';
import type { RecommendationActivityKind } from '../types/db';

export type { RecommendationActivityKind } from '../types/db';

export const RECOMMENDATION_ACTIVITY_LIMIT = 30;

export type RecommendationActivity = {
  readonly activityKind: RecommendationActivityKind;
  readonly statusId: string;
  readonly occurredAt: string;
  readonly text: string;
  readonly language: string;
  readonly tags: readonly string[];
};

type RecommendationActivityRow = {
  readonly activity_kind: RecommendationActivityKind;
  readonly status_id: string;
  readonly occurred_at: string;
  readonly text: string;
  readonly language: string;
  readonly tags_json: string;
};

/**
 * Store a recommendation signal only while its source status is a current,
 * public, non-deleted original. Posting additionally requires ownership.
 * The insert/upsert and per-account retention prune run atomically in D1.
 */
export async function recordRecommendationActivity(
  accountId: string,
  activityKind: RecommendationActivityKind,
  statusId: string,
  occurredAt = new Date().toISOString(),
): Promise<void> {
  await env.DB_META_C000.batch([
    env.DB_META_C000.prepare(
      `INSERT INTO recommendation_activities (
         account_id,
         activity_kind,
         status_id,
         occurred_at
       )
       SELECT ?, ?, s.id, ?
       FROM statuses s
       WHERE s.id = ?
         AND s.visibility = 'public'
         AND s.deleted_at IS NULL
         AND s.reblog_of_id IS NULL
         AND (? != 'posted' OR s.account_id = ?)
       ON CONFLICT (account_id, activity_kind, status_id)
       DO UPDATE SET occurred_at = excluded.occurred_at`,
    ).bind(
      accountId,
      activityKind,
      occurredAt,
      statusId,
      activityKind,
      accountId,
    ),
    env.DB_META_C000.prepare(
      `DELETE FROM recommendation_activities
       WHERE account_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM (
             SELECT activity_kind, status_id
             FROM recommendation_activities
             WHERE account_id = ?
             ORDER BY occurred_at DESC, status_id DESC, activity_kind
             LIMIT ?
           ) retained
           WHERE retained.activity_kind = recommendation_activities.activity_kind
             AND retained.status_id = recommendation_activities.status_id
         )`,
    ).bind(accountId, accountId, RECOMMENDATION_ACTIVITY_LIMIT),
  ]);
}

export async function removeRecommendationActivity(
  accountId: string,
  activityKind: RecommendationActivityKind,
  statusId: string,
): Promise<void> {
  await env.DB_META_C000.prepare(
    `DELETE FROM recommendation_activities
     WHERE account_id = ?
       AND activity_kind = ?
       AND status_id = ?`,
  ).bind(accountId, activityKind, statusId).run();
}

export async function removeRecommendationActivitiesForStatus(
  statusId: string,
): Promise<void> {
  await env.DB_META_C000.prepare(
    `DELETE FROM recommendation_activities
     WHERE status_id = ?`,
  ).bind(statusId).run();
}

/**
 * Read the bounded activity history and resolve status text and metadata at
 * read time, so stale or private/deleted content is never retained as a
 * recommendation snapshot.
 */
export async function readRecommendationActivities(
  accountId: string,
): Promise<readonly RecommendationActivity[]> {
  const { results } = await env.DB_META_C000.prepare(
    `SELECT ra.activity_kind,
            ra.status_id,
            ra.occurred_at,
            COALESCE(NULLIF(s.text, ''), s.content, '') AS text,
            COALESCE(s.language, '') AS language,
            COALESCE((
              SELECT json_group_array(tag_rows.name)
              FROM (
                SELECT t.name
                FROM status_tags st
                JOIN tags t ON t.id = st.tag_id
                WHERE st.status_id = s.id
                ORDER BY t.name
              ) tag_rows
            ), '[]') AS tags_json
     FROM recommendation_activities ra
     JOIN statuses s ON s.id = ra.status_id
     WHERE ra.account_id = ?
       AND s.visibility = 'public'
       AND s.deleted_at IS NULL
       AND s.reblog_of_id IS NULL
       AND (ra.activity_kind != 'posted' OR s.account_id = ra.account_id)
     ORDER BY ra.occurred_at DESC, ra.status_id DESC, ra.activity_kind
     LIMIT ?`,
  ).bind(accountId, RECOMMENDATION_ACTIVITY_LIMIT).all<RecommendationActivityRow>();

  return (results ?? []).map((row) => {
    const parsedTags: unknown = JSON.parse(row.tags_json);
    const tags = Array.isArray(parsedTags)
      ? parsedTags.filter((tag): tag is string => typeof tag === 'string')
      : [];

    return {
      activityKind: row.activity_kind,
      statusId: row.status_id,
      occurredAt: row.occurred_at,
      text: row.text,
      language: row.language,
      tags,
    };
  });
}
