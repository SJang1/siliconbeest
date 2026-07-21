/**
 * Centralized version constants for SiliconBeest.
 *
 * At build time Vite/wrangler may define `__GIT_HASH__` with the short
 * commit hash.  When present the SiliconBeest version becomes e.g.
 * "0.1.0+a9e597a"; otherwise it falls back to the plain semver string.
 */

export const SILICONBEEST_BASE_VERSION = '1.2.35';

declare const __GIT_HASH__: string | undefined;

const gitHash = typeof __GIT_HASH__ !== 'undefined' ? __GIT_HASH__ : '';

/** SiliconBeest version — e.g. "0.1.0" or "0.1.0+a9e597a" */
export const SILICONBEEST_VERSION = gitHash
  ? `${SILICONBEEST_BASE_VERSION}+${gitHash}`
  : SILICONBEEST_BASE_VERSION;

/** Mastodon-compatible version string for /api/v1/instance */
export const MASTODON_V1_VERSION = `4.0.0 (compatible; SiliconBeest ${SILICONBEEST_VERSION})`;

/** Mastodon-compatible version string for /api/v2/instance */
export const MASTODON_V2_VERSION = MASTODON_V1_VERSION;

/** Mastodon-compatible version string used by InstanceService */
export const MASTODON_SERVICE_VERSION = `4.2.0 (compatible; siliconbeest/${SILICONBEEST_VERSION})`;
