/**
 * Inbox Processor: QuoteRequest (FEP-044f)
 *
 * Automatically approves quote requests for local, non-direct statuses using
 * the default public canQuote policy advertised on local Note objects.
 */

import { env } from 'cloudflare:workers';
import type { APActivity, APQuoteRequest } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';
import { BaseProcessor } from './BaseProcessor';
import {
  FEP044F_QUOTE_REQUEST,
  createLocalQuoteAuthorization,
  getId,
  quoteContext,
} from '../helpers/quote';
import {
  canAccountOriginateFederationActivity,
  canProcessFederatedStatusInteraction,
  canQuoteStatusRecord,
  type StatusQuotePermissionRecord,
} from '../../services/permissions';

function activityObjectId(value: unknown): string | null {
  return getId(value);
}

function getInstrumentUri(instrument: APQuoteRequest['instrument']): string | null {
  if (typeof instrument === 'string') return instrument;
  if (instrument && typeof instrument === 'object') return getId(instrument);
  return null;
}

class QuoteRequestProcessor extends BaseProcessor {
  async process(activity: APActivity): Promise<void> {
    if (activity.type !== 'QuoteRequest' && activity.type !== FEP044F_QUOTE_REQUEST) return;

    const request = activity as APQuoteRequest;
    if (!request.id || !request.actor || !request.object || !request.instrument) {
      console.warn('[quoteRequest] Missing id, actor, object, or instrument');
      return;
    }

    const quotedObjectUri = activityObjectId(request.object);
    const quotePostUri = getInstrumentUri(request.instrument);
    if (!quotedObjectUri || !quotePostUri) {
      console.warn('[quoteRequest] Could not determine quoted object or quote post URI');
      return;
    }

    const quoted = await env.DB_META_C000.prepare(
      `SELECT s.id, s.uri, s.account_id, s.visibility, s.deleted_at, s.quote_policy,
              s.quote_policy_automatic_approvals, s.quote_policy_manual_approvals,
              a.username, a.uri AS account_uri
       FROM statuses s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.uri = ?1 AND s.deleted_at IS NULL AND a.domain IS NULL
       LIMIT 1`,
    ).bind(quotedObjectUri).first<StatusQuotePermissionRecord & {
      uri: string;
      account_id: string;
      username: string;
      account_uri: string;
    }>();

    if (!quoted) return;

    const remoteActorAccountId = await this.resolveActor(request.actor);
    if (!remoteActorAccountId
      || !await canAccountOriginateFederationActivity(remoteActorAccountId)
      || !await canProcessFederatedStatusInteraction(
        quoted.id,
        remoteActorAccountId,
        this.recipientAccountId || null,
      )) {
      return;
    }
    const remoteActor = await env.DB_META_C000.prepare(
      'SELECT inbox_url, shared_inbox_url FROM accounts WHERE id = ?1 LIMIT 1',
    ).bind(remoteActorAccountId).first<{ inbox_url: string | null; shared_inbox_url: string | null }>();

    if (!remoteActor?.inbox_url) {
      console.warn(`[quoteRequest] Could not resolve inbox for ${request.actor}`);
      return;
    }

    const reject = !await canQuoteStatusRecord(quoted, remoteActorAccountId);
    if (reject) {
      await this.deliverResponse({
        type: 'Reject',
        actorUri: quoted.account_uri,
        actorAccountId: quoted.account_id,
        request,
        inboxUrl: remoteActor.shared_inbox_url || remoteActor.inbox_url,
        to: request.actor,
      });
      return;
    }

    const stampUri = await createLocalQuoteAuthorization({
      attributedToAccountId: quoted.account_id,
      attributedToUsername: quoted.username,
      interactingObjectUri: quotePostUri,
      interactionTargetUri: quoted.uri,
      quotedStatusId: quoted.id,
      requestUri: request.id,
    });

    await this.deliverResponse({
      type: 'Accept',
      actorUri: quoted.account_uri,
      actorAccountId: quoted.account_id,
      request,
      inboxUrl: remoteActor.shared_inbox_url || remoteActor.inbox_url,
      to: request.actor,
      result: stampUri,
    });

    await this.notify('mention', quoted.account_id, remoteActorAccountId, quoted.id);
  }

  private async deliverResponse(input: {
    type: 'Accept' | 'Reject';
    actorUri: string;
    actorAccountId: string;
    request: APQuoteRequest;
    inboxUrl: string;
    to: string;
    result?: string;
  }): Promise<void> {
    const activity: Record<string, unknown> = {
      '@context': ['https://www.w3.org/ns/activitystreams', quoteContext()],
      type: input.type,
      id: `https://${env.INSTANCE_DOMAIN}/activities/${generateUlid()}`,
      actor: input.actorUri,
      to: input.to,
      object: {
        type: 'QuoteRequest',
        id: input.request.id,
        actor: input.request.actor,
        object: activityObjectId(input.request.object),
        instrument: getInstrumentUri(input.request.instrument),
      },
    };
    if (input.result) {
      activity.result = input.result;
    }

    await env.QUEUE_FEDERATION.send({
      type: 'deliver_activity',
      activity: activity as APActivity,
      inboxUrl: input.inboxUrl,
      actorAccountId: input.actorAccountId,
    });
  }
}

export async function processQuoteRequest(
  activity: APActivity,
  localAccountId: string,
): Promise<void> {
  await new QuoteRequestProcessor(localAccountId).process(activity);
}
