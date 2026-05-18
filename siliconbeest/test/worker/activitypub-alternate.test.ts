import { describe, expect, it } from 'vitest';
import {
  ACTIVITYPUB_CONTENT_TYPE,
  buildActivityPubAlternate,
  injectActivityPubAlternateHtml,
  parseActivityPubAlternateCandidate,
} from '../../server/activitypub-alternate';

describe('ActivityPub alternate discovery helpers', () => {
  it('recognizes local profile URLs', () => {
    expect(parseActivityPubAlternateCandidate('/@alice')).toEqual({
      type: 'profile',
      username: 'alice',
    });
    expect(parseActivityPubAlternateCandidate('/%40alice')).toEqual({
      type: 'profile',
      username: 'alice',
    });
  });

  it('recognizes local status permalink URLs', () => {
    expect(parseActivityPubAlternateCandidate('/@alice/01JABCDEF0123456789XYZABC')).toEqual({
      type: 'status',
      username: 'alice',
      statusId: '01JABCDEF0123456789XYZABC',
    });
  });

  it('does not treat remote profile URLs or profile subpages as local alternates', () => {
    expect(parseActivityPubAlternateCandidate('/@alice@example.com')).toBeNull();
    expect(parseActivityPubAlternateCandidate('/@alice/followers')).toBeNull();
    expect(parseActivityPubAlternateCandidate('/@alice/following')).toBeNull();
  });

  it('builds Link header values and injects HTML link tags', () => {
    const alternate = buildActivityPubAlternate('https://example.com/users/alice');
    const html = '<!doctype html><html><head><title>x</title></head><body></body></html>';
    const result = injectActivityPubAlternateHtml(html, alternate);

    expect(alternate.headerValue).toBe(
      `<https://example.com/users/alice>; rel="alternate"; type="${ACTIVITYPUB_CONTENT_TYPE}"`,
    );
    expect(result).toContain(
      `<link rel="alternate" type="${ACTIVITYPUB_CONTENT_TYPE}" href="https://example.com/users/alice" />`,
    );
  });
});
