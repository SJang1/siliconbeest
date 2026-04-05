/* oxlint-disable fp/no-classes, fp/no-class-inheritance, fp/no-this-expressions */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, AppVariables } from '../env';

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

// ---------------------------------------------------------------------------
// Custom error class
// ---------------------------------------------------------------------------

/**
 * Application error with an associated HTTP status code.
 *
 * Throwing an `AppError` from any handler or middleware will be caught by
 * `errorHandler` and serialised into a Mastodon-compatible JSON body.
 *
 * ```ts
 * throw new AppError(404, 'Record not found');
 * ```
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorDescription?: string;

  constructor(statusCode: number, message: string, errorDescription?: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.errorDescription = errorDescription;
  }
}

// ---------------------------------------------------------------------------
// Predefined error factories
// ---------------------------------------------------------------------------

export const NotFoundError = (msg = 'Record not found') =>
  new AppError(404, msg);

export const UnauthorizedError = (msg = 'The access token is invalid') =>
  new AppError(401, msg);

export const ForbiddenError = (msg = 'This action is not allowed') =>
  new AppError(403, msg);

export const UnprocessableEntityError = (
  msg = 'Validation failed',
  description?: string,
) => new AppError(422, msg, description);

export const GoneError = (msg = 'Resource is gone') =>
  new AppError(410, msg);

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

/**
 * Hono `app.onError()` handler.
 *
 * Returns a Mastodon-compatible error response:
 * ```json
 * { "error": "...", "error_description": "..." }
 * ```
 */
export function errorHandler(err: Error, c: AppContext) {
  // Known application errors
  if (err instanceof AppError) {
    const body: { error: string; error_description?: string } = {
      error: err.message,
    };
    if (err.errorDescription) {
      body.error_description = err.errorDescription;
    }
    return c.json(body, err.statusCode as ContentfulStatusCode);
  }

  // Unexpected / internal errors
  console.error('[errorHandler]', err);

  return c.json(
    { error: 'An unexpected error occurred' },
    500,
  );
}
