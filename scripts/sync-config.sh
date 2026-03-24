#!/bin/bash
# ============================================================================
# SiliconBeest — Sync Cloudflare Resource IDs to wrangler.jsonc
# ============================================================================
#
# Fetches D1, KV, R2, and Queue resource IDs from your Cloudflare account
# and updates all wrangler.jsonc files with the correct values.
#
# Use this when:
#   - You cloned the repo on a new machine
#   - Your wrangler.jsonc files are out of date or have wrong IDs
#   - You need to verify resource bindings match actual Cloudflare state
#
# Usage:
#   ./scripts/sync-config.sh              # Dry run (show what would change)
#   ./scripts/sync-config.sh --apply      # Apply changes to wrangler.jsonc files
#
# Prerequisites:
#   - wrangler CLI installed and authenticated (npx wrangler whoami)
#   - Cloudflare account with existing resources
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh" 2>/dev/null || true
source "$SCRIPT_DIR/config.env" 2>/dev/null || true

APPLY=false
if [[ "${1:-}" == "--apply" ]]; then
  APPLY=true
fi

header "SiliconBeest Config Sync"

# Verify wrangler is authenticated
info "Checking wrangler authentication..."
if ! npx wrangler whoami 2>/dev/null | grep -q "Account ID"; then
  error "Not authenticated. Run: npx wrangler login"
  exit 1
fi
success "Authenticated"

# ============================================================================
# Fetch all resource IDs from Cloudflare
# ============================================================================

header "Fetching Cloudflare Resources"

