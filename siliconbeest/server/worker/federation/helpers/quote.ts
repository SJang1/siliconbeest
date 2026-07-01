import { env } from 'cloudflare:workers';
import { generateUlid } from '../../utils/ulid';
import type { APNote, APObject, APQuoteAuthorization } from '../../types/activitypub';
import { normalizeQuotePolicy, quotePolicyAutomaticApprovals, type QuotePolicy } from '../../../../../packages/shared/utils/quotePolicy';

export const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
export const FEP044F_QUOTE = 'https://w3id.org/fep/044f#quote';
export const FEP044F_QUOTE_AUTHORIZATION = 'https://w3id.org/fep/044f#quoteAuthorization';
export const FEP044F_QUOTE_REQUEST = 'https://w3id.org/fep/044f#QuoteRequest';
export const FEP044F_QUOTE_AUTHORIZATION_TYPE = 'https://w3id.org/fep/044f#QuoteAuthorization';
export const GTS_INTERACTION_POLICY = 'https://gotosocial.org/ns#interactionPolicy';
export const GTS_CAN_QUOTE = 'https://gotosocial.org/ns#canQuote';
export const GTS_AUTOMATIC_APPROVAL = 'https://gotosocial.org/ns#automaticApproval';
export const GTS_MANUAL_APPROVAL = 'https://gotosocial.org/ns#manualApproval';
export const GTS_INTERACTING_OBJECT = 'https://gotosocial.org/ns#interactingObject';
export const GTS_INTERACTION_TARGET = 'https://gotosocial.org/ns#interactionTarget';

export function quoteContext(): Record<string, unknown> {
  return {
    gts: 'https://gotosocial.org/ns#',
    quote: { '@id': FEP044F_QUOTE, '@type': '@id' },
    quoteAuthorization: { '@id': FEP044F_QUOTE_AUTHORIZATION, '@type': '@id' },
    QuoteRequest: FEP044F_QUOTE_REQUEST,
    QuoteAuthorization: FEP044F_QUOTE_AUTHORIZATION_TYPE,
    interactionPolicy: { '@id': 'gts:interactionPolicy', '@type': '@id' },
    canQuote: { '@id': 'gts:canQuote', '@type': '@id' },
    automaticApproval: { '@id': 'gts:automaticApproval', '@type': '@id', '@container': '@set' },
    manualApproval: { '@id': 'gts:manualApproval', '@type': '@id', '@container': '@set' },
    interactingObject: { '@id': 'gts:interactingObject', '@type': '@id' },
    interactionTarget: { '@id': 'gts:interactionTarget', '@type': '@id' },
    quoteUrl: 'as:quoteUrl',
    quoteUri: 'http://fedibird.com/ns#quoteUri',
    _misskey_quote: 'https://misskey-hub.net/ns#_misskey_quote',
  };
}

export function ensureQuoteContext(jsonLd: Record<string, unknown>): Record<string, unknown> {
  const context = jsonLd['@context'];
  if (Array.isArray(context)) {
    jsonLd['@context'] = [...context, quoteContext()];
  } else if (context) {
    jsonLd['@context'] = [context, quoteContext()];
  } else {
    jsonLd['@context'] = ['https://www.w3.org/ns/activitystreams', quoteContext()];
  }
  return jsonLd;
}

export function getId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const id = (value as Record<string, unknown>).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

export function getQuoteUri(note: APObject | APNote | Record<string, unknown>): string | null {
  const obj = note as Record<string, unknown>;
  return getId(obj.quote)
    ?? getId(obj.quoteUrl)
    ?? getId(obj.quoteUri)
    ?? getId(obj._misskey_quote)
    ?? getMisskeyQuoteLink(obj.tag);
}

function getMisskeyQuoteLink(tag: unknown): string | null {
  const tags = Array.isArray(tag) ? tag : tag ? [tag] : [];
  for (const item of tags) {
    if (!item || typeof item !== 'object') continue;
    const link = item as Record<string, unknown>;
    if (link.type !== 'Link') continue;
    if (link.rel !== 'https://misskey-hub.net/ns#_misskey_quote') continue;
    if (typeof link.href === 'string') return link.href;
  }
  return null;
}

