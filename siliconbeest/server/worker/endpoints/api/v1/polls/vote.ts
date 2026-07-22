import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import { Create, Note, Question, Update } from '@fedify/vocab';
import { Temporal } from '@js-temporal/polyfill';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { votePoll } from '../../../../services/status';
import { sendToRecipient, sendToRecipients } from '../../../../federation/helpers/send';
import { generateUlid } from '../../../../utils/ulid';
import { assertStatusViewable } from '../../../../services/permissions';
import { getStatusFederationAudience } from '../../../../federation/helpers/status-audience';
import { resolveAddressing } from '../../../../federation/dispatchers/collections/helpers';

type HonoEnv = { Variables: AppVariables };

interface PollStatusRow {
  status_id: string;
  options: string;
  status_uri: string;
  account_id: string;
  visibility: string;
  local: number | null;
  in_reply_to_account_id: string | null;
  author_uri: string;
  author_domain: string | null;
}

const app = new Hono<HonoEnv>();

// POST /api/v1/polls/:id/votes
app.post('/:id/votes', authRequired, requireScope('write:statuses'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const pollId = c.req.param('id');
  const domain = env.INSTANCE_DOMAIN;

  const pollRow = await env.DB_META_C000.prepare(
    `SELECT p.status_id, p.options, s.uri AS status_uri, s.account_id,
            s.visibility, s.local, s.in_reply_to_account_id,
            a.uri AS author_uri, a.domain AS author_domain
     FROM polls p
     JOIN statuses s ON s.id = p.status_id
     JOIN accounts a ON a.id = s.account_id
     WHERE p.id = ?1`,
  ).bind(pollId).first<PollStatusRow>();
  if (!pollRow) throw new AppError(404, 'Record not found');
  await assertStatusViewable(pollRow.status_id, currentAccount.id);

  let body: { choices?: number[] };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  const choices = body.choices;
  if (!choices || !Array.isArray(choices) || choices.length === 0) {
    throw new AppError(422, 'Validation failed', 'choices is required');
  }

  const { poll } = await votePoll(currentAccount.id, pollId, choices);

  // Federate vote to remote poll author
  try {
    if (pollRow.author_domain) {
      // Remote poll — send vote activities
      const options: Array<{ title: string }> = JSON.parse(pollRow.options);
      const actorUri = `https://${domain}/users/${currentAccount.username}`;
      const fed = c.get('federation');

      for (const choiceIdx of choices) {
        const option = options[choiceIdx];
        if (!option) continue;

        const voteNote = new Note({
          id: new URL(`https://${domain}/activities/${generateUlid()}`),
          attribution: new URL(actorUri),
          name: option.title,
          replyTarget: new URL(pollRow.status_uri),
          tos: [new URL(pollRow.author_uri)],
        });

        const create = new Create({
          id: new URL(`https://${domain}/activities/${generateUlid()}`),
          actor: new URL(actorUri),
          object: voteNote,
          published: Temporal.Now.instant(),
          tos: [new URL(pollRow.author_uri)],
        });

        await sendToRecipient(fed, currentAccount.username, pollRow.author_uri, create);
      }
    } else {
      // Local poll — broadcast Update(Question) with updated counts to followers
      const fed = c.get('federation');
      const updatedPoll = await env.DB_META_C000.prepare(
        'SELECT * FROM polls WHERE id = ?1 LIMIT 1',
      ).bind(pollId).first<{ options: string; expires_at: string | null; multiple: number; voters_count: number }>();

      if (updatedPoll) {
        const options: Array<{ title: string; votes_count: number }> = JSON.parse(updatedPoll.options);
        const authorUsername = pollRow.author_uri.split('/users/')[1];
        const authorActorUri = pollRow.author_uri;
        const followersUri = `${authorActorUri}/followers`;

        const audience = await getStatusFederationAudience({
          id: pollRow.status_id,
          accountId: pollRow.account_id,
          visibility: pollRow.visibility,
          local: pollRow.local,
          accountDomain: pollRow.author_domain,
          inReplyToAccountId: pollRow.in_reply_to_account_id,
        });
        const addressing = resolveAddressing(pollRow.visibility, followersUri);
        const recipientIds = audience.recipients.flatMap((recipient) =>
          recipient.id ? [recipient.id] : [],
        );
        const tos = pollRow.visibility === 'direct'
          ? recipientIds
          : addressing.tos;
        const ccs = pollRow.visibility === 'direct'
          ? []
          : [...addressing.ccs, ...recipientIds];

        const optionNotes = options.map((o) => new Note({ name: o.title }));
        const questionValues: ConstructorParameters<typeof Question>[0] = {
          id: new URL(pollRow.status_uri),
          actor: new URL(authorActorUri),
          voters: updatedPoll.voters_count,
        };

        if (updatedPoll.multiple) {
          questionValues.inclusiveOptions = optionNotes;
        } else {
          questionValues.exclusiveOptions = optionNotes;
        }

        if (updatedPoll.expires_at) {
          questionValues.endTime = Temporal.Instant.from(new Date(updatedPoll.expires_at).toISOString());
          if (new Date(updatedPoll.expires_at) <= new Date()) {
            questionValues.closed = Temporal.Instant.from(new Date(updatedPoll.expires_at).toISOString());
          }
        }

        const question = new Question(questionValues);

        const update = new Update({
          id: new URL(`https://${domain}/activities/${generateUlid()}`),
          actor: new URL(authorActorUri),
          object: question,
          published: Temporal.Now.instant(),
          tos,
          ccs,
        });

        if (authorUsername) {
          await sendToRecipients(fed, authorUsername, audience.recipients, update);
        }
      }
    }
  } catch (e) {
    console.error('[polls/vote] Federation delivery failed:', e);
  }

  return c.json(poll);
});

export default app;
