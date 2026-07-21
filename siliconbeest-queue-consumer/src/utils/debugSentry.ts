/**
 * Mirror debug logs to Sentry when both `DEBUG` and Sentry are enabled.
 *
 * The consumer entry (`src/index.ts`) initializes Sentry via
 * `Sentry.withSentry` with `enableLogs: true`; when the optional
 * `SENTRY_DSN` secret is unset, Sentry is disabled and this module never
 * registers a sink. The sink receives details AFTER ultra-sensitive
 * redaction, so Sentry can never see more than the console does.
 */

import * as Sentry from '@sentry/cloudflare';
import { env } from 'cloudflare:workers';
import {
  isDebugEnabled,
  safeStringify,
  setDebugLogSink,
  truncateForDebugLog,
} from '../../../packages/shared/utils/debugLog';

let registered = false;

/** Register the Sentry debug-log sink once per isolate. Cheap no-op otherwise. */
export function ensureDebugSentryLogging(): void {
  if (registered) return;
  if (!isDebugEnabled() || !env.SENTRY_DSN) return;
  registered = true;
  setDebugLogSink((scope, message, redactedDetails) => {
    Sentry.logger.debug(`[${scope}] ${message}`, {
      scope,
      ...(redactedDetails === undefined
        ? {}
        : { details: truncateForDebugLog(safeStringify(redactedDetails)) }),
    });
  });
}
