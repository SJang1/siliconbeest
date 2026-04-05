import type { SendEmailMessage } from '../types/queue';
import { getEmailTranslations } from './emailTranslations';

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

/**
 * Enqueue an email for delivery via the email-sender worker.
 *
 * All email sending is now done asynchronously through the QUEUE_EMAIL queue.
 * The siliconbeest-email-sender worker consumes these messages and handles
 * SMTP delivery.
 */
export async function sendEmail(
	env: { QUEUE_EMAIL: Queue<SendEmailMessage> },
	to: string,
	subject: string,
	html: string,
	text?: string,
): Promise<boolean> {
	// oxlint-disable-next-line fp/no-try-statements
	try {
		await env.QUEUE_EMAIL.send({
			type: 'send_email',
			to,
			subject,
			html,
			text,
		});
		console.log(`[email] Enqueued email to ${to}: ${subject}`);
		return true;
	} catch (_err) {
		console.error('[email] Failed to enqueue email:', _err);
		return false;
	}
}

/**
 * Send a password reset email with a tokenised link.
 */
export async function sendPasswordReset(
	env: { QUEUE_EMAIL: Queue<SendEmailMessage>; INSTANCE_DOMAIN: string },
	email: string,
	token: string,
	locale = 'en',
): Promise<boolean> {
	const domain = env.INSTANCE_DOMAIN;
	const resetUrl = `https://${domain}/auth/reset-password?token=${token}`;
	const t = getEmailTranslations(locale);
	const html = `<h1>${escapeHtml(t.passwordReset.heading)}</h1>
<p>${escapeHtml(t.passwordReset.body)}</p>
<p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>
<p>${escapeHtml(t.passwordReset.expiry)}</p>`;
	return sendEmail(env, email, t.passwordReset.subject, html);
}

/**
 * Send an email confirmation link after registration.
 */
export async function sendConfirmation(
	env: { QUEUE_EMAIL: Queue<SendEmailMessage>; INSTANCE_DOMAIN: string; INSTANCE_TITLE?: string },
	email: string,
	token: string,
	locale = 'en',
): Promise<boolean> {
	const domain = env.INSTANCE_DOMAIN;
	const title = env.INSTANCE_TITLE || 'SiliconBeest';
	const confirmUrl = `https://${domain}/auth/confirm?token=${token}`;
	const t = getEmailTranslations(locale);
	const html = `<h1>${escapeHtml(t.confirmation.heading(title))}</h1>
<p>${escapeHtml(t.confirmation.body)}</p>
<p><a href="${escapeHtml(confirmUrl)}">${escapeHtml(confirmUrl)}</a></p>
<p>${escapeHtml(t.confirmation.expiry)}</p>`;
	return sendEmail(env, email, t.confirmation.subject(title), html);
}

/**
 * Send a welcome email after account approval.
 */
export async function sendWelcome(
	env: { QUEUE_EMAIL: Queue<SendEmailMessage>; INSTANCE_DOMAIN: string; INSTANCE_TITLE?: string },
	email: string,
	username: string,
	locale = 'en',
): Promise<boolean> {
	const domain = env.INSTANCE_DOMAIN;
	const title = env.INSTANCE_TITLE || 'SiliconBeest';
	const t = getEmailTranslations(locale);
	const html = `<h1>${escapeHtml(t.welcome.heading(title))}</h1>
<p>${escapeHtml(t.welcome.body)}</p>
<p><strong>@${escapeHtml(username)}@${escapeHtml(domain)}</strong></p>
<p><a href="https://${escapeHtml(domain)}">https://${escapeHtml(domain)}</a></p>`;
	return sendEmail(env, email, t.welcome.subject(title), html);
}

/**
 * Send a rejection notification email.
 */
export async function sendRejection(
	env: { QUEUE_EMAIL: Queue<SendEmailMessage>; INSTANCE_TITLE?: string },
	email: string,
	locale = 'en',
): Promise<boolean> {
	const title = env.INSTANCE_TITLE || 'SiliconBeest';
	const t = getEmailTranslations(locale);
	const html = `<h1>${escapeHtml(t.rejection.heading)}</h1>
<p>${escapeHtml(t.rejection.body(title))}</p>`;
	return sendEmail(env, email, t.rejection.subject, html);
}

/**
 * Send an account warning / moderation notice email.
 *
 * Generates a localised subject and body per action type with the
 * admin's reason text and the instance name.
 */
