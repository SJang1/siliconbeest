/**
 * Instance accent color for the Deck UI.
 *
 * The admin-selected `accent_color` (a #rrggbb hex) is written to two CSS
 * custom properties on <html>:
 *  - `--dk-acc-raw`: the color itself. deck.css derives the per-theme
 *    accent from it (dark uses it as-is, light darkens it via color-mix).
 *  - `--dk-acc-ink`: text color used on accent-filled surfaces, chosen by
 *    relative luminance so the ＋ Note button stays readable for any accent.
 */

export const DEFAULT_ACCENT = '#c6f24e';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isValidAccent(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value);
}

/** WCAG relative luminance of a #rrggbb color, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** Ink (text) color for content sitting on the accent color. */
export function accentInk(hex: string): string {
  return relativeLuminance(hex) > 0.35 ? '#181322' : '#ffffff';
}

/**
 * Apply the instance accent to the document. Invalid or missing values fall
 * back to DEFAULT_ACCENT. `root` is injectable for tests.
 */
export function applyAccent(
  value?: string | null,
  root: HTMLElement | undefined = typeof document !== 'undefined' ? document.documentElement : undefined,
): string {
  let hex = DEFAULT_ACCENT;
  if (value != null && value !== '') {
    if (isValidAccent(value)) {
      hex = value.toLowerCase();
    } else {
      console.warn(`[deck] invalid accent_color ${JSON.stringify(value)}; using ${DEFAULT_ACCENT}`);
    }
  }
  if (root) {
    root.style.setProperty('--dk-acc-raw', hex);
    root.style.setProperty('--dk-acc-ink', accentInk(hex));
  }
  return hex;
}
