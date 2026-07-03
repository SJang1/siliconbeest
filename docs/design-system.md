# Siliconbeest "Aurora" Design System

The new default UI (everything outside `/old/*`). The previous UI is preserved
verbatim in `src/legacy/` + `pages/old/` — never modify those trees.

## Design language

**Aurora**: a luminous, modern fediverse client. Calm neutral surfaces (slate,
not gray), one expressive accent — an indigo→violet→fuchsia gradient — used
sparingly for primary actions, active states, and identity moments. Generous
radii (`rounded-2xl` cards, pill buttons), soft layered elevation instead of
hard borders, translucent blurred sticky bars, and subtle motion (hover lift,
fade/rise-in). Landing and auth pages get the animated `sb-aurora` backdrop;
in-app screens stay quiet and content-first. Typography: Inter Variable for UI
(`--font-ui`, inherited via `.sb-app`), Space Grotesk Variable for headings and
brand moments (`.sb-heading`).

Timeline density stays readable — this is a social app, not a marketing site.
Posts are comfortable but not airy; admin/settings screens can breathe more.

## Tokens (defined in `src/assets/main.css` `@theme`)

- Colors: `brand-50…950` (indigo anchor #6366f1), `canvas`/`canvas-dark`,
  `surface`/`surface-dark`, `surface-2`/`surface-2-dark`, `outline`/`outline-dark`.
  Usable as any color utility: `bg-surface`, `border-outline-dark`, `text-brand-600`…
- Shadows: `shadow-soft` (resting), `shadow-lift` (hover/dropdown), `shadow-glow` (primary CTA hover).
- Motion: `animate-fade-in`, `animate-rise-in`, `animate-aurora`.
- Fonts: `.sb-app` sets Inter; `.sb-heading` sets Space Grotesk.

## Recipes (use these before hand-rolling utilities)

| Class | Use |
| --- | --- |
| `sb-app` | Root wrapper of every page/shell. Sets canvas bg, text color, font. |
| `sb-heading` | Page titles, section titles, brand wordmark. |
| `sb-gradient-text` | Hero/brand accent text. Use sparingly. |
| `sb-card` (+ `sb-card-hover`) | Content cards, posts, panels. |
| `sb-glass` | Sticky translucent headers/toolbars (pair with `sticky top-0 z-10 border-b`). |
| `sb-btn` + `sb-btn-primary/secondary/ghost/danger` (+ `sb-btn-sm`) | All buttons. |
| `sb-input`, `sb-label` | Form fields and their labels. |
| `sb-chip` | Tags, counters, small badges. |
| `sb-nav-item` (+ `sb-nav-item-active`) | Sidebar/mobile nav entries. |
| `sb-menu`, `sb-menu-item` | Dropdown panels and their items. |
| `sb-divider`, `sb-empty` | Separators, empty states. |
| `sb-avatar-ring` | Gradient ring around avatars (profile header, active identity). |
| `sb-aurora` | Animated backdrop inside a `relative overflow-hidden` hero/auth container. |

Extend with plain Tailwind utilities; use the token colors (`surface`,
`outline`, `brand`, slate for text) rather than `gray-*` so both themes stay
coherent. Every visual choice needs a `dark:` treatment (recipes already
include theirs).

## Composition patterns

- **Page scaffold**: `.sb-app min-h-dvh` root → optional `sb-glass` sticky
  header with the page title (`sb-heading text-lg`) → content column
  (`mx-auto w-full max-w-2xl px-4` for feeds; wider `max-w-4xl` for
  settings/admin tables).
- **Feeds/posts**: cards separated by `space-y-3`, or a single `sb-card`
  with `divide-y divide-outline dark:divide-outline-dark`. Action buttons are
  `sb-btn-ghost sb-btn-sm` with icons.
- **Forms**: `sb-label` + `sb-input`, submit is `sb-btn sb-btn-primary`,
  cancel/secondary is `sb-btn sb-btn-secondary`. Group in `sb-card p-6 space-y-4`.
- **Auth/landing**: full-viewport `relative overflow-hidden` container with
  `sb-aurora` backdrop, centered `sb-card` (auth) or hero + feature grid
  (landing) above it (`relative z-10`).
- **Modals/dropdowns**: panel uses `sb-card`/`sb-menu` styling; keep existing
  transition names (`fade`, `slide-up`) — they still work.
- **Focus/a11y**: recipes ship `focus-visible` rings; never remove focus
  styles, `aria-*`, `role`, or `alt` attributes.

## Tailwind v4 notes

- Gradients: `bg-linear-to-r` (v4 name; `bg-gradient-to-r` still compiles).
- Class-based dark mode via `.dark` on `<html>` — already wired.
- Arbitrary values (`bg-white/75`, `max-w-[calc(100vw-2rem)]`) are fine.

## Hard rules for restyling existing components

1. Templates and styles only. Do not change `<script>` logic, props, emits,
   slots, store/composable usage, or file names. Tiny additions (an icon path
   constant, a class-computing computed) are allowed only for presentation.
2. Keep every interactive element and its bindings (`@click`, `v-model`,
   `:disabled`, …). Keep conditional rendering (`v-if`/`v-for`) semantics.
3. All user-facing text stays behind vue-i18n (`$t`/`t()`); no new hardcoded strings.
4. Preserve `aria-*`, `role`, `alt`, `aria-pressed`, keyboard handlers.
5. Don't touch `src/legacy/**`, `pages/old/**`, `server/**`, stores, api.
6. Unit tests assert behavior (button order, `aria-pressed`, text) — keep those
   passing. A test that asserts a purely cosmetic class may be updated to the
   new class instead.
7. `.status-content` (federated HTML) styling is shared with the classic
   design — extend around it, don't restyle that class itself.

---

# Siliconbeest "Deck" Design System

The next default UI, built as a separate tree in `src/deck/` (spec:
`docs/superpowers/specs/2026-07-03-deck-mode-design.md`). Aurora is being
preserved under `/aurora/*`; classic stays at `/old/*`. Never mix `sb-*`
and `dk-*` recipes in the same component.

## Design language

Dark-first, terminal-flavored fediverse deck: TweetDeck-style columns, an
admin-selectable accent (default `#c6f24e` lime), a fixed violet second
accent, Bricolage Grotesque for UI text and JetBrains Mono for metadata
(handles, timestamps, chips, labels). Chips and buttons are pills; cards are
rounded-16 with hairline borders; the page backdrop is two radial accent
glows over a deep slate-violet canvas.

## Tokens (defined in `src/assets/deck.css`, scoped under `.dk-app`)

CSS custom properties, not Tailwind theme colors — the accent changes at
runtime:

- Surfaces: `--dk-bg`, `--dk-surface`, `--dk-surface2`, `--dk-border`
- Text: `--dk-text`, `--dk-dim`
- Accent: `--dk-acc` (derived per-theme from `--dk-acc-raw`, which
  `src/utils/accent.ts` sets from the instance `accent_color` setting),
  `--dk-acc-ink` (text on accent), `--dk-acc2` (fixed violet)
- Density: `--dk-pad`, `--dk-gap`, `--dk-fs` (compact via
  `data-density="compact"` on `.dk-app`)
- Fonts: `--dk-font` (Bricolage Grotesque), `--dk-mono` (JetBrains Mono)

Light/dark is keyed off the existing `.dark` class on `<html>`; both sets
live in deck.css. Use the vars via recipes below or
`style="…: var(--dk-…)"` — never hardcode Deck palette hexes in templates.

## Recipes

| Class | Use |
| --- | --- |
| `dk-app` | Root of every Deck screen (DeckShell applies it). Canvas, fonts, glow backdrop. |
| `dk-card` | Columns headers, notes, panels. Pair with `style="padding: var(--dk-pad)"`. |
| `dk-chip` | Mono meta pills (scope, instance chip). |
| `dk-pill-btn` | Surface pill buttons (theme toggle, streaming, secondary). |
| `dk-btn-accent` | Primary accent action (＋ Note). |
| `dk-rail-item` (+ `-active`), `dk-rail-label`, `dk-rail-badge` | Left icon rail entries. |
| `dk-menu`, `dk-menu-item` | Popover menus. |
| `dk-input`, `dk-label` | Form fields. |
| `dk-mono`, `dk-text`, `dk-dim-text` | Type utilities. |
| `dk-hairline-b/t/r` | 1px `--dk-border` separators. |
| `dk-dot`, `dk-live` | Pulsing live indicator. |
| `dk-note-in` | Card entrance animation. |

Aurora's hard rules (i18n, aria/focus preservation, `.status-content`
untouched, no logic changes when restyling) apply to Deck verbatim.
