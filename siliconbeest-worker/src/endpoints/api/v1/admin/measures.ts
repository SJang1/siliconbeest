import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { authRequired, adminRequired } from '../../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

type MeasureKey =
	| 'active_users'
	| 'new_users'
	| 'interactions'
	| 'opened_reports'
	| 'resolved_reports';

/**
 * POST /api/v1/admin/measures — retrieve instance metrics.
 *
 * Body:
 *   keys: MeasureKey[]
 *   start_at: string (ISO date)
 *   end_at: string (ISO date)
 */
app.post('/', async (c) => {
	const body = await c.req.json<{
		keys: MeasureKey[];
		start_at: string;
		end_at: string;
	}>();

	if (!body.keys || !Array.isArray(body.keys) || body.keys.length === 0) {
		throw new AppError(422, 'keys is required');
	}
	if (!body.start_at || !body.end_at) {
		throw new AppError(422, 'start_at and end_at are required');
	}

	const startAt = body.start_at;
	const endAt = body.end_at;
	const db = c.env.DB;

	const measures = await Promise.all(
		body.keys.map(async (key) => {
			let total = 0;

			switch (key) {
				case 'active_users': {
					const row = await db
						.prepare(
							`SELECT COUNT(DISTINCT a.id) AS count FROM accounts a
							 JOIN users u ON u.account_id = a.id
							 WHERE u.current_sign_in_at >= ?1 AND u.current_sign_in_at <= ?2
							 AND a.domain IS NULL`,
						)
						.bind(startAt, endAt)
						.first();
					total = (row?.count as number) || 0;
					break;
				}

				case 'new_users': {
					const row = await db
						.prepare(
							`SELECT COUNT(*) AS count FROM users
							 WHERE created_at >= ?1 AND created_at <= ?2`,
						)
						.bind(startAt, endAt)
						.first();
					total = (row?.count as number) || 0;
					break;
				}

				case 'interactions': {
					const row = await db
						.prepare(
							`SELECT COUNT(*) AS count FROM statuses
							 WHERE created_at >= ?1 AND created_at <= ?2`,
						)
						.bind(startAt, endAt)
						.first();
					total = (row?.count as number) || 0;
					break;
				}

				case 'opened_reports': {
					const row = await db
						.prepare(
							`SELECT COUNT(*) AS count FROM reports
							 WHERE created_at >= ?1 AND created_at <= ?2`,
						)
						.bind(startAt, endAt)
						.first();
					total = (row?.count as number) || 0;
					break;
				}

				case 'resolved_reports': {
					const row = await db
						.prepare(
							`SELECT COUNT(*) AS count FROM reports
							 WHERE action_taken_at >= ?1 AND action_taken_at <= ?2`,
						)
						.bind(startAt, endAt)
						.first();
					total = (row?.count as number) || 0;
					break;
				}

				default:
					break;
			}

			return {
				key,
				unit: '',
				total: String(total),
				human_value: String(total),
				previous_total: '0',
				data: [],
			};
		}),
	);

	return c.json(measures);
});

export default app;
