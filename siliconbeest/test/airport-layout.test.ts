import { describe, it, expect } from 'vitest';
import {
	formatBytes,
	hashDomain,
	makeFleet,
	placeDestinations,
	vehicles,
} from '@/airport/lib/layout';

describe('airport layout helpers', () => {
	it('scales vehicle counts by digit count, capped', () => {
		expect(vehicles(0)).toBe(0);
		expect(vehicles(-3)).toBe(0);
		expect(vehicles(1)).toBe(1);
		expect(vehicles(9)).toBe(1);
		expect(vehicles(10)).toBe(2);
		expect(vehicles(99)).toBe(2);
		expect(vehicles(100)).toBe(3);
		expect(vehicles(1_000_000)).toBe(4); // default cap
		expect(vehicles(1_000_000, 6)).toBe(6);
	});

	it('formats bytes readably', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(2048)).toBe('2.0 KB');
		expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
	});

	it('spreads fleets with negative begins and mid-path freeze points', () => {
		const fleet = makeFleet(3, 30);
		expect(fleet).toHaveLength(3);
		for (const entry of fleet) {
			expect(entry.begin.startsWith('-')).toBe(true);
			const freeze = Number(entry.freeze);
			expect(freeze).toBeGreaterThan(0);
			expect(freeze).toBeLessThan(1);
		}
		expect(new Set(fleet.map((f) => f.begin)).size).toBe(3);
	});

	it('hashes domains stably', () => {
		expect(hashDomain('friendly.example')).toBe(hashDomain('friendly.example'));
		expect(hashDomain('friendly.example')).not.toBe(hashDomain('other.example'));
	});

	it('places destinations deterministically inside the region', () => {
		const region = { x: 660, y: 48, w: 460, h: 180 };
		const input = [
			{ domain: 'aaa.example', arrivals: 5, delayed: false },
			{ domain: 'bbb.example', arrivals: 120, delayed: true },
			{ domain: 'ccc.example', arrivals: 42, delayed: false },
		];

		const first = placeDestinations(input, region);
		const second = placeDestinations([...input].reverse(), region);

		// Same domains → same sky, regardless of input order.
		expect(first).toEqual(second);

		for (const spot of first) {
			expect(spot.x).toBeGreaterThanOrEqual(region.x);
			expect(spot.x).toBeLessThanOrEqual(region.x + region.w);
			expect(spot.y).toBeGreaterThanOrEqual(region.y);
			expect(spot.y).toBeLessThanOrEqual(region.y + region.h);
		}

		// Spots keep their minimum distance from each other.
		for (let i = 0; i < first.length; i++) {
			for (let j = i + 1; j < first.length; j++) {
				const dist = Math.hypot(first[i].x - first[j].x, first[i].y - first[j].y);
				expect(dist).toBeGreaterThanOrEqual(95);
			}
		}

		// Size reflects arrival digit count.
		const big = first.find((s) => s.domain === 'bbb.example');
		expect(big?.size).toBe(3);
		expect(big?.delayed).toBe(true);
	});
});
