/**
 * Email Service
 *
 * All email sending goes through the QUEUE_EMAIL queue.
 * Uses `env` from cloudflare:workers — no env parameter passing.
 */

import { env } from 'cloudflare:workers';
import type { SendEmailMessage } from '../types/queue';
import type { RegistrationDesign } from '../types/db';
import { getEmailTranslations, t as emailT } from './emailTranslations';
import { getInstanceTitle } from './instance';

/**
 * HTML-escape a string to prevent injection in email templates.
 */
function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function registrationDesignPrefix(design: RegistrationDesign): string {
	if (design === 'old') return '/old';
	if (design === 'aurora') return '/aurora';
	return '';
}

/**
 * Enqueue an email for delivery via the email-sender worker.
 * Exported for admin use cases (custom subject/body).
 */
export async function sendCustomEmail(
	to: string,
	subject: string,
	html: string,
	text?: string,
): Promise<boolean> {
	return sendEmail(to, subject, html, text);
}

/**
 * Enqueue an email for delivery via the email-sender worker.
 */
async function sendEmail(
	to: string,
	subject: string,
	html: string,
	text?: string,
): Promise<boolean> {
	try {
		await env.QUEUE_EMAIL.send({ type: 'send_email', to, subject, html, text });
		return true;
	} catch (error) {
		console.error('[email] Failed to enqueue message', error);
		return false;
	}
}

/**
 * Send a password reset link.
 */
export async function sendPasswordReset(
	email: string,
	token: string,
	locale = 'en',
): Promise<boolean> {
	const domain = env.INSTANCE_DOMAIN;
	const title = await getInstanceTitle();
	const resetUrl = `https://${domain}/auth/reset-password?token=${token}`;
	const t = getEmailTranslations(locale);
	const html = `<h1>${escapeHtml(t.passwordReset.heading)}</h1>
<p>${escapeHtml(t.passwordReset.body)}</p>
<p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>
<p>${escapeHtml(t.passwordReset.expiry)}</p>`;
	return sendEmail(email, t.passwordReset.subject, html);
}

/**
 * Send an email confirmation link after registration.
 */
export async function sendConfirmation(
	email: string,
	token: string,
	locale = 'en',
	code?: string,
	design: RegistrationDesign = 'default',
): Promise<boolean> {
	const domain = env.INSTANCE_DOMAIN;
	const title = await getInstanceTitle();
	const query = new URLSearchParams({ token, locale });
	const confirmUrl = `https://${domain}${registrationDesignPrefix(design)}/auth/confirm?${query.toString()}`;
	const t = getEmailTranslations(locale);
	const html = `<h1>${escapeHtml(t.confirmation.heading(title))}</h1>
<p>${escapeHtml(t.confirmation.body)}</p>
${code ? `<p>${escapeHtml(t.confirmation.codeHelp)}</p>
<p style="font-size:24px;font-weight:700;letter-spacing:0.2em;">${escapeHtml(t.confirmation.code(code))}</p>` : ''}
<p><a href="${escapeHtml(confirmUrl)}">${escapeHtml(confirmUrl)}</a></p>
<p>${escapeHtml(t.confirmation.expiry)}</p>`;
	return sendEmail(email, t.confirmation.subject(title), html);
}

/**
 * Tell an approved applicant that they may sign in and finish registration.
 * Account activation and the welcome email happen only after that final step.
 */
export async function sendRegistrationReady(
	email: string,
	locale = 'en',
	design: RegistrationDesign = 'default',
): Promise<boolean> {
	const domain = env.INSTANCE_DOMAIN;
	const title = await getInstanceTitle();
	const prefix = registrationDesignPrefix(design);
	const loginUrl = `https://${domain}${prefix}/login?redirect=${encodeURIComponent(`${prefix}/auth/registration`)}`;
	const t = getEmailTranslations(locale);
	const html = `<h1>${escapeHtml(t.registrationReady.heading)}</h1>
<p>${escapeHtml(t.registrationReady.body)}</p>
<p><a href="${escapeHtml(loginUrl)}">${escapeHtml(t.registrationReady.action)}</a></p>`;
	return sendEmail(email, t.registrationReady.subject(title), html);
}

/**
 * Send a welcome email after account approval.
 */
