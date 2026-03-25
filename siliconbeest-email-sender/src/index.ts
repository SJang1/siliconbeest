import { WorkerMailer } from 'worker-mailer';

// ============================================================================
// Types
// ============================================================================

interface Env {
	DB: D1Database;

	// SMTP configuration (secrets set via `wrangler secret put`)
	SMTP_HOST?: string;
	SMTP_PORT?: string;
	SMTP_USER?: string;
	SMTP_PASS?: string;
	SMTP_FROM?: string;
	SMTP_SECURE?: string;
	SMTP_AUTH_TYPE?: string;
}

interface EmailMessage {
	type: 'send_email';
	to: string;
	subject: string;
	html: string;
	text?: string;
}

interface EmailConfig {
	host: string;
	port: number;
	username: string;
	password: string;
	from: string;
	secure: boolean;
	authType: 'plain' | 'login' | 'cram-md5' | 'auto';
}

// ============================================================================
// SMTP config resolution
// ============================================================================

/**
 * Read SMTP config from env vars OR D1 settings table.
 * Priority: env vars > D1 settings.
 */
async function getEmailConfig(env: Env): Promise<EmailConfig | null> {
	// Priority 1: environment variables
	if (env.SMTP_HOST) {
		const port = parseInt(env.SMTP_PORT || '587');
		return {
			host: env.SMTP_HOST,
			port,
			username: env.SMTP_USER || '',
			password: env.SMTP_PASS || '',
			from: env.SMTP_FROM || 'noreply@localhost',
			secure: env.SMTP_SECURE === 'true' || port === 465,
			authType: (env.SMTP_AUTH_TYPE as EmailConfig['authType']) || 'auto',
		};
	}

	// Priority 2: D1 settings table
	try {
		const settings = await env.DB
			.prepare("SELECT key, value FROM settings WHERE key LIKE 'smtp_%'")
			.all();
		if (settings.results && settings.results.length > 0) {
			const map: Record<string, string> = {};
			for (const row of settings.results) {
				map[row.key as string] = row.value as string;
			}
			if (map.smtp_host) {
				const port = parseInt(map.smtp_port || '587');
				return {
					host: map.smtp_host,
					port,
					username: map.smtp_username || map.smtp_user || '',
					password: map.smtp_password || '',
					from: map.smtp_from_address || map.smtp_from || 'noreply@localhost',
					secure: map.smtp_secure === 'true' || port === 465,
					authType: (map.smtp_auth_type as EmailConfig['authType']) || 'auto',
				};
			}
		}
	} catch {
		// settings table might not have smtp entries -- that's fine
	}

	return null;
}

// ============================================================================
// Queue consumer
// ============================================================================

export default {
	async fetch(): Promise<Response> {
		return new Response('siliconbeest-email-sender: queue consumer only', { status: 200 });
	},

	async queue(batch: MessageBatch<EmailMessage>, env: Env): Promise<void> {
		for (const msg of batch.messages) {
			try {
				const config = await getEmailConfig(env);
				if (!config || !config.host) {
					console.warn('[email-sender] No SMTP configured, dropping message');
					msg.ack();
					continue;
				}

				const authType: ('plain' | 'login' | 'cram-md5') | ('plain' | 'login' | 'cram-md5')[] =
					config.authType === 'auto' || !config.authType
						? ['login', 'plain', 'cram-md5']
						: config.authType as 'plain' | 'login' | 'cram-md5';

				await WorkerMailer.send(
					{
						host: config.host,
						port: config.port,
						secure: config.secure,
						startTls: !config.secure,
						credentials: config.username
							? { username: config.username, password: config.password }
							: undefined,
						authType,
					},
					{
						from: { name: 'SiliconBeest', email: config.from },
						to: msg.body.to,
						subject: msg.body.subject,
						html: msg.body.html,
						text: msg.body.text,
					},
				);

				console.log(`[email-sender] Sent to ${msg.body.to}: ${msg.body.subject}`);
				msg.ack();
			} catch (e) {
				console.error(`[email-sender] Failed to send to ${msg.body.to}:`, e);
				msg.retry();
			}
		}
	},
} satisfies ExportedHandler<Env>;
