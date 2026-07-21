import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { parsePaginationParams } from '../../../../utils/pagination';
import { serializeOriginalTimelineRows } from '../../../../utils/timelineSerialization';
import {
  continueRecommendedTimelinePage,
  createRecommendedTimelinePage,
  RECOMMENDATION_DEFAULT_PAGE_LIMIT,
  RecommendationGenerationError,
} from '../../../../services/recommendation';
import {
  getWorkersAiModels,
  runWorkersAiModel,
} from '../../../../services/workersAi';
import { consumeWorkersAiRateLimit } from '../../../../services/workersAiRateLimit';
import { isWorkersAiFeatureEnabled } from '../../../../services/workersAiFeatures';

const app = new Hono<{ Variables: AppVariables }>();

app.on(['GET', 'POST'], '/', authRequired, requireScope('read:statuses'), async (c) => {
  if (!await isWorkersAiFeatureEnabled('recommendation')) {
    return c.json({
      error: 'AI recommended timeline is not enabled',
      error_code: 'AI_RECOMMENDATION_DISABLED',
    }, 404);
  }

  const account = c.get('currentAccount');
  if (!account) {
    return c.json({ error: 'The access token is invalid' }, 401);
  }
  const pag = parsePaginationParams({
    limit: c.req.query('limit') ?? String(RECOMMENDATION_DEFAULT_PAGE_LIMIT),
  });
  const cursor = c.req.query('cursor');

  // Every page performs paid inference over a replenished candidate window.
  // POST prevents browser/proxy prefetch from consuming model quota.
  if (c.req.method !== 'POST') {
    return c.json({
      error: 'Generate recommendation pages with POST',
      error_code: 'AI_RECOMMENDATION_POST_REQUIRED',
    }, 405, {
      Allow: 'POST',
      'Cache-Control': 'private, no-store',
      Vary: 'Authorization',
    });
  }

  const rateLimit = await consumeWorkersAiRateLimit('recommendation', account.id);
  if (!rateLimit.allowed) {
    const unavailable = rateLimit.reason === 'unavailable';
    return c.json({
      error: unavailable
        ? 'AI recommendation rate-limit guard is unavailable'
        : 'AI recommendation request limit exceeded',
      error_code: unavailable
        ? 'AI_RECOMMENDATION_UNAVAILABLE'
        : 'AI_RECOMMENDATION_RATE_LIMITED',
    }, unavailable ? 503 : 429, {
      'Cache-Control': 'private, no-store',
      'Retry-After': String(rateLimit.retryAfterSeconds),
      Vary: 'Authorization',
    });
  }

  try {
    const model = getWorkersAiModels().recommendation;
    const page = cursor
      ? await continueRecommendedTimelinePage(
        account.id,
        cursor,
        pag.limit,
        model,
        runWorkersAiModel,
      )
      : await createRecommendedTimelinePage(
        account.id,
        pag.limit,
        model,
        runWorkersAiModel,
      );

    if (page === null) {
      return c.json({
        error: 'Recommendation cursor was not found or has expired',
        error_code: 'AI_RECOMMENDATION_CURSOR_INVALID',
      }, 404, {
        'Cache-Control': 'private, no-store',
        Vary: 'Authorization',
      });
    }

    const statuses = await serializeOriginalTimelineRows(
      page.rows,
      account.id,
      c.get('preferredLanguages'),
    );
    const headers: Record<string, string> = {
      'Cache-Control': 'private, no-store',
      Vary: 'Authorization',
      'X-SiliconBeest-Recommendation-Source': page.source,
    };
    if (page.nextCursor) {
      const baseUrl = `https://${env.INSTANCE_DOMAIN}/api/v1/timelines/recommended`;
      headers.Link = `<${baseUrl}?cursor=${encodeURIComponent(page.nextCursor)}&limit=${pag.limit}>; rel="next"`;
    }

    return c.json(statuses, 200, headers);
  } catch (error) {
    if (error instanceof RecommendationGenerationError) {
      return c.json({
        error: error.message,
        error_code: error.code,
        ...(error.reason ? { error_description: error.reason } : {}),
      }, 503, {
        'Cache-Control': 'private, no-store',
        Vary: 'Authorization',
      });
    }
    // eslint-disable-next-line functional/no-throw-statements -- Global error middleware handles non-AI failures.
    throw error;
  }
});

export default app;
