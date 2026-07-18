import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { env } from 'cloudflare:workers';
import { authOptional } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { enrichStatuses } from '../../../../utils/statusEnrichment';
import type { MediaAttachment } from '../../../../types/mastodon';
import { parseCustomEmojiTagsJson } from '../../../../../../../packages/shared/utils/customEmoji';
import {
  assertStatusViewable,
  canSurfaceStatusToViewer,
  getSurfaceableReblogOriginalId,
} from '../../../../services/permissions';

type HonoEnv = { Variables: AppVariables };

/** Convert any date string to ISO 8601 with milliseconds */
function toISO(d: unknown): string {
  if (!d || typeof d !== 'string') return new Date().toISOString();
  return new Date(d).toISOString();
}

function parseAccountEmojiTags(
  emojiTagsJson: string | null | undefined,
  instanceDomain: string,
): Array<{ shortcode: string; url: string; static_url: string; visible_in_picker: boolean }> {
  return parseCustomEmojiTagsJson(emojiTagsJson, instanceDomain);
}

function serializeStatus(row: Record<string, unknown>, domain: string, currentAccountId?: string, accountEmojis?: any[]) {
  const acct = row.account_domain
    ? `${row.account_username}@${row.account_domain}`
    : (row.account_username as string);

  // Derive account emojis from emoji_tags if not explicitly provided
  const resolvedAccountEmojis = (accountEmojis && accountEmojis.length > 0)
      ? accountEmojis
      : parseAccountEmojiTags(
        row.account_emoji_tags as string | null,
        domain,
      );

  return {
    id: row.id as string,
    object_type: row.poll_id ? 'Question' : row.object_type === 'Article' ? 'Article' : 'Note',
    title: (row.title as string) || '',
    created_at: toISO(row.created_at),
    in_reply_to_id: (row.in_reply_to_id as string) || null,
    in_reply_to_account_id: (row.in_reply_to_account_id as string) || null,
    sensitive: !!(row.sensitive),
    spoiler_text: (row.content_warning as string) || '',
    visibility: (row.visibility as string) || 'public',
    language: (row.language as string) || 'en',
    uri: row.uri as string,
    url: (row.url as string) || null,
    replies_count: (row.replies_count as number) || 0,
    reblogs_count: (row.reblogs_count as number) || 0,
    favourites_count: (row.favourites_count as number) || 0,
    favourited: false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    pinned: !!row.pinned,
    content: (row.content as string) || '',
    filtered: [] as Record<string, unknown>[],
    reblog: null,
    quote: null as import('../../../../types/mastodon').Status | null,
    quote_policy: row.quote_policy === 'followers' || row.quote_policy === 'nobody' ? row.quote_policy : 'public',
    quote_policy_allows: true,
    quote_policy_reason: null as string | null,
    application: null,
    account: {
      id: row.account_id as string,
      username: row.account_username as string,
      acct,
      display_name: (row.account_display_name as string) || '',
      locked: !!(row.account_locked),
      bot: !!(row.account_bot),
      discoverable: !!(row.account_discoverable),
      group: false,
      created_at: toISO(row.account_created_at),
      note: (row.account_note as string) || '',
      url: (row.account_url as string) || `https://${domain}/@${row.account_username}`,
      uri: row.account_uri as string,
      avatar: (row.account_avatar_url as string) || '',
      avatar_static: (row.account_avatar_static_url as string) || (row.account_avatar_url as string) || '',
      header: (row.account_header_url as string) || '',
      header_static: (row.account_header_static_url as string) || (row.account_header_url as string) || '',
      followers_count: (row.account_followers_count as number) || 0,
      following_count: (row.account_following_count as number) || 0,
      statuses_count: (row.account_statuses_count as number) || 0,
      last_status_at: (row.account_last_status_at as string) || null,
      emojis: resolvedAccountEmojis,
      roles: [],
      fields: [],
    },
    media_attachments: [] as MediaAttachment[],
    mentions: [] as { id: string; username: string; acct: string; url: string }[],
    tags: [] as { name: string; url: string }[],
    emojis: [] as { shortcode: string; url: string; static_url: string; visible_in_picker: boolean }[],
    card: null as import('../../../../types/mastodon').PreviewCard | null,
    poll: null as import('../../../../types/mastodon').Poll | null,
    edited_at: (row.edited_at as string) || null,
  };
}

/**
 * Serialize a status with enrichment (media + interaction states).
 * Use this for single-status endpoints (favourite, reblog, fetch, etc.)
 */
async function serializeStatusEnriched(
  row: Record<string, unknown>,
  domain: string,
  currentAccountId?: string | null,
  cache?: KVNamespace,
) {
  const statusId = row.id as string;
  const enrichments = await enrichStatuses(domain, [statusId], currentAccountId, cache);
  const e = enrichments.get(statusId);
  const status = serializeStatus(row, domain, undefined, e?.accountEmojis);
  if (e) {
    status.media_attachments = e.mediaAttachments ?? [];
    status.favourited = e.favourited ?? false;
    status.reblogged = e.reblogged ?? false;
    status.bookmarked = e.bookmarked ?? false;
    status.card = e.card ?? null;
    status.poll = e.poll ?? null;
    status.quote = e.quote ?? null;
    status.emojis = e.emojis ?? [];
    status.mentions = e.mentions ?? [];
    status.quote_policy_allows = e.quotePolicyAllows;
    status.quote_policy_reason = e.quotePolicyReason;
  }
  return status;
}

const STATUS_JOIN_SQL = `
  SELECT s.*,
    a.username AS account_username, a.domain AS account_domain,
    a.display_name AS account_display_name, a.note AS account_note,
    a.uri AS account_uri, a.url AS account_url,
    a.avatar_url AS account_avatar_url, a.avatar_static_url AS account_avatar_static_url,
    a.header_url AS account_header_url, a.header_static_url AS account_header_static_url,
    a.locked AS account_locked, a.bot AS account_bot, a.discoverable AS account_discoverable,
    a.followers_count AS account_followers_count, a.following_count AS account_following_count,
    a.statuses_count AS account_statuses_count, a.last_status_at AS account_last_status_at,
    a.created_at AS account_created_at, a.emoji_tags AS account_emoji_tags
  FROM statuses s
  JOIN accounts a ON a.id = s.account_id
`;

const app = new Hono<HonoEnv>();

app.get('/:id', authOptional, requireScope('read:statuses'), async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')?.account_id ?? null;
  const domain = env.INSTANCE_DOMAIN;

  const row = await env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();

  if (!row) throw new AppError(404, 'Record not found');
  await assertStatusViewable(statusId, currentAccountId);

  const status = await serializeStatusEnriched(
    row,
    domain,
    currentAccountId,
    env.CACHE,
  );
  if (row.reblog_of_id === null) return c.json(status);
  if (typeof row.reblog_of_id !== 'string' || row.reblog_of_id.length === 0) {
    throw new AppError(404, 'Record not found');
  }

  const originalId = await getSurfaceableReblogOriginalId(
    statusId,
    currentAccountId,
  );
  if (!originalId) throw new AppError(404, 'Record not found');

  const originalRow = await env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(originalId).first();
  if (
    !originalRow
    || originalRow.reblog_of_id !== null
    || !await canSurfaceStatusToViewer(originalId, currentAccountId)
  ) {
    throw new AppError(404, 'Record not found');
  }
  const original = await serializeStatusEnriched(
    originalRow,
    domain,
    currentAccountId,
    env.CACHE,
  );
  return c.json({ ...status, reblog: original });
});

export { STATUS_JOIN_SQL, serializeStatus, serializeStatusEnriched };
export default app;
