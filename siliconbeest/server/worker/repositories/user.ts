import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';

export type User = {
	id: string;
	account_id: string;
	email: string;
	encrypted_password: string;
	locale: string;
	confirmed_at: string | null;
	confirmation_token: string | null;
	reset_password_token: string | null;
	reset_password_sent_at: string | null;
	otp_secret: string | null;
	otp_enabled: number;
	otp_backup_codes: string | null;
	role: string;
	approved: number;
	disabled: number;
	sign_in_count: number;
	current_sign_in_at: string | null;
	last_sign_in_at: string | null;
	current_sign_in_ip: string | null;
	last_sign_in_ip: string | null;
	chosen_languages: string | null;
	created_at: string;
	updated_at: string;
};

export type CreateUserInput = {
	account_id: string;
	email: string;
	encrypted_password: string;
	locale?: string;
	role?: string;
	confirmed_at?: string | null;
	confirmation_token?: string | null;
};

export const findById = async (id: string): Promise<User | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM users WHERE id = ?')
		.bind(id)
		.first<User>();
	return result ?? null;
};

export const findByEmail = async (email: string): Promise<User | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM users WHERE email = ?')
		.bind(email)
		.first<User>();
	return result ?? null;
};

export const findByAccountId = async (accountId: string): Promise<User | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM users WHERE account_id = ?')
		.bind(accountId)
		.first<User>();
	return result ?? null;
};

export const create = async (input: CreateUserInput): Promise<User> => {
	const now = new Date().toISOString();
	const id = generateUlid();
	const user: User = {
		id,
		account_id: input.account_id,
		email: input.email,
		encrypted_password: input.encrypted_password,
		locale: input.locale ?? 'en',
		confirmed_at: input.confirmed_at ?? null,
		confirmation_token: input.confirmation_token ?? null,
		reset_password_token: null,
		reset_password_sent_at: null,
		otp_secret: null,
		otp_enabled: 0,
		otp_backup_codes: null,
		role: input.role ?? 'user',
		approved: 1,
		disabled: 0,
		sign_in_count: 0,
		current_sign_in_at: null,
		last_sign_in_at: null,
		current_sign_in_ip: null,
		last_sign_in_ip: null,
		chosen_languages: null,
		created_at: now,
		updated_at: now,
	};

	await env.DB
		.prepare(
			`INSERT INTO users (
				id, account_id, email, encrypted_password, locale,
				confirmed_at, confirmation_token,
				reset_password_token, reset_password_sent_at,
				otp_secret, otp_enabled, otp_backup_codes,
				role, approved, disabled,
				sign_in_count, current_sign_in_at, last_sign_in_at,
				current_sign_in_ip, last_sign_in_ip,
				chosen_languages, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			user.id, user.account_id, user.email, user.encrypted_password, user.locale,
			user.confirmed_at, user.confirmation_token,
			user.reset_password_token, user.reset_password_sent_at,
			user.otp_secret, user.otp_enabled, user.otp_backup_codes,
			user.role, user.approved, user.disabled,
			user.sign_in_count, user.current_sign_in_at, user.last_sign_in_at,
			user.current_sign_in_ip, user.last_sign_in_ip,
			user.chosen_languages, user.created_at, user.updated_at
		)
		.run();

	return user;
};

export const update = async (id: string, input: Partial<Omit<User, 'id' | 'created_at' | 'updated_at'>>): Promise<User | null> => {
	const now = new Date().toISOString();
	const entries = Object.entries(input);
	const fields = [...entries.map(([key]) => `${key} = ?`), 'updated_at = ?'];
	const values = [...entries.map(([, value]) => value), now, id];

	await env.DB
		.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();

	return findById(id);
};

export const updatePassword = async (id: string, encryptedPassword: string): Promise<void> => {
	const now = new Date().toISOString();
	await env.DB
		.prepare('UPDATE users SET encrypted_password = ?, updated_at = ? WHERE id = ?')
		.bind(encryptedPassword, now, id)
		.run();
};

export const updateOtp = async (
	id: string,
	data: { otp_secret?: string | null; otp_enabled?: number; otp_backup_codes?: string | null }
): Promise<void> => {
	const now = new Date().toISOString();
	const entries = Object.entries(data).filter(([, v]) => v !== undefined);

	if (entries.length === 0) return;

	const fields = [...entries.map(([key]) => `${key} = ?`), 'updated_at = ?'];
	const values = [...entries.map(([, value]) => value), now, id];

	await env.DB
		.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();
};

export const updateSignIn = async (id: string, ip: string): Promise<void> => {
	const now = new Date().toISOString();
	await env.DB
		.prepare(
			`UPDATE users SET
				last_sign_in_at = current_sign_in_at,
				last_sign_in_ip = current_sign_in_ip,
				current_sign_in_at = ?,
				current_sign_in_ip = ?,
				sign_in_count = sign_in_count + 1,
				updated_at = ?
			 WHERE id = ?`
		)
		.bind(now, ip, now, id)
		.run();
};
