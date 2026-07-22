import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
type StatusPayload = {
  id: string;
  in_reply_to_id: string | null;
  visibility: string;
  quote: { id: string; content: string } | null;
};

async function postStatus(
  user: TestUser,
  body: Record<string, string>,
): Promise<{ response: Response; status: StatusPayload }> {
  const response = await SELF.fetch(`${BASE}/api/v1/statuses`, {
    method: 'POST',
    headers: authHeaders(user.token),
    body: JSON.stringify(body),
  });
  return { response, status: await response.clone().json<StatusPayload>() };
}

describe('quote and reply target permissions', () => {
  let author: TestUser;
  let stranger: TestUser;
  let privateStatus: StatusPayload;

  beforeAll(async () => {
    await applyMigration();
    author = await createTestUser('quotetargetauthor');
    stranger = await createTestUser('quotetargetstranger');
    const created = await postStatus(author, {
      status: 'private quote target body',
      visibility: 'private',
    });
    expect(created.response.status).toBe(200);
    privateStatus = created.status;
  });

  it('rejects hidden quote and reply targets without creating a status', async () => {
    const quoteAttempt = await postStatus(stranger, {
      status: 'must not attach a hidden quote',
      visibility: 'public',
      quote_id: privateStatus.id,
    });
    expect(quoteAttempt.response.status).toBe(404);

    const replyAttempt = await postStatus(stranger, {
      status: 'must not attach a hidden reply target',
      visibility: 'public',
      in_reply_to_id: privateStatus.id,
    });
    expect(replyAttempt.response.status).toBe(404);

    const stored = await env.DB_META_C000.prepare(
      `SELECT COUNT(*) AS count FROM statuses
       WHERE account_id = ?1
         AND text IN (?2, ?3)`,
    ).bind(
      stranger.accountId,
      'must not attach a hidden quote',
      'must not attach a hidden reply target',
    ).first<{ count: number }>();
    expect(stored?.count).toBe(0);
  });

  it('filters a hidden quote from enrichment while preserving author access', async () => {
    const wrapper = await postStatus(stranger, {
      status: 'public wrapper',
      visibility: 'public',
    });
    expect(wrapper.response.status).toBe(200);

    await env.DB_META_C000.prepare(
      `UPDATE statuses
       SET quote_id = ?1, quote_approval_status = 'accepted'
       WHERE id = ?2`,
    ).bind(privateStatus.id, wrapper.status.id).run();

    const strangerResponse = await SELF.fetch(`${BASE}/api/v1/statuses/${wrapper.status.id}`, {
      headers: authHeaders(stranger.token),
    });
    expect(strangerResponse.status).toBe(200);
    const strangerView = await strangerResponse.json<StatusPayload>();
    expect(strangerView.quote).toBeNull();

    const authorResponse = await SELF.fetch(`${BASE}/api/v1/statuses/${wrapper.status.id}`, {
      headers: authHeaders(author.token),
    });
    expect(authorResponse.status).toBe(200);
    const authorView = await authorResponse.json<StatusPayload>();
    expect(authorView.quote?.id).toBe(privateStatus.id);
    expect(authorView.quote?.content).toContain('private quote target body');
  });

  it('clamps a self-quote of a private target and keeps it off public surfaces', async () => {
    const wrapper = await postStatus(author, {
      status: 'attempted public self quote of a private target',
      visibility: 'public',
      quote_id: privateStatus.id,
    });
    expect(wrapper.response.status).toBe(200);
    expect(wrapper.status.visibility).toBe('private');
    expect(wrapper.status.quote?.id).toBe(privateStatus.id);

    const stored = await env.DB_META_C000.prepare(
      `SELECT visibility, quote_id, quote_approval_status
       FROM statuses
       WHERE id = ?1`,
    ).bind(wrapper.status.id).first<{
      visibility: string;
      quote_id: string | null;
      quote_approval_status: string | null;
    }>();
    expect(stored).toMatchObject({
      visibility: 'private',
      quote_id: privateStatus.id,
      quote_approval_status: 'accepted',
    });

    const anonymous = await SELF.fetch(`${BASE}/api/v1/statuses/${wrapper.status.id}`);
    expect(anonymous.status).toBe(404);

    const publicTimeline = await SELF.fetch(`${BASE}/api/v1/timelines/public`);
    expect(publicTimeline.status).toBe(200);
    const publicStatuses = await publicTimeline.json<StatusPayload[]>();
    expect(publicStatuses.some((status) => status.id === wrapper.status.id)).toBe(false);

    const activityPub = await SELF.fetch(
      `${BASE}/users/quotetargetauthor/statuses/${wrapper.status.id}`,
      { headers: { Accept: 'application/activity+json, application/ld+json' } },
    );
    expect(activityPub.status).toBe(404);
  });

  it('embeds a quote only while its authorization is accepted', async () => {
    const target = await postStatus(author, {
      status: 'quote approval target',
      visibility: 'public',
    });
    const wrapper = await postStatus(author, {
      status: 'quote approval wrapper',
      visibility: 'public',
    });

    const setApproval = async (approval: string): Promise<void> => {
      await env.DB_META_C000.prepare(
        `UPDATE statuses
         SET quote_id = ?1, quote_approval_status = ?2
         WHERE id = ?3`,
      ).bind(target.status.id, approval, wrapper.status.id).run();
    };
    const fetchApiQuote = async (): Promise<StatusPayload['quote']> => {
      const response = await SELF.fetch(`${BASE}/api/v1/statuses/${wrapper.status.id}`, {
        headers: authHeaders(author.token),
      });
      expect(response.status).toBe(200);
      return (await response.json<StatusPayload>()).quote;
    };
    const fetchActivityPub = async (): Promise<Record<string, unknown>> => {
      const response = await SELF.fetch(
        `${BASE}/users/quotetargetauthor/statuses/${wrapper.status.id}`,
        { headers: { Accept: 'application/activity+json, application/ld+json' } },
      );
      expect(response.status).toBe(200);
      return response.json<Record<string, unknown>>();
    };

    await setApproval('pending');
    expect(await fetchApiQuote()).toBeNull();
    const pendingActivityPub = await fetchActivityPub();
    expect(pendingActivityPub.quote).toBeUndefined();
    expect(pendingActivityPub.quoteUrl).toBeUndefined();

    await setApproval('accepted');
    expect((await fetchApiQuote())?.id).toBe(target.status.id);
    const acceptedActivityPub = await fetchActivityPub();
    expect(acceptedActivityPub.quote ?? acceptedActivityPub.quoteUrl).toBeDefined();

    await setApproval('rejected');
    expect(await fetchApiQuote()).toBeNull();
    const rejectedActivityPub = await fetchActivityPub();
    expect(rejectedActivityPub.quote).toBeUndefined();
    expect(rejectedActivityPub.quoteUrl).toBeUndefined();
  });

  it('enforces public, followers, and nobody quote policies before attaching a quote', async () => {
    const publicTarget = await postStatus(author, {
      status: 'public quote policy target',
      visibility: 'public',
      quote_policy: 'public',
    });
    const publicQuote = await postStatus(stranger, {
      status: 'public policy quote',
      visibility: 'public',
      quote_id: publicTarget.status.id,
    });
    expect(publicQuote.status.quote?.id).toBe(publicTarget.status.id);

    const followersTarget = await postStatus(author, {
      status: 'followers quote policy target',
      visibility: 'public',
      quote_policy: 'followers',
    });
    const deniedBeforeFollow = await postStatus(stranger, {
      status: 'followers policy denied quote',
      visibility: 'public',
      quote_id: followersTarget.status.id,
    });
    expect(deniedBeforeFollow.response.status).toBe(422);

    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      `INSERT OR IGNORE INTO follows
       (id, account_id, target_account_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
    ).bind(
      `quote_policy_follow_${crypto.randomUUID()}`,
      stranger.accountId,
      author.accountId,
      now,
    ).run();
    const allowedAfterFollow = await postStatus(stranger, {
      status: 'followers policy allowed quote',
      visibility: 'public',
      quote_id: followersTarget.status.id,
    });
    expect(allowedAfterFollow.status.quote?.id).toBe(followersTarget.status.id);

    const nobodyTarget = await postStatus(author, {
      status: 'nobody quote policy target',
      visibility: 'public',
      quote_policy: 'nobody',
    });
    const deniedNobody = await postStatus(stranger, {
      status: 'nobody policy denied quote',
      visibility: 'public',
      quote_id: nobodyTarget.status.id,
    });
    expect(deniedNobody.response.status).toBe(422);

    const selfQuote = await postStatus(author, {
      status: 'author self quote',
      visibility: 'public',
      quote_id: nobodyTarget.status.id,
    });
    expect(selfQuote.status.quote?.id).toBe(nobodyTarget.status.id);

    const identities = await env.DB_META_C000.prepare(
      `SELECT author.uri AS author_uri, requester.uri AS requester_uri
       FROM accounts author, accounts requester
       WHERE author.id = ?1 AND requester.id = ?2`,
    ).bind(author.accountId, stranger.accountId).first<{
      author_uri: string;
      requester_uri: string;
    }>();
    expect(identities).not.toBeNull();
    if (!identities) throw new Error('Missing quote policy account identities');

    const explicitTarget = await postStatus(author, {
      status: 'explicit actor quote policy target',
      visibility: 'public',
      quote_policy: 'nobody',
    });
    await env.DB_META_C000.prepare(
      `UPDATE statuses
       SET quote_policy_automatic_approvals = ?1,
           quote_policy_manual_approvals = ?2
       WHERE id = ?3`,
    ).bind(
      JSON.stringify([]),
      JSON.stringify([identities.requester_uri]),
      explicitTarget.status.id,
    ).run();
    const explicitQuote = await postStatus(stranger, {
      status: 'explicit actor policy quote',
      visibility: 'public',
      quote_id: explicitTarget.status.id,
    });
    expect(explicitQuote.status.quote?.id).toBe(explicitTarget.status.id);

    const followingTarget = await postStatus(author, {
      status: 'following collection quote policy target',
      visibility: 'public',
      quote_policy: 'nobody',
    });
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `UPDATE statuses
         SET quote_policy_automatic_approvals = ?1,
             quote_policy_manual_approvals = ?2
         WHERE id = ?3`,
      ).bind(
        JSON.stringify([`${identities.author_uri}/following`]),
        JSON.stringify([]),
        followingTarget.status.id,
      ),
      env.DB_META_C000.prepare(
        `INSERT OR IGNORE INTO follows
         (id, account_id, target_account_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)`,
      ).bind(
        `quote_policy_following_${crypto.randomUUID()}`,
        author.accountId,
        stranger.accountId,
        now,
      ),
    ]);
    const followingQuote = await postStatus(stranger, {
      status: 'following collection policy quote',
      visibility: 'public',
      quote_id: followingTarget.status.id,
    });
    expect(followingQuote.status.quote?.id).toBe(followingTarget.status.id);
  });

  it('does not surface a muted or blocked quote target through a visible wrapper', async () => {
    const publicTarget = await postStatus(author, {
      status: 'public relationship quote target',
      visibility: 'public',
    });
    const wrapper = await postStatus(stranger, {
      status: 'public relationship quote wrapper',
      visibility: 'public',
    });
    expect(publicTarget.response.status).toBe(200);
    expect(wrapper.response.status).toBe(200);
    await env.DB_META_C000.prepare(
      `UPDATE statuses
       SET quote_id = ?1, quote_approval_status = 'accepted'
       WHERE id = ?2`,
    ).bind(publicTarget.status.id, wrapper.status.id).run();

    const mute = await SELF.fetch(`${BASE}/api/v1/accounts/${author.accountId}/mute`, {
      method: 'POST',
      headers: authHeaders(stranger.token),
    });
    expect(mute.status).toBe(200);
    const muted = await SELF.fetch(`${BASE}/api/v1/statuses/${wrapper.status.id}`, {
      headers: authHeaders(stranger.token),
    });
    expect((await muted.json<StatusPayload>()).quote).toBeNull();

    const directTarget = await SELF.fetch(`${BASE}/api/v1/statuses/${publicTarget.status.id}`, {
      headers: authHeaders(stranger.token),
    });
    expect(directTarget.status).toBe(200);

    const unmute = await SELF.fetch(`${BASE}/api/v1/accounts/${author.accountId}/unmute`, {
      method: 'POST',
      headers: authHeaders(stranger.token),
    });
    expect(unmute.status).toBe(200);
    const visible = await SELF.fetch(`${BASE}/api/v1/statuses/${wrapper.status.id}`, {
      headers: authHeaders(stranger.token),
    });
    expect((await visible.json<StatusPayload>()).quote?.id).toBe(publicTarget.status.id);

    const reverseBlock = await SELF.fetch(`${BASE}/api/v1/accounts/${stranger.accountId}/block`, {
      method: 'POST',
      headers: authHeaders(author.token),
    });
    expect(reverseBlock.status).toBe(200);
    const blocked = await SELF.fetch(`${BASE}/api/v1/statuses/${wrapper.status.id}`, {
      headers: authHeaders(stranger.token),
    });
    expect((await blocked.json<StatusPayload>()).quote).toBeNull();
  });
});
