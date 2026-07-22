import { env } from 'cloudflare:workers';
import type { WriteReceipt } from '../../../../packages/shared/types/write';
import type { StatusVisibility } from '../../../../packages/shared/permissions';
import { normalizeQuotePolicy } from '../../../../packages/shared/utils/quotePolicy';
import { parseContent } from '../utils/contentParser';
import { sanitizeLocale } from '../utils/locales';
import { generateUlid } from '../utils/ulid';
import { resolveLocalStatusCreationVisibility } from './permissions';
import { acceptWrite } from './writeJournal';
import { getAccountStorage, getActiveShard } from './sharding';

export type SimpleStatusWriteInput = {
  readonly text: string;
  readonly objectType: 'Note' | 'Article';
  readonly visibility?: StatusVisibility;
  readonly sensitive?: boolean;
  readonly spoilerText?: string;
  readonly language?: string;
  readonly mediaIds: readonly string[];
  readonly inReplyToId?: string;
  readonly pollOptions?: readonly string[];
  readonly quoteId?: string;
};

export async function tryAcceptSimpleStatusWrite(
  domain: string,
  accountId: string,
  username: string,
  input: SimpleStatusWriteInput,
): Promise<WriteReceipt | null> {
  if (String(env.ASYNC_STATUS_WRITES) !== 'true') return null;
  if (
    input.objectType !== 'Note'
    || input.mediaIds.length > 0
    || input.inReplyToId
    || input.pollOptions?.length
    || input.quoteId
    || input.visibility === 'direct'
  ) return null;

  const parsed = parseContent(input.text, domain);
  if (parsed.mentions.length > 0 || parsed.tags.length > 0 || /:[a-zA-Z0-9_]+:/.test(input.text)) return null;

  const storage = await getAccountStorage(accountId);
  const shard = await getActiveShard('POSTS', storage.cohort);
  const statusId = generateUlid({ shardOrdinal: shard.ordinal });
  const conversationId = generateUlid({ shardOrdinal: shard.ordinal });
  const operationId = generateUlid();
  const now = new Date().toISOString();
  const visibility = await resolveLocalStatusCreationVisibility(accountId, input.visibility ?? 'public');
  const language = sanitizeLocale(input.language, 'en');
  const quotePolicyRow = await env.DB_META_C000.prepare(
    'SELECT default_quote_policy FROM users WHERE account_id = ?1 LIMIT 1',
  ).bind(accountId).first<{ default_quote_policy: string | null }>();
  const quotePolicy = normalizeQuotePolicy(quotePolicyRow?.default_quote_policy);
  const statusUri = `https://${domain}/users/${username}/statuses/${statusId}`;
  const statusUrl = `https://${domain}/@${username}/${statusId}`;
  const year = now.slice(0, 4);
  const conversationUri = `tag:${domain},${year}:objectId=${conversationId}:objectType=Conversation`;
  const actorUri = `https://${domain}/users/${username}`;
  const followersUri = `${actorUri}/followers`;
  const publicUri = 'https://www.w3.org/ns/activitystreams#Public';
  const to = visibility === 'public' ? [publicUri] : [followersUri];
  const cc = visibility === 'public' ? [followersUri] : visibility === 'unlisted' ? [publicUri] : [];
  const activityId = `https://${domain}/activities/${generateUlid()}`;
  const activity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Create',
    actor: actorUri,
    published: now,
    to,
    cc,
    object: {
      id: statusUri,
      type: 'Note',
      attributedTo: actorUri,
      content: parsed.html,
      source: { content: input.text, mediaType: 'text/plain' },
      url: statusUrl,
      published: now,
      sensitive: !!input.sensitive,
      summary: input.spoilerText || null,
      context: conversationUri,
      to,
      cc,
    },
  };
  const urlMatch = input.text.match(/https?:\/\/[^\s<>"')\]]+/i);

  return acceptWrite({
    operationId,
    entityId: statusId,
    actorKey: accountId,
    kind: 'insert',
    capacityEffect: 'growth',
    shard,
    acceptedAt: now,
    payload: {
      commandType: 'sql_batch',
      statements: [
        {
          sql: 'INSERT OR IGNORE INTO conversations (id, ap_uri, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
          params: [conversationId, conversationUri, now],
        },
        {
          sql: `INSERT OR IGNORE INTO statuses (
                  id, uri, url, object_type, title, account_id, text, content,
                  content_warning, visibility, sensitive, language, conversation_id,
                  reply, quote_approval_status, quote_policy, local, created_at, updated_at
                ) VALUES (?1, ?2, ?3, 'Note', '', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 'none', ?12, 1, ?13, ?13)`,
          params: [
            statusId, statusUri, statusUrl, accountId, input.text, parsed.html,
            input.spoilerText ?? '', visibility, input.sensitive ? 1 : 0, language,
            conversationId, quotePolicy, now,
          ],
        },
        {
          sql: `UPDATE accounts SET statuses_count = (
                  SELECT COUNT(*) FROM statuses WHERE account_id = ?1 AND deleted_at IS NULL
                ), last_status_at = ?2 WHERE id = ?1`,
          params: [accountId, now],
        },
        {
          sql: `INSERT OR IGNORE INTO entity_routes
                (entity_type, entity_id, family, cohort, epoch, ordinal, format_version)
                VALUES ('conversation', ?1, 'INBOX', ?2, ?3, ?4, 1)`,
          params: [conversationId, shard.cohort, shard.epoch, shard.ordinal],
        },
        {
          sql: `INSERT OR IGNORE INTO entity_routes
                (entity_type, entity_id, family, cohort, epoch, ordinal, format_version)
                VALUES ('status', ?1, 'POSTS', ?2, ?3, ?4, 1)`,
          params: [statusId, shard.cohort, shard.epoch, shard.ordinal],
        },
      ],
      pendingResponse: {
        id: statusId,
        uri: statusUri,
        url: statusUrl,
        content: parsed.html,
        visibility,
        created_at: now,
        operation_id: operationId,
        write_state: 'pending',
      },
      postCommitMessages: [
        {
          binding: 'QUEUE_INTERNAL',
          body: { type: 'timeline_fanout', statusId, accountId },
        },
        {
          binding: 'QUEUE_FEDERATION',
          body: { type: 'deliver_activity_fanout', activity, actorAccountId: accountId, statusId },
        },
        ...(urlMatch ? [{
          binding: 'QUEUE_INTERNAL' as const,
          body: { type: 'fetch_preview_card', statusId, url: urlMatch[0] },
        }] : []),
      ],
    },
  });
}
