import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { createDefaultImages } from '../../../../utils/defaultImages';
import { generateToken } from '../../../../utils/crypto';
import { sendConfirmation, notifyAdminsPendingUser } from '../../../../services/email';
import { verifyTurnstile, getTurnstileSettings } from '../../../../utils/turnstile';
import { sanitizeLocale } from '../../../../utils/locales';
import { registerUser, RegisterInput } from '../../../../services/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

function serializeAccount(row: Record<string, unknown>, domain: string) {
  const acct = row.domain ? `${row.username}@${row.domain}` : (row.username as string);
  return {
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
    fields: [],
  };
}

const app = new Hono<HonoEnv>();

app.post('/', async (c) => {
  const body = await c.req.json<{
    username: string;
    email: string;
    password: string;
    agreement: boolean;
    locale?: string;
    reason?: string;
    turnstile_token?: string;
  }>();

  if (!body.username || !body.email || !body.password) {
    throw new AppError(422, 'Validation failed', 'Missing required fields');
  }

  // Normalise email to lowercase for consistent lookups
  body.email = body.email.trim().toLowerCase();

  // Check email domain against email_domain_blocks table
  const emailDomain = body.email.split('@')[1];
  if (emailDomain) {
    const blockedDomain = await c.env.DB.prepare(
      'SELECT 1 FROM email_domain_blocks WHERE domain = ?1 LIMIT 1',
    ).bind(emailDomain.toLowerCase()).first();
    if (blockedDomain) {
      throw new AppError(422, 'Validation failed', 'Email domain is not allowed for registration');
    }
  }

  if (!body.agreement) {
    throw new AppError(422, 'Validation failed', 'Agreement must be accepted');
  }

  // Turnstile CAPTCHA verification (if enabled)
  const turnstile = await getTurnstileSettings(c.env.DB, c.env.CACHE);
  if (turnstile.enabled && turnstile.secretKey) {
    if (!body.turnstile_token) {
      throw new AppError(422, 'Validation failed', 'CAPTCHA verification failed. Please try again.');
    }
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For');
    const valid = await verifyTurnstile(body.turnstile_token, turnstile.secretKey, ip);
    if (!valid) {
      throw new AppError(422, 'Validation failed', 'CAPTCHA verification failed. Please try again.');
    }
  }

  // Check registration mode from DB settings first, fall back to env var
  const dbRegMode = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'registration_mode'").first<{ value: string }>();
  const regMode = dbRegMode?.value || c.env.REGISTRATION_MODE || 'closed';

  const domain = c.env.INSTANCE_DOMAIN;
  const validatedLocale = sanitizeLocale(body.locale);

  // Sanitize reason: strip HTML tags (including unclosed), entities, trim, limit length
  let reason: string | null = null;
  if (body.reason && typeof body.reason === 'string') {
    reason = body.reason
      .replace(/<[^>]*>?/g, '')       // Strip tags including unclosed ones
      .replace(/&[a-zA-Z0-9#]+;/g, '') // Strip HTML entities
      .trim().slice(0, 1000) || null;
  }

  // Register user via auth service (handles uniqueness checks, keypair generation, batch INSERT)
  const { account, user } = await registerUser(
    c.env.DB,
    domain,
    body.email,
    body.password,
    body.username,
    regMode,
  );

  // Generate default avatar and header images
  const { avatarUrl, headerUrl } = await createDefaultImages(
    c.env.MEDIA_BUCKET, domain, account.id, body.username,
  );

  // Update account with default images and update user locale/reason if needed
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE accounts SET avatar_url = ?1, avatar_static_url = ?1, header_url = ?2, header_static_url = ?2 WHERE id = ?3',
    ).bind(avatarUrl, headerUrl, account.id),
    ...(validatedLocale !== 'en' || reason
      ? [c.env.DB.prepare(
          'UPDATE users SET locale = ?1, reason = ?2 WHERE id = ?3',
        ).bind(validatedLocale, reason, user.id)]
      : []),
  ]);

  // Generate email confirmation token and store in KV
  const confirmToken = generateToken(64);
  await c.env.CACHE.put(
    'email_confirm:' + confirmToken,
    JSON.stringify({ userId: user.id, email: body.email }),
    { expirationTtl: 86400 },
  );
  await c.env.DB.prepare('UPDATE users SET confirmation_token = ?1 WHERE id = ?2').bind(confirmToken, user.id).run();

  // Send confirmation email (best-effort, in user's chosen locale)
  try {
    await sendConfirmation(c.env, body.email, confirmToken, validatedLocale);
  } catch { /* email queue failure should not block registration */ }

  // Notify admins if approval is required
  if (regMode === 'approval') {
    try {
      await notifyAdminsPendingUser(
        { ...c.env, DB: c.env.DB },
        body.username,
        body.email,
        reason,
      );
    } catch { /* admin notification failure should not block registration */ }
  }

  return c.json({ confirmation_required: true });
});

export default app;
