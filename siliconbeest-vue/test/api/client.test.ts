import { describe, it, expect, beforeEach, vi } from 'vitest';
import { apiFetch, ApiError, parseLinkHeader, buildQueryString } from '@/api/client';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('API Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('apiFetch', () => {
    it('adds Authorization header when token is provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: '1' }),
        headers: new Headers(),
      });

      await apiFetch('/v1/test', { token: 'my-token' });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/v1/test',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-token',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('does not add Authorization header when no token', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
        headers: new Headers(),
      });

      await apiFetch('/v1/test');

      const calledHeaders = mockFetch.mock.calls[0][1].headers;
      expect(calledHeaders.Authorization).toBeUndefined();
    });

    it('returns parsed JSON data and headers', async () => {
      const responseHeaders = new Headers({ 'X-Custom': 'value' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: 'test' }),
        headers: responseHeaders,
      });

      const result = await apiFetch('/v1/test');
      expect(result.data).toEqual({ name: 'test' });
      expect(result.headers).toBe(responseHeaders);
    });

    it('throws ApiError on non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({ error: 'Record not found' }),
        headers: new Headers(),
      });

      await expect(apiFetch('/v1/missing')).rejects.toThrow(ApiError);

      try {
        await apiFetch('/v1/missing');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).status).toBe(404);
        expect((e as ApiError).error).toBe('Record not found');
      }
    });

    it('throws ApiError with statusText when JSON parse fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.reject(new Error('not json')),
        headers: new Headers(),
      });

      await expect(apiFetch('/v1/broken')).rejects.toThrow(ApiError);
    });

    it('includes error_description when available', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: () =>
          Promise.resolve({
            error: 'Validation failed',
            error_description: 'Username is too short',
          }),
        headers: new Headers(),
      });

      try {
        await apiFetch('/v1/validate');
      } catch (e) {
        expect((e as ApiError).description).toBe('Username is too short');
      }
    });

    it('prepends /api to paths', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
        headers: new Headers(),
      });

      await apiFetch('/v1/accounts/1');
      expect(mockFetch.mock.calls[0][0]).toBe('/api/v1/accounts/1');
    });
  });

  describe('parseLinkHeader', () => {
    it('returns empty object for null header', () => {
      expect(parseLinkHeader(null)).toEqual({});
    });

    it('returns empty object for empty string', () => {
      expect(parseLinkHeader('')).toEqual({});
    });

    it('parses next link', () => {
      const header =
        '<https://example.com/api/v1/timelines/home?max_id=123>; rel="next"';
      const result = parseLinkHeader(header);
      expect(result.next).toContain('/api/v1/timelines/home');
      expect(result.next).toContain('max_id=123');
    });

    it('parses prev link', () => {
      const header =
        '<https://example.com/api/v1/timelines/home?min_id=456>; rel="prev"';
      const result = parseLinkHeader(header);
      expect(result.prev).toContain('min_id=456');
    });

    it('parses both next and prev links', () => {
      const header =
        '<https://example.com/api/v1/timelines/home?max_id=123>; rel="next", <https://example.com/api/v1/timelines/home?min_id=456>; rel="prev"';
      const result = parseLinkHeader(header);
      expect(result.next).toBeDefined();
      expect(result.prev).toBeDefined();
    });
  });

  describe('buildQueryString', () => {
    it('returns empty string for empty params', () => {
      expect(buildQueryString({})).toBe('');
    });

    it('builds simple key=value pairs', () => {
      const result = buildQueryString({ limit: 20, local: true });
      expect(result).toContain('limit=20');
      expect(result).toContain('local=true');
      expect(result.startsWith('?')).toBe(true);
    });

    it('skips undefined values', () => {
      const result = buildQueryString({ limit: 20, max_id: undefined });
      expect(result).toBe('?limit=20');
    });

    it('handles array values with [] suffix', () => {
      const result = buildQueryString({ types: ['mention', 'follow'] });
      expect(result).toContain('types%5B%5D=mention');
      expect(result).toContain('types%5B%5D=follow');
    });
  });
});
