/**
 * Inbox Processor: Flag (remote report)
 *
 * Handles incoming Flag activities from remote instances reporting
 * content or accounts on this instance.
 */

import { env } from 'cloudflare:workers';
import type { APActivity } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';
import { BaseProcessor } from './BaseProcessor';
import { authorizeFederatedReport } from '../../services/permissions';

class FlagProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<boolean> {
		const objects = activity.object;
		if (!objects) {
			console.warn('[flag] activity.object is missing');
			return false;
		}

		// Normalize to array of URIs
		const objectUris: string[] = [];
		if (typeof objects === 'string') {
			objectUris.push(objects);
		} else if (Array.isArray(objects)) {
			for (const obj of objects) {
				if (typeof obj === 'string') {
					objectUris.push(obj);
				} else if (
					obj
					&& typeof obj === 'object'
					&& 'id' in obj
					&& typeof obj.id === 'string'
					&& obj.id.length > 0
				) {
					objectUris.push(obj.id);
				}
			}
		}

		if (objectUris.length === 0) {
			console.warn('[flag] No object URIs found');
			return false;
		}

		const reporterAccountId = await this.resolveActor(activity.actor);
		if (!reporterAccountId) {
			console.error('[flag] Could not resolve reporting actor');
			return false;
		}

		const targetAccountUri = objectUris[0];
		const statusUris = objectUris.slice(1);

		const targetAccount = await this.findLocalAccountByUri(targetAccountUri);
		if (!targetAccount) {
			console.warn(`[flag] Target account not found locally: ${targetAccountUri}`);
			return false;
		}

		const authorization = await authorizeFederatedReport(
			reporterAccountId,
			targetAccount.id,
			this.recipientAccountId || null,
			statusUris,
		);
		if (!authorization) return false;

		const comment = (activity as APActivity & { content?: string }).content ?? '';
		const now = new Date().toISOString();
		const reportId = generateUlid();

		await env.DB_META_C000.prepare(
			`INSERT INTO reports
			 (id, account_id, target_account_id, status_ids, comment, category, forwarded, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, 'other', 1, ?6, ?7)`,
		)
			.bind(reportId, reporterAccountId, targetAccount.id,
				authorization.statusIds.length > 0
					? JSON.stringify(authorization.statusIds)
					: null,
				comment, now, now)
			.run();

		console.log(`[flag] Created report ${reportId} from ${activity.actor}`);
		return true;
	}
}

export async function processFlag(
	activity: APActivity,
	localAccountId: string,
): Promise<boolean> {
	return new FlagProcessor(localAccountId).process(activity);
}
