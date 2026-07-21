# Contributing to SiliconBeest

Thank you for your interest in SiliconBeest. Contributions of all sizes are welcome, including typo fixes, bug fixes, new features, tests, and documentation improvements.

SiliconBeest is a monorepo containing an ActivityPub server, a Mastodon-compatible API, and a Vue/Nuxt frontend running on Cloudflare Workers. Even a small change can affect authentication, content visibility, or federation delivery, so please include relevant tests with your contribution.

한국어로 된 기여 안내는 [CONTRIBUTING.ko.md](CONTRIBUTING.ko.md)를 참고하세요.

## Before You Start

- Search existing issues and pull requests before reporting a bug or proposing a feature.
- Discuss changes that substantially alter behavior or compatibility in an issue before implementation.
- Keep each pull request focused on one logical change whenever possible.
- Never commit API keys, tokens, passwords, real user data, `.env`, `.dev.vars`, or `scripts/config.env`.
- Do not publish exploit details or secrets in a public issue. Coordinate security-sensitive reports privately with the repository owner first.

## Development Environment

You will need:

- Node.js `25+`
- pnpm `10.9.0`
- Wrangler `4.x` and a Cloudflare account when working with local Workers or Cloudflare resources

If you need a Paid Cloudflare Workers environment for testing while developing SiliconBeest, email [siliconsjang@gmail.com](mailto:siliconsjang@gmail.com) to request free access. We will give you an temporarily Cloudflare Workers `Enterprise plan` or a `Paid plan` environment. If your testing requires federation with other servers, you **must** explicitly state that requirement in your request so the environment can be prepared appropriately.

Fork the repository and install its dependencies:

```bash
git clone <your-fork-url>
cd siliconbeest
pnpm install --frozen-lockfile
git remote add upstream https://github.com/SJang1/siliconbeest.git
```

Create a working branch from the latest `main`:

```bash
git fetch upstream
git switch main
git rebase upstream/main
git switch -c fix/short-description
```

## Repository Layout

| Path | Purpose |
| --- | --- |
| `siliconbeest/` | Hono API Worker and Vue/Nuxt web application |
| `siliconbeest/server/worker/` | Mastodon API, authentication, ActivityPub, services, and repositories |
| `siliconbeest/src/` | Vue components, views, stores, and localization resources |
| `siliconbeest/migrations/` | Cloudflare D1 schema migrations |
| `siliconbeest-queue-consumer/` | Asynchronous federation delivery, timeline fanout, and notification jobs |
| `siliconbeest-email-sender/` | Email queue consumer and SMTP delivery |
| `packages/shared/` | Types and utilities shared by multiple Workers |
| `scripts/` | Installation, configuration, migration, deployment, and maintenance scripts |
| `docs/` | Architecture and feature documentation |

See the [root README](README.md) and the README in each package for more detail.

## Running Locally

Start the main application:

```bash
pnpm --filter siliconbeest-vue dev
```

To exercise queue processing or email delivery, start the other Workers in separate terminals:

```bash
pnpm --filter siliconbeest-queue-consumer dev
pnpm --filter siliconbeest-email-sender dev
```

Apply migrations to the local D1 database with:

```bash
./scripts/migrate.sh --local
```

The full `./scripts/setup.sh` workflow is not required for ordinary unit tests or UI work. When testing Queue, D1, R2, or KV bindings across local Workers, follow the [deployment guide](docs/deploy/README.md) and [scripts documentation](scripts/README.md).

## Guidelines for Changes

### Code and Types

- Follow the style and design of nearby files and keep TypeScript types explicit and accurate.
- Avoid `any`, floating promises, parameter reassignment, and unnecessary mutable state. `siliconbeest/oxlint.config.ts` and `siliconbeest/eslint.config.ts` define the detailed rules for server code.
- Keep business logic in the service layer and data access in the repository layer where practical.
- Validate API input consistently with nearby endpoints, and preserve error handling and authorization checks.
- When changing a shared message or API type, keep producers, consumers, and definitions in `packages/shared/` synchronized.

