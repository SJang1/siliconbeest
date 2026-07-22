import { env } from 'cloudflare:workers';
import type {
  IdentityDirectoryMapping,
  IdentityReservationDO,
} from '../durableObjects/identityReservation';

type IdentityType = 'email' | 'username';
type DigestNamespace = IdentityType | 'idempotency';
type Reservation = { type: IdentityType; normalized: string; digest: string };

type IdentityEnv = Omit<Env, 'IDENTITY_RESERVATION_DO'> & {
  IDENTITY_RESERVATION_DO: DurableObjectNamespace<IdentityReservationDO>;
};

function identityEnv(): IdentityEnv { return env as unknown as IdentityEnv; }

function normalize(type: DigestNamespace, value: string): string {
  return type === 'email' ? value.trim().toLowerCase() : value.trim().toLowerCase();
}

function secret(): string {
  const dedicated = Reflect.get(env, 'IDENTITY_DIRECTORY_HMAC_KEY');
  if (typeof dedicated === 'string' && dedicated.length >= 32) return dedicated;
  const rollingFallback = Reflect.get(env, 'OTP_ENCRYPTION_KEY');
  if (typeof rollingFallback === 'string' && rollingFallback.length >= 32) return rollingFallback;
  throw new Error('IDENTITY_DIRECTORY_HMAC_KEY secret is not configured');
}

export async function identityDigest(type: DigestNamespace, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`identity-directory:v1:${type}:${normalize(type, value)}`),
  ));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function reservations(email: string, username: string): Promise<Reservation[]> {
  return (await Promise.all([
    identityDigest('email', email).then((digest) => ({ type: 'email' as const, normalized: normalize('email', email), digest })),
    identityDigest('username', username).then((digest) => ({ type: 'username' as const, normalized: normalize('username', username), digest })),
  ])).sort((left, right) => left.digest.localeCompare(right.digest));
}

export interface IdentityReservationResult {
  readonly digests: Readonly<Record<IdentityType, string>>;
  readonly existingOperationId: string | null;
  readonly conflict: boolean;
}

export async function reserveRegistrationIdentities(
  operationId: string,
  email: string,
  username: string,
): Promise<IdentityReservationResult> {
  const entries = await reservations(email, username);
  const acquired: Reservation[] = [];
  for (const entry of entries) {
    const stub = identityEnv().IDENTITY_RESERVATION_DO.getByName(entry.digest);
    const outcome = await stub.reserve(operationId);
    if (outcome === 'conflict') {
      const owner = await stub.owner();
      for (const held of acquired) {
        await identityEnv().IDENTITY_RESERVATION_DO.getByName(held.digest).release(operationId);
      }
      return {
        digests: Object.fromEntries(entries.map((item) => [item.type, item.digest])) as Record<IdentityType, string>,
        existingOperationId: owner?.state === 'reserved' ? owner.operationId : null,
        conflict: true,
      };
    }
    acquired.push(entry);
  }
  return {
    digests: Object.fromEntries(entries.map((item) => [item.type, item.digest])) as Record<IdentityType, string>,
    existingOperationId: null,
    conflict: false,
  };
}

export async function releaseRegistrationIdentities(
  operationId: string,
  email: string,
  username: string,
): Promise<void> {
  for (const entry of await reservations(email, username)) {
    await identityEnv().IDENTITY_RESERVATION_DO.getByName(entry.digest).release(operationId);
  }
}

export async function commitRegistrationIdentities(
  operationId: string,
  email: string,
  username: string,
  mapping: IdentityDirectoryMapping,
): Promise<void> {
  for (const entry of await reservations(email, username)) {
    const committed = await identityEnv().IDENTITY_RESERVATION_DO.getByName(entry.digest).commit(operationId, mapping);
    if (!committed) throw new Error(`Lost ${entry.type} identity reservation for ${operationId}`);
    await env.DB_META_C000.prepare(
      `INSERT OR IGNORE INTO identity_directory (
         identity_hash, identity_type, account_id, user_id, cohort, meta_ordinal, meta_binding
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      entry.digest, entry.type, mapping.accountId, mapping.userId,
      mapping.cohort, mapping.metaOrdinal, mapping.metaBinding,
    ).run();
  }
}
