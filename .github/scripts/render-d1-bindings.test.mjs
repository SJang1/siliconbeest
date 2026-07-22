import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBindingBudget } from './render-d1-bindings.mjs';
import { planGateways } from './plan-d1-binding-gateways.mjs';

test('keeps a metadata reserve and fails before the documented binding ceiling', () => {
  const entries = Array.from({ length: 4_000 }, (_, index) => ({ binding: `DB_${index}` }));
  const budget = validateBindingBudget(entries, {});
  assert.equal(budget.softLimit, 4_000);
  assert.equal(budget.calculatedMaximum, 5_000);
  assert.throws(
    () => validateBindingBudget([...entries, { binding: 'DB_OVER' }], {}),
    /operational soft limit/,
  );
});

test('splits physical ordinals into deterministic gateway manifests', () => {
  const manifest = {
    schemaVersion: 1,
    shards: Array.from({ length: 201 }, (_, index) => ({
      ordinal: index + 1,
      binding: `DB_${index + 1}`,
      databaseId: `id-${index + 1}`,
      databaseName: `db-${index + 1}`,
      state: 'active',
    })),
  };
  const plan = planGateways(manifest, 100);
  assert.equal(plan.gateways.length, 3);
  assert.equal(plan.gateways[0].ordinalStart, 1);
  assert.equal(plan.gateways[0].ordinalEnd, 100);
  assert.equal(plan.gateways[2].ordinalEnd, 201);
});
