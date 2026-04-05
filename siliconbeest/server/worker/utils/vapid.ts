/**
 * VAPID key resolution from D1 settings table.
 */

/* oxlint-disable fp/no-loop-statements */

type VapidKeys = {
	publicKey: string;
	privateKey: string;
}

/**
 * Get VAPID keys from DB settings.
 * Returns null if keys are not configured.
 */
export async function getVapidKeys(
	db: D1Database,
): Promise<VapidKeys | null> {
	const { results } = await db
		.prepare("SELECT key, value FROM settings WHERE key IN ('vapid_public_key', 'vapid_private_key')")
		.all<{ key: string; value: string }>();

	const map: Record<string, string> = {};
	for (const row of results || []) {
		if (row.value) map[row.key] = row.value;
	}

	const publicKey = map.vapid_public_key || '';
	const privateKey = map.vapid_private_key || '';

	if (!publicKey || !privateKey) return null;

	return { publicKey, privateKey };
}

/**
 * Get just the VAPID public key (for API responses).
 * Cheaper than getVapidKeys when you only need the public key.
 */
export async function getVapidPublicKey(
	db: D1Database,
): Promise<string> {
	const row = await db
		.prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'")
		.first<{ value: string }>();

	return row?.value || '';
}
