import { describe, it, expect } from 'vitest';
import { parseContent } from '../src/utils/contentParser';

const DOMAIN = 'test.siliconbeest.local';

describe('parseContent', () => {
  // ---------------------------------------------------------------
  // Mentions
  // ---------------------------------------------------------------
  describe('mention extraction', () => {
    it('extracts local mention @user', () => {
      const result = parseContent('Hello @alice', DOMAIN);

      expect(result.mentions.length).toBe(1);
      expect(result.mentions[0].username).toBe('alice');
      expect(result.mentions[0].domain).toBeNull();
      expect(result.mentions[0].acct).toBe('alice');
    });

    it('extracts federated mention @user@domain', () => {
      const result = parseContent('Hello @bob@remote.example', DOMAIN);

      expect(result.mentions.length).toBe(1);
      expect(result.mentions[0].username).toBe('bob');
      expect(result.mentions[0].domain).toBe('remote.example');
      expect(result.mentions[0].acct).toBe('bob@remote.example');
    });

    it('extracts multiple mentions', () => {
      const result = parseContent('@alice @bob@remote.example hello!', DOMAIN);

      expect(result.mentions.length).toBe(2);
    });

    it('deduplicates repeated mentions', () => {
      const result = parseContent('@alice @alice hello again', DOMAIN);

      expect(result.mentions.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------
  // Hashtags
  // ---------------------------------------------------------------
  describe('hashtag extraction', () => {
    it('extracts hashtags', () => {
      const result = parseContent('Hello #fediverse', DOMAIN);

      expect(result.tags.length).toBe(1);
      expect(result.tags[0]).toBe('fediverse');
    });

    it('normalizes hashtags to lowercase', () => {
      const result = parseContent('#FediVerse', DOMAIN);

      expect(result.tags[0]).toBe('fediverse');
    });

    it('deduplicates hashtags', () => {
      const result = parseContent('#test #Test #TEST', DOMAIN);

      expect(result.tags.length).toBe(1);
    });

    it('extracts multiple hashtags', () => {
      const result = parseContent('#hello #world', DOMAIN);

      expect(result.tags.length).toBe(2);
    });
  });

  // ---------------------------------------------------------------
  // URL auto-linking
  // ---------------------------------------------------------------
  describe('URL auto-linking', () => {
    it('auto-links https URLs', () => {
      const result = parseContent('Check https://example.com', DOMAIN);

      expect(result.html).toContain('<a href="https://example.com"');
      expect(result.html).toContain('rel="noopener noreferrer"');
      expect(result.html).toContain('target="_blank"');
    });

    it('auto-links http URLs', () => {
      const result = parseContent('Visit http://example.com', DOMAIN);

      expect(result.html).toContain('<a href="http://example.com"');
    });

    it('strips trailing punctuation from URLs', () => {
      const result = parseContent('See https://example.com.', DOMAIN);

      expect(result.html).toContain('href="https://example.com"');
      // The period should be outside the link
      expect(result.html).toContain('</a>.');
    });
  });

  // ---------------------------------------------------------------
  // HTML output
  // ---------------------------------------------------------------
  describe('HTML output', () => {
    it('mention links have proper a tags with rel noopener', () => {
      const result = parseContent('@alice hello', DOMAIN);

      expect(result.html).toContain('class="u-url mention"');
      expect(result.html).toContain(`href="https://${DOMAIN}/@alice"`);
    });

    it('local mention links point to local profile', () => {
      const result = parseContent('@alice', DOMAIN);

      expect(result.html).toContain(`href="https://${DOMAIN}/@alice"`);
    });

    it('federated mention links include domain in URL', () => {
      const result = parseContent('@bob@remote.example', DOMAIN);

      expect(result.html).toContain(`href="https://${DOMAIN}/@bob@remote.example"`);
    });

    it('hashtag links have class mention hashtag and rel tag', () => {
      const result = parseContent('#hello', DOMAIN);

      expect(result.html).toContain('class="mention hashtag"');
      expect(result.html).toContain('rel="tag"');
      expect(result.html).toContain(`href="https://${DOMAIN}/tags/hello"`);
    });
  });

  // ---------------------------------------------------------------
  // Paragraph wrapping
  // ---------------------------------------------------------------
  describe('paragraph wrapping', () => {
    it('wraps content in <p> tags', () => {
      const result = parseContent('Hello world', DOMAIN);

      expect(result.html).toBe('<p>Hello world</p>');
    });

    it('creates multiple paragraphs from double newlines', () => {
      const result = parseContent('First paragraph\n\nSecond paragraph', DOMAIN);

      expect(result.html).toBe('<p>First paragraph</p><p>Second paragraph</p>');
    });

    it('converts single newlines to <br />', () => {
      const result = parseContent('Line one\nLine two', DOMAIN);

      expect(result.html).toContain('Line one<br />Line two');
    });
  });

  // ---------------------------------------------------------------
  // HTML escaping
  // ---------------------------------------------------------------
  describe('HTML escaping', () => {
    it('escapes HTML special characters', () => {
      const result = parseContent('<script>alert("xss")</script>', DOMAIN);

      expect(result.html).not.toContain('<script>');
      expect(result.html).toContain('&lt;script&gt;');
    });

    it('escapes ampersands', () => {
      const result = parseContent('A & B', DOMAIN);

      expect(result.html).toContain('A &amp; B');
    });
  });
});
