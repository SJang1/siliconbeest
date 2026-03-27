import { describe, it, expect } from 'vitest';
import { parsePaginationParams, buildPaginationQuery, buildLinkHeader } from '../src/utils/pagination';

describe('pagination utilities', () => {
  // -------------------------------------------------------------------
  // parsePaginationParams
  // -------------------------------------------------------------------
  describe('parsePaginationParams', () => {
    it('returns defaults when no params supplied', () => {
      const result = parsePaginationParams({});
      expect(result).toEqual({
        maxId: undefined,
        sinceId: undefined,
        minId: undefined,
        limit: 20,
      });
    });

    it('parses max_id', () => {
      const result = parsePaginationParams({ max_id: 'abc123' });
      expect(result.maxId).toBe('abc123');
    });

    it('parses since_id', () => {
      const result = parsePaginationParams({ since_id: 'def456' });
      expect(result.sinceId).toBe('def456');
    });

    it('parses min_id', () => {
      const result = parsePaginationParams({ min_id: 'ghi789' });
      expect(result.minId).toBe('ghi789');
    });

    it('parses a valid limit', () => {
      const result = parsePaginationParams({ limit: '10' });
      expect(result.limit).toBe(10);
    });

    it('clamps limit to max 40', () => {
      const result = parsePaginationParams({ limit: '100' });
      expect(result.limit).toBe(40);
    });

    it('uses default limit for non-numeric value', () => {
      const result = parsePaginationParams({ limit: 'abc' });
      expect(result.limit).toBe(20);
    });

    it('uses default limit for zero', () => {
      const result = parsePaginationParams({ limit: '0' });
      expect(result.limit).toBe(20);
    });

    it('uses default limit for negative', () => {
      const result = parsePaginationParams({ limit: '-5' });
      expect(result.limit).toBe(20);
    });

    it('treats empty string ids as undefined', () => {
      const result = parsePaginationParams({ max_id: '', since_id: '', min_id: '' });
      expect(result.maxId).toBeUndefined();
      expect(result.sinceId).toBeUndefined();
      expect(result.minId).toBeUndefined();
    });

    it('parses all params together', () => {
      const result = parsePaginationParams({
        max_id: 'aaa',
        since_id: 'bbb',
        min_id: 'ccc',
        limit: '5',
      });
      expect(result).toEqual({
        maxId: 'aaa',
        sinceId: 'bbb',
        minId: 'ccc',
        limit: 5,
      });
    });
  });

  // -------------------------------------------------------------------
  // buildPaginationQuery
  // -------------------------------------------------------------------
  describe('buildPaginationQuery', () => {
    it('returns empty whereClause when no cursors set', () => {
      const result = buildPaginationQuery({ limit: 20 });
      expect(result.whereClause).toBe('');
      expect(result.orderClause).toBe('id DESC');
      expect(result.limitValue).toBe(20);
      expect(result.params).toEqual([]);
    });

    it('builds maxId condition', () => {
      const result = buildPaginationQuery({ maxId: 'xyz', limit: 10 });
      expect(result.whereClause).toBe('id < ?');
      expect(result.params).toEqual(['xyz']);
      expect(result.orderClause).toBe('id DESC');
    });

    it('builds sinceId condition', () => {
      const result = buildPaginationQuery({ sinceId: 'abc', limit: 10 });
      expect(result.whereClause).toBe('id > ?');
      expect(result.params).toEqual(['abc']);
      expect(result.orderClause).toBe('id DESC');
    });

    it('builds minId condition with ASC order', () => {
      const result = buildPaginationQuery({ minId: 'def', limit: 10 });
      expect(result.whereClause).toBe('id > ?');
      expect(result.params).toEqual(['def']);
      expect(result.orderClause).toBe('id ASC');
    });

    it('combines maxId and sinceId', () => {
      const result = buildPaginationQuery({ maxId: 'zzz', sinceId: 'aaa', limit: 5 });
      expect(result.whereClause).toBe('id < ? AND id > ?');
      expect(result.params).toEqual(['zzz', 'aaa']);
    });

    it('uses custom idColumn', () => {
      const result = buildPaginationQuery({ maxId: 'xyz', limit: 10 }, 'created_at');
      expect(result.whereClause).toBe('created_at < ?');
      expect(result.orderClause).toBe('created_at DESC');
    });

    it('passes through limitValue', () => {
      const result = buildPaginationQuery({ limit: 35 });
      expect(result.limitValue).toBe(35);
    });
  });

  // -------------------------------------------------------------------
  // buildLinkHeader
  // -------------------------------------------------------------------
  describe('buildLinkHeader', () => {
    it('returns empty string for empty items', () => {
      const result = buildLinkHeader('https://example.com/api/v1/timelines/home', [], 20);
      expect(result).toBe('');
    });

    it('builds next and prev links for single item', () => {
      const items = [{ id: '100' }];
      const result = buildLinkHeader('https://example.com/api/v1/timelines/home', items, 20);
      expect(result).toContain('rel="next"');
      expect(result).toContain('rel="prev"');
      expect(result).toContain('max_id=100');
      expect(result).toContain('min_id=100');
      expect(result).toContain('limit=20');
    });

    it('uses last item id for next and first item id for prev', () => {
      const items = [{ id: '200' }, { id: '150' }, { id: '100' }];
      const result = buildLinkHeader('https://example.com/endpoint', items, 10);
      expect(result).toContain('max_id=100');
      expect(result).toContain('min_id=200');
    });

    it('includes limit in both links', () => {
      const items = [{ id: '50' }, { id: '40' }];
      const result = buildLinkHeader('https://example.com/endpoint', items, 15);
      const parts = result.split(', ');
      expect(parts).toHaveLength(2);
      for (const part of parts) {
        expect(part).toContain('limit=15');
      }
    });

    it('wraps URLs in angle brackets per RFC 8288', () => {
      const items = [{ id: '1' }];
      const result = buildLinkHeader('https://example.com/endpoint', items, 20);
      expect(result).toMatch(/<https:\/\/example\.com\/endpoint\?/);
    });
  });
});
