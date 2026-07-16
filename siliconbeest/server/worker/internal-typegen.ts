/**
 * Module-format facade used only by wrangler.rpc-typegen.jsonc.
 *
 * Production exports Internal from the Nitro entrypoint instead. Keeping this
 * facade source-based lets consuming Workers generate RPC types before the
 * production bundle exists.
 */
export { Internal, Internal as default } from './internal';
