/* oxlint-disable fp/no-classes, fp/no-class-inheritance, fp/no-this-expressions */

import { DurableObject } from 'cloudflare:workers';

export type RemoteObjectEventKind = 'Create' | 'Update' | 'Delete';
export interface RemoteObjectDecision {
  readonly apply: boolean;
  readonly sourceVersion: number;
  readonly tombstoned: boolean;
}

type JournalRow = {
  actor_uri: string;
  source_version: number;
  source_timestamp_ms: number | null;
  tombstoned: number;
  activity_ids_json: string;
};

export class RemoteObjectJournalDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS remote_object_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          actor_uri TEXT NOT NULL,
          source_version INTEGER NOT NULL,
          source_timestamp_ms INTEGER,
          tombstoned INTEGER NOT NULL CHECK (tombstoned IN (0, 1)),
          activity_ids_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    });
  }

  accept(input: {
    kind: RemoteObjectEventKind;
    activityId: string | null;
    actorUri: string;
    sourceTimestampMs: number | null;
  }): RemoteObjectDecision {
    const current = this.ctx.storage.sql.exec<JournalRow>(
      'SELECT actor_uri, source_version, source_timestamp_ms, tombstoned, activity_ids_json FROM remote_object_state WHERE singleton = 1',
    ).toArray()[0];
    const activityIds = new Set<string>(current ? JSON.parse(current.activity_ids_json) as string[] : []);
    if (input.activityId && activityIds.has(input.activityId)) {
      return { apply: false, sourceVersion: current?.source_version ?? 0, tombstoned: current?.tombstoned === 1 };
    }
    // A tombstone only governs the actor that asserted it. This preserves
    // delete-before-create ordering without letting another actor poison a URI.
    if (current?.tombstoned === 1 && current.actor_uri === input.actorUri && input.kind !== 'Delete') {
      return { apply: false, sourceVersion: current.source_version, tombstoned: true };
    }
    if (current && current.actor_uri === input.actorUri
      && current.source_timestamp_ms !== null && input.sourceTimestampMs !== null
      && input.sourceTimestampMs < current.source_timestamp_ms) {
      return { apply: false, sourceVersion: current.source_version, tombstoned: current.tombstoned === 1 };
    }
    if (input.activityId) activityIds.add(input.activityId);
    const boundedIds = [...activityIds].slice(-64);
    const sourceVersion = (current?.source_version ?? 0) + 1;
    const tombstoned = input.kind === 'Delete'
      || (current?.tombstoned === 1 && current.actor_uri === input.actorUri);
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO remote_object_state (
         singleton, actor_uri, source_version, source_timestamp_ms,
         tombstoned, activity_ids_json, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      input.actorUri,
      sourceVersion,
      input.sourceTimestampMs,
      tombstoned ? 1 : 0,
      JSON.stringify(boundedIds),
      new Date().toISOString(),
    );
    return { apply: true, sourceVersion, tombstoned };
  }
}
