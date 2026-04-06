import { createI18n } from 'vue-i18n';
import type { Ref } from 'vue';
import en from './locales/en.json';

export const SUPPORTED_LOCALES = [
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

const SUPPORTED_CODES = SUPPORTED_LOCALES.map((l) => l.code) as readonly string[];

const DISPLAY_LOCALE_KEY = 'siliconbeest_display_locale';

/**
 * Detect the best matching locale from the browser's language setting.
 * Tries full code first (e.g. 'zh-CN'), then prefix (e.g. 'zh' -> 'zh-CN').
 */
export function detectBrowserLocale(): string {
  if (typeof navigator === 'undefined') return 'en';
  const browserLang = navigator.language;
  if (!browserLang) return 'en';

  // Exact match (e.g. 'ko', 'zh-CN', 'pt-BR')
  if (SUPPORTED_CODES.includes(browserLang)) return browserLang;

  // Prefix match: 'zh-Hans' -> 'zh-CN', 'pt' -> 'pt-BR'
  const prefix = browserLang.split('-')[0];
  if (!prefix) return 'en';

  // Direct prefix match
  if (SUPPORTED_CODES.includes(prefix)) return prefix;

  // Find first locale starting with prefix
  const match = SUPPORTED_CODES.find((c) => c.startsWith(prefix + '-'));
  return match || 'en';
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

const initialLocale = getDisplayLocale();

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: 'en',
  messages: { en },
});

export async function loadLocale(locale: string) {
  if (!(i18n.global.availableLocales as string[]).includes(locale)) {
    const messages = await import(`./locales/${locale}.json`);
    i18n.global.setLocaleMessage(locale, messages.default);
  }
  (i18n.global.locale as Ref<string>).value = locale;
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
  await loadLocale(locale);
}
