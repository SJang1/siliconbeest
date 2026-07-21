/* oxlint-disable fp/no-classes, fp/no-class-inheritance, fp/no-this-expressions, fp/no-try-statements, fp/no-throw-statements, fp/no-promise-reject, fp/no-let, fp/no-loop-statements */
import { env } from 'cloudflare:workers';
import { sanitizePlainText } from '../utils/sanitize';
import type { TimelineStatusRow } from '../types/db';
import {
  getRecommendationCandidateWindow,
  RECOMMENDATION_CANDIDATE_WINDOW_LIMIT,
} from './timeline';
import {
  readRecommendationActivities,
  type RecommendationActivity,
  type RecommendationActivityKind,
} from './recommendationActivity';

export const RECOMMENDATION_DEFAULT_PAGE_LIMIT = 30;
export const RECOMMENDATION_CANDIDATE_LIMIT = RECOMMENDATION_CANDIDATE_WINDOW_LIMIT;
export const RECOMMENDATION_CONTEXT_MAX_CHARS = 400;
export const RECOMMENDATION_INTEREST_MAX_CHARS = 7_000;

const RECOMMENDATION_TAG_QUERY_BATCH_SIZE = 80;
const RECOMMENDATION_CURSOR_TTL_SECONDS = 300;
const RECOMMENDATION_CURSOR_PREFIX = 'workers-ai:recommended:v2';
const RECOMMENDATION_PAGE_MEMO_PREFIX = 'workers-ai:recommended-page:v3';
const MAX_INTEREST_TAGS = 12;
const MAX_INTEREST_LANGUAGES = 5;
const MAX_RECENT_ACTIVITY_ITEM_CHARS = 140;
const MAX_TAGS_PER_CONTEXT = 8;
const RECOMMENDATION_DIVERSITY_WINDOW = 3;
const RECOMMENDATION_CURSOR_VERSION = 'v2';

export type RecommendationSource = 'ai' | 'cached';

export class RecommendationGenerationError extends Error {
  readonly code = 'AI_RECOMMENDATION_FAILED';
  readonly reason: string | undefined;

  constructor(
    message = 'AI recommendation could not be generated',
    reason?: string,
  ) {
    super(message);
    this.name = 'RecommendationGenerationError';
    this.reason = reason;
  }
}

const RECOMMENDATION_FAILURE_REASON_MAX_CHARS = 500;

function normalizeFailureDetail(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const detail = String(value)
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return detail.length > 0
    ? detail.slice(0, RECOMMENDATION_FAILURE_REASON_MAX_CHARS)
    : null;
}

