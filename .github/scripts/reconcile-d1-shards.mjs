import { readFile, readdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { createHash } from 'node:crypto';

const FAMILIES = [
  'META', 'POSTS', 'GRAPH', 'INBOX', 'REMOTE_ACTORS', 'REMOTE_POSTS', 'SEARCH_FEED', 'OPS',
];
const GIB = 1024 ** 3;
const DEFAULT_D1_MAX_BYTES = 10_000_000_000;
const MANIFEST_PATH = new URL('../../config/d1-shards.json', import.meta.url);
const DEFAULT_ROLLOUT_PATH = new URL('../../config/d1-family-rollout.default.json', import.meta.url);
const FAMILY_MIGRATIONS_PATH = new URL('../../config/d1-family-migrations/', import.meta.url);

const LEGACY_SPLIT_FAMILIES = FAMILIES.filter((family) => family !== 'META');

export function parseShardLimits(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('D1_SHARD_LIMITS_GIB_JSON must contain valid JSON');
  }
  for (const family of FAMILIES) {
    const value = parsed[family];
    if (!value || typeof value !== 'object') throw new Error(`Missing shard limits for ${family}`);
    const maxBytes = Number.isFinite(value.maxBytes) ? value.maxBytes : DEFAULT_D1_MAX_BYTES;
    const ratioMode = value.precreateRatio !== undefined
      || value.activateRatio !== undefined
      || value.hardStopRatio !== undefined;
    const precreateBytes = ratioMode ? maxBytes * value.precreateRatio : value.precreate * GIB;
    const activateBytes = ratioMode ? maxBytes * value.activateRatio : value.activate * GIB;
    const hardStopBytes = ratioMode ? maxBytes * value.hardStopRatio : value.hardStop * GIB;
    if (!Number.isFinite(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_D1_MAX_BYTES
      || !Number.isFinite(precreateBytes) || precreateBytes <= 0
      || !Number.isFinite(activateBytes) || precreateBytes > activateBytes
      || !Number.isFinite(hardStopBytes) || activateBytes >= hardStopBytes
      || hardStopBytes >= maxBytes) {
      throw new Error(`Invalid shard limits for ${family}: require 0 < precreate <= activate < hardStop < maxBytes`);
    }
    parsed[family] = {
      maxBytes,
      precreateBytes: Math.floor(precreateBytes),
      activateBytes: Math.floor(activateBytes),
      hardStopBytes: Math.floor(hardStopBytes),
    };
  }
  return parsed;
}

export function parseFamilyRollout(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('D1_FAMILY_ROLLOUT_JSON must contain valid JSON');
  }
  if (parsed?.schemaVersion !== 1) throw new Error('D1 family rollout schemaVersion must be 1');
  if (!Array.isArray(parsed.legacySplitOrder)
    || parsed.legacySplitOrder.length !== LEGACY_SPLIT_FAMILIES.length
    || new Set(parsed.legacySplitOrder).size !== LEGACY_SPLIT_FAMILIES.length
    || LEGACY_SPLIT_FAMILIES.some((family) => !parsed.legacySplitOrder.includes(family))) {
    throw new Error(`legacySplitOrder must contain each non-META family exactly once`);
  }
  if (!Array.isArray(parsed.readyFamilies)
    || parsed.readyFamilies.some((family) => !LEGACY_SPLIT_FAMILIES.includes(family))) {
    throw new Error('readyFamilies may only contain known non-META families');
  }
  if (!Number.isInteger(parsed.maxLegacySplitsPerRun)
    || parsed.maxLegacySplitsPerRun < 1
    || parsed.maxLegacySplitsPerRun > LEGACY_SPLIT_FAMILIES.length) {
    throw new Error('maxLegacySplitsPerRun must be an integer between 1 and 7');
  }
  return {
    schemaVersion: 1,
    legacySplitOrder: parsed.legacySplitOrder,
    readyFamilies: [...new Set(parsed.readyFamilies)],
    maxLegacySplitsPerRun: parsed.maxLegacySplitsPerRun,
  };
}

