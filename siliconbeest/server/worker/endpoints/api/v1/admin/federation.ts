/**
 * Admin Federation API
 *
 * GET /instances          — List all known instances (paginated, searchable)
 * GET /instances/:domain  — Single instance detail with account count
 * POST /instances/:domain/refresh     — Queue a forced refresh of known actors
 * POST /instances/:domain/diagnose    — Run side-effect-free federation checks
 * POST /instances/:domain/cache/reset — Queue a scoped cache reset
 * POST /instances/:domain/suspension  — Suspend or resume federation
 * DELETE /instances/:domain           — Delete only the instance summary record
 * GET /stats              — Federation overview statistics
 * GET /dlq                — List parked dead-letter messages
 * POST /dlq/bulk          — Replay or discard selected/all parked messages
 * POST /dlq/:id/replay    — Re-enqueue a parked message to the federation queue
 * DELETE /dlq/:id         — Discard a parked message
 *
 * All endpoints require authRequired + adminRequired. Instance actions also
 * require adminOnlyRequired, while the existing read routes remain moderator-accessible.
 */

import { env } from 'cloudflare:workers';
import { getNodeInfo } from '@fedify/fedify';
import { isActor } from '@fedify/vocab';
import { Hono, type Context } from 'hono';
import type { AppVariables } from '../../../../types';
import {
  authRequired,
  adminRequired,
  adminOnlyRequired,
} from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { redactDlqBodyForDisplay } from '../../../../utils/redactSensitive';
import { getUserAgent } from '../../../../utils/repository';
import { getFedifyContext } from '../../../../federation/helpers/send';
import { isValidProxyUrl } from '../../../proxy';
import {
  listInstances,
  getInstance,
  getRepresentativeRemoteAccount,
  setInstanceSuspension,
  deleteInstanceRecord,
  getFederationStats,
  listDlqParked,
  getDlqParked,
  markDlqParked,
  listParkedDlqForBulk,
  markDlqParkedBulk,
} from '../../../../services/admin';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();
const DIAGNOSTIC_DNS_REBINDING_ROOTS = new Set([
  'nip.io',
  'sslip.io',
  'localtest.me',
  'lvh.me',
]);

// Apply auth to all routes
app.use('*', authRequired, adminRequired);

// GET /instances — list all instances with pagination and search
app.get('/instances', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '40', 10) || 40, 200);
  const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;
  const search = c.req.query('search') ?? '';

  const results = await listInstances({
    limit,
    offset,
    search: search || undefined,
  });

  return c.json(results);
});

// POST /instances/:domain/refresh — enqueue a bounded, paginated actor refresh
app.post('/instances/:domain/refresh', adminOnlyRequired, async (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  const instance = await requireKnownInstance(domain);
  if (instance.suspended === true) {
    throw new AppError(409, 'Cannot refresh a suspended instance');
  }

  await env.QUEUE_INTERNAL.send({
    type: 'refresh_remote_instance',
    domain,
  });

  return c.json({ domain, queued: true }, 202);
});

// POST /instances/:domain/diagnose — check NodeInfo, a known actor, and its inbox
app.post('/instances/:domain/diagnose', adminOnlyRequired, async (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  await requireKnownInstance(domain);

  const representative = await getRepresentativeRemoteAccount(domain);
  const checks: FederationDiagnosticChecks = {
    nodeinfo: await diagnoseNodeInfo(domain),
    actor: { ok: false, detail: null, error: 'No known remote actor' },
    delivery: { ok: false, detail: null, error: 'No known remote inbox' },
  };

  let inboxUrl = representative?.inbox_url ?? null;
  if (representative) {
    const actorResult = await diagnoseActor(c, representative);
    checks.actor = actorResult.check;
    inboxUrl = actorResult.inboxUrl ?? inboxUrl;
  }
  if (inboxUrl) {
    checks.delivery = await diagnoseDelivery(inboxUrl);
  }

  return c.json({
    domain,
    checked_at: new Date().toISOString(),
    healthy: checks.nodeinfo.ok && checks.actor.ok && checks.delivery.ok,
    checks,
  });
});