# --- D1 Database ---
info "Looking up D1 database: ${D1_DATABASE_NAME}"
D1_ID=$(npx wrangler d1 list 2>/dev/null | grep -w "$D1_DATABASE_NAME" | awk '{print $1}' || true)
if [[ -z "$D1_ID" ]]; then
  # Try JSON format
  D1_ID=$(npx wrangler d1 list --json 2>/dev/null | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const db = d.find(x => x.name === '${D1_DATABASE_NAME}');
    if (db) console.log(db.uuid);
  " 2>/dev/null || true)
fi
if [[ -n "$D1_ID" ]]; then
  success "D1: $D1_DATABASE_NAME → $D1_ID"
else
  warn "D1 database '$D1_DATABASE_NAME' not found"
  D1_ID=""
fi

# --- KV Namespaces ---
info "Looking up KV namespaces..."
KV_JSON=$(npx wrangler kv namespace list 2>/dev/null || echo "[]")

KV_CACHE_ID=$(echo "$KV_JSON" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const ns = d.find(x => x.title === '${KV_CACHE_TITLE}' || x.title === '${WORKER_NAME}-${KV_CACHE_TITLE}' || x.title.includes('CACHE'));
  if (ns) console.log(ns.id);
" 2>/dev/null || true)

KV_SESSIONS_ID=$(echo "$KV_JSON" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const ns = d.find(x => x.title === '${KV_SESSIONS_TITLE}' || x.title === '${WORKER_NAME}-${KV_SESSIONS_TITLE}' || x.title.includes('SESSIONS'));
  if (ns) console.log(ns.id);
" 2>/dev/null || true)

[[ -n "$KV_CACHE_ID" ]] && success "KV CACHE: $KV_CACHE_ID" || warn "KV CACHE not found"
[[ -n "$KV_SESSIONS_ID" ]] && success "KV SESSIONS: $KV_SESSIONS_ID" || warn "KV SESSIONS not found"

# --- R2 Bucket ---
info "Looking up R2 bucket: ${R2_BUCKET_NAME}"
R2_EXISTS=$(npx wrangler r2 bucket list 2>/dev/null | grep -w "$R2_BUCKET_NAME" || true)
if [[ -n "$R2_EXISTS" ]]; then
  success "R2: $R2_BUCKET_NAME exists"
else
  warn "R2 bucket '$R2_BUCKET_NAME' not found"
fi

# --- Instance Domain (from current wrangler.jsonc if exists) ---
CURRENT_DOMAIN=""
if [[ -f "$WORKER_DIR/wrangler.jsonc" ]]; then
  CURRENT_DOMAIN=$(read_wrangler_json "$WORKER_DIR/wrangler.jsonc" "vars?.INSTANCE_DOMAIN" 2>/dev/null || true)
fi
if [[ -n "$CURRENT_DOMAIN" ]]; then
  info "Instance domain: $CURRENT_DOMAIN"
else
  warn "No INSTANCE_DOMAIN found in wrangler.jsonc"
  CURRENT_DOMAIN="${PROJECT_PREFIX}.example.com"
fi

# --- Instance Title ---
CURRENT_TITLE=""
if [[ -f "$WORKER_DIR/wrangler.jsonc" ]]; then
  CURRENT_TITLE=$(read_wrangler_json "$WORKER_DIR/wrangler.jsonc" "vars?.INSTANCE_TITLE" 2>/dev/null || true)
fi
CURRENT_TITLE="${CURRENT_TITLE:-SiliconBeest}"

# --- Registration Mode ---
CURRENT_REG=""
if [[ -f "$WORKER_DIR/wrangler.jsonc" ]]; then
  CURRENT_REG=$(read_wrangler_json "$WORKER_DIR/wrangler.jsonc" "vars?.REGISTRATION_MODE" 2>/dev/null || true)
fi
CURRENT_REG="${CURRENT_REG:-open}"

# ============================================================================
# Summary
# ============================================================================

header "Resource Summary"

echo "  D1 Database:    ${D1_DATABASE_NAME} → ${D1_ID:-NOT FOUND}"
echo "  R2 Bucket:      ${R2_BUCKET_NAME}"
echo "  KV CACHE:       ${KV_CACHE_ID:-NOT FOUND}"
echo "  KV SESSIONS:    ${KV_SESSIONS_ID:-NOT FOUND}"
echo "  Queue Fed:      ${QUEUE_FEDERATION}"
echo "  Queue Internal: ${QUEUE_INTERNAL}"
echo "  Queue DLQ:      ${QUEUE_DLQ}"
echo "  Domain:         ${CURRENT_DOMAIN}"
echo "  Title:          ${CURRENT_TITLE}"
echo "  Registration:   ${CURRENT_REG}"
echo ""

if ! $APPLY; then
  echo "════════════════════════════════════════════════════════"
  echo "  DRY RUN — No changes made"
  echo "  Run with --apply to update wrangler.jsonc files"
  echo "════════════════════════════════════════════════════════"

  # Show what would change
  echo ""
  info "Files that would be updated:"
  echo "  $WORKER_DIR/wrangler.jsonc"
  echo "  $CONSUMER_DIR/wrangler.jsonc"
  echo "  $VUE_DIR/wrangler.jsonc"
  exit 0
fi

# ============================================================================
# Apply — Generate wrangler.jsonc files
# ============================================================================

header "Updating wrangler.jsonc files"

# --- Worker wrangler.jsonc ---
info "Writing $WORKER_DIR/wrangler.jsonc"
cat > "$WORKER_DIR/wrangler.jsonc" << WRANGLER_EOF
{
	"\$schema": "node_modules/wrangler/config-schema.json",
	"name": "${WORKER_NAME}",
	"main": "src/index.ts",
	"compatibility_date": "2026-03-17",
	"compatibility_flags": ["nodejs_compat"],
	"observability": {
		"enabled": true
	},
	"placement": {
		"mode": "smart"
	},

	// Environment Variables (secrets set via \`wrangler secret put\`)
	"vars": {
		"INSTANCE_DOMAIN": "${CURRENT_DOMAIN}",
		"INSTANCE_TITLE": "${CURRENT_TITLE}",
		"REGISTRATION_MODE": "${CURRENT_REG}"
	},

	// D1 Database
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "${D1_DATABASE_NAME}",
			"database_id": "${D1_ID}"
		}
	],

	// R2 Object Storage (media uploads)
	"r2_buckets": [
		{
			"binding": "MEDIA_BUCKET",
			"bucket_name": "${R2_BUCKET_NAME}"
		}
	],

	// KV Namespaces
	"kv_namespaces": [
		{
			"binding": "CACHE",
			"id": "${KV_CACHE_ID}"
		},
		{
			"binding": "SESSIONS",
			"id": "${KV_SESSIONS_ID}"
		}
	],

	// Queues (producer bindings — worker enqueues jobs)
	"queues": {
		"producers": [
			{
				"binding": "QUEUE_FEDERATION",
				"queue": "${QUEUE_FEDERATION}"
			},
			{
				"binding": "QUEUE_INTERNAL",
				"queue": "${QUEUE_INTERNAL}"
			}
		]
	},

	// Durable Objects (WebSocket streaming)
	"durable_objects": {
		"bindings": [
			{
				"name": "STREAMING_DO",
				"class_name": "StreamingDO"
			}
		]
	},
	"migrations": [
		{
			"tag": "v1",
			"new_classes": ["StreamingDO"]
		}
	],

	// Workers Routes (API paths)
	"routes": [
		{ "pattern": "${CURRENT_DOMAIN}/api/*", "zone_name": "$(echo "$CURRENT_DOMAIN" | sed 's/^[^.]*\.//')" },
		{ "pattern": "${CURRENT_DOMAIN}/oauth/*", "zone_name": "$(echo "$CURRENT_DOMAIN" | sed 's/^[^.]*\.//')" },
		{ "pattern": "${CURRENT_DOMAIN}/.well-known/*", "zone_name": "$(echo "$CURRENT_DOMAIN" | sed 's/^[^.]*\.//')" },
		{ "pattern": "${CURRENT_DOMAIN}/users/*", "zone_name": "$(echo "$CURRENT_DOMAIN" | sed 's/^[^.]*\.//')" },
		{ "pattern": "${CURRENT_DOMAIN}/inbox", "zone_name": "$(echo "$CURRENT_DOMAIN" | sed 's/^[^.]*\.//')" },
		{ "pattern": "${CURRENT_DOMAIN}/nodeinfo/*", "zone_name": "$(echo "$CURRENT_DOMAIN" | sed 's/^[^.]*\.//')" },
		{ "pattern": "${CURRENT_DOMAIN}/media/*", "zone_name": "$(echo "$CURRENT_DOMAIN" | sed 's/^[^.]*\.//')" },
		{ "pattern": "${CURRENT_DOMAIN}/actor", "zone_name": "$(echo "$CURRENT_DOMAIN" | sed 's/^[^.]*\.//')" }
	]
}
WRANGLER_EOF
success "Worker config written"

# --- Queue Consumer wrangler.jsonc ---
info "Writing $CONSUMER_DIR/wrangler.jsonc"
cat > "$CONSUMER_DIR/wrangler.jsonc" << WRANGLER_EOF
{
	"\$schema": "node_modules/wrangler/config-schema.json",
	"name": "${CONSUMER_NAME}",
	"main": "src/index.ts",
	"compatibility_date": "2026-03-17",
	"compatibility_flags": ["nodejs_compat"],
	"observability": {
		"enabled": true
	},

	// D1 Database (same as worker)
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "${D1_DATABASE_NAME}",
			"database_id": "${D1_ID}"
		}
	],

	// R2 Object Storage (media processing)
	"r2_buckets": [
		{
			"binding": "MEDIA_BUCKET",
			"bucket_name": "${R2_BUCKET_NAME}"
		}
	],

	// KV Namespaces
	"kv_namespaces": [
		{
			"binding": "CACHE",
			"id": "${KV_CACHE_ID}"
		}
	],

	// Queue consumers
	"queues": {
		"producers": [
			{
				"binding": "QUEUE_FEDERATION",
				"queue": "${QUEUE_FEDERATION}"
			},
			{
				"binding": "QUEUE_INTERNAL",
				"queue": "${QUEUE_INTERNAL}"
			}
		],
		"consumers": [
			{
				"queue": "${QUEUE_FEDERATION}",
				"max_retries": 5,
				"dead_letter_queue": "${QUEUE_DLQ}"
			},
			{
				"queue": "${QUEUE_INTERNAL}",
				"max_retries": 3
			}
		]
	},

	// Service binding to main worker (for Durable Object + streaming)
	"services": [
		{
			"binding": "WORKER",
			"service": "${WORKER_NAME}"
		}
	]
}
WRANGLER_EOF
success "Queue consumer config written"

