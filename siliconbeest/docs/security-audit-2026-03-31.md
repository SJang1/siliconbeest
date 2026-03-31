# Security Audit — 2026-03-31

## Remediated Issues

1. **Auth middleware skips suspension/disabled checks** (CRITICAL → FIXED) — `middleware/auth.ts` now checks `suspended_at` and `disabled` on every token resolution, including cache hits.

2. **No OAuth scope enforcement** (CRITICAL → FIXED) — `scopeCheck.ts` middleware enforces Mastodon-compatible scope hierarchy on all API endpoints. Admin endpoints use role-based access (adminRequired) rather than scope-based.

3. **Domain blocks not enforced on federation** (CRITICAL → FIXED) — `domainBlock.ts` helper checks `domain_blocks` table with KV caching. All 13 inbox listeners drop activities from suspended domains. `resolveRemoteAccount` refuses suspended domains. Cache invalidated on admin CRUD.

4. **OAuth tokens stored plaintext** (CRITICAL → FIXED) — Tokens now stored as SHA-256 hashes in `token_hash` column. Legacy plaintext fallback for migration period.

5. **Registration ignores email_domain_blocks** (HIGH → FIXED) — Registration endpoint now checks `email_domain_blocks` table.

6. **Remote content not sanitized** (MEDIUM → FIXED) — `processCreate` and `processUpdate` now pass remote content through `sanitizeHtml()`.

7. **No CSP headers** (MEDIUM → FIXED) — Security headers middleware adds CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy.

8. **No admin rate limiting** (MEDIUM → FIXED) — Admin API endpoints rate-limited to 60 req/5min.

9. **Proxy SSRF bypasses** (HIGH → FIXED) — Hardened against hex/decimal/octal IPs, IPv6 private ranges, DNS rebinding, embedded credentials.

## Remaining Items (Future Work)

- **client_secret plaintext** — OAuth app client_secret stored in plaintext. Low priority since only visible to app creator.
- **No TOTP lockout** — No account lockout after failed TOTP attempts. Mitigated by auth rate limit (30 req/5min).
- **OAuth CSRF on authorize** — State parameter should be session-bound. Partially mitigated by PKCE.
- **Token cache staleness** — Cached tokens valid for 5 min after revocation. Acceptable tradeoff. Now mitigated by suspension check on cache hit.
- **No idempotency key** — Status creation doesn't deduplicate. `idempotencyKey.ts` exists but isn't wired up.
- **Outbox exposes to blocked accounts** — ActivityPub outbox serves public/unlisted without checking requester blocks. Fedify limitation.
- **GDPR gaps** — No explicit right-to-be-forgotten endpoint. Script exists for account deletion.
- **OTP key rotation** — No rotation mechanism for OTP_ENCRYPTION_KEY.
