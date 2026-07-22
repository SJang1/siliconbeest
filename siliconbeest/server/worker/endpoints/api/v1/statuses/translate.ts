/* oxlint-disable fp/no-throw-statements, fp/no-promise-reject, fp/no-try-statements */
import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import { decodeHTML } from 'entities';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { buildStatusVisibilitySqlPredicate } from '../../../../services/permissions';
import {
  WorkersAiServiceError,
  translateWithWorkersAi,
} from '../../../../services/workersAi';
import { consumeWorkersAiRateLimit } from '../../../../services/workersAiRateLimit';
import { isWorkersAiFeatureEnabled } from '../../../../services/workersAiFeatures';
import { parseContent } from '../../../../utils/contentParser';
import { sanitizePlainText } from '../../../../utils/sanitize';

type HonoEnv = { Variables: AppVariables };

type TranslatableStatusRow = {
  id: string;
  account_id: string;
  visibility: string;
  deleted_at: string | null;
  reblog_of_id: string | null;
  text: string | null;
  content: string | null;
  content_warning: string | null;
  language: string | null;
  updated_at: string;
};

const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;

export function statusHtmlToTranslationText(value: string): string {
  const textWithParagraphs = value
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\b[^>]*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|blockquote|pre|li|h[1-6])\s*>/gi, '\n\n')
    .replace(/<[a-zA-Z/][^>]*>/g, ' ');

  return decodeHTML(textWithParagraphs)
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/ *\r?\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function translatedStatusTextToHtml(value: string, domain: string): string {
  return parseContent(value, domain).html;
}

function baseLanguage(value: string): string {
  return value.trim().toLowerCase().split(/[-_]/, 1)[0];
}

function mapTranslationError(error: unknown): AppError {
  if (error instanceof WorkersAiServiceError) {
    if (error.code === 'disabled') {
      return new AppError(503, 'Translation is not enabled');
    }
    if (error.code === 'unsupported_language') {
      return new AppError(403, 'This action is not allowed');
    }
    if (error.code === 'invalid_input') {
      return new AppError(422, 'Validation failed', error.message);
    }
  }
  return new AppError(503, 'Service Unavailable');
}

async function getTranslatableStatus(
  statusId: string,
  viewerAccountId: string,
): Promise<TranslatableStatusRow | null> {
  const visibility = buildStatusVisibilitySqlPredicate('status', viewerAccountId);
  return env.DB_META_C000.prepare(
    `SELECT s.id, s.account_id, s.visibility, s.deleted_at, s.reblog_of_id,
            s.text, s.content, s.content_warning, s.language, s.updated_at
     FROM statuses s
     WHERE s.id = ?
       AND s.reblog_of_id IS NULL
       AND s.visibility IN ('public', 'unlisted')
       AND ${visibility.sql}
     LIMIT 1`,
  ).bind(statusId, ...visibility.bindings).first<TranslatableStatusRow>();
}

async function getStatusForTranslationPolicy(
  statusId: string,
  viewerAccountId: string,
): Promise<TranslatableStatusRow | null> {
  const visibility = buildStatusVisibilitySqlPredicate('status', viewerAccountId);
  return env.DB_META_C000.prepare(
    `SELECT s.id, s.account_id, s.visibility, s.deleted_at, s.reblog_of_id,
            s.text, s.content, s.content_warning, s.language, s.updated_at
     FROM statuses s
     WHERE s.id = ?
       AND ${visibility.sql}
     LIMIT 1`,
  ).bind(statusId, ...visibility.bindings).first<TranslatableStatusRow>();
}

function translationSourceUnchanged(
  before: TranslatableStatusRow,
  after: TranslatableStatusRow,
): boolean {
  return before.id === after.id
    && before.visibility === after.visibility
    && before.deleted_at === after.deleted_at
    && before.text === after.text
    && before.content === after.content
    && before.content_warning === after.content_warning
    && before.language === after.language
    && before.updated_at === after.updated_at;
}

const app = new Hono<HonoEnv>();

