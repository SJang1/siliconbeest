import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_ACCENT,
  isValidAccent,
  relativeLuminance,
  accentInk,
  applyAccent,
} from '@/utils/accent';

function fakeRoot() {
  const vars = new Map<string, string>();
  return {
    vars,
    style: {
      setProperty: (k: string, v: string) => vars.set(k, v),
    },
  } as unknown as HTMLElement & { vars: Map<string, string> };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isValidAccent', () => {
  it('accepts #rrggbb hex colors', () => {
    expect(isValidAccent('#c6f24e')).toBe(true);
    expect(isValidAccent('#C6F24E')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isValidAccent('#fff')).toBe(false);
    expect(isValidAccent('c6f24e')).toBe(false);
    expect(isValidAccent('#c6f24e00')).toBe(false);
    expect(isValidAccent('red')).toBe(false);
    expect(isValidAccent('')).toBe(false);
    expect(isValidAccent(null)).toBe(false);
    expect(isValidAccent(undefined)).toBe(false);
    expect(isValidAccent('#c6f24g')).toBe(false);
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1);
  });
});

describe('accentInk', () => {
  it('uses dark ink on light accents', () => {
    expect(accentInk('#c6f24e')).toBe('#181322');
    expect(accentInk('#4ed9c6')).toBe('#181322');
  });

  it('uses white ink on dark accents', () => {
    expect(accentInk('#1e1b4b')).toBe('#ffffff');
    expect(accentInk('#7c2d12')).toBe('#ffffff');
  });
});

describe('applyAccent', () => {
  it('applies a valid accent and its ink to the root element', () => {
    const root = fakeRoot();
    const applied = applyAccent('#4ED9C6', root);
    expect(applied).toBe('#4ed9c6');
    expect(root.vars.get('--dk-acc-raw')).toBe('#4ed9c6');
    expect(root.vars.get('--dk-acc-ink')).toBe('#181322');
  });

  it('falls back to the default accent on invalid input and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = fakeRoot();
    const applied = applyAccent('not-a-color', root);
    expect(applied).toBe(DEFAULT_ACCENT);
    expect(root.vars.get('--dk-acc-raw')).toBe(DEFAULT_ACCENT);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('falls back silently on missing values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = fakeRoot();
    expect(applyAccent(null, root)).toBe(DEFAULT_ACCENT);
    expect(applyAccent(undefined, root)).toBe(DEFAULT_ACCENT);
    expect(applyAccent('', root)).toBe(DEFAULT_ACCENT);
    expect(warn).not.toHaveBeenCalled();
  });
});
