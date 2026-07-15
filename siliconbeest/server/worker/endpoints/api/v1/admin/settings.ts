import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';
import { requireScopeForMethod } from '../../../../middleware/scopeCheck';
import { getAllSettings, setSettings } from '../../../../services/instance';
import { CONTRIBUTION_EVENTS, contributionSettingKey } from '../../../../services/contribution';
import { updateInvitationSettings } from '../../../../services/invitationCredits';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);
app.use('*', requireScopeForMethod('admin:read', 'admin:write'));

/**
 * GET /api/v1/admin/settings — get all instance settings.
 */
app.get('/', async (c) => {
	const settings = await getAllSettings();
	return c.json(settings);
});

/**
 * PATCH /api/v1/admin/settings — update settings (key-value pairs).
 */
app.patch('/', async (c) => {
	const body = await c.req.json<Record<string, string>>();

	// accent_color drives the Deck UI for every visitor — reject anything
	// that is not a #rrggbb hex so a typo can't break the client-side parser.
	if (body.accent_color !== undefined && body.accent_color !== '' && !/^#[0-9a-fA-F]{6}$/.test(body.accent_color)) {
		return c.json({ error: 'accent_color must be a #rrggbb hex color' }, 422);
	}
	if (body.registration_mode !== undefined
		&& !['open', 'approval', 'referral', 'closed'].includes(body.registration_mode)) {
		return c.json({ error: 'registration_mode must be open, approval, referral, or closed' }, 422);
	}
	if (body.require_email_verification !== undefined
		&& body.require_email_verification !== '0'
		&& body.require_email_verification !== '1') {
		return c.json({ error: 'require_email_verification must be 0 or 1' }, 422);
	}
	for (const key of ['invite_link_issuance_enabled', 'invite_contribution_enabled']) {
		if (body[key] !== undefined && body[key] !== '0' && body[key] !== '1') {
			return c.json({ error: `${key} must be 0 or 1` }, 422);
		}
	}
	if (body.invite_credit_max_per_account !== undefined
		&& !isSafeSettingInteger(body.invite_credit_max_per_account, 0)) {
		return c.json({ error: 'invite_credit_max_per_account must be an integer between 0 and 1000000000' }, 422);
	}
	if (body.invite_contribution_threshold !== undefined
		&& !isSafeSettingInteger(body.invite_contribution_threshold, 1)) {
		return c.json({ error: 'invite_contribution_threshold must be an integer between 1 and 1000000000' }, 422);
	}
	for (const event of CONTRIBUTION_EVENTS) {
		const key = contributionSettingKey(event);
		if (body[key] !== undefined && !isSafeSettingInteger(body[key], -1_000_000_000)) {
			return c.json({ error: `${key} must be an integer between -1000000000 and 1000000000` }, 422);
		}
	}

	const invitationChanges = Object.fromEntries(Object.entries(body).filter(([key]) =>
		key === 'invite_credit_max_per_account'
		|| key === 'invite_link_issuance_enabled'
		|| key === 'invite_contribution_enabled'
		|| key === 'invite_contribution_threshold'
		|| key.startsWith('invite_contribution_points_'),
	));
	const generalChanges = Object.fromEntries(Object.entries(body).filter(([key]) =>
		!(key === 'invite_credit_max_per_account'
			|| key === 'invite_link_issuance_enabled'
			|| key === 'invite_contribution_enabled'
			|| key === 'invite_contribution_threshold'
			|| key.startsWith('invite_contribution_points_')),
	));
	await setSettings(generalChanges);
	const actor = c.get('currentAccount')!;
	await updateInvitationSettings(actor.id, invitationChanges);

	// Return the full settings after update
	const settings = await getAllSettings();
	return c.json(settings);
});

function isSafeSettingInteger(value: string, minimum: number): boolean {
	if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return false;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= 1_000_000_000;
}

/**
 * POST /api/v1/admin/settings/thumbnail — upload instance thumbnail
 */
app.post('/thumbnail', async (c) => {
	const formData = await c.req.formData();
	const file = formData.get('file') as File | null;
	if (!file) return c.json({ error: 'file is required' }, 422);

	const buffer = await file.arrayBuffer();
	await env.MEDIA_BUCKET.put('instance/thumbnail.png', buffer, {
		httpMetadata: { contentType: file.type || 'image/png' },
	});

	const domain = env.INSTANCE_DOMAIN;
	const url = `https://${domain}/thumbnail.png`;

	// Save both keys: site_logo_url is what the admin UI edits, while
	// thumbnail_url is kept for older deployments that may already read it.
	await setSettings({
		site_logo_url: url,
		thumbnail_url: url,
	});

	return c.json({ url });
});

/**
 * POST /api/v1/admin/settings/favicon — upload instance favicon
 */
app.post('/favicon', async (c) => {
	const formData = await c.req.formData();
	const file = formData.get('file') as File | null;
	if (!file) return c.json({ error: 'file is required' }, 422);

	const buffer = await file.arrayBuffer();
	// Store as both favicon.ico and the original format
	await env.MEDIA_BUCKET.put('instance/favicon.ico', buffer, {
		httpMetadata: { contentType: file.type || 'image/x-icon' },
	});

	const domain = env.INSTANCE_DOMAIN;
	const url = `https://${domain}/favicon.ico`;

	// Save both keys: site_favicon_url is what the admin UI edits, while
	// favicon_url is kept for older deployments that may already read it.
	await setSettings({
		site_favicon_url: url,
		favicon_url: url,
	});

	return c.json({ url });
});

export default app;
