import { createMiddleware } from 'hono/factory';
import type { AppVariables } from '../types';
import {
	recordContributionEvent,
	type ContributionEvent,
} from '../services/contribution';

type MiddlewareEnv = { Variables: AppVariables };

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const EXCLUDED_PREFIXES = [
	'/api/v1/admin',
	'/api/v1/auth',
	'/api/v1/invites',
	'/api/v1/invitations',
	'/api/v1/registration',
	'/api/v1/setup',
];
const EXCLUDED_EXACT_PATHS = new Set([
	'/api/v1/accounts',
	'/api/v1/accounts/change_password',
	'/api/v1/apps',
]);

function isExcludedPath(path: string): boolean {
	return EXCLUDED_EXACT_PATHS.has(path)
		|| EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function classifyContributionEvent(
	method: string,
	path: string,
	statusIsReply = false,
): ContributionEvent | null {
	if (!MUTATION_METHODS.has(method) || isExcludedPath(path)) return null;
	if (!path.startsWith('/api/v1/') && !path.startsWith('/api/v2/')) return null;

	if (method === 'POST' && path === '/api/v1/statuses') {
		return statusIsReply ? 'reply_create' : 'status_create';
	}
	if (method === 'DELETE' && /^\/api\/v1\/statuses\/[^/]+$/.test(path)) return 'status_delete';
	if (method === 'POST' && /^\/api\/v1\/statuses\/[^/]+\/reblog$/.test(path)) return 'status_reblog';
	if (method === 'POST' && /^\/api\/v1\/statuses\/[^/]+\/unreblog$/.test(path)) return 'status_unreblog';
	if (method === 'POST' && /^\/api\/v1\/statuses\/[^/]+\/favourite$/.test(path)) return 'status_favourite';
	if (method === 'POST' && /^\/api\/v1\/statuses\/[^/]+\/unfavourite$/.test(path)) return 'status_unfavourite';
	if (method === 'POST' && /^\/api\/v1\/statuses\/[^/]+\/bookmark$/.test(path)) return 'status_bookmark';
	if (method === 'POST' && /^\/api\/v1\/statuses\/[^/]+\/unbookmark$/.test(path)) return 'status_unbookmark';
	if (method === 'POST' && /^\/api\/v1\/accounts\/[^/]+\/follow$/.test(path)) return 'account_follow';
	if (method === 'POST' && /^\/api\/v1\/accounts\/[^/]+\/unfollow$/.test(path)) return 'account_unfollow';
	if (method === 'POST' && /^\/api\/v1\/polls\/[^/]+\/votes$/.test(path)) return 'poll_vote';
	if (method === 'POST' && (path === '/api/v1/media' || path === '/api/v2/media')) return 'media_upload';
	if (method === 'PATCH' && path === '/api/v1/accounts/update_credentials') return 'profile_update';
	if (method === 'POST' && path === '/api/v1/reports') return 'report_submit';
	if (method === 'POST' && path === '/api/v1/lists') return 'list_create';
	if (method === 'DELETE' && /^\/api\/v1\/lists\/[^/]+$/.test(path)) return 'list_delete';

	return 'generic_mutation';
}

async function isStatusReply(request: Request): Promise<boolean> {
	try {
		const body = await request.clone().json<{ in_reply_to_id?: string | null }>();
		return typeof body.in_reply_to_id === 'string' && body.in_reply_to_id.length > 0;
	} catch {
		return false;
	}
}

export const contributionMiddleware = createMiddleware<MiddlewareEnv>(async (c, next) => {
	const method = c.req.method.toUpperCase();
	const path = c.req.path;
	if (!MUTATION_METHODS.has(method) || isExcludedPath(path)) {
		await next();
		return;
	}

	const statusIsReply = method === 'POST' && path === '/api/v1/statuses'
		? await isStatusReply(c.req.raw)
		: false;

	await next();

	if (c.res.status < 200 || c.res.status >= 300) return;
	if (c.get('contributionApplied') === false) return;
	const currentUser = c.get('currentUser');
	if (!currentUser) return;
	const event = classifyContributionEvent(method, path, statusIsReply);
	if (!event) return;
	// The generic fallback spans many idempotent endpoints. Require those
	// handlers to positively report a persisted state change; a plain 2xx is
	// not enough evidence and would let repeated no-op requests farm points.
	if (event === 'generic_mutation' && c.get('contributionApplied') !== true) return;

	try {
		await recordContributionEvent(currentUser.account_id, event, {
			requestId: c.get('requestId'),
			method,
			path,
		});
	} catch (error) {
		console.error('Unable to record contribution event', {
			event,
			accountId: currentUser.account_id,
			error,
		});
	}
});
