/* oxlint-disable fp/no-classes, fp/no-class-inheritance, fp/no-this-expressions */

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { InternalRpc, StreamEventPayload } from './internal-contract';
import { sendStreamEventToDurableObject } from './services/streaming';
import type { WriteClaim, WriteClaimResult, WriteProgress } from '../../../packages/shared/types/write';
import type { WriteJournalDO } from './durableObjects/writeJournal';
import type { RegistrationCommand } from '../../../packages/shared/types/registration';
import { applyRegistration } from './services/asyncRegistration';
import type { RealtimeFeedEntry } from '../../../packages/shared/types/realtimeFeed';
import { projectRealtimeFeedToDurableObject } from './services/realtimeFeed';

type InternalEnv = Env & {
  WRITE_JOURNAL_DO: DurableObjectNamespace<WriteJournalDO>;
};

/**
 * Capability-scoped RPC entrypoint for calls from other SiliconBeest Workers.
 *
 * This named entrypoint is only reachable through an explicit Service Binding;
 * it is not attached to the main Worker's public HTTP routes.
 */
export class Internal extends WorkerEntrypoint<InternalEnv> implements InternalRpc {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  }

  async sendStreamEvent(
    userId: string,
    event: StreamEventPayload,
  ): Promise<void> {
    await sendStreamEventToDurableObject(userId, event);
  }

  async updateWriteOperation(progress: WriteProgress): Promise<void> {
    const stub = this.env.WRITE_JOURNAL_DO.getByName(progress.actorKey);
    await stub.update(progress);
  }

  async claimWriteOperation(claim: WriteClaim): Promise<WriteClaimResult> {
    const stub = this.env.WRITE_JOURNAL_DO.getByName(claim.actorKey);
    return stub.claim(claim.operationId, claim.leaseMs);
  }

  async applyRegistration(command: RegistrationCommand): Promise<void> {
    await applyRegistration(command);
  }

  async projectRealtimeFeed(entry: RealtimeFeedEntry): Promise<void> {
    await projectRealtimeFeedToDurableObject(entry);
  }
}
