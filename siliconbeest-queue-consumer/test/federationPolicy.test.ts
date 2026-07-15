import { describe, expect, it } from 'vitest';
import {
  filterSuspendedFedifyTargets,
  getFedifyInboxUrls,
  getFedifyTargetDomains,
} from '../src/federationPolicy';
import {
  getDeliveryTargetDomains,
  getSuspendedDeliveryInboxes,
} from '../../packages/shared/domain-blocks';

describe('Fedify outbound suspension policy', () => {
  it('drops an outbox task for a suspended domain', () => {
    const message = {
      type: 'outbox',
      inbox: 'https://blocked.example/inbox',
      activity: { type: 'Create' },
    };

    expect(getFedifyTargetDomains(message)).toEqual(new Set(['blocked.example']));
    expect(filterSuspendedFedifyTargets(
      message,
      new Set(['blocked.example']),
    )).toEqual({ message: null, droppedTargets: 1 });
  });

  it('passes an allowed outbox task through unchanged', () => {
    const message = { type: 'outbox', inbox: 'https://allowed.example/inbox' };

    expect(filterSuspendedFedifyTargets(
      message,
      new Set(['blocked.example']),
    )).toEqual({ message, droppedTargets: 0 });
  });

  it('drops an outbox task when the actor domain is suspended but the inbox host differs', () => {
    const message = {
      type: 'outbox',
      inbox: 'https://delivery.example.net/inbox',
      actorIds: ['https://blocked.example/users/alice'],
    };

    expect(getFedifyTargetDomains(message)).toEqual(new Set([
      'delivery.example.net',
      'blocked.example',
    ]));
    expect(filterSuspendedFedifyTargets(
      message,
      new Set(['blocked.example']),
    )).toEqual({ message: null, droppedTargets: 1 });
  });

  it('removes only suspended destinations from a fanout task', () => {
    const message = {
      type: 'fanout',
      inboxes: {
        'https://blocked.example/inbox': ['alice'],
        'https://allowed.example/inbox': ['bob'],
      },
      activity: { type: 'Announce' },
    };

    const result = filterSuspendedFedifyTargets(
      message,
      new Set(['blocked.example']),
    );

    expect(result).toEqual({
      message: {
        ...message,
        inboxes: { 'https://allowed.example/inbox': ['bob'] },
      },
      droppedTargets: 1,
    });
    expect(message.inboxes).toHaveProperty('https://blocked.example/inbox');
  });

  it('drops a fanout task when every destination is suspended', () => {
    const message = {
      type: 'fanout',
      inboxes: {
        'https://one.example/inbox': ['alice'],
        'https://two.example/inbox': ['bob'],
      },
    };

    expect(filterSuspendedFedifyTargets(
      message,
      new Set(['one.example', 'two.example']),
    )).toEqual({ message: null, droppedTargets: 2 });
  });

  it('filters fanout by actor identity when shared inbox hosts differ', () => {
    const message = {
      type: 'fanout',
      inboxes: {
        'https://shared-one.example.net/inbox': {
          actorIds: ['https://blocked.example/users/alice'],
          sharedInbox: true,
        },
        'https://shared-two.example.net/inbox': {
          actorIds: ['https://allowed.example/users/bob'],
          sharedInbox: true,
        },
      },
    };

    expect(filterSuspendedFedifyTargets(
      message,
      new Set(['blocked.example']),
    )).toEqual({
      message: {
        ...message,
        inboxes: {
          'https://shared-two.example.net/inbox': {
            actorIds: ['https://allowed.example/users/bob'],
            sharedInbox: true,
          },
        },
      },
      droppedTargets: 1,
    });
  });

  it('drops a shared inbox when D1 maps a deduped recipient to a suspended identity', () => {
    const sharedInbox = 'https://delivery.example.net/inbox';
    const message = {
      type: 'fanout',
      inboxes: {
        [sharedInbox]: {
          actorIds: ['https://allowed.example/users/alice'],
          sharedInbox: true,
        },
      },
    };

    expect(getFedifyInboxUrls(message)).toEqual(new Set([sharedInbox]));
    expect(filterSuspendedFedifyTargets(
      message,
      new Set(),
      new Set([sharedInbox]),
    )).toEqual({ message: null, droppedTargets: 1 });
  });

  it('does not apply outbound filtering to an inbox task', () => {
    const message = { type: 'inbox', activity: { type: 'Create' } };

    expect(filterSuspendedFedifyTargets(
      message,
      new Set(['blocked.example']),
    )).toEqual({ message, droppedTargets: 0 });
  });
});

describe('legacy delivery identity mapping', () => {
  it('includes stored actor and relay domains behind a cross-host inbox', async () => {
    const all = async () => ({
      results: [
        { kind: 'domain', value: 'actor.example' },
        { kind: 'actor_uri', value: 'https://relay.example/actor' },
      ],
    });
    const bind = () => ({ all });
    const prepare = () => ({ bind });
    const db = { prepare } as unknown as D1Database;

    await expect(getDeliveryTargetDomains(
      db,
      'https://delivery.example.net/inbox',
    )).resolves.toEqual(new Set([
      'delivery.example.net',
      'actor.example',
      'relay.example',
    ]));
  });

  it('does not query D1 for an invalid inbox URL', async () => {
    const prepare = () => {
      throw new Error('D1 should not be queried');
    };
    const db = { prepare } as unknown as D1Database;

    await expect(getDeliveryTargetDomains(db, 'not a URL')).resolves.toEqual(new Set());
  });

  it('finds a suspended identity hidden behind a deduped shared inbox', async () => {
    const sharedInbox = 'https://delivery.example.net/inbox';
    const prepare = (sql: string) => ({
      bind: (..._values: unknown[]) => ({
        all: async () => sql.includes('WITH requested')
          ? {
              results: [
                { inbox_url: sharedInbox, kind: 'domain', value: 'allowed.example' },
                { inbox_url: sharedInbox, kind: 'domain', value: 'blocked.example' },
              ],
            }
          : { results: [{ domain: 'blocked.example' }] },
      }),
    });
    const db = { prepare } as unknown as D1Database;

    await expect(getSuspendedDeliveryInboxes(
      db,
      [sharedInbox],
    )).resolves.toEqual(new Set([sharedInbox]));
  });
});
