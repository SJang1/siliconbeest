import { Hono } from 'hono';
import type { Context } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../types';
import { AppError } from '../../../middleware/errorHandler';
import { registerUser, getOrCreateInternalApp, createAccessToken, updateSignInTracking } from '../../../services/auth';
import { createDefaultImages } from '../../../utils/defaultImages';
import { sanitizeLocale } from '../../../utils/locales';
import { setAuthTokenCookie } from '../../../utils/authCookie';
import { getInternalSessionOAuthScopes } from '../../../../../../packages/shared/permissions';

const SETUP_LOCK_KEY = 'setup_admin_seeded';

const app = new Hono<{ Variables: AppVariables }>();
type SetupContext = Context<{ Variables: AppVariables }>;

type SetupCreateBody = {
  username?: string;
  email?: string;
  password?: string;
  locale?: string;
  setup_secret?: string;
};

async function readSetupCreateBody(c: SetupContext): Promise<SetupCreateBody> {
  const contentType = c.req.header('Content-Type') ?? '';

  if (contentType.includes('application/json')) {
    return c.req.json<SetupCreateBody>().catch((): SetupCreateBody => ({}));
  }

  const form = await c.req.parseBody().catch(() => ({})) as Record<string, string | File>;
  return {
    username: typeof form.username === 'string' ? form.username : undefined,
    email: typeof form.email === 'string' ? form.email : undefined,
    password: typeof form.password === 'string' ? form.password : undefined,
    locale: typeof form.locale === 'string' ? form.locale : undefined,
    setup_secret: typeof form.setup_secret === 'string' ? form.setup_secret : undefined,
  };
}

async function getUserCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>();
  return Number(row?.count ?? 0);
}

function getSetupSecret(): string {
  return ((env as unknown as { SETUP_SECRET?: string }).SETUP_SECRET ?? '').trim();
}

async function verifySetupSecret(providedSecret: string | undefined): Promise<boolean> {
  const setupSecret = getSetupSecret();
  if (!setupSecret || !providedSecret) return false;

  const encoder = new TextEncoder();
  const expected = await crypto.subtle.digest('SHA-256', encoder.encode(setupSecret));
  const actual = await crypto.subtle.digest('SHA-256', encoder.encode(providedSecret));

  return crypto.subtle.timingSafeEqual(expected, actual);
}

app.get('/', async (c) => {
  const userCount = await getUserCount();
  return c.json({
    setup_required: userCount === 0,
    user_count: userCount,
  });
});

app.post('/', async (c) => {
  const body = await readSetupCreateBody(c);
  const beforeCount = await getUserCount();
  if (beforeCount !== 0) {
    throw new AppError(403, 'Initial setup is no longer available');
  }

  const setupSecret = (c.req.header('X-Setup-Secret') ?? body.setup_secret)?.trim();

  if (!getSetupSecret()) {
    throw new AppError(503, 'Initial setup is not configured');
  }

  if (!await verifySetupSecret(setupSecret)) {
    throw new AppError(403, 'Invalid setup secret');
  }

  if (!body.username || !body.email || !body.password) {
    throw new AppError(422, 'Validation failed', 'Username, email, and password are required');
  }

  const now = new Date().toISOString();
  const lock = await env.DB.prepare(
    'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)',
  ).bind(SETUP_LOCK_KEY, 'in_progress', now).run();

  if ((lock.meta.changes ?? 0) !== 1) {
    throw new AppError(409, 'Initial setup is already in progress');
  }

  try {
    const lockedCount = await getUserCount();
    if (lockedCount !== 0) {
      throw new AppError(403, 'Initial setup is no longer available');
    }

    const locale = sanitizeLocale(body.locale);
    const email = body.email.trim().toLowerCase();
    const domain = env.INSTANCE_DOMAIN;

    const { account, user } = await registerUser(
      domain,
      email,
      body.password,
      body.username.trim(),
      'open',
    );

    const { avatarUrl, headerUrl } = await createDefaultImages(
      env.MEDIA_BUCKET,
      domain,
      account.id,
      account.username,
    ).catch(() => ({ avatarUrl: '', headerUrl: '' }));

    await env.DB.batch([
      env.DB.prepare(
        'UPDATE accounts SET avatar_url = ?1, avatar_static_url = ?1, header_url = ?2, header_static_url = ?2 WHERE id = ?3',
      ).bind(avatarUrl, headerUrl, account.id),
      env.DB.prepare(
        `UPDATE users
         SET role = 'admin',
             approved = 1,
             confirmed_at = ?1,
             confirmation_token = NULL,
             registration_state = 'active',
             locale = ?2,
             updated_at = ?1
         WHERE id = ?3`,
      ).bind(now, locale, user.id),
      env.DB.prepare(
        'UPDATE accounts SET discoverable = 1, updated_at = ?1 WHERE id = ?2',
      ).bind(now, account.id),
      env.DB.prepare(
        'UPDATE settings SET value = ?1, updated_at = ?2 WHERE key = ?3',
      ).bind(user.id, now, SETUP_LOCK_KEY),
    ]);

    const appRecord = await getOrCreateInternalApp();
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
    const userAgent = c.req.header('User-Agent') || '';
    const scopes = getInternalSessionOAuthScopes('admin');
    const { tokenValue, createdAt } = await createAccessToken(appRecord.id, user.id, {
      ip,
      userAgent,
      email,
      locale,
      scopes,
    });
    await updateSignInTracking(user.id, ip);

    setAuthTokenCookie(c, tokenValue);

    return c.json({
      access_token: tokenValue,
      token_type: 'Bearer',
      scope: scopes,
      created_at: Math.floor(new Date(createdAt).getTime() / 1000),
    });
  } catch (error) {
    await env.DB.prepare('DELETE FROM settings WHERE key = ?1 AND value = ?2')
      .bind(SETUP_LOCK_KEY, 'in_progress')
      .run()
      .catch(() => {});
    throw error;
  }
});

export default app;
