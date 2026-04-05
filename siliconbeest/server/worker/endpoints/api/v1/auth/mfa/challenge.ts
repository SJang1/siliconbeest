/**
 * MFA challenge verification endpoint.
 * POST /api/v1/auth/mfa/challenge
 *
 * After a login attempt returns `mfa_required`, the client sends
 * the temporary `mfa_token` and the user's TOTP `code` (or a backup code)
 * to this endpoint to complete authentication.
 */
import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { decryptAESGCM } from '../../../../../utils/crypto';
import { verifyTOTP, hashBackupCode } from '../../../../../utils/totp';
import { AppError } from '../../../../../middleware/errorHandler';
import {
	getOrCreateInternalApp,
	createAccessToken,
	updateSignInTracking,
} from '../../../../../services/auth';
import type { UserRow } from '../../../../../types/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.post('/', async (c) => {
	const body = await c.req.json<{ mfa_token?: string; code?: string }>().catch(
		(): { mfa_token?: string; code?: string } => ({}),
	);

	const { mfa_token, code } = body;

	if (!mfa_token || !code) {
		throw new AppError(422, 'mfa_token and code are required');
	}

	// Validate the mfa_token from KV
	const kvKey = `mfa:${mfa_token}`;
	const userId = await c.env.CACHE.get(kvKey);

	if (!userId) {
		throw new AppError(401, 'MFA token is invalid or expired');
	}

	// Look up user
	const user = await c.env.DB.prepare(
		'SELECT id, otp_enabled, otp_secret, otp_backup_codes FROM users WHERE id = ?1 LIMIT 1',
	).bind(userId).first<Pick<UserRow, 'id' | 'otp_enabled' | 'otp_secret' | 'otp_backup_codes'>>();

	if (!user || !user.otp_enabled || !user.otp_secret) {
		// Clean up the KV entry
		await c.env.CACHE.delete(kvKey);
		throw new AppError(401, 'MFA is not configured for this account');
	}

	// Decrypt the OTP secret
	const otpSecret = await decryptAESGCM(user.otp_secret, c.env.OTP_ENCRYPTION_KEY);

	// Try TOTP verification first
	const totpValid = await verifyTOTP(code, otpSecret);

	if (!totpValid) {
		// Try backup codes
		const backupCodeUsed = await tryBackupCode(c.env.DB, user, code);

		if (!backupCodeUsed) {
			throw new AppError(401, 'Invalid MFA code');
		}
	}

	// Success — delete the MFA token to prevent replay
	await c.env.CACHE.delete(kvKey);

	// Issue access token
	const appRecord = await getOrCreateInternalApp(c.env.DB);
	const { tokenValue, createdAt } = await createAccessToken(c.env.DB, appRecord.id, user.id);

	// Update sign-in tracking
	const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
	await updateSignInTracking(c.env.DB, user.id, ip);

	return c.json({
		access_token: tokenValue,
		token_type: 'Bearer',
		scope: 'read write follow push',
		created_at: Math.floor(new Date(createdAt).getTime() / 1000),
	});
});

/**
 * Check if the provided code matches any of the user's backup codes.
 * If it matches, remove the used backup code from the user record.
 */
async function tryBackupCode(
	db: D1Database,
	user: Pick<UserRow, 'id' | 'otp_backup_codes'>,
	code: string,
): Promise<boolean> {
	if (!user.otp_backup_codes) {
		return false;
	}

	let storedHashes: string[];
	try {
		storedHashes = JSON.parse(user.otp_backup_codes) as string[];
	} catch {
		return false;
	}

	if (!Array.isArray(storedHashes) || storedHashes.length === 0) {
		return false;
	}

	const codeHash = await hashBackupCode(code);
	const matchIndex = storedHashes.indexOf(codeHash);

	if (matchIndex === -1) {
		return false;
	}

	// Remove the used backup code
	storedHashes.splice(matchIndex, 1);
	const updatedCodes = JSON.stringify(storedHashes);

	await db.prepare(
		'UPDATE users SET otp_backup_codes = ?1, updated_at = ?2 WHERE id = ?3',
	).bind(updatedCodes, new Date().toISOString(), user.id).run();

	return true;
}

export default app;
