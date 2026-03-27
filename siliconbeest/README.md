# SiliconBeest Vue Frontend

The web frontend for SiliconBeest. A single-page application built with Vue 3, deployed to Cloudflare Workers via the Cloudflare Vite plugin.

---

## Tech Stack

| Technology                  | Purpose                            |
| --------------------------- | ---------------------------------- |
| Vue 3                       | Reactive UI framework              |
| Vue Router 5                | Client-side routing with auth guards |
| Vite 7                      | Build tool and dev server          |
| TypeScript                  | Type safety                        |
| Tailwind CSS 4              | Utility-first styling              |
| @tailwindcss/typography     | Prose content styling              |
| Pinia 3                     | State management                   |
| vue-i18n 11                 | Internationalization               |
| @headlessui/vue             | Accessible UI components           |
| @vueuse/core                | Vue composition utilities          |
| @sentry/vue                 | Error tracking (optional)          |
| @cloudflare/vite-plugin     | Cloudflare Workers deployment      |
| Vitest + @vue/test-utils    | Unit and component testing         |

---

## Features

- **Responsive design** -- mobile-first layout with Tailwind CSS
- **Dark mode** -- system-aware and manual toggle
- **Internationalization** -- 12 locales with lazy loading (en, ko, ja, zh-CN, zh-TW, es, fr, de, pt-BR, ru, ar, id)
- **RTL support** -- Arabic locale includes RTL layout
- **OAuth 2.0** -- full login flow including third-party app authorization
- **Two-factor authentication** -- TOTP setup and verification
- **Password reset** -- forgot password and reset flows
- **Sentry integration** -- optional error tracking (enabled via `VITE_SENTRY_DSN`)
- **Infinite scroll** -- paginated timeline loading
- **WebSocket streaming** -- real-time timeline and notification updates
- **Web Push** -- notification subscription management
- **Admin dashboard** -- full administration interface

---

## Views (38 files)

### Public

| View | Route | Description |
|------|-------|-------------|
| `LandingView` | `/` | Landing page (redirects to `/home` if authenticated) |
| `ExploreView` | `/explore` | Public/federated timeline |
| `AboutView` | `/about`, `/about/more` | Instance information |
| `SearchView` | `/search` | Search accounts, statuses, hashtags |
| `TagTimelineView` | `/tags/:tag` | Hashtag timeline |
| `ProfileView` | `/@:acct` | User profile |
| `FollowListView` | `/@:acct/followers`, `/@:acct/following` | Followers/following lists |
| `StatusDetailView` | `/@:acct/:statusId` | Status detail with thread context |
| `NotFoundView` | `*` | 404 page |

### Authentication

| View | Route | Description |
|------|-------|-------------|
| `LoginView` | `/login` | Login form |
| `RegisterView` | `/register` | Registration form |
| `OAuthAuthorizeView` | `/oauth/authorize` | OAuth app authorization |
| `ForgotPasswordView` | `/auth/forgot-password` | Password reset request |
| `ResetPasswordView` | `/auth/reset-password` | Password reset form |

### Authenticated

| View | Route | Description |
|------|-------|-------------|
| `HomeView` | `/home` | Home timeline |
| `NotificationsView` | `/notifications` | Notifications |
| `ConversationsView` | `/conversations` | Direct message conversations |
| `BookmarksView` | `/bookmarks` | Bookmarked statuses |
| `FavouritesView` | `/favourites` | Favourited statuses |
| `ListsView` | `/lists` | User lists |
| `ListTimelineView` | `/lists/:id` | List timeline |
| `FollowRequestsView` | `/follow-requests` | Pending follow requests |

### Settings

| View | Route | Description |
|------|-------|-------------|
| `SettingsView` | `/settings` | Settings layout (parent) |
| `SettingsProfileView` | `/settings/profile` | Edit profile |
| `SettingsAccountView` | `/settings/account` | Account settings (password, 2FA) |
| `SettingsAppearanceView` | `/settings/appearance` | Theme and display |
| `SettingsNotificationsView` | `/settings/notifications` | Notification preferences |
| `SettingsFiltersView` | `/settings/filters` | Content filters |

### Admin

| View | Route | Description |
|------|-------|-------------|
| `AdminDashboardView` | `/admin` | Admin dashboard |
| `AdminAccountsView` | `/admin/accounts` | Account management |
| `AdminReportsView` | `/admin/reports` | Report management |
| `AdminDomainBlocksView` | `/admin/domain-blocks` | Domain blocks |
| `AdminSettingsView` | `/admin/settings` | Instance settings |
| `AdminAnnouncementsView` | `/admin/announcements` | Announcements |
| `AdminRulesView` | `/admin/rules` | Server rules |
| `AdminRelaysView` | `/admin/relays` | Relay management |
| `AdminCustomEmojisView` | `/admin/custom-emojis` | Custom emoji management |
| `AdminFederationView` | `/admin/federation` | Federation status |

---

## Components

### Layout

| Component | Description |
|-----------|-------------|
| `AppShell` | Main application shell (sidebar + content) |
| `Sidebar` | Navigation sidebar |
| `MobileNav` | Mobile bottom navigation |
| `AdminLayout` | Admin section layout wrapper |

### Status

