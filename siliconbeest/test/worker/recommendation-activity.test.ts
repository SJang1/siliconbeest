import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildRecommendationInterestQuery,
  createRecommendedTimelinePage,
  type RecommendationModelRunner,
} from '../../server/worker/services/recommendation';
import {
  readRecommendationActivities,
  recordRecommendationActivity,
  RECOMMENDATION_ACTIVITY_LIMIT,
} from '../../server/worker/services/recommendationActivity';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const MODEL = '@cf/baai/bge-m3';
const RECOMMENDATION_KV_PREFIXES = [
  'workers-ai:recommended:v2',
  'workers-ai:recommended-page:v2',
] as const;

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
type StatusVisibility = 'public' | 'unlisted' | 'private' | 'direct';
type CreatedStatus = { readonly id: string };
type ActivityRow = {
  readonly account_id: string;
  readonly activity_kind: 'posted' | 'reposted' | 'liked';
  readonly status_id: string;
  readonly occurred_at: string;
};

async function createStatus(
  user: TestUser,
  status: string,
  visibility: StatusVisibility,
): Promise<CreatedStatus> {
  const response = await SELF.fetch(`${BASE}/api/v1/statuses`, {
    method: 'POST',
    headers: authHeaders(user.token),
    body: JSON.stringify({ status, visibility }),
  });
  expect(response.status).toBe(200);
  return response.json<CreatedStatus>();
}

