import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import en from '@/i18n/locales/en.json';

export function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    fallbackLocale: 'en',
    messages: { en },
    silentFallbackWarn: true,
    silentTranslationWarn: true,
    missingWarn: false,
    fallbackWarn: false,
  });
}

export function mountWithPlugins(component: any, opts?: any) {
  return mount(component, {
    global: {
      plugins: [createPinia(), createTestI18n(), ...(opts?.plugins || [])],
      ...opts?.global,
    },
    ...opts,
  });
}
