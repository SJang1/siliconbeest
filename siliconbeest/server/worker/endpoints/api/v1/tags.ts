import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../types';
import { authRequired, authOptional } from '../../../middleware/auth';
import { requireScope } from '../../../middleware/scopeCheck';
import { AppError } from '../../../middleware/errorHandler';
import { generateUlid } from '../../../utils/ulid';
import type { TagRow } from '../../../types/db';

type HonoEnv = { Variables: AppVariables };

function serializeTagResponse(row: TagRow, domain: string, following?: boolean) {
  return {
    name: row.name,
    url: `https://${domain}/tags/${row.name}`,
    history: [],
    following: following ?? false,
  };
}

const app = new Hono<HonoEnv>();

// GET /api/v1/tags/:id — get tag info
app.get('/:id', authOptional, async (c) => {
  const currentAccount = c.get('currentAccount');
  const domain = env.INSTANCE_DOMAIN;
  const tagName = c.req.param('id').toLowerCase();

  const tag = await env.DB.prepare(
    'SELECT * FROM tags WHERE name = ?1',
  )
    .bind(tagName)
    .first<TagRow>();

  if (!tag) {
    throw new AppError(404, 'Record not found');
  }

  let following = false;
  if (currentAccount) {
    const tf = await env.DB.prepare(
      'SELECT id FROM tag_follows WHERE account_id = ?1 AND tag_id = ?2',
    )
      .bind(currentAccount.id, tag.id)
      .first();
    following = !!tf;
  }

  return c.json(serializeTagResponse(tag, domain, following));
});

// POST /api/v1/tags/:id/follow — follow tag
app.post('/:id/follow', authRequired, requireScope('write:follows'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const domain = env.INSTANCE_DOMAIN;
  const tagName = c.req.param('id').toLowerCase();

  const tag = await env.DB.prepare(
    'SELECT * FROM tags WHERE name = ?1',
  )
    .bind(tagName)
    .first<TagRow>();

  if (!tag) {
    throw new AppError(404, 'Record not found');
  }

  const followId = generateUlid();
  const now = new Date().toISOString();
  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO tag_follows (id, account_id, tag_id, created_at) VALUES (?1, ?2, ?3, ?4)',
  )
    .bind(followId, currentAccount.id, tag.id, now)
    .run();
  c.set('contributionApplied', (inserted.meta?.changes ?? 0) > 0);

  return c.json(serializeTagResponse(tag, domain, true));
});

// POST /api/v1/tags/:id/unfollow — unfollow tag
app.post('/:id/unfollow', authRequired, requireScope('write:follows'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const domain = env.INSTANCE_DOMAIN;
  const tagName = c.req.param('id').toLowerCase();

  const tag = await env.DB.prepare(
    'SELECT * FROM tags WHERE name = ?1',
  )
    .bind(tagName)
    .first<TagRow>();

  if (!tag) {
    throw new AppError(404, 'Record not found');
  }

  const removed = await env.DB.prepare(
    'DELETE FROM tag_follows WHERE account_id = ?1 AND tag_id = ?2',
  )
    .bind(currentAccount.id, tag.id)
    .run();
  c.set('contributionApplied', (removed.meta?.changes ?? 0) > 0);

  return c.json(serializeTagResponse(tag, domain, false));
});

export default app;
