/**
 * Fedify Actor Dispatcher + KeyPairs Dispatcher
 *
 * Registers an actor dispatcher and key pairs dispatcher on the
 * Fedify Federation instance.  The actor dispatcher returns a
 * Person / Application / Service object that matches the exact
 * JSON-LD output the former `actorSerializer.ts` produced (now removed).
 *
 * NOTE: Fedify handles serialisation to JSON-LD, @context, WebFinger
 * integration, and content-negotiation automatically.
 */

import {
  Person,
  Application,
  Service,
  Image,
  Endpoints,
  PropertyValue,
  Emoji,
  CryptographicKey,
  Multikey,
} from '@fedify/vocab';
import { Temporal } from '@js-temporal/polyfill';
import type { Federation } from '@fedify/fedify';
import type { Link as WebFingerLink } from '@fedify/webfinger';
import type { FedifyContextData } from '../fedify';
import type { AccountRow, ActorKeyRow, CustomEmojiRow } from '../../types/db';
import { parsePemToBuffer as parsePemKey } from '../helpers/key-utils';
import { encodeEd25519PublicKeyMultibase, base64UrlToBytes, generateEd25519KeyPair } from '../../utils/crypto';

/** Profile metadata field as stored in accounts.fields JSON column. */
interface ProfileField {
  name: string;
  value: string;
  verified_at?: string | null;
}

/**
 * Extract custom emoji shortcodes from text (e.g. :custom_emoji:).
 */
function extractEmojiShortcodes(text: string): string[] {
  const matches = text.match(/:([a-zA-Z0-9_]+):/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace(/:/g, '')))];
}

/**
 * Import an RSA public key PEM as a CryptoKey (SPKI / RSASSA-PKCS1-v1_5 SHA-256).
 */
async function importRsaPublicKey(pem: string): Promise<CryptoKey> {
  const keyData = parsePemKey(pem);
  return crypto.subtle.importKey(
    'spki',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } },
    true,
    ['verify'],
  );
}

/**
 * Import an RSA private key PEM as a CryptoKey (PKCS8 / RSASSA-PKCS1-v1_5 SHA-256).
 */
async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = parsePemKey(pem);
  return crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } },
    true,
    ['sign'],
  );
}

/**
 * Import an Ed25519 public key from base64url raw bytes as a CryptoKey.
 */
async function importEd25519Pub(base64url: string): Promise<CryptoKey> {
  const keyData = base64UrlToBytes(base64url);
  return crypto.subtle.importKey('raw', keyData, 'Ed25519', true, ['verify']);
}

/**
 * Import an Ed25519 private key from base64url PKCS8 as a CryptoKey.
 */
async function importEd25519Priv(base64url: string): Promise<CryptoKey> {
  const keyData = base64UrlToBytes(base64url);
  return crypto.subtle.importKey('pkcs8', keyData, 'Ed25519', true, ['sign']);
}

/**
 * Register the actor dispatcher and key-pairs dispatcher on the given
 * Federation instance.
 */
