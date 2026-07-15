import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../types';
import type { RegistrationDesign } from '../../types/db';
import { getInstanceTitle } from '../../services/instance';
import { t as emailT } from '../../services/emailTranslations';
import { createRegistrationCompletionTicket } from '../../services/registrationCompletion';
import { sanitizeLocale } from '../../utils/locales';
import {
	createAccessToken,
	getOrCreateInternalApp,
	updateSignInTracking,
} from '../../services/auth';
import {
	confirmRegistrationLink,
	revokeRegistrationSession,
	validateRegistrationLink,
} from '../../services/registration';
import { getInternalSessionOAuthScopes } from '../../../../../packages/shared/permissions';
import { setAuthTokenCookie } from '../../utils/authCookie';
import {
	clearRegistrationSessionCookie,
	getRegistrationSessionFromCookie,
} from '../../utils/registrationCookie';

type HonoEnv = { Variables: AppVariables };

interface EmailConfirmationData {
	userId: string;
	email: string;
	registration?: boolean;
	locale?: string;
	design?: RegistrationDesign;
}

const app = new Hono<HonoEnv>();

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function renderPage(title: string, body: string, locale = 'en'): string {
	return `<!DOCTYPE html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: #282c37; color: #d9e1e8; display: flex; align-items: center; justify-content: center;
         min-height: 100vh; }
  .card { background: #313543; border-radius: 8px; padding: 32px; width: 100%; max-width: 400px; text-align: center; }
  h1 { font-size: 20px; margin-bottom: 16px; color: #fff; }
  p { font-size: 14px; color: #9baec8; margin-bottom: 16px; line-height: 1.5; }
  .success { color: #79bd9a; }
  .error { color: #ff6b6b; }
  .btn { display: inline-block; border: 0; padding: 10px 24px; border-radius: 4px; font-size: 14px;
         font-weight: 600; text-decoration: none; background: #6364ff; color: #fff; margin-top: 8px;
         cursor: pointer; }
  .btn:hover { background: #5253e0; }
</style>
</head>
<body>
<div class="card">
${body}
</div>
</body>
</html>`;
}

app.get('/', async (c) => {
	const token = c.req.query('token');
	const domain = env.INSTANCE_DOMAIN;
	const title = await getInstanceTitle();
	const requestedLocale = sanitizeLocale(c.req.query('locale'));

	if (!token) {
		return c.html(renderPage(`Error - ${title}`,
			`<h1 class="error">Invalid Link</h1>
<p>${escapeHtml(emailT(requestedLocale, 'confirmation_missing_token'))}</p>`, requestedLocale), 400);
	}

	// Look up token in KV
	const data = await env.CACHE.get<EmailConfirmationData>('email_confirm:' + token, 'json');

	if (!data) {
		return c.html(renderPage(`Error - ${title}`,
			`<h1 class="error">${escapeHtml(emailT(requestedLocale, 'confirmation_invalid_title'))}</h1>
<p>${escapeHtml(emailT(requestedLocale, 'confirmation_invalid_body'))}</p>`, requestedLocale), 400);
	}

	if (data.registration) {
		const locale = data.locale ?? 'en';
		try {
			await validateRegistrationLink(data.userId, token);
			const pageTitle = emailT(locale, 'confirmation_page_title');
			const actionPath = new URL(c.req.url).pathname;
			return c.html(renderPage(`${pageTitle} - ${title}`,
				`<h1>${escapeHtml(pageTitle)}</h1>
<p>${escapeHtml(emailT(locale, 'confirmation_page_body'))}</p>
<form method="post" action="${escapeHtml(actionPath)}?token=${encodeURIComponent(token)}&amp;locale=${encodeURIComponent(locale)}">
<button class="btn" type="submit">${escapeHtml(emailT(locale, 'confirmation_page_action'))}</button>
</form>`, locale));
		} catch {
			return c.html(renderPage(`Error - ${title}`,
				`<h1 class="error">${escapeHtml(emailT(locale, 'confirmation_invalid_title'))}</h1>
<p>${escapeHtml(emailT(locale, 'confirmation_invalid_body'))}</p>`, locale), 400);
		}
	}

	// Legacy confirmation records did not carry a lifecycle marker. Migration
	// 0039 moved previously approved-but-unconfirmed users to
	// awaiting_confirmation and made them private, so claiming their original
	// token must activate them. Applicants that still need administrator review
	// remain pending even after their email address is verified.
	const now = new Date().toISOString();
	const results = await env.DB.batch([
		env.DB.prepare(
			`UPDATE users
			 SET confirmed_at = ?1,
			     confirmation_token = NULL,
			     approved = CASE
			       WHEN registration_state = 'awaiting_confirmation' THEN 1
			       ELSE approved
			     END,
			     registration_state = CASE
			       WHEN registration_state = 'awaiting_confirmation' THEN 'active'
			       ELSE registration_state
			     END,
			     updated_at = ?1
			 WHERE id = ?2
			   AND confirmation_token = ?3
			   AND confirmed_at IS NULL
			   AND registration_state IN ('awaiting_confirmation', 'pending_approval', 'active')`,
		).bind(now, data.userId, token),
			env.DB.prepare(
				`UPDATE accounts
				 SET discoverable = 1, updated_at = ?1
				 WHERE id = (SELECT account_id FROM users WHERE id = ?2)
				   AND changes() = 1
				   AND EXISTS (
			     SELECT 1 FROM users
			     WHERE id = ?2 AND registration_state = 'active' AND approved = 1
			   )`,
		).bind(now, data.userId),
	]);
	if ((results[0]?.meta.changes ?? 0) !== 1) {
		return c.html(renderPage(`Error - ${title}`,
			`<h1 class="error">${escapeHtml(emailT(requestedLocale, 'confirmation_invalid_title'))}</h1>
<p>${escapeHtml(emailT(requestedLocale, 'confirmation_invalid_body'))}</p>`, requestedLocale), 400);
	}

	// Delete the KV entry
	await env.CACHE.delete('email_confirm:' + token);

	return c.html(renderPage(`Email Confirmed - ${title}`,
		`<h1 class="success">Email Confirmed!</h1>
<p>Your email address <strong>${escapeHtml(data.email)}</strong> has been verified.</p>
<p>You can now sign in to your account.</p>
<a class="btn" href="https://${escapeHtml(domain)}">Go to ${escapeHtml(title)}</a>`));
});

