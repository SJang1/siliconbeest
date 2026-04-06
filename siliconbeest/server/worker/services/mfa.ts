/**
 * MFA (Multi-Factor Authentication) service.
 *
 * Handles TOTP setup, confirmation, and disabling.
 * Uses `env` from cloudflare:workers for DB and encryption key access.
 */

import { env } from 'cloudflare:workers';
import { generateTOTPSecret, generateTOTPUri, generateBackupCodes, hashBackupCode, verifyTOTP } from '../utils/totp';
import { encryptAESGCM, decryptAESGCM } from '../utils/crypto';
import { updateOtp } from '../repositories/user';
import { verifyPassword } from './auth';
import { AppError } from '../middleware/errorHandler';
import { getInstanceTitle } from './instance';
import type { UserRow } from '../types/db';

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export interface MfaSetupResult {
	secret: string;
	uri: string;
	backup_codes: string[];
}

// ----------------------------------------------------------------
// Setup: generate secret, backup codes, store provisionally
// ----------------------------------------------------------------

export async function setupMfa(
	userId: string,
	email: string,
): Promise<MfaSetupResult> {
	const secret = generateTOTPSecret();
	const instanceTitle = await getInstanceTitle();
	const uri = generateTOTPUri(secret, email, instanceTitle);

	const encryptedSecret = await encryptAESGCM(secret, env.OTP_ENCRYPTION_KEY);

	const backupCodes = generateBackupCodes(10);
	const hashedCodes = await Promise.all(backupCodes.map(hashBackupCode));

	await updateOtp(userId, {
		otp_secret: encryptedSecret,
		otp_enabled: 0,
		otp_backup_codes: JSON.stringify(hashedCodes),
	});

	return { secret, uri, backup_codes: backupCodes };
}

// ----------------------------------------------------------------
// Confirm: verify TOTP code and enable 2FA
// ----------------------------------------------------------------

export async function verifyAndEnableMfa(
	userId: string,
	code: string,
): Promise<void> {
	const row = await env.DB
		.prepare('SELECT otp_secret, otp_enabled FROM users WHERE id = ? LIMIT 1')
		.bind(userId)
		.first<Pick<UserRow, 'otp_secret' | 'otp_enabled'>>();

	if (!row?.otp_secret) {
		throw new AppError(422, 'No TOTP secret configured. Call /setup first.');
	}

	if (row.otp_enabled) {
		throw new AppError(422, '2FA is already enabled');
	}

	const secret = await decryptAESGCM(row.otp_secret, env.OTP_ENCRYPTION_KEY);
	const valid = await verifyTOTP(code, secret);

	if (!valid) {
		throw new AppError(401, 'Invalid TOTP code. Please try again.');
	}

	await updateOtp(userId, { otp_enabled: 1 });
}

// ----------------------------------------------------------------
// Disable: verify password and remove all OTP data
// ----------------------------------------------------------------

export async function disableMfa(
	userId: string,
	email: string,
	password: string,
): Promise<void> {
	const result = await verifyPassword(email, password);
	if (!result) {
		throw new AppError(401, 'Invalid password');
	}

	await updateOtp(userId, {
		otp_secret: null,
		otp_enabled: 0,
		otp_backup_codes: null,
	});
}