export function setupActorDispatcher(fed: Federation<FedifyContextData>): void {
  fed
    .setActorDispatcher('/users/{identifier}', async (ctx, identifier) => {
      const env = ctx.data.env;
      const domain = env.INSTANCE_DOMAIN;

      // ---- Instance actor (special case) ----
      if (identifier === '__instance__') {
        return buildInstanceActor(env, domain);
      }

      // ---- Regular user actors ----
      const account = await env.DB.prepare(
        `SELECT * FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1`,
      )
        .bind(identifier)
        .first<AccountRow>();

      if (!account) return null;

      // Suspended actors: return null so the request falls through to
      // the Hono Tombstone fallback route at /users/:username.
      if (account.suspended_at) return null;

      const actorKey = await env.DB.prepare(
        `SELECT * FROM actor_keys WHERE account_id = ?1 ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(account.id)
        .first<ActorKeyRow>();

      if (!actorKey) return null;

      const actorUri = `https://${domain}/users/${account.username}`;
      const actorUrl = `https://${domain}/@${account.username}`;

      // --- Parse alsoKnownAs ---
      let alsoKnownAs: URL[] = [];
      if (account.also_known_as) {
        try {
          const parsed = JSON.parse(account.also_known_as);
          if (Array.isArray(parsed)) {
            alsoKnownAs = parsed.map((u: string) => new URL(u));
          }
        } catch {
          // skip
        }
      }

      // --- Resolve movedTo ---
      let successor: URL | undefined;
      if (account.moved_to_account_id) {
        const target = await env.DB.prepare(
          `SELECT uri FROM accounts WHERE id = ?1 LIMIT 1`,
        )
          .bind(account.moved_to_account_id)
          .first<{ uri: string }>();
        if (target) {
          successor = new URL(target.uri);
        }
      }

      // --- Profile metadata fields (PropertyValue) ---
      const attachments: PropertyValue[] = [];
      const fieldsJson = (account as unknown as Record<string, unknown>)
        .fields as string | null | undefined;
      if (fieldsJson) {
        try {
          const fields: ProfileField[] = JSON.parse(fieldsJson);
          if (Array.isArray(fields)) {
            for (const f of fields) {
              attachments.push(new PropertyValue({ name: f.name, value: f.value }));
            }
          }
        } catch {
          // skip
        }
      }

      // --- Custom emoji tags ---
      const textToScan = `${account.display_name || ''} ${account.note || ''}`;
      const shortcodes = extractEmojiShortcodes(textToScan);
      const tags: Emoji[] = [];

      if (shortcodes.length > 0) {
        const placeholders = shortcodes.map((_: string, i: number) => `?${i + 1}`).join(', ');
        const { results } = await env.DB.prepare(
          `SELECT * FROM custom_emojis WHERE shortcode IN (${placeholders}) AND (domain IS NULL OR domain = '${domain}')`,
        )
          .bind(...shortcodes)
          .all();
        const customEmojis = (results ?? []) as unknown as CustomEmojiRow[];
        for (const emoji of customEmojis) {
          tags.push(
            new Emoji({
              id: new URL(`https://${domain}/emojis/${emoji.shortcode}`),
              name: `:${emoji.shortcode}:`,
              icon: new Image({
                url: new URL(emoji.image_key),
                mediaType: 'image/png',
              }),
            }),
          );
        }
      }

      // --- RSA public key for publicKey field ---
      const rsaPubCryptoKey = await importRsaPublicKey(actorKey.public_key);

      // --- Ed25519 assertionMethod (generate if missing) ---
      let ed25519PubBase64 = actorKey.ed25519_public_key as string | null;
      if (!ed25519PubBase64) {
        // Lazy-generate Ed25519 key pair on first actor fetch
        try {
          const generated = await generateEd25519KeyPair();
          await env.DB.prepare(
            'UPDATE actor_keys SET ed25519_public_key = ?1, ed25519_private_key = ?2 WHERE account_id = ?3',
          ).bind(generated.publicKey, generated.privateKey, account.id).run();
          ed25519PubBase64 = generated.publicKey;
          console.log(`[actor] Generated Ed25519 key for ${account.username}`);
        } catch (e) {
          console.error(`[actor] Failed to generate Ed25519 key:`, e);
        }
      }
      let assertionMethod: Multikey | undefined;
      if (ed25519PubBase64) {
        const ed25519PubCryptoKey = await importEd25519Pub(ed25519PubBase64);
        assertionMethod = new Multikey({
          id: new URL(`${actorUri}#ed25519-key`),
          controller: new URL(actorUri),
          publicKey: ed25519PubCryptoKey,
        });
      }

      // --- Determine actor type ---
      const ActorClass = account.bot ? Service : Person;

      const actor = new ActorClass({
        id: new URL(actorUri),
        preferredUsername: account.username,
        name: account.display_name || account.username,
        summary: account.note || null,
        url: new URL(actorUrl),
        inbox: new URL(`${actorUri}/inbox`),
        outbox: new URL(`${actorUri}/outbox`),
        followers: new URL(`${actorUri}/followers`),
        following: new URL(`${actorUri}/following`),
        featured: new URL(`${actorUri}/collections/featured`),
        featuredTags: new URL(`${actorUri}/collections/tags`),
        publicKey: new CryptographicKey({
          id: new URL(actorKey.key_id),
          owner: new URL(actorUri),
          publicKey: rsaPubCryptoKey,
        }),
        ...(assertionMethod ? { assertionMethod } : {}),
        endpoints: new Endpoints({
          sharedInbox: new URL(`https://${domain}/inbox`),
        }),
        manuallyApprovesFollowers: account.manually_approves_followers === 1,
        discoverable: account.discoverable === 1,
        published: account.created_at
          ? Temporal.Instant.from(account.created_at)
          : null,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(alsoKnownAs.length > 0 ? { aliases: alsoKnownAs } : {}),
        ...(successor ? { successor } : {}),
        // icon (avatar)
        ...(account.avatar_url && account.avatar_url !== ''
          ? {
              icon: new Image({
                url: new URL(account.avatar_url),
                mediaType: 'image/png',
              }),
            }
          : {}),
        // image (header)
        ...(account.header_url && account.header_url !== ''
          ? {
              image: new Image({
                url: new URL(account.header_url),
                mediaType: 'image/png',
              }),
            }
          : {}),
      });

      return actor;
    })
    .setKeyPairsDispatcher(async (ctx, identifier) => {
      const env = ctx.data.env;
      const domain = env.INSTANCE_DOMAIN;

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

      // Ed25519 key pair — generate on the fly if missing
      let ed25519Pub = actorKey.ed25519_public_key;
      let ed25519Priv = actorKey.ed25519_private_key;

      if (!ed25519Pub || !ed25519Priv) {
        const generated = await generateEd25519KeyPair();
        ed25519Pub = generated.publicKey;
        ed25519Priv = generated.privateKey;

        // Persist the newly generated keys back to the database
        await env.DB.prepare(
          `UPDATE actor_keys SET ed25519_public_key = ?1, ed25519_private_key = ?2 WHERE id = ?3`,
        )
          .bind(ed25519Pub, ed25519Priv, actorKey.id)
          .run();
      }

      const ed25519PublicKey = await importEd25519Pub(ed25519Pub);
      const ed25519PrivateKey = await importEd25519Priv(ed25519Priv);
      keyPairs.push({ publicKey: ed25519PublicKey, privateKey: ed25519PrivateKey });

      return keyPairs;
    });

  // Add custom WebFinger links (profile-page, subscribe template)
  fed.setWebFingerLinksDispatcher(async (ctx, resource): Promise<readonly WebFingerLink[]> => {
    const env = ctx.data.env;
    const domain = env.INSTANCE_DOMAIN;

    // Parse the acct: URI to get the username
    const resourceStr = resource.toString();
    const acctMatch = resourceStr.match(/^acct:([^@]+)@(.+)$/i);
    if (!acctMatch) return [];

    const [, username, resourceDomain] = acctMatch;
    if (resourceDomain!.toLowerCase() !== domain.toLowerCase()) return [];

    // Instance actor case
    if (username!.toLowerCase() === domain.toLowerCase()) return [];

    const profileUrl = `https://${domain}/@${username}`;

    return [
      {
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: profileUrl,
      },
      {
        rel: 'http://ostatus.org/schema/1.0/subscribe',
        template: `https://${domain}/authorize_interaction?uri={uri}`,
      },
    ];
  });
}

/**
 * Build the instance-level Application actor.
 */
async function buildInstanceActor(
  env: { DB: D1Database; INSTANCE_DOMAIN: string; INSTANCE_TITLE: string },
  domain: string,
): Promise<Application | null> {
  // Look up existing instance actor key
  const actorKey = await env.DB.prepare(
    "SELECT * FROM actor_keys WHERE account_id = '__instance__'",
  ).first<ActorKeyRow>();

  if (!actorKey) {
    // Instance actor not initialised yet; let the old endpoint handle lazy-init.
    return null;
  }

  const actorId = `https://${domain}/actor`;
  const rsaPubCryptoKey = await importRsaPublicKey(actorKey.public_key);

  let assertionMethod: Multikey | undefined;
  if (actorKey.ed25519_public_key) {
    const ed25519PubCryptoKey = await importEd25519Pub(actorKey.ed25519_public_key);
    assertionMethod = new Multikey({
      id: new URL(`${actorId}#ed25519-key`),
      controller: new URL(actorId),
      publicKey: ed25519PubCryptoKey,
    });
  }

  return new Application({
    id: new URL(actorId),
    preferredUsername: domain,
    name: env.INSTANCE_TITLE || 'SiliconBeest',
    summary: `Instance actor for ${domain}`,
    inbox: new URL(`https://${domain}/inbox`),
    outbox: new URL(`https://${domain}/outbox`),
    url: new URL(`https://${domain}/about`),
    manuallyApprovesFollowers: true,
    publicKey: new CryptographicKey({
      id: new URL(`${actorId}#main-key`),
      owner: new URL(actorId),
      publicKey: rsaPubCryptoKey,
    }),
    ...(assertionMethod ? { assertionMethod } : {}),
    endpoints: new Endpoints({
      sharedInbox: new URL(`https://${domain}/inbox`),
    }),
  });
}