# --- Vue wrangler.jsonc ---
info "Writing $VUE_DIR/wrangler.jsonc"
cat > "$VUE_DIR/wrangler.jsonc" << WRANGLER_EOF
{
	"\$schema": "node_modules/wrangler/config-schema.json",
	"name": "${VUE_NAME}",
	"compatibility_date": "2026-03-17",
	"assets": {
		"directory": "dist/client",
		"binding": "ASSETS",
		"not_found_handling": "single-page-application"
	},
	"routes": [
		{
			"pattern": "${CURRENT_DOMAIN}",
			"custom_domain": true
		}
	]
}
WRANGLER_EOF
success "Vue frontend config written"

# ============================================================================
# Done
# ============================================================================

header "Sync Complete"

echo "  Updated files:"
echo "    ✅ $WORKER_DIR/wrangler.jsonc"
echo "    ✅ $CONSUMER_DIR/wrangler.jsonc"
echo "    ✅ $VUE_DIR/wrangler.jsonc"
echo ""
echo "  Next steps:"
echo "    1. Review the generated files"
echo "    2. Set secrets if needed:  npx wrangler secret put VAPID_PRIVATE_KEY"
echo "    3. Apply migrations:       ./scripts/migrate.sh --remote"
echo "    4. Deploy:                  ./scripts/deploy.sh"
