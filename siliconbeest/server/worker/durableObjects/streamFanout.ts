/* oxlint-disable fp/no-classes, fp/no-class-inheritance, fp/no-this-expressions */

import { DurableObject } from 'cloudflare:workers';
import type { StreamEventPayload } from '../internal-contract';

interface StreamFanoutEnv {
  readonly STREAMING_DO: DurableObjectNamespace<
    import('./streaming').StreamingDO
  >;
  readonly STREAM_FANOUT_DO: DurableObjectNamespace<StreamFanoutDO>;
}

/**
 * One internal node in the public-stream distribution tree.
 *
 * The stateless Worker invokes every level-one node. Each node calls at most
 * five children, keeping below the six simultaneous outgoing connection
 * limit. Only StreamingDO leaves own WebSockets.
 */
export class StreamFanoutDO extends DurableObject<StreamFanoutEnv> {
  async publish(
    event: StreamEventPayload,
    nodeIndex: number,
    remainingDepth: number,
    branchFactor: number,
  ): Promise<void> {
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0) throw new RangeError('Invalid stream tree node');
    if (!Number.isInteger(remainingDepth) || remainingDepth < 1 || remainingDepth > 3) {
      throw new RangeError('Invalid remaining stream tree depth');
    }
    if (!Number.isInteger(branchFactor) || branchFactor < 2 || branchFactor > 5) {
      throw new RangeError('Invalid stream branch factor');
    }

    const childIndexes = Array.from(
      { length: branchFactor },
      (_, offset) => nodeIndex * branchFactor + offset,
    );
    if (remainingDepth === 1) {
      await Promise.all(childIndexes.map((leafIndex) =>
        this.env.STREAMING_DO.getByName(`public:leaf:${leafIndex}`).sendEvent(event),
      ));
      return;
    }

    await Promise.all(childIndexes.map((childIndex) =>
      this.env.STREAM_FANOUT_DO
        .getByName(`public:depth:${remainingDepth - 1}:node:${childIndex}`)
        .publish(event, childIndex, remainingDepth - 1, branchFactor),
    ));
  }
}
