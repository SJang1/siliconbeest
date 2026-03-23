import { generateUlid } from '../utils/ulid';

export interface User {
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
}

export interface CreateUserInput {
	account_id: string;
	email: string;
	encrypted_password: string;
	locale?: string;
	role?: string;
	confirmed_at?: string | null;
	confirmation_token?: string | null;
}

export class UserRepository {
	constructor(private db: D1Database) {}

	async findById(id: string): Promise<User | null> {
		const result = await this.db
			.prepare('SELECT * FROM users WHERE id = ?')
			.bind(id)
			.first<User>();
		return result ?? null;
	}

	async findByEmail(email: string): Promise<User | null> {
		const result = await this.db
			.prepare('SELECT * FROM users WHERE email = ?')
			.bind(email)
			.first<User>();
		return result ?? null;
	}

	async findByAccountId(accountId: string): Promise<User | null> {
		const result = await this.db
			.prepare('SELECT * FROM users WHERE account_id = ?')
			.bind(accountId)
			.first<User>();
		return result ?? null;
	}

	async create(input: CreateUserInput): Promise<User> {
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

		await this.db
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
	}

	async update(id: string, input: Partial<Omit<User, 'id' | 'created_at' | 'updated_at'>>): Promise<User | null> {
		const now = new Date().toISOString();
		const fields: string[] = [];
		const values: unknown[] = [];

		for (const [key, value] of Object.entries(input)) {
			fields.push(`${key} = ?`);
			values.push(value);
		}

		fields.push('updated_at = ?');
		values.push(now);
		values.push(id);

		await this.db
			.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
			.bind(...values)
			.run();

		return this.findById(id);
	}

	async updatePassword(id: string, encryptedPassword: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db
			.prepare('UPDATE users SET encrypted_password = ?, updated_at = ? WHERE id = ?')
			.bind(encryptedPassword, now, id)
			.run();
	}

	async updateOtp(
		id: string,
		data: { otp_secret?: string | null; otp_enabled?: number; otp_backup_codes?: string | null }
	): Promise<void> {
		const now = new Date().toISOString();
		const fields: string[] = [];
		const values: unknown[] = [];

		if (data.otp_secret !== undefined) {
			fields.push('otp_secret = ?');
			values.push(data.otp_secret);
		}
		if (data.otp_enabled !== undefined) {
			fields.push('otp_enabled = ?');
			values.push(data.otp_enabled);
		}
		if (data.otp_backup_codes !== undefined) {
			fields.push('otp_backup_codes = ?');
			values.push(data.otp_backup_codes);
		}

		if (fields.length === 0) return;

		fields.push('updated_at = ?');
		values.push(now);
		values.push(id);

		await this.db
			.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
			.bind(...values)
			.run();
	}

	async updateSignIn(id: string, ip: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db
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
	}
}
