import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), '..');

describe('purpose-scoped Queue topology', () => {
  it('binds exactly one inbound Queue in the main Worker', async () => {
    const config = await readFile(resolve(root, 'siliconbeest/wrangler.jsonc'), 'utf8');
    expect(config.match(/"binding": "QUEUE_INBOX"/g)).toHaveLength(1);
    expect(config).not.toMatch(/QUEUE_INBOX_\d/);
    expect(config).not.toMatch(/siliconbeest-inbox-\d/);
  });

  it('consumes one inbound Queue and one inbound DLQ', async () => {
    const config = await readFile(
      resolve(root, 'siliconbeest-queue-consumer/wrangler.jsonc'),
      'utf8',
    );
    expect(config.match(/"queue": "siliconbeest-inbox"/g)).toHaveLength(2);
    expect(config.match(/"queue": "siliconbeest-inbox-dlq"/g)).toHaveLength(1);
    expect(config).not.toMatch(/siliconbeest-inbox-\d/);
  });
});