export function addQuoteProperties(
  jsonLd: Record<string, unknown>,
  quoteUri: string | null | undefined,
  quoteAuthorizationUri?: string | null,
): Record<string, unknown> {
  if (!quoteUri) return jsonLd;
  ensureQuoteContext(jsonLd);
  jsonLd.quote = quoteUri;
  jsonLd.quoteUrl = quoteUri;
  jsonLd.quoteUri = quoteUri;
  jsonLd._misskey_quote = quoteUri;
  const existingTags = Array.isArray(jsonLd.tag) ? jsonLd.tag : jsonLd.tag ? [jsonLd.tag] : [];
  if (!existingTags.some((tag) => tag && typeof tag === 'object' && (tag as Record<string, unknown>).rel === 'https://misskey-hub.net/ns#_misskey_quote')) {
    jsonLd.tag = [
      ...existingTags,
      {
        type: 'Link',
        mediaType: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
        rel: 'https://misskey-hub.net/ns#_misskey_quote',
        href: quoteUri,
      },
    ];
  }
  if (quoteAuthorizationUri) {
    jsonLd.quoteAuthorization = quoteAuthorizationUri;
  }
  return jsonLd;
}

export function addDefaultQuotePolicy(
  jsonLd: Record<string, unknown>,
  actorUri: string,
  policy: QuotePolicy = 'public',
): Record<string, unknown> {
  ensureQuoteContext(jsonLd);
  const normalized = normalizeQuotePolicy(policy);
  jsonLd.interactionPolicy = {
    canQuote: {
      automaticApproval: quotePolicyAutomaticApprovals(normalized, actorUri, `${actorUri}/followers`),
    },
  };
  return jsonLd;
}

export async function createLocalQuoteAuthorization(input: {
  attributedToAccountId: string;
  attributedToUsername: string;
  interactingObjectUri: string;
  interactionTargetUri: string;
  quoteStatusId?: string | null;
  quotedStatusId?: string | null;
  requestUri?: string | null;
}): Promise<string> {
  const now = new Date().toISOString();
  const id = generateUlid();
  const uri = `https://${env.INSTANCE_DOMAIN}/users/${input.attributedToUsername}/stamps/${id}`;
  await env.DB.prepare(
    `INSERT INTO quote_authorizations
      (id, uri, attributed_to_account_id, interacting_object_uri, interaction_target_uri,
       quote_status_id, quoted_status_id, request_uri, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
  ).bind(
    id,
    uri,
    input.attributedToAccountId,
    input.interactingObjectUri,
    input.interactionTargetUri,
    input.quoteStatusId ?? null,
    input.quotedStatusId ?? null,
    input.requestUri ?? null,
    now,
  ).run();
  return uri;
}

export async function verifyQuoteAuthorization(input: {
  authorizationUri: string | null;
  interactingObjectUri: string;
  interactionTargetUri: string;
  targetAttributedTo: string;
}): Promise<boolean> {
  if (!input.authorizationUri) return false;

  const local = await env.DB.prepare(
    `SELECT qa.uri, qa.interacting_object_uri, qa.interaction_target_uri, a.uri AS attributed_to_uri
     FROM quote_authorizations qa
     JOIN accounts a ON a.id = qa.attributed_to_account_id
     WHERE qa.uri = ?1 AND qa.revoked_at IS NULL
     LIMIT 1`,
  ).bind(input.authorizationUri).first<{
    uri: string;
    interacting_object_uri: string;
    interaction_target_uri: string;
    attributed_to_uri: string;
  }>();

  if (local) {
    return local.interacting_object_uri === input.interactingObjectUri
      && local.interaction_target_uri === input.interactionTargetUri
      && local.attributed_to_uri === input.targetAttributedTo;
  }

  try {
    const response = await fetch(input.authorizationUri, {
      headers: {
        Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
        'User-Agent': `SiliconBeest/1.0 (+https://${env.INSTANCE_DOMAIN}/)`,
      },
    });
    if (!response.ok) return false;
    const json = await response.json<APQuoteAuthorization>();
    return (json.type === 'QuoteAuthorization' || json.type === FEP044F_QUOTE_AUTHORIZATION_TYPE)
      && json.interactingObject === input.interactingObjectUri
      && json.interactionTarget === input.interactionTargetUri
      && json.attributedTo === input.targetAttributedTo;
  } catch {
    return false;
  }
}

export async function getStatusAuthorUriByStatusUri(uri: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT a.uri
     FROM statuses s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.uri = ?1 AND s.deleted_at IS NULL
     LIMIT 1`,
  ).bind(uri).first<{ uri: string }>();
  return row?.uri ?? null;
}