function readFailureField(error: unknown, names: readonly string[]): unknown {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return undefined;
  }
  for (const name of names) {
    const value = Reflect.get(error, name) as unknown;
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Preserve the useful, non-stack portion of a Workers AI rejection so the
 * recommendation endpoint can explain a temporary provider failure. Error
 * objects differ between local bindings and the remote service, so read the
 * common HTTP status/code fields in addition to the message.
 */
export function describeRecommendationGenerationFailure(error: unknown): string | undefined {
  const message = normalizeFailureDetail(
    error instanceof Error ? error.message : readFailureField(error, ['message', 'error']),
  ) ?? normalizeFailureDetail(typeof error === 'string' ? error : null);
  const status = normalizeFailureDetail(readFailureField(
    error,
    ['status', 'statusCode', 'httpStatus'],
  ));
  const code = normalizeFailureDetail(readFailureField(error, ['code', 'errorCode']));
  const details = [
    status && !message?.toLocaleLowerCase().includes(`http ${status.toLocaleLowerCase()}`)
      ? `HTTP ${status}`
      : null,
    code && !message?.toLocaleLowerCase().includes(`code: ${code.toLocaleLowerCase()}`)
      ? `code: ${code}`
      : null,
    message,
  ].filter((detail): detail is string => detail !== null);
  if (details.length === 0) return undefined;
  return details.join('\n').slice(0, RECOMMENDATION_FAILURE_REASON_MAX_CHARS);
}

export type RecommendationModelRunner = (
  model: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

// eslint-disable-next-line functional/type-declaration-immutability -- D1 row snapshots are readonly request data.
export type RecommendedTimelinePage = {
  readonly rows: readonly TimelineStatusRow[];
  readonly nextCursor?: string;
  readonly source: RecommendationSource;
};

type InterestTagRow = {
  readonly name: string;
};

type CandidateTagRow = {
  readonly status_id: string;
  readonly name: string;
};

type RankedContext = {
  readonly id: number;
  readonly score: number;
  readonly diversity: number;
};

function clampPageLimit(limit: number): number {
  if (!Number.isFinite(limit)) return RECOMMENDATION_DEFAULT_PAGE_LIMIT;
  return Math.min(40, Math.max(1, Math.trunc(limit)));
}

function normalizeSignal(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return sanitizePlainText(value)
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/giu, ' ')
    .replace(/(^|\s)@\S+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function seededFraction(seed: string, value: string): number {
  const input = `${seed}:${value}`;
  const hash = Array.from(input).reduce(
    (current, character) => Math.imul(current ^ (character.codePointAt(0) ?? 0), 16_777_619) >>> 0,
    2_166_136_261,
  );
  return hash / 0xffff_ffff;
}

/**
 * Take a bounded sample from the current public/home candidate window. The
 * rolling state supplies a stable page seed, so retries select the same input
 * ordering while a later page can mix the replenished window differently.
 */
export function sampleRecommendationCandidates<T extends { readonly id: string }>(
  candidates: readonly T[],
  snapshotSeed: string,
  limit = RECOMMENDATION_CANDIDATE_LIMIT,
): T[] {
  const deduplicated = [...new Map(
    candidates.map((row) => [row.id, row] as const),
  ).values()];
  return deduplicated
    .map((row) => ({
      row,
      sample: seededFraction(snapshotSeed, row.id),
    }))
    .sort((left, right) => left.sample - right.sample)
    .slice(0, Math.min(RECOMMENDATION_CANDIDATE_LIMIT, Math.max(1, Math.trunc(limit))))
    .map(({ row }) => row);
}

async function fetchFollowedTags(accountId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT t.name
     FROM tag_follows tf
     JOIN tags t ON t.id = tf.tag_id
     WHERE tf.account_id = ?
       AND t.name IS NOT NULL
       AND t.name != ''
     ORDER BY tf.created_at DESC, t.name
     LIMIT ?`,
  ).bind(
    accountId,
    MAX_INTEREST_TAGS,
  ).all<InterestTagRow>();

  return (results ?? [])
    .map((row) => normalizeSignal(row.name, 60))
    .filter((name) => name.length > 0)
    .slice(0, MAX_INTEREST_TAGS);
}

function activityWeight(kind: RecommendationActivityKind): number {
  if (kind === 'posted') return 3;
  if (kind === 'reposted') return 2;
  return 1;
}

function rankActivityValues(
  activities: readonly RecommendationActivity[],
  valuesForActivity: (activity: RecommendationActivity) => readonly string[],
  maxItems: number,
): string[] {
  const scores = new Map<string, { readonly value: string; score: number; latest: number }>();
  activities.forEach((activity, index) => {
    valuesForActivity(activity).forEach((rawValue) => {
      const value = normalizeSignal(rawValue, 60);
      if (!value) return;
      const key = value.toLocaleLowerCase();
      const existing = scores.get(key);
      scores.set(key, {
        value: existing?.value ?? value,
        score: (existing?.score ?? 0) + activityWeight(activity.activityKind),
        latest: Math.min(existing?.latest ?? index, index),
      });
    });
  });

  return [...scores.values()]
    .sort((left, right) => (
      right.score - left.score
      || left.latest - right.latest
      || left.value.localeCompare(right.value)
    ))
    .slice(0, maxItems)
    .map(({ value }) => value);
}

/** Build a bounded interest query exclusively from signals on public data. */
export async function buildRecommendationInterestQuery(accountId: string): Promise<string> {
  const [followedTags, activities] = await Promise.all([
    fetchFollowedTags(accountId),
    readRecommendationActivities(accountId),
  ]);
  const activityTags = rankActivityValues(activities, (activity) => activity.tags, MAX_INTEREST_TAGS);
  const tags = [...new Map(
    [...followedTags, ...activityTags].map((tag) => [tag.toLocaleLowerCase(), tag] as const),
  ).values()].slice(0, MAX_INTEREST_TAGS);
  const languages = rankActivityValues(
    activities,
    (activity) => /^[\p{L}\p{N}_-]+$/u.test(activity.language) ? [activity.language] : [],
    MAX_INTEREST_LANGUAGES,
  );
  const recentActivity = activities
    .map((activity) => {
      const text = normalizeSignal(activity.text, MAX_RECENT_ACTIVITY_ITEM_CHARS);
      return text ? `${activity.activityKind}: ${text}` : '';
    })
    .filter((item) => item.length > 0);
  const activityCounts = activities.reduce(
    (counts, activity) => ({
      ...counts,
      [activity.activityKind]: counts[activity.activityKind] + 1,
    }),
    { posted: 0, reposted: 0, liked: 0 } satisfies Record<RecommendationActivityKind, number>,
  );

  const parts = [
    'Rank recent visible public and home-timeline posts for this user.',
    tags.length > 0 ? `Interested topics: ${tags.map((tag) => `#${tag}`).join(', ')}.` : '',
    languages.length > 0 ? `Languages seen in public activity: ${languages.join(', ')}.` : '',
    activities.length > 0
      ? `Activity mix: ${activityCounts.posted} posted, ${activityCounts.reposted} reposted, ${activityCounts.liked} liked.`
      : '',
    recentActivity.length > 0
      ? `Recent public activity: ${recentActivity.join(' | ')}.`
      : '',
    'Treat authored and reposted topics as stronger interest signals than likes.',
    'Prefer relevant, informative, and varied posts; do not invent interests outside these signals.',
  ].filter((part) => part.length > 0);

  return parts.join(' ').slice(0, RECOMMENDATION_INTEREST_MAX_CHARS).trim();
}

async function fetchCandidateTags(
  statusIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (statusIds.length === 0) return new Map();
  const tagMap = new Map<string, string[]>();

  for (let offset = 0; offset < statusIds.length; offset += RECOMMENDATION_TAG_QUERY_BATCH_SIZE) {
    const batch = statusIds.slice(offset, offset + RECOMMENDATION_TAG_QUERY_BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT st.status_id, t.name
       FROM status_tags st
       JOIN tags t ON t.id = st.tag_id
       WHERE st.status_id IN (${placeholders})
       ORDER BY st.status_id, t.name
       LIMIT ?`,
    ).bind(...batch, batch.length * MAX_TAGS_PER_CONTEXT).all<CandidateTagRow>();

    for (const row of results ?? []) {
      const name = normalizeSignal(row.name, 60);
      if (!name) continue;
      const current = tagMap.get(row.status_id) ?? [];
      if (current.length < MAX_TAGS_PER_CONTEXT) {
        tagMap.set(row.status_id, [...current, name]);
      }
    }
  }

  return tagMap;
}

/** Convert visible candidate rows into bounded, non-identifying model contexts. */
export async function buildRecommendationContexts(
  candidates: readonly TimelineStatusRow[],
): Promise<Array<{ text: string }>> {
  const statusIds = candidates.map((row) => row.id);
  const tagMap = await fetchCandidateTags(statusIds);

  return candidates.map((row) => {
    const body = normalizeSignal(
      row.text || row.content || row.title || '',
      RECOMMENDATION_CONTEXT_MAX_CHARS,
    );
    const language = normalizeSignal(row.language, 35);
    const tags = tagMap.get(row.id) ?? [];
    const prefix = [
      language ? `language ${language}` : '',
      tags.length > 0 ? `topics ${tags.map((tag) => `#${tag}`).join(' ')}` : '',
    ].filter((part) => part.length > 0).join('; ');
    const text = prefix ? `${prefix}; ${body}` : body;
    return {
      text: (text || 'visible timeline post')
        .slice(0, RECOMMENDATION_CONTEXT_MAX_CHARS)
        .trim(),
    };
  });
}

/**
 * Validate BGE-M3's indexed-score response as an exact permutation before
 * applying it. Partial, duplicated, non-finite, or out-of-range output is not
 * trusted and returns null so callers fail recommendation generation explicitly.
 */
export function rankRecommendationCandidates<
  T extends { readonly id: string; readonly account_id?: string },
>(
  candidates: readonly T[],
  output: unknown,
  snapshotSeed = '',
): T[] | null {
  if (candidates.length === 0) return [];
  if (!isRecord(output) || !Array.isArray(output.response)) return null;
  if (output.response.length !== candidates.length) return null;

  const parsed = output.response.reduce<RankedContext[] | null>((items, value) => {
    if (items === null || !isRecord(value)) return null;
    const id = value.id;
    const score = value.score;
    if (
      typeof id !== 'number'
      || !Number.isInteger(id)
      || id < 0
      || id >= candidates.length
      || typeof score !== 'number'
      || !Number.isFinite(score)
      || items.some((item) => item.id === id)
    ) {
      return null;
    }
    const candidate = candidates[id];
    if (candidate === undefined) return null;
    return [...items, {
      id,
      score,
      diversity: seededFraction(snapshotSeed, candidate.id),
    }];
  }, []);

  if (parsed === null || parsed.length !== candidates.length) return null;
  const relevanceOrdered = [...parsed]
    .sort((left, right) => (
      right.score - left.score
      || left.diversity - right.diversity
      || left.id - right.id
    ));
  // Keep model relevance local while allowing a new snapshot to reshuffle
  // nearby results even when every model score is distinct. This makes refresh
  // genuinely fresh without promoting a low-scoring tail item to the top.
  const scoreOrdered = snapshotSeed
    ? Array.from(
      { length: Math.ceil(relevanceOrdered.length / RECOMMENDATION_DIVERSITY_WINDOW) },
      (_, windowIndex) => relevanceOrdered
        .slice(
          windowIndex * RECOMMENDATION_DIVERSITY_WINDOW,
          (windowIndex + 1) * RECOMMENDATION_DIVERSITY_WINDOW,
        )
        .sort((left, right) => left.diversity - right.diversity || left.id - right.id),
    ).flat()
    : relevanceOrdered;
  const candidateOrder = scoreOrdered
    .map((item) => candidates[item.id])
    .filter((candidate): candidate is T => candidate !== undefined);
  const diversified = candidateOrder.reduce<{
    primary: T[];
    overflow: T[];
    authorCounts: ReadonlyMap<string, number>;
  }>((result, row, index) => {
    const authorId = typeof row.account_id === 'string'
      ? row.account_id
      : `missing-author:${row.id}:${index}`;
    const count = result.authorCounts.get(authorId) ?? 0;
    const authorCounts = new Map(result.authorCounts);
    authorCounts.set(authorId, count + 1);
    return count < 2
      ? {
        primary: [...result.primary, row],
        overflow: result.overflow,
        authorCounts,
      }
      : {
        primary: result.primary,
        overflow: [...result.overflow, row],
        authorCounts,
      };
  }, {
    primary: [],
    overflow: [],
    authorCounts: new Map<string, number>(),
  });
  return [...diversified.primary, ...diversified.overflow];
}

type RecommendationRollingState = {
  readonly version: 2;
  readonly upperBound: string;
  readonly shownIds: readonly string[];
  readonly rejectedIds: readonly string[];
  readonly query: string;
  readonly seed: string;
  readonly page: number;
};

type RecommendationPageMemo = {
  readonly version: 2;
  readonly rows: readonly TimelineStatusRow[];
  readonly nextCursor?: string;
};

function cursorKey(accountId: string, stateId: string): string {
  return `${RECOMMENDATION_CURSOR_PREFIX}:${accountId}:${stateId}`;
}

function pageMemoKey(accountId: string, stateId: string): string {
  return `${RECOMMENDATION_PAGE_MEMO_PREFIX}:${accountId}:${stateId}`;
}

function encodeRecommendationCursor(stateId: string): string {
  return btoa(`${RECOMMENDATION_CURSOR_VERSION}.${stateId}`)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeRecommendationCursor(cursor: string): string | null {
  if (cursor.length < 20 || cursor.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    return null;
  }

  let decoded: string;
  try {
    const base64 = cursor
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(cursor.length / 4) * 4, '=');
    decoded = atob(base64);
  } catch {
    return null;
  }

  const match = /^v2\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(decoded);
  const stateId = match?.[1];
  return stateId !== undefined && encodeRecommendationCursor(stateId) === cursor
    ? stateId
    : null;
}

function isValidStatusIdList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
    && new Set(value).size === value.length;
}

