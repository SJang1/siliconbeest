/**
 * MFA challenge verification endpoint.
 * POST /api/v1/auth/mfa/challenge
 */
import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../../../types';
import { decryptAESGCM } from '../../../../../utils/crypto';
import { verifyTOTP, hashBackupCode } from '../../../../../utils/totp';
import { AppError } from '../../../../../middleware/errorHandler';
import {
	getOrCreateInternalApp,
	createAccessToken,
	updateSignInTracking,
} from '../../../../../services/auth';
import type { UserRow } from '../../../../../types/db';

const app = new Hono<{ Variables: AppVariables }>();

app.post('/', async (c) => {
	const body = await c.req.json<{ mfa_token?: string; code?: string }>().catch(
		(): { mfa_token?: string; code?: string } => ({}),
	);

	const { mfa_token, code } = body;

	if (!mfa_token || !code) {
		throw new AppError(422, 'mfa_token and code are required');
	}

	const kvKey = `mfa:${mfa_token}`;
	const userId = await env.CACHE.get(kvKey);

	if (!userId) {
		throw new AppError(401, 'MFA token is invalid or expired');
	}

	const user = await env.DB.prepare(
		'SELECT id, email, locale, otp_enabled, otp_secret, otp_backup_codes FROM users WHERE id = ?1 LIMIT 1',
	).bind(userId).first<Pick<UserRow, 'id' | 'otp_enabled' | 'otp_secret' | 'otp_backup_codes'> & { email: string; locale: string }>();

	if (!user || !user.otp_enabled || !user.otp_secret) {
		await env.CACHE.delete(kvKey);
		throw new AppError(401, 'MFA is not configured for this account');
	}

	const otpSecret = await decryptAESGCM(user.otp_secret, env.OTP_ENCRYPTION_KEY);
	const totpValid = await verifyTOTP(code, otpSecret);

	if (!totpValid) {
		const backupCodeUsed = await tryBackupCode(user, code);
		if (!backupCodeUsed) {
			throw new AppError(401, 'Invalid MFA code');
		}
	}

	await env.CACHE.delete(kvKey);

	// Issue access token (includes login notification email)
	const appRecord = await getOrCreateInternalApp();
	const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
	const userAgent = c.req.header('User-Agent') || '';
	const { tokenValue, createdAt } = await createAccessToken(appRecord.id, user.id, {
		ip, userAgent, email: user.email, locale: user.locale,
	});

	await updateSignInTracking(user.id, ip);

	return c.json({
		access_token: tokenValue,
		token_type: 'Bearer',
		scope: 'read write follow push',
		created_at: Math.floor(new Date(createdAt).getTime() / 1000),
	});
});

async function tryBackupCode(
	user: Pick<UserRow, 'id' | 'otp_backup_codes'>,
	code: string,
): Promise<boolean> {
	if (!user.otp_backup_codes) return false;

	let storedHashes: string[];
	try {
		storedHashes = JSON.parse(user.otp_backup_codes) as string[];
	} catch {
		return false;
	}

	if (!Array.isArray(storedHashes) || storedHashes.length === 0) return false;

	const codeHash = await hashBackupCode(code);
	const matchIndex = storedHashes.indexOf(codeHash);
	if (matchIndex === -1) return false;

	storedHashes.splice(matchIndex, 1);
	await env.DB.prepare(
		'UPDATE users SET otp_backup_codes = ?1, updated_at = ?2 WHERE id = ?3',
	).bind(JSON.stringify(storedHashes), new Date().toISOString(), user.id).run();

	return true;
}

export default app;
