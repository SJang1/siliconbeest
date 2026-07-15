import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../../server/worker/utils/crypto';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

type RegistrationState =
  | 'pending_approval'
  | 'awaiting_confirmation'
  | 'email_verification'
  | 'active';

interface RegistrationResponse {
  registration_required: boolean;
  registration_state: RegistrationState;
}

interface RegistrationStatus {
  state: RegistrationState;
  username: string;
  email: string;
  email_verification_required: boolean;
  email_verification_expires_at: string | null;
  redirect_uri: string;
  invited_by: {
    id: string;
    username: string;
    display_name: string;
    avatar: string | null;
  } | null;
}

interface ActivationResponse {
  state: 'active';
  access_token: string;
  redirect_uri: string;
  passkey_prompt: boolean;
}

interface CompletionResponse {
  state: 'active';
  redirect_uri: string;
  passkey_prompt: boolean;
}

type RegistrationDesign = 'default' | 'aurora' | 'old';

interface InviteResponse {
  id: string;
  token: string;
  url: string;
  uses_remaining: number;
  expires_at: string | null;
  auto_follow: boolean;
  created_at: string;
}

interface InvitePreview {
  id: string;
  uses_remaining: number;
  expires_at: string | null;
  auto_follow: boolean;
  inviter: {
    id: string;
    username: string;
    display_name: string;
    avatar: string | null;
  };
}

const DELETE_ORDER = [
  'webauthn_credentials',
  'oauth_access_tokens',
  'oauth_authorization_codes',
  'oauth_applications',
  'mentions',
  'statuses',
  'follow_requests',
  'follows',
  'registration_cancellation_cooldowns',
  'registration_email_delivery_limits',
  'registration_invites',
  'actor_keys',
  'users',
  'accounts',
] as const;

let migrated = false;
let registrationRequestIp = 1;

async function resetRegistrationData() {
  for (const table of DELETE_ORDER) {
    await env.DB.prepare(`DELETE FROM "${table}"`).run();
  }
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('registration_mode', 'open', datetime('now'))",
    ),
    env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('require_email_verification', '1', datetime('now'))",
    ),
  ]);
}

async function setRegistrationSettings(
  mode: 'open' | 'approval' | 'referral' | 'closed',
  requireEmailVerification = true,
) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('registration_mode', ?1, datetime('now'))",
    ).bind(mode),
    env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('require_email_verification', ?1, datetime('now'))",
    ).bind(requireEmailVerification ? '1' : '0'),
  ]);
}

function registrationCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  const cookieValue = setCookie?.match(/(?:^|,\s*)siliconbeest_registration=([^;,]+)/)?.[1];
  const cookie = cookieValue
    ? `siliconbeest_registration=${cookieValue}`
    : null;
  expect(cookie).toBeTruthy();
  return cookie ?? '';
}

async function register(
  username: string,
  options: {
    email?: string;
    invite_token?: string;
    reason?: string;
    redirect_uri?: string;
    design?: RegistrationDesign;
  } = {},
) {
  return SELF.fetch(`${BASE}/api/v1/accounts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': `198.51.100.${registrationRequestIp++}`,
    },
    body: JSON.stringify({
      username,
      email: `${username}@test.local`,
      password: 'securepassword123',
      agreement: true,
      locale: 'en',
      ...options,
    }),
  });
}

function authCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookieValue = setCookie.match(/(?:^|,\s*)siliconbeest_token=([^;,]+)/)?.[1];
  expect(cookieValue).toBeTruthy();
  return `siliconbeest_token=${cookieValue ?? ''}`;
}

async function completeRegistration(ticket: string, cookie: string) {
  return SELF.fetch(`${BASE}/api/v1/registration/completion`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ticket }),
  });
}

async function registrationRequest(
  path: string,
  cookie: string,
  body?: Record<string, string>,
) {
  return SELF.fetch(`${BASE}/api/v1/registration${path}`, {
    method: path === '' ? 'GET' : 'POST',
    headers: {
      Cookie: cookie,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function createInvite(
	account: { token: string; accountId: string },
  options: { uses?: number; expires_in_days?: number | null; auto_follow?: boolean } = {},
) {
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT INTO account_invitation_balances
		 (account_id, available_credits, contribution_score, contribution_award_level, created_at, updated_at)
		 VALUES (?1, 10, 0, 0, ?2, ?2)
		 ON CONFLICT (account_id) DO UPDATE SET available_credits = MAX(available_credits, 10), updated_at = ?2`,
	).bind(account.accountId, now).run();
	const response = await SELF.fetch(`${BASE}/api/v1/invites`, {
    method: 'POST',
    headers: authHeaders(account.token),
    body: JSON.stringify({
      uses: options.uses ?? 1,
      expires_in_days: options.expires_in_days ?? 7,
      auto_follow: options.auto_follow ?? true,
    }),
  });
  expect(response.status).toBe(200);
  return response.json<InviteResponse>();
}

