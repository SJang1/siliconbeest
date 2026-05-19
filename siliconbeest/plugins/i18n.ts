import {
  DISPLAY_LOCALE_KEY,
  createSiliconBeestI18n,
  detectAcceptLanguageLocale,
  detectBrowserLocale,
  loadLocale,
  normalizeSupportedLocale,
  setI18nInstance,
} from '@/i18n';

export default defineNuxtPlugin(async (nuxtApp) => {
  const localeCookie = useCookie<string | null>(DISPLAY_LOCALE_KEY, {
    maxAge: 60 * 60 * 24 * 365,
    path: '/',
    sameSite: 'lax',
  });
  const localeState = useState<string>('display-locale', () => {
    const cookieLocale = normalizeSupportedLocale(localeCookie.value);
    if (cookieLocale) return cookieLocale;

    if (import.meta.server) {
      const headers = useRequestHeaders(['accept-language']);
      return detectAcceptLanguageLocale(headers['accept-language']);
    }

    return detectBrowserLocale();
  });

  const initialLocale = normalizeSupportedLocale(localeState.value) ?? 'en';
  localeState.value = initialLocale;
  if (!localeCookie.value) {
    localeCookie.value = initialLocale;
  }

  const instance = createSiliconBeestI18n(initialLocale);
  setI18nInstance(instance);

  if (initialLocale !== 'en') {
    await loadLocale(initialLocale).catch(() => {});
  }

  useHead({
    htmlAttrs: {
      lang: initialLocale,
    },
  });

  nuxtApp.vueApp.use(instance);
});
