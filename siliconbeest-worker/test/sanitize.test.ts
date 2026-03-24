import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from '../src/utils/sanitize';

describe('sanitizeHtml', () => {
  // -------------------------------------------------------------------
  // Basic pass-through
  // -------------------------------------------------------------------
  it('returns empty string for empty input', () => {
    expect(sanitizeHtml('')).toBe('');
  });

  it('returns empty string for null/undefined', () => {
    expect(sanitizeHtml(null as any)).toBe('');
    expect(sanitizeHtml(undefined as any)).toBe('');
  });

  it('passes through plain text', () => {
    expect(sanitizeHtml('hello world')).toBe('hello world');
  });

  // -------------------------------------------------------------------
  // Allowed tags
  // -------------------------------------------------------------------
  describe('allowed tags', () => {
    it('allows <p> tags', () => {
      const result = sanitizeHtml('<p>paragraph</p>');
      expect(result).toBe('<p>paragraph</p>');
    });

    it('allows <br /> tags', () => {
      const result = sanitizeHtml('<br>');
      expect(result).toBe('<br />');
    });

    it('allows <a> tags with href', () => {
      const result = sanitizeHtml('<a href="https://example.com">link</a>');
      expect(result).toContain('<a href="https://example.com">');
      expect(result).toContain('link</a>');
    });

    it('allows <strong> and <em>', () => {
      expect(sanitizeHtml('<strong>bold</strong>')).toBe('<strong>bold</strong>');
      expect(sanitizeHtml('<em>italic</em>')).toBe('<em>italic</em>');
    });

    it('allows <blockquote>', () => {
      const result = sanitizeHtml('<blockquote>quoted</blockquote>');
      expect(result).toBe('<blockquote>quoted</blockquote>');
    });

    it('allows <pre> and <code>', () => {
      const result = sanitizeHtml('<pre><code>code</code></pre>');
      expect(result).toBe('<pre><code>code</code></pre>');
    });

    it('allows <ul>, <ol>, <li>', () => {
      const result = sanitizeHtml('<ul><li>item</li></ul>');
      expect(result).toBe('<ul><li>item</li></ul>');
    });

    it('allows heading tags h1-h6', () => {
      expect(sanitizeHtml('<h1>title</h1>')).toBe('<h1>title</h1>');
      expect(sanitizeHtml('<h6>sub</h6>')).toBe('<h6>sub</h6>');
    });

    it('allows <span> with class attribute', () => {
      const result = sanitizeHtml('<span class="highlight">text</span>');
      expect(result).toContain('class="highlight"');
    });

    it('allows <del> tag', () => {
      expect(sanitizeHtml('<del>removed</del>')).toBe('<del>removed</del>');
    });
  });

  // -------------------------------------------------------------------
  // Disallowed tags
  // -------------------------------------------------------------------
  describe('disallowed tags', () => {
    it('strips <div> tags but keeps content', () => {
      expect(sanitizeHtml('<div>content</div>')).toBe('content');
    });

    it('strips <img> tags', () => {
      expect(sanitizeHtml('<img src="x.jpg">')).toBe('');
    });

    it('strips <iframe> tags', () => {
      expect(sanitizeHtml('<iframe src="evil.html"></iframe>')).toBe('');
    });

    it('strips <table> and related tags', () => {
      expect(sanitizeHtml('<table><tr><td>cell</td></tr></table>')).toBe('cell');
    });

    it('strips <form> tags', () => {
      expect(sanitizeHtml('<form action="/submit"><input></form>')).toBe('');
    });
  });

  // -------------------------------------------------------------------
  // Script and style removal
  // -------------------------------------------------------------------
  describe('script and style removal', () => {
    it('removes <script> blocks entirely', () => {
      const result = sanitizeHtml('<p>safe</p><script>alert("xss")</script><p>text</p>');
      expect(result).toBe('<p>safe</p><p>text</p>');
      expect(result).not.toContain('script');
      expect(result).not.toContain('alert');
    });

    it('removes <style> blocks entirely', () => {
      const result = sanitizeHtml('<style>body{color:red}</style><p>text</p>');
      expect(result).toBe('<p>text</p>');
      expect(result).not.toContain('style');
    });

    it('removes script with attributes', () => {
      const result = sanitizeHtml('<script type="text/javascript">var x=1;</script>');
      expect(result).toBe('');
    });
  });

  // -------------------------------------------------------------------
  // Event handler removal
  // -------------------------------------------------------------------
  describe('event handlers', () => {
    it('removes onclick', () => {
      const result = sanitizeHtml('<a href="https://example.com" onclick="alert(1)">link</a>');
      expect(result).not.toContain('onclick');
      expect(result).toContain('href="https://example.com"');
    });

    it('removes onload', () => {
      const result = sanitizeHtml('<p onload="steal()">text</p>');
      expect(result).not.toContain('onload');
    });

    it('removes onmouseover', () => {
      const result = sanitizeHtml('<span onmouseover="hack()">hover</span>');
      expect(result).not.toContain('onmouseover');
    });

    it('removes onerror', () => {
      const result = sanitizeHtml('<p onerror="alert(1)">text</p>');
      expect(result).not.toContain('onerror');
    });
  });

  // -------------------------------------------------------------------
  // Attribute filtering
  // -------------------------------------------------------------------
  describe('attribute filtering', () => {
    it('removes disallowed attributes', () => {
      const result = sanitizeHtml('<p style="color:red">text</p>');
      expect(result).not.toContain('style');
    });

    it('removes data- attributes', () => {
      const result = sanitizeHtml('<p data-custom="value">text</p>');
      expect(result).not.toContain('data-custom');
    });

    it('allows class on any tag', () => {
      const result = sanitizeHtml('<p class="special">text</p>');
      expect(result).toContain('class="special"');
    });

    it('allows rel and target on <a>', () => {
      const result = sanitizeHtml('<a href="https://example.com" rel="nofollow" target="_blank">link</a>');
      expect(result).toContain('rel="nofollow"');
      expect(result).toContain('target="_blank"');
    });
  });

  // -------------------------------------------------------------------
  // href validation
  // -------------------------------------------------------------------
  describe('href validation', () => {
    it('allows https URLs', () => {
      const result = sanitizeHtml('<a href="https://example.com">link</a>');
      expect(result).toContain('href="https://example.com"');
    });

    it('allows http URLs', () => {
      const result = sanitizeHtml('<a href="http://example.com">link</a>');
      expect(result).toContain('href="http://example.com"');
    });

    it('blocks javascript: URLs', () => {
      const result = sanitizeHtml('<a href="javascript:alert(1)">link</a>');
      expect(result).not.toContain('javascript');
      expect(result).not.toContain('href');
    });

    it('blocks data: URLs', () => {
      const result = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">link</a>');
      expect(result).not.toContain('data:');
    });

    it('blocks vbscript: URLs', () => {
      const result = sanitizeHtml('<a href="vbscript:MsgBox">link</a>');
      expect(result).not.toContain('vbscript');
    });

    it('blocks blob: URLs', () => {
      const result = sanitizeHtml('<a href="blob:http://evil.com/uuid">link</a>');
      expect(result).not.toContain('blob:');
    });

    it('allows mailto: links', () => {
      const result = sanitizeHtml('<a href="mailto:test@example.com">email</a>');
      expect(result).toContain('href="mailto:test@example.com"');
    });

    it('allows relative URLs', () => {
      const result = sanitizeHtml('<a href="/path/to/page">link</a>');
      expect(result).toContain('href="/path/to/page"');
    });

    it('allows hash fragment URLs', () => {
      const result = sanitizeHtml('<a href="#section">link</a>');
      expect(result).toContain('href="#section"');
    });
  });

  // -------------------------------------------------------------------
  // HTML comments
  // -------------------------------------------------------------------
  it('removes HTML comments', () => {
    const result = sanitizeHtml('<p>text</p><!-- secret comment --><p>more</p>');
    expect(result).not.toContain('<!--');
    expect(result).not.toContain('secret');
  });

  // -------------------------------------------------------------------
  // Attribute value escaping
  // -------------------------------------------------------------------
  it('escapes special characters in attribute values', () => {
    const result = sanitizeHtml('<a href="https://example.com?a=1&amp;b=2">link</a>');
    expect(result).toContain('href=');
  });
});
