/**
 * VAPID key resolution: DB settings take priority over env vars.
 * This allows admin to configure VAPID keys from the Web UI.
 */

interface VapidKeys {
	publicKey: string;
	privateKey: string;
}

/**
 * Get VAPID keys from DB settings, falling back to env vars.
 * Returns null if neither source has keys configured.
 */
export async function getVapidKeys(
	db: D1Database,
	env: { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string },
): Promise<VapidKeys | null> {
	// Try DB first
	const { results } = await db
		.prepare("SELECT key, value FROM settings WHERE key IN ('vapid_public_key', 'vapid_private_key')")
		.all<{ key: string; value: string }>();

	const map: Record<string, string> = {};
	for (const row of results || []) {
		if (row.value) map[row.key] = row.value;
	}

	const publicKey = map.vapid_public_key || env.VAPID_PUBLIC_KEY || '';
	const privateKey = map.vapid_private_key || env.VAPID_PRIVATE_KEY || '';

	if (!publicKey || !privateKey) return null;

	return { publicKey, privateKey };
}

/**
 * Get just the VAPID public key (for API responses).
 * Cheaper than getVapidKeys when you only need the public key.
 */
export async function getVapidPublicKey(
	db: D1Database,
	env: { VAPID_PUBLIC_KEY?: string },
): Promise<string> {
	const row = await db
		.prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'")
		.first<{ value: string }>();

	return row?.value || env.VAPID_PUBLIC_KEY || '';
}
