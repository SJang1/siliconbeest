import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildRecommendationInterestQuery,
  continueRecommendedTimelinePage,
  createRecommendedTimelinePage,
  describeRecommendationGenerationFailure,
  rankRecommendationCandidates,
  RECOMMENDATION_CANDIDATE_LIMIT,
  RECOMMENDATION_DEFAULT_PAGE_LIMIT,
  RECOMMENDATION_INTEREST_MAX_CHARS,
  RecommendationGenerationError,
  sampleRecommendationCandidates,
} from '../../server/worker/services/recommendation';
import {
  getRecommendationCandidateWindow,
  RECOMMENDATION_HOME_SOURCE_LIMIT,
  RECOMMENDATION_PUBLIC_SOURCE_LIMIT,
} from '../../server/worker/services/timeline';
import { cacheWorkersAiFeatureFlags } from '../../server/worker/services/workersAiFeatures';
import { generateUlid } from '../../server/worker/utils/ulid';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const MODEL = '@cf/baai/bge-m3';

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

type CreatedStatus = {
  id: string;
};

async function createStatus(
  user: TestUser,
  status: string,
  visibility: 'public' | 'unlisted' | 'private' | 'direct',
  sensitive = false,
): Promise<CreatedStatus> {
  const response = await SELF.fetch(`${BASE}/api/v1/statuses`, {
    method: 'POST',
    headers: authHeaders(user.token),
    body: JSON.stringify({ status, visibility, sensitive }),
  });
  expect(response.status).toBe(200);
  return response.json<CreatedStatus>();
}

function indexedRunner(
  capture?: (input: Record<string, unknown>) => void,
  equalScores = false,
) {
  return async (_model: string, input: Record<string, unknown>) => {
    capture?.(input);
    const contexts = input.contexts;
    if (!Array.isArray(contexts)) throw new Error('missing contexts');
    return {
      response: contexts.map((_, id) => ({
        id,
        score: equalScores ? 1 : contexts.length - id,
      })),
    };
  };
}

