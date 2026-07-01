import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';
import { processAnnounce } from '../../server/worker/federation/inboxProcessors/announce';

const BASE = 'https://test.siliconbeest.local';

describe('Quote Posts (FEP-e232)', () => {
  let user: { accountId: string; userId: string; token: string };
  let quotableStatusId: string;

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('quoteuser');

    // Create a status to be quoted
    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ status: 'This is a quotable post', visibility: 'public' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();
    quotableStatusId = body.id;
  });

  it('creates a status with quote_id and response includes quote object', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({
        status: 'Quoting this post',
        quote_id: quotableStatusId,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();

    expect(body.quote).toBeDefined();
    expect(body.quote).not.toBeNull();
    expect(body.quote.id).toBe(quotableStatusId);
    expect(body.quote.content).toContain('quotable post');
    expect(body.content).toContain(`${BASE}/@quoteuser/${quotableStatusId}`);
    expect(body.content).not.toContain(`${BASE}/users/quoteuser/statuses/${quotableStatusId}`);
  });

  it('quote object includes the quoted status account', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({
        status: 'Another quote',
        quote_id: quotableStatusId,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();

    expect(body.quote.account).toBeDefined();
    expect(body.quote.account.username).toBe('quoteuser');
  });

  it('invalid quote_id is ignored gracefully', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({
        status: 'Trying to quote nonexistent',
        quote_id: 'NONEXISTENT_ID_12345',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();

    // Status should be created successfully but with no quote
    expect(body.id).toBeDefined();
    expect(body.quote).toBeNull();
  });

  it('uses public quote policy by default', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ status: 'Default quote policy', visibility: 'public' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();
    expect(body.quote_policy).toBe('public');
    expect(body.quote_policy_allows).toBe(true);
  });

  it('advertises canQuote automatic approval without unsupported manual approval', async () => {
    const createRes = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ status: 'AP quote policy', visibility: 'public' }),
    });
    expect(createRes.status).toBe(200);
    const status = await createRes.json<Record<string, any>>();

    const apRes = await SELF.fetch(`${BASE}/users/quoteuser/statuses/${status.id}`, {
      headers: { Accept: 'application/activity+json, application/ld+json' },
    });
    expect(apRes.status).toBe(200);
    const ap = await apRes.json<Record<string, any>>();
    const canQuote = ap.interactionPolicy?.canQuote;
    expect(canQuote).toBeDefined();
    const automaticApproval = canQuote.automaticApproval ?? canQuote.automaticApprovals;
    const approvals = Array.isArray(automaticApproval) ? automaticApproval : [automaticApproval];
    expect(approvals).toEqual(expect.arrayContaining(['as:Public']));
    expect(canQuote.manualApproval).toBeUndefined();
    expect(canQuote.manualApprovals).toBeUndefined();
    expect(ap.replies).toMatchObject({
      id: `${BASE}/users/quoteuser/statuses/${status.id}/replies`,
      type: 'Collection',
      totalItems: 0,
    });
    expect(ap.shares).toMatchObject({
      id: `${BASE}/users/quoteuser/statuses/${status.id}/shares`,
      type: 'Collection',
      totalItems: 0,
    });
    expect(ap.likes).toMatchObject({
      id: `${BASE}/users/quoteuser/statuses/${status.id}/likes`,
      type: 'Collection',
      totalItems: 0,
    });
  });

  it('stores the user default quote policy and applies it to new posts', async () => {
    const form = new FormData();
    form.append('source[quote_policy]', 'followers');
    const updateRes = await SELF.fetch(`${BASE}/api/v1/accounts/update_credentials`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user.token}` },
      body: form,
    });
    expect(updateRes.status).toBe(200);
    const account = await updateRes.json<Record<string, any>>();
    expect(account.source.quote_policy).toBe('followers');

    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ status: 'Default followers policy', visibility: 'public' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();
    expect(body.quote_policy).toBe('followers');
  });

  it('allows per-post quote policy override', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({
        status: 'No quotes for this one',
        visibility: 'public',
        quote_policy: 'nobody',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();
    expect(body.quote_policy).toBe('nobody');
  });

  it('returns quote button state from stored quote policy', async () => {
    const remoteAccountId = 'remote_quote_policy_actor';
    const remoteStatusId = 'remote_quote_policy_status';
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO accounts
        (id, username, domain, display_name, note, uri, url, avatar_url, avatar_static_url,
         header_url, header_static_url, locked, bot, discoverable, manually_approves_followers,
         statuses_count, followers_count, following_count, created_at, updated_at)
       VALUES (?1, 'remotequote', 'remote.example', '', '', 'https://remote.example/users/remotequote',
         'https://remote.example/@remotequote', '', '', '', '', 0, 0, 1, 0, 1, 0, 0, ?2, ?2)`,
    ).bind(remoteAccountId, now).run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO statuses
        (id, uri, url, account_id, text, content, content_warning, visibility, sensitive,
         language, conversation_id, reply, local, quote_policy, created_at, updated_at)
       VALUES (?1, 'https://remote.example/objects/quote-policy', 'https://remote.example/@remotequote/quote-policy',
         ?2, 'remote', '<p>remote</p>', '', 'public', 0, 'en', ?1, 0, 0, 'nobody', ?3, ?3)`,
    ).bind(remoteStatusId, remoteAccountId, now).run();

    const res = await SELF.fetch(`${BASE}/api/v1/statuses/${remoteStatusId}`, {
      headers: authHeaders(user.token),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();
    expect(body.quote_policy).toBe('nobody');
    expect(body.quote_policy_allows).toBe(false);
    expect(body.quote_policy_reason).toBe('policy_nobody');
  });

  it('stores FEP-dd4b Announce with content as a quote post', async () => {
    const remoteAccountId = 'remote_dd4b_quote_actor';
    const remoteActorUri = 'https://dd4b.example/users/quoteactor';
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO accounts
        (id, username, domain, display_name, note, uri, url, avatar_url, avatar_static_url,
         header_url, header_static_url, locked, bot, discoverable, manually_approves_followers,
         statuses_count, followers_count, following_count, created_at, updated_at)
       VALUES (?1, 'quoteactor', 'dd4b.example', '', '', ?2,
         'https://dd4b.example/@quoteactor', '', '', '', '', 0, 0, 1, 0, 1, 0, 0, ?3, ?3)`,
    ).bind(remoteAccountId, remoteActorUri, now).run();

    const original = await env.DB.prepare(
      'SELECT uri FROM statuses WHERE id = ?1',
    ).bind(quotableStatusId).first<{ uri: string }>();
    expect(original?.uri).toBeTruthy();

    await processAnnounce({
      type: 'Announce',
      id: 'https://dd4b.example/activities/quote-1',
      actor: remoteActorUri,
      object: original!.uri,
      content: '<p>FEP-dd4b commentary</p>',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    }, user.accountId);

    const stored = await env.DB.prepare(
      `SELECT quote_id, reblog_of_id, content
       FROM statuses
       WHERE uri = 'https://dd4b.example/activities/quote-1'
       LIMIT 1`,
    ).first<{ quote_id: string | null; reblog_of_id: string | null; content: string }>();

    expect(stored?.quote_id).toBe(quotableStatusId);
    expect(stored?.reblog_of_id).toBeNull();
    expect(stored?.content).toContain('FEP-dd4b commentary');
  });
});
