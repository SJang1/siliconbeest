import { createI18n } from 'vue-i18n';
import en from './locales/en.json';

export const i18n = createI18n({
  legacy: false,
  locale: navigator.language.split('-')[0] || 'en',
  fallbackLocale: 'en',
  messages: { en },
});

export async function loadLocale(locale: string) {
  if (i18n.global.availableLocales.includes(locale)) return;
  const messages = await import(`./locales/${locale}.json`);
  i18n.global.setLocaleMessage(locale, messages.default);
  i18n.global.locale.value = locale;
}

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
