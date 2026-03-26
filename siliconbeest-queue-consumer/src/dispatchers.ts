/**
 * Minimal Fedify Dispatcher Setup (Queue Consumer)
 *
 * Registers the actor dispatcher and key-pairs dispatcher on the
 * Federation instance.  The queue consumer needs these so that
 * Fedify can look up signing keys when `processQueuedTask()` sends
 * outgoing activities (HTTP Signatures / Object Integrity Proofs).
 *
 * This is a slimmed-down copy of the worker's actor dispatcher —
 * it only returns key pairs (no full actor profile) because the
 * consumer never serves actor documents over HTTP.
 */

import type { Federation } from '@fedify/fedify';
import type { FedifyContextData } from './fedify';

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
// PEM / Base64url helpers
// ============================================================

function parsePemToBuffer(pem: string): ArrayBuffer {
  const lines = pem
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\r?\n/g, '')
    .trim();
  const binaryString = atob(lines);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64UrlToBytes(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binaryString = atob(padded);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// ============================================================
// Key import helpers
// ============================================================

async function importRsaPublicKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    parsePemToBuffer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } },
    true,
    ['verify'],
  );
}

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    parsePemToBuffer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } },
    true,
    ['sign'],
  );
}

async function importEd25519Pub(base64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64UrlToBytes(base64url), 'Ed25519', true, ['verify']);
}

async function importEd25519Priv(base64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', base64UrlToBytes(base64url), 'Ed25519', true, ['sign']);
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
        const ed25519PublicKey = await importEd25519Pub(actorKey.ed25519_public_key);
        const ed25519PrivateKey = await importEd25519Priv(actorKey.ed25519_private_key);
        keyPairs.push({ publicKey: ed25519PublicKey, privateKey: ed25519PrivateKey });
      }

      return keyPairs;
    });
}
