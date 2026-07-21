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
} from '@fedify/vocab';
import { Temporal } from '@js-temporal/polyfill';
import type { Context, Federation } from '@fedify/fedify';
import type { Link as WebFingerLink } from '@fedify/webfinger';
import type { FedifyContextData } from '../fedify';
import type { AccountRow, ActorKeyRow, CustomEmojiRow } from '../../types/db';
import {
  importRsaPublicKey,
  importRsaPrivateKey,
  importEd25519PublicKey,
  importEd25519PrivateKey,
} from '../../../../../packages/shared/crypto/keys';
import { generateEd25519KeyPair } from '../../utils/crypto';
import { getInstanceTitle } from '../../services/instance';
import { canAccountOriginateFederationActivity } from '../../services/permissions';
import { env } from 'cloudflare:workers';

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
 * Register the actor dispatcher and key-pairs dispatcher on the given
 * Federation instance.
 */
export function setupActorDispatcher(fed: Federation<FedifyContextData>): void {
  fed
    .setActorDispatcher('/users/{identifier}', async (ctx, identifier) => {
      const domain = env.INSTANCE_DOMAIN;

      // ---- Instance actor (special case) ----
      if (identifier === '__instance__') {
        return buildInstanceActor(ctx, domain);
      }

      // ---- Regular user actors ----
      // ActivityPub identity is case-sensitive: the actor lives at the exact
      // `/users/<username>` path using the stored casing. We emit that canonical
      // URI everywhere, so remote servers always reference the exact case.
      // (Registration enforces case-insensitive uniqueness, so at most one
      // local account can match a given handle regardless of casing.)
      const account = await env.DB.prepare(
        `SELECT * FROM accounts WHERE username = ?1 AND domain IS NULL LIMIT 1`,
      )
        .bind(identifier)
        .first<AccountRow>();

      if (!account) return null;

      // Suspended actors fall through to the Tombstone route. Other inactive
      // local users (disabled, unapproved, memorial) are not discoverable.
      if (account.suspended_at) return null;
      if (!await canAccountOriginateFederationActivity(account.id)) return null;

      // Fedify-managed key pairs (RSA first, then Ed25519; lazily generated
      // by the key-pairs dispatcher below).  Serving fedify's own
      // CryptographicKey/Multikey objects keeps the published key IDs
      // (#main-key, #multikey-N) aligned with the keyIds fedify uses for
      // outbound HTTP signatures and FEP-8b32 integrity proofs — remote
      // servers resolve proof verificationMethods against this document.
      const keys = await ctx.getActorKeyPairs(identifier);
      if (keys.length === 0) return null;

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
      const fieldsJson = account.fields;
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
        const { results: customEmojis } = await env.DB.prepare(
          `SELECT * FROM custom_emojis WHERE shortcode IN (${placeholders}) AND (domain IS NULL OR domain = '${domain}')`,
        )
          .bind(...shortcodes)
          .all<CustomEmojiRow>();
        for (const emoji of customEmojis ?? []) {
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
        publicKey: keys[0].cryptographicKey,
        assertionMethods: keys.map((key) => key.multikey),
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
        if (!account) {
          console.warn(`[keyPairsDispatcher] No local account for identifier='${identifier}' — returning empty keyPairs (Fedify will fall back to unauthenticated loader)`);
          return [];
        }
        if (!await canAccountOriginateFederationActivity(account.id)) return [];
        accountId = account.id;
      }

      const actorKey = await env.DB.prepare(
        `SELECT * FROM actor_keys WHERE account_id = ?1 ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(accountId)
        .first<ActorKeyRow>();

      if (!actorKey) {
        console.warn(`[keyPairsDispatcher] No actor_keys row for account_id='${accountId}' (identifier='${identifier}') — returning empty keyPairs`);
        return [];
      }

      const keyPairs: CryptoKeyPair[] = [];

      // RSA key pair
      const rsaPublicKey = await importRsaPublicKey(actorKey.public_key);
      const rsaPrivateKey = await importRsaPrivateKey(actorKey.private_key);
      keyPairs.push({ publicKey: rsaPublicKey, privateKey: rsaPrivateKey });

      // Ed25519 key pair — generate on the fly if missing.
      // Early install/seed scripts stored these columns as PEM, which the
      // base64url importers below cannot read (atob throws). A PEM-seeded
      // key can never have been served or used — every import crashed — so
      // treat those rows as missing and regenerate.
      let ed25519Pub = actorKey.ed25519_public_key;
      let ed25519Priv = actorKey.ed25519_private_key;
      const isPemSeeded = (value: string | null): boolean =>
        value !== null && value.includes('-----BEGIN');

      if (!ed25519Pub || !ed25519Priv || isPemSeeded(ed25519Pub) || isPemSeeded(ed25519Priv)) {
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

      const ed25519PublicKey = await importEd25519PublicKey(ed25519Pub, true);
      const ed25519PrivateKey = await importEd25519PrivateKey(ed25519Priv, true);
      keyPairs.push({ publicKey: ed25519PublicKey, privateKey: ed25519PrivateKey });

      return keyPairs;
    });

  // Add custom WebFinger links (profile-page, subscribe template)
  fed.setWebFingerLinksDispatcher(async (ctx, resource): Promise<readonly WebFingerLink[]> => {
    const domain = env.INSTANCE_DOMAIN;

    // Parse the acct: URI to get the username
    const resourceStr = resource.toString();
    const acctMatch = resourceStr.match(/^acct:([^@]+)@(.+)$/i);
    if (!acctMatch) return [];

    const [, username, resourceDomain] = acctMatch;
    if (!resourceDomain || resourceDomain.toLowerCase() !== domain.toLowerCase()) return [];

    // Instance actor case
    if (!username || username.toLowerCase() === domain.toLowerCase()) return [];

    const account = await env.DB.prepare(
      `SELECT id FROM accounts
       WHERE username = ?1 AND domain IS NULL
       LIMIT 1`,
    ).bind(username).first<{ id: string }>();
    if (!account || !await canAccountOriginateFederationActivity(account.id)) return [];

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
  ctx: Context<FedifyContextData>,
  domain: string,
): Promise<Application | null> {
  // Fedify-managed key pairs (dispatched by the key-pairs dispatcher, which
  // also lazy-generates the Ed25519 key).  Empty means the instance actor is
  // not initialised yet; let the old endpoint handle lazy-init.
  const keys = await ctx.getActorKeyPairs('__instance__');
  if (keys.length === 0) return null;

  // The instance actor's `id` MUST equal Fedify's route URL
  // (`/users/__instance__`) so that the keyIds Fedify generates for outbound
  // signatures and proofs (`#main-key`, `#multikey-N`) match the
  // `publicKey`/`assertionMethod` IDs we serve.
  // The legacy `/actor` Hono endpoint keeps serving its own self-consistent
  // actor doc (with `id: /actor`) so existing relay subscriptions that point
  // there continue to verify successfully; same private key, different keyId.
  const actorId = `https://${domain}/users/__instance__`;

  return new Application({
    id: new URL(actorId),
    preferredUsername: domain,
    name: await getInstanceTitle(),
    summary: `Instance actor for ${domain}`,
    inbox: new URL(`https://${domain}/inbox`),
    outbox: new URL(`https://${domain}/outbox`),
    url: new URL(`https://${domain}/about`),
    manuallyApprovesFollowers: true,
    publicKey: keys[0].cryptographicKey,
    assertionMethods: keys.map((key) => key.multikey),
    endpoints: new Endpoints({
      sharedInbox: new URL(`https://${domain}/inbox`),
    }),
  });
}