// POST /instances/:domain/cache/reset — enqueue bounded cache invalidation
app.post('/instances/:domain/cache/reset', adminOnlyRequired, async (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  await requireKnownInstance(domain);

  await env.QUEUE_INTERNAL.send({
    type: 'reset_remote_instance_cache',
    domain,
  });

  return c.json({ domain, queued: true }, 202);
});

// POST /instances/:domain/suspension — update domain-block backed federation policy
app.post('/instances/:domain/suspension', adminOnlyRequired, async (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  await requireKnownInstance(domain);
  const input = await c.req.json<{ suspended?: unknown }>().catch(() => null);
  if (!input || typeof input.suspended !== 'boolean') {
    throw new AppError(400, 'suspended must be a boolean');
  }

  await setInstanceSuspension(domain, input.suspended);
  await env.CACHE.delete(`domblk:${domain}`);

  return c.json({ domain, suspended: input.suspended });
});

// DELETE /instances/:domain — delete the summary only; actors/policy remain
app.delete('/instances/:domain', adminOnlyRequired, async (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  await requireKnownInstance(domain);
  await deleteInstanceRecord(domain);
  return c.json({ domain, deleted: true });
});

// GET /instances/:domain — single instance detail
app.get('/instances/:domain', async (c) => {
  const domain = normalizeDomain(c.req.param('domain'));

  const instance = await getInstance(domain);

  if (!instance) {
    return c.json({ error: 'Instance not found' }, 404);
  }

  return c.json(instance);
});

// GET /stats — federation overview
app.get('/stats', async (c) => {
  const stats = await getFederationStats();
  return c.json(stats);
});

// GET /dlq — list parked dead-letter messages (status: parked | replayed | discarded)
app.get('/dlq', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '40', 10) || 40, 200);
  const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;
  const status = c.req.query('status') ?? 'parked';

  const { items, counts } = await listDlqParked({ status, limit, offset });

  return c.json({
    counts,
    items: items.map((row) => ({
      ...row,
      body: redactDlqBodyForDisplay(row.body),
    })),
  });
});

// POST /dlq/bulk — replay or discard selected/all parked messages
app.post('/dlq/bulk', async (c) => {
  const input = await c.req.json<{
    action?: unknown;
    ids?: unknown;
    all?: unknown;
  }>().catch(() => null);
  if (!input || (input.action !== 'replay' && input.action !== 'discard')) {
    throw new AppError(400, 'action must be replay or discard');
  }

  const processAll = input.all === true;
  const ids = Array.isArray(input.ids)
    ? [...new Set(input.ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];
  if (!processAll && ids.length === 0) {
    throw new AppError(400, 'ids must contain at least one message');
  }
  if (processAll && ids.length > 0) {
    throw new AppError(400, 'ids and all cannot be used together');
  }
  const action = input.action;
  const batchSize = 100;
  let processed = 0;
  let selectedOffset = 0;

  do {
    const selectedBatch = processAll
      ? undefined
      : ids.slice(selectedOffset, selectedOffset + batchSize);
    if (selectedBatch && selectedBatch.length === 0) break;
    const rows = await listParkedDlqForBulk({
      ...(selectedBatch ? { ids: selectedBatch } : {}),
      limit: batchSize,
    });
    if (rows.length === 0 && processAll) break;

    if (action === 'replay' && rows.length > 0) {
      await env.QUEUE_FEDERATION.sendBatch(rows.map((row) => {
        let body: unknown = row.body;
        try {
          body = JSON.parse(row.body);
        } catch {
          // Keep the raw body when a parked message is not valid JSON.
        }
        return { body };
      }));
    }
    await markDlqParkedBulk(
      rows.map((row) => row.id),
      action === 'replay' ? 'replayed' : 'discarded',
    );
    processed += rows.length;

    if (!processAll) selectedOffset += batchSize;
  } while (processAll || selectedOffset < ids.length);

  return c.json({ action, processed });
});

// POST /dlq/:id/replay — re-enqueue a parked message to the federation queue
app.post('/dlq/:id/replay', async (c) => {
  const row = await getDlqParked(c.req.param('id'));
  if (row.status !== 'parked') {
    throw new AppError(409, `Message already ${row.status}`);
  }

  await env.QUEUE_FEDERATION.send(JSON.parse(row.body));
  await markDlqParked(row.id, 'replayed');

  return c.json({ id: row.id, status: 'replayed' });
});

// DELETE /dlq/:id — discard a parked message
app.delete('/dlq/:id', async (c) => {
  const row = await getDlqParked(c.req.param('id'));
  if (row.status !== 'parked') {
    throw new AppError(409, `Message already ${row.status}`);
  }

  await markDlqParked(row.id, 'discarded');

  return c.json({ id: row.id, status: 'discarded' });
});

type FederationDiagnosticCheck = {
  ok: boolean;
  detail: string | null;
  error: string | null;
};

type FederationDiagnosticChecks = {
  nodeinfo: FederationDiagnosticCheck;
  actor: FederationDiagnosticCheck;
  delivery: FederationDiagnosticCheck;
};

type RepresentativeRemoteAccount = NonNullable<
  Awaited<ReturnType<typeof getRepresentativeRemoteAccount>>
>;

function normalizeDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  if (!normalized) throw new AppError(400, 'domain is required');
  return normalized;
}

