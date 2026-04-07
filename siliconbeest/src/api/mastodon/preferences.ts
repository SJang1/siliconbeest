import { apiFetch } from '../client';

export interface Preferences {
	'posting:default:visibility': string;
	'posting:default:sensitive': boolean;
	'posting:default:language': string | null;
	'reading:expand:media': string;
	'reading:expand:spoilers': boolean;
	'ui:columns': string | null;
	'ui:show_trending': string | null;
}

export function getPreferences(token: string) {
	return apiFetch<Preferences>('/v1/preferences', { token });
}

export function updatePreferences(token: string, prefs: Record<string, string>) {
	return apiFetch<Record<string, never>>('/v1/preferences', {
		token,
		method: 'PATCH',
		body: prefs,
	});
}
