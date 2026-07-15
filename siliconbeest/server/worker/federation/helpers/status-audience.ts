import { env } from 'cloudflare:workers';
import type { Recipient } from '@fedify/fedify/vocab';

export type StatusFederationReason =
	| 'actor_follower'
	| 'status_follower'
	| 'mention'
	| 'reply_author'
	| 'relay';

export interface StatusAudienceStatus {
	id: string;
	accountId: string;
	visibility: string;
	local?: boolean | number | null;
	accountDomain?: string | null;
	inReplyToAccountId?: string | null;
}

export interface StatusFederationRecipient extends Recipient {
	deliveryInbox: string;
	domain: string | null;
	reasons: StatusFederationReason[];
}

export interface StatusFederationAudience {
	recipients: StatusFederationRecipient[];
	inboxUrls: string[];
	domains: string[];
}

export interface StatusFederationAudienceOptions {
	/**
	 * Include the interacting local actor's remote followers in the same
	 * recipient set. Only applies to public/unlisted statuses because private
	 * and direct statuses must stay scoped to readers of the original status.
	 */
	includeActorFollowersAccountId?: string;
	includePublicRelays?: boolean;
}

interface AccountRecipientRow {
	uri: string;
	inbox_url: string | null;
	shared_inbox_url: string | null;
	domain: string | null;
}

interface RelayRecipientRow {
	inbox_url: string;
	actor_uri: string | null;
}

function isLocalStatus(status: StatusAudienceStatus): boolean {
	return status.accountDomain == null && status.local !== 0;
}

function getDeliveryInbox(row: AccountRecipientRow): string | null {
	return row.shared_inbox_url || row.inbox_url || null;
}

function getInboxDomain(inboxUrl: string, fallbackDomain: string | null): string | null {
	try {
		return new URL(inboxUrl).hostname;
	} catch {
		return fallbackDomain;
	}
}

function addAccountRecipient(
	recipientsByInbox: Map<string, StatusFederationRecipient>,
	row: AccountRecipientRow,
	reason: StatusFederationReason,
): void {
	const deliveryInbox = getDeliveryInbox(row);
	if (!deliveryInbox) return;

	const existing = recipientsByInbox.get(deliveryInbox);
	if (existing) {
		if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
		return;
	}

	recipientsByInbox.set(deliveryInbox, {
		id: new URL(row.uri),
		inboxId: new URL(row.inbox_url || deliveryInbox),
		endpoints: row.shared_inbox_url
			? { sharedInbox: new URL(row.shared_inbox_url) }
			: null,
		deliveryInbox,
		domain: getInboxDomain(deliveryInbox, row.domain),
		reasons: [reason],
	});
}

function addRelayRecipient(
	recipientsByInbox: Map<string, StatusFederationRecipient>,
	row: RelayRecipientRow,
): void {
	if (recipientsByInbox.has(row.inbox_url)) {
		const existing = recipientsByInbox.get(row.inbox_url)!;
		if (!existing.reasons.includes('relay')) existing.reasons.push('relay');
		return;
	}

	let actorId: URL | null = null;
	if (row.actor_uri) {
		try { actorId = new URL(row.actor_uri); } catch { /* use inbox identity */ }
	}

	recipientsByInbox.set(row.inbox_url, {
		id: actorId,
		inboxId: new URL(row.inbox_url),
		endpoints: null,
		deliveryInbox: row.inbox_url,
		domain: actorId?.hostname.toLowerCase() ?? getInboxDomain(row.inbox_url, null),
		reasons: ['relay'],
	});
}

async function addRemoteFollowers(
	recipientsByInbox: Map<string, StatusFederationRecipient>,
	accountId: string,
	reason: 'actor_follower' | 'status_follower',
): Promise<void> {
	const { results } = await env.DB.prepare(
		`SELECT DISTINCT a.uri, a.inbox_url, a.shared_inbox_url, a.domain
		 FROM follows f
		 JOIN accounts a ON a.id = f.account_id
		 WHERE f.target_account_id = ?1
		   AND a.domain IS NOT NULL
		   AND a.inbox_url IS NOT NULL`,
	).bind(accountId).all<AccountRecipientRow>();

	for (const row of results ?? []) {
		addAccountRecipient(recipientsByInbox, row, reason);
	}
}

async function addRemoteMentions(
	recipientsByInbox: Map<string, StatusFederationRecipient>,
	statusId: string,
): Promise<void> {
	const { results } = await env.DB.prepare(
		`SELECT DISTINCT a.uri, a.inbox_url, a.shared_inbox_url, a.domain
		 FROM mentions m
		 JOIN accounts a ON a.id = m.account_id
		 WHERE m.status_id = ?1
		   AND a.domain IS NOT NULL
		   AND a.inbox_url IS NOT NULL`,
	).bind(statusId).all<AccountRecipientRow>();

	for (const row of results ?? []) {
		addAccountRecipient(recipientsByInbox, row, 'mention');
	}
}

async function addRemoteReplyAuthor(
	recipientsByInbox: Map<string, StatusFederationRecipient>,
	accountId: string | null | undefined,
): Promise<void> {
	if (!accountId) return;

	const row = await env.DB.prepare(
		`SELECT uri, inbox_url, shared_inbox_url, domain
		 FROM accounts
		 WHERE id = ?1
		   AND domain IS NOT NULL
		   AND inbox_url IS NOT NULL
		 LIMIT 1`,
	).bind(accountId).first<AccountRecipientRow>();

	if (row) addAccountRecipient(recipientsByInbox, row, 'reply_author');
}

async function addAcceptedRelays(
	recipientsByInbox: Map<string, StatusFederationRecipient>,
): Promise<void> {
	const { results } = await env.DB.prepare(
		"SELECT inbox_url, actor_uri FROM relays WHERE state = 'accepted'",
	).all<RelayRecipientRow>();

	for (const row of results ?? []) {
		addRelayRecipient(recipientsByInbox, row);
	}
}

/**
 * Resolve remote inboxes that should receive interactions on a local status.
 *
 * This mirrors post delivery visibility:
 * - direct: remote mentioned accounts only
 * - private: remote followers plus mentions
 * - public/unlisted: remote followers, mentions, and remote reply author
 * - public: also accepted relays
 */
export async function getStatusFederationAudience(
	status: StatusAudienceStatus,
	options: StatusFederationAudienceOptions = {},
): Promise<StatusFederationAudience> {
	const recipientsByInbox = new Map<string, StatusFederationRecipient>();

	if (!isLocalStatus(status)) {
		return { recipients: [], inboxUrls: [], domains: [] };
	}

	await addRemoteMentions(recipientsByInbox, status.id);

	if (status.visibility !== 'direct') {
		await addRemoteFollowers(recipientsByInbox, status.accountId, 'status_follower');
	}

	if (status.visibility === 'public' || status.visibility === 'unlisted') {
		if (options.includeActorFollowersAccountId) {
			await addRemoteFollowers(recipientsByInbox, options.includeActorFollowersAccountId, 'actor_follower');
		}

		await addRemoteReplyAuthor(recipientsByInbox, status.inReplyToAccountId);
	}

	if (status.visibility === 'public' && options.includePublicRelays !== false) {
		await addAcceptedRelays(recipientsByInbox);
	}

	const recipients = [...recipientsByInbox.values()];
	const domains = [...new Set(recipients.map((r) => r.domain).filter((domain): domain is string => !!domain))];

	return {
		recipients,
		inboxUrls: recipients.map((r) => r.deliveryInbox),
		domains,
	};
}
