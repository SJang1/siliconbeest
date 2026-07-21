import { describe, expect, it } from 'vitest';
import { getInstanceThumbnailUrl } from '../../server/worker/services/instance';

const DOMAIN = 'test.siliconbeest.local';
const DEFAULT_THUMBNAIL_URL = `https://${DOMAIN}/thumbnail.png`;

describe('getInstanceThumbnailUrl', () => {
	it('prefers site_logo_url over the legacy thumbnail_url', () => {
		expect(getInstanceThumbnailUrl({
			site_logo_url: 'https://cdn.example.com/current.png',
			thumbnail_url: 'https://cdn.example.com/legacy.png',
		}, DOMAIN)).toBe('https://cdn.example.com/current.png');
	});

	it('uses the legacy thumbnail_url only when site_logo_url is absent', () => {
		expect(getInstanceThumbnailUrl({
			thumbnail_url: 'https://cdn.example.com/legacy.png',
		}, DOMAIN)).toBe('https://cdn.example.com/legacy.png');
	});

	it('does not restore the legacy thumbnail when site_logo_url was explicitly cleared', () => {
		expect(getInstanceThumbnailUrl({
			site_logo_url: '',
			thumbnail_url: 'https://cdn.example.com/legacy.png',
		}, DOMAIN)).toBe(DEFAULT_THUMBNAIL_URL);
	});

	it.each([
		['/images/logo.png', `https://${DOMAIN}/images/logo.png`],
		['branding/logo.png', `https://${DOMAIN}/branding/logo.png`],
	])('resolves relative URL %s against the instance domain', (configuredUrl, expectedUrl) => {
		expect(getInstanceThumbnailUrl({ site_logo_url: configuredUrl }, DOMAIN)).toBe(expectedUrl);
	});

	it('keeps an absolute HTTP URL unchanged', () => {
		expect(getInstanceThumbnailUrl({
			site_logo_url: 'http://assets.example.com/logo.png',
		}, DOMAIN)).toBe('http://assets.example.com/logo.png');
	});

	it.each(['https://', 'data:image/png;base64,abc'])('falls back for invalid thumbnail URL %s', (configuredUrl) => {
		expect(getInstanceThumbnailUrl({ site_logo_url: configuredUrl }, DOMAIN)).toBe(DEFAULT_THUMBNAIL_URL);
	});
});