export function selectNextLegacySplitFamily(manifest, rollout, cohort = 0) {
  const ready = new Set(rollout.readyFamilies);
  for (const family of rollout.legacySplitOrder) {
    if (!ready.has(family)) continue;
    const familyShards = manifest.shards.filter((shard) => shard.family === family && shard.cohort === cohort);
    const deployed = familyShards.some((shard) => shard.ordinal > 0
      && ['active', 'draining', 'sealed'].includes(shard.state));
    if (deployed) continue;
    const pending = familyShards.find((shard) => shard.ordinal > 0 && shard.state === 'precreated');
    const legacy = familyShards.find((shard) => shard.ordinal === 0
      && ['legacy', 'active', 'draining'].includes(shard.state));
    if (!legacy) continue;
    return { family, legacy, pending };
  }
  return null;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function cloudflare(path, init = {}) {
  const accountId = required('CLOUDFLARE_ACCOUNT_ID');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok || payload.success !== true) {
    throw new Error(`Cloudflare API ${response.status}: ${JSON.stringify(payload.errors ?? payload)}`);
  }
  return payload.result;
}

function resolveDatabaseId(shard) {
  if (shard.databaseId) return shard.databaseId;
  if (shard.databaseIdEnv) return required(shard.databaseIdEnv);
  throw new Error(`Shard ${shard.binding} has no database ID`);
}

function nextName(prefix, family, cohort, epoch) {
  return `${prefix}-${family.toLowerCase().replaceAll('_', '-')}-c${String(cohort).padStart(3, '0')}-e${String(epoch).padStart(3, '0')}`;
}

async function findOrCreateDatabase(databaseName) {
  const matches = await cloudflare(`/d1/database?name=${encodeURIComponent(databaseName)}`);
  const existing = Array.isArray(matches)
    ? matches.find((database) => database.name === databaseName)
    : undefined;
  if (existing) return existing;
  return cloudflare('/d1/database', {
    method: 'POST',
    body: JSON.stringify({ name: databaseName }),
  });
}

async function applyFamilyMigrations(databaseId, family) {
  const directory = new URL(`${family}/`, FAMILY_MIGRATIONS_PATH);
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`No D1 migrations registered for ${family}`);
  for (const file of files) {
    const sql = await readFile(new URL(file, directory), 'utf8');
    await cloudflare(`/d1/database/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql }),
    });
  }
  const checksum = createHash('sha256');
  for (const file of files) checksum.update(file).update('\0').update(await readFile(new URL(file, directory), 'utf8')).update('\0');
  const schemaChecksum = checksum.digest('hex');
  await cloudflare(`/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      sql: `CREATE TABLE IF NOT EXISTS shard_schema_checksum (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), checksum TEXT NOT NULL, updated_at TEXT NOT NULL);
            INSERT OR REPLACE INTO shard_schema_checksum (singleton, checksum, updated_at) VALUES (1, ?1, CURRENT_TIMESTAMP)`,
      params: [schemaChecksum],
    }),
  });
  return { files, schemaChecksum };
}

