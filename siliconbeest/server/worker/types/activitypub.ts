/**
 * ActivityPub / ActivityStreams Types
 *
 * W3C ActivityPub protocol type definitions.
 * See: https://www.w3.org/TR/activitypub/
 *      https://www.w3.org/TR/activitystreams-core/
 */

// ============================================================
// JSON-LD CONTEXT
// ============================================================

export type APContextValue =
  | string
  | Record<string, unknown>;

export type APContext =
  | string
  | APContextValue[];

// ============================================================
// LINK / ADDRESSABLE
// ============================================================

/** A string URI or a Link/Object reference */
export type APObjectOrLink = string | APObject;

/** One or many references */
export type APOneOrMany<T> = T | T[];

// ============================================================
// BASE OBJECT
// ============================================================

export interface APObject {
  '@context'?: APContext;
  id?: string;
  type: string;
  name?: string | null;
  nameMap?: Record<string, string>;
  content?: string | null;
  contentMap?: Record<string, string>;
  summary?: string | null;
  summaryMap?: Record<string, string>;
  published?: string;
  updated?: string;
  url?: APOneOrMany<string>;
  to?: APOneOrMany<string>;
  cc?: APOneOrMany<string>;
  bto?: APOneOrMany<string>;
  bcc?: APOneOrMany<string>;
  attributedTo?: APOneOrMany<string>;
  inReplyTo?: string | null;
  tag?: APTag[];
  attachment?: (APDocument | APPropertyValue | Record<string, unknown>)[];
  sensitive?: boolean;
  mediaType?: string;
  replies?: APCollection | APOrderedCollection | string;
}

// ============================================================
// ACTOR
// ============================================================

export interface APMultikey {
  id: string;
  type: 'Multikey';
  controller: string;
  publicKeyMultibase: string;
}

export interface APActor extends APObject {
  type: 'Person' | 'Service' | 'Application' | 'Group' | 'Organization';
  preferredUsername: string;
  inbox: string;
  outbox: string;
  followers?: string;
  following?: string;
  featured?: string;
  featuredTags?: string;
  publicKey?: APPublicKey;
  assertionMethod?: APMultikey[];
  endpoints?: APEndpoints;
  icon?: APImage | null;
  image?: APImage | null;
  summary?: string | null;
  manuallyApprovesFollowers?: boolean;
  discoverable?: boolean;
  url?: string;
  movedTo?: string;
  alsoKnownAs?: string[];
  attachment?: (APDocument | APPropertyValue)[];
  tag?: APTag[];
}

// ============================================================
// NOTE
// ============================================================

export interface APNote extends APObject {
  type: 'Note';
  source?: {
    content: string;
    mediaType: string;
  };
  conversation?: string;
  replies?: APCollection | APOrderedCollection | string;
  atomUri?: string;
  /** FEP-e232: Quote post URI */
  quoteUri?: string;
  // Misskey-specific extensions
  _misskey_content?: string;      // MFM (Misskey Flavored Markdown) source
  _misskey_summary?: string;      // CW text in MFM
  _misskey_reaction?: string;     // Emoji reaction (used in Like activities)
  _misskey_quote?: string;        // Quote post URI
  _misskey_talk?: boolean;        // Chat message flag
}

// ============================================================
// DOCUMENT / IMAGE
// ============================================================

export interface APDocument extends APObject {
  type: 'Document' | 'Image' | 'Audio' | 'Video';
  mediaType?: string;
  url?: string;
  width?: number;
  height?: number;
  blurhash?: string;
  name?: string | null;
}

export interface APImage {
  type: 'Image';
  url: string;
  mediaType?: string;
}

// ============================================================
// PROPERTY VALUE (Profile Metadata Fields)
// ============================================================

export interface APPropertyValue {
  type: 'PropertyValue';
  name: string;
  value: string;
}

// ============================================================
// TAG
// ============================================================

