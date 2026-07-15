import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { isValidLocale } from '../../../../utils/locales';
import { parseCustomEmojiTagsJson } from '../../../../../../../packages/shared/utils/customEmoji';
import { normalizeQuotePolicy } from '../../../../../../../packages/shared/utils/quotePolicy';

type HonoEnv = { Variables: AppVariables };

function parseFields(raw: string | null): Array<{ name: string; value: string; verified_at: string | null }> {
  if (!raw) return [];
  return JSON.parse(raw);
}

function addProfileField(
  fields: Array<{ name: string; value: string; verified_at: string | null }>,
  field: { name?: unknown; value?: unknown },
) {
  const name = String(field.name ?? '');
  const value = String(field.value ?? '');
  if (!name.trim() && !value.trim()) return;
  fields.push({ name, value, verified_at: null });
}

function collectShortcodes(...values: Array<string | null | undefined>): string[] {
  const shortcodes = new Set<string>();
  const regex = /:([A-Za-z0-9_]+):/g;
  for (const value of values) {
    if (!value) continue;
    let match;
    while ((match = regex.exec(value)) !== null) {
      shortcodes.add(match[1]!);
    }
  }
  return [...shortcodes];
}

async function updateLocalAccountEmojiTags(accountId: string, domain: string) {
  const row = await env.DB.prepare(
    'SELECT display_name, note, fields FROM accounts WHERE id = ?1',
  ).bind(accountId).first<{ display_name: string | null; note: string | null; fields: string | null }>();
  if (!row) return;

  const fieldText = parseFields(row.fields).flatMap((field) => [field.name, field.value]).join(' ');
  const shortcodes = collectShortcodes(row.display_name, row.note, fieldText);
  if (shortcodes.length === 0) {
    await env.DB.prepare('UPDATE accounts SET emoji_tags = NULL WHERE id = ?1').bind(accountId).run();
    return;
  }

  const placeholders = shortcodes.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT shortcode, image_key FROM custom_emojis WHERE shortcode IN (${placeholders}) AND (domain IS NULL OR domain = ?)`,
  ).bind(...shortcodes, domain).all<{ shortcode: string; image_key: string }>();

  const emojiTags = (results ?? []).map((emoji) => {
    const url = emoji.image_key.startsWith('http') ? emoji.image_key : `https://${domain}/media/${emoji.image_key}`;
    return { shortcode: emoji.shortcode, url, static_url: url };
  });
  await env.DB.prepare('UPDATE accounts SET emoji_tags = ?1 WHERE id = ?2')
    .bind(emojiTags.length > 0 ? JSON.stringify(emojiTags) : null, accountId)
    .run();
}

const app = new Hono<HonoEnv>();

