import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

interface StatusSourceRow {
  id: string;
  text: string | null;
  content: string | null;
  content_warning: string | null;
}

const app = new Hono<HonoEnv>();

// GET /api/v1/statuses/:id/source — get plaintext source of a status
app.get('/:id/source', authRequired, async (c) => {
  const statusId = c.req.param('id');

  const status = await c.env.DB.prepare(
    `SELECT id, text, content_warning, content FROM statuses
     WHERE id = ?1 AND deleted_at IS NULL`,
  )
    .bind(statusId)
    .first<StatusSourceRow>();

  if (!status) throw new AppError(404, 'Record not found');

  return c.json({
    id: status.id,
    text: status.text || status.content || '',
    spoiler_text: status.content_warning || '',
  });
});

export default app;
