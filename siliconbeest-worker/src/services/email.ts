import { WorkerMailer } from 'worker-mailer';

interface EmailConfig {
	host: string;
	port: number;
	username: string;
	password: string;
	from: string;
}

/**
 * Read SMTP config from env vars OR D1 settings table.
 * Priority: env vars > D1 settings.
 */
async function getEmailConfig(env: any, db?: D1Database): Promise<EmailConfig | null> {
	// Priority 1: environment variables
	if (env.SMTP_HOST) {
		return {
			host: env.SMTP_HOST,
			port: parseInt(env.SMTP_PORT || '587'),
			username: env.SMTP_USER || '',
			password: env.SMTP_PASS || '',
			from: env.SMTP_FROM || `noreply@${env.INSTANCE_DOMAIN}`,
		};
	}

	// Priority 2: D1 settings table
	if (db) {
		try {
			const settings = await db
				.prepare("SELECT key, value FROM settings WHERE key LIKE 'smtp_%'")
				.all();
			if (settings.results && settings.results.length > 0) {
				const map: Record<string, string> = {};
				for (const row of settings.results) {
					map[row.key as string] = row.value as string;
				}
				if (map.smtp_host) {
					return {
						host: map.smtp_host,
						port: parseInt(map.smtp_port || '587'),
						username: map.smtp_user || '',
						password: map.smtp_password || '',
						from: map.smtp_from || `noreply@${env.INSTANCE_DOMAIN}`,
					};
				}
			}
		} catch {
			// settings table might not have smtp entries — that's fine
		}
	}

	return null;
}

/**
 * Send an email via SMTP. Returns false if SMTP is not configured.
 */
export async function sendEmail(
	env: any,
	db: D1Database,
	to: string,
	subject: string,
	html: string,
): Promise<boolean> {
	const config = await getEmailConfig(env, db);
	if (!config) {
		console.warn('[email] SMTP not configured, skipping email to', to);
		return false;
	}

	try {
		const mailer = await WorkerMailer.connect({
			host: config.host,
			port: config.port,
			credentials: {
				username: config.username,
				password: config.password,
			},
			authType: 'plain',
		});
		const { Email } = await import('worker-mailer');
		const email = new Email({
			from: { name: 'SiliconBeest', email: config.from },
			to: [{ email: to }],
			subject,
			html,
		});
		await mailer.send(email);
		return true;
	} catch (err) {
		console.error('[email] Failed to send email:', err);
		return false;
	}
}

/**
 * Send a password reset email with a tokenised link.
 */
export async function sendPasswordReset(
	env: any,
	db: D1Database,
	email: string,
	token: string,
): Promise<boolean> {
	const domain = env.INSTANCE_DOMAIN;
	const resetUrl = `https://${domain}/auth/reset-password?token=${token}`;
	const html = `<h1>Password Reset</h1>
<p>Click the link below to reset your password:</p>
<p><a href="${resetUrl}">${resetUrl}</a></p>
<p>This link expires in 1 hour.</p>`;
	return sendEmail(env, db, email, 'Reset your password', html);
}

/**
 * Send a welcome email after account approval.
 */
export async function sendWelcome(
	env: any,
	db: D1Database,
	email: string,
	username: string,
): Promise<boolean> {
	const domain = env.INSTANCE_DOMAIN;
	const title = env.INSTANCE_TITLE || 'SiliconBeest';
	const html = `<h1>Welcome to ${title}!</h1>
<p>Your account <strong>@${username}@${domain}</strong> has been approved.</p>
<p>Log in at <a href="https://${domain}">https://${domain}</a></p>`;
	return sendEmail(env, db, email, `Welcome to ${title}`, html);
}

/**
 * Send a rejection notification email.
 */
export async function sendRejection(
	env: any,
	db: D1Database,
	email: string,
): Promise<boolean> {
	const title = env.INSTANCE_TITLE || 'SiliconBeest';
	const html = `<h1>Registration Update</h1>
<p>Your registration at ${title} was not approved at this time.</p>`;
	return sendEmail(env, db, email, 'Registration update', html);
}

/**
 * Send an account warning / moderation notice email.
 */
export async function sendAccountWarning(
	env: any,
	db: D1Database,
	email: string,
	action: string,
	text: string,
): Promise<boolean> {
	const html = `<h1>Account Notice</h1>
<p>An action was taken on your account: <strong>${action}</strong></p>
${text ? `<p>${text}</p>` : ''}`;
	return sendEmail(env, db, email, 'Account notice', html);
}
