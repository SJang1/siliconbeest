import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const sourceUrl = new URL('config/d1-shards.json', root);
const outputUrl = new URL('config/d1-binding-gateways.json', root);

export function planGateways(manifest, maxBindings = 4_000) {
  if (!Number.isInteger(maxBindings) || maxBindings < 100 || maxBindings > 4_000) {
    throw new Error('Gateway max bindings must be between 100 and 4000');
  }
  const physical = [...new Map(manifest.shards
    .filter((shard) => shard.ordinal > 0 && shard.state !== 'unavailable')
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((shard) => [shard.ordinal, shard])).values()];
  const gateways = [];
  for (let offset = 0; offset < physical.length; offset += maxBindings) {
    const shards = physical.slice(offset, offset + maxBindings);
    gateways.push({
      gateway: `d1-shard-gateway-${String(gateways.length).padStart(3, '0')}`,
      ordinalStart: shards[0]?.ordinal ?? null,
      ordinalEnd: shards.at(-1)?.ordinal ?? null,
      bindings: shards.map(({ ordinal, binding, databaseId, databaseName }) => ({
        ordinal, binding, databaseId, databaseName,
      })),
    });
  }
  return {
    schemaVersion: 1,
    maxBindingsPerGateway: maxBindings,
    generatedFromShardSchemaVersion: manifest.schemaVersion,
    gateways,
  };
}

export async function writeGatewayPlan() {
  const manifest = JSON.parse(await readFile(sourceUrl, 'utf8'));
  const maxBindings = Number(process.env.D1_BINDING_SOFT_LIMIT || 4_000);
  const plan = planGateways(manifest, maxBindings);
  await writeFile(outputUrl, `${JSON.stringify(plan, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  writeGatewayPlan().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
