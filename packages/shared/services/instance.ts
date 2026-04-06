/**
 * Instance Record Service
 *
 * Pure functions for managing instance records during federation delivery.
 * Used by both deliverActivity, forwardActivity, and fetchRemoteAccount handlers.
 */

/**
 * Ensure an instance record exists for the given domain.
 * Uses INSERT OR IGNORE so it's safe to call multiple times.
 */
export async function ensureInstanceRecord(
  db: D1Database,
  domain: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO instances (id, domain, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(crypto.randomUUID(), domain)
    .run();
}

/**
 * Record a successful delivery to a domain.
 * Resets failure_count and updates last_successful_at.
 */
export async function recordDeliverySuccess(
  db: D1Database,
  domain: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE instances
       SET last_successful_at = datetime('now'),
           failure_count = 0,
           updated_at = datetime('now')
       WHERE domain = ?`,
    )
    .bind(domain)
    .run();
}

/**
 * Record a failed delivery to a domain.
 * Increments failure_count and updates last_failed_at.
 */
export async function recordDeliveryFailure(
  db: D1Database,
  domain: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE instances
       SET last_failed_at = datetime('now'),
           failure_count = failure_count + 1,
           updated_at = datetime('now')
       WHERE domain = ?`,
    )
    .bind(domain)
    .run();
}
