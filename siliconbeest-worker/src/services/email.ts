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
 */
export async function sendAccountWarning(
	env: { QUEUE_EMAIL: Queue<SendEmailMessage> },
	email: string,
	action: string,
	text: string,
): Promise<boolean> {
	const html = `<h1>Account Notice</h1>
<p>An action was taken on your account: <strong>${action}</strong></p>
${text ? `<p>${text}</p>` : ''}`;
	return sendEmail(env, email, 'Account notice', html);
}
