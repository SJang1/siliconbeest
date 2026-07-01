export type QuotePolicy = 'public' | 'followers' | 'nobody';
export type QuotePolicyDetails = {
  policy: QuotePolicy;
  automaticApprovals: string[];
  manualApprovals: string[];
};

export const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const GTS_CAN_QUOTE = 'https://gotosocial.org/ns#canQuote';
const GTS_AUTOMATIC_APPROVAL = 'https://gotosocial.org/ns#automaticApproval';
const GTS_MANUAL_APPROVAL = 'https://gotosocial.org/ns#manualApproval';

function idsFrom(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (value instanceof URL) return [value.href];
  if (Array.isArray(value)) return value.flatMap(idsFrom);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return idsFrom(obj.id).concat(idsFrom(obj['@id'])).concat(idsFrom(obj.href));
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
  return parseQuotePolicyDetailsFromInteractionPolicy(
    interactionPolicy,
    authorUri,
    followersUri,
  ).policy;
}

export function parseQuotePolicyDetailsFromInteractionPolicy(
  interactionPolicy: unknown,
  authorUri: string,
  followersUri?: string | null,
): QuotePolicyDetails {
  if (!interactionPolicy || typeof interactionPolicy !== 'object') {
    return { policy: 'public', automaticApprovals: [], manualApprovals: [] };
  }

  const policy = interactionPolicy as Record<string, unknown>;
  const canQuote = policy.canQuote ?? policy[GTS_CAN_QUOTE];
  if (!canQuote || typeof canQuote !== 'object') {
    return { policy: 'public', automaticApprovals: [], manualApprovals: [] };
  }

  const rule = canQuote as Record<string, unknown>;
  const automaticApprovals = idsFrom(rule.automaticApproval ?? rule.automaticApprovals ?? rule[GTS_AUTOMATIC_APPROVAL]);
  const manualApprovals = idsFrom(rule.manualApproval ?? rule.manualApprovals ?? rule[GTS_MANUAL_APPROVAL]);
  const approvals = [...automaticApprovals, ...manualApprovals];

  let parsedPolicy: QuotePolicy = 'nobody';
  if (approvals.includes(AS_PUBLIC) || approvals.includes('as:Public')) parsedPolicy = 'public';
  else if (followersUri && approvals.includes(followersUri)) parsedPolicy = 'followers';
  else if (approvals.some((id) => id.endsWith('/followers'))) parsedPolicy = 'followers';
  else if (approvals.includes(authorUri)) parsedPolicy = 'nobody';

  return { policy: parsedPolicy, automaticApprovals, manualApprovals };
}

export function quotePolicyAutomaticApproval(policy: QuotePolicy, actorUri: string, followersUri: string): string {
  if (policy === 'followers') return followersUri;
  if (policy === 'nobody') return actorUri;
  return AS_PUBLIC;
}

export function quotePolicyAutomaticApprovals(policy: QuotePolicy, actorUri: string, followersUri: string): string[] {
  return [quotePolicyAutomaticApproval(policy, actorUri, followersUri)];
}
