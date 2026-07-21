import '#nitro-internal-pollyfills';
import * as Sentry from '@sentry/cloudflare';
import wsAdapter from 'crossws/adapters/cloudflare';
import { useNitroApp } from 'nitropack/runtime';
import { requestHasBody, runCronTasks } from 'nitropack/runtime/internal';
import { isPublicAssetURL } from '#nitro-internal-virtual/public-assets';
import app from './worker/index';

export { Internal } from './worker/internal';

const nitroApp = useNitroApp();
const ws = import.meta._websocket ? wsAdapter(nitroApp.h3App.websocket) : undefined;

function setCloudflareEnv(env: Env): void {
  (globalThis as typeof globalThis & { __env__?: Env }).__env__ = env;
}

async function fetchHandler(
  request: Request,
  env: Env,
  context: ExecutionContext,
  url = new URL(request.url),
  ctxExt?: Record<string, unknown>,
): Promise<Response> {
  let body: BodyInit | undefined;
  if (requestHasBody(request)) {
    body = await request.arrayBuffer();
  }

  setCloudflareEnv(env);
  return nitroApp.localFetch(url.pathname + url.search, {
    context: {
      waitUntil: (promise: Promise<unknown>) => context.waitUntil(promise),
      _platform: {
        cf: request.cf,
        cloudflare: {
          request,
          env,
          context,
          url,
          ...ctxExt,
        },
      },
    },
    host: url.hostname,
    protocol: url.protocol,
    method: request.method,
    headers: request.headers,
    body,
  });
}

const handler = {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const ctxExt = {};
    const url = new URL(request.url);

    if (url.pathname === '/api/v1/streaming') {
      return app.fetch(request, env, context);
    }

    if (env.ASSETS && isPublicAssetURL(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    if (import.meta._websocket && request.headers.get('upgrade') === 'websocket') {
      return ws!.handleUpgrade(request, env, context);
    }

    return fetchHandler(request, env, context, url, ctxExt);
  },

  scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): void {
    setCloudflareEnv(env);
    context.waitUntil(
      nitroApp.hooks.callHook('cloudflare:scheduled', {
        controller,
        env,
        context,
      }),
    );
    if (import.meta._tasks) {
      context.waitUntil(
        runCronTasks(controller.cron, {
          context: {
            cloudflare: {
              env,
              context,
            },
          },
          payload: {},
        }),
      );
    }
  },

  email(message: ForwardableEmailMessage, env: Env, context: ExecutionContext): void {
    setCloudflareEnv(env);
    context.waitUntil(
      nitroApp.hooks.callHook('cloudflare:email', {
        message,
        event: message,
        env,
        context,
      }),
    );
  },

  queue(batch: MessageBatch, env: Env, context: ExecutionContext): void {
    setCloudflareEnv(env);
    context.waitUntil(
      nitroApp.hooks.callHook('cloudflare:queue', {
        batch,
        event: batch,
        env,
        context,
      }),
    );
  },

  tail(traces: TraceItem[], env: Env, context: ExecutionContext): void {
    setCloudflareEnv(env);
    context.waitUntil(
      nitroApp.hooks.callHook('cloudflare:tail', {
        traces,
        env,
        context,
      }),
    );
  },

  trace(traces: TraceItem[], env: Env, context: ExecutionContext): void {
    setCloudflareEnv(env);
    context.waitUntil(
      nitroApp.hooks.callHook('cloudflare:trace', {
        traces,
        env,
        context,
      }),
    );
  },
} satisfies ExportedHandler<Env>;

export default Sentry.withSentry(
  (env: Env) => ({
    // SENTRY_DSN is an optional Cloudflare secret; Sentry is disabled when it is unset.
    dsn: env.SENTRY_DSN || undefined,
    tracesSampleRate: 1.0,
    enableLogs: true,
  }),
  handler,
);
