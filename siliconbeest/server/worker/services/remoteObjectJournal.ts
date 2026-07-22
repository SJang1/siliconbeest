import { env } from 'cloudflare:workers';
import type {
  RemoteObjectDecision,
  RemoteObjectEventKind,
  RemoteObjectJournalDO,
} from '../durableObjects/remoteObjectJournal';
import { sha256 } from '../utils/crypto';

type RemoteJournalEnv = Omit<Env, 'REMOTE_OBJECT_JOURNAL_DO'> & {
  REMOTE_OBJECT_JOURNAL_DO: DurableObjectNamespace<RemoteObjectJournalDO>;
};

export async function recordRemoteObjectEvent(input: {
  objectUri: string;
  kind: RemoteObjectEventKind;
  activityId: string | null;
  actorUri: string;
  sourceTimestamp: unknown;
}): Promise<RemoteObjectDecision> {
  const key = await sha256(`remote-object:v1:${input.objectUri}`);
  const parsed = typeof input.sourceTimestamp === 'string' ? Date.parse(input.sourceTimestamp) : Number.NaN;
  return (env as unknown as RemoteJournalEnv).REMOTE_OBJECT_JOURNAL_DO.getByName(key).accept({
    kind: input.kind,
    activityId: input.activityId,
    actorUri: input.actorUri,
    sourceTimestampMs: Number.isFinite(parsed) ? parsed : null,
  });
}
