type FedifyQueueMessage = Record<string, unknown>;

export interface FedifyTargetFilterResult {
  message: FedifyQueueMessage | null;
  droppedTargets: number;
}

/** Extract outbound target domains without depending on Fedify's opaque type. */
export function getFedifyTargetDomains(message: unknown): Set<string> {
  const domains = new Set<string>();
  if (!isRecord(message)) return domains;

  if (message.type === 'outbox' && typeof message.inbox === 'string') {
    const domain = hostname(message.inbox);
    if (domain) domains.add(domain);
    addActorDomains(domains, message);
  } else if (message.type === 'fanout' && isRecord(message.inboxes)) {
    for (const [inbox, target] of Object.entries(message.inboxes)) {
      const domain = hostname(inbox);
      if (domain) domains.add(domain);
      addActorDomains(domains, target);
    }
  }

  return domains;
}

/** Return the concrete outbound inbox URLs in a Fedify queue payload. */
export function getFedifyInboxUrls(message: unknown): Set<string> {
  const inboxes = new Set<string>();
  if (!isRecord(message)) return inboxes;
  if (message.type === 'outbox' && typeof message.inbox === 'string') {
    inboxes.add(message.inbox);
  } else if (message.type === 'fanout' && isRecord(message.inboxes)) {
    for (const inbox of Object.keys(message.inboxes)) inboxes.add(inbox);
  }
  return inboxes;
}

/**
 * Remove suspended destinations from a Fedify outbox/fanout task.
 * Inbox tasks and unknown future task types are passed through unchanged.
 */
export function filterSuspendedFedifyTargets(
  message: unknown,
  suspendedDomains: ReadonlySet<string>,
  suspendedInboxes: ReadonlySet<string> = new Set(),
): FedifyTargetFilterResult {
  if (!isRecord(message)) return { message: null, droppedTargets: 0 };

  if (message.type === 'outbox' && typeof message.inbox === 'string') {
    if (isSuspendedTarget(message.inbox, message, suspendedDomains, suspendedInboxes)) {
      return { message: null, droppedTargets: 1 };
    }
    return { message, droppedTargets: 0 };
  }

  if (message.type === 'fanout' && isRecord(message.inboxes)) {
    const entries = Object.entries(message.inboxes);
    const remaining = entries.filter(
      ([inbox, target]) => !isSuspendedTarget(
        inbox,
        target,
        suspendedDomains,
        suspendedInboxes,
      ),
    );
    const droppedTargets = entries.length - remaining.length;
    if (droppedTargets === 0) return { message, droppedTargets: 0 };
    if (remaining.length === 0) return { message: null, droppedTargets };
    return {
      message: { ...message, inboxes: Object.fromEntries(remaining) },
      droppedTargets,
    };
  }

  return { message, droppedTargets: 0 };
}

function hostname(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isSuspendedTarget(
  inbox: string,
  target: unknown,
  suspendedDomains: ReadonlySet<string>,
  suspendedInboxes: ReadonlySet<string>,
): boolean {
  if (suspendedInboxes.has(inbox)) return true;
  const inboxDomain = hostname(inbox);
  if (inboxDomain && suspendedDomains.has(inboxDomain)) return true;

  const actorDomains = new Set<string>();
  addActorDomains(actorDomains, target);
  for (const domain of actorDomains) {
    if (suspendedDomains.has(domain)) return true;
  }
  return false;
}

function addActorDomains(domains: Set<string>, target: unknown): void {
  if (!isRecord(target) || !Array.isArray(target.actorIds)) return;
  for (const actorId of target.actorIds) {
    if (typeof actorId !== 'string') continue;
    const domain = hostname(actorId);
    if (domain) domains.add(domain);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
