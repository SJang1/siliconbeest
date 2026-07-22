import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RegistrationState } from '../../src/types/registration';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://localhost';

type AdminAccountResponse = {
  username: string;
  registration_state: RegistrationState | null;
};

describe('Admin account registration states', () => {
  let admin: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    await applyMigration();
    admin = await createTestUser('registration_state_admin', { role: 'admin' });
  });

  async function createAccountInState(username: string, state: RegistrationState) {
    const account = await createTestUser(username);
    await env.DB_META_C000.prepare(
      'UPDATE users SET approved = ?1, registration_state = ?2 WHERE id = ?3',
    ).bind(state === 'active' ? 1 : 0, state, account.userId).run();
    return account;
  }

  it('separates administrator approval from email verification filters', async () => {
    await createAccountInState('approval_filter_user', 'pending_approval');
    await createAccountInState('confirmation_filter_user', 'awaiting_confirmation');
    await createAccountInState('verification_filter_user', 'email_verification');

    const approvalResponse = await SELF.fetch(
      `${BASE}/api/v1/admin/accounts?pending=true`,
      { headers: authHeaders(admin.token) },
    );
    expect(approvalResponse.status).toBe(200);
    const approvalAccounts = await approvalResponse.json<AdminAccountResponse[]>();
    expect(approvalAccounts.map((account) => account.username)).toContain('approval_filter_user');
    expect(approvalAccounts.every(
      (account) => account.registration_state === 'pending_approval',
    )).toBe(true);

    const verificationResponse = await SELF.fetch(
      `${BASE}/api/v1/admin/accounts?status=verification`,
      { headers: authHeaders(admin.token) },
    );
    expect(verificationResponse.status).toBe(200);
    const verificationAccounts = await verificationResponse.json<AdminAccountResponse[]>();
    expect(verificationAccounts.map((account) => account.username)).toEqual(
      expect.arrayContaining(['confirmation_filter_user', 'verification_filter_user']),
    );
    expect(verificationAccounts.every((account) =>
      account.registration_state === 'awaiting_confirmation'
      || account.registration_state === 'email_verification')).toBe(true);
  });

  it.each(['awaiting_confirmation', 'email_verification'] as const)(
    'allows rejection but not approval while %s',
    async (state) => {
      const username = `reject_${state}`;
      const account = await createAccountInState(username, state);

      const approveResponse = await SELF.fetch(
        `${BASE}/api/v1/admin/accounts/${account.accountId}/approve`,
        { method: 'POST', headers: authHeaders(admin.token) },
      );
      expect(approveResponse.status).toBe(403);

      const rejectResponse = await SELF.fetch(
        `${BASE}/api/v1/admin/accounts/${account.accountId}/reject`,
        { method: 'POST', headers: authHeaders(admin.token) },
      );
      expect(rejectResponse.status).toBe(200);
      expect(await env.DB_META_C000.prepare(
        'SELECT id FROM users WHERE id = ?1',
      ).bind(account.userId).first()).toBeNull();
    },
  );
});