function parseRecommendationState(cached: string): RecommendationRollingState | null {
  try {
    const parsed = JSON.parse(cached) as unknown;
    if (
      !isRecord(parsed)
      || parsed.version !== 2
      || typeof parsed.upperBound !== 'string'
      || parsed.upperBound.length > 64
      || !Number.isFinite(Date.parse(parsed.upperBound))
      || typeof parsed.query !== 'string'
      || parsed.query.length === 0
      || parsed.query.length > RECOMMENDATION_INTEREST_MAX_CHARS
      || typeof parsed.seed !== 'string'
      || parsed.seed.length === 0
      || parsed.seed.length > 128
      || typeof parsed.page !== 'number'
      || !Number.isSafeInteger(parsed.page)
      || parsed.page < 1
    ) {
      return null;
    }
    const shownIds = parsed.shownIds;
    const rejectedIds = parsed.rejectedIds;
    if (!isValidStatusIdList(shownIds) || !isValidStatusIdList(rejectedIds)) {
      return null;
    }
    const rejectedSet = new Set(rejectedIds);
    if (shownIds.some((id) => rejectedSet.has(id))) return null;
    return {
      version: 2,
      upperBound: parsed.upperBound,
      shownIds,
      rejectedIds,
      query: parsed.query,
      seed: parsed.seed,
      page: parsed.page,
    };
  } catch {
    return null;
  }
}

