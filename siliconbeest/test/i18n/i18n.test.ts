import { describe, it, expect } from 'vitest';
import { createI18n } from 'vue-i18n';
import en from '@/i18n/locales/en.json';

describe('i18n', () => {
  function makeI18n() {
    return createI18n({
      legacy: false,
      locale: 'en',
      fallbackLocale: 'en',
      messages: { en },
      missingWarn: false,
      fallbackWarn: false,
    });
  }

  describe('English locale', () => {
    it('loads English locale successfully', () => {
      const i18n = makeI18n();
      expect(i18n.global.availableLocales).toContain('en');
    });

    it('has common.loading key', () => {
      const i18n = makeI18n();
      expect(i18n.global.t('common.loading')).toBe('Loading...');
    });

    it('has auth.login key', () => {
      const i18n = makeI18n();
      expect(i18n.global.t('auth.login')).toBe('Log in');
    });

    it('has auth.logout key', () => {
      const i18n = makeI18n();
      expect(i18n.global.t('auth.logout')).toBe('Log out');
    });

    it('has timeline section keys', () => {
      const i18n = makeI18n();
      expect(i18n.global.t('timeline.home')).toBe('Home');
      expect(i18n.global.t('timeline.local')).toBe('Local');
      expect(i18n.global.t('timeline.federated')).toBe('Federated');
    });

    it('has status action keys', () => {
      const i18n = makeI18n();
      expect(i18n.global.t('status.reply')).toBe('Reply');
      expect(i18n.global.t('status.boost')).toBe('Boost');
      expect(i18n.global.t('status.favourite')).toBe('Favourite');
      expect(i18n.global.t('status.bookmark')).toBe('Bookmark');
      expect(i18n.global.t('status.share')).toBe('Share');
    });

    it('has profile keys', () => {
      const i18n = makeI18n();
      expect(i18n.global.t('profile.follow')).toBe('Follow');
      expect(i18n.global.t('profile.unfollow')).toBe('Unfollow');
    });

    it('has settings keys', () => {
      const i18n = makeI18n();
      expect(i18n.global.t('settings.theme')).toBe('Theme');
      expect(i18n.global.t('settings.themeLight')).toBe('Light');
      expect(i18n.global.t('settings.themeDark')).toBe('Dark');
    });

    it('has error keys', () => {
      const i18n = makeI18n();
      expect(i18n.global.t('error.notFound')).toBe('Page not found');
    });
  });

  describe('Fallback behavior', () => {
    it('falls back to English for missing locale', () => {
      const i18n = createI18n({
        legacy: false,
        locale: 'fr',
        fallbackLocale: 'en',
        messages: { en },
        missingWarn: false,
        fallbackWarn: false,
      });
      // French locale has no messages loaded, should fall back to English
      expect(i18n.global.t('common.loading')).toBe('Loading...');
    });

    it('returns key path for completely missing keys', () => {
      const i18n = makeI18n();
      const result = i18n.global.t('nonexistent.key');
      expect(result).toBe('nonexistent.key');
    });
  });

  describe('Dynamic locale', () => {
    it('can add a new locale at runtime', () => {
      const i18n = makeI18n();
      const koMessages = { common: { loading: '로딩 중...' } };
      i18n.global.setLocaleMessage('ko', koMessages);
      expect(i18n.global.availableLocales).toContain('ko');
      i18n.global.locale.value = 'ko';
      expect(i18n.global.t('common.loading')).toBe('로딩 중...');
    });
  });
});