async function postStatusAction(
  user: TestUser,
  statusId: string,
  action: 'favourite' | 'unfavourite' | 'reblog' | 'unreblog',
): Promise<Response> {
  return SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/${action}`, {
    method: 'POST',
    headers: authHeaders(user.token),
  });
}

async function rawActivities(accountId: string): Promise<ActivityRow[]> {
  const { results } = await env.DB_META_C000.prepare(
    `SELECT account_id, activity_kind, status_id, occurred_at
     FROM recommendation_activities
     WHERE account_id = ?
     ORDER BY occurred_at DESC, status_id DESC, activity_kind`,
  ).bind(accountId).all<ActivityRow>();
  return results ?? [];
}

function activityKeys(rows: readonly ActivityRow[]): string[] {
  return rows
    .map((row) => `${row.activity_kind}:${row.status_id}`)
    .sort();
}

async function waitForActivityKeys(
  accountId: string,
  expected: readonly string[],
): Promise<void> {
  await vi.waitFor(async () => {
    expect(activityKeys(await rawActivities(accountId))).toEqual([...expected].sort());
  }, { timeout: 5_000 });
}

async function insertPublicStatus(
  authorAccountId: string,
  marker: string,
  createdAt: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB_META_C000.prepare(
    `INSERT INTO statuses (
       id, uri, account_id, text, content, visibility, language, local,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'public', 'en', 1, ?, ?)`,
  ).bind(
    id,
    `${BASE}/activities/statuses/${id}`,
    authorAccountId,
    marker,
    `<p>${marker}</p>`,
    createdAt,
    createdAt,
  ).run();
  return id;
}

async function clearRecommendationKv(): Promise<void> {
  for (const prefix of RECOMMENDATION_KV_PREFIXES) {
    const { keys } = await env.CACHE.list({ prefix });
    await Promise.all(keys.map((key) => env.CACHE.delete(key.name)));
  }
}

function capturingRunner(queries: string[]): RecommendationModelRunner {
  return async (_model, input) => {
    const query = input.query;
    const contexts = input.contexts;
    if (typeof query !== 'string' || !Array.isArray(contexts)) {
      throw new Error('Expected recommendation query and contexts');
    }
    queries.push(query);
    return {
      response: contexts.map((_, id) => ({ id, score: contexts.length - id })),
    };
  };
}

describe('D1 recommendation activity history', () => {
  beforeAll(async () => {
    await applyMigration();
  });

  it('records only public post, like, and repost signals through HTTP background tasks', async () => {
    const actor = await createTestUser('activity-http-actor');
    const author = await createTestUser('activity-http-author');
    const follow = await SELF.fetch(`${BASE}/api/v1/accounts/${author.accountId}/follow`, {
      method: 'POST',
      headers: authHeaders(actor.token),
    });
    expect(follow.status).toBe(200);

    const ownPublic = await createStatus(actor, 'own public activity signal', 'public');
    const ownUnlisted = await createStatus(actor, 'own unlisted excluded signal', 'unlisted');
    const ownPrivate = await createStatus(actor, 'own private excluded signal', 'private');
    const ownDirect = await createStatus(
      actor,
      '@activity-http-author own direct excluded signal',
      'direct',
    );

    const targetPublic = await createStatus(author, 'target public activity signal', 'public');
    const targetUnlisted = await createStatus(author, 'target unlisted excluded signal', 'unlisted');
    const targetPrivate = await createStatus(author, 'target private excluded signal', 'private');
    const targetDirect = await createStatus(
      author,
      '@activity-http-actor target direct excluded signal',
      'direct',
    );

    for (const status of [targetPublic, targetUnlisted, targetPrivate]) {
      expect((await postStatusAction(actor, status.id, 'favourite')).status).toBe(200);
    }
    expect((await postStatusAction(actor, targetDirect.id, 'favourite')).status).toBe(404);
    expect((await postStatusAction(actor, targetPublic.id, 'reblog')).status).toBe(200);
    expect((await postStatusAction(actor, targetUnlisted.id, 'reblog')).status).toBe(200);
    expect((await postStatusAction(actor, targetPrivate.id, 'reblog')).status).toBe(422);
    expect((await postStatusAction(actor, targetDirect.id, 'reblog')).status).toBe(404);

    await waitForActivityKeys(actor.accountId, [
      `posted:${ownPublic.id}`,
      `liked:${targetPublic.id}`,
      `reposted:${targetPublic.id}`,
    ]);

    const excludedIds = [
      ownUnlisted.id,
      ownPrivate.id,
      ownDirect.id,
      targetUnlisted.id,
      targetPrivate.id,
      targetDirect.id,
    ];
    const placeholders = excludedIds.map(() => '?').join(', ');
    const excludedCount = await env.DB_META_C000.prepare(
      `SELECT COUNT(*) AS count
       FROM recommendation_activities
       WHERE account_id = ?
         AND status_id IN (${placeholders})`,
    ).bind(actor.accountId, ...excludedIds).first<{ count: number }>();
    expect(excludedCount?.count).toBe(0);
  });

  it('removes signals after unfavourite, unreblog, and status deletion', async () => {
    const actor = await createTestUser('activity-cleanup-actor');
    const author = await createTestUser('activity-cleanup-author');
    const observer = await createTestUser('activity-cleanup-observer');
    const target = await createStatus(author, 'cleanup target activity', 'public');
    const owned = await createStatus(actor, 'cleanup owned activity', 'public');

    expect((await postStatusAction(actor, target.id, 'favourite')).status).toBe(200);
    expect((await postStatusAction(actor, target.id, 'reblog')).status).toBe(200);
    expect((await postStatusAction(observer, owned.id, 'favourite')).status).toBe(200);

    await waitForActivityKeys(actor.accountId, [
      `posted:${owned.id}`,
      `liked:${target.id}`,
      `reposted:${target.id}`,
    ]);
    await waitForActivityKeys(observer.accountId, [`liked:${owned.id}`]);

    expect((await postStatusAction(actor, target.id, 'unfavourite')).status).toBe(200);
    expect((await postStatusAction(actor, target.id, 'unreblog')).status).toBe(200);
    const deletion = await SELF.fetch(`${BASE}/api/v1/statuses/${owned.id}`, {
      method: 'DELETE',
      headers: authHeaders(actor.token),
    });
    expect(deletion.status).toBe(200);

    await waitForActivityKeys(actor.accountId, []);
    await waitForActivityKeys(observer.accountId, []);
    await vi.waitFor(async () => {
      const deletedStatusSignals = await env.DB_META_C000.prepare(
        `SELECT COUNT(*) AS count
         FROM recommendation_activities
         WHERE status_id = ?`,
      ).bind(owned.id).first<{ count: number }>();
      const targetSignals = await env.DB_META_C000.prepare(
        `SELECT account_id, activity_kind, status_id, occurred_at
         FROM recommendation_activities
         WHERE status_id = ?`,
      ).bind(target.id).all<ActivityRow>();
      expect(deletedStatusSignals?.count).toBe(0);
      expect(activityKeys(targetSignals.results ?? [])).toEqual([`posted:${target.id}`]);
      expect(targetSignals.results?.[0]?.account_id).toBe(author.accountId);
    }, { timeout: 5_000 });
  });

  it('retains the newest 30 signals per account without pruning another account', async () => {
    const viewer = await createTestUser('activity-cap-viewer');
    const otherViewer = await createTestUser('activity-cap-other');
    const author = await createTestUser('activity-cap-author');
    const baseTime = Date.parse('2025-01-01T00:00:00.000Z');
    const statusIds: string[] = [];

    for (let index = 0; index < RECOMMENDATION_ACTIVITY_LIMIT + 2; index += 1) {
      const occurredAt = new Date(baseTime + index * 1_000).toISOString();
      const statusId = await insertPublicStatus(
        author.accountId,
        `cap activity signal ${index}`,
        occurredAt,
      );
      statusIds.push(statusId);
    }

    await recordRecommendationActivity(
      otherViewer.accountId,
      'liked',
      statusIds[0]!,
      new Date(baseTime - 1_000).toISOString(),
    );
    for (const [index, statusId] of statusIds.entries()) {
      await recordRecommendationActivity(
        viewer.accountId,
        'liked',
        statusId,
        new Date(baseTime + index * 1_000).toISOString(),
      );
    }

    const retained = await rawActivities(viewer.accountId);
    expect(retained).toHaveLength(RECOMMENDATION_ACTIVITY_LIMIT);
    expect(retained.map((row) => row.status_id)).not.toContain(statusIds[0]);
    expect(retained.map((row) => row.status_id)).not.toContain(statusIds[1]);
    expect(new Set(retained.map((row) => row.status_id))).toEqual(
      new Set(statusIds.slice(2)),
    );
    expect(activityKeys(await rawActivities(otherViewer.accountId))).toEqual([
      `liked:${statusIds[0]}`,
    ]);
  });

  it('uses all 30 D1 signals for the model query across fresh feeds and KV clearing', async () => {
    const viewer = await createTestUser('activity-persistence-viewer');
    const author = await createTestUser('activity-persistence-author');
    const baseTime = Date.parse('2025-02-01T00:00:00.000Z');
    const markers = Array.from(
      { length: RECOMMENDATION_ACTIVITY_LIMIT },
      (_, index) => `d1-persisted-signal-${String(index).padStart(2, '0')}`,
    );

    for (const [index, marker] of markers.entries()) {
      const occurredAt = new Date(baseTime + index * 1_000).toISOString();
      const statusId = await insertPublicStatus(author.accountId, marker, occurredAt);
      await recordRecommendationActivity(viewer.accountId, 'liked', statusId, occurredAt);
    }

    const stored = await readRecommendationActivities(viewer.accountId);
    expect(stored).toHaveLength(RECOMMENDATION_ACTIVITY_LIMIT);
    expect(new Set(stored.map((activity) => activity.text))).toEqual(new Set(markers));

    const expectedQuery = await buildRecommendationInterestQuery(viewer.accountId);
    for (const marker of markers) expect(expectedQuery).toContain(marker);

    await clearRecommendationKv();
    const capturedQueries: string[] = [];
    await createRecommendedTimelinePage(
      viewer.accountId,
      1,
      MODEL,
      capturingRunner(capturedQueries),
      'd1-activity-first-fresh-feed',
    );

    const keysBeforeClear = (await Promise.all(
      RECOMMENDATION_KV_PREFIXES.map((prefix) => env.CACHE.list({ prefix })),
    )).flatMap((result) => result.keys);
    expect(keysBeforeClear.length).toBeGreaterThan(0);
    await clearRecommendationKv();
    for (const prefix of RECOMMENDATION_KV_PREFIXES) {
      expect((await env.CACHE.list({ prefix })).keys).toEqual([]);
    }

    await createRecommendedTimelinePage(
      viewer.accountId,
      1,
      MODEL,
      capturingRunner(capturedQueries),
      'd1-activity-second-fresh-feed',
    );

    expect(capturedQueries).toEqual([expectedQuery, expectedQuery]);
    for (const query of capturedQueries) {
      for (const marker of markers) expect(query).toContain(marker);
    }
  });

  it('revalidates status privacy when reading a previously stored signal', async () => {
    const viewer = await createTestUser('activity-privacy-viewer');
    const author = await createTestUser('activity-privacy-author');
    const marker = 'read-time-privacy-revalidation-marker';
    const occurredAt = '2025-03-01T00:00:00.000Z';
    const statusId = await insertPublicStatus(author.accountId, marker, occurredAt);
    await recordRecommendationActivity(viewer.accountId, 'liked', statusId, occurredAt);

    expect((await readRecommendationActivities(viewer.accountId)).map((row) => row.statusId))
      .toEqual([statusId]);

    await env.DB_META_C000.prepare(
      `UPDATE statuses
       SET visibility = 'private', updated_at = ?
       WHERE id = ?`,
    ).bind(new Date().toISOString(), statusId).run();

    const raw = await rawActivities(viewer.accountId);
    expect(raw.map((row) => row.status_id)).toEqual([statusId]);
    expect(await readRecommendationActivities(viewer.accountId)).toEqual([]);
    expect(await buildRecommendationInterestQuery(viewer.accountId)).not.toContain(marker);
  });
});
