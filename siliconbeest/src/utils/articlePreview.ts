const ARTICLE_PREVIEW_MAX_LINES = 3;
const ARTICLE_PREVIEW_MAX_CHARACTERS = 280;

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  const decodeCodePoint = (entity: string, value: string, radix: number): string => {
    const codePoint = Number.parseInt(value, radix);
    if (
      !Number.isInteger(codePoint)
      || codePoint < 0
      || codePoint > 0x10FFFF
      || (codePoint >= 0xD800 && codePoint <= 0xDFFF)
    ) {
      return entity;
    }
    return String.fromCodePoint(codePoint);
  };

  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith('#x')) {
      return decodeCodePoint(entity, code.slice(2), 16);
    }
    if (code.startsWith('#')) {
      return decodeCodePoint(entity, code.slice(1), 10);
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

export function articlePlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|blockquote|pre|li|h[1-6])>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '• ')
      .replace(/<[a-zA-Z/][^>]*>/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function truncateAtWord(value: string, maxCharacters: number): string {
  const sliced = value.slice(0, maxCharacters + 1);
  const lastWhitespace = sliced.search(/\s+\S*$/);
  return (lastWhitespace > maxCharacters * 0.6
    ? sliced.slice(0, lastWhitespace)
    : value.slice(0, maxCharacters)).trimEnd();
}

/** Build the text shown for an Article in a timeline card. */
export function articleTimelinePreview(summary: string | undefined, content: string): string {
  const summaryText = articlePlainText(summary?.trim() || '');
  if (summaryText) return summaryText;

  const fullText = articlePlainText(content);
  if (!fullText) return '';

  const lines = fullText.split('\n');
  const selectedLines = lines.slice(0, ARTICLE_PREVIEW_MAX_LINES);
  let preview = selectedLines.join('\n');
  let truncated = lines.length > ARTICLE_PREVIEW_MAX_LINES;

  if (preview.length > ARTICLE_PREVIEW_MAX_CHARACTERS) {
    preview = truncateAtWord(preview, ARTICLE_PREVIEW_MAX_CHARACTERS);
    truncated = true;
  }

  return truncated ? `${preview}...` : preview;
}