function parseRecommendationPageMemo(cached: string): RecommendationPageMemo | null {
  try {
    const parsed = JSON.parse(cached) as unknown;
    if (
      !isRecord(parsed)
      || parsed.version !== 2
      || !Array.isArray(parsed.rows)
      || parsed.rows.length > 40
      || !parsed.rows.every((row) => (
        isRecord(row)
        && typeof row.id === 'string'
        && row.id.length > 0
        && row.id.length <= 128
      ))
      || new Set(parsed.rows.map((row) => row.id)).size !== parsed.rows.length
      || (
        parsed.nextCursor !== undefined
        && (typeof parsed.nextCursor !== 'string'
          || decodeRecommendationCursor(parsed.nextCursor) === null)
      )
    ) {
      return null;
    }
    return {
      version: 2,
      rows: parsed.rows as TimelineStatusRow[],
      ...(typeof parsed.nextCursor === 'string'
        ? { nextCursor: parsed.nextCursor }
        : {}),
    };
  } catch {
    return null;
  }
}

async function storeRecommendationState(
  accountId: string,
  state: RecommendationRollingState,
): Promise<string> {
  const stateId = crypto.randomUUID();
  try {
    await env.CACHE.put(
      cursorKey(accountId, stateId),
      JSON.stringify(state),
      { expirationTtl: RECOMMENDATION_CURSOR_TTL_SECONDS },
    );
    return encodeRecommendationCursor(stateId);
  } catch {
    // eslint-disable-next-line functional/no-throw-statements -- Losing rolling state would silently truncate a non-exhausted feed.
    throw new RecommendationGenerationError(
      'AI recommendation cursor could not be stored',
    );
  }
}