describe('AI recommended timeline', () => {
  let viewer: TestUser;
  let followed: TestUser;
  let publicAuthor: TestUser;
  let mutedAuthor: TestUser;
  let scopeLimited: TestUser;
  let viewerPublic: CreatedStatus;
  let publicStatus: CreatedStatus;
  let privateFollowed: CreatedStatus;
  let unlistedFollowed: CreatedStatus;
  let directFollowed: CreatedStatus;
  let privateStranger: CreatedStatus;
  let mutedPublic: CreatedStatus;
  let sensitivePublic: CreatedStatus;
  let boostedOriginal: CreatedStatus;

  beforeAll(async () => {
    await applyMigration();
    viewer = await createTestUser('recommendviewer');
    followed = await createTestUser('recommendfollowed');
    publicAuthor = await createTestUser('recommendpublic');
    mutedAuthor = await createTestUser('recommendmuted');
    scopeLimited = await createTestUser('recommendscope', { scopes: 'read:accounts' });

    const follow = await SELF.fetch(`${BASE}/api/v1/accounts/${followed.accountId}/follow`, {
      method: 'POST',
      headers: authHeaders(viewer.token),
    });
    expect(follow.status).toBe(200);

    viewerPublic = await createStatus(
      viewer,
      'My public interest is #cloudflare',
      'public',
    );
    publicStatus = await createStatus(
      publicAuthor,
      `${'public candidate '.repeat(35)} https://example.test secret@example.test @somebody #favtopic`,
      'public',
    );
    privateStranger = await createStatus(
      publicAuthor,
      'unauthorized private stranger content',
      'private',
    );
    privateFollowed = await createStatus(
      followed,
      'authorized private follower content',
      'private',
    );
    unlistedFollowed = await createStatus(
      followed,
      'authorized unlisted follower content',
      'unlisted',
    );
    directFollowed = await createStatus(
      followed,
      '@recommendviewer direct message must never be ranked',
      'direct',
    );
    mutedPublic = await createStatus(
      mutedAuthor,
      'muted public content must never be ranked',
      'public',
    );
    sensitivePublic = await createStatus(
      publicAuthor,
      'sensitive but visible public candidate',
      'public',
      true,
    );
    boostedOriginal = await createStatus(
      publicAuthor,
      'unlisted original reached through an eligible home boost',
      'unlisted',
    );

    const favourite = await SELF.fetch(`${BASE}/api/v1/statuses/${publicStatus.id}/favourite`, {
      method: 'POST',
      headers: authHeaders(viewer.token),
    });
    expect(favourite.status).toBe(200);

    const mute = await SELF.fetch(`${BASE}/api/v1/accounts/${mutedAuthor.accountId}/mute`, {
      method: 'POST',
      headers: authHeaders(viewer.token),
      body: JSON.stringify({}),
    });
    expect(mute.status).toBe(200);

    const boost = await SELF.fetch(`${BASE}/api/v1/statuses/${boostedOriginal.id}/reblog`, {
      method: 'POST',
      headers: authHeaders(followed.token),
    });
    expect(boost.status).toBe(200);
  });

  it('strictly validates indexed-score output', () => {
    const candidates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(rankRecommendationCandidates(candidates, {
      response: [
        { id: 0, score: 0.1 },
        { id: 1, score: 0.9 },
        { id: 2, score: 0.5 },
      ],
    })?.map((row) => row.id)).toEqual(['b', 'c', 'a']);

    expect(rankRecommendationCandidates(candidates, {
      response: [{ id: 0, score: 1 }, { id: 0, score: 0.5 }, { id: 2, score: 0.1 }],
    })).toBeNull();
    expect(rankRecommendationCandidates(candidates, {
      response: [{ id: 0, score: 1 }, { id: 1, score: Number.NaN }, { id: 2, score: 0.1 }],
    })).toBeNull();
    expect(rankRecommendationCandidates(candidates, {
      response: [{ id: 0, score: 1 }],
    })).toBeNull();
  });

  it('uses seeded equal-score diversity and defers author overflow without dropping it', () => {
    const equalScoreCandidates = [
      { id: 'status-a', account_id: 'author-a' },
      { id: 'status-b', account_id: 'author-b' },
      { id: 'status-c', account_id: 'author-c' },
      { id: 'status-d', account_id: 'author-d' },
      { id: 'status-e', account_id: 'author-e' },
      { id: 'status-f', account_id: 'author-f' },
    ];
    const equalScores = {
      response: equalScoreCandidates.map((_, id) => ({ id, score: 1 })),
    };
    const firstSnapshot = rankRecommendationCandidates(
      equalScoreCandidates,
      equalScores,
      'fresh-snapshot-one',
    )!.map((row) => row.id);
    const secondSnapshot = rankRecommendationCandidates(
      equalScoreCandidates,
      equalScores,
      'fresh-snapshot-two',
    )!.map((row) => row.id);
    expect(firstSnapshot[0]).not.toBe(secondSnapshot[0]);
    expect(firstSnapshot).not.toEqual(secondSnapshot);

    const authorHeavy = [
      { id: 'a-1', account_id: 'same-author' },
      { id: 'a-2', account_id: 'same-author' },
      { id: 'a-3', account_id: 'same-author' },
      { id: 'b-1', account_id: 'other-author' },
    ];
    expect(rankRecommendationCandidates(authorHeavy, {
      response: [
        { id: 0, score: 4 },
        { id: 1, score: 3 },
        { id: 2, score: 2 },
        { id: 3, score: 1 },
      ],
    }, 'author-diversity')?.map((row) => row.id)).toEqual([
      'a-1', 'a-2', 'b-1', 'a-3',
    ]);
  });

  it('varies nearby distinct-score results between fresh snapshots', () => {
    const candidates = [
      { id: 'one' },
      { id: 'two' },
      { id: 'three' },
      { id: 'four' },
      { id: 'five' },
      { id: 'six' },
    ];
    const output = {
      response: candidates.map((_, id) => ({ id, score: candidates.length - id })),
    };
    const first = rankRecommendationCandidates(candidates, output, 'fresh-snapshot-one')!;
    const second = rankRecommendationCandidates(candidates, output, 'fresh-snapshot-two')!;

    expect(first.map((row) => row.id)).not.toEqual(second.map((row) => row.id));
    expect(new Set(first.slice(0, 3).map((row) => row.id))).toEqual(
      new Set(['one', 'two', 'three']),
    );
    expect(new Set(second.slice(0, 3).map((row) => row.id))).toEqual(
      new Set(['one', 'two', 'three']),
    );
  });

  it('ranks the merged 250-public and 100-home candidate window', () => {
    expect(RECOMMENDATION_DEFAULT_PAGE_LIMIT).toBe(30);
    expect(RECOMMENDATION_PUBLIC_SOURCE_LIMIT).toBe(250);
    expect(RECOMMENDATION_HOME_SOURCE_LIMIT).toBe(100);
    expect(RECOMMENDATION_CANDIDATE_LIMIT).toBe(350);

    const candidates = Array.from({ length: 400 }, (_, index) => ({
      id: `candidate-${index}`,
    }));
    const first = sampleRecommendationCandidates(
      candidates,
      'candidate-pool-one',
      RECOMMENDATION_CANDIDATE_LIMIT,
    );
    const repeated = sampleRecommendationCandidates(
      candidates,
      'candidate-pool-one',
      RECOMMENDATION_CANDIDATE_LIMIT,
    );
    const refreshed = sampleRecommendationCandidates(
      candidates,
      'candidate-pool-two',
      RECOMMENDATION_CANDIDATE_LIMIT,
    );

    expect(first).toHaveLength(350);
    expect(new Set(first.map((row) => row.id))).toHaveLength(350);
    expect(repeated).toEqual(first);
    expect(refreshed).not.toEqual(first);
  });

  it('filters boosted originals before sending them to AI', async () => {
    const privacyAuthor = await createTestUser('recommendboostprivacy');
    const relationshipAuthor = await createTestUser('recommendboostrelation');
    const booster = await createTestUser('recommendboostwrapper');
    const followBooster = await SELF.fetch(
      `${BASE}/api/v1/accounts/${booster.accountId}/follow`,
      { method: 'POST', headers: authHeaders(viewer.token) },
    );
    expect(followBooster.status).toBe(200);

    const privateOriginal = await createStatus(
      privacyAuthor,
      'boost original changed to private permission marker',
      'unlisted',
    );
    const directOriginal = await createStatus(
      privacyAuthor,
      'boost original changed to direct permission marker',
      'unlisted',
    );
    const deletedOriginal = await createStatus(
      privacyAuthor,
      'boost original deleted permission marker',
      'unlisted',
    );
    const relationshipOriginal = await createStatus(
      relationshipAuthor,
      'boost original lost relationship permission marker',
      'unlisted',
    );
    const originals = [
      privateOriginal,
      directOriginal,
      deletedOriginal,
      relationshipOriginal,
    ];
    for (const original of originals) {
      const boost = await SELF.fetch(`${BASE}/api/v1/statuses/${original.id}/reblog`, {
        method: 'POST',
        headers: authHeaders(booster.token),
      });
      expect(boost.status).toBe(200);
    }

    const followOriginalAuthor = await SELF.fetch(
      `${BASE}/api/v1/accounts/${relationshipAuthor.accountId}/follow`,
      { method: 'POST', headers: authHeaders(viewer.token) },
    );
    expect(followOriginalAuthor.status).toBe(200);
    const changedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE statuses SET visibility = 'private', updated_at = ?1 WHERE id = ?2`,
      ).bind(changedAt, privateOriginal.id),
      env.DB.prepare(
        `UPDATE statuses SET visibility = 'direct', updated_at = ?1 WHERE id = ?2`,
      ).bind(changedAt, directOriginal.id),
      env.DB.prepare(
        'UPDATE statuses SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2',
      ).bind(changedAt, deletedOriginal.id),
      env.DB.prepare(
        'UPDATE accounts SET silenced_at = ?1 WHERE id = ?2',
      ).bind(changedAt, relationshipAuthor.accountId),
    ]);
    const unfollowOriginalAuthor = await SELF.fetch(
      `${BASE}/api/v1/accounts/${relationshipAuthor.accountId}/unfollow`,
      { method: 'POST', headers: authHeaders(viewer.token) },
    );
    expect(unfollowOriginalAuthor.status).toBe(200);
    let captured: Record<string, unknown> | undefined;
    await createRecommendedTimelinePage(
      viewer.accountId,
      40,
      MODEL,
      indexedRunner((input) => { captured = input; }),
      'boost-original-permission-revalidation',
    );
    const modelText = (captured?.contexts as Array<{ text: string }> | undefined)
      ?.map((context) => context.text)
      .join('\n') ?? '';
    expect(modelText).not.toContain('boost original changed to private permission marker');
    expect(modelText).not.toContain('boost original changed to direct permission marker');
    expect(modelText).not.toContain('boost original deleted permission marker');
    expect(modelText).not.toContain('boost original lost relationship permission marker');
  });

  it('merges bounded public and home sources before bulk permission checks', async () => {
    const prepare = vi.spyOn(env.DB, 'prepare');
    try {
      await getRecommendationCandidateWindow({
        viewerAccountId: viewer.accountId,
        upperBound: new Date(Date.now() + 60_000).toISOString(),
        excludedIds: [],
        limit: RECOMMENDATION_CANDIDATE_LIMIT,
      });

      const publicSourceQuery = prepare.mock.calls
        .map(([sql]) => sql)
        .find((sql) => sql.includes('recommendation-public-source'));
      const homeSourceQuery = prepare.mock.calls
        .map(([sql]) => sql)
        .find((sql) => sql.includes('recommendation-home-source'));
      expect(publicSourceQuery).toContain('INDEXED BY idx_statuses_recommendation_original_cursor');
      expect(publicSourceQuery).toContain("s.visibility = 'public'");
      expect(publicSourceQuery).toContain('excluded.id = s.id');
      expect(homeSourceQuery).toContain('INDEXED BY idx_statuses_timeline_cursor');
      expect(homeSourceQuery).toContain('COALESCE(s.reblog_of_id, s.id) AS candidate_id');
      expect(homeSourceQuery).toContain('home_follow');
      expect(homeSourceQuery).toContain('excluded.id = COALESCE(s.reblog_of_id, s.id)');
      expect(publicSourceQuery).not.toContain('relationship_author');
      expect(homeSourceQuery).not.toContain('relationship_author');
    } finally {
      prepare.mockRestore();
    }

    const { results: indexes } = await env.DB.prepare(
      'PRAGMA index_list(statuses)',
    ).all<{ name: string }>();
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'idx_statuses_recommendation_original_cursor',
      'idx_statuses_recommendation_boost_cursor',
    ]));

    const { results: domainBlockPlan } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT 1
       FROM user_domain_blocks
       WHERE account_id = ?
         AND lower(domain) = lower(?)`,
    ).bind(viewer.accountId, 'example.test').all<{ detail: string }>();
    expect(domainBlockPlan.map((step) => step.detail).join('\n')).toContain(
      'idx_user_domain_blocks_account_domain_lower',
    );
  });

  it('sends only the newest viewer-authored original to AI across pages', async () => {
    const olderOwnStatus = await createStatus(
      viewer,
      'older viewer-authored recommendation marker',
      'public',
    );
    const newestOwnStatus = await createStatus(
      viewer,
      'newest viewer-authored recommendation marker',
      'public',
    );
    const upperBound = new Date(Date.now() + 60_000).toISOString();

    const firstWindow = await getRecommendationCandidateWindow({
      viewerAccountId: viewer.accountId,
      upperBound,
      excludedIds: [],
      limit: RECOMMENDATION_CANDIDATE_LIMIT,
    });
    expect(firstWindow
      .filter((status) => status.account_id === viewer.accountId)
      .map((status) => status.id)).toEqual([newestOwnStatus.id]);

    const nextWindow = await getRecommendationCandidateWindow({
      viewerAccountId: viewer.accountId,
      upperBound,
      excludedIds: [newestOwnStatus.id],
      limit: RECOMMENDATION_CANDIDATE_LIMIT,
    });
    expect(nextWindow.some((status) => status.account_id === viewer.accountId)).toBe(false);

    let captured: Record<string, unknown> | undefined;
    await createRecommendedTimelinePage(
      viewer.accountId,
      1,
      MODEL,
      indexedRunner((input) => { captured = input; }),
      'newest-own-status-only',
    );
    const modelText = (captured?.contexts as Array<{ text: string }> | undefined)
      ?.map((context) => context.text)
      .join('\n') ?? '';
    expect(modelText).toContain('newest viewer-authored recommendation marker');
    expect(modelText).not.toContain('older viewer-authored recommendation marker');
    expect(modelText).not.toContain(olderOwnStatus.id);
  });

  it('sends only visible public or home-eligible candidates to AI', async () => {
    let captured: Record<string, unknown> | undefined;
    const page = await createRecommendedTimelinePage(
      viewer.accountId,
      40,
      MODEL,
      indexedRunner((input) => { captured = input; }),
      'candidate-permission-test',
    );

    expect(page.source).toBe('ai');
    const ids = page.rows.map((row) => row.id);
    expect(ids).toContain(publicStatus.id);
    expect(ids).toContain(privateFollowed.id);
    expect(ids).toContain(unlistedFollowed.id);
    expect(ids).toContain(sensitivePublic.id);
    expect(ids).toContain(boostedOriginal.id);
    expect(ids).not.toContain(viewerPublic.id);
    expect(ids).not.toContain(privateStranger.id);
    expect(ids).not.toContain(directFollowed.id);
    expect(ids).not.toContain(mutedPublic.id);

    expect(captured).toBeDefined();
    expect(captured?.truncate_inputs).toBe(true);
    const query = captured?.query;
    expect(typeof query).toBe('string');
    expect(query as string).toContain('#cloudflare');
    expect(query as string).toContain('#favtopic');
    expect((query as string).length).toBeLessThanOrEqual(RECOMMENDATION_INTEREST_MAX_CHARS);

    const contexts = captured?.contexts as Array<{ text: string }>;
    expect(contexts.every((context) => context.text.length <= 400)).toBe(true);
    const modelText = contexts.map((context) => context.text).join('\n');
    expect(modelText).toContain('authorized private follower content');
    expect(modelText).toContain('unlisted original reached through an eligible home boost');
    expect(modelText).not.toContain('unauthorized private stranger content');
    expect(modelText).not.toContain('direct message must never be ranked');
    expect(modelText).not.toContain('muted public content must never be ranked');
    expect(modelText).not.toContain('https://example.test');
    expect(modelText).not.toContain('secret@example.test');
    expect(modelText).not.toContain('@somebody');
  });

  it('builds a bounded profile from recent public posts, likes, and reposts', async () => {
    const repostSource = await createStatus(
      publicAuthor,
      'recent repost interest marker #reposttopic https://example.test private@example.test @mention',
      'public',
    );
    const repost = await SELF.fetch(`${BASE}/api/v1/statuses/${repostSource.id}/reblog`, {
      method: 'POST',
      headers: authHeaders(viewer.token),
    });
    expect(repost.status).toBe(200);

    const privateFavourite = await SELF.fetch(
      `${BASE}/api/v1/statuses/${privateFollowed.id}/favourite`,
      { method: 'POST', headers: authHeaders(viewer.token) },
    );
    expect(privateFavourite.status).toBe(200);

    const query = await buildRecommendationInterestQuery(viewer.accountId);
    expect(query).toContain('posted: My public interest is #cloudflare');
    expect(query).toContain('liked: public candidate');
    expect(query).toContain('reposted: recent repost interest marker #reposttopic');
    expect(query).not.toContain('authorized private follower content');
    expect(query).not.toContain('https://example.test');
    expect(query).not.toContain('private@example.test');
    expect(query).not.toContain('@mention');
    expect(query.length).toBeLessThanOrEqual(RECOMMENDATION_INTEREST_MAX_CHARS);
  });

  it('treats inference errors and malformed rankings as explicit failures', async () => {
    await expect(createRecommendedTimelinePage(
      viewer.accountId,
      20,
      MODEL,
      async () => { throw new Error('model unavailable'); },
      'throwing-model',
    )).rejects.toMatchObject<Partial<RecommendationGenerationError>>({
      code: 'AI_RECOMMENDATION_FAILED',
      reason: 'model unavailable',
    });

    await expect(createRecommendedTimelinePage(
      viewer.accountId,
      20,
      MODEL,
      async () => ({ response: [{ id: 0, score: 1 }] }),
      'malformed-model',
    )).rejects.toMatchObject<Partial<RecommendationGenerationError>>({
      code: 'AI_RECOMMENDATION_FAILED',
    });
  });

  it('keeps the provider HTTP status, code, and reason without exposing a stack', () => {
    const failure = Object.assign(
      new Error('Capacity temporarily exceeded, please try again.'),
      { status: 429, code: 3040 },
    );

    expect(describeRecommendationGenerationFailure(failure)).toBe(
      'HTTP 429\ncode: 3040\nCapacity temporarily exceeded, please try again.',
    );
  });

  it('fails instead of truncating a non-exhausted feed when cursor storage fails', async () => {
    const put = vi.spyOn(env.CACHE, 'put').mockRejectedValueOnce(
      new Error('KV unavailable'),
    );
    try {
      await expect(createRecommendedTimelinePage(
        viewer.accountId,
        1,
        MODEL,
        indexedRunner(),
        'cursor-write-failure',
      )).rejects.toMatchObject<Partial<RecommendationGenerationError>>({
        code: 'AI_RECOMMENDATION_FAILED',
        message: 'AI recommendation cursor could not be stored',
      });
    } finally {
      put.mockRestore();
    }
  });

  it('rolls beyond one candidate window without repeats and memoizes cursor retries', async () => {
    let runCount = 0;
    const runner = indexedRunner(() => { runCount += 1; }, true);
    const first = await createRecommendedTimelinePage(
      viewer.accountId,
      1,
      MODEL,
      runner,
      'fresh-snapshot-one',
    );
    const refreshed = await createRecommendedTimelinePage(
      viewer.accountId,
      1,
      MODEL,
      runner,
      'fresh-snapshot-two',
    );

    expect(runCount).toBe(2);
    expect(first.nextCursor).toBeDefined();
    expect(refreshed.nextCursor).toBeDefined();
    expect(refreshed.nextCursor).not.toBe(first.nextCursor);

    const next = await continueRecommendedTimelinePage(
      viewer.accountId,
      first.nextCursor!,
      1,
      MODEL,
      runner,
    );
    const keysAfterGeneration = (await env.CACHE.list()).keys
      .map((key) => key.name)
      .sort();
    const repeated = await continueRecommendedTimelinePage(
      viewer.accountId,
      first.nextCursor!,
      1,
      MODEL,
      runner,
    );
    expect(next?.source).toBe('ai');
    expect(repeated?.source).toBe('cached');
    expect(next?.rows[0]?.id).not.toBe(first.rows[0]?.id);
    expect(repeated?.rows.map((row) => row.id)).toEqual(next?.rows.map((row) => row.id));
    expect(repeated?.nextCursor).toBe(next?.nextCursor);
    expect((await env.CACHE.list()).keys.map((key) => key.name).sort()).toEqual(
      keysAfterGeneration,
    );

    const collectSnapshotIds = async (
      initial: typeof first,
    ): Promise<string[]> => {
      const ids = initial.rows.map((row) => row.id);
      const seen = new Set(ids);
      let cursor = initial.nextCursor;
      while (cursor) {
        const page = await continueRecommendedTimelinePage(
          viewer.accountId,
          cursor,
          3,
          MODEL,
          runner,
        );
        expect(page).not.toBeNull();
        for (const row of page?.rows ?? []) {
          expect(seen.has(row.id)).toBe(false);
          seen.add(row.id);
          ids.push(row.id);
        }
        cursor = page?.nextCursor;
      }
      return ids;
    };
    const firstSnapshotIds = await collectSnapshotIds(first);
    const refreshedSnapshotIds = await collectSnapshotIds(refreshed);
    expect(firstSnapshotIds.length).toBeGreaterThan(1);
    expect(refreshedSnapshotIds.some((id) => firstSnapshotIds.includes(id))).toBe(true);

    expect(await continueRecommendedTimelinePage(
      publicAuthor.accountId,
      first.nextCursor!,
      1,
      MODEL,
      runner,
    )).toBeNull();
    expect(await continueRecommendedTimelinePage(
      viewer.accountId,
      `${first.nextCursor!}invalid`,
      1,
      MODEL,
      runner,
    )).toBeNull();

    const cachedStatusId = next?.rows[0]?.id as string;
    await env.DB.prepare(
      'UPDATE statuses SET deleted_at = ?1 WHERE id = ?2',
    ).bind(new Date().toISOString(), cachedStatusId).run();
    const cachedSnapshot = await continueRecommendedTimelinePage(
      viewer.accountId,
      first.nextCursor!,
      1,
      MODEL,
      runner,
    );
    expect(cachedSnapshot?.rows.map((row) => row.id)).toContain(cachedStatusId);
  });

  it('excludes shown IDs before rebuilding the next 350-item AI window', async () => {
    for (let index = 0; index < 7; index += 1) {
      await createStatus(
        publicAuthor,
        `small rolling window marker ${index}`,
        'public',
      );
    }

    const capturedContexts: string[][] = [];
    const runner = indexedRunner((input) => {
      const contexts = Array.isArray(input.contexts)
        ? input.contexts
          .filter((context): context is { text: string } => (
            typeof context === 'object'
            && context !== null
            && typeof (context as { text?: unknown }).text === 'string'
          ))
          .map((context) => context.text)
        : [];
      capturedContexts.push(contexts);
    }, true);
    const initial = await createRecommendedTimelinePage(
      viewer.accountId,
      1,
      MODEL,
      runner,
      'small-rolling-window',
    );
    const second = await continueRecommendedTimelinePage(
      viewer.accountId,
      initial.nextCursor!,
      1,
      MODEL,
      runner,
    );

    expect(capturedContexts[0]?.length).toBeGreaterThan(0);
    expect(capturedContexts[0]?.length).toBeLessThanOrEqual(RECOMMENDATION_CANDIDATE_LIMIT);
    expect(capturedContexts[1]?.length).toBeGreaterThan(0);
    expect(capturedContexts[1]?.length).toBeLessThanOrEqual(RECOMMENDATION_CANDIDATE_LIMIT);
    const firstText = initial.rows[0]?.text ?? '';
    expect(capturedContexts[1]?.every((text) => !text.includes(firstText))).toBe(true);
    const firstWindow = new Set(capturedContexts[0]);
    expect(capturedContexts[1]?.some((text) => firstWindow.has(text))).toBe(true);

    const seen = new Set(initial.rows.map((row) => row.id));
    for (const row of second?.rows ?? []) {
      expect(seen.has(row.id)).toBe(false);
      seen.add(row.id);
    }
    let cursor = second?.nextCursor;
    let attempts = 0;
    while (cursor && attempts < 10) {
      const page = await continueRecommendedTimelinePage(
        viewer.accountId,
        cursor,
        1,
        MODEL,
        runner,
      );
      expect(page).not.toBeNull();
      for (const row of page?.rows ?? []) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      cursor = page?.nextCursor;
      attempts += 1;
    }
    expect(seen.size).toBeGreaterThan(2);
  });

  it('replenishes the D1 window and continues after more than 200 displayed posts', async () => {
    const statements = Array.from({ length: 210 }, (_, index) => {
      const id = generateUlid();
      const createdAt = new Date(Date.now() - index).toISOString();
      return env.DB.prepare(
        `INSERT INTO statuses
           (id, uri, account_id, text, content, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'public', ?, ?)`,
      ).bind(
        id,
        `${BASE}/users/recommendpublic/statuses/${id}`,
        publicAuthor.accountId,
        `rolling window candidate ${index}`,
        `<p>rolling window candidate ${index}</p>`,
        createdAt,
        createdAt,
      );
    });
    for (let offset = 0; offset < statements.length; offset += 50) {
      await env.DB.batch(statements.slice(offset, offset + 50));
    }

    const runner = indexedRunner(undefined, true);
    const initial = await createRecommendedTimelinePage(
      viewer.accountId,
      40,
      MODEL,
      runner,
      'rolling-past-two-hundred',
    );
    const seen = new Set(initial.rows.map((row) => row.id));
    let cursor = initial.nextCursor;
    let pageCount = 1;
    while (cursor && seen.size <= 200 && pageCount < 10) {
      const page = await continueRecommendedTimelinePage(
        viewer.accountId,
        cursor,
        40,
        MODEL,
        runner,
      );
      expect(page).not.toBeNull();
      for (const row of page?.rows ?? []) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      cursor = page?.nextCursor;
      pageCount += 1;
    }

    expect(seen.size).toBeGreaterThan(200);
    expect(pageCount).toBeGreaterThanOrEqual(6);
  });

  it('requires auth and read:statuses, then hides the route while AI is disabled', async () => {
    const unauthenticated = await SELF.fetch(`${BASE}/api/v1/timelines/recommended`, {
      method: 'POST',
    });
    expect(unauthenticated.status).toBe(401);

    const insufficientScope = await SELF.fetch(`${BASE}/api/v1/timelines/recommended`, {
      method: 'POST',
      headers: authHeaders(scopeLimited.token),
    });
    expect(insufficientScope.status).toBe(403);

    const disabled = await SELF.fetch(`${BASE}/api/v1/timelines/recommended`, {
      method: 'POST',
      headers: authHeaders(viewer.token),
    });
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toMatchObject({
      error_code: 'AI_RECOMMENDATION_DISABLED',
    });
  });

  it('uses POST and the native limiter for both fresh and cursor AI pages', async () => {
    for (let index = 0; index < RECOMMENDATION_DEFAULT_PAGE_LIMIT + 5; index += 1) {
      await createStatus(
        publicAuthor,
        `default recommended page fixture ${index}`,
        'public',
      );
    }

    const bindings = env as unknown as Record<string, unknown>;
    const names = [
      'WORKERS_AI_ENABLED',
      'AI',
      'WORKERS_AI_RATE_LIMITS',
      'WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS',
      'AI_RECOMMENDATION_RATE_LIMITER',
    ] as const;
    const previous = names.map((name) => ({
      name,
      hadValue: Object.prototype.hasOwnProperty.call(bindings, name),
      value: bindings[name],
    }));
    const limit = vi.fn(async () => ({ success: true }));
    bindings.WORKERS_AI_ENABLED = true;
    bindings.AI = { run: indexedRunner() };
    bindings.WORKERS_AI_RATE_LIMITS = true;
    bindings.WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS = 60;
    bindings.AI_RECOMMENDATION_RATE_LIMITER = { limit };

    try {
      await cacheWorkersAiFeatureFlags({
        workers_ai_recommendation_enabled: '1',
        workers_ai_translation_enabled: '0',
        workers_ai_image_description_enabled: '0',
      }, bindings);

      const unsafeGet = await SELF.fetch(`${BASE}/api/v1/timelines/recommended`, {
        headers: authHeaders(viewer.token),
      });
      expect(unsafeGet.status).toBe(405);
      expect(unsafeGet.headers.get('Allow')).toBe('POST');
      expect(limit).not.toHaveBeenCalled();

      const freshPost = await SELF.fetch(`${BASE}/api/v1/timelines/recommended`, {
        method: 'POST',
        headers: authHeaders(viewer.token),
      });
      expect(freshPost.status).toBe(200);
      expect(limit).toHaveBeenCalledWith({ key: viewer.accountId });
      expect(await freshPost.json<CreatedStatus[]>()).toHaveLength(
        RECOMMENDATION_DEFAULT_PAGE_LIMIT,
      );
      const link = freshPost.headers.get('Link');
      expect(link).toContain(
        `&limit=${RECOMMENDATION_DEFAULT_PAGE_LIMIT}>; rel="next"`,
      );
      const nextUrl = /<([^>]+)>; rel="next"/u.exec(link ?? '')?.[1];
      expect(nextUrl).toBeDefined();
      const nextPost = await SELF.fetch(nextUrl!, {
        method: 'POST',
        headers: authHeaders(viewer.token),
      });
      expect(nextPost.status).toBe(200);
      expect(limit).toHaveBeenCalledTimes(2);
      expect(await nextPost.json<CreatedStatus[]>()).toHaveLength(
        RECOMMENDATION_DEFAULT_PAGE_LIMIT,
      );
    } finally {
      for (const entry of previous) {
        if (entry.hadValue) bindings[entry.name] = entry.value;
        else Reflect.deleteProperty(bindings, entry.name);
      }
    }
  });

  it('uses the configured rate-limit period in Retry-After', async () => {
    const bindings = env as unknown as Record<string, unknown>;
    const names = [
      'WORKERS_AI_ENABLED',
      'AI',
      'WORKERS_AI_RATE_LIMITS',
      'WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS',
      'AI_RECOMMENDATION_RATE_LIMITER',
    ] as const;
    const previous = names.map((name) => ({
      name,
      hadValue: Object.prototype.hasOwnProperty.call(bindings, name),
      value: bindings[name],
    }));
    const run = vi.fn(indexedRunner());
    const limit = vi.fn(async () => ({ success: false }));
    bindings.WORKERS_AI_ENABLED = true;
    bindings.AI = { run };
    bindings.WORKERS_AI_RATE_LIMITS = true;
    bindings.WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS = 10;
    bindings.AI_RECOMMENDATION_RATE_LIMITER = { limit };

    try {
      await cacheWorkersAiFeatureFlags({
        workers_ai_recommendation_enabled: '1',
        workers_ai_translation_enabled: '0',
        workers_ai_image_description_enabled: '0',
      }, bindings);

      const response = await SELF.fetch(`${BASE}/api/v1/timelines/recommended`, {
        method: 'POST',
        headers: authHeaders(viewer.token),
      });
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('10');
      expect(await response.json()).toMatchObject({
        error_code: 'AI_RECOMMENDATION_RATE_LIMITED',
      });
      expect(limit).toHaveBeenCalledWith({ key: viewer.accountId });
      expect(run).not.toHaveBeenCalled();
    } finally {
      for (const entry of previous) {
        if (entry.hadValue) bindings[entry.name] = entry.value;
        else Reflect.deleteProperty(bindings, entry.name);
      }
    }
  });

  it('returns the temporary provider failure reason from the endpoint', async () => {
    const bindings = env as unknown as Record<string, unknown>;
    const names = [
      'WORKERS_AI_ENABLED',
      'WORKERS_AI_RATE_LIMITS',
      'AI',
    ] as const;
    const previous = names.map((name) => ({
      name,
      hadValue: Object.prototype.hasOwnProperty.call(bindings, name),
      value: bindings[name],
    }));
    bindings.WORKERS_AI_ENABLED = true;
    bindings.WORKERS_AI_RATE_LIMITS = false;
    bindings.AI = {
      run: async () => {
        throw Object.assign(
          new Error('Capacity temporarily exceeded, please try again.'),
          { status: 429, code: 3040 },
        );
      },
    };

    try {
      await cacheWorkersAiFeatureFlags({
        workers_ai_recommendation_enabled: '1',
        workers_ai_translation_enabled: '0',
        workers_ai_image_description_enabled: '0',
      }, bindings);

      const response = await SELF.fetch(`${BASE}/api/v1/timelines/recommended`, {
        method: 'POST',
        headers: authHeaders(viewer.token),
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: 'AI recommendation could not be generated',
        error_code: 'AI_RECOMMENDATION_FAILED',
        error_description:
          'HTTP 429\ncode: 3040\nCapacity temporarily exceeded, please try again.',
      });
    } finally {
      for (const entry of previous) {
        if (entry.hadValue) bindings[entry.name] = entry.value;
        else Reflect.deleteProperty(bindings, entry.name);
      }
    }
  });
});
