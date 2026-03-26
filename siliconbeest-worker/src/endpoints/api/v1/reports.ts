import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { authRequired } from '../../../middleware/auth';
import { AppError } from '../../../middleware/errorHandler';
import { generateUlid } from '../../../utils/ulid';
import { buildFlagActivity } from '../../../federation/activityBuilder';
import { enqueueDelivery } from '../../../federation/deliveryManager';
import { notifyAdminsNewReport } from '../../../services/email';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const VALID_CATEGORIES = ['spam', 'violation', 'legal', 'other'];

const app = new Hono<HonoEnv>();

// POST /api/v1/reports — create a report
app.post('/', authRequired, async (c) => {
  const currentUser = c.get('currentUser')!;

  let body: {
    account_id?: string;
    status_ids?: string[];
    comment?: string;
    category?: string;
    forward?: boolean;
    rule_ids?: string[];
  };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  if (!body.account_id) {
    throw new AppError(422, 'Validation failed', 'account_id is required');
  }

  // Verify the target account exists
  const targetAccount = await c.env.DB.prepare(
    'SELECT id, username, domain, uri FROM accounts WHERE id = ?1',
  )
    .bind(body.account_id)
    .first();

  if (!targetAccount) {
    throw new AppError(404, 'Record not found');
  }

  const category = body.category || 'other';
  if (!VALID_CATEGORIES.includes(category)) {
    throw new AppError(422, 'Validation failed', 'Invalid category');
  }

  const reportId = generateUlid();
  const now = new Date().toISOString();
  const comment = body.comment || '';
  const statusIds = body.status_ids || [];
  const forwarded = body.forward ? 1 : 0;

  await c.env.DB.prepare(
    `INSERT INTO reports
       (id, account_id, target_account_id, status_ids, comment, category,
        action_taken, action_taken_at, action_taken_by_account_id, forwarded,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, NULL, ?7, ?8, ?8)`,
  )
    .bind(
      reportId,
      currentUser.account_id,
      body.account_id,
      JSON.stringify(statusIds),
      comment,
      category,
      forwarded,
      now,
    )
    .run();

  // Federation: forward report to remote instance if requested
  if (body.forward && targetAccount.domain) {
    try {
      const instanceActorUri = `https://${c.env.INSTANCE_DOMAIN}/actor`;
      // Resolve status URIs for the report
      let statusUrisList: string[] = [];
      if (statusIds.length > 0) {
        const placeholders = statusIds.map(() => '?').join(',');
        const { results } = await c.env.DB.prepare(
          `SELECT uri FROM statuses WHERE id IN (${placeholders})`,
        ).bind(...statusIds).all();
        statusUrisList = (results || []).map((r) => r.uri as string);
      }
      const targetUri = targetAccount.uri as string;
      // Deliver to the target instance's shared inbox
      const targetDomain = targetAccount.domain as string;
      const instance = await c.env.DB.prepare(
        'SELECT inbox_url FROM instances WHERE domain = ?1',
      ).bind(targetDomain).first();
      const targetInbox = instance?.inbox_url
        ? (instance.inbox_url as string)
        : `https://${targetDomain}/inbox`;
      const activity = buildFlagActivity(instanceActorUri, targetUri, statusUrisList, comment);
      await enqueueDelivery(c.env.QUEUE_FEDERATION, JSON.stringify(activity), targetInbox, 'instance');
    } catch (e) {
      console.error('Federation delivery failed for report forward:', e);
    }
  }

  // Notify admins about the new report
  try {
    const reporterAccount = c.get('currentAccount');
    const reporterAcct = reporterAccount?.username || 'unknown';
    const targetAcct = targetAccount.domain
      ? `${targetAccount.username}@${targetAccount.domain}`
      : (targetAccount.username as string);
    await notifyAdminsNewReport(
      { ...c.env, DB: c.env.DB },
      reporterAcct,
      targetAcct,
      comment,
      category,
    );
  } catch { /* admin notification failure should not block report */ }

  return c.json({
    id: reportId,
    action_taken: false,
    action_taken_at: null,
    category,
    comment,
    forwarded: !!forwarded,
    created_at: now,
    status_ids: statusIds,
    rule_ids: body.rule_ids || [],
    target_account: {
      id: body.account_id,
    },
  });
});

export default app;
