/**
 * Route Fedify's internal LogTape records to the console when `DEBUG` is
 * enabled. The queue consumer runs Fedify's actual outbound deliveries
 * (`processQueuedTask`), so this is where Fedify's per-inbox HTTP
 * request/response logging surfaces.
 */

import { configure, type LogRecord } from '@logtape/logtape';
import {
  debugLog,
  isDebugEnabled,
  redactUltraSensitive,
  safeStringify,
} from '../../../packages/shared/utils/debugLog';

// Routed through debugLog so records reach every debug sink (console and,
// when configured, Sentry). Message parts are pre-redacted here because
// they are interpolated into the line rather than passed as details.
function emitRecord(record: LogRecord): void {
  const message = record.message
    .map((part) => (typeof part === 'string' ? part : safeStringify(redactUltraSensitive(part))))
    .join('');
  debugLog(
    record.category.join('.'),
    `${record.level}: ${message}`,
    Object.keys(record.properties).length > 0 ? record.properties : undefined,
  );
}

let configured: Promise<void> | null = null;

/**
 * Configure LogTape once per isolate. No-op (and cheap) when `DEBUG` is off.
 */
export function ensureFedifyDebugLogging(): Promise<void> {
  if (!isDebugEnabled()) return Promise.resolve();
  configured ??= configure({
    sinks: {
      debugConsole: emitRecord,
    },
    loggers: [
      { category: 'fedify', sinks: ['debugConsole'], lowestLevel: 'debug' },
      // Silence LogTape's own meta logger warnings.
      { category: ['logtape', 'meta'], sinks: [] },
    ],
  }).catch((err: unknown) => {
    console.warn('[debug] LogTape configuration failed:', err);
  });
  return configured;
}