### ActivityPub, Authentication, and Authorization

- Consider every visibility level (`public`, `unlisted`, `private`, and `direct`) and the distinction between local and remote accounts.
- Federation changes must preserve signature verification, audience targeting, idempotency, retries, and dead-letter queue behavior.
- Authentication endpoints must enforce OAuth scopes, account suspension, administrator permissions, and object ownership where applicable.
- Code that fetches external URLs must retain SSRF protections, allowed-protocol checks, redirect handling, size limits, and timeouts.
- Permission and visibility fixes should test both allowed and denied cases.

### Database Migrations

- Add schema changes as the next numbered SQL file under `siliconbeest/migrations/`. Do not modify migrations that may already have been deployed.
- Use the filename format `NNNN_short_description.sql`.
- Verify that the migration is safe for an instance with existing data and that its indexes and rollout order are appropriate.
- Describe data transformations, compatibility concerns, and operational steps in the pull request, and apply the migration locally.

```bash
./scripts/migrate.sh --local
```

### Cloudflare Bindings and Generated Types

After changing a binding in `wrangler.jsonc`, regenerate the affected Worker types and review the generated declarations:

```bash
pnpm --filter siliconbeest-vue cf-typegen
pnpm --filter siliconbeest-queue-consumer cf-typegen
pnpm --filter siliconbeest-email-sender cf-typegen
```

Before committing, confirm that generated files and configuration files do not contain secrets or resource IDs from your personal account.

### Frontend and Localization

- Reuse existing components and the [design system](docs/design-system.md), and check keyboard navigation, focus behavior, color contrast, and other accessibility concerns.
- Put user-facing strings in the existing i18n structure. If you cannot provide every translation, ensure that the default English key is present.
- Consider responsive layouts, dark mode, and right-to-left languages.

## Tests and Quality Checks

Run the nearest relevant test suite while developing:

```bash
# Main web application tests
pnpm --filter siliconbeest-vue test:vue

# Main API Worker tests
pnpm --filter siliconbeest-vue test:worker

# Queue consumer tests
pnpm --filter siliconbeest-queue-consumer test
```

Bug fixes should include a regression test that fails before the fix and passes afterward. New features should cover successful requests, error paths, and authorization boundaries. Follow the existing `*.test.ts` patterns close to the implementation.

Before opening a pull request, run the following checks from the repository root when applicable:

```bash
pnpm lint
pnpm test
pnpm --filter siliconbeest-vue type-check
pnpm build
```

For changes that directly affect Worker types, also run:

```bash
pnpm --dir siliconbeest exec tsc --noEmit -p tsconfig.worker.json
pnpm --dir siliconbeest-queue-consumer exec tsc --noEmit
pnpm --dir siliconbeest-email-sender exec tsc --noEmit
```

Documentation-only changes may omit the full test suite, but verify that links and command examples match the current repository. Mention any checks you could not run and explain why in the pull request.

## Commits and Pull Requests

Write short, specific commit messages that explain the purpose of the change. Do not combine large formatting changes or unrelated refactors with a functional change.

Open pull requests against `main` and include:

- What changed and why
- A link to the related issue
- Tests run and their results
- Before-and-after screenshots or a short recording for UI changes
- Operational impact from migrations, bindings, environment variables, or deployment ordering
- Compatibility and security impact for API or federation changes

Before submitting:

- [ ] The change is focused on one purpose.
- [ ] Relevant tests were added or updated.
- [ ] Linting, tests, type checks, and builds were run for the affected scope.
- [ ] User-facing behavior and configuration changes were documented.
- [ ] No secrets, personal resource IDs, generated artifacts, or debug logs were included.
- [ ] New dependencies are necessary and their license impact was reviewed.

For non-draft pull requests from branches in the same repository, a preview Worker may be created after approval. Automatic previews do not run for fork-based pull requests for security reasons, so provide thorough local verification results.

## License

Contributions are distributed under the same [GNU Affero General Public License v3.0](LICENSE) as this project. The AGPLv3 source-availability requirements also apply to modified versions deployed as network services.
