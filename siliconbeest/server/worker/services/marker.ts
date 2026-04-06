/**
 * Marker Service
 *
 * Pure DB operations for reading position markers.
 */

import { env } from 'cloudflare:workers';
import type { MarkerRow } from '../types/db';

// ----------------------------------------------------------------
// Get markers
// ----------------------------------------------------------------

/**
 * Fetch markers for a user filtered by timeline names.
 */
export async function getMarkers(
	userId: string,
	timelines: string[],
): Promise<MarkerRow[]> {
	const placeholders = timelines.map(() => '?').join(', ');
	const { results } = await env.DB.prepare(`
		SELECT * FROM markers
		WHERE user_id = ?1 AND timeline IN (${placeholders})
	`).bind(userId, ...timelines).all();

	return (results ?? []) as unknown as MarkerRow[];
}

// ----------------------------------------------------------------
// Upsert marker
// ----------------------------------------------------------------

/**
 * Update or insert a marker for a given timeline.
 * Returns the resulting marker data.
 */
export async function upsertMarker(
	userId: string,
	timeline: string,
	lastReadId: string,
): Promise<{ last_read_id: string; version: number; updated_at: string }> {
	const now = new Date().toISOString();

	const existing = await env.DB.prepare(
		'SELECT id, version FROM markers WHERE user_id = ?1 AND timeline = ?2 LIMIT 1',
	).bind(userId, timeline).first<{ id: string; version: number }>();

	if (existing) {
		const newVersion = existing.version + 1;
		await env.DB.prepare(`
			UPDATE markers SET last_read_id = ?1, version = ?2, updated_at = ?3
			WHERE id = ?4
		`).bind(lastReadId, newVersion, now, existing.id).run();

		return { last_read_id: lastReadId, version: newVersion, updated_at: now };
	}

	const id = crypto.randomUUID();
	await env.DB.prepare(`
		INSERT INTO markers (id, user_id, timeline, last_read_id, version, updated_at)
		VALUES (?1, ?2, ?3, ?4, 0, ?5)
	`).bind(id, userId, timeline, lastReadId, now).run();

	return { last_read_id: lastReadId, version: 0, updated_at: now };
}