| Component | Description |
|-----------|-------------|
| `StatusCard` | Status display card |
| `StatusContent` | Rendered status content (HTML, CW) |
| `StatusActions` | Interaction buttons (reply, boost, favourite, bookmark, reactions) |
| `StatusComposer` | Status composition form |
| `MediaGallery` | Media attachment grid |
| `PreviewCard` | URL preview card (OpenGraph) |

### Account

| Component | Description |
|-----------|-------------|
| `AccountCard` | Account display card |
| `AccountHeader` | Profile header with stats |
| `FollowButton` | Follow/unfollow button |

### Auth

| Component | Description |
|-----------|-------------|
| `LoginForm` | Login form with 2FA support |
| `RegisterForm` | Registration form |
| `TwoFactorForm` | TOTP verification form |

### Notification

| Component | Description |
|-----------|-------------|
| `NotificationItem` | Individual notification display |

### Common

| Component | Description |
|-----------|-------------|
| `Avatar` | User avatar with fallback |
| `LoadingSpinner` | Loading indicator |
| `Modal` | Dialog/modal component |
| `Toast` | Toast notification |
| `InfiniteScroll` | Infinite scroll pagination |
| `ReportDialog` | Report submission dialog |

### Settings

| Component | Description |
|-----------|-------------|
| `LanguageSelector` | Language picker dropdown |

### Timeline

| Component | Description |
|-----------|-------------|
| `TimelineFeed` | Timeline rendering with infinite scroll |

---

## Stores (Pinia)

| Store | File | Description |
|-------|------|-------------|
| `auth` | `stores/auth.ts` | Authentication state, token management, login/logout |
| `accounts` | `stores/accounts.ts` | Account data cache, follow/block/mute actions |
| `statuses` | `stores/statuses.ts` | Status data cache, favourite/reblog/bookmark actions |
| `timelines` | `stores/timelines.ts` | Timeline pagination and caching |
| `notifications` | `stores/notifications.ts` | Notification list and management |
| `compose` | `stores/compose.ts` | Status composition state |
| `instance` | `stores/instance.ts` | Instance information and configuration |
| `ui` | `stores/ui.ts` | UI state (theme, sidebar, modals) |

---

## API Modules

| Module | File | Description |
|--------|------|-------------|
| `client` | `api/client.ts` | HTTP client with auth headers and error handling |
| `streaming` | `api/streaming.ts` | WebSocket streaming client |
| `accounts` | `api/mastodon/accounts.ts` | Account API calls |
| `statuses` | `api/mastodon/statuses.ts` | Status API calls |
| `timelines` | `api/mastodon/timelines.ts` | Timeline API calls |
| `notifications` | `api/mastodon/notifications.ts` | Notification API calls |
| `instance` | `api/mastodon/instance.ts` | Instance API calls |
| `search` | `api/mastodon/search.ts` | Search API calls |
| `media` | `api/mastodon/media.ts` | Media upload API calls |
| `bookmarks` | `api/mastodon/bookmarks.ts` | Bookmark API calls |
| `favourites` | `api/mastodon/favourites.ts` | Favourite API calls |
| `oauth` | `api/mastodon/oauth.ts` | OAuth API calls |
| `admin` | `api/mastodon/admin.ts` | Admin API calls |
| `reports` | `api/mastodon/reports.ts` | Report API calls |

---

## Internationalization

Bundled locales: **en** (English) and **ko** (Korean) are included in the main bundle.

Lazy-loaded locales (12 total): ja, zh-CN, zh-TW, es, fr, de, pt-BR, ru, ar (RTL), id.

Language detection uses `navigator.language` with fallback to English.

---

## Route Guards

- `requireAuth` -- redirects to `/login` if not authenticated
- `requireAdmin` -- redirects to `/home` if not an admin
- `redirectIfAuthenticated` -- redirects to `/home` if already logged in (for login/register pages)

---

## Local Development

### Prerequisites

- Node.js >= 20.19.0 or >= 22.12.0

### Setup

```bash
npm install
```

### Development Server

```bash
npm run dev
```

This starts the Vite dev server with hot module replacement at `http://localhost:5173`.

### Type Checking

```bash
npm run type-check
```

---

## Build and Deploy

### Production Build

```bash
npm run build
```

Runs type checking and Vite production build in parallel.

### Preview (local Workers preview)

```bash
npm run preview
```

### Deploy to Cloudflare

```bash
npm run deploy
```

### Generate Cloudflare Types

```bash
npm run cf-typegen
```

---

## Testing

The project uses [Vitest](https://vitest.dev/) with [happy-dom](https://github.com/nicedoc/happy-dom) and [@vue/test-utils](https://test-utils.vuejs.org/) for unit and component testing.

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch
```

### Test Files (11 files)

| Test File | Coverage |
|-----------|----------|
| `test/stores/auth.test.ts` | Auth store (login, logout, token management) |
| `test/stores/ui.test.ts` | UI store (theme, sidebar state) |
| `test/stores/statuses.test.ts` | Status store (favourite, reblog, bookmark actions) |
| `test/stores/timelines.test.ts` | Timeline store (pagination, caching) |
| `test/components/Avatar.test.ts` | Avatar component rendering |
| `test/components/LoadingSpinner.test.ts` | Loading spinner component |
| `test/components/StatusActions.test.ts` | Status action buttons |
| `test/components/FollowButton.test.ts` | Follow button states |
| `test/api/client.test.ts` | API client (headers, error handling) |
| `test/i18n/i18n.test.ts` | i18n setup and locale loading |
| `test/router/guards.test.ts` | Route guard behavior |