export interface APTag {
  type: 'Mention' | 'Hashtag' | 'Emoji';
  href?: string;
  name: string;
  icon?: APImage;
}

// ============================================================
// PUBLIC KEY / ENDPOINTS
// ============================================================

export interface APPublicKey {
  id: string;
  owner: string;
  publicKeyPem: string;
}

export interface APEndpoints {
  sharedInbox?: string;
}

// ============================================================
// ACTIVITY (BASE)
// ============================================================

export interface APDataIntegrityProof {
  type: 'DataIntegrityProof';
  cryptosuite: string;
  verificationMethod: string;
  proofPurpose: string;
  proofValue: string;
  created: string;
}

export interface APActivity {
  '@context'?: APContext;
  id?: string;
  type: string;
  actor: string;
  object?: APOneOrMany<string | APObject | Record<string, unknown>>;
  target?: string | APObject;
  published?: string;
  to?: APOneOrMany<string>;
  cc?: APOneOrMany<string>;
  content?: string | null;
  signature?: APSignature;
  proof?: APDataIntegrityProof;
}

export interface APSignature {
  type: string;
  creator: string;
  created: string;
  signatureValue: string;
}

// ============================================================
// SPECIFIC ACTIVITY TYPES
// ============================================================

export interface APCreate extends APActivity {
  type: 'Create';
  object: APNote | APObject;
}

export interface APUpdate extends APActivity {
  type: 'Update';
  object: APNote | APActor | APObject;
}

export interface APDelete extends APActivity {
  type: 'Delete';
  object: string | APObject;
}

export interface APFollow extends APActivity {
  type: 'Follow';
  object: string;
}

export interface APAccept extends APActivity {
  type: 'Accept';
  object: APFollow | APActivity | string;
}

export interface APReject extends APActivity {
  type: 'Reject';
  object: APFollow | APActivity | string;
}

export interface APLike extends APActivity {
  type: 'Like';
  object: string;
}

export interface APAnnounce extends APActivity {
  type: 'Announce';
  object: string;
}

export interface APUndo extends APActivity {
  type: 'Undo';
  object: APFollow | APLike | APAnnounce | APBlock | APActivity | string;
}

export interface APBlock extends APActivity {
  type: 'Block';
  object: string;
}

export interface APMove extends APActivity {
  type: 'Move';
  object: string;
  target: string;
}

export interface APFlag extends APActivity {
  type: 'Flag';
  object: APOneOrMany<string>;
  content?: string;
}

// ============================================================
// COLLECTIONS
// ============================================================

export interface APCollection {
  '@context'?: APContext;
  id?: string;
  type: 'Collection';
  totalItems: number;
  first?: string | APCollectionPage;
  last?: string | APCollectionPage;
  current?: string | APCollectionPage;
  items?: APOneOrMany<string | APObject>;
}

export interface APOrderedCollection {
  '@context'?: APContext;
  id?: string;
  type: 'OrderedCollection';
  totalItems: number;
  first?: string | APOrderedCollectionPage;
  last?: string | APOrderedCollectionPage;
  current?: string | APOrderedCollectionPage;
  orderedItems?: (string | APObject)[];
}

export interface APCollectionPage {
  '@context'?: APContext;
  id?: string;
  type: 'CollectionPage';
  partOf: string;
  next?: string;
  prev?: string;
  items?: (string | APObject)[];
}

export interface APOrderedCollectionPage {
  '@context'?: APContext;
  id?: string;
  type: 'OrderedCollectionPage';
  partOf: string;
  next?: string;
  prev?: string;
  orderedItems?: (string | APObject)[];
}

// ============================================================
// UNION OF ALL INBOUND ACTIVITIES
// ============================================================

export type APInboundActivity =
  | APCreate
  | APUpdate
  | APDelete
  | APFollow
  | APAccept
  | APReject
  | APLike
  | APAnnounce
  | APUndo
  | APBlock
  | APMove
  | APFlag;
