import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { AppError } from '../../../../middleware/errorHandler';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';
import { getRules, getRule, createRule, updateRule, deleteRule } from '../../../../services/instance';
import type { RuleRow } from '../../../../types/db';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/rules — list all instance rules.
 */
app.get('/', async (c) => {
	const rules = await getRules();
	return c.json(rules.map(formatRule));
});

/**
 * GET /api/v1/admin/rules/:id — fetch single rule.
 */
app.get('/:id', async (c) => {
	const row = await getRule(c.req.param('id'));
	return c.json(formatRule(row));
});

/**
 * POST /api/v1/admin/rules — create a rule.
 */
app.post('/', async (c) => {
	const body = await c.req.json<{
		text: string;
		priority?: number;
	}>();

	if (!body.text) throw new AppError(422, 'text is required');

	const row = await createRule(body.text, body.priority);
	return c.json(formatRule(row), 200);
});

/**
 * PUT /api/v1/admin/rules/:id — update a rule.
 */
app.put('/:id', async (c) => {
	const body = await c.req.json<{
		text?: string;
		priority?: number;
	}>();

	const row = await updateRule(c.req.param('id'), body);
	return c.json(formatRule(row));
});

/**
 * DELETE /api/v1/admin/rules/:id — remove a rule.
 */
app.delete('/:id', async (c) => {
	await deleteRule(c.req.param('id'));
	return c.json({}, 200);
});

function formatRule(row: RuleRow) {
	return {
		id: row.id,
		text: row.text,
		priority: row.priority || 0,
		created_at: row.created_at,
		updated_at: row.updated_at || row.created_at,
	};
}

export default app;
