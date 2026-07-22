import type { ShardRef } from './sharding';

export type RegistrationOperationState =
	| 'accepted'
	| 'queued'
	| 'applying'
	| 'committed'
	| 'failed';

export interface RegistrationCommand {
	readonly operationId: string;
	readonly accountId: string;
	readonly userId: string;
	readonly actorKeyId: string;
	readonly email: string;
	readonly username: string;
	readonly encryptedPassword: string;
	readonly locale: string;
	readonly reason: string | null;
	readonly registrationState: 'awaiting_confirmation' | 'pending_approval';
	readonly registrationMode: 'open' | 'approval' | 'referral';
	readonly redirectUri: string | null;
	readonly design: 'default' | 'aurora' | 'old';
	readonly invitationToken: string | null;
	readonly shard: ShardRef;
	readonly acceptedAt: string;
}

export interface RegistrationQueueMessage {
	readonly type: 'registration';
	readonly command: RegistrationCommand;
}

export interface RegistrationProgress {
	readonly operationId: string;
	readonly state: 'applying' | 'committed' | 'failed';
	readonly error?: string;
}

export interface RegistrationOperation {
	readonly operationId: string;
	readonly accountId: string;
	readonly userId: string;
	readonly state: RegistrationOperationState;
	readonly attempts: number;
	readonly acceptedAt: string;
	readonly updatedAt: string;
	readonly error: string | null;
}
