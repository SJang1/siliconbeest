import { describe, expect, it } from 'vitest';
import { articlePlainText, articleTimelinePreview } from '@/utils/articlePreview';

describe('Article timeline previews', () => {
  it('shows only the supplied summary when one exists', () => {
    expect(articleTimelinePreview('A concise &amp; useful summary', '<p>Secret full body</p>')).toBe(
      'A concise & useful summary',
    );
  });

  it('uses the opening body lines and marks omitted content', () => {
    const content = '<h2>Opening</h2><p>First paragraph.</p><p>Second paragraph.</p><p>Hidden paragraph.</p>';
    expect(articleTimelinePreview(undefined, content)).toBe(
      'Opening\nFirst paragraph.\nSecond paragraph....',
    );
  });

  it('strips embedded media and decodes text entities', () => {
    expect(articlePlainText('<p>One &lt; Two</p><img src="https://example.test/image.png" alt="hidden">')).toBe(
      'One < Two',
    );
  });

  it('preserves comparison text and invalid numeric entities', () => {
    expect(articlePlainText('<p>X < Y but Z > W &#9999999999; &#xD800;</p>')).toBe(
      'X < Y but Z > W &#9999999999; &#xD800;',
    );
  });
});
