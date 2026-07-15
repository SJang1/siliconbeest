import type { Context } from 'hono';

export const AUTH_TOKEN_COOKIE = 'siliconbeest_token';
const AUTH_TOKEN_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
	if (!cookieHeader) return null;

	for (const part of cookieHeader.split(';')) {
		const [rawKey, ...rawValue] = part.trim().split('=');
		if (rawKey !== name) continue;
		return decodeURIComponent(rawValue.join('='));
	}

	return null;
}

export function getAuthTokenFromCookie(cookieHeader: string | undefined): string | null {
	return getCookieValue(cookieHeader, AUTH_TOKEN_COOKIE);
}

export function setAuthTokenCookie(c: Context, token: string): void {
	const secure = new URL(c.req.url).protocol === 'https:';
	const parts = [
		`${AUTH_TOKEN_COOKIE}=${encodeURIComponent(token)}`,
		'Path=/',
		`Max-Age=${AUTH_TOKEN_COOKIE_MAX_AGE}`,
		'SameSite=Lax',
	];

	if (secure) {
		parts.push('Secure');
	}

	c.header('Set-Cookie', parts.join('; '), { append: true });
}

export function clearAuthTokenCookie(c: Context): void {
	const secure = new URL(c.req.url).protocol === 'https:';
	const parts = [
		`${AUTH_TOKEN_COOKIE}=`,
		'Path=/',
		'Max-Age=0',
		'SameSite=Lax',
	];

	if (secure) {
		parts.push('Secure');
	}

	c.header('Set-Cookie', parts.join('; '), { append: true });
}