async function requireKnownInstance(domain: string): Promise<Record<string, unknown>> {
  const instance = await getInstance(domain);
  if (!instance) throw new AppError(404, 'Instance not found');
  return instance;
}

async function diagnoseNodeInfo(domain: string): Promise<FederationDiagnosticCheck> {
  const instanceUrl = new URL(`https://${domain}/`);
  if (!isSafeDiagnosticHttpsUrl(instanceUrl)) {
    return {
      ok: false,
      detail: safeUrl(instanceUrl.href),
      error: 'Remote instance is not a safe HTTPS target',
    };
  }
  try {
    const nodeInfo = await getNodeInfo(instanceUrl, {
      parse: 'none',
      userAgent: getUserAgent('Federation diagnostics'),
    });
    const software = asRecord(asRecord(nodeInfo)?.software);
    const name = asString(software?.name);
    const version = asString(software?.version);
    if (!name) {
      return {
        ok: false,
        detail: null,
        error: 'NodeInfo software metadata is unavailable',
      };
    }
    return {
      ok: true,
      detail: version ? `${safeText(name)} ${safeText(version)}` : safeText(name),
      error: null,
    };
  } catch (error) {
    return { ok: false, detail: null, error: diagnosticError(error) };
  }
}

async function diagnoseActor(
  c: Context<HonoEnv>,
  representative: RepresentativeRemoteAccount,
): Promise<{ check: FederationDiagnosticCheck; inboxUrl: string | null }> {
  let representativeUrl: URL;
  try {
    representativeUrl = new URL(representative.uri);
  } catch {
    return {
      check: { ok: false, detail: null, error: 'Remote actor URL is invalid' },
      inboxUrl: null,
    };
  }
  if (!isSafeDiagnosticHttpsUrl(representativeUrl)) {
    return {
      check: {
        ok: false,
        detail: safeUrl(representativeUrl.href),
        error: 'Remote actor is not a safe HTTPS target',
      },
      inboxUrl: null,
    };
  }

  try {
    const currentAccount = c.get('currentAccount');
    if (!currentAccount) {
      return {
        check: { ok: false, detail: null, error: 'No local diagnostic signer' },
        inboxUrl: null,
      };
    }

    const ctx = getFedifyContext(c.get('federation'));
    const documentLoader = await ctx.getDocumentLoader({
      identifier: currentAccount.username,
    });
    const actor = await ctx.lookupObject(representative.uri, { documentLoader });
    if (!actor || !isActor(actor)) {
      return {
        check: { ok: false, detail: null, error: 'Remote object is not an actor' },
        inboxUrl: null,
      };
    }

    const actorJson = asRecord(await actor.toJsonLd());
    const publicKey = firstRecord(actorJson?.publicKey);
    const actorUri = asString(actorJson?.id) ?? actor.id?.href ?? representative.uri;
    const keyId = asString(publicKey?.id);
    const publicKeyPem = asString(publicKey?.publicKeyPem);
    const inboxUrl = asString(actorJson?.inbox) ?? actor.inboxId?.href ?? null;
    const keyMatches = publicKeyPem && representative.public_key_pem
      ? publicKeyPem === representative.public_key_pem
      : null;
    const inboxMatches = inboxUrl && representative.inbox_url
      ? inboxUrl === representative.inbox_url
      : null;
    const ok = !!keyId && !!publicKeyPem && !!inboxUrl;
    const comparison = [
      keyMatches === null ? null : `stored key ${keyMatches ? 'matches' : 'differs'}`,
      inboxMatches === null ? null : `stored inbox ${inboxMatches ? 'matches' : 'differs'}`,
    ].filter((value): value is string => value !== null).join(', ');

    return {
      check: {
        ok,
        detail: [
          `actor ${safeUrl(actorUri)}`,
          keyId ? `keyId ${safeUrl(keyId)}` : 'keyId missing',
          comparison || null,
        ].filter((value): value is string => value !== null).join(' · '),
        error: ok ? null : 'Actor is missing a public key or inbox',
      },
      inboxUrl,
    };
  } catch (error) {
    return {
      check: { ok: false, detail: null, error: diagnosticError(error) },
      inboxUrl: null,
    };
  }
}