export async function sendWelcome(
	email: string,
	username: string,
	locale = 'en',
): Promise<boolean> {
	const domain = env.INSTANCE_DOMAIN;
	const title = await getInstanceTitle();
	const t = getEmailTranslations(locale);
	const html = `<h1>${escapeHtml(t.welcome.heading(title))}</h1>
<p>${escapeHtml(t.welcome.body)}</p>
<p><strong>@${escapeHtml(username)}@${escapeHtml(domain)}</strong></p>
<p><a href="https://${escapeHtml(domain)}">https://${escapeHtml(domain)}</a></p>`;
	return sendEmail(email, t.welcome.subject(title), html);
}

/**
 * Send a rejection notification email.
 */
export async function sendRejection(
	email: string,
	locale = 'en',
): Promise<boolean> {
	const title = await getInstanceTitle();
	const t = getEmailTranslations(locale);
	const html = `<h1>${escapeHtml(t.rejection.heading)}</h1>
<p>${escapeHtml(t.rejection.body(title))}</p>`;
	return sendEmail(email, t.rejection.subject, html);
}

/**
 * Send an account warning / moderation notice email.
 */
export async function sendAccountWarning(
	email: string,
	action: string,
	text: string,
	locale = 'en',
): Promise<boolean> {
	const title = await getInstanceTitle();
	const t = getEmailTranslations(locale);

	const labels = t.accountWarning[action] || t.accountWarning.warn;

	const html = `<h1>${escapeHtml(labels.heading)}</h1>
<p>${escapeHtml(labels.description)}</p>
${text ? `<h3>${escapeHtml(t.reasonLabel)}</h3><p>${escapeHtml(text)}</p>` : ''}
<hr />
<p style="color:#888;font-size:12px;">${escapeHtml(title)}</p>`;

	return sendEmail(email, `[${title}] ${labels.subject}`, html);
}

// ---------------------------------------------------------------------------
// Password changed notification email
// ---------------------------------------------------------------------------

export async function sendPasswordChanged(
	email: string,
	locale = 'en',
): Promise<boolean> {
	const title = await getInstanceTitle();
	const time = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
	const html = `<h2>${escapeHtml(emailT(locale, 'password_changed_heading'))}</h2>
<p>${escapeHtml(emailT(locale, 'password_changed_body'))} (${escapeHtml(time)})</p>
<p>${escapeHtml(emailT(locale, 'password_changed_sessions'))}</p>
<p>${escapeHtml(emailT(locale, 'password_changed_warning'))}</p>`;
	return sendEmail(email, emailT(locale, 'password_changed_subject', { title }), html);
}

// ---------------------------------------------------------------------------
// Username reminder email
// ---------------------------------------------------------------------------

export async function sendUsernameReminder(
	email: string,
	username: string,
	locale = 'en',
): Promise<boolean> {
	const title = await getInstanceTitle();
	const domain = env.INSTANCE_DOMAIN;
	const loginUrl = `https://${domain}/login`;
	const html = `<h2>${escapeHtml(emailT(locale, 'username_reminder_heading'))}</h2>
<p>${escapeHtml(emailT(locale, 'username_reminder_body'))}</p>
<p>${escapeHtml(emailT(locale, 'username_reminder_your_username'))}: <strong>@${escapeHtml(username)}</strong></p>
<p>${escapeHtml(emailT(locale, 'username_reminder_your_handle'))}: <strong>@${escapeHtml(username)}@${escapeHtml(domain)}</strong></p>
<p><a href="${escapeHtml(loginUrl)}">Log in &rarr;</a></p>
<p>${escapeHtml(emailT(locale, 'username_reminder_ignore'))}</p>`;
	return sendEmail(email, emailT(locale, 'username_reminder_subject', { title }), html);
}

// ---------------------------------------------------------------------------
// Login notification email
// ---------------------------------------------------------------------------

export async function sendLoginNotification(
	email: string,
	ip: string,
	userAgent: string,
	locale = 'en',
): Promise<boolean> {
	const title = await getInstanceTitle();
	const time = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
	const html = `<h2>${escapeHtml(emailT(locale, 'login_notification_heading'))}</h2>
<p>${escapeHtml(emailT(locale, 'login_notification_body'))}</p>
<ul>
  <li><strong>${escapeHtml(emailT(locale, 'login_notification_time'))}:</strong> ${escapeHtml(time)}</li>
  <li><strong>${escapeHtml(emailT(locale, 'login_notification_ip'))}:</strong> ${escapeHtml(ip || 'Unknown')}</li>
  <li><strong>${escapeHtml(emailT(locale, 'login_notification_device'))}:</strong> ${escapeHtml(userAgent || 'Unknown')}</li>
</ul>
<p>${escapeHtml(emailT(locale, 'login_notification_warning'))}</p>`;
	return sendEmail(email, emailT(locale, 'login_notification_subject', { title }), html);
}

