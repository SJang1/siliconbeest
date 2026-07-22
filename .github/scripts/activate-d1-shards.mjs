import { readFile } from 'node:fs/promises';
import process from 'node:process';

const manifestUrl = new URL('../../config/d1-shards.json', import.meta.url);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function cloudflare(databaseId, sql, params = []) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${required('CLOUDFLARE_ACCOUNT_ID')}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  const payload = await response.json();
  if (!response.ok || payload.success !== true) throw new Error(`D1 query failed: ${JSON.stringify(payload.errors ?? payload)}`);
  return payload.result;
}

function databaseId(shard) {
  if (shard.databaseId) return shard.databaseId;
  if (shard.databaseIdEnv) return required(shard.databaseIdEnv);
  throw new Error(`Missing database ID for ${shard.binding}`);
}

async function smoke(shard) {
  const targetDatabaseId = databaseId(shard);
  const smokeId = `activate:${shard.ordinal}`;
  await cloudflare(targetDatabaseId, 'CREATE TABLE IF NOT EXISTS _shard_deploy_smoke (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)');
  await cloudflare(
    targetDatabaseId,
    'INSERT OR REPLACE INTO _shard_deploy_smoke (id, created_at) VALUES (?1, CURRENT_TIMESTAMP)',
    [smokeId],
  );
  await cloudflare(targetDatabaseId, 'DELETE FROM _shard_deploy_smoke WHERE id = ?1', [smokeId]);
  const result = await cloudflare(targetDatabaseId, 'SELECT checksum FROM shard_schema_checksum WHERE singleton = 1');
  const rows = Array.isArray(result) ? result.flatMap((entry) => entry.results ?? []) : [];
  if (!rows.some((row) => row.checksum === shard.schemaChecksum)) {
    throw new Error(`Schema checksum mismatch for ${shard.binding}`);
  }
}

async function activate(controlDatabaseId, shard) {
  const current = await cloudflare(
    controlDatabaseId,
    `SELECT epoch, binding FROM shard_catalog
     WHERE family = ?1 AND cohort = ?2 AND state IN ('legacy', 'active')
     ORDER BY epoch DESC LIMIT 1`,
    [shard.family, shard.cohort],
  );
  const currentRows = Array.isArray(current) ? current.flatMap((entry) => entry.results ?? []) : [];
  const predecessor = currentRows[0];
  if (predecessor && Number(predecessor.epoch) > shard.epoch) return;

  await cloudflare(
    controlDatabaseId,
    `INSERT OR IGNORE INTO shard_catalog (
       family, cohort, epoch, ordinal, binding, state, shared_physical_database,
       schema_checksum, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, 'precreated', 0, ?6, CURRENT_TIMESTAMP)`,
    [shard.family, shard.cohort, shard.epoch, shard.ordinal, shard.binding, shard.schemaChecksum],
  );
  const activation = await cloudflare(
    controlDatabaseId,
    `UPDATE shard_catalog SET state = 'active', activated_at = CURRENT_TIMESTAMP
     WHERE family = ?1 AND cohort = ?2 AND epoch = ?3 AND ordinal = ?4
       AND binding = ?5 AND state = 'precreated'
       AND NOT EXISTS (
         SELECT 1 FROM shard_catalog current
         WHERE current.family = ?1 AND current.cohort = ?2
           AND current.state IN ('legacy', 'active') AND current.epoch >= ?3
       )`,
    [shard.family, shard.cohort, shard.epoch, shard.ordinal, shard.binding],
  );
  const activationRows = Array.isArray(activation) ? activation : [];
  const changed = activationRows.some((entry) => Number(entry?.meta?.changes ?? 0) > 0);
  const active = await cloudflare(
    controlDatabaseId,
    `SELECT 1 AS active FROM shard_catalog
     WHERE family = ?1 AND cohort = ?2 AND epoch = ?3 AND ordinal = ?4
       AND binding = ?5 AND state = 'active' LIMIT 1`,
    [shard.family, shard.cohort, shard.epoch, shard.ordinal, shard.binding],
  );
  const activeRows = Array.isArray(active) ? active.flatMap((entry) => entry.results ?? []) : [];
  if (!changed && activeRows.length === 0) {
    throw new Error(`CAS activation lost for ${shard.binding}; catalog contains a competing active epoch`);
  }
  await cloudflare(
    controlDatabaseId,
    `UPDATE shard_catalog SET state = 'draining'
     WHERE family = ?1 AND cohort = ?2 AND state IN ('legacy', 'active') AND epoch < ?3`,
    [shard.family, shard.cohort, shard.epoch],
  );
}

export async function activateRequestedShards({ dryRun = false } = {}) {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const candidates = manifest.shards.filter((shard) => shard.state === 'precreated' && shard.activationRequestedAt);
  const actions = [];
  for (const shard of candidates) {
    actions.push({ binding: shard.binding, ordinal: shard.ordinal, action: dryRun ? 'would-activate' : 'activate' });
    if (dryRun) continue;
    await smoke(shard);
    await activate(required('D1_DATABASE_ID'), shard);
  }
  process.stdout.write(`${JSON.stringify({ actions }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  activateRequestedShards({ dryRun: process.argv.includes('--dry-run') }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
