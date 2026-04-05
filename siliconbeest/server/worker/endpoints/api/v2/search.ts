import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { authOptional } from '../../../middleware/auth';
import { serializeAccount, serializeStatus, serializeTag } from '../../../utils/mastodonSerializer';
import { enrichStatuses } from '../../../utils/statusEnrichment';
import { generateUlid } from '../../../utils/ulid';
import { getFedifyContext } from '../../../federation/helpers/send';
import { isActor } from '@fedify/fedify/vocab';
import type { AccountRow, StatusRow, TagRow } from '../../../types/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/', authOptional, async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) {
    return c.json({ accounts: [], statuses: [], hashtags: [] });
  }

  const type = c.req.query('type');
  const resolve = c.req.query('resolve') === 'true';
  const limitRaw = parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Math.min(Math.max(limitRaw, 1), 40);
  const offsetRaw = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Math.max(offsetRaw, 0);
  const domain = c.env.INSTANCE_DOMAIN;

  let accounts: any[] = [];
  let statuses: any[] = [];
  let hashtags: any[] = [];

  // Strip leading @ for account username search (DB stores "admin" not "@admin")
  const normalizedQ = q.replace(/^@/, '');
  const searchTerm = `%${normalizedQ}%`;

  // Search accounts
  if (!type || type === 'accounts') {
    const { results } = await c.env.DB.prepare(`
      SELECT * FROM accounts
      WHERE (username LIKE ?1 OR display_name LIKE ?1)
        AND suspended_at IS NULL
      ORDER BY followers_count DESC
      LIMIT ?2 OFFSET ?3
    `).bind(searchTerm, limit, offset).all();

    accounts = (results ?? []).map((row: any) => {
      return serializeAccount(row as AccountRow, { instanceDomain: c.env.INSTANCE_DOMAIN });
    });

    // WebFinger resolution: if resolve=true and query looks like user@domain
    const looksLikeAcct = /^@?[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q);
    console.log(`[search] resolve=${resolve}, looksLikeAcct=${looksLikeAcct}, q="${q}"`);
    if (resolve && looksLikeAcct) {
      const fed = c.get('federation');
      const ctx = getFedifyContext(fed, c.env);
      // Normalize acct for WebFinger lookup
      const normalizedAcct = q.replace(/^@/, '');
      const wfResult = await ctx.lookupWebFinger(`acct:${normalizedAcct}`);
      // Extract actor URI from self link
      const selfLink = wfResult?.links?.find(
        (link) =>
          link.rel === 'self' &&
          (link.type === 'application/activity+json' ||
            link.type === 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"') &&
          link.href,
      );
      const actorUri = selfLink?.href;
      // Extract profile URL
      const profileLink = wfResult?.links?.find(
        (link) =>
          link.rel === 'http://webfinger.net/rel/profile-page' &&
          link.type === 'text/html' &&
          link.href,
      );
      const profileUrl = profileLink?.href;
      console.log(`[search] WebFinger result:`, actorUri || 'null');
      if (actorUri) {
        // Check if we already have this actor in the DB
        const existingActor = await c.env.DB.prepare(
          'SELECT * FROM accounts WHERE uri = ?1',
        ).bind(actorUri).first();

        if (existingActor) {
          // Include existing actor in results if not already present
          const existingId = existingActor.id as string;
          if (!accounts.some((a: any) => a.id === existingId)) {
            accounts.unshift(serializeAccount(existingActor as unknown as AccountRow, { instanceDomain: c.env.INSTANCE_DOMAIN }));
          }
        } else {
          // Fetch remote actor via Fedify lookupObject
          let actorObject: any = null;
          try {
            // Use a real local account for authenticated fetch (not __instance__ which has mismatched keyId)
            const localAcct = await c.env.DB.prepare("SELECT username FROM accounts WHERE domain IS NULL LIMIT 1").first<{ username: string }>();
            const docLoader = await ctx.getDocumentLoader({ identifier: localAcct?.username || 'admin' });
            actorObject = await ctx.lookupObject(actorUri, { documentLoader: docLoader });
          } catch (fetchErr) {
            console.error('[search] lookupObject error:', fetchErr);
          }
          console.log('[search] actorObject:', actorObject ? `id=${actorObject.id?.href}, isActor=${isActor(actorObject)}` : 'null');
          if (actorObject && isActor(actorObject) && actorObject.id) {
            const id = generateUlid();
            const now = new Date().toISOString();
            const username = actorObject.preferredUsername || actorObject.name?.toString() || '';
            const actorDomain = actorObject.id.hostname;
            const iconObj = await actorObject.getIcon();
            const imageObj = await actorObject.getImage();
            const iconUrl = iconObj?.url instanceof URL ? iconObj.url.href : '';
            const imageUrl = imageObj?.url instanceof URL ? imageObj.url.href : '';
            const actorUrl = actorObject.url instanceof URL ? actorObject.url.href : actorObject.id.href;

            const inboxUrl = actorObject.inboxId?.href || '';
            const endpointsObj = actorObject.endpoints;
            const sharedInboxUrl = endpointsObj?.sharedInbox?.href || '';

            await c.env.DB.prepare(
              `INSERT OR IGNORE INTO accounts
                (id, username, domain, display_name, note, uri, url,
                 avatar_url, avatar_static_url, header_url, header_static_url,
                 locked, bot, discoverable, inbox_url, shared_inbox_url,
                 statuses_count, followers_count, following_count,
                 created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, 0, 0, ?17, ?18)`,
            ).bind(
              id,
              username,
              actorDomain,
              actorObject.name?.toString() || username,
              actorObject.summary?.toString() || '',
              actorObject.id.href,
              profileUrl || actorUrl,
              iconUrl,
              iconUrl,
              imageUrl,
              imageUrl,
              actorObject.manuallyApprovesFollowers ? 1 : 0,
              actorObject.constructor.name === 'Service' ? 1 : 0,
              actorObject.discoverable !== false ? 1 : 0,
              inboxUrl,
              sharedInboxUrl,
              now,
              now,
            ).run();

            // Fetch the inserted/existing account
            const insertedAccount = await c.env.DB.prepare(
              'SELECT * FROM accounts WHERE uri = ?1',
            ).bind(actorObject.id.href).first();

            if (insertedAccount) {
              accounts.unshift(serializeAccount(insertedAccount as unknown as AccountRow, { instanceDomain: c.env.INSTANCE_DOMAIN }));
            }
          }
        }
      }
    }
  }

  // Search statuses
  if (!type || type === 'statuses') {
    const { results } = await c.env.DB.prepare(`
      SELECT s.*, a.id AS a_id, a.username AS a_username, a.domain AS a_domain,
             a.display_name AS a_display_name, a.note AS a_note, a.uri AS a_uri,
             a.url AS a_url, a.avatar_url AS a_avatar_url, a.avatar_static_url AS a_avatar_static_url,
             a.header_url AS a_header_url, a.header_static_url AS a_header_static_url,
             a.locked AS a_locked, a.bot AS a_bot, a.discoverable AS a_discoverable,
             a.statuses_count AS a_statuses_count, a.followers_count AS a_followers_count,
             a.following_count AS a_following_count, a.last_status_at AS a_last_status_at,
             a.created_at AS a_created_at, a.suspended_at AS a_suspended_at,
             a.memorial AS a_memorial, a.moved_to_account_id AS a_moved_to_account_id,
             a.emoji_tags AS a_emoji_tags
      FROM statuses s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.content LIKE ?1
        AND s.visibility = 'public'
        AND s.deleted_at IS NULL
      ORDER BY s.id DESC
      LIMIT ?2 OFFSET ?3
    `).bind(searchTerm, limit, offset).all();

    const statusIds = (results ?? []).map((r: any) => r.id as string);
    const currentAccount = c.get('currentAccount');
    const enrichments = await enrichStatuses(
      c.env.DB,
      domain,
      statusIds,
      currentAccount?.id ?? null,
      c.env.CACHE,
    );

    statuses = (results ?? []).map((row: any) => {
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
        emoji_tags: row.a_emoji_tags || null,
      };
      const e = enrichments.get(row.id);
      return serializeStatus(row as StatusRow, {
        account: serializeAccount(accountRow, { instanceDomain: c.env.INSTANCE_DOMAIN }),
        mediaAttachments: e?.mediaAttachments,
        mentions: e?.mentions,
        favourited: e?.favourited,
        reblogged: e?.reblogged,
        bookmarked: e?.bookmarked,
        card: e?.card, poll: e?.poll,
        emojis: e?.emojis,
      });
    });
  }

  // Search hashtags
  if (!type || type === 'hashtags') {
    const { results } = await c.env.DB.prepare(`
      SELECT * FROM tags
      WHERE name LIKE ?1
      ORDER BY name ASC
      LIMIT ?2 OFFSET ?3
    `).bind(searchTerm, limit, offset).all();

    hashtags = (results ?? []).map((row: any) => {
      const tag = serializeTag(row as TagRow);
      tag.url = `https://${domain}/tags/${tag.name}`;
      return tag;
    });
  }

  return c.json({ accounts, statuses, hashtags });
});

export default app;