async function diagnoseDelivery(rawInboxUrl: string): Promise<FederationDiagnosticCheck> {
  let inboxUrl: URL;
  try {
    inboxUrl = new URL(rawInboxUrl);
  } catch {
    return { ok: false, detail: null, error: 'Remote inbox URL is invalid' };
  }

  if (!isSafeDiagnosticHttpsUrl(inboxUrl)) {
    return {
      ok: false,
      detail: safeUrl(inboxUrl.href),
      error: 'Remote inbox is not a safe HTTPS target',
    };
  }

  try {
    const response = await fetch(inboxUrl, {
      method: 'HEAD',
      redirect: 'manual',
      headers: {
        Accept: 'application/activity+json, application/ld+json',
        'User-Agent': getUserAgent('Federation diagnostics'),
      },
      signal: AbortSignal.timeout(8_000),
    });
    const ok = response.status < 500
      && response.status !== 404
      && response.status !== 410;
    return {
      ok,
      detail: `HEAD ${response.status} ${safeUrl(inboxUrl.href)}`,
      error: ok ? null : `Inbox returned HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `HEAD ${safeUrl(inboxUrl.href)}`,
      error: diagnosticError(error),
    };
  }
}

function isSafeDiagnosticHttpsUrl(url: URL): boolean {
  return url.protocol === 'https:'
    && url.username === ''
    && url.password === ''
    && !DIAGNOSTIC_DNS_REBINDING_ROOTS.has(url.hostname.toLowerCase())
    && isValidProxyUrl(url.href);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return asRecord(value[0]);
  return asRecord(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    return safeText(url.href);
  } catch {
    return safeText(rawUrl);
  }
}

function safeText(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
}

function diagnosticError(error: unknown): string {
  if (!(error instanceof Error)) return 'Diagnostic request failed';
  const name = safeText(error.name) || 'Error';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return `${name}: Remote diagnostic request timed out`;
  }
  return `${name}: Remote diagnostic request failed`;
}

export default app;
