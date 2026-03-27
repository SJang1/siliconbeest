import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

function parseFields(raw: string | null): Array<{ name: string; value: string; verified_at: string | null }> {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

const app = new Hono<HonoEnv>();

app.patch('/update_credentials', authRequired, async (c) => {
  const currentUser = c.get('currentUser')!;
  const domain = c.env.INSTANCE_DOMAIN;

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
    await c.env.MEDIA_BUCKET.put(key, avatarFile.stream(), {
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
    await c.env.MEDIA_BUCKET.put(key, headerFile.stream(), {
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

  // Handle profile fields/metadata
  // Mastodon sends fields_attributes[0][name], fields_attributes[0][value] in FormData
  // or fields_attributes: [{name, value}] in JSON
  const fields: Array<{ name: string; value: string; verified_at: string | null }> = [];
  if (body.fields_attributes) {
    const attrs = body.fields_attributes as any;
    if (Array.isArray(attrs)) {
      for (const f of attrs) {
        if (f && f.name !== undefined) {
          fields.push({ name: String(f.name), value: String(f.value || ''), verified_at: null });
        }
      }
    } else if (typeof attrs === 'object') {
      // Indexed object: { "0": { name, value }, "1": { name, value } }
      for (const key of Object.keys(attrs).sort()) {
        const f = attrs[key];
        if (f && f.name !== undefined) {
          fields.push({ name: String(f.name), value: String(f.value || ''), verified_at: null });
        }
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
        fields.push({ name: f.name, value: f.value, verified_at: null });
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
    await c.env.DB.prepare(sql).bind(...params).run();
  }

  // Fetch updated account
  const row = await c.env.DB.prepare(
    `SELECT a.*, u.locale, u.role
     FROM accounts a
     JOIN users u ON u.account_id = a.id
     WHERE a.id = ?1`,
  ).bind(currentUser.account_id).first();

  if (!row) throw new AppError(404, 'Record not found');

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
    emojis: [],
    fields: parseFields(row.fields as string | null),
    source: {
      privacy: 'public',
      sensitive: false,
      language: (row.locale as string) || 'en',
      note: (row.note as string) || '',
      fields: parseFields(row.fields as string | null),
      follow_requests_count: 0,
    },
  });
});

export default app;
