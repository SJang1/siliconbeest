import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { parsePaginationParams, buildPaginationQuery, buildLinkHeader } from '../../../../utils/pagination';
import { serializeAccount, serializeStatus } from '../../../../utils/mastodonSerializer';
import type { AccountRow, StatusRow } from '../../../../types/db';
import {
	listConversationEntries,
	getConversationParticipants,
	getConversationLastStatus,
} from '../../../../services/conversation';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/conversations — list DM conversations
app.get('/', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const domain = c.env.INSTANCE_DOMAIN;

  const pag = parsePaginationParams({
    max_id: c.req.query('max_id'),
    since_id: c.req.query('since_id'),
    min_id: c.req.query('min_id'),
    limit: c.req.query('limit'),
  });

  const { whereClause, orderClause, limitValue, params } = buildPaginationQuery(pag, 'ca.conversation_id');

  // Get conversation entries for the current user
  const convRows = await listConversationEntries(c.env.DB, currentAccount.id, {
    paginationQuery: pag,
    whereClause,
    orderClause,
    limitValue,
    params,
  });

  const conversations = [];

  for (const conv of convRows) {
    const convId = conv.conversation_id as string;

    // Get other participants
    const participantRows = await getConversationParticipants(c.env.DB, convId, currentAccount.id);

    const accounts = participantRows.map((row: any) =>
      serializeAccount(row as AccountRow, { instanceDomain: c.env.INSTANCE_DOMAIN }),
    );

    // Get last status
    let lastStatus = null;
    if (conv.last_status_id) {
      const statusRow = await getConversationLastStatus(c.env.DB, conv.last_status_id as string);

      if (statusRow) {
        const accountRow: AccountRow = {
          id: statusRow.a_id as string,
          username: statusRow.a_username as string,
          domain: statusRow.a_domain as string | null,
          display_name: statusRow.a_display_name as string,
          note: statusRow.a_note as string,
          uri: statusRow.a_uri as string,
          url: statusRow.a_url as string | null,
          avatar_url: statusRow.a_avatar_url as string,
          avatar_static_url: statusRow.a_avatar_static_url as string,
          header_url: statusRow.a_header_url as string,
          header_static_url: statusRow.a_header_static_url as string,
          locked: statusRow.a_locked as number,
          bot: statusRow.a_bot as number,
          discoverable: statusRow.a_discoverable as number,
          manually_approves_followers: 0,
          statuses_count: statusRow.a_statuses_count as number,
          followers_count: statusRow.a_followers_count as number,
          following_count: statusRow.a_following_count as number,
          last_status_at: statusRow.a_last_status_at as string | null,
          created_at: statusRow.a_created_at as string,
          updated_at: statusRow.a_created_at as string,
          suspended_at: statusRow.a_suspended_at as string | null,
          silenced_at: null,
          memorial: statusRow.a_memorial as number,
          moved_to_account_id: statusRow.a_moved_to_account_id as string | null,
          emoji_tags: (statusRow.a_emoji_tags as string) || null,
        };
        lastStatus = serializeStatus(statusRow as unknown as StatusRow, {
          account: serializeAccount(accountRow, { instanceDomain: c.env.INSTANCE_DOMAIN }),
        });
      }
    }

    conversations.push({
      id: convId,
      accounts,
      last_status: lastStatus,
      unread: !!(conv.unread as number),
    });
  }

  if (pag.minId) conversations.reverse();

  const baseUrl = `https://${domain}/api/v1/conversations`;
  const items = conversations.map((conv) => ({ id: conv.id }));
  const link = buildLinkHeader(baseUrl, items, limitValue);
  const headers: Record<string, string> = {};
  if (link) headers['Link'] = link;

  return c.json(conversations, 200, headers);
});

export default app;