async function markShardReadOnly(shard) {
  const controlDatabaseId = required('D1_DATABASE_ID');
  await cloudflare(`/d1/database/${controlDatabaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      sql: `UPDATE shard_catalog
            SET state = 'sealed'
            WHERE family = ?1 AND cohort = ?2 AND epoch = ?3
              AND state IN ('legacy', 'active')`,
      params: [shard.family, shard.cohort, shard.epoch],
    }),
  });
}

async function syncManifestLifecycle(manifest) {
  const result = await cloudflare(`/d1/database/${required('D1_DATABASE_ID')}/query`, {
    method: 'POST',
    body: JSON.stringify({
      sql: `SELECT family, cohort, epoch, ordinal, binding, state
            FROM shard_catalog WHERE ordinal > 0`,
    }),
  });
  const rows = Array.isArray(result) ? result.flatMap((entry) => entry.results ?? []) : [];
  for (const row of rows) {
    const shard = manifest.shards.find((candidate) => candidate.ordinal === Number(row.ordinal)
      && candidate.family === row.family && candidate.binding === row.binding);
    if (!shard) continue;
    shard.state = row.state;
    if (row.state === 'active') delete shard.activationRequestedAt;
  }
}

function findPrecreated(manifest, shard) {
  return manifest.shards.find((candidate) => candidate.family === shard.family
    && candidate.cohort === shard.cohort
    && candidate.epoch > shard.epoch
    && candidate.state === 'precreated');
}

async function provisionNextShard({ manifest, shard, prefix, actions, provision }) {
  const precreated = findPrecreated(manifest, shard);
  if (precreated) return precreated;
  const epoch = shard.epoch + 1;
  const ordinal = manifest.nextPhysicalOrdinal;
  const databaseName = nextName(prefix, shard.family, shard.cohort, epoch);
  actions.push({ action: 'precreate', family: shard.family, cohort: shard.cohort, epoch, ordinal, databaseName });
  if (!provision) return null;
  const created = await findOrCreateDatabase(databaseName);
  const migrationResult = await applyFamilyMigrations(created.uuid, shard.family);
  const createdShard = {
    family: shard.family,
    cohort: shard.cohort,
    epoch,
    ordinal,
    binding: `DB_${shard.family}_C${String(shard.cohort).padStart(3, '0')}_E${String(epoch).padStart(3, '0')}`,
    databaseName,
    databaseId: created.uuid,
    migrations: migrationResult.files,
    schemaChecksum: migrationResult.schemaChecksum,
    state: 'precreated',
  };
  manifest.shards.push(createdShard);
  manifest.nextPhysicalOrdinal += 1;
  return createdShard;
}

export async function reconcile({ provision }) {
  const limits = parseShardLimits(required('D1_SHARD_LIMITS_GIB_JSON'));
  const rollout = parseFamilyRollout(process.env.D1_FAMILY_ROLLOUT_JSON
    || await readFile(DEFAULT_ROLLOUT_PATH, 'utf8'));
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  await syncManifestLifecycle(manifest);
  const prefix = process.env.PROJECT_PREFIX || 'siliconbeest';
  const active = manifest.shards.filter((shard) => shard.state === 'active' || shard.state === 'legacy');
  const actions = [];
  const databaseCache = new Map();
  const processedDatabaseIds = new Set();
  let legacySplitsPlanned = 0;

  for (const shard of active) {
    const databaseId = resolveDatabaseId(shard);
    if (processedDatabaseIds.has(databaseId)) continue;
    processedDatabaseIds.add(databaseId);
    let database = databaseCache.get(databaseId);
    if (!database) {
      database = await cloudflare(`/d1/database/${databaseId}`);
      databaseCache.set(databaseId, database);
    }
    const sizeBytes = Number(database.file_size ?? 0);
    const physicalAliases = shard.sharedPhysicalDatabase
      ? active.filter((candidate) => resolveDatabaseId(candidate) === databaseId)
      : [shard];
    const threshold = physicalAliases
      .map((candidate) => limits[candidate.family])
      .reduce((lowest, candidate) => candidate.activateBytes < lowest.activateBytes ? candidate : lowest);
    const utilization = sizeBytes / threshold.maxBytes;
    if (sizeBytes >= threshold.hardStopBytes) {
      actions.push({ action: 'hard-stop', binding: shard.binding, physicalAliases: physicalAliases.map((alias) => alias.family), sizeBytes, utilization, thresholdBytes: threshold.hardStopBytes });
      if (provision) await Promise.all(physicalAliases.map((alias) => markShardReadOnly(alias)));
    }

    const isSharedLegacy = physicalAliases.some((candidate) => candidate.sharedPhysicalDatabase && candidate.ordinal === 0);
    let rotationSource = shard;
    if (isSharedLegacy) {
      if (legacySplitsPlanned >= rollout.maxLegacySplitsPerRun) continue;
      const next = selectNextLegacySplitFamily(manifest, rollout, shard.cohort);
      if (!next) continue;
      rotationSource = next.legacy;
      legacySplitsPlanned += 1;
    }

    const precreated = findPrecreated(manifest, rotationSource);
    if (precreated && sizeBytes >= threshold.activateBytes && !precreated.activationRequestedAt) {
      precreated.activationRequestedAt = new Date().toISOString();
      actions.push({ action: 'request-activation', binding: precreated.binding, previousBinding: rotationSource.binding, sizeBytes, utilization, thresholdBytes: threshold.activateBytes });
    }
    if (sizeBytes < threshold.precreateBytes) continue;
    if (precreated) continue;
    await provisionNextShard({ manifest, shard: rotationSource, prefix, actions, provision });
  }

  if (provision) await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ provision, actions }, null, 2)}\n`);
  if (actions.some((action) => action.action === 'hard-stop')) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  reconcile({ provision: process.argv.includes('--provision') }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
