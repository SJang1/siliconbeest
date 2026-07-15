import { env } from 'cloudflare:workers';
import type { RegistrationDesign } from '../types/db';
import { generateToken, sha256 } from '../utils/crypto';
import { AppError } from '../middleware/errorHandler';

export type RegistrationCompletionPayload = {
	userId: string;
	redirectUri: string;
	design: RegistrationDesign;
};

const COMPLETION_TICKET_TTL_SECONDS = 10 * 60;

export async function createRegistrationCompletionTicket(
	payload: RegistrationCompletionPayload,
): Promise<string> {
	const ticket = generateToken(64);
	const tokenHash = await sha256(ticket);
	const createdAt = new Date();
	const expiresAt = new Date(
		createdAt.getTime() + COMPLETION_TICKET_TTL_SECONDS * 1000,
	).toISOString();
	await env.DB.batch([
		env.DB.prepare(
			`DELETE FROM registration_completion_tickets
			 WHERE expires_at <= ?1`,
		).bind(createdAt.toISOString()),
		env.DB.prepare(
			`INSERT INTO registration_completion_tickets
			 (token_hash, user_id, redirect_uri, design, expires_at, consumed_at, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)`,
		).bind(
			tokenHash,
			payload.userId,
			payload.redirectUri,
			payload.design,
			expiresAt,
			createdAt.toISOString(),
		),
	]);
	return ticket;
}

export async function consumeRegistrationCompletionTicket(
	ticket: string,
	userId: string,
): Promise<RegistrationCompletionPayload> {
	if (!/^[0-9a-f]{64}$/.test(ticket)) {
		throw new AppError(410, 'Registration completion ticket is invalid or expired');
	}

	const tokenHash = await sha256(ticket);
	const consumedAt = new Date().toISOString();
	const claimed = await env.DB.prepare(
		`UPDATE registration_completion_tickets
		 SET consumed_at = ?1
		 WHERE token_hash = ?2
		   AND user_id = ?3
		   AND consumed_at IS NULL
		   AND expires_at > ?1`,
	).bind(consumedAt, tokenHash, userId).run();
	if ((claimed.meta.changes ?? 0) !== 1) {
		throw new AppError(410, 'Registration completion ticket is invalid or expired');
	}

	const payload = await env.DB.prepare(
		`SELECT user_id, redirect_uri, design
		 FROM registration_completion_tickets
		 WHERE token_hash = ?1 AND user_id = ?2 AND consumed_at = ?3`,
	).bind(tokenHash, userId, consumedAt).first<{
		user_id: string;
		redirect_uri: string;
		design: RegistrationDesign;
	}>();
	if (!payload) {
		throw new AppError(410, 'Registration completion ticket is invalid or expired');
	}
	return {
		userId: payload.user_id,
		redirectUri: payload.redirect_uri,
		design: payload.design,
	};
}
