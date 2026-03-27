import { describe, it, expect } from 'vitest';
import { generateUlid, isValidUlid, ulidToDate } from '../src/utils/ulid';

describe('ULID utilities', () => {
  // -------------------------------------------------------------------
  // generateUlid
  // -------------------------------------------------------------------
  describe('generateUlid', () => {
    it('produces a 26-character string', () => {
      const id = generateUlid();
      expect(id).toHaveLength(26);
    });

    it('produces valid Crockford Base32 characters', () => {
      const id = generateUlid();
      expect(id).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    });

    it('produces unique IDs on successive calls', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateUlid());
      }
      expect(ids.size).toBe(100);
    });

    it('produces lexicographically sortable IDs across different timestamps', async () => {
      const first = generateUlid();
      // Wait 2ms to ensure different timestamp component
      await new Promise((r) => setTimeout(r, 2));
      const second = generateUlid();
      // The second should sort after the first when timestamps differ
      expect(first < second).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // isValidUlid
  // -------------------------------------------------------------------
  describe('isValidUlid', () => {
    it('returns true for a valid ULID', () => {
      const id = generateUlid();
      expect(isValidUlid(id)).toBe(true);
    });

    it('returns true for a known valid ULID', () => {
      expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(isValidUlid('')).toBe(false);
    });

    it('returns false for string too short', () => {
      expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false);
    });

    it('returns false for string too long', () => {
      expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAVX')).toBe(false);
    });

    it('returns false for non-string input', () => {
      expect(isValidUlid(123 as any)).toBe(false);
      expect(isValidUlid(null as any)).toBe(false);
      expect(isValidUlid(undefined as any)).toBe(false);
    });

    it('returns false for string with invalid characters', () => {
      // I, L, O, U are not in Crockford Base32
      expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false);
    });

    it('accepts lowercase input (case insensitive)', () => {
      expect(isValidUlid('01arz3ndektsv4rrffq69g5fav')).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // ulidToDate
  // -------------------------------------------------------------------
  describe('ulidToDate', () => {
    it('extracts a date from a generated ULID', () => {
      const before = Date.now();
      const id = generateUlid();
      const after = Date.now();

      const date = ulidToDate(id);
      expect(date).toBeInstanceOf(Date);
      expect(date.getTime()).toBeGreaterThanOrEqual(before);
      expect(date.getTime()).toBeLessThanOrEqual(after);
    });

    it('returns a reasonable timestamp from a known ULID', () => {
      // 01ARZ3NDEKTSV4RRFFQ69G5FAV has a known timestamp
      const date = ulidToDate('01ARZ3NDEKTSV4RRFFQ69G5FAV');
      expect(date).toBeInstanceOf(Date);
      // Should be a date in 2016 (1469918176385 ms since epoch)
      expect(date.getFullYear()).toBe(2016);
    });
  });
});
