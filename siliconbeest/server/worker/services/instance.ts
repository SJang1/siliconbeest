import type { RuleRow, SettingRow } from '../types/db';
import { MASTODON_SERVICE_VERSION } from '../version';

/**
 * Instance service: instance metadata for /api/v2/instance,
 * rules, and key-value settings management.
 */
export class InstanceService {
	constructor(
		private db: D1Database,
		private kv: KVNamespace,
		private domain: string,
		private title: string,
	) {}

	// ----------------------------------------------------------------
	// Get instance info (Mastodon /api/v2/instance format)
	// ----------------------------------------------------------------
	async getInstanceInfo(): Promise<Record<string, unknown>> {
		// Fetch settings
		const description = (await this.getSetting('site_description')) || '';
		const shortDescription = (await this.getSetting('site_short_description')) || '';
		const email = (await this.getSetting('site_contact_email')) || '';
		const registrations = (await this.getSetting('registrations_mode')) || 'open';
		const maxChars = parseInt((await this.getSetting('max_toot_chars')) || '500', 10);
		const maxMediaAttachments = parseInt((await this.getSetting('max_media_attachments')) || '4', 10);

		// Get stats with KV caching
		const stats = await this.getStats();
		const rules = await this.getRules();

		return {
			domain: this.domain,
			title: this.title,
			version: MASTODON_SERVICE_VERSION,
			source_url: 'https://github.com/SJang1/siliconbeest',
			description,
			usage: {
				users: {
					active_month: stats.activeUsers,
				},
			},
			thumbnail: {
				url: `https://${this.domain}/images/thumbnail.png`,
				blurhash: null,
				versions: {},
			},
			languages: ['en'],
			configuration: {
				urls: {
					streaming: `wss://${this.domain}/api/v1/streaming`,
					status: null,
				},
				accounts: {
					max_featured_tags: 10,
					max_pinned_statuses: 5,
				},
				statuses: {
					max_characters: maxChars,
					max_media_attachments: maxMediaAttachments,
					characters_reserved_per_url: 23,
				},
				media_attachments: {
					supported_mime_types: [
						'image/jpeg',
						'image/png',
						'image/gif',
						'image/webp',
						'video/mp4',
						'video/webm',
						'audio/mpeg',
						'audio/ogg',
						'audio/wav',
					],
					image_size_limit: 16777216, // 16 MB
					image_matrix_limit: 33177600,
					video_size_limit: 103809024, // 99 MB
					video_frame_rate_limit: 120,
					video_matrix_limit: 8294400,
				},
				polls: {
					max_options: 4,
					max_characters_per_option: 50,
					min_expiration: 300,
					max_expiration: 2629746,
				},
				translation: {
					enabled: false,
				},
			},
			registrations: {
				enabled: registrations !== 'closed',
				approval_required: registrations === 'approval',
				message: null,
				url: null,
			},
			contact: {
				email,
				account: null,
			},
			rules: rules.map((rule) => ({
				id: rule.id,
				text: rule.text,
				hint: '',
			})),
		};
	}

	// ----------------------------------------------------------------
	// Get instance rules
	// ----------------------------------------------------------------
	async getRules(): Promise<RuleRow[]> {
		const result = await this.db.prepare('SELECT * FROM rules ORDER BY priority ASC').all();
		return (result.results || []) as unknown as RuleRow[];
	}

	// ----------------------------------------------------------------
	// Get setting
	// ----------------------------------------------------------------
	async getSetting(key: string): Promise<string | null> {
		const row = (await this.db.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1').bind(key).first()) as SettingRow | null;
		return row?.value || null;
	}

	// ----------------------------------------------------------------
	// Set setting
	// ----------------------------------------------------------------
	async setSetting(key: string, value: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db
			.prepare(
				`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			)
			.bind(key, value, now)
			.run();
	}

	// ----------------------------------------------------------------
	// Get stats (cached in KV for 1 hour)
	// ----------------------------------------------------------------
	private async getStats(): Promise<{ userCount: number; statusCount: number; domainCount: number; activeUsers: number }> {
		const cacheKey = 'instance:stats';
		const cached = await this.kv.get(cacheKey, 'json');
		if (cached) {
			return cached as { userCount: number; statusCount: number; domainCount: number; activeUsers: number };
		}

		const [usersResult, statusesResult, domainsResult, activeResult] = await Promise.all([
			this.db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE domain IS NULL AND suspended_at IS NULL').first(),
			this.db.prepare('SELECT COUNT(*) AS count FROM statuses WHERE local = 1 AND deleted_at IS NULL').first(),
			this.db.prepare('SELECT COUNT(DISTINCT domain) AS count FROM accounts WHERE domain IS NOT NULL').first(),
			this.db
				.prepare(
					`SELECT COUNT(DISTINCT u.id) AS count FROM users u
					JOIN accounts a ON a.id = u.account_id
					WHERE u.current_sign_in_at > datetime('now', '-30 days')
					AND a.suspended_at IS NULL`,
				)
				.first(),
		]);

		const stats = {
			userCount: (usersResult?.count as number) || 0,
			statusCount: (statusesResult?.count as number) || 0,
			domainCount: (domainsResult?.count as number) || 0,
			activeUsers: (activeResult?.count as number) || 0,
		};

		// Cache for 1 hour
		await this.kv.put(cacheKey, JSON.stringify(stats), { expirationTtl: 3600 });

		return stats;
	}
}