export async function sendAccountWarning(
	env: { QUEUE_EMAIL: Queue<SendEmailMessage>; INSTANCE_TITLE?: string },
	email: string,
	action: string,
	text: string,
	locale = 'en',
): Promise<boolean> {
	const title = env.INSTANCE_TITLE || 'SiliconBeest';
	const t = getEmailTranslations(locale);

	const labels = t.accountWarning[action] || t.accountWarning.warn;

	const html = `<h1>${escapeHtml(labels.heading)}</h1>
<p>${escapeHtml(labels.description)}</p>
${text ? `<h3>${escapeHtml(t.reasonLabel)}</h3><p>${escapeHtml(text)}</p>` : ''}
<hr />
<p style="color:#888;font-size:12px;">${escapeHtml(title)}</p>`;

	return sendEmail(env, email, `[${title}] ${labels.subject}`, html);
}

// ---------------------------------------------------------------------------
// Admin notification emails
// ---------------------------------------------------------------------------

/**
 * Get all admin email addresses from the database.
 */
async function getAdminEmails(db: D1Database): Promise<string[]> {
	const { results } = await db.prepare(
		"SELECT u.email FROM users u WHERE u.role IN ('admin', 'owner') AND u.disabled = 0 AND u.email IS NOT NULL",
	).all<{ email: string }>();
	return (results ?? []).map((r) => r.email).filter(Boolean);
}

/**
 * Notify admins when a new user registers and is pending approval.
 */
export async function notifyAdminsPendingUser(
	env: { QUEUE_EMAIL: Queue<SendEmailMessage>; INSTANCE_DOMAIN: string; INSTANCE_TITLE?: string; DB: D1Database },
	username: string,
	email: string,
	reason?: string | null,
): Promise<void> {
	const adminEmails = await getAdminEmails(env.DB);
	if (adminEmails.length === 0) return;

	const domain = env.INSTANCE_DOMAIN;
	const title = env.INSTANCE_TITLE || 'SiliconBeest';
	const adminUrl = `https://${domain}/admin/accounts`;
	const subject = `[${title}] New user pending approval: @${username}`;
	const html = `<h2>New Registration Pending Approval</h2>
<p>A new user has registered and is waiting for approval:</p>
<ul>
  <li><strong>Username:</strong> @${escapeHtml(username)}@${escapeHtml(domain)}</li>
  <li><strong>Email:</strong> ${escapeHtml(email)}</li>
  ${reason ? `<li><strong>Reason:</strong> ${escapeHtml(reason)}</li>` : ''}
</ul>
<p><a href="${escapeHtml(adminUrl)}">Review pending accounts &rarr;</a></p>`;

	await Promise.all(adminEmails.map(async (adminEmail) => {
		// oxlint-disable-next-line fp/no-try-statements
		try {
			await sendEmail(env, adminEmail, subject, html);
		} catch {
			// Don't fail registration if admin notification fails
		}
	}));
}

/**
 * Notify admins when a new report is submitted.
 */
export async function notifyAdminsNewReport(
	env: { QUEUE_EMAIL: Queue<SendEmailMessage>; INSTANCE_DOMAIN: string; INSTANCE_TITLE?: string; DB: D1Database },
	reporterAcct: string,
	targetAcct: string,
	comment: string,
	category: string,
): Promise<void> {
	const adminEmails = await getAdminEmails(env.DB);
	if (adminEmails.length === 0) return;

	const domain = env.INSTANCE_DOMAIN;
	const title = env.INSTANCE_TITLE || 'SiliconBeest';
	const adminUrl = `https://${domain}/admin/reports`;
	const subject = `[${title}] New report: @${targetAcct}`;
	const html = `<h2>New Report Submitted</h2>
<p>A new report has been filed:</p>
<ul>
  <li><strong>Reporter:</strong> @${escapeHtml(reporterAcct)}</li>
  <li><strong>Target:</strong> @${escapeHtml(targetAcct)}</li>
  <li><strong>Category:</strong> ${escapeHtml(category || 'other')}</li>
  ${comment ? `<li><strong>Comment:</strong> ${escapeHtml(comment)}</li>` : ''}
</ul>
<p><a href="${escapeHtml(adminUrl)}">Review reports &rarr;</a></p>`;

	await Promise.all(adminEmails.map(async (adminEmail) => {
		// oxlint-disable-next-line fp/no-try-statements
		try {
			await sendEmail(env, adminEmail, subject, html);
		} catch {
			// Don't fail report submission if admin notification fails
		}
	}));
}