describe('enhanced registration flow', () => {
  beforeEach(async () => {
    if (!migrated) {
      await applyMigration();
      migrated = true;
    }
    await resetRegistrationData();
  });

  it('keeps an open registration private until the user confirms it', async () => {
    await setRegistrationSettings('open');

    const response = await register('open_pending');
    expect(response.status).toBe(200);
    expect(await response.json<RegistrationResponse>()).toMatchObject({
      registration_required: true,
      registration_state: 'awaiting_confirmation',
    });

    const user = await env.DB.prepare(
      'SELECT approved, confirmed_at, registration_state FROM users WHERE email = ?1',
    ).bind('open_pending@test.local').first<{
      approved: number;
      confirmed_at: string | null;
      registration_state: RegistrationState;
    }>();
    expect(user).toEqual({
      approved: 0,
      confirmed_at: null,
      registration_state: 'awaiting_confirmation',
    });

    const lookup = await SELF.fetch(`${BASE}/api/v1/accounts/lookup?acct=open_pending`);
    expect(lookup.status).toBe(404);
  });

  it('claims legacy confirmation tokens with lifecycle-aware activation', async () => {
    const legacyOpen = await createTestUser('legacy_open_confirmation');
    const openToken = 'legacy-open-confirmation-token';
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE users
         SET approved = 0, confirmed_at = NULL, confirmation_token = ?1,
             registration_state = 'awaiting_confirmation'
         WHERE id = ?2`,
      ).bind(openToken, legacyOpen.userId),
      env.DB.prepare('UPDATE accounts SET discoverable = 0 WHERE id = ?1')
        .bind(legacyOpen.accountId),
    ]);
    await env.CACHE.put(`email_confirm:${openToken}`, JSON.stringify({
      userId: legacyOpen.userId,
      email: 'legacy_open_confirmation@test.local',
    }));

    const activated = await SELF.fetch(`${BASE}/auth/confirm?token=${openToken}`);
    expect(activated.status).toBe(200);
    expect(await env.DB.prepare(
      `SELECT users.approved, users.registration_state, users.confirmed_at,
              accounts.discoverable
       FROM users JOIN accounts ON accounts.id = users.account_id
       WHERE users.id = ?1`,
    ).bind(legacyOpen.userId).first<{
      approved: number;
      registration_state: RegistrationState;
      confirmed_at: string | null;
      discoverable: number;
    }>()).toMatchObject({
      approved: 1,
      registration_state: 'active',
      discoverable: 1,
    });
    expect(await env.CACHE.get(`email_confirm:${openToken}`)).toBeNull();
    expect((await SELF.fetch(`${BASE}/auth/confirm?token=${openToken}`)).status).toBe(400);

    const legacyApplicant = await createTestUser('legacy_pending_confirmation');
    const pendingToken = 'legacy-pending-confirmation-token';
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE users
         SET approved = 0, confirmed_at = NULL, confirmation_token = ?1,
             registration_state = 'pending_approval'
         WHERE id = ?2`,
      ).bind(pendingToken, legacyApplicant.userId),
      env.DB.prepare('UPDATE accounts SET discoverable = 0 WHERE id = ?1')
        .bind(legacyApplicant.accountId),
    ]);
    await env.CACHE.put(`email_confirm:${pendingToken}`, JSON.stringify({
      userId: legacyApplicant.userId,
      email: 'legacy_pending_confirmation@test.local',
    }));

    expect((await SELF.fetch(`${BASE}/auth/confirm?token=${pendingToken}`)).status).toBe(200);
    const pending = await env.DB.prepare(
      `SELECT users.approved, users.registration_state, users.confirmed_at,
              accounts.discoverable
       FROM users JOIN accounts ON accounts.id = users.account_id
       WHERE users.id = ?1`,
    ).bind(legacyApplicant.userId).first<{
      approved: number;
      registration_state: RegistrationState;
      confirmed_at: string | null;
      discoverable: number;
    }>();
    expect(pending).toMatchObject({
      approved: 0,
      registration_state: 'pending_approval',
      discoverable: 0,
    });
    expect(pending?.confirmed_at).toBeTruthy();
  });

  it('requires a reason only for approval mode without an invitation', async () => {
    await setRegistrationSettings('approval');

    const missingReason = await register('approval_no_reason');
    expect(missingReason.status).toBe(422);

    const response = await register('approval_pending', { reason: 'I want to join.' });
    expect(response.status).toBe(200);
    expect(await response.json<RegistrationResponse>()).toMatchObject({
      registration_state: 'pending_approval',
    });
  });

  it('blocks referral mode without a valid invitation and closed mode even with one', async () => {
    await setRegistrationSettings('referral');
    expect((await register('referral_without_invite')).status).toBe(403);

    const inviter = await createTestUser('closed_inviter');
    const invite = await createInvite(inviter);
    await setRegistrationSettings('closed');
    expect((await register('closed_with_invite', { invite_token: invite.token })).status).toBe(403);
  });

  it('validates the invitation gate before account availability without consuming a valid use', async () => {
    await setRegistrationSettings('referral');
    const inviter = await createTestUser('preflight_inviter');
    await createTestUser('preflight_existing');
    const invite = await createInvite(inviter, { uses: 2 });

    const submit = (inviteToken: string, username: string) => SELF.fetch(`${BASE}/api/v1/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': `198.51.100.${registrationRequestIp++}`,
      },
      body: JSON.stringify({
        username,
        email: 'preflight_existing@test.local',
        password: 'securepassword123',
        agreement: true,
        invite_token: inviteToken,
      }),
    });

    const invalidGate = await submit('0'.repeat(64), 'preflight_probe');
    expect(invalidGate.status).toBe(404);

    const duplicateAfterValidGate = await submit(invite.token, 'preflight_duplicate');
    expect(duplicateAfterValidGate.status).toBe(422);

    expect(await env.DB.prepare(
      'SELECT remaining_uses FROM registration_invites WHERE id = ?1',
    ).bind(invite.id).first<{ remaining_uses: number }>()).toMatchObject({ remaining_uses: 2 });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM invitation_audit_logs WHERE invitation_id = ?1 AND action = 'invite.used'",
    ).bind(invite.id).first<{ count: number }>()).toMatchObject({ count: 0 });
  });

  it('previews an inviter, bypasses approval, consumes a use, and restores it on cancel', async () => {
    const inviter = await createTestUser('invite_owner');
    const invite = await createInvite(inviter, { uses: 2 });
    await setRegistrationSettings('approval');

    const previewResponse = await SELF.fetch(
      `${BASE}/api/v1/registration/invitations/${encodeURIComponent(invite.token)}`,
    );
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json<InvitePreview>()).toMatchObject({
      id: invite.id,
      uses_remaining: 2,
      inviter: { username: 'invite_owner' },
    });

    const response = await register('invited_member', { invite_token: invite.token });
    expect(response.status).toBe(200);
    expect(await response.json<RegistrationResponse>()).toMatchObject({
      registration_state: 'awaiting_confirmation',
    });
    const cookie = registrationCookie(response);

    const linkedUser = await env.DB.prepare(
      'SELECT account_id, invite_id, invited_by_account_id FROM users WHERE email = ?1',
    ).bind('invited_member@test.local').first<{
      account_id: string;
      invite_id: string | null;
      invited_by_account_id: string | null;
    }>();
    expect(linkedUser).toMatchObject({
      invite_id: invite.id,
      invited_by_account_id: inviter.accountId,
    });

    const avatarKey = `avatars/${linkedUser?.account_id ?? ''}_default.svg`;
    const headerKey = `headers/${linkedUser?.account_id ?? ''}_default.svg`;
    expect(await env.MEDIA_BUCKET.head(avatarKey)).toBeTruthy();
    expect(await env.MEDIA_BUCKET.head(headerKey)).toBeTruthy();
    expect(await env.DB.prepare(
      'SELECT remaining_uses FROM registration_invites WHERE id = ?1',
    ).bind(invite.id).first<{ remaining_uses: number }>()).toMatchObject({ remaining_uses: 1 });

    const cancel = await registrationRequest('/cancel', cookie);
    expect(cancel.status).toBe(200);
    expect(await env.DB.prepare(
      'SELECT remaining_uses FROM registration_invites WHERE id = ?1',
    ).bind(invite.id).first<{ remaining_uses: number }>()).toMatchObject({ remaining_uses: 2 });
    expect(await env.DB.prepare(
      'SELECT id FROM users WHERE email = ?1',
    ).bind('invited_member@test.local').first()).toBeNull();
    expect(await env.MEDIA_BUCKET.head(avatarKey)).toBeNull();
    expect(await env.MEDIA_BUCKET.head(headerKey)).toBeNull();
  });

  it('blocks the cancelled email for 24 hours without consuming another invitation use', async () => {
    const email = 'cancelled_cooldown@test.local';
    const inviter = await createTestUser('cooldown_inviter');
    const invite = await createInvite(inviter, { uses: 2 });
    await setRegistrationSettings('referral');

    const first = await register('cooldown_first', {
      email,
      invite_token: invite.token,
    });
    expect(first.status).toBe(200);
    const cancelled = await registrationRequest('/cancel', registrationCookie(first));
    expect(cancelled.status).toBe(200);

    const emailHash = await sha256(email);
    const cooldown = await env.DB.prepare(
      `SELECT email_hash, cancelled_at, expires_at
       FROM registration_cancellation_cooldowns WHERE email_hash = ?1`,
    ).bind(emailHash).first<{
      email_hash: string;
      cancelled_at: string;
      expires_at: string;
    }>();
    expect(cooldown?.email_hash).toBe(emailHash);
    expect(cooldown?.email_hash).not.toContain(email);
    expect(new Date(cooldown?.expires_at ?? '').getTime()
      - new Date(cooldown?.cancelled_at ?? '').getTime()).toBe(24 * 60 * 60 * 1000);

    const blocked = await register('cooldown_retry', {
      email,
      invite_token: invite.token,
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.json<{ error: string }>()).toMatchObject({
      error: 'Registration cancellation cooldown is active',
    });
    expect(await env.DB.prepare(
      'SELECT remaining_uses FROM registration_invites WHERE id = ?1',
    ).bind(invite.id).first<{ remaining_uses: number }>()).toEqual({ remaining_uses: 2 });
    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM invitation_use_claims WHERE invitation_id = ?1',
    ).bind(invite.id).first<{ count: number }>()).toEqual({ count: 0 });

    await env.DB.prepare(
      "UPDATE registration_cancellation_cooldowns SET expires_at = datetime('now', '-1 second') WHERE email_hash = ?1",
    ).bind(emailHash).run();
    const allowed = await register('cooldown_retry', {
      email,
      invite_token: invite.token,
    });
    expect(allowed.status).toBe(200);
    expect(await env.DB.prepare(
      'SELECT remaining_uses FROM registration_invites WHERE id = ?1',
    ).bind(invite.id).first<{ remaining_uses: number }>()).toEqual({ remaining_uses: 1 });
    expect(await env.DB.prepare(
      'SELECT email_hash FROM registration_cancellation_cooldowns WHERE email_hash = ?1',
    ).bind(emailHash).first()).toBeNull();
  });

  it('does not start the cancellation cooldown when an admin rejects an application', async () => {
    const email = 'rejected_no_cooldown@test.local';
    await setRegistrationSettings('approval');
    const application = await register('rejected_first', {
      email,
      reason: 'Please review my application.',
    });
    expect(application.status).toBe(200);

    const pending = await env.DB.prepare(
      "SELECT id FROM accounts WHERE username = 'rejected_first' AND domain IS NULL",
    ).first<{ id: string }>();
    const admin = await createTestUser('cooldown_rejection_admin', { role: 'admin' });
    const rejected = await SELF.fetch(
      `${BASE}/api/v1/admin/accounts/${pending?.id ?? ''}/reject`,
      { method: 'POST', headers: authHeaders(admin.token) },
    );
    expect(rejected.status).toBe(200);
    expect(await env.DB.prepare(
      'SELECT email_hash FROM registration_cancellation_cooldowns WHERE email_hash = ?1',
    ).bind(await sha256(email)).first()).toBeNull();

    const retry = await register('rejected_retry', {
      email,
      reason: 'Submitting again after rejection.',
    });
    expect(retry.status).toBe(200);
  });

  it('lets a pending applicant log in only to the registration session', async () => {
    await setRegistrationSettings('approval');
    await register('pending_login', { reason: 'Community participation' });

    const response = await SELF.fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'pending_login', password: 'securepassword123' }),
    });
    expect(response.status).toBe(200);
    const body = await response.json<RegistrationResponse>();
    expect(body).toMatchObject({
      registration_required: true,
      registration_state: 'pending_approval',
    });
    expect(registrationCookie(response)).toContain('=');
    expect('access_token' in body).toBe(false);
  });

  it('moves an approved applicant to user confirmation without exposing the account', async () => {
    await setRegistrationSettings('approval');
    const response = await register('admin_review', { reason: 'Please approve me.' });
    const cookie = registrationCookie(response);
    const account = await env.DB.prepare(
      "SELECT id FROM accounts WHERE username = 'admin_review' AND domain IS NULL",
    ).first<{ id: string }>();
    const admin = await createTestUser('registration_admin', { role: 'admin' });

    const approve = await SELF.fetch(`${BASE}/api/v1/admin/accounts/${account?.id}/approve`, {
      method: 'POST',
      headers: authHeaders(admin.token),
    });
    expect(approve.status).toBe(200);

    expect(await env.DB.prepare(
      'SELECT approved, registration_state FROM users WHERE account_id = ?1',
    ).bind(account?.id).first<{ approved: number; registration_state: RegistrationState }>())
      .toEqual({ approved: 0, registration_state: 'awaiting_confirmation' });

    const status = await registrationRequest('', cookie);
    expect(status.status).toBe(200);
    expect(await status.json<RegistrationStatus>()).toMatchObject({
      state: 'awaiting_confirmation',
    });
  });

  it('activates without email verification and creates idempotent mutual follows', async () => {
    await setRegistrationSettings('referral', false);
    const inviter = await createTestUser('follow_inviter');
    const existingStatusResponse = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(inviter.token),
      body: JSON.stringify({
        status: 'Existing inviter status',
        visibility: 'public',
      }),
    });
    expect(existingStatusResponse.status).toBe(200);
    const existingStatus = await existingStatusResponse.json<{ id: string }>();
    const invite = await createInvite(inviter, { auto_follow: true });
    const response = await register('follow_invitee', {
      invite_token: invite.token,
      redirect_uri: '/notifications',
    });
    const cookie = registrationCookie(response);

    const activate = await registrationRequest('/continue', cookie);
    expect(activate.status).toBe(200);
    const activation = await activate.json<ActivationResponse>();
    expect(activation).toMatchObject({
      state: 'active',
      redirect_uri: '/notifications',
      passkey_prompt: true,
    });

    const invitee = await env.DB.prepare(
      "SELECT id FROM accounts WHERE username = 'follow_invitee' AND domain IS NULL",
    ).first<{ id: string }>();
    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM follows WHERE (account_id = ?1 AND target_account_id = ?2) OR (account_id = ?2 AND target_account_id = ?1)',
    ).bind(inviter.accountId, invitee?.id).first<{ count: number }>()).toMatchObject({ count: 2 });
    expect(await env.DB.prepare(
      'SELECT approved, registration_state, confirmed_at FROM users WHERE account_id = ?1',
    ).bind(invitee?.id).first<{
      approved: number;
      registration_state: RegistrationState;
      confirmed_at: string | null;
    }>()).toMatchObject({ approved: 1, registration_state: 'active' });

    const homeResponse = await SELF.fetch(`${BASE}/api/v1/timelines/home`, {
      headers: authHeaders(activation.access_token),
    });
    expect(homeResponse.status).toBe(200);
    expect((await homeResponse.json<Array<{ id: string }>>()).map((status) => status.id))
      .toContain(existingStatus.id);
  });

  it('validates an email link with GET and activates exactly once with POST', async () => {
    await setRegistrationSettings('open', true);
    const response = await register('email_challenge', {
      redirect_uri: '/notifications',
    });
    const cookie = registrationCookie(response);

    const start = await registrationRequest('/continue', cookie);
    expect(start.status).toBe(200);
    const challenge = await start.json<{
      state: 'email_verification';
      email_verification_expires_at: string;
    }>();
    const remaining = new Date(challenge.email_verification_expires_at).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(55 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(60 * 60 * 1000);

    const user = await env.DB.prepare(
      'SELECT id, confirmation_token FROM users WHERE email = ?1',
    ).bind('email_challenge@test.local').first<{
      id: string;
      confirmation_token: string;
    }>();
    const confirmationUrl = `${BASE}/auth/confirm?token=${encodeURIComponent(user?.confirmation_token ?? '')}`;

    const preview = await SELF.fetch(confirmationUrl, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    expect(preview.status).toBe(200);
    const previewBody = await preview.text();
    expect(previewBody).toContain('Confirm your email');
    expect(previewBody).toContain('<form');
    expect(previewBody).toMatch(/method=["']post["']/i);
    expect(previewBody).toMatch(/type=["']submit["']/i);
    expect(await env.CACHE.get(
      `email_confirm:${user?.confirmation_token ?? ''}`,
    )).toBeTruthy();
    expect(await env.DB.prepare(
      'SELECT approved, registration_state, confirmed_at, confirmation_token FROM users WHERE id = ?1',
    ).bind(user?.id).first<{
      approved: number;
      registration_state: RegistrationState;
      confirmed_at: string | null;
      confirmation_token: string | null;
    }>()).toEqual({
      approved: 0,
      registration_state: 'email_verification',
      confirmed_at: null,
      confirmation_token: user?.confirmation_token,
    });

    const confirmationAttempts = await Promise.all([1, 2].map(() =>
      SELF.fetch(confirmationUrl, {
        method: 'POST',
        headers: { Cookie: cookie },
        redirect: 'manual',
      }),
    ));
    expect(confirmationAttempts.map((response) => response.status).sort()).toEqual([302, 400]);
    const confirm = confirmationAttempts.find((response) => response.status === 302);
    expect(confirm).toBeDefined();
    const redirectLocation = confirm!.headers.get('location');
    expect(redirectLocation).toBeTruthy();
    const redirect = new URL(redirectLocation ?? '', BASE);
    expect(redirect.pathname).toBe('/auth/registration');
    expect(redirect.searchParams.has('completed')).toBe(false);
    expect(redirect.searchParams.has('redirect')).toBe(false);
    const ticket = redirect.searchParams.get('ticket') ?? '';
    expect(ticket).toMatch(/^[0-9a-f]{64}$/);

    const setCookie = confirm!.headers.get('set-cookie') ?? '';
    const authTokenCookie = authCookie(confirm!);
    expect(setCookie).toContain('siliconbeest_registration=; Path=/; Max-Age=0');
    expect(await env.CACHE.get(
      `email_confirm:${user?.confirmation_token ?? ''}`,
    )).toBeNull();
    const activated = await env.DB.prepare(
      'SELECT approved, registration_state, confirmed_at, confirmation_token FROM users WHERE email = ?1',
    ).bind('email_challenge@test.local').first<{
      approved: number;
      registration_state: RegistrationState;
      confirmed_at: string | null;
      confirmation_token: string | null;
    }>();
    expect(activated).toMatchObject({
      approved: 1,
      registration_state: 'active',
      confirmation_token: null,
    });
    expect(activated?.confirmed_at).toBeTruthy();

    const withoutAuthentication = await SELF.fetch(`${BASE}/api/v1/registration/completion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    expect(withoutAuthentication.status).toBe(401);

    const intruder = await createTestUser('completion_intruder');
    const mismatchedAccount = await SELF.fetch(`${BASE}/api/v1/registration/completion`, {
      method: 'POST',
      headers: authHeaders(intruder.token),
      body: JSON.stringify({ ticket }),
    });
    expect(mismatchedAccount.status).toBe(410);

    const forgedTicket = await completeRegistration('0'.repeat(64), authTokenCookie);
    expect(forgedTicket.status).toBe(410);

    const concurrentCompletions = await Promise.all([
      completeRegistration(ticket, authTokenCookie),
      completeRegistration(ticket, authTokenCookie),
    ]);
    expect(concurrentCompletions.map((response) => response.status).sort()).toEqual([200, 410]);
    const completion = concurrentCompletions.find((response) => response.status === 200);
    expect(completion).toBeDefined();
    expect(await completion!.json<CompletionResponse>()).toEqual({
      state: 'active',
      redirect_uri: '/notifications',
      passkey_prompt: true,
    });

    const reusedTicket = await completeRegistration(ticket, authTokenCookie);
    expect(reusedTicket.status).toBe(410);

    const repeatedConfirm = await SELF.fetch(confirmationUrl, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    expect(repeatedConfirm.status).toBe(400);
    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM oauth_access_tokens WHERE user_id = ?1',
    ).bind(user?.id).first<{ count: number }>()).toEqual({ count: 1 });
    expect(await env.DB.prepare(
      'SELECT confirmed_at FROM users WHERE id = ?1',
    ).bind(user?.id).first<{ confirmed_at: string | null }>()).toEqual({
      confirmed_at: activated?.confirmed_at ?? null,
    });
  });

  it.each([
    { design: 'aurora' as const, confirmPath: '/aurora/auth/confirm', registrationPath: '/aurora/auth/registration' },
    { design: 'old' as const, confirmPath: '/old/auth/confirm', registrationPath: '/old/auth/registration' },
  ])('returns a one-time completion ticket to the $design registration design', async ({
    design,
    confirmPath,
    registrationPath,
  }) => {
    await setRegistrationSettings('open', true);
    const username = `design_${design}`;
    const response = await register(username, { design });
    const registrationSession = registrationCookie(response);
    expect((await registrationRequest('/continue', registrationSession)).status).toBe(200);

    const user = await env.DB.prepare(
      'SELECT confirmation_token, registration_design FROM users WHERE email = ?1',
    ).bind(`${username}@test.local`).first<{
      confirmation_token: string;
      registration_design: RegistrationDesign;
    }>();
    expect(user?.registration_design).toBe(design);

    const confirm = await SELF.fetch(
      `${BASE}${confirmPath}?token=${encodeURIComponent(user?.confirmation_token ?? '')}`,
      { method: 'POST', headers: { Cookie: registrationSession }, redirect: 'manual' },
    );
    expect(confirm.status).toBe(302);
    const redirect = new URL(confirm.headers.get('location') ?? '', BASE);
    expect(redirect.pathname).toBe(registrationPath);
    const ticket = redirect.searchParams.get('ticket') ?? '';
    expect(ticket).toMatch(/^[0-9a-f]{64}$/);

    const authTokenCookie = authCookie(confirm);
    const completion = await completeRegistration(ticket, authTokenCookie);
    expect(completion.status).toBe(200);
    expect(await completion.json<CompletionResponse>()).toEqual({
      state: 'active',
      redirect_uri: '/home',
      passkey_prompt: true,
    });
    expect((await completeRegistration(ticket, authTokenCookie)).status).toBe(410);
  });

  it('returns an expired email challenge to confirmation and rejects external redirects', async () => {
    await setRegistrationSettings('open', true);
    const response = await register('expired_challenge', {
      redirect_uri: 'https://evil.example/steal',
    });
    const cookie = registrationCookie(response);
    await registrationRequest('/continue', cookie);
    await env.DB.prepare(
      "UPDATE users SET email_verification_expires_at = datetime('now', '-1 minute') WHERE email = ?1",
    ).bind('expired_challenge@test.local').run();

    const status = await registrationRequest('', cookie);
    expect(status.status).toBe(200);
    expect(await status.json<RegistrationStatus>()).toMatchObject({
      state: 'awaiting_confirmation',
      redirect_uri: '/home',
      email_verification_expires_at: null,
    });
  });
});