app.patch('/update_credentials', authRequired, requireScope('write:accounts'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const domain = env.INSTANCE_DOMAIN;
  const before = await env.DB.prepare(
    `SELECT a.avatar_url, a.header_url, a.display_name, a.note, a.locked, a.bot,
            a.discoverable, a.hide_collections, a.fields, a.emoji_tags,
            u.locale, u.default_privacy, u.default_quote_policy
     FROM accounts a JOIN users u ON u.account_id = a.id
     WHERE a.id = ?1`,
  ).bind(currentUser.account_id).first<Record<string, unknown>>();
  if (!before) throw new AppError(404, 'Record not found');

  let body: Record<string, unknown> = {};
  let avatarFile: File | null = null;
  let headerFile: File | null = null;
  const contentType = c.req.header('content-type') || '';
  try {
    if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await c.req.formData();
      for (const [key, value] of formData.entries()) {
        if (key === 'avatar' && value instanceof File) {
          avatarFile = value;
        } else if (key === 'header' && value instanceof File) {
          headerFile = value;
        } else if (typeof value === 'string') {
          if (value === 'true') body[key] = true;
          else if (value === 'false') body[key] = false;
          else body[key] = value;
        }
      }
    } else {
      body = await c.req.json();
    }
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  // Upload avatar to R2
  if (avatarFile) {
    const ext = avatarFile.name.split('.').pop() || 'png';
    const key = `avatars/${currentUser.account_id}.${ext}`;
    await env.MEDIA_BUCKET.put(key, avatarFile.stream(), {
      httpMetadata: { contentType: avatarFile.type },
    });
    const avatarUrl = `https://${domain}/media/${key}`;
    updates.push(`avatar_url = ?${paramIdx++}`);
    params.push(avatarUrl);
    updates.push(`avatar_static_url = ?${paramIdx++}`);
    params.push(avatarUrl);
  }

  // Upload header to R2
  if (headerFile) {
    const ext = headerFile.name.split('.').pop() || 'png';
    const key = `headers/${currentUser.account_id}.${ext}`;
    await env.MEDIA_BUCKET.put(key, headerFile.stream(), {
      httpMetadata: { contentType: headerFile.type },
    });
    const headerUrl = `https://${domain}/media/${key}`;
    updates.push(`header_url = ?${paramIdx++}`);
    params.push(headerUrl);
    updates.push(`header_static_url = ?${paramIdx++}`);
    params.push(headerUrl);
  }

  if (body.display_name !== undefined) {
    updates.push(`display_name = ?${paramIdx++}`);
    params.push(body.display_name as string);
  }
  if (body.note !== undefined) {
    updates.push(`note = ?${paramIdx++}`);
    params.push(body.note as string);
  }
  if (body.locked !== undefined) {
    const lockedVal = body.locked ? 1 : 0;
    updates.push(`locked = ?${paramIdx++}`);
    params.push(lockedVal);
    updates.push(`manually_approves_followers = ?${paramIdx++}`);
    params.push(lockedVal);
  }
  if (body.bot !== undefined) {
    updates.push(`bot = ?${paramIdx++}`);
    params.push(body.bot ? 1 : 0);
  }
  if (body.discoverable !== undefined) {
    updates.push(`discoverable = ?${paramIdx++}`);
    params.push(body.discoverable ? 1 : 0);
  }
  if (body.hide_collections !== undefined) {
    updates.push(`hide_collections = ?${paramIdx++}`);
    params.push(body.hide_collections ? 1 : 0);
  }

  // Handle profile fields/metadata
  // Mastodon sends fields_attributes[0][name], fields_attributes[0][value] in FormData
  // or fields_attributes: [{name, value}] in JSON
  const fields: Array<{ name: string; value: string; verified_at: string | null }> = [];
  if (body.fields_attributes) {
    const attrs = body.fields_attributes as Array<{ name?: unknown; value?: unknown }> | Record<string, { name?: unknown; value?: unknown }>;
    if (Array.isArray(attrs)) {
      for (const f of attrs) {
        if (f) addProfileField(fields, f);
      }
    } else if (typeof attrs === 'object') {
      // Indexed object: { "0": { name, value }, "1": { name, value } }
      for (const key of Object.keys(attrs).sort()) {
        const f = attrs[key];
        if (f) addProfileField(fields, f);
      }
    }
    updates.push(`fields = ?${paramIdx++}`);
    params.push(JSON.stringify(fields));
  } else {
    // Check for flat FormData keys: fields_attributes[0][name], fields_attributes[0][value]
    const fieldMap = new Map<string, { name: string; value: string }>();
    for (const [key, val] of Object.entries(body)) {
      const m = key.match(/^fields_attributes\[(\d+)]\[(\w+)]$/);
      if (m) {
        const idx = m[1]!;
        const prop = m[2]!;
        if (!fieldMap.has(idx)) fieldMap.set(idx, { name: '', value: '' });
        const entry = fieldMap.get(idx)!;
        if (prop === 'name') entry.name = String(val);
        else if (prop === 'value') entry.value = String(val);
      }
    }
    if (fieldMap.size > 0) {
      const sorted = [...fieldMap.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
      for (const [, f] of sorted) {
        addProfileField(fields, f);
      }
      updates.push(`fields = ?${paramIdx++}`);
      params.push(JSON.stringify(fields));
    }
  }

  const now = new Date().toISOString();
  updates.push(`updated_at = ?${paramIdx++}`);
  params.push(now);

  params.push(currentUser.account_id);

  if (updates.length > 1) {
    const sql = `UPDATE accounts SET ${updates.join(', ')} WHERE id = ?${paramIdx}`;
    await env.DB.prepare(sql).bind(...params).run();
  }

  // Handle default language update (source[language] or source.language)
  let sourceLanguage: unknown = body['source[language]'];
  if (!sourceLanguage && typeof body.source === 'object' && body.source !== null) {
    sourceLanguage = (body.source as Record<string, unknown>).language;
  }
  if (typeof sourceLanguage === 'string' && isValidLocale(sourceLanguage)) {
    await env.DB.prepare(
      'UPDATE users SET locale = ?1, updated_at = ?2 WHERE account_id = ?3',
    ).bind(sourceLanguage, now, currentUser.account_id).run();
  }

  // Handle default privacy update (source[privacy] or source.privacy)
  const validPrivacy = ['public', 'unlisted', 'private', 'direct'];
  let sourcePrivacy: unknown = body['source[privacy]'];
  if (!sourcePrivacy && typeof body.source === 'object' && body.source !== null) {
    sourcePrivacy = (body.source as Record<string, unknown>).privacy;
  }
  if (typeof sourcePrivacy === 'string' && validPrivacy.includes(sourcePrivacy)) {
    await env.DB.prepare(
      'UPDATE users SET default_privacy = ?1, updated_at = ?2 WHERE account_id = ?3',
    ).bind(sourcePrivacy, now, currentUser.account_id).run();
  }

  let sourceQuotePolicy: unknown = body['source[quote_policy]'];
  if (!sourceQuotePolicy && typeof body.source === 'object' && body.source !== null) {
    sourceQuotePolicy = (body.source as Record<string, unknown>).quote_policy;
  }
  if (typeof sourceQuotePolicy === 'string') {
    await env.DB.prepare(
      'UPDATE users SET default_quote_policy = ?1, updated_at = ?2 WHERE account_id = ?3',
    ).bind(normalizeQuotePolicy(sourceQuotePolicy), now, currentUser.account_id).run();
  }

  await updateLocalAccountEmojiTags(currentUser.account_id, domain);

  // Fetch updated account
  const row = await env.DB.prepare(
    `SELECT a.*, u.locale, u.role, u.default_privacy, u.default_quote_policy
     FROM accounts a
     JOIN users u ON u.account_id = a.id
     WHERE a.id = ?1`,
  ).bind(currentUser.account_id).first();

  if (!row) throw new AppError(404, 'Record not found');

  const profileFields = [
    'avatar_url',
    'header_url',
    'display_name',
    'note',
    'locked',
    'bot',
    'discoverable',
    'hide_collections',
    'fields',
    'emoji_tags',
    'locale',
    'default_privacy',
    'default_quote_policy',
  ] as const;
  c.set(
    'contributionApplied',
    avatarFile !== null
      || headerFile !== null
      || profileFields.some((field) => before[field] !== row[field]),
  );

  const acct = row.domain ? `${row.username}@${row.domain}` : (row.username as string);

  return c.json({
    id: row.id as string,
    username: row.username as string,
    acct,
    display_name: (row.display_name as string) || '',
    locked: !!(row.locked),
    bot: !!(row.bot),
    discoverable: !!(row.discoverable),
    group: false,
    created_at: row.created_at as string,
    note: (row.note as string) || '',
    url: (row.url as string) || `https://${domain}/@${row.username}`,
    uri: row.uri as string,
    avatar: (row.avatar_url as string) || null,
    avatar_static: (row.avatar_static_url as string) || null,
    header: (row.header_url as string) || null,
    header_static: (row.header_static_url as string) || null,
    followers_count: (row.followers_count as number) || 0,
    following_count: (row.following_count as number) || 0,
    statuses_count: (row.statuses_count as number) || 0,
    last_status_at: (row.last_status_at as string) || null,
    emojis: parseCustomEmojiTagsJson(row.emoji_tags as string | null, domain),
    fields: parseFields(row.fields as string | null),
    source: {
      privacy: (row.default_privacy as string) || 'public',
      sensitive: false,
      language: (row.locale as string) || 'en',
      note: (row.note as string) || '',
      fields: parseFields(row.fields as string | null),
      follow_requests_count: 0,
      hide_collections: !!(row.hide_collections),
      quote_policy: normalizeQuotePolicy(row.default_quote_policy),
    },
  });
});

export default app;
