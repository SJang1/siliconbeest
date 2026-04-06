import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { env } from 'cloudflare:workers';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { sendToFollowers } from '../../../../federation/helpers/send';
import { editStatus } from '../../../../services/status';
import { serializeAccount } from '../../../../utils/mastodonSerializer';
import type { AccountRow } from '../../../../types/db';
import {
  Update,
  Note,
  Mention,
  Hashtag,
  Image,
  Document as APDocument,
  Source,
  Emoji as APEmoji,
} from '@fedify/vocab';
import { Temporal } from '@js-temporal/polyfill';
import { generateUlid } from '../../../../utils/ulid';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.put('/:id', authRequired, requireScope('write:statuses'), async (c) => {
  const statusId = c.req.param('id');
  const currentUser = c.get('currentUser')!;
  const currentAccountId = currentUser.account_id;
  const domain = env.INSTANCE_DOMAIN;

  let body: {
    status?: string;
    sensitive?: boolean;
    spoiler_text?: string;
    language?: string;
    media_ids?: string[];
  };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  const result = await editStatus(domain, statusId, currentAccountId, {
    text: body.status,
    sensitive: body.sensitive,
    spoilerText: body.spoiler_text,
    language: body.language,
    mediaIds: body.media_ids,
  });

  const { status: updatedRow, content, hashtags, mediaAttachments } = result;

  // Fetch full account data for response
  const accountRow = await env.DB.prepare(
    'SELECT * FROM accounts WHERE id = ?1',
  ).bind(currentAccountId).first<AccountRow>();

  const acct = accountRow!.username;
  const accountData = serializeAccount(accountRow!, { instanceDomain: domain });

  // Federation: deliver Update(Note) to followers via Fedify if status is local
  if (updatedRow.local === 1) {
    try {
      const actorUri = (accountRow!.uri as string) || `https://${domain}/users/${acct}`;
      const followersUri = `${actorUri}/followers`;
      const editVisibility = (updatedRow.visibility as string) || 'public';
      const now = updatedRow.edited_at as string;

      // -- Addressing --
      const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
      let toUrls: URL[];
      let ccUrls: URL[];
      switch (editVisibility) {
        case 'public':
          toUrls = [new URL(AS_PUBLIC)];
          ccUrls = [new URL(followersUri)];
          break;
        case 'unlisted':
          toUrls = [new URL(followersUri)];
          ccUrls = [new URL(AS_PUBLIC)];
          break;
        case 'private':
          toUrls = [new URL(followersUri)];
          ccUrls = [];
          break;
        case 'direct':
          toUrls = [];
          ccUrls = [];
          break;
        default:
          toUrls = [new URL(AS_PUBLIC)];
          ccUrls = [new URL(followersUri)];
      }

      // -- Resolve inReplyTo --
      let replyTarget: URL | undefined;
      if (updatedRow.in_reply_to_id) {
        const parentUri = await env.DB.prepare('SELECT uri FROM statuses WHERE id = ?1').bind(updatedRow.in_reply_to_id).first<{ uri: string }>();
        if (parentUri) replyTarget = new URL(parentUri.uri);
      }

      // -- Conversation context --
      let editConvApUri: string | null = null;
      if (updatedRow.conversation_id) {
        const convRow = await env.DB.prepare('SELECT ap_uri FROM conversations WHERE id = ?1').bind(updatedRow.conversation_id).first<{ ap_uri: string | null }>();
        editConvApUri = convRow?.ap_uri ?? null;
      }

      // -- Hashtag tags --
      const hashtagTags = hashtags.map((tag) =>
        new Hashtag({
          href: new URL(`https://${domain}/tags/${tag}`),
          name: `#${tag}`,
        }),
      );

      // -- Mention tags (from DB) --
      const { results: mentionRows } = await env.DB.prepare(
        `SELECT m.account_id, a.uri AS actor_uri, a.username, a.domain
         FROM mentions m JOIN accounts a ON a.id = m.account_id
         WHERE m.status_id = ?1`,
      ).bind(statusId).all();
      const mentionTags = (mentionRows ?? []).map((m: any) => {
        const mentionAcct = m.domain ? `${m.username}@${m.domain}` : m.username;
        return new Mention({
          href: m.actor_uri ? new URL(m.actor_uri) : undefined,
          name: `@${mentionAcct}`,
        });
      });

      // -- Media attachments --
      const { results: editMediaRows } = await env.DB.prepare(
        'SELECT * FROM media_attachments WHERE status_id = ?1',
      ).bind(statusId).all();
      const mediaAttachmentObjects = (editMediaRows ?? []).map((m: any) => {
        const attUrl = new URL(`https://${domain}/media/${m.file_key}`);
        const attMediaType = m.file_content_type || 'image/jpeg';
        const attName = m.description || null;
        if ((m.type || 'image') === 'image') {
          return new Image({ url: attUrl, mediaType: attMediaType, name: attName });
        }
        return new APDocument({ url: attUrl, mediaType: attMediaType, name: attName });
      });

      // -- Build Fedify Note --
      const noteValues: ConstructorParameters<typeof Note>[0] = {
        id: new URL(updatedRow.uri as string),
        attribution: new URL(actorUri),
        content: (updatedRow.content as string) || content,
        url: new URL((updatedRow.url as string) || `https://${domain}/@${acct}/${statusId}`),
        published: Temporal.Instant.from(updatedRow.created_at as string),
        updated: Temporal.Instant.from(now),
        tos: toUrls,
        ccs: ccUrls,
        sensitive: !!(updatedRow.sensitive),
        summary: (updatedRow.content_warning as string) || null,
      };

      if (replyTarget) noteValues.replyTarget = replyTarget;

      // Build custom emoji tags for federation
      const emojiTagObjects: APEmoji[] = [];
      const editEmojiTags = updatedRow.emoji_tags as string | null;
      if (editEmojiTags) {
        try {
          const parsed = JSON.parse(editEmojiTags) as Array<{ shortcode: string; url: string }>;
          for (const et of parsed) {
            if (!et.shortcode || !et.url) continue;
            emojiTagObjects.push(new APEmoji({
              id: new URL(et.url),
              name: `:${et.shortcode}:`,
              icon: new Image({ url: new URL(et.url), mediaType: 'image/png' }),
            }));
          }
        } catch { /* ignore */ }
      }

      const allTags = [...mentionTags, ...hashtagTags, ...emojiTagObjects];
      if (allTags.length > 0) noteValues.tags = allTags;
      if (mediaAttachmentObjects.length > 0) noteValues.attachments = mediaAttachmentObjects;

      const statusText = (updatedRow.text as string) || '';
      if (statusText) {
        noteValues.source = new Source({ content: statusText, mediaType: 'text/plain' });
      }

      if (editConvApUri) {
        noteValues.contexts = [new URL(editConvApUri)];
      }

      const fedifyNote = new Note(noteValues);

      // -- Build Update activity --
      const update = new Update({
        id: new URL(`https://${domain}/activities/${generateUlid()}`),
        actor: new URL(actorUri),
        object: fedifyNote,
        published: Temporal.Instant.from(now),
        tos: toUrls,
        ccs: ccUrls,
      });

      // -- Send via Fedify --
      const fed = c.get('federation');
      await sendToFollowers(fed, accountRow!.username as string, update);
    } catch (e) {
      console.error('Federation delivery failed for status edit:', e);
    }
  }

  return c.json({
    id: statusId,
    created_at: updatedRow.created_at as string,
    in_reply_to_id: (updatedRow.in_reply_to_id as string) || null,
    in_reply_to_account_id: (updatedRow.in_reply_to_account_id as string) || null,
    sensitive: !!(updatedRow.sensitive),
    spoiler_text: (updatedRow.content_warning as string) || '',
    visibility: (updatedRow.visibility as string) || 'public',
    language: (updatedRow.language as string) || 'en',
    uri: updatedRow.uri as string,
    url: (updatedRow.url as string) || null,
    replies_count: (updatedRow.replies_count as number) || 0,
    reblogs_count: (updatedRow.reblogs_count as number) || 0,
    favourites_count: (updatedRow.favourites_count as number) || 0,
    favourited: false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    pinned: false,
    content,
    reblog: null,
    application: null,
    account: accountData,
    media_attachments: mediaAttachments,
    mentions: [],
    tags: hashtags.map((t) => ({ name: t, url: `https://${domain}/tags/${t}` })),
    emojis: [],
    card: null,
    poll: null,
    edited_at: updatedRow.edited_at as string,
  });
});

export default app;
