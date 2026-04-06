/**
 * Shared worker types.
 */

import type { Federation } from '@fedify/fedify';
import type { FedifyContextData } from './federation/fedify';

/**
 * Hono context variables set by middleware.
 */
export type AppVariables = {
  currentUser: {
    readonly id: string;
    readonly account_id: string;
    readonly email: string;
    readonly role: string;
  } | null;
  currentAccount: {
    readonly id: string;
    readonly username: string;
    readonly domain: string | null;
  } | null;
  /** OAuth token scopes (space-separated), e.g. "read write follow push". */
  tokenScopes: string | null;
  /** The oauth_access_tokens row ID for the current bearer token. */
  tokenId: string | null;
  requestId: string;
  /** True when the client accepts ActivityPub content types. */
  isActivityPub: boolean;
  /** Fedify Federation instance (created per-request in middleware). */
  federation: Federation<FedifyContextData>;
};