app.post('/', async (c) => {
	const token = c.req.query('token');
	const domain = env.INSTANCE_DOMAIN;
	const title = await getInstanceTitle();
	const requestedLocale = sanitizeLocale(c.req.query('locale'));

	if (!token) {
		return c.html(renderPage(`Error - ${title}`,
			`<h1 class="error">Invalid Link</h1>
<p>${escapeHtml(emailT(requestedLocale, 'confirmation_missing_token'))}</p>`, requestedLocale), 400);
	}

	const data = await env.CACHE.get<EmailConfirmationData>('email_confirm:' + token, 'json');
	if (!data?.registration) {
		return c.html(renderPage(`Error - ${title}`,
			`<h1 class="error">${escapeHtml(emailT(requestedLocale, 'confirmation_invalid_title'))}</h1>
<p>${escapeHtml(emailT(requestedLocale, 'confirmation_invalid_body'))}</p>`, requestedLocale), 400);
	}

	const locale = data.locale ?? 'en';
	try {
		const activation = await confirmRegistrationLink(data.userId, token);
		const application = await getOrCreateInternalApp();
		const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
		const userAgent = c.req.header('User-Agent') || '';
		const { tokenValue } = await createAccessToken(application.id, activation.userId, {
			ip,
			userAgent,
			scopes: getInternalSessionOAuthScopes('user'),
		});
		await updateSignInTracking(activation.userId, ip);
		setAuthTokenCookie(c, tokenValue);
		const registrationToken = getRegistrationSessionFromCookie(c.req.header('Cookie'));
		if (registrationToken) await revokeRegistrationSession(registrationToken);
		clearRegistrationSessionCookie(c);

		const design = data.design ?? 'default';
		const ticket = await createRegistrationCompletionTicket({
			userId: activation.userId,
			redirectUri: activation.redirectUri,
			design,
		});
		const prefix = design === 'old' ? '/old' : design === 'aurora' ? '/aurora' : '';
		return c.redirect(
			`https://${domain}${prefix}/auth/registration?ticket=${encodeURIComponent(ticket)}`,
			302,
		);
	} catch {
		return c.html(renderPage(`Error - ${title}`,
			`<h1 class="error">${escapeHtml(emailT(locale, 'confirmation_invalid_title'))}</h1>
<p>${escapeHtml(emailT(locale, 'confirmation_invalid_body'))}</p>`, locale), 400);
	}
});

export default app;
