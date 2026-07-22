import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  resolveStreamingTopology,
  stableStreamingLeaf,
} from '../../../packages/shared/utils/streamingTopology';
import { mergeRealtimeFeedEntries } from '../../server/worker/services/realtimeFeed';

describe('real-time scale topology', () => {
  it('keeps every tree node below the six-connection limit', () => {
    const topology = resolveStreamingTopology({});
    expect(topology).toMatchObject({
      branchFactor: 5,
      depth: 3,
      leafCount: 125,
      publicLeafMaxSockets: 400,
    });
    expect(topology.branchFactor).toBeLessThan(6);
    expect(topology.leafCount * topology.publicLeafMaxSockets).toBe(50_000);
    expect(stableStreamingLeaf('same-user', topology.leafCount)).toBe(
      stableStreamingLeaf('same-user', topology.leafCount),
    );
  });

  it('caps sockets per leaf before accepting another connection', async () => {
    const stub = env.STREAMING_DO.getByName('socket-cap-test');
    const sockets: WebSocket[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await stub.fetch('https://example.test/?stream=direct', {
        headers: {
          Upgrade: 'websocket',
          'X-Siliconbeest-Allowed-Streams': JSON.stringify(['direct']),
          'X-Siliconbeest-Socket-Limit': '4',
        },
      });
      expect(response.status).toBe(101);
      if (!response.webSocket) throw new Error('Expected WebSocket');
      response.webSocket.accept();
      sockets.push(response.webSocket);
    }
    const overflow = await stub.fetch('https://example.test/?stream=direct', {
      headers: {
        Upgrade: 'websocket',
        'X-Siliconbeest-Allowed-Streams': JSON.stringify(['direct']),
        'X-Siliconbeest-Socket-Limit': '4',
      },
    });
    expect(overflow.status).toBe(503);
    expect(overflow.headers.get('Retry-After')).toBe('1');
    for (const socket of sockets) socket.close(1000, 'test complete');
  });
});

describe('RealtimeFeedIndexDO', () => {
  it('orders by global tuple and ignores an older source version', async () => {
    const feed = env.REALTIME_FEED_DO.getByName('feed:test:partition:0');
    await feed.project({
      feedKey: 'public:all', entityId: 'b', sourceOrdinal: 2,
      sortAtMs: 1000, sourceVersion: 2, snapshotJson: '{"id":"b","v":2}',
    });
    await feed.project({
      feedKey: 'public:all', entityId: 'a', sourceOrdinal: 1,
      sortAtMs: 1000, sourceVersion: 1, snapshotJson: '{"id":"a"}',
    });
    await feed.project({
      feedKey: 'public:all', entityId: 'b', sourceOrdinal: 2,
      sortAtMs: 2000, sourceVersion: 1, snapshotJson: '{"id":"b","v":1}',
    });

    const page = await feed.page('public:all', null, 10);
    expect(page.entries.map((entry) => entry.entityId)).toEqual(['b', 'a']);
    expect(page.entries[0]).toMatchObject({ sortAtMs: 1000, sourceVersion: 2 });

    await feed.project({
      feedKey: 'public:all', entityId: 'b', sourceOrdinal: 2,
      sortAtMs: 1000, sourceVersion: 3, tombstoned: true,
    });
    expect((await feed.page('public:all', null, 10)).entries.map((entry) => entry.entityId)).toEqual(['a']);

    await feed.project({
      feedKey: 'public:all', entityId: 'b', sourceOrdinal: 2,
      sortAtMs: 3000, sourceVersion: 2, snapshotJson: '{"id":"b","late":true}',
    });
    expect((await feed.page('public:all', null, 10)).entries.map((entry) => entry.entityId)).toEqual(['a']);
  });
});

describe('D1 feed fallback merge', () => {
  it('deduplicates overlapping epochs and lets a tombstone suppress an older snapshot', () => {
    const entries = mergeRealtimeFeedEntries([
      [{
        feedKey: 'public:all:all', entityId: 'same', sourceOrdinal: 1,
        sortAtMs: 2_000, sourceVersion: 1, snapshotJson: '{"id":"same"}',
      }, {
        feedKey: 'public:all:all', entityId: 'visible', sourceOrdinal: 1,
        sortAtMs: 1_000, sourceVersion: 1, snapshotJson: '{"id":"visible"}',
      }],
      [{
        feedKey: 'public:all:all', entityId: 'same', sourceOrdinal: 2,
        sortAtMs: 2_000, sourceVersion: 2, tombstoned: true,
      }],
    ], 20);
    expect(entries.map((entry) => entry.entityId)).toEqual(['visible']);
  });
});
