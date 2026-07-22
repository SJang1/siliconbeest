/* oxlint-disable fp/no-throw-statements, fp/no-try-statements */

import { env } from 'cloudflare:workers';
import { AppError } from '../middleware/errorHandler';
import type {
  RegistrationCommand,
  RegistrationOperation,
  RegistrationProgress,
} from '../../../../packages/shared/types/registration';
import type { RegistrationJournalDO } from '../durableObjects/registrationJournal';
import type { IdentityReservationDO } from '../durableObjects/identityReservation';
import { generateUlid } from '../utils/ulid';
import { hashPassword } from '../utils/crypto';
import { verifyPassword as verifyPasswordHash } from '../utils/crypto';
import { createDefaultImages } from '../utils/defaultImages';
import { notifyAdminsPendingUser } from './email';
import { registerPreparedUser } from './auth';
import {
  consumeRegistrationInvitation,
  initializeRegistration,
  restoreRegistrationInvitation,
  type RegistrationInvitePreview,
} from './registration';
import { chooseRegistrationCohort, getActiveShard, resolveShardDatabase } from './sharding';
import {
  commitRegistrationIdentities,
  identityDigest,
  releaseRegistrationIdentities,
  reserveRegistrationIdentities,
} from './identityDirectory';

type AsyncRegistrationEnv = Omit<Env, 'REGISTRATION_JOURNAL_DO' | 'IDENTITY_RESERVATION_DO'> & {
  REGISTRATION_JOURNAL_DO: DurableObjectNamespace<RegistrationJournalDO>;
  IDENTITY_RESERVATION_DO: DurableObjectNamespace<IdentityReservationDO>;
};

function registrationEnv(): AsyncRegistrationEnv { return env as unknown as AsyncRegistrationEnv; }

export async function acceptAsyncRegistration(input: {
  email: string;
  username: string;
  password: string;
  locale: string;
  reason: string | null;
  registrationState: RegistrationCommand['registrationState'];
  registrationMode: RegistrationCommand['registrationMode'];
  redirectUri: string | null;
  design: RegistrationCommand['design'];
  invitationToken: string | null;
  idempotencyKey: string | null;
}): Promise<RegistrationOperation> {
  const operationId = generateUlid({ timestampMs: Date.now() });
  let idempotencyDigest: string | null = null;
  if (input.idempotencyKey) {
    idempotencyDigest = await identityDigest('idempotency', input.idempotencyKey);
    const idempotency = registrationEnv().IDENTITY_RESERVATION_DO.getByName(`idempotency:${idempotencyDigest}`);
    const outcome = await idempotency.reserve(operationId, 24 * 60 * 60 * 1000);
    if (outcome === 'conflict') {
      const owner = await idempotency.owner();
      if (owner) {
        const existing = await registrationEnv().REGISTRATION_JOURNAL_DO
          .getByName(owner.operationId).getOperation(owner.operationId);
        if (existing) return existing;
      }
      throw new Error('Idempotency key is held by an unknown registration operation');
    }
  }
  const reservation = await reserveRegistrationIdentities(operationId, input.email, input.username);
  if (reservation.existingOperationId) {
    const existing = await registrationEnv().REGISTRATION_JOURNAL_DO
      .getByName(reservation.existingOperationId)
      .getOperation(reservation.existingOperationId);
    if (existing) return existing;
    throw new Error('Identity is reserved by an unknown registration operation');
  }
  if (reservation.conflict) throw new AppError(422, 'Validation failed', 'Registration identity is already in use');

  try {
    const cohort = await chooseRegistrationCohort(operationId);
    const shard = await getActiveShard('META', cohort.cohort);
    const command: RegistrationCommand = {
      operationId,
      accountId: generateUlid({ shardOrdinal: shard.ordinal }),
      userId: generateUlid({ shardOrdinal: shard.ordinal }),
      actorKeyId: generateUlid({ shardOrdinal: shard.ordinal }),
      email: input.email,
      username: input.username,
      encryptedPassword: await hashPassword(input.password),
      locale: input.locale,
      reason: input.reason,
      registrationState: input.registrationState,
      registrationMode: input.registrationMode,
      redirectUri: input.redirectUri,
      design: input.design,
      invitationToken: input.invitationToken,
      shard,
      acceptedAt: new Date().toISOString(),
    };
    return await registrationEnv().REGISTRATION_JOURNAL_DO.getByName(operationId).accept(command);
  } catch (error) {
    await releaseRegistrationIdentities(operationId, input.email, input.username);
    if (idempotencyDigest) {
      await registrationEnv().IDENTITY_RESERVATION_DO
        .getByName(`idempotency:${idempotencyDigest}`).release(operationId);
    }
    throw error;
  }
}

