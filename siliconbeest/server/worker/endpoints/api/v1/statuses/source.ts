import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { env } from 'cloudflare:workers';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import {
  assertStatusMutationAllowedForRecord,
  type StatusMutationPermissionRecord,
} from '../../../../services/permissions';

type HonoEnv = { Variables: AppVariables };

interface StatusSourceRow extends StatusMutationPermissionRecord {
  id: string;
  account_id: string;
  text: string | null;
  content: string | null;
  content_warning: string | null;
  object_type: 'Note' | 'Article';
  title: string;
}

const app = new Hono<HonoEnv>();

// GET /api/v1/statuses/:id/source — get plaintext source of a status
app.get('/:id/source', authRequired, requireScope('read:statuses'), async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;

  const status = await env.DB_META_C000.prepare(
    `SELECT id, account_id, visibility, deleted_at, local, reblog_of_id,
            text, content_warning, content, object_type, title
     FROM statuses
     WHERE id = ?1`,
  )
    .bind(statusId)
    .first<StatusSourceRow>();

  if (!status) throw new AppError(404, 'Record not found');
  assertStatusMutationAllowedForRecord(status, currentAccountId, 'source');

  return c.json({
    id: status.id,
    object_type: status.object_type,
    title: status.title || '',
    article_summary: status.object_type === 'Article' ? status.content_warning || '' : '',
    text: status.text || status.content || '',
    spoiler_text: status.object_type === 'Article' ? '' : status.content_warning || '',
  });
});

export default app;
