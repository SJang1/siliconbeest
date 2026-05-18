export const ACTIVITYPUB_CONTENT_TYPE = 'application/activity+json';

const LOCAL_USERNAME_RE = /^[A-Za-z0-9_]{1,30}$/;
const STATUS_ID_RE = /^[A-Za-z0-9]+$/;
const RESERVED_PROFILE_SUBPATHS = new Set(['followers', 'following']);

export interface ActivityPubAlternate {
  href: string;
  headerValue: string;
  htmlTag: string;
}

export type ActivityPubAlternateCandidate =
  | { type: 'profile'; username: string }
  | { type: 'status'; username: string; statusId: string };

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function parseActivityPubAlternateCandidate(
  pathname: string,
): ActivityPubAlternateCandidate | null {
  const match = pathname.match(/^\/(?:@|%40)([^/]+)(?:\/([^/]+))?\/?$/i);
  if (!match?.[1]) return null;

  const username = safeDecodeURIComponent(match[1]);
  if (!username || !LOCAL_USERNAME_RE.test(username)) return null;

  const rawStatusId = match[2];
  if (!rawStatusId) {
    return { type: 'profile', username };
  }

  const statusId = safeDecodeURIComponent(rawStatusId);
  if (
    !statusId ||
    RESERVED_PROFILE_SUBPATHS.has(statusId.toLowerCase()) ||
    !STATUS_ID_RE.test(statusId)
  ) {
    return null;
  }

  return { type: 'status', username, statusId };
}

export function buildActivityPubAlternate(href: string): ActivityPubAlternate {
  const escapedHref = escapeAttr(href);
  return {
    href,
    headerValue: `<${href}>; rel="alternate"; type="${ACTIVITYPUB_CONTENT_TYPE}"`,
    htmlTag: `<link rel="alternate" type="${ACTIVITYPUB_CONTENT_TYPE}" href="${escapedHref}" />`,
  };
}

export async function resolveActivityPubAlternate(
  url: URL,
  db: D1Database,
): Promise<ActivityPubAlternate | null> {
  const candidate = parseActivityPubAlternateCandidate(url.pathname);
  if (!candidate) return null;

  try {
    if (candidate.type === 'profile') {
      const account = await db
        .prepare(
          `SELECT uri
           FROM accounts
           WHERE username = ?1
             AND domain IS NULL
             AND suspended_at IS NULL
           LIMIT 1`,
        )
        .bind(candidate.username)
        .first<{ uri: string | null }>();

      return account?.uri ? buildActivityPubAlternate(account.uri) : null;
    }

    const status = await db
      .prepare(
        `SELECT s.uri
         FROM statuses s
         JOIN accounts a ON a.id = s.account_id
         WHERE s.id = ?1
           AND a.username = ?2
           AND a.domain IS NULL
           AND s.deleted_at IS NULL
           AND s.visibility IN ('public', 'unlisted')
         LIMIT 1`,
      )
      .bind(candidate.statusId, candidate.username)
      .first<{ uri: string | null }>();

    return status?.uri ? buildActivityPubAlternate(status.uri) : null;
  } catch (error) {
    console.error('[activitypub-alternate] Failed to resolve alternate link:', error);
    return null;
  }
}

export function injectActivityPubAlternateHtml(
  html: string,
  alternate: ActivityPubAlternate,
): string {
  if (html.includes(`type="${ACTIVITYPUB_CONTENT_TYPE}"`)) {
    return html;
  }

  const headCloseIndex = html.search(/<\/head>/i);
  if (headCloseIndex === -1) return html;

  return `${html.slice(0, headCloseIndex)}  ${alternate.htmlTag}
${html.slice(headCloseIndex)}`;
}