export async function getRegistrationOperation(operationId: string): Promise<RegistrationOperation | null> {
  return registrationEnv().REGISTRATION_JOURNAL_DO.getByName(operationId).getOperation(operationId);
}

export async function findPendingRegistration(
  identifier: string,
  password: string,
): Promise<RegistrationOperation | null> {
  const namespace = identifier.includes('@') ? 'email' as const : 'username' as const;
  const digest = await identityDigest(namespace, identifier);
  const owner = await registrationEnv().IDENTITY_RESERVATION_DO.getByName(digest).owner();
  if (!owner || owner.state !== 'reserved') return null;
  const journal = registrationEnv().REGISTRATION_JOURNAL_DO.getByName(owner.operationId);
  const command = await journal.getCommand(owner.operationId);
  if (!command || !await verifyPasswordHash(password, command.encryptedPassword)) return null;
  return journal.getOperation(owner.operationId);
}

export async function updateRegistrationOperation(progress: RegistrationProgress): Promise<void> {
  await registrationEnv().REGISTRATION_JOURNAL_DO.getByName(progress.operationId).update(progress);
}

export async function applyRegistration(command: RegistrationCommand): Promise<void> {
  const journal = registrationEnv().REGISTRATION_JOURNAL_DO.getByName(command.operationId);
  await journal.update({ operationId: command.operationId, state: 'applying' });
  const existingSaga = await env.DB_META_C000.prepare(
    'SELECT state, invitation_json FROM registration_sagas WHERE operation_id = ?1',
  ).bind(command.operationId).first<{ state: string; invitation_json: string | null }>();
  if (existingSaga?.state === 'completed') {
    await journal.update({ operationId: command.operationId, state: 'committed' });
    return;
  }

  await env.DB_META_C000.prepare(
    `INSERT OR IGNORE INTO registration_sagas (
       operation_id, account_id, user_id, state, created_at, updated_at
     ) VALUES (?1, ?2, ?3, 'applying', ?4, ?4)`,
  ).bind(command.operationId, command.accountId, command.userId, new Date().toISOString()).run();

  let invitation = existingSaga?.invitation_json
    ? JSON.parse(existingSaga.invitation_json) as RegistrationInvitePreview
    : null;
  try {
    if (command.invitationToken && !invitation) {
      invitation = await consumeRegistrationInvitation(command.invitationToken);
      await env.DB_META_C000.prepare(
        'UPDATE registration_sagas SET invitation_json = ?1, updated_at = ?2 WHERE operation_id = ?3',
      ).bind(JSON.stringify(invitation), new Date().toISOString(), command.operationId).run();
    }

    const db = resolveShardDatabase(command.shard);
    const existingAccount = await db.prepare('SELECT id FROM accounts WHERE id = ?1')
      .bind(command.accountId).first<{ id: string }>();
    if (!existingAccount) {
      await registerPreparedUser({
        db,
        domain: env.INSTANCE_DOMAIN,
        email: command.email,
        username: command.username,
        encryptedPassword: command.encryptedPassword,
        accountId: command.accountId,
        userId: command.userId,
        actorKeyId: command.actorKeyId,
        initialRegistrationState: command.registrationState,
      });
    }
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT OR IGNORE INTO account_storage (account_id, cohort) VALUES (?1, ?2)`,
      ).bind(command.accountId, command.shard.cohort),
      env.DB_META_C000.prepare(
        `INSERT OR IGNORE INTO entity_routes (
           entity_type, entity_id, family, cohort, epoch, ordinal, format_version
         ) VALUES ('account', ?1, 'META', ?2, ?3, ?4, 1)`,
      ).bind(command.accountId, command.shard.cohort, command.shard.epoch, command.shard.ordinal),
      env.DB_META_C000.prepare(
        `INSERT OR IGNORE INTO entity_routes (
           entity_type, entity_id, family, cohort, epoch, ordinal, format_version
         ) VALUES ('user', ?1, 'META', ?2, ?3, ?4, 1)`,
      ).bind(command.userId, command.shard.cohort, command.shard.epoch, command.shard.ordinal),
      env.DB_META_C000.prepare(
        "UPDATE registration_sagas SET state = 'account_committed', updated_at = ?1 WHERE operation_id = ?2",
      ).bind(new Date().toISOString(), command.operationId),
    ]);

    // Registration workflow tables currently live in the legacy META schema.
    // Admission validation keeps non-legacy cohorts disabled until their META
    // schema has these tables and directory-routed auth is deployed.
    await db.prepare('UPDATE users SET locale = ?1, reason = ?2 WHERE id = ?3')
      .bind(command.locale, command.reason, command.userId).run();
    await initializeRegistration(command.userId, command.accountId, {
      state: command.registrationState,
      invitation,
      redirectUri: command.redirectUri,
      design: command.design,
    });
    await commitRegistrationIdentities(command.operationId, command.email, command.username, {
      accountId: command.accountId,
      userId: command.userId,
      cohort: command.shard.cohort,
      metaOrdinal: command.shard.ordinal,
      metaBinding: command.shard.binding,
    });
    await env.DB_META_C000.prepare(
      "UPDATE registration_sagas SET state = 'completed', error = NULL, updated_at = ?1 WHERE operation_id = ?2",
    ).bind(new Date().toISOString(), command.operationId).run();
    await env.DB_META_C000.prepare(
      "UPDATE ops_parked_writes SET status = 'recovered', updated_at = ?1 WHERE operation_id = ?2 AND status = 'retrying'",
    ).bind(new Date().toISOString(), command.operationId).run();
    await journal.update({ operationId: command.operationId, state: 'committed' });

    try {
      const { avatarUrl, headerUrl } = await createDefaultImages(
        env.MEDIA_BUCKET,
        env.INSTANCE_DOMAIN,
        command.accountId,
        command.username,
      );
      await db.prepare(
        `UPDATE accounts SET avatar_url = ?1, avatar_static_url = ?1,
         header_url = ?2, header_static_url = ?2 WHERE id = ?3`,
      ).bind(avatarUrl, headerUrl, command.accountId).run();
    } catch (error) {
      console.error('[registration] default image post-processing failed', error);
    }
    if (command.registrationState === 'pending_approval') {
      await notifyAdminsPendingUser(command.username, command.email, command.reason).catch(() => undefined);
    }
  } catch (error) {
    if (invitation && !(await resolveShardDatabase(command.shard).prepare('SELECT id FROM accounts WHERE id = ?1')
      .bind(command.accountId).first())) {
      await restoreRegistrationInvitation(invitation.id, invitation.claim_id ?? null).catch(() => undefined);
    }
    await env.DB_META_C000.prepare(
      "UPDATE registration_sagas SET state = 'failed', error = ?1, updated_at = ?2 WHERE operation_id = ?3",
    ).bind(error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000), new Date().toISOString(), command.operationId).run();
    await journal.update({
      operationId: command.operationId,
      state: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
