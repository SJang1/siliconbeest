import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authOptional } from '../../../../middleware/auth';
import { parsePaginationParams, buildLinkHeader } from '../../../../utils/pagination';
import { serializeOriginalTimelineRows } from '../../../../utils/timelineSerialization';
import { getTagTimeline } from '../../../../services/timeline';
import { buildFeedLinkHeader } from '../../../../utils/feedCursor';

const app = new Hono<{ Variables: AppVariables }>();

app.get('/:tag', authOptional, async (c) => {
  const tagName = c.req.param('tag').toLowerCase();

  const pag = parsePaginationParams({
    max_id: c.req.query('max_id'),
    since_id: c.req.query('since_id'),
    min_id: c.req.query('min_id'),
    limit: c.req.query('limit'),
  });

  const local = c.req.query('local') === 'true';
  const onlyMedia = c.req.query('only_media') === 'true';

  const currentAccount = c.get('currentAccount');

  const allRows = await getTagTimeline(tagName, {
    maxId: pag.maxId,
    sinceId: pag.sinceId,
    minId: pag.minId,
    limit: pag.limit,
    local,
    onlyMedia,
    viewerAccountId: currentAccount?.id,
  });

  const statuses = await serializeOriginalTimelineRows(
    allRows,
    currentAccount?.id ?? null,
    c.get('preferredLanguages'),
  );

  if (pag.minId) statuses.reverse();

  const baseUrl = `https://${env.INSTANCE_DOMAIN}/api/v1/timelines/tag/${encodeURIComponent(tagName)}`;
  const linkRows = pag.minId ? [...allRows].reverse() : allRows;
  const link = String(env.SEARCH_FEED_READS) === 'true'
    ? await buildFeedLinkHeader(baseUrl, linkRows, pag.limit, `tag:${tagName}`)
    : buildLinkHeader(baseUrl, statuses, pag.limit);
  const headers: Record<string, string> = {};
  if (link) headers['Link'] = link;

  return c.json(statuses, 200, headers);
});

export default app;