async function loadRecommendationState(
  accountId: string,
  stateId: string,
): Promise<RecommendationRollingState | null> {
  try {
    const cached = await env.CACHE.get(cursorKey(accountId, stateId));
    return cached ? parseRecommendationState(cached) : null;
  } catch {
    return null;
  }
}

async function storeRecommendationPageMemo(
  accountId: string,
  stateId: string,
  page: RecommendedTimelinePage,
): Promise<void> {
  const memo: RecommendationPageMemo = {
    version: 2,
    rows: page.rows,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
  try {
    await env.CACHE.put(
      pageMemoKey(accountId, stateId),
      JSON.stringify(memo),
      { expirationTtl: RECOMMENDATION_CURSOR_TTL_SECONDS },
    );
  } catch {
    // A memo is an optimization. The immutable input state still supports a
    // safe retry if KV cannot persist this generated response.
  }
}

async function loadRecommendationPageMemo(
  accountId: string,
  stateId: string,
): Promise<RecommendedTimelinePage | null> {
  let cached: string | null;
  try {
    cached = await env.CACHE.get(pageMemoKey(accountId, stateId));
  } catch {
    return null;
  }
  if (!cached) return null;
  const memo = parseRecommendationPageMemo(cached);
  if (memo === null) return null;

  return {
    rows: memo.rows,
    ...(memo.nextCursor ? { nextCursor: memo.nextCursor } : {}),
    source: 'cached',
  };
}

async function generateRecommendationPage(
  accountId: string,
  state: RecommendationRollingState,
  limit: number,
  model: string,
  runModel: RecommendationModelRunner,
): Promise<RecommendedTimelinePage> {
  const pageLimit = clampPageLimit(limit);
  const candidateLimit = RECOMMENDATION_CANDIDATE_LIMIT;
  const excludedIds = [...state.shownIds, ...state.rejectedIds];
  const recentRows = await getRecommendationCandidateWindow({
    viewerAccountId: accountId,
    upperBound: state.upperBound,
    excludedIds,
    limit: candidateLimit,
  });
  const pageSeed = `${state.seed}:${state.page}`;
  const candidates = sampleRecommendationCandidates(
    recentRows,
    pageSeed,
    candidateLimit,
  );
  if (candidates.length === 0) return { rows: [], source: 'ai' };

  const contexts = await buildRecommendationContexts(candidates);
  let output: unknown;
  try {
    output = await runModel(model, {
      query: state.query,
      contexts,
      truncate_inputs: true,
    });
  } catch (error) {
    // eslint-disable-next-line functional/no-throw-statements -- Endpoint maps model failures to a structured 503.
    throw new RecommendationGenerationError(
      undefined,
      describeRecommendationGenerationFailure(error),
    );
  }
  const ordered = rankRecommendationCandidates(candidates, output, pageSeed);
  if (ordered === null) {
    // eslint-disable-next-line functional/no-throw-statements -- Invalid rankings must fail closed with a structured 503.
    throw new RecommendationGenerationError('AI recommendation returned an invalid ranking');
  }

  // The candidate window already applied the complete visibility and
  // relationship policy. Keep that validated snapshot through ranking instead
  // of issuing another D1 permission query after the model call.
  const rows = ordered.slice(0, pageLimit);
  const selectedIds = rows.map((row) => row.id);
  const selectedSet = new Set(selectedIds);

  // Only displayed rows enter the next exclusion set. Healthy candidates that
  // were not selected remain in the rolling window, while D1 replenishes it
  // with older rows as displayed IDs accumulate.
  const hasRemainingWindowCandidate = candidates.some((row) => (
    !selectedSet.has(row.id)
  ));
  const mayHaveOlderCandidate = recentRows.length >= candidateLimit;
  const hasMore = hasRemainingWindowCandidate || mayHaveOlderCandidate;
  if (!hasMore) return { rows, source: 'ai' };

  const nextState: RecommendationRollingState = {
    version: 2,
    upperBound: state.upperBound,
    shownIds: [...state.shownIds, ...selectedIds],
    rejectedIds: state.rejectedIds,
    query: state.query,
    seed: state.seed,
    page: state.page + 1,
  };
  const nextCursor = await storeRecommendationState(accountId, nextState);
  return {
    rows,
    nextCursor,
    source: 'ai',
  };
}

/** Start a fresh rolling feed. Refresh resets exclusions and the activity profile. */
export async function createRecommendedTimelinePage(
  accountId: string,
  limit: number,
  model: string,
  runModel: RecommendationModelRunner,
  snapshotSeed = crypto.randomUUID(),
): Promise<RecommendedTimelinePage> {
  const state: RecommendationRollingState = {
    version: 2,
    upperBound: new Date().toISOString(),
    shownIds: [],
    rejectedIds: [],
    query: await buildRecommendationInterestQuery(accountId),
    seed: snapshotSeed,
    page: 0,
  };
  return generateRecommendationPage(accountId, state, limit, model, runModel);
}

/** Generate the next rolling page, memoizing a successful cursor response. */
export async function continueRecommendedTimelinePage(
  accountId: string,
  cursor: string,
  limit: number,
  model: string,
  runModel: RecommendationModelRunner,
): Promise<RecommendedTimelinePage | null> {
  const stateId = decodeRecommendationCursor(cursor);
  if (stateId === null) return null;

  const memoized = await loadRecommendationPageMemo(accountId, stateId);
  if (memoized !== null) return memoized;
  const state = await loadRecommendationState(accountId, stateId);
  if (state === null) return null;

  const page = await generateRecommendationPage(accountId, state, limit, model, runModel);
  await storeRecommendationPageMemo(accountId, stateId, page);
  return page;
}
