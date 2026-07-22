import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ActorKeyPermissionRow {
  private_key: string;
  ed25519_private_key: string | null;
  uri: string;
  domain: string | null;
  suspended_at: string | null;
  memorial: number;
  user_disabled: number | null;
  user_approved: number | null;
}

const mocks = vi.hoisted(() => ({
  keyRow: null as ActorKeyPermissionRow | null,
  actorKeyBindings: [] as string[][],
  env: {
    DB_META_C000: { prepare: vi.fn() },
    CACHE: {},
  },
  fetch: vi.fn(),
  createProof: vi.fn(),
  getDeliveryTargetDomains: vi.fn(),
  getSuspendedDomains: vi.fn(),
  ensureInstanceRecord: vi.fn(),
  recordDeliverySuccess: vi.fn(),
  recordDeliveryFailure: vi.fn(),
  signRequestCavage: vi.fn(),
  signRequestRFC9421: vi.fn(),
  getSignaturePreference: vi.fn(),
  setSignaturePreference: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({ env: mocks.env }));
vi.mock('../src/handlers/integrityProofs', () => ({
  createProof: mocks.createProof,
}));
vi.mock('../../packages/shared/domain-blocks', () => ({
  getDeliveryTargetDomains: mocks.getDeliveryTargetDomains,
  getSuspendedDomains: mocks.getSuspendedDomains,
}));
vi.mock('../../packages/shared/services/instance', () => ({
  ensureInstanceRecord: mocks.ensureInstanceRecord,
  recordDeliverySuccess: mocks.recordDeliverySuccess,
  recordDeliveryFailure: mocks.recordDeliveryFailure,
}));
vi.mock('../../packages/shared/crypto', () => ({
  signRequestCavage: mocks.signRequestCavage,
  signRequestRFC9421: mocks.signRequestRFC9421,
  getSignaturePreference: mocks.getSignaturePreference,
  setSignaturePreference: mocks.setSignaturePreference,
}));
vi.mock('../src/utils/repository', () => ({
  getUserAgent: () => 'SiliconBeest/Test',
}));

import { handleDeliverActivity } from '../src/handlers/deliverActivity';

function validKeyRow(): ActorKeyPermissionRow {
  return {
    private_key: 'rsa-private-key',
    ed25519_private_key: null,
    uri: 'https://local.example/users/alice',
    domain: null,
    suspended_at: null,
    memorial: 0,
    user_disabled: 0,
    user_approved: 1,
  };
}

beforeEach(() => {
  mocks.keyRow = null;
  mocks.actorKeyBindings.length = 0;
  mocks.env.DB_META_C000.prepare.mockReset();
  mocks.env.DB_META_C000.prepare.mockImplementation((sql: string) => ({
    bind: (...params: string[]) => ({
      first: async () => {
        mocks.actorKeyBindings.push(params);
        if (sql.includes('FROM actor_keys ak')) return mocks.keyRow;
        throw new Error(`Unexpected first query: ${sql} (${params.join(',')})`);
      },
    }),
  }));
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.createProof.mockReset();
  mocks.getDeliveryTargetDomains.mockReset();
  mocks.getDeliveryTargetDomains.mockResolvedValue(new Set(['target.example']));
  mocks.getSuspendedDomains.mockReset();
  mocks.getSuspendedDomains.mockResolvedValue(new Set());
  mocks.ensureInstanceRecord.mockReset();
  mocks.ensureInstanceRecord.mockResolvedValue(undefined);
  mocks.recordDeliverySuccess.mockReset();
  mocks.recordDeliverySuccess.mockResolvedValue(undefined);
  mocks.recordDeliveryFailure.mockReset();
  mocks.recordDeliveryFailure.mockResolvedValue(undefined);
  mocks.signRequestCavage.mockReset();
  mocks.signRequestCavage.mockResolvedValue({ Signature: 'cavage' });
  mocks.signRequestRFC9421.mockReset();
  mocks.signRequestRFC9421.mockResolvedValue({ Signature: 'rfc9421' });
  mocks.getSignaturePreference.mockReset();
  mocks.getSignaturePreference.mockResolvedValue(null);
  mocks.setSignaturePreference.mockReset();
  mocks.setSignaturePreference.mockResolvedValue(undefined);
});

describe('activity signing principal binding', () => {
  it.each([
    ['the actor key does not exist', null, 'https://local.example/users/alice'],
    [
      'the activity claims a different actor',
      validKeyRow(),
      'https://local.example/users/mallory',
    ],
    [
      'the signing account is remote',
      { ...validKeyRow(), domain: 'remote.example' },
      'https://local.example/users/alice',
    ],
    [
      'the signing account is suspended',
      {
        ...validKeyRow(),
        suspended_at: '2026-07-15T00:00:00.000Z',
      },
      'https://local.example/users/alice',
    ],
    [
      'the signing account is memorialized',
      { ...validKeyRow(), memorial: 1 },
      'https://local.example/users/alice',
    ],
    [
      'the local signing user is disabled',
      { ...validKeyRow(), user_disabled: 1 },
      'https://local.example/users/alice',
    ],
    [
      'the local signing user is unapproved',
      { ...validKeyRow(), user_approved: 0 },
      'https://local.example/users/alice',
    ],
    [
      'a normal local signing account has no user row',
      { ...validKeyRow(), user_disabled: null, user_approved: null },
      'https://local.example/users/alice',
    ],
    [
      'the signing key is empty',
      { ...validKeyRow(), private_key: '' },
      'https://local.example/users/alice',
    ],
  ] satisfies [string, ActorKeyPermissionRow | null, string][])(
    'drops delivery before signing when %s',
    async (_label, keyRow, activityActor) => {
      mocks.keyRow = keyRow;

      await handleDeliverActivity({
        type: 'deliver_activity',
        activity: {
          type: 'Create',
          actor: activityActor,
          object: 'https://local.example/statuses/1',
        },
        actorAccountId: 'alice-account',
        inboxUrl: 'https://target.example/inbox',
      });

      expect(mocks.ensureInstanceRecord).not.toHaveBeenCalled();
      expect(mocks.actorKeyBindings[0]).toEqual(['alice-account']);
      expect(mocks.signRequestRFC9421).not.toHaveBeenCalled();
      expect(mocks.signRequestCavage).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it('signs and delivers an activity for its matching active local actor', async () => {
    mocks.keyRow = validKeyRow();

    await handleDeliverActivity({
      type: 'deliver_activity',
      activity: {
        type: 'Create',
        actor: 'https://local.example/users/alice',
        object: 'https://local.example/statuses/1',
      },
      actorAccountId: 'alice-account',
      inboxUrl: 'https://target.example/inbox',
    });

    expect(mocks.signRequestRFC9421).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.recordDeliverySuccess).toHaveBeenCalledWith(
      mocks.env.DB_META_C000,
      'target.example',
    );
  });

  it('signs the exact terminal self-Delete for a suspended local actor', async () => {
    mocks.keyRow = {
      ...validKeyRow(),
      suspended_at: '2026-07-15T00:00:00.000Z',
    };

    await handleDeliverActivity({
      type: 'deliver_activity',
      activity: {
        type: 'Delete',
        actor: 'https://local.example/users/alice',
        object: 'https://local.example/users/alice',
      },
      actorAccountId: 'alice-account',
      inboxUrl: 'https://target.example/inbox',
    });

    expect(mocks.signRequestRFC9421).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'the actor differs',
      'Delete',
      'https://local.example/users/mallory',
      'https://local.example/users/alice',
    ],
    [
      'the object differs',
      'Delete',
      'https://local.example/users/alice',
      'https://local.example/users/mallory',
    ],
    [
      'the object only shares the actor prefix',
      'Delete',
      'https://local.example/users/alice',
      'https://local.example/users/alice/statuses/1',
    ],
    [
      'the type only resembles Delete',
      'DeleteActor',
      'https://local.example/users/alice',
      'https://local.example/users/alice',
    ],
    [
      'the object is a SQL-shaped URI',
      'Delete',
      'https://local.example/users/alice',
      "https://local.example/users/alice' OR 1=1 --",
    ],
  ] satisfies [string, string, string, string][])('does not sign a suspended actor when %s', async (
    _label,
    activityType,
    activityActor,
    activityObject,
  ) => {
    mocks.keyRow = {
      ...validKeyRow(),
      suspended_at: '2026-07-15T00:00:00.000Z',
    };

    await handleDeliverActivity({
      type: 'deliver_activity',
      activity: {
        type: activityType,
        actor: activityActor,
        object: activityObject,
      },
      actorAccountId: 'alice-account',
      inboxUrl: 'https://target.example/inbox',
    });

    expect(mocks.actorKeyBindings[0]).toEqual(['alice-account']);
    expect(mocks.signRequestRFC9421).not.toHaveBeenCalled();
    expect(mocks.signRequestCavage).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not treat an embedded actor object as a terminal self-Delete URI', async () => {
    mocks.keyRow = {
      ...validKeyRow(),
      suspended_at: '2026-07-15T00:00:00.000Z',
    };

    await handleDeliverActivity({
      type: 'deliver_activity',
      activity: {
        type: 'Delete',
        actor: 'https://local.example/users/alice',
        object: {
          type: 'Person',
          id: 'https://local.example/users/alice',
        },
      },
      actorAccountId: 'alice-account',
      inboxUrl: 'https://target.example/inbox',
    });

    expect(mocks.signRequestRFC9421).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('allows the __instance__ system principal without a user row', async () => {
    mocks.keyRow = {
      ...validKeyRow(),
      uri: 'https://local.example/actor',
      user_disabled: null,
      user_approved: null,
    };

    await handleDeliverActivity({
      type: 'deliver_activity',
      activity: {
        type: 'Follow',
        actor: 'https://local.example/actor',
        object: 'https://relay.example/actor',
      },
      actorAccountId: '__instance__',
      inboxUrl: 'https://target.example/inbox',
    });

    expect(mocks.actorKeyBindings[0]).toEqual(['__instance__']);
    expect(mocks.signRequestRFC9421).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
