export type QuotePolicy = 'public' | 'followers' | 'nobody';

export const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const GTS_CAN_QUOTE = 'https://gotosocial.org/ns#canQuote';
const GTS_AUTOMATIC_APPROVAL = 'https://gotosocial.org/ns#automaticApproval';
const GTS_MANUAL_APPROVAL = 'https://gotosocial.org/ns#manualApproval';

function idsFrom(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(idsFrom);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return idsFrom(obj.id).concat(idsFrom(obj.href));
  }
  return [];
}

export function normalizeQuotePolicy(value: unknown): QuotePolicy {
  return value === 'followers' || value === 'nobody' ? value : 'public';
}

export function parseQuotePolicyFromInteractionPolicy(
  interactionPolicy: unknown,
  authorUri: string,
  followersUri?: string | null,
): QuotePolicy {
  if (!interactionPolicy || typeof interactionPolicy !== 'object') return 'public';

  const policy = interactionPolicy as Record<string, unknown>;
  const canQuote = policy.canQuote ?? policy[GTS_CAN_QUOTE];
  if (!canQuote || typeof canQuote !== 'object') return 'public';

  const rule = canQuote as Record<string, unknown>;
  const approvals = [
    ...idsFrom(rule.automaticApproval ?? rule[GTS_AUTOMATIC_APPROVAL]),
    ...idsFrom(rule.manualApproval ?? rule[GTS_MANUAL_APPROVAL]),
  ];

  if (approvals.includes(AS_PUBLIC) || approvals.includes('as:Public')) return 'public';
  if (followersUri && approvals.includes(followersUri)) return 'followers';
  if (approvals.some((id) => id.endsWith('/followers'))) return 'followers';
  if (approvals.includes(authorUri)) return 'nobody';

  return 'nobody';
}

export function quotePolicyAutomaticApproval(policy: QuotePolicy, actorUri: string, followersUri: string): string {
  if (policy === 'followers') return followersUri;
  if (policy === 'nobody') return actorUri;
  return AS_PUBLIC;
}

export function quotePolicyAutomaticApprovals(policy: QuotePolicy, actorUri: string, followersUri: string): string[] {
  return [quotePolicyAutomaticApproval(policy, actorUri, followersUri)];
}
