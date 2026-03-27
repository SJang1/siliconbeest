/**
 * CSV Import Endpoint
 *
 * Accepts a CSV file with account addresses and enqueues
 * import_item messages for asynchronous processing.
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { authRequired } from '../../../middleware/auth';
import { AppError } from '../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// POST /api/v1/import
// ---------------------------------------------------------------------------

app.post('/', authRequired, async (c) => {
  const account = c.get('currentAccount')!;

  const formData = await c.req.formData();
  const type = formData.get('type') as string | null;
  const file = formData.get('data') as File | null;

  if (!type || !['following', 'blocks', 'mutes'].includes(type)) {
    throw new AppError(422, 'Validation failed', 'type must be one of: following, blocks, mutes');
  }

  if (!file) {
    throw new AppError(422, 'Validation failed', 'data file is required');
  }

  const text = await file.text();
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

  // Skip header line if it looks like a CSV header
  const startIndex = lines.length > 0 && lines[0].toLowerCase().includes('account') ? 1 : 0;

  const accts: string[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Extract the first CSV column (account address)
    const parts = line.split(',');
    const acct = parts[0].trim().replace(/^@/, '');
    if (acct && acct.includes('@')) {
      accts.push(acct);
    } else if (acct) {
      // Local account without domain
      accts.push(acct);
    }
  }

  // Enqueue each account for import processing
  const messages = accts.map((acct) => ({
    body: {
      type: 'import_item' as const,
      acct,
      action: type as 'following' | 'blocks' | 'mutes',
      accountId: account.id,
    },
  }));

  // Send in batches of 100 (Cloudflare queue batch limit)
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    await c.env.QUEUE_INTERNAL.sendBatch(batch);
  }

  return c.json({ imported: accts.length });
});

export default app;
