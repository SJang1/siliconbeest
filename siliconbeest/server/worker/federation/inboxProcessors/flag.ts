/**
 * Inbox Processor: Flag (remote report)
 *
 * Handles incoming Flag activities from remote instances reporting
 * content or accounts on this instance.
 */

import type { Env } from '../../env';
import type { APActivity } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';
import { BaseProcessor } from './BaseProcessor';

class FlagProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<void> {
		const objects = activity.object;
		if (!objects) {
			console.warn('[flag] activity.object is missing');
			return;
		}

		// Normalize to array of URIs
		const objectUris: string[] = [];
		if (typeof objects === 'string') {
			objectUris.push(objects);
		} else if (Array.isArray(objects)) {
			for (const obj of objects) {
				if (typeof obj === 'string') {
					objectUris.push(obj);
				} else if (obj && typeof obj === 'object' && 'id' in obj && obj.id) {
					objectUris.push(obj.id as string);
				}
			}
		}

		if (objectUris.length === 0) {
			console.warn('[flag] No object URIs found');
			return;
		}

		const reporterAccountId = await this.resolveActor(activity.actor);
		if (!reporterAccountId) {
			console.error('[flag] Could not resolve reporting actor');
			return;
		}

		const targetAccountUri = objectUris[0];
		const statusUris = objectUris.slice(1);

		const targetAccount = await this.findLocalAccountByUri(targetAccountUri);
		if (!targetAccount) {
			console.warn(`[flag] Target account not found locally: ${targetAccountUri}`);
			return;
		}

		// Resolve status IDs
		const statusIds: string[] = [];
		for (const uri of statusUris) {
			const status = await this.findStatusByUri(uri);
			if (status) statusIds.push(status.id);
		}

		const comment = (activity as APActivity & { content?: string }).content ?? '';
		const now = new Date().toISOString();
		const reportId = generateUlid();

		await this.env.DB.prepare(
			`INSERT INTO reports
			 (id, account_id, target_account_id, status_ids, comment, category, forwarded, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, 'other', 1, ?6, ?7)`,
		)
			.bind(reportId, reporterAccountId, targetAccount.id,
				statusIds.length > 0 ? JSON.stringify(statusIds) : null,
				comment, now, now)
			.run();

		console.log(`[flag] Created report ${reportId} from ${activity.actor}`);
	}
}

export async function processFlag(
	activity: APActivity,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	await new FlagProcessor(env).process(activity);
}
