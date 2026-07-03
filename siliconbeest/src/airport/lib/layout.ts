/**
 * Pure, deterministic helpers for the /airport scene.
 *
 * Nothing here may use Math.random(), Date.now() or any other
 * non-deterministic input: the SVG is rendered on the server and hydrated
 * on the client, and both must produce identical markup for the same data.
 */

/**
 * Digit-based vehicle scaling (from the reference train-map article):
 * 1–9 → 1 vehicle, 10–99 → 2, … capped at `max`. Log scaling keeps the
 * scene calm — it only changes when a number gains a digit.
 */
export function vehicles(n: number, max = 4): number {
	return n <= 0 ? 0 : Math.min(max, Math.floor(Math.log10(n)) + 1);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = -1;
	do {
		value /= 1024;
		unit++;
	} while (value >= 1024 && unit < units.length - 1);
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** djb2 string hash — stable across runs and platforms. */
export function hashDomain(domain: string): number {
	let h = 5381;
	for (let i = 0; i < domain.length; i++) {
		h = ((h << 5) + h + domain.charCodeAt(i)) >>> 0;
	}
	return h;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface DestinationInput {
	domain: string;
	arrivals: number;
	delayed: boolean;
}

export interface DestinationSpot extends DestinationInput {
	x: number;
	y: number;
	/** 1..3 — digit count of arrivals, used for the airport glyph size. */
	size: number;
}

const GOLDEN_ANGLE = 2.39996322972865332;

/**
 * Place destination airports deterministically inside `region`.
 * The base position comes from the domain hash, so the same domain always
 * lands on the same spot; overlapping spots step outward along a spiral
 * whose start angle also derives from the hash. Same domains → same sky.
 */
export function placeDestinations(
	destinations: DestinationInput[],
	region: Rect,
	minDist = 95,
): DestinationSpot[] {
	const placed: DestinationSpot[] = [];
	// Placement order is sorted by domain so the result does not depend on
	// the (traffic-ranked) API ordering.
	const sorted = [...destinations].sort((a, b) => a.domain.localeCompare(b.domain));

	const wrap = (v: number, size: number) => ((v % size) + size) % size;

	for (const dest of sorted) {
		const h = hashDomain(dest.domain);
		const baseX = ((h % 997) / 997) * region.w;
		const baseY = ((Math.floor(h / 997) % 613) / 613) * region.h;
		const startAngle = ((h % 360) * Math.PI) / 180;

		let x = region.x + baseX;
		let y = region.y + baseY;
		let step = 0;
		while (
			placed.some((p) => Math.hypot(p.x - x, p.y - y) < minDist) &&
			step < 64
		) {
			step++;
			const angle = startAngle + step * GOLDEN_ANGLE;
			const radius = 16 * step;
			x = region.x + wrap(baseX + radius * Math.cos(angle), region.w);
			y = region.y + wrap(baseY + radius * Math.sin(angle), region.h);
		}
		placed.push({ ...dest, x, y, size: vehicles(dest.arrivals, 3) });
	}

	return placed;
}

export interface FleetEntry {
	/** Negative begin offset — the vehicle was "already flying" on load. */
	begin: string;
	dur: string;
	/** Path fraction where the vehicle parks under prefers-reduced-motion. */
	freeze: string;
}

/**
 * Spread `count` vehicles evenly along a looped path of `durSeconds`.
 * Negative begins avoid the SMIL pitfall where a positive offset leaves the
 * vehicle sitting at the SVG origin until its start time.
 */
export function makeFleet(count: number, durSeconds: number): FleetEntry[] {
	return Array.from({ length: count }, (_, i) => ({
		begin: `-${((i * durSeconds) / count).toFixed(1)}s`,
		dur: `${durSeconds}s`,
		freeze: ((i + 0.5) / count).toFixed(3),
	}));
}
