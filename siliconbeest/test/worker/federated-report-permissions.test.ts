import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { processFlag } from '../../server/worker/federation/inboxProcessors/flag';
import type { APActivity } from '../../server/worker/types/activitypub';
import { applyMigration, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

interface ActorFixture {
  id: string;
  uri: string;
}

interface StatusFixture {
  id: string;
  uri: string;
}

async function insertRemoteActor(
  id: string,
  username: string,
  suspended = false,
): Promise<ActorFixture> {
  const now = new Date().toISOString();
  const uri = `https://reports.remote.example/users/${username}`;
  await env.DB_META_C000.prepare(
    `INSERT INTO accounts
       (id, username, domain, display_name, note, uri, url,
        suspended_at, created_at, updated_at)
     VALUES (?1, ?2, 'reports.remote.example', ?2, '', ?3, ?3, ?4, ?5, ?5)`,
  ).bind(id, username, uri, suspended ? now : null, now).run();
  return { id, uri };
}

async function insertStatus(
  id: string,
  accountId: string,
  visibility: 'public' | 'private',
): Promise<StatusFixture> {
  const now = new Date().toISOString();
  const uri = `${BASE}/objects/${id}`;
  await env.DB_META_C000.prepare(
    `INSERT INTO statuses
       (id, uri, url, account_id, text, content, visibility, local,
        created_at, updated_at)
     VALUES (?1, ?2, ?2, ?3, ?1, ?1, ?4, 1, ?5, ?5)`,
  ).bind(id, uri, accountId, visibility, now).run();
  return { id, uri };
}

function flagActivity(
  actorUri: string,
  targetUri: string,
  comment: string,
  statusUris: readonly string[] = [],
): APActivity {
  return {
    type: 'Flag',
    actor: actorUri,
    object: [targetUri, ...statusUris],
    content: comment,
  };
}

async function reportCount(comment: string): Promise<number> {
  const row = await env.DB_META_C000.prepare(
    'SELECT COUNT(*) AS count FROM reports WHERE comment = ?1',
  ).bind(comment).first<{ count: number }>();
  return row?.count ?? 0;
}

describe('federated report permissions', () => {
  let target: Awaited<ReturnType<typeof createTestUser>>;
  let otherLocal: Awaited<ReturnType<typeof createTestUser>>;
  let suspendedTarget: Awaited<ReturnType<typeof createTestUser>>;
  let reporter: ActorFixture;
  let suspendedReporter: ActorFixture;
  let remoteTarget: ActorFixture;
  let publicStatus: StatusFixture;
  let privateStatus: StatusFixture;
  let otherStatus: StatusFixture;

  beforeAll(async () => {
    await applyMigration();
    target = await createTestUser('reporttarget');
    otherLocal = await createTestUser('reportother');
    suspendedTarget = await createTestUser('reportsuspendedtarget');
    reporter = await insertRemoteActor('report_remote_actor', 'reporter');
    suspendedReporter = await insertRemoteActor(
      'report_suspended_actor',
      'suspended_reporter',
      true,
    );
    remoteTarget = await insertRemoteActor('report_remote_target', 'remote_target');
    publicStatus = await insertStatus('report_public_status', target.accountId, 'public');
    privateStatus = await insertStatus('report_private_status', target.accountId, 'private');
    otherStatus = await insertStatus('report_other_status', otherLocal.accountId, 'public');
    await env.DB_META_C000.prepare('UPDATE accounts SET suspended_at = ?1 WHERE id = ?2')
      .bind(new Date().toISOString(), suspendedTarget.accountId).run();
  });

  it('accepts an active remote reporter through the exact personal or shared inbox', async () => {
    const personalComment = 'allowed personal federated report';
    expect(await processFlag(
      flagActivity(
        reporter.uri,
        `${BASE}/users/reporttarget`,
        personalComment,
        [publicStatus.uri],
      ),
      target.accountId,
    )).toBe(true);

    const stored = await env.DB_META_C000.prepare(
      `SELECT target_account_id, status_ids
       FROM reports WHERE comment = ?1 LIMIT 1`,
    ).bind(personalComment).first<{
      target_account_id: string;
      status_ids: string | null;
    }>();
    expect(stored).toEqual({
      target_account_id: target.accountId,
      status_ids: JSON.stringify([publicStatus.id]),
    });

    const sharedComment = 'allowed shared federated report';
    expect(await processFlag(
      flagActivity(reporter.uri, `${BASE}/users/reporttarget`, sharedComment),
      '',
    )).toBe(true);
    expect(await reportCount(sharedComment)).toBe(1);
  });

  it('accepts only status references that the reporter can view', async () => {
    const deniedComment = 'private report before follow';
    expect(await processFlag(
      flagActivity(
        reporter.uri,
        `${BASE}/users/reporttarget`,
        deniedComment,
        [privateStatus.uri],
      ),
      target.accountId,
    )).toBe(false);
    expect(await reportCount(deniedComment)).toBe(0);

    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      `INSERT INTO follows
         (id, account_id, target_account_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
    ).bind('report_visibility_follow', reporter.id, target.accountId, now).run();

    const allowedComment = 'private report after follow';
    expect(await processFlag(
      flagActivity(
        reporter.uri,
        `${BASE}/users/reporttarget`,
        allowedComment,
        [privateStatus.uri],
      ),
      target.accountId,
    )).toBe(true);
    expect(await reportCount(allowedComment)).toBe(1);
  });

  it.each([
    {
      name: 'the personal inbox belongs to another account',
      activity: () => flagActivity(
        reporter.uri,
        `${BASE}/users/reporttarget`,
        'denied wrong report inbox',
      ),
      recipient: () => otherLocal.accountId,
      comment: 'denied wrong report inbox',
    },
    {
      name: 'the reporter is suspended',
      activity: () => flagActivity(
        suspendedReporter.uri,
        `${BASE}/users/reporttarget`,
        'denied suspended reporter',
      ),
      recipient: () => target.accountId,
      comment: 'denied suspended reporter',
    },
    {
      name: 'the reporter is a local account',
      activity: () => flagActivity(
        `${BASE}/users/reportother`,
        `${BASE}/users/reporttarget`,
        'denied local reporter',
      ),
      recipient: () => target.accountId,
      comment: 'denied local reporter',
    },
    {
      name: 'the target is remote',
      activity: () => flagActivity(
        reporter.uri,
        remoteTarget.uri,
        'denied remote report target',
      ),
      recipient: () => '',
      comment: 'denied remote report target',
    },
    {
      name: 'the local target is suspended',
      activity: () => flagActivity(
        reporter.uri,
        `${BASE}/users/reportsuspendedtarget`,
        'denied suspended report target',
      ),
      recipient: () => suspendedTarget.accountId,
      comment: 'denied suspended report target',
    },
  ])('rejects the Flag before storage when $name', async ({ activity, recipient, comment }) => {
    expect(await processFlag(activity(), recipient())).toBe(false);
    expect(await reportCount(comment)).toBe(0);
  });

  it.each([
    ['another account owns the status', () => otherStatus.uri],
    ['the status URI does not resolve', () => `${BASE}/objects/missing-report-status`],
  ])('rejects every status reference when %s', async (label, statusUri) => {
    const comment = `denied report status: ${label}`;
    expect(await processFlag(
      flagActivity(
        reporter.uri,
        `${BASE}/users/reporttarget`,
        comment,
        [publicStatus.uri, statusUri()],
      ),
      target.accountId,
    )).toBe(false);
    expect(await reportCount(comment)).toBe(0);
  });
});
