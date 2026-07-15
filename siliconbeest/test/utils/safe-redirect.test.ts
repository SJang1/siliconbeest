import { describe, expect, it } from 'vitest';
import { getSafeRedirect, withCurrentDesign } from '@/utils/safeRedirect';

describe('getSafeRedirect', () => {
  it('keeps same-origin paths including query and hash', () => {
    expect(getSafeRedirect('/invitations?tab=active#links')).toBe(
      '/invitations?tab=active#links',
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
    expect(withCurrentDesign('/invitations', '/home')).toBe(
      '/invitations',
    );
  });

  it('preserves Aurora and old design prefixes', () => {
    expect(withCurrentDesign('/invitations', '/aurora/home')).toBe(
      '/aurora/invitations',
    );
    expect(withCurrentDesign('/invitations', '/old/home')).toBe(
      '/old/invitations',
    );
  });
});
