/**
 * Server-side email translations for multilingual email delivery.
 *
 * Translation strings are stored in JSON files under server/worker/i18n/email/.
 * Each file uses {placeholder} syntax for variable interpolation.
 * Falls back to English for unsupported locales.
 */

import en from '../i18n/email/en.json';
import ko from '../i18n/email/ko.json';
import ja from '../i18n/email/ja.json';
import zhCN from '../i18n/email/zh-CN.json';
import zhTW from '../i18n/email/zh-TW.json';

type EmailMessages = Record<string, string>;

const locales: Record<string, EmailMessages> = {
	en,
	ko,
	ja,
	'zh-CN': zhCN,
	'zh-TW': zhTW,
};

/**
 * Replace `{key}` placeholders in a string with provided values.
 */
function interpolate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

/**
 * Get a translated email string for the given locale and key.
 * Falls back to English if the locale or key is missing.
 */
function t(locale: string, key: string, vars?: Record<string, string>): string {
	const messages = locales[locale] || locales.en;
	const raw = messages[key] ?? locales.en[key] ?? key;
	return vars ? interpolate(raw, vars) : raw;
}

// ---- Public API (backwards-compatible with email.ts callers) ----

export interface AccountWarningStrings {
	subject: string;
	heading: string;
	description: string;
}

export interface EmailStrings {
	confirmation: {
		subject: (title: string) => string;
		heading: (title: string) => string;
		body: string;
		expiry: string;
	};
	passwordReset: {
		subject: string;
		heading: string;
		body: string;
		expiry: string;
	};
	welcome: {
		subject: (title: string) => string;
		heading: (title: string) => string;
		body: string;
	};
	rejection: {
		subject: string;
		heading: string;
		body: (title: string) => string;
	};
	accountWarning: Record<string, AccountWarningStrings>;
	reasonLabel: string;
}

const WARNING_ACTIONS = [
	'warn', 'disable', 'silence', 'suspend', 'sensitive', 'none',
	'unsuspend', 'unsilence', 'enable', 'unsensitize',
];

/**
 * Build an EmailStrings object for a given locale from the JSON data.
 * The returned object has the same shape as before so email.ts callers
 * need no changes.
 */
function buildEmailStrings(locale: string): EmailStrings {
	const warningMap: Record<string, AccountWarningStrings> = {};
	for (const action of WARNING_ACTIONS) {
		warningMap[action] = {
			subject: t(locale, `warning_${action}_subject`),
			heading: t(locale, `warning_${action}_heading`),
			description: t(locale, `warning_${action}_description`),
		};
	}

	return {
		confirmation: {
			subject: (title) => t(locale, 'confirmation_subject', { title }),
			heading: (title) => t(locale, 'confirmation_heading', { title }),
			body: t(locale, 'confirmation_body'),
			expiry: t(locale, 'confirmation_expiry'),
		},
		passwordReset: {
			subject: t(locale, 'password_reset_subject'),
			heading: t(locale, 'password_reset_heading'),
			body: t(locale, 'password_reset_body'),
			expiry: t(locale, 'password_reset_expiry'),
		},
		welcome: {
			subject: (title) => t(locale, 'welcome_subject', { title }),
			heading: (title) => t(locale, 'welcome_heading', { title }),
			body: t(locale, 'welcome_body'),
		},
		rejection: {
			subject: t(locale, 'rejection_subject'),
			heading: t(locale, 'rejection_heading'),
			body: (title) => t(locale, 'rejection_body', { title }),
		},
		accountWarning: warningMap,
		reasonLabel: t(locale, 'reason_label'),
	};
}

// Cache built objects to avoid re-building on every call
const cache = new Map<string, EmailStrings>();

/**
 * Get email translations for a given locale. Falls back to English
 * if the locale is not available.
 */
export function getEmailTranslations(locale: string | unknown): EmailStrings {
	const key = typeof locale === 'string' && locale in locales ? locale : 'en';
	let cached = cache.get(key);
	if (!cached) {
		cached = buildEmailStrings(key);
		cache.set(key, cached);
	}
	return cached;
}
