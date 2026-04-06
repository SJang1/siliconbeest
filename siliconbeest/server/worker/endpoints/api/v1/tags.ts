import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../types';
import { authRequired, authOptional } from '../../../middleware/auth';
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
app.post('/:id/follow', authRequired, async (c) => {
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

  // Check if already following
  const existing = await env.DB.prepare(
    'SELECT id FROM tag_follows WHERE account_id = ?1 AND tag_id = ?2',
  )
    .bind(currentAccount.id, tag.id)
    .first();

  if (!existing) {
    const followId = generateUlid();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO tag_follows (id, account_id, tag_id, created_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(followId, currentAccount.id, tag.id, now)
      .run();
  }

  return c.json(serializeTagResponse(tag, domain, true));
});

// POST /api/v1/tags/:id/unfollow — unfollow tag
app.post('/:id/unfollow', authRequired, async (c) => {
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

  await env.DB.prepare(
    'DELETE FROM tag_follows WHERE account_id = ?1 AND tag_id = ?2',
  )
    .bind(currentAccount.id, tag.id)
    .run();

  return c.json(serializeTagResponse(tag, domain, false));
});

export default app;
