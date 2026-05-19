import { createI18n } from 'vue-i18n';
import type { Ref } from 'vue';
import en from './locales/en.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';

/** All locales available for post language tagging (server-side default language). */
export const ALL_LOCALES = [
  { code: 'en', name: 'English' },
  { code: 'ko', name: '한국어' },
  { code: 'ja', name: '日本語' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'ru', name: 'Русский' },
  { code: 'ar', name: 'العربية', rtl: true },
  { code: 'id', name: 'Bahasa Indonesia' },
] as const;

/** Locales with full UI translations (display language selector). */
export const SUPPORTED_LOCALES = [
  { code: 'en', name: 'English' },
  { code: 'ko', name: '한국어' },
  { code: 'ja', name: '日本語' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
] as const;

const SUPPORTED_CODES = SUPPORTED_LOCALES.map((l) => l.code) as readonly string[];

export const DISPLAY_LOCALE_KEY = 'siliconbeest_display_locale';

const UI_MESSAGES = {
  en,
  ko,
  ja,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

export function normalizeSupportedLocale(locale: string | null | undefined): string | null {
  if (!locale) return null;
  if (SUPPORTED_CODES.includes(locale)) return locale;

  const prefix = locale.split('-')[0];
  if (!prefix) return null;
  if (SUPPORTED_CODES.includes(prefix)) return prefix;

  return SUPPORTED_CODES.find((code) => code.startsWith(`${prefix}-`)) ?? null;
}

/**
 * Detect the best matching locale from the browser's language setting.
 * Tries full code first (e.g. 'zh-CN'), then prefix (e.g. 'zh' -> 'zh-CN').
 */
export function detectBrowserLocale(): string {
  if (typeof navigator === 'undefined') return 'en';
  const browserLang = navigator.language;
  if (!browserLang) return 'en';

  return normalizeSupportedLocale(browserLang) ?? 'en';
}

export function detectAcceptLanguageLocale(header: string | null | undefined): string {
  if (!header) return 'en';

  const candidates = header
    .split(',')
    .map((part) => {
      const [locale, qValue] = part.trim().split(';q=');
      return {
        locale: normalizeSupportedLocale(locale),
        quality: qValue ? Number.parseFloat(qValue) : 1,
      };
    })
    .filter((candidate): candidate is { locale: string; quality: number } => !!candidate.locale)
    .sort((a, b) => b.quality - a.quality);

  return candidates[0]?.locale ?? 'en';
}

/**
 * Get the display locale: localStorage > browser detection > 'en'
 */
export function getDisplayLocale(): string {
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(DISPLAY_LOCALE_KEY);
    if (stored && SUPPORTED_CODES.includes(stored)) return stored;
  }
  return detectBrowserLocale();
}

export function createSiliconBeestI18n(locale = getDisplayLocale()) {
  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: 'en',
    messages: UI_MESSAGES,
  });
}

export let i18n = createSiliconBeestI18n();

export function setI18nInstance(instance: typeof i18n) {
  i18n = instance;
}

export const createSiliconbeestI18n = createSiliconBeestI18n;

export async function loadLocale(locale: string) {
  const supportedLocale = normalizeSupportedLocale(locale);
  if (!supportedLocale) return;
  (i18n.global.locale as Ref<string>).value = supportedLocale;
}

/**
 * Set the display locale. Validates against supported list, persists
 * to localStorage, and loads the locale messages.
 */
export async function setDisplayLocale(locale: string): Promise<void> {
  if (!SUPPORTED_CODES.includes(locale)) return;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(DISPLAY_LOCALE_KEY, locale);
  }
  if (typeof document !== 'undefined') {
    document.cookie = `${DISPLAY_LOCALE_KEY}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }
  await loadLocale(locale);
}
