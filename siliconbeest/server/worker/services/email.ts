import type { SendEmailMessage } from '../types/queue';

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
	} catch (err) {
		console.error('[email] Failed to enqueue email:', err);
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
): Promise<boolean> {
	const domain = env.INSTANCE_DOMAIN;
	const resetUrl = `https://${domain}/auth/reset-password?token=${token}`;
	const html = `<h1>Password Reset</h1>
<p>Click the link below to reset your password:</p>
<p><a href="${resetUrl}">${resetUrl}</a></p>
<p>This link expires in 1 hour.</p>`;
	return sendEmail(env, email, 'Reset your password', html);
}

/**
 * Send an email confirmation link after registration.
 */
export async function sendConfirmation(
	env: { QUEUE_EMAIL: Queue<SendEmailMessage>; INSTANCE_DOMAIN: string; INSTANCE_TITLE?: string },
	email: string,
	token: string,
): Promise<boolean> {
	const domain = env.INSTANCE_DOMAIN;
	const title = env.INSTANCE_TITLE || 'SiliconBeest';
	const confirmUrl = `https://${domain}/auth/confirm?token=${token}`;
	const html = `<h1>Confirm your email - ${title}</h1>
<p>Click the link below to confirm your email address:</p>
<p><a href="${confirmUrl}">${confirmUrl}</a></p>
<p>This link expires in 24 hours.</p>`;
	return sendEmail(env, email, `Confirm your email - ${title}`, html);
}

/**
 * Send a welcome email after account approval.
 */
export async function sendWelcome(
	env: { QUEUE_EMAIL: Queue<SendEmailMessage>; INSTANCE_DOMAIN: string; INSTANCE_TITLE?: string },
	email: string,
	username: string,
): Promise<boolean> {
	const domain = env.INSTANCE_DOMAIN;
	const title = env.INSTANCE_TITLE || 'SiliconBeest';
	const html = `<h1>Welcome to ${title}!</h1>
<p>Your account <strong>@${username}@${domain}</strong> has been approved.</p>
<p>Log in at <a href="https://${domain}">https://${domain}</a></p>`;
	return sendEmail(env, email, `Welcome to ${title}`, html);
}

/**
 * Send a rejection notification email.
 */
export async function sendRejection(
	env: { QUEUE_EMAIL: Queue<SendEmailMessage>; INSTANCE_TITLE?: string },
	email: string,
): Promise<boolean> {
	const title = env.INSTANCE_TITLE || 'SiliconBeest';
	const html = `<h1>Registration Update</h1>
<p>Your registration at ${title} was not approved at this time.</p>`;
	return sendEmail(env, email, 'Registration update', html);
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
): Promise<boolean> {
	const title = env.INSTANCE_TITLE || 'SiliconBeest';

	const actionLabels: Record<string, { subject: string; heading: string; description: string }> = {
		warn: {
			subject: `[${title}] 계정 경고`,
			heading: '계정 경고',
			description: '관리자가 회원님의 계정에 경고를 보냈습니다.',
		},
		disable: {
			subject: `[${title}] 계정 동결`,
			heading: '계정 동결',
			description: '관리자가 회원님의 계정을 동결했습니다. 로그인이 제한됩니다.',
		},
		silence: {
			subject: `[${title}] 계정 제한`,
			heading: '계정 제한',
			description: '관리자가 회원님의 계정을 제한했습니다. 게시물이 팔로워에게만 표시됩니다.',
		},
		suspend: {
			subject: `[${title}] 계정 정지`,
			heading: '계정 정지',
			description: '관리자가 회원님의 계정을 정지했습니다. 더 이상 이 계정을 사용할 수 없습니다.',
		},
		sensitive: {
			subject: `[${title}] 미디어 민감 표시`,
			heading: '미디어 민감 표시',
			description: '관리자가 회원님의 미디어를 민감한 콘텐츠로 표시했습니다.',
		},
		none: {
			subject: `[${title}] 계정 경고`,
			heading: '계정 경고',
			description: '관리자가 회원님의 계정에 경고를 보냈습니다.',
		},
	};

	const labels = actionLabels[action] || actionLabels.warn;

	const html = `<h1>${labels.heading}</h1>
<p>${labels.description}</p>
${text ? `<h3>사유</h3><p>${text}</p>` : ''}
<hr />
<p style="color:#888;font-size:12px;">${title}</p>`;

	return sendEmail(env, email, labels.subject, html);
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
  <li><strong>Username:</strong> @${username}@${domain}</li>
  <li><strong>Email:</strong> ${email}</li>
</ul>
<p><a href="${adminUrl}">Review pending accounts →</a></p>`;

	for (const adminEmail of adminEmails) {
		try {
			await sendEmail(env, adminEmail, subject, html);
		} catch {
			// Don't fail registration if admin notification fails
		}
	}
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
  <li><strong>Reporter:</strong> @${reporterAcct}</li>
  <li><strong>Target:</strong> @${targetAcct}</li>
  <li><strong>Category:</strong> ${category || 'other'}</li>
  ${comment ? `<li><strong>Comment:</strong> ${comment}</li>` : ''}
</ul>
<p><a href="${adminUrl}">Review reports →</a></p>`;

	for (const adminEmail of adminEmails) {
		try {
			await sendEmail(env, adminEmail, subject, html);
		} catch {
			// Don't fail report submission if admin notification fails
		}
	}
}
