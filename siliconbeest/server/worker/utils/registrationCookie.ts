import type { Context } from 'hono';
import { getCookieValue } from './authCookie';

export const REGISTRATION_SESSION_COOKIE = 'siliconbeest_registration';
const REGISTRATION_SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export function getRegistrationSessionFromCookie(cookieHeader: string | undefined): string | null {
	return getCookieValue(cookieHeader, REGISTRATION_SESSION_COOKIE);
}

export function setRegistrationSessionCookie(c: Context, token: string): void {
	const secure = new URL(c.req.url).protocol === 'https:';
	const parts = [
		`${REGISTRATION_SESSION_COOKIE}=${encodeURIComponent(token)}`,
		'Path=/',
		`Max-Age=${REGISTRATION_SESSION_COOKIE_MAX_AGE}`,
		'HttpOnly',
		'SameSite=Lax',
	];

	if (secure) parts.push('Secure');
	c.header('Set-Cookie', parts.join('; '), { append: true });
}

export function clearRegistrationSessionCookie(c: Context): void {
	const secure = new URL(c.req.url).protocol === 'https:';
	const parts = [
		`${REGISTRATION_SESSION_COOKIE}=`,
		'Path=/',
		'Max-Age=0',
		'HttpOnly',
		'SameSite=Lax',
	];

	if (secure) parts.push('Secure');
	c.header('Set-Cookie', parts.join('; '), { append: true });
}