// Translation can incur paid inference, so it is intentionally POST-only.
app.on(
  ['POST'],
  '/:id/translate',
  authRequired,
  requireScope('read:statuses'),
  async (c) => {
    const statusId = c.req.param('id');
    const currentUser = c.get('currentUser');
    if (!currentUser) throw new AppError(401, 'The access token is invalid');
    const currentAccountId = currentUser.account_id;
    const queryLanguage = c.req.query('lang')?.trim() ?? '';

    if (queryLanguage && !LANGUAGE_TAG.test(queryLanguage)) {
      throw new AppError(422, 'Validation failed', 'A valid target language is required');
    }
    const user = queryLanguage
      ? null
      : await env.DB_META_C000.prepare('SELECT locale FROM users WHERE id = ?1')
        .bind(currentUser.id)
        .first<{ locale: string | null }>();
    const requestedLanguage = queryLanguage || user?.locale?.trim() || 'en';

    if (!LANGUAGE_TAG.test(requestedLanguage)) {
      throw new AppError(422, 'Validation failed', 'A valid target language is required');
    }

    const status = await getTranslatableStatus(statusId, currentAccountId);
    if (!status) {
      const policyStatus = await getStatusForTranslationPolicy(statusId, currentAccountId);
      if (
        policyStatus
        && policyStatus.deleted_at === null
        && policyStatus.reblog_of_id === null
        && policyStatus.visibility !== 'public'
        && policyStatus.visibility !== 'unlisted'
      ) {
        throw new AppError(403, 'This action is not allowed');
      }
      throw new AppError(404, 'Record not found');
    }

    if (!await isWorkersAiFeatureEnabled('translation')) {
      throw new AppError(503, 'Translation is not enabled');
    }

    const sourceLanguage = status.language?.trim() || 'en';
    if (baseLanguage(sourceLanguage) === baseLanguage(requestedLanguage)) {
      throw new AppError(403, 'This action is not allowed');
    }

    const sourceContent = status.content?.trim() || status.text?.trim() || '';
    const contentText = statusHtmlToTranslationText(sourceContent);
    const spoilerText = statusHtmlToTranslationText(status.content_warning || '');
    if (!contentText) {
      throw new AppError(422, 'Validation failed', 'The status has no translatable text');
    }
    const rateLimit = await consumeWorkersAiRateLimit('translation', currentAccountId);
    if (!rateLimit.allowed) {
      const unavailable = rateLimit.reason === 'unavailable';
      return c.json({
        error: unavailable
          ? 'Translation rate-limit guard is unavailable'
          : 'Translation rate limit exceeded',
        error_code: unavailable
          ? 'AI_TRANSLATION_UNAVAILABLE'
          : 'AI_TRANSLATION_RATE_LIMITED',
      }, unavailable ? 503 : 429, {
        'Cache-Control': 'private, no-store',
        'Retry-After': String(rateLimit.retryAfterSeconds),
        Vary: 'Authorization',
      });
    }

    try {
      const [contentTranslation, spoilerTranslation] = await Promise.all([
        translateWithWorkersAi(contentText, sourceLanguage, requestedLanguage, env),
        spoilerText
          ? translateWithWorkersAi(spoilerText, sourceLanguage, requestedLanguage, env)
          : Promise.resolve(null),
      ]);

      // Inference is a network hop. Discard the result if the post was edited,
      // deleted, made private, or became unviewable while the model was running.
      const currentStatus = await getTranslatableStatus(statusId, currentAccountId);
      if (!currentStatus) throw new AppError(404, 'Record not found');
      if (!translationSourceUnchanged(status, currentStatus)) {
        throw new AppError(409, 'The status changed during translation; retry');
      }

      return c.json({
        content: translatedStatusTextToHtml(contentTranslation.translatedText, env.INSTANCE_DOMAIN),
        spoiler_text: spoilerTranslation
          ? sanitizePlainText(spoilerTranslation.translatedText)
          : '',
        poll: null,
        media_attachments: [],
        detected_source_language: sourceLanguage,
        provider: 'Cloudflare Workers AI',
        model: contentTranslation.model,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      console.warn('[workers-ai]', JSON.stringify({
        event: 'status_translation_failed',
        status_id: statusId,
        reason: error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error',
      }));
      throw mapTranslationError(error);
    }
  },
);

export default app;
