# SiliconBeest Vue Frontend

The web frontend for SiliconBeest. A single-page application built with Vue 3 and deployed to Cloudflare Workers (via the Cloudflare Vite plugin).

> Version **0.1.0**

---

## What It Does

- Provides a web interface for interacting with the SiliconBeest Mastodon-compatible API.
- Renders timelines, profiles, notifications, and conversations.
- Handles OAuth 2.0 login flows.
- Supports server-side rendering and edge deployment via the Cloudflare Vite plugin.

---

## Tech Stack

| Technology                  | Purpose                            |
| --------------------------- | ---------------------------------- |
| Vue 3                       | Reactive UI framework              |
| Vue Router 5                | Client-side routing                |
| Vite 7                      | Build tool and dev server          |
| TypeScript                  | Type safety                        |
| @cloudflare/vite-plugin     | Cloudflare Workers deployment      |
| vite-plugin-vue-devtools    | Development tooling                |

---

## Project Structure

```
src/
  App.vue                # Root application component
  main.ts                # App entry point, plugin registration
  assets/                # Static assets (CSS, images)
  components/
    icons/               # SVG icon components
    HelloWorld.vue       # Example component
    TheWelcome.vue       # Welcome page component
    WelcomeItem.vue      # Welcome item component
  views/
    HomeView.vue         # Home page view
    AboutView.vue        # About page view
  router/
    index.ts             # Vue Router configuration
```

---

## Pages and Routes

| Route   | View             | Description     |
| ------- | ---------------- | --------------- |
| `/`     | `HomeView.vue`   | Home page       |
| `/about`| `AboutView.vue`  | About page      |

Additional routes will be added as the frontend is built out to support timelines, profiles, notifications, settings, and the admin panel.

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

This starts the Vite dev server with hot module replacement. The app will be available at `http://localhost:5173` by default.

### Type Checking

```bash
npm run type-check
```

Runs `vue-tsc` to verify TypeScript types across all `.vue` and `.ts` files.

---

## Build and Deploy

### Production Build

```bash
npm run build
```

This runs type checking and Vite production build in parallel.

### Preview (local Workers preview)

```bash
npm run preview
```

Builds the project and starts a local Wrangler dev server to preview the Workers deployment.

### Deploy to Cloudflare

```bash
npm run deploy
```

Builds the project and deploys to Cloudflare Workers using Wrangler.

### Generate Cloudflare Types

```bash
npm run cf-typegen
```

Regenerates TypeScript types for Cloudflare bindings after changing `wrangler.jsonc`.

---

## Adding New Pages

1. Create a new view component in `src/views/`:

```vue
<script setup lang="ts">
// component logic
</script>

<template>
  <div>
    <h1>My New Page</h1>
  </div>
</template>
```

2. Add a route in `src/router/index.ts`:

```typescript
{
  path: '/my-page',
  name: 'my-page',
  component: () => import('../views/MyPageView.vue'),
}
```

---

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) with the [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) extension (disable Vetur if installed).
