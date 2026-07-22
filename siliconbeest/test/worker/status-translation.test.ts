import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { cacheWorkersAiFeatureFlags } from '../../server/worker/services/workersAiFeatures';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Status translation API with Workers AI disabled', () => {
  let token: string;
  let limitedToken: string;
  let publicStatusId: string;
  let privateStatusId: string;
  let hiddenPrivateStatusId: string;
  let hiddenDirectStatusId: string;

  beforeAll(async () => {
    await applyMigration();
    const user = await createTestUser('translationowner');
    const limited = await createTestUser('translationlimited', { scopes: 'read:accounts' });
    const hiddenAuthor = await createTestUser('translationhidden');
    token = user.token;
    limitedToken = limited.token;

    const publicResponse = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        status: '안녕하세요 & welcome',
        language: 'ko',
        visibility: 'public',
      }),
    });
    const publicStatus = await publicResponse.json<{ id: string }>();
    publicStatusId = publicStatus.id;

    const privateResponse = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        status: 'Private text',
        language: 'en',
        visibility: 'private',
      }),
    });
    const privateStatus = await privateResponse.json<{ id: string }>();
    privateStatusId = privateStatus.id;

    const hiddenPrivateResponse = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(hiddenAuthor.token),
      body: JSON.stringify({
        status: 'Hidden private text',
        language: 'en',
        visibility: 'private',
      }),
    });
    const hiddenPrivateStatus = await hiddenPrivateResponse.json<{ id: string }>();
    hiddenPrivateStatusId = hiddenPrivateStatus.id;

    const hiddenDirectResponse = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(hiddenAuthor.token),
      body: JSON.stringify({
        status: 'Hidden direct text',
        language: 'en',
        visibility: 'direct',
      }),
    });
    const hiddenDirectStatus = await hiddenDirectResponse.json<{ id: string }>();
    hiddenDirectStatusId = hiddenDirectStatus.id;
  });

  it('requires authentication and read:statuses scope', async () => {
    const unauthenticated = await SELF.fetch(
      `${BASE}/api/v1/statuses/${publicStatusId}/translate?lang=en`,
      { method: 'POST' },
    );
    expect(unauthenticated.status).toBe(401);

    const outOfScope = await SELF.fetch(
      `${BASE}/api/v1/statuses/${publicStatusId}/translate?lang=en`,
      { method: 'POST', headers: authHeaders(limitedToken) },
    );
    expect(outOfScope.status).toBe(403);
  });

  it('rejects invalid language tags before inference', async () => {
    const response = await SELF.fetch(
      `${BASE}/api/v1/statuses/${publicStatusId}/translate?lang=not_a_locale`,
      { method: 'POST', headers: authHeaders(token) },
    );
    expect(response.status).toBe(422);
  });

  it('returns 503 for a public status when optional AI is disabled', async () => {
    const response = await SELF.fetch(
      `${BASE}/api/v1/statuses/${publicStatusId}/translate?lang=en`,
      { method: 'POST', headers: authHeaders(token) },
    );
    expect(response.status).toBe(503);
  });

  it('does not expose a billable GET translation route', async () => {
    const response = await SELF.fetch(
      `${BASE}/api/v1/statuses/${publicStatusId}/translate?lang=en`,
      { headers: authHeaders(token) },
    );
    expect(response.status).toBe(404);
  });

  it('returns 403 for a private status visible to its author', async () => {
    const response = await SELF.fetch(
      `${BASE}/api/v1/statuses/${privateStatusId}/translate?lang=ko`,
      { method: 'POST', headers: authHeaders(token) },
    );
    expect(response.status).toBe(403);
  });

  it.each([
    ['private', () => hiddenPrivateStatusId],
    ['direct', () => hiddenDirectStatusId],
  ])('does not expose an unviewable %s status ID', async (_visibility, getStatusId) => {
    const response = await SELF.fetch(
      `${BASE}/api/v1/statuses/${getStatusId()}/translate?lang=ko`,
      { method: 'POST', headers: authHeaders(token) },
    );
    expect(response.status).toBe(404);
  });

  it('does not reveal missing status records', async () => {
    const response = await SELF.fetch(
      `${BASE}/api/v1/statuses/missing-status/translate?lang=en`,
      { method: 'POST', headers: authHeaders(token) },
    );
    expect(response.status).toBe(404);
  });

  it('reports all AI capabilities as disabled by default', async () => {
    const response = await SELF.fetch(`${BASE}/api/v2/instance`);
    const body = await response.json<{
      configuration: {
        translation: { enabled: boolean };
        ai: {
          enabled: boolean;
          recommended_timeline: boolean;
          image_description: boolean;
        };
      };
    }>();

    expect(body.configuration.translation.enabled).toBe(false);
    expect(body.configuration.ai).toEqual({
      enabled: false,
      recommended_timeline: false,
      image_description: false,
    });
  });

  it('discloses the configured model used for a successful translation', async () => {
    const bindings = env as unknown as Record<string, unknown>;
    const names = [
      'WORKERS_AI_ENABLED',
      'WORKERS_AI_TRANSLATION_MODEL',
      'AI',
      'AI_TRANSLATION_RATE_LIMITER',
    ] as const;
    const previous = names.map((name) => ({
      name,
      hadValue: Object.prototype.hasOwnProperty.call(bindings, name),
      value: bindings[name],
    }));
    const configuredModel = '@cf/test/disclosed-translation-model';
    const run = vi.fn(async () => ({ translated_text: 'Translated text' }));
    bindings.WORKERS_AI_ENABLED = true;
    bindings.WORKERS_AI_TRANSLATION_MODEL = configuredModel;
    bindings.AI = { run };
    bindings.AI_TRANSLATION_RATE_LIMITER = {
      limit: vi.fn(async () => ({ success: true })),
    };

    try {
      await cacheWorkersAiFeatureFlags({
        workers_ai_recommendation_enabled: '0',
        workers_ai_translation_enabled: '1',
        workers_ai_image_description_enabled: '0',
      }, bindings);

      const response = await SELF.fetch(
        `${BASE}/api/v1/statuses/${publicStatusId}/translate?lang=en`,
        { method: 'POST', headers: authHeaders(token) },
      );
      const body = await response.json<{
        provider: string;
        model: string;
      }>();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        provider: 'Cloudflare Workers AI',
        model: configuredModel,
      });
      expect(run).toHaveBeenCalledWith(configuredModel, expect.objectContaining({
        text: expect.any(String),
        source_lang: 'ko',
        target_lang: 'en',
      }));
    } finally {
      await cacheWorkersAiFeatureFlags({
        workers_ai_recommendation_enabled: '0',
        workers_ai_translation_enabled: '0',
        workers_ai_image_description_enabled: '0',
      }, bindings);
      for (const entry of previous) {
        if (entry.hadValue) bindings[entry.name] = entry.value;
        else Reflect.deleteProperty(bindings, entry.name);
      }
    }
  });

  it('discards an inference result when the source status changes in flight', async () => {
    const bindings = env as unknown as Record<string, unknown>;
    const names = [
      'WORKERS_AI_ENABLED',
      'AI',
      'AI_TRANSLATION_RATE_LIMITER',
    ] as const;
    const previous = names.map((name) => ({
      name,
      hadValue: Object.prototype.hasOwnProperty.call(bindings, name),
      value: bindings[name],
    }));
    let resolveInference: ((value: { translated_text: string }) => void) | undefined;
    let markInferenceStarted: (() => void) | undefined;
    const inferenceStarted = new Promise<void>((resolve) => {
      markInferenceStarted = resolve;
    });
    const inference = new Promise<{ translated_text: string }>((resolve) => {
      resolveInference = resolve;
    });
    bindings.WORKERS_AI_ENABLED = true;
    bindings.AI = {
      run: vi.fn(async () => {
        markInferenceStarted?.();
        return inference;
      }),
    };
    bindings.AI_TRANSLATION_RATE_LIMITER = {
      limit: vi.fn(async () => ({ success: true })),
    };

    try {
      await cacheWorkersAiFeatureFlags({
        workers_ai_recommendation_enabled: '0',
        workers_ai_translation_enabled: '1',
        workers_ai_image_description_enabled: '0',
      }, bindings);

      const responsePromise = SELF.fetch(
        `${BASE}/api/v1/statuses/${publicStatusId}/translate?lang=en`,
        { method: 'POST', headers: authHeaders(token) },
      );
      await inferenceStarted;
      await env.DB_META_C000.prepare(
        `UPDATE statuses
         SET text = ?1, content = ?1, updated_at = ?2
         WHERE id = ?3`,
      ).bind('게시물이 번역 중 수정되었습니다', new Date(Date.now() + 1_000).toISOString(), publicStatusId).run();
      resolveInference?.({ translated_text: 'A stale translation' });

      const response = await responsePromise;
      expect(response.status).toBe(409);
    } finally {
      for (const entry of previous) {
        if (entry.hadValue) bindings[entry.name] = entry.value;
        else Reflect.deleteProperty(bindings, entry.name);
      }
    }
  });
});
