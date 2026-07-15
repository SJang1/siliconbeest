import { describe, expect, it } from 'vitest';
import { getSafeRedirect, withCurrentDesign } from '@/utils/safeRedirect';

describe('getSafeRedirect', () => {
  it('keeps same-origin paths including query and hash', () => {
    expect(getSafeRedirect('/settings/invitations?tab=active#links')).toBe(
      '/settings/invitations?tab=active#links',
    );
  });

  it('rejects absolute and protocol-relative redirects', () => {
    expect(getSafeRedirect('https://example.com/account')).toBe('/home');
    expect(getSafeRedirect('//example.com/account')).toBe('/home');
    expect(getSafeRedirect('javascript:alert(1)', '/')).toBe('/');
  });

  it('uses the first query value', () => {
    expect(getSafeRedirect(['/settings/security', '/admin'])).toBe(
      '/settings/security',
    );
  });
});

describe('withCurrentDesign', () => {
  it('keeps canonical paths in the default design', () => {
    expect(withCurrentDesign('/settings/invitations', '/home')).toBe(
      '/settings/invitations',
    );
  });

  it('preserves Aurora and old design prefixes', () => {
    expect(withCurrentDesign('/settings/invitations', '/aurora/home')).toBe(
      '/aurora/settings/invitations',
    );
    expect(withCurrentDesign('/settings/invitations', '/old/home')).toBe(
      '/old/settings/invitations',
    );
  });
});
