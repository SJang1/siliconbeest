# Optional Workers AI

[한국어](WORKERS_AI.ko.md)

SiliconBeest can use [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) for a recommended timeline, on-demand status translation, and automatic image ALT text. It is **disabled by default**. With the default configuration, the main Worker's Wrangler file has no AI or AI rate-limit bindings, no model inference runs, and no Workers AI usage is billed.

Activation has two layers:

1. The operator enables the deployment-wide `WORKERS_AI_ENABLED` master switch.
2. An administrator independently enables Recommended timeline, Status translation, and Automatic image ALT in Admin Settings.

All three administrator switches also default to off. A missing stored setting is interpreted as off, so an existing installation needs no Workers AI **feature-setting** migration or new feature-flag SQL statement. The existing instance-settings batch reads the three values without adding a query and hydrates one write-through KV snapshot; feature-flag checks on recommendation, translation, and upload request paths read that snapshot rather than D1. This is distinct from recommendation activity history: migration `0047_recommendation_activities.sql` adds the D1 table used to persist per-account recommendation signals. The master switch always wins: when it is off, all three features remain unavailable regardless of saved administrator choices.

## Enable it in GitHub Actions

Add these GitHub Actions variables to the `production` environment. Add the same variables separately to the `preview` environment only if trusted PR previews should use AI.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WORKERS_AI_ENABLED` | `false` | Master switch for all optional AI features |
| `WORKERS_AI_RECOMMENDATION_MODEL` | `@cf/baai/bge-m3` | Scores recommended-timeline candidates |
| `WORKERS_AI_TRANSLATION_MODEL` | `@cf/meta/m2m100-1.2b` | Translates status text |
| `WORKERS_AI_IMAGE_CAPTION_MODEL` | `@cf/moondream/moondream3.1-9B-A2B` | Generates image ALT text |
| `WORKERS_AI_RATE_LIMITS` | `true` | Adds native per-account inference guards when Workers AI is enabled |
| `WORKERS_AI_RECOMMENDATION_RATE_LIMIT` | `2` | Maximum recommendation page requests in one configured period |
| `WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS` | `60` | Recommendation limit period; only `10` or `60` is valid |
| `WORKERS_AI_TRANSLATION_RATE_LIMIT` | `6` | Maximum translation requests in one configured period |
| `WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS` | `60` | Translation limit period; only `10` or `60` is valid |
| `WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT` | `4` | Maximum automatic image-description attempts in one configured period |
| `WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS` | `60` | Image-description limit period; only `10` or `60` is valid |
| `WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID` | `1001` (`2001` in PR Preview) | Native rate-limit namespace for recommendation generation |
| `WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID` | `1002` (`2002` in PR Preview) | Native rate-limit namespace for translation |
| `WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID` | `1003` (`2003` in PR Preview) | Native rate-limit namespace for automatic ALT generation |

`WORKERS_AI_ENABLED` and `WORKERS_AI_RATE_LIMITS` accept only the lowercase strings `true` and `false`. An omitted master value becomes `false`, while omitted rate limiting becomes `true`; values such as `TRUE`, `1`, or `yes` stop configuration generation. Each limit must be a positive integer, and each period must be exactly `10` or `60` seconds.

After changing a variable, run the relevant workflow again. Configuration and type validation happen in this order:

1. Writes the GitHub variables to `scripts/config.env`.
2. Runs `./scripts/sync-config.sh --apply`.
3. Runs `cf-typegen`, then a full Worker `tsc --noEmit` check.
4. Builds the main Worker.
5. The deployment workflows run their normal D1 migration step and deploy; the PR Preview workflow uploads its preview version.

The Deploy, PR Preview, and Upstream Sync Deploy workflows all perform that type generation and Worker type check immediately after configuration sync. A binding mismatch therefore stops the workflow before build or deployment. The normal deployment migration step applies `0047_recommendation_activities.sql`, which creates and indexes the recommendation activity table and backfills each existing local user with their latest 30 eligible public posted, reposted, or liked signals. No separate migration is needed for the three administrator feature switches because they still use the existing settings store.

When Workers AI is enabled, the generated `siliconbeest/wrangler.jsonc` contains a remote binding named `AI`. It also contains three native Rate Limiting bindings when `WORKERS_AI_RATE_LIMITS=true`; setting that variable to `false` keeps `AI` but omits all `ratelimits` bindings. When `WORKERS_AI_ENABLED=false`, both `ai` and `ratelimits` are omitted regardless of the rate-limit setting. Model variables remain in `vars` in every mode, which keeps application configuration stable. The queue consumer and email sender never receive these bindings.

When both switches are `true`, each Rate Limiting namespace ID must be a positive integer string, the three IDs must be pairwise distinct, and each namespace should be unique within the Cloudflare account for the behavior it represents. Use different IDs for production and preview so preview traffic does not consume the production limits. Namespace IDs are not required when `WORKERS_AI_RATE_LIMITS=false`.

Cloudflare documents the native binding and `env.AI.run()` in [Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/), and the request guard in [Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## Local configuration

From the repository root, copy the example, enable the master switch, and regenerate Wrangler configuration. When native rate limiting is enabled, the namespace IDs below are examples; change them if those IDs are already used in the same Cloudflare account:

```bash
cp scripts/config.env.example scripts/config.env
```

```dotenv
WORKERS_AI_ENABLED=true
WORKERS_AI_RECOMMENDATION_MODEL=@cf/baai/bge-m3
WORKERS_AI_TRANSLATION_MODEL=@cf/meta/m2m100-1.2b
WORKERS_AI_IMAGE_CAPTION_MODEL=@cf/moondream/moondream3.1-9B-A2B
WORKERS_AI_RATE_LIMITS=true
WORKERS_AI_RECOMMENDATION_RATE_LIMIT=2
WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS=60
WORKERS_AI_TRANSLATION_RATE_LIMIT=6
WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS=60
WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT=4
WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS=60
WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID=1001
WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID=1002
WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID=1003
```

```bash
./scripts/sync-config.sh --apply
cd siliconbeest
pnpm cf-typegen
pnpm exec tsc --noEmit -p tsconfig.worker.json
pnpm type-check
```

Then start the built Worker locally:

```bash
pnpm preview
```

The remote AI binding requires Wrangler authentication. From `siliconbeest`, run `pnpm wrangler whoami` and, if necessary, `pnpm wrangler login` before starting the preview.

Sign in with an administrator account, open `/admin/settings`, enable only the AI features you want to exercise, and save. Enabling the deployment master switch alone intentionally does not expose any user-facing AI feature. Apply the repository's normal D1 migrations, including `0047_recommendation_activities.sql`, before testing recommendations. The administrator choices themselves need no feature-setting migration: they use the existing settings store, missing keys mean off, and inference throttling uses native Cloudflare bindings rather than D1 counters.

For a quick end-to-end check, open the separate AI recommendation-feed navigation entry and refresh it, request translation on an eligible public or unlisted status, and upload a supported image with an empty ALT field. The upload UI should show ALT generation in progress and then the generated description after the normal media-status poll completes.

`cf-typegen` automatically reads the tracked `scripts/typegen.env`. That file contains only type-generation placeholders for the `OTP_ENCRYPTION_KEY`, `SETUP_SECRET`, and `SENTRY_DSN` bindings; they are not runtime secrets and must never be deployed, used as local credentials, or replaced with real secrets. Do not edit `worker-configuration.d.ts` by hand; Wrangler generates it from the current Wrangler mode.

Run the same type generation, full Worker `tsc`, and application type check after switching AI on or off.

AI inference is not an offline operation. The generated binding is remote, so `pnpm preview` and PR previews send inputs to Cloudflare, consume Workers AI quota, and can incur cost. Plain `pnpm dev` runs the Nuxt development server and does not by itself provide the real Workers AI binding. Keep AI disabled in the GitHub `preview` environment unless the preview requires it and is trusted.

To stop local AI use, turn off the three administrator switches. To also remove the bindings, set `WORKERS_AI_ENABLED=false` in `scripts/config.env`, rerun `./scripts/sync-config.sh --apply`, and rerun `pnpm cf-typegen` from `siliconbeest`.

## Administrator feature switches

The three administrator switches are independent and are evaluated together with the deployment master switch:

| Administrator switch | User-visible result while off |
| --- | --- |
| Recommended timeline | The separate AI recommendation-feed navigation entry, page, and Deck column option are not shown. |
| Status translation | Translation controls are not shown on statuses. |
| Automatic image ALT | Uploads skip AI captioning. Manual ALT entry remains available because it is not an AI feature. |

Turning a switch off prevents its inference path as well as hiding its related user interface. The AI section remains visible to administrators. When the deployment master is off, its three controls are disabled and show deployment-configuration guidance; after the operator enables the master, an administrator can enable any subset.

The existing settings endpoint stores `workers_ai_recommendation_enabled`, `workers_ai_translation_enabled`, and `workers_ai_image_description_enabled`. Only the literal value `1` means on; a missing or any other value means off. Do not seed these keys with SQL.

## Feature behavior

### Recommended timeline

`POST /api/v1/timelines/recommended` generates a page; omit `cursor` for a fresh feed and pass the opaque Link cursor for its next page. Initial and continuation pages are both POST-only, and every request consumes the configured recommendation Rate Limiter binding when rate limiting is enabled. Each newly generated non-empty page runs inference; replaying a successful cursor can return its short-lived memoized result without another model call, and an empty candidate window ends the feed. Authentication and the `read:statuses` scope are required. The default page contains 30 statuses. D1 first builds a rolling window of up to five times the requested page size, capped at 200, from recent public statuses the user may view and statuses that may actually appear in that user's home feed. The requesting user's own eligible statuses remain candidates, Direct statuses are excluded, and an eligible boost is normalized to its original status. Existing visibility, account-state, block, and relationship filters run before any text is sent to AI. Because a home-feed-eligible status can have a non-public audience, the model may process non-public status text that the requesting user is authorized to view.

Home and AI recommendations are completely separate timelines, stores, routes, and navigation destinations. Aurora and Classic open recommendations as a dedicated feed page, while Deck can add a dedicated recommendation column. The recommendation feed does not replace, filter, or mix entries into Home, and refreshing recommendations does not refresh Home.

The interest query is derived from followed tags and public-status activity only. D1 keeps each account's latest 30 eligible `posted`, `reposted`, and `liked` signals in `recommendation_activities`; migration `0047_recommendation_activities.sql` backfills the same bounded history for existing local users. New signals, retention pruning above 30 records, and removals after undo or deletion are scheduled with the Worker's `waitUntil()` lifetime so the primary post, repost, like, undo, or deletion response does not wait for recommendation-history maintenance. Private-status activity is never recorded. When recommendations are generated, all retained activity records are read from D1 and resolved against the current status rows: an activity is used only while its source is still a public, non-deleted original (and a `posted` signal still belongs to that account). This live revalidation prevents a delayed background removal or later visibility change from exposing stale activity.

Tags, languages, and bounded text snippets from all of those retained signals are combined into the model query, with authored and reposted activity weighted more strongly than likes. The query is capped at 7,000 characters, giving the ranker an explicit user-interest signal rather than asking BGE-M3 to invent one. Each candidate context is converted to at most 400 characters of plain text, and obvious URLs, email addresses, and mentions are removed before inference; the remaining status text is still content sent to Cloudflare.

The default [BGE-M3](https://developers.cloudflare.com/workers-ai/models/bge-m3/) adapter uses the model's `query` plus ordered `contexts` scoring contract to rerank each rolling window. AI is not an authorization layer: D1 filtering happens first, and the selected page plus backups are revalidated after inference. The UI explicitly labels the result as an AI-generated recommendation feed. A continuation state fixes the refresh's initial time boundary and interest query and records displayed and invalidated IDs. For each page, those IDs are passed as one JSON binding and expanded with SQLite `json_each`, so D1 excludes them before selecting candidates. Unselected recent candidates stay eligible, older eligible posts replenish the window as exclusions grow, and the mixed window is ranked again. Consequently, 200 is a per-page candidate-window cap, not a feed-length cap: pagination continues without repeats until no eligible posts remain. Refreshing chooses a new time boundary and seed and clears the feed's displayed/invalidated exclusion set, then builds a new query from the persisted D1 activity history; it does not clear or rebuild that history.

If inference is unavailable or returns an invalid ranking, the UI reports that AI recommendation-feed generation failed and prompts the user to refresh and try again. It does not silently substitute an ordinary timeline. The ordinary home timeline is independent and remains available. KV is used only for the account-bound, five-minute pagination state: the fixed upper bound, seed, generated interest query, displayed/invalidated IDs, and memoized cursor response needed for stable retries. Persistent activity history lives in D1 rather than KV. Candidate post text and model scores are not persisted separately, and this implementation does not create a Vectorize index.

### Status translation

Translation is requested on demand through the POST-only `POST /api/v1/statuses/:id/translate?lang=...` route for an original public or unlisted status that the signed-in user is allowed to view; it requires the `read:statuses` OAuth scope. The `lang` parameter is optional and falls back to the user's locale, then English. The service decodes entities and extracts plain text from the sanitized status content, then escapes and linkifies the model result before returning safe HTML. Translation input longer than 10,000 characters is split at the preceding paragraph boundary, translated sequentially in batches, and combined in order. A single paragraph longer than the limit falls back to a safe character boundary. The built-in UI presents a lightweight, Twitter-style inline Translate action below eligible content. The original remains in place while the request is pending; when translation succeeds, it replaces the original in the same content slot and the action becomes Show original. The translated view identifies the model and warns that AI translations may be inaccurate. The UI does not offer translation for sensitive or content-warning-concealed statuses, so it cannot bypass their reveal control. If the feature's administrator switch or master switch is off, the translation control is not rendered. If the direction is unsupported or inference fails after a request begins, the original status remains visible and the translation UI reports the error.

[M2M100](https://developers.cloudflare.com/workers-ai/models/m2m100-1.2b/) is the general default. [IndicTrans2 English-to-Indic](https://developers.cloudflare.com/workers-ai/models/indictrans2-en-indic-1B/) is a specialized adapter: its input is English text plus a script-specific `target_language`, and its output is a `translations` array. It is not a drop-in replacement for M2M100's `source_lang` / `target_lang` and `translated_text` contract.

### Automatic image ALT text

ALT generation starts after the upload has been accepted and runs in the Worker's background lifetime. The initial `202` response reports `description_generation_status` as `pending`; the normal media-status GET returns `pending`, `complete`, `failed`, or `disabled` together with the current description. While pending, the upload UI shows that ALT generation is in progress. It runs only when both the master and Automatic image ALT administrator switches are on, and only for JPEG, PNG, and WebP uploads whose submitted description is blank and whose inference payload is at most 10 MiB. GIF, other formats, and larger files still upload normally but skip AI.

Generated text is normalized and capped at the application's 1,500-character ALT limit before it is stored with the media attachment. The database update succeeds only if the attachment is still unchanged and blank; any user edit, including an intentional blank save while generation is pending, wins and cannot be overwritten. If inference fails or returns an invalid/empty result, the upload remains successful with an empty ALT field so the user can add one manually.

The composer warns that AI ALT may be inaccurate and should be reviewed only for media generated from uploads in the current compose session. This also covers a generated description inserted into an Article's image Markdown. Successfully saving the normal ALT editor after review, or editing the generated Article Markdown, clears the notice. Existing attachments loaded while editing a post are not treated as newly generated uploads and do not show this notice.

The default [Moondream 3.1](https://developers.cloudflare.com/workers-ai/models/moondream3.1-9B-A2B/) adapter uses its caption task with a non-streaming response. The upload bytes are embedded for inference rather than fetched from the public media URL, so this path also works with local or private R2 objects. [LLaVA 1.5](https://developers.cloudflare.com/workers-ai/models/llava-1.5-7b-hf/) is the compatible fallback adapter for operators who accept its beta status. The legacy LLaVA and UForm byte-array adapters impose a stricter 4 MiB inference limit even though the Moondream path accepts eligible uploads up to the application's 10 MiB limit.

## Model selection and compatibility

Model IDs are variables because Cloudflare can introduce, deprecate, or replace models. They are **not arbitrary drop-in plug-ins**. Each feature validates a particular request and response contract. Before changing an ID, confirm that an adapter exists and run the AI-enabled tests and type checks.

| Feature | Recommendation | Compatibility notes |
| --- | --- | --- |
| Timeline | `@cf/baai/bge-m3` | Multilingual and supports the expected `query` + `contexts` ranking contract. An embedding-only or generative model cannot be substituted without an adapter and ranking changes. |
| Translation | `@cf/meta/m2m100-1.2b` | General translation contract. IndicTrans2 is English-to-Indic only and uses a different schema. |
| Image ALT | `@cf/moondream/moondream3.1-9B-A2B` | Preferred caption model. LLaVA 1.5 is a beta fallback with a different byte-array input and `description` output. |

[UForm Gen2](https://developers.cloudflare.com/workers-ai/models/uform-gen2-qwen-500m/) is an image-to-text model, but Cloudflare marks it deprecated as of May 30, 2026, so it is not recommended for a new deployment. [ResNet-50](https://developers.cloudflare.com/workers-ai/models/resnet-50/) returns image classifications rather than natural-language captions, so it is not suitable for accessible ALT generation.

## Privacy, limits, and cost

- Recommendation sends only candidate text that passed the requesting user's visibility and relationship checks, but this can include non-public statuses eligible for that user's home feed. Its activity profile uses followed tags and public-status activity only; private-status activity is excluded. Translation sends the viewable status text, and ALT generation sends the uploaded image. Do not enable these features if that processing is outside your instance's privacy notice or user expectations.
- SiliconBeest stores each account's latest 30 public posted, reposted, or liked recommendation signals in D1 as activity kind, source status ID, and occurrence time. Status text and metadata are resolved from the live status row when the interest query is built rather than copied into the activity table. Candidate contexts and model scores are not stored. KV contains only the five-minute, public-activity-derived pagination query and state; generated ALT text is stored because it becomes media metadata, while translation responses are not persisted by this feature.
- Cloudflare treats inputs and outputs as Customer Content and documents how it processes them in [Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/). Review that page and each model's license before enabling AI.
- Candidate counts, text length, image formats, and ALT length are bounded by the application. Models also have their own changing context, payload, and rate limits; invalid or oversized requests are rejected or skip AI according to the feature and never bypass access checks.
- Paid inference is guarded by Cloudflare's native Rate Limiting bindings. The defaults are 2 recommendation page requests, 6 translation requests, and 4 automatic image descriptions per account per 60 seconds; the variables above configure each limit and its 10- or 60-second period.
- Wrangler's generated `ratelimits[].simple.limit` and `ratelimits[].simple.period` values are the sole enforcement policy. Runtime code only calls the feature binding's `limit()` method with the signed-in account ID as its key. Both an initial recommendation `POST` and every cursor continuation `POST` consume this guard; recommendation `GET` requests are rejected rather than generating or retrieving a page.
- A declined recommendation or translation request returns `429`. If an enabled native guard is missing or fails, those synchronous endpoints fail closed with `503`. Automatic ALT generation runs in the background: an unavailable or declined guard marks generation as failed, but the image upload itself still succeeds.
- Setting `WORKERS_AI_RATE_LIMITS=false` removes all three native bindings and bypasses this application-level inference guard; the namespace IDs are then unnecessary. Use this opt-out only with another suitable cost and abuse control.
- Native Rate Limiting is best-effort, local to a Cloudflare location, and eventually consistent. It can allow some excess requests, so these limits reduce accidental or abusive inference but are not an exact accounting system or a hard spending cap. Use Cloudflare billing controls and dashboard monitoring for cost control.
- Every successful or attempted inference can consume Workers AI quota. Model rates and free allocations change, so use the [current pricing page](https://developers.cloudflare.com/workers-ai/platform/pricing/) and the Workers AI dashboard instead of relying on a fixed estimate in this repository.

## Verification matrix

Verify the generated configuration modes before deployment:

1. Set `WORKERS_AI_ENABLED=false`, run `./scripts/sync-config.sh --apply`, and confirm there are no top-level `ai` or `ratelimits` blocks in `siliconbeest/wrangler.jsonc`.
2. From `siliconbeest`, run `pnpm cf-typegen`, `pnpm exec tsc --noEmit -p tsconfig.worker.json`, and `pnpm type-check`.
3. Set `WORKERS_AI_ENABLED=true` and `WORKERS_AI_RATE_LIMITS=true`, regenerate, and confirm `ai.binding` is `AI`, `ai.remote` is `true`, and the three `ratelimits` bindings exist in the main Worker only with the configured `simple.limit` and `simple.period` values.
4. Keep `WORKERS_AI_ENABLED=true`, set `WORKERS_AI_RATE_LIMITS=false`, regenerate, and confirm the `AI` binding remains while `ratelimits` is omitted and namespace IDs are not required.
5. Confirm configuration generation rejects non-positive limits, periods other than `10` or `60`, and—when both switches are enabled—non-positive or duplicate namespace IDs.
6. Run type generation, type checking, and the full test suite again:

```bash
cd siliconbeest
pnpm cf-typegen
pnpm exec tsc --noEmit -p tsconfig.worker.json
pnpm type-check
pnpm test
```

Before committing generated configuration, return `WORKERS_AI_ENABLED` to the mode intended for that deployment. The repository default is `false`.
