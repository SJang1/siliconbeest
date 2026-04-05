/**
 * Fedify Dispatcher Setup (Queue Consumer)
 *
 * Registers all Fedify dispatchers and listeners on the Federation
 * instance. The queue consumer needs these because Fedify defers
 * both inbox processing and outbound delivery to the queue:
 *
 * - Actor dispatcher + key-pairs: for signing outgoing HTTP requests
 * - Inbox listeners: for processing deferred inbox activities
 * - Collection dispatchers: for resolving followers during fanout
 *
 * Inbox listeners and collection dispatchers are defined locally in the
 * consumer (inboxListeners.ts, collectionDispatchers.ts) to avoid the
 * dual-package hazard with Fedify vocab types.
 */

import type { Federation } from '@fedify/fedify';
import type { FedifyContextData } from './fedify';
import {
  importRsaPublicKey,
  importRsaPrivateKey,
  importEd25519PublicKey,
  importEd25519PrivateKey,
} from '../../packages/shared/crypto/keys';

// Note: setupInboxListeners and setupCollectionDispatchers are defined
// locally in the consumer (inboxListeners.ts, collectionDispatchers.ts)
// and imported in index.ts for processQueuedTask to handle inbox and fanout messages.

/** Row shape for the actor_keys table. */
interface ActorKeyRow {
  id: string;
  account_id: string;
  public_key: string;
  private_key: string;
  key_id: string;
  ed25519_public_key: string | null;
  ed25519_private_key: string | null;
  created_at: string;
}

// ============================================================
// Public API
// ============================================================

/**
 * Register the actor dispatcher (with key-pairs dispatcher) on the
 * given Federation instance.
 *
 * The actor dispatcher returns `null` for every identifier — the
 * consumer never needs to serve actor documents.  Only the
 * key-pairs dispatcher does real work so Fedify can sign outgoing
 * HTTP requests.
 */
export function setupActorDispatcher(fed: Federation<FedifyContextData>): void {
  fed
    .setActorDispatcher('/users/{identifier}', async (_ctx, _identifier) => {
      // The consumer never serves actor documents; return null.
      return null;
    })
    .setKeyPairsDispatcher(async (ctx, identifier) => {
      const env = ctx.data.env;

      // Determine the account_id to look up
      let accountId: string;
      if (identifier === '__instance__') {
        accountId = '__instance__';
      } else {
        const account = await env.DB.prepare(
          `SELECT id FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1`,
        )
          .bind(identifier)
          .first<{ id: string }>();
        if (!account) return [];
        accountId = account.id;
      }

      const actorKey = await env.DB.prepare(
        `SELECT * FROM actor_keys WHERE account_id = ?1 ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(accountId)
        .first<ActorKeyRow>();

      if (!actorKey) return [];

      const keyPairs: CryptoKeyPair[] = [];

      // RSA key pair
      const rsaPublicKey = await importRsaPublicKey(actorKey.public_key);
      const rsaPrivateKey = await importRsaPrivateKey(actorKey.private_key);
      keyPairs.push({ publicKey: rsaPublicKey, privateKey: rsaPrivateKey });

      // Ed25519 key pair (optional)
      if (actorKey.ed25519_public_key && actorKey.ed25519_private_key) {
        const ed25519PublicKey = await importEd25519PublicKey(actorKey.ed25519_public_key, true);
        const ed25519PrivateKey = await importEd25519PrivateKey(actorKey.ed25519_private_key, true);
        keyPairs.push({ publicKey: ed25519PublicKey, privateKey: ed25519PrivateKey });
      }

      return keyPairs;
    });
}
