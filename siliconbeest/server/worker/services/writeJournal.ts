import { env } from 'cloudflare:workers';
import type {
  WriteCommand,
  WriteOperation,
  WriteReceipt,
} from '../../../../packages/shared/types/write';

function journal(actorKey: string) {
  return env.WRITE_JOURNAL_DO.getByName(actorKey);
}

export async function acceptWrite(command: WriteCommand): Promise<WriteReceipt> {
  return journal(command.actorKey).accept(command);
}

export async function getWriteOperation(actorKey: string, operationId: string): Promise<WriteOperation | null> {
  return journal(actorKey).getOperation(operationId);
}

export async function getPendingEntity(
  actorKey: string,
  entityId: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  return journal(actorKey).getPendingEntity(entityId);
}
