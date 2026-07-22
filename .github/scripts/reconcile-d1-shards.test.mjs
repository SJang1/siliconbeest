import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  parseFamilyRollout,
  parseShardLimits,
  selectNextLegacySplitFamily,
} from './reconcile-d1-shards.mjs';

const families = ['META', 'POSTS', 'GRAPH', 'INBOX', 'REMOTE_ACTORS', 'REMOTE_POSTS', 'SEARCH_FEED', 'OPS'];

test('accepts service-specific limits for every family', () => {
  const value = Object.fromEntries(families.map((family, index) => [
    family,
    { maxBytes: 10_000_000_000, precreateRatio: 0.4, activateRatio: 0.5 + index * 0.01, hardStopRatio: 0.9 },
  ]));
  const parsed = parseShardLimits(JSON.stringify(value));
  assert.equal(parsed.META.activateBytes, 5_000_000_000);
  assert.equal(parsed.POSTS.maxBytes, 10_000_000_000);
});

test('fails closed for missing families and unsafe ordering', () => {
  assert.throws(() => parseShardLimits('{"META":{}}'), /Invalid shard limits|Missing shard limits/);
  const value = Object.fromEntries(families.map((family) => [
    family,
    { maxBytes: 10_000_000_000, precreateRatio: 0.9, activateRatio: 0.8, hardStopRatio: 0.97 },
  ]));
  assert.throws(() => parseShardLimits(JSON.stringify(value)), /Invalid shard limits/);
});

test('registers every legacy family alias and a family migration', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../config/d1-shards.json', import.meta.url), 'utf8'));
  for (const family of families) {
    const legacy = manifest.shards.find((shard) =>
      shard.family === family && shard.cohort === 0 && shard.epoch === 0 && shard.ordinal === 0);
    assert.equal(legacy?.binding, 'DB_META_C000');
    await access(new URL(`../../config/d1-family-migrations/${family}/0001_family_schema.sql`, import.meta.url));
  }
});

test('splits one ready legacy family at a time in the configured order', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../config/d1-shards.json', import.meta.url), 'utf8'));
  const rollout = parseFamilyRollout(await readFile(
    new URL('../../config/d1-family-rollout.default.json', import.meta.url),
    'utf8',
  ));
  rollout.readyFamilies = [...rollout.legacySplitOrder];
  assert.equal(selectNextLegacySplitFamily(manifest, rollout)?.family, 'POSTS');
  manifest.shards.push({
    family: 'POSTS', cohort: 0, epoch: 1, ordinal: 1,
    binding: 'DB_POSTS_C000_E001', state: 'active',
  });
  assert.equal(selectNextLegacySplitFamily(manifest, rollout)?.family, 'REMOTE_POSTS');
});

test('waits for a precreated family before considering the next legacy family', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../config/d1-shards.json', import.meta.url), 'utf8'));
  const rollout = parseFamilyRollout(await readFile(
    new URL('../../config/d1-family-rollout.default.json', import.meta.url),
    'utf8',
  ));
  rollout.readyFamilies = [...rollout.legacySplitOrder];
  manifest.shards.push({
    family: 'POSTS', cohort: 0, epoch: 1, ordinal: 1,
    binding: 'DB_POSTS_C000_E001', state: 'precreated',
  });
  const selected = selectNextLegacySplitFamily(manifest, rollout);
  assert.equal(selected?.family, 'POSTS');
  assert.equal(selected?.pending?.ordinal, 1);
});

test('rejects rollout orders that omit or duplicate a family', () => {
  assert.throws(() => parseFamilyRollout(JSON.stringify({
    schemaVersion: 1,
    maxLegacySplitsPerRun: 1,
    legacySplitOrder: ['POSTS', 'POSTS'],
    readyFamilies: ['POSTS'],
  })), /legacySplitOrder/);
});