// ---------------------------------------------------------------------------
// Admin notification emails
// ---------------------------------------------------------------------------

async function getAdminEmails(): Promise<{ email: string; locale: string }[]> {
	const { results } = await env.DB_META_C000.prepare(
		"SELECT u.email, u.locale FROM users u WHERE u.role IN ('admin', 'owner') AND u.disabled = 0 AND u.email IS NOT NULL",
	).all<{ email: string; locale: string }>();
	return (results ?? []).filter((r) => r.email);
}

/**
 * Notify admins when a new user registers and is pending approval.
 */
export async function notifyAdminsPendingUser(
	username: string,
	email: string,
	reason?: string | null,
): Promise<void> {
	const admins = await getAdminEmails();
	if (admins.length === 0) return;

	const domain = env.INSTANCE_DOMAIN;
	const title = await getInstanceTitle();
	const adminUrl = `https://${domain}/admin/accounts`;

	await Promise.all(admins.map(async (admin) => {
		const locale = admin.locale || 'en';
		const subject = `[${title}] ${emailT(locale, 'admin_pending_subject', { username })}`;
		const html = `<h2>${escapeHtml(emailT(locale, 'admin_pending_heading'))}</h2>
<p>${escapeHtml(emailT(locale, 'admin_pending_body'))}</p>
<ul>
  <li><strong>${escapeHtml(emailT(locale, 'admin_pending_username'))}:</strong> @${escapeHtml(username)}@${escapeHtml(domain)}</li>
  <li><strong>${escapeHtml(emailT(locale, 'admin_pending_email'))}:</strong> ${escapeHtml(email)}</li>
  ${reason ? `<li><strong>${escapeHtml(emailT(locale, 'admin_pending_reason'))}:</strong> ${escapeHtml(reason)}</li>` : ''}
</ul>
<p><a href="${escapeHtml(adminUrl)}">${escapeHtml(emailT(locale, 'admin_pending_review'))} &rarr;</a></p>`;

		try {
			await sendEmail(admin.email, subject, html);
		} catch { /* ignore */ }
	}));
}

/**
 * Notify admins when a new report is submitted.
 */
export async function notifyAdminsNewReport(
	reporterAcct: string,
	targetAcct: string,
	comment: string,
	category: string,
): Promise<void> {
	const admins = await getAdminEmails();
	if (admins.length === 0) return;

	const domain = env.INSTANCE_DOMAIN;
	const title = await getInstanceTitle();
	const adminUrl = `https://${domain}/admin/reports`;

	await Promise.all(admins.map(async (admin) => {
		const locale = admin.locale || 'en';
		const subject = `[${title}] ${emailT(locale, 'admin_report_subject', { target: targetAcct })}`;
		const html = `<h2>${escapeHtml(emailT(locale, 'admin_report_heading'))}</h2>
<p>${escapeHtml(emailT(locale, 'admin_report_body'))}</p>
<ul>
  <li><strong>${escapeHtml(emailT(locale, 'admin_report_reporter'))}:</strong> @${escapeHtml(reporterAcct)}</li>
  <li><strong>${escapeHtml(emailT(locale, 'admin_report_target'))}:</strong> @${escapeHtml(targetAcct)}</li>
  <li><strong>${escapeHtml(emailT(locale, 'admin_report_category'))}:</strong> ${escapeHtml(category || 'other')}</li>
  ${comment ? `<li><strong>${escapeHtml(emailT(locale, 'admin_report_comment'))}:</strong> ${escapeHtml(comment)}</li>` : ''}
</ul>
<p><a href="${escapeHtml(adminUrl)}">${escapeHtml(emailT(locale, 'admin_report_review'))} &rarr;</a></p>`;

		try {
			await sendEmail(admin.email, subject, html);
		} catch { /* ignore */ }
	}));
}
