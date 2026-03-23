import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { serializeAccount, serializeNotification } from '../../../../utils/mastodonSerializer';
import type { AccountRow, NotificationRow } from '../../../../types/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/:id', authRequired, async (c) => {
  const account = c.get('currentAccount')!;
  const id = c.req.param('id');

  const row: any = await c.env.DB.prepare(`
    SELECT n.*, a.id AS a_id, a.username AS a_username, a.domain AS a_domain,
           a.display_name AS a_display_name, a.note AS a_note, a.uri AS a_uri,
           a.url AS a_url, a.avatar_url AS a_avatar_url, a.avatar_static_url AS a_avatar_static_url,
           a.header_url AS a_header_url, a.header_static_url AS a_header_static_url,
           a.locked AS a_locked, a.bot AS a_bot, a.discoverable AS a_discoverable,
           a.statuses_count AS a_statuses_count, a.followers_count AS a_followers_count,
           a.following_count AS a_following_count, a.last_status_at AS a_last_status_at,
           a.created_at AS a_created_at, a.suspended_at AS a_suspended_at,
           a.memorial AS a_memorial, a.moved_to_account_id AS a_moved_to_account_id
    FROM notifications n
    JOIN accounts a ON a.id = n.from_account_id
    WHERE n.id = ?1 AND n.account_id = ?2
    LIMIT 1
  `).bind(id, account.id).first();

  if (!row) {
    return c.json({ error: 'Record not found' }, 404);
  }

  const accountRow: AccountRow = {
    id: row.a_id, username: row.a_username, domain: row.a_domain,
    display_name: row.a_display_name, note: row.a_note, uri: row.a_uri,
    url: row.a_url, avatar_url: row.a_avatar_url, avatar_static_url: row.a_avatar_static_url,
    header_url: row.a_header_url, header_static_url: row.a_header_static_url,
    locked: row.a_locked, bot: row.a_bot, discoverable: row.a_discoverable,
    manually_approves_followers: 0, statuses_count: row.a_statuses_count,
    followers_count: row.a_followers_count, following_count: row.a_following_count,
    last_status_at: row.a_last_status_at, created_at: row.a_created_at,
    updated_at: row.a_created_at, suspended_at: row.a_suspended_at,
    silenced_at: null, memorial: row.a_memorial, moved_to_account_id: row.a_moved_to_account_id,
  };
  const notifRow: NotificationRow = {
    id: row.id, account_id: row.account_id, from_account_id: row.from_account_id,
    type: row.type, status_id: row.status_id, read: row.read, created_at: row.created_at,
  };

  return c.json(serializeNotification(notifRow, { account: serializeAccount(accountRow) }));
});

export default app;
