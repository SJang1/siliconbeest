#!/usr/bin/env bash
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
# Architecture: unified worker deployed from siliconbeest-vue/
#
# Usage:
#   ./scripts/sync-config.sh              # Dry run (show what would change)
#   ./scripts/sync-config.sh --apply      # Apply changes to wrangler.jsonc files
#
# Prerequisites:
#   - wrangler CLI installed and authenticated (npx wrangler whoami)
#   - Cloudflare account with existing resources
# ============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# Source config — set defaults if config.sh not found
if [[ -f "$SCRIPT_DIR/config.sh" ]]; then
  source "$SCRIPT_DIR/config.sh"
else
  echo "[WARN] config.sh not found, using defaults"
  PROJECT_PREFIX="${PROJECT_PREFIX:-siliconbeest}"
  MAIN_WORKER_NAME="${MAIN_WORKER_NAME:-${PROJECT_PREFIX}}"
  CONSUMER_NAME="${CONSUMER_NAME:-${PROJECT_PREFIX}-queue-consumer}"
  EMAIL_SENDER_NAME="${EMAIL_SENDER_NAME:-${PROJECT_PREFIX}-email-sender}"
  D1_DATABASE_NAME="${D1_DATABASE_NAME:-${PROJECT_PREFIX}-db}"
  R2_BUCKET_NAME="${R2_BUCKET_NAME:-${PROJECT_PREFIX}-media}"
  KV_CACHE_TITLE="${KV_CACHE_TITLE:-${PROJECT_PREFIX}-CACHE}"
  KV_SESSIONS_TITLE="${KV_SESSIONS_TITLE:-${PROJECT_PREFIX}-SESSIONS}"
  KV_FEDIFY_TITLE="${KV_FEDIFY_TITLE:-${PROJECT_PREFIX}-FEDIFY_KV}"
  QUEUE_FEDERATION="${QUEUE_FEDERATION:-${PROJECT_PREFIX}-federation}"
  QUEUE_INTERNAL="${QUEUE_INTERNAL:-${PROJECT_PREFIX}-internal}"
  QUEUE_EMAIL="${QUEUE_EMAIL:-${PROJECT_PREFIX}-email}"
  QUEUE_DLQ="${QUEUE_DLQ:-${PROJECT_PREFIX}-federation-dlq}"
  PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
  MAIN_DIR="$PROJECT_ROOT/siliconbeest-vue"
  CONSUMER_DIR="$PROJECT_ROOT/siliconbeest-queue-consumer"
  EMAIL_DIR="$PROJECT_ROOT/siliconbeest-email-sender"
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
  info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
  success() { echo -e "${GREEN}[OK]${NC}    $*"; }
  warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
  error()   { echo -e "${RED}[ERROR]${NC} $*"; }
  header()  { echo -e "\n${BOLD}${CYAN}=== $* ===${NC}\n"; }
fi

[[ -f "$SCRIPT_DIR/config.env" ]] && source "$SCRIPT_DIR/config.env"

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
D1_ID=$(npx wrangler d1 list --json 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const db = d.find(x => x.name === '${D1_DATABASE_NAME}');
  if (db) console.log(db.uuid);
" 2>/dev/null || true)
# Fallback: parse table output
if [[ -z "$D1_ID" || "$D1_ID" == *"│"* ]]; then
  D1_ID=$(npx wrangler d1 list 2>/dev/null | grep "$D1_DATABASE_NAME" | sed 's/[│ ]//g' | grep -oE '[0-9a-f-]{36}' | head -1 || true)
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
  const ns = d.find(x => x.title === '${KV_CACHE_TITLE}' || x.title === '${MAIN_WORKER_NAME}-${KV_CACHE_TITLE}' || x.title.includes('CACHE'));
  if (ns) console.log(ns.id);
" 2>/dev/null || true)

KV_SESSIONS_ID=$(echo "$KV_JSON" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const ns = d.find(x => x.title === '${KV_SESSIONS_TITLE}' || x.title === '${MAIN_WORKER_NAME}-${KV_SESSIONS_TITLE}' || x.title.includes('SESSIONS'));
  if (ns) console.log(ns.id);
" 2>/dev/null || true)

[[ -n "$KV_CACHE_ID" ]] && success "KV CACHE: $KV_CACHE_ID" || warn "KV CACHE not found"
[[ -n "$KV_SESSIONS_ID" ]] && success "KV SESSIONS: $KV_SESSIONS_ID" || warn "KV SESSIONS not found"

KV_FEDIFY_ID=$(echo "$KV_JSON" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const ns = d.find(x => x.title === '${KV_FEDIFY_TITLE}' || x.title === '${MAIN_WORKER_NAME}-${KV_FEDIFY_TITLE}' || x.title.includes('FEDIFY'));
  if (ns) console.log(ns.id);
" 2>/dev/null || true)

[[ -n "$KV_FEDIFY_ID" ]] && success "KV FEDIFY: $KV_FEDIFY_ID" || warn "KV FEDIFY not found"

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
if [[ -f "$MAIN_DIR/wrangler.jsonc" ]]; then
  CURRENT_DOMAIN=$(sed 's|//.*$||' "$MAIN_DIR/wrangler.jsonc" | node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      if (d.vars?.INSTANCE_DOMAIN) console.log(d.vars.INSTANCE_DOMAIN);
    } catch(e) {}
  " 2>/dev/null || true)
fi
if [[ -n "$CURRENT_DOMAIN" ]]; then
  info "Instance domain: $CURRENT_DOMAIN"
else
  warn "No INSTANCE_DOMAIN found in wrangler.jsonc"
  CURRENT_DOMAIN="${PROJECT_PREFIX}.example.com"
fi

# --- Instance Title ---
CURRENT_TITLE=""
if [[ -f "$MAIN_DIR/wrangler.jsonc" ]]; then
  CURRENT_TITLE=$(sed 's|//.*$||' "$MAIN_DIR/wrangler.jsonc" | node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      if (d.vars?.INSTANCE_TITLE) console.log(d.vars.INSTANCE_TITLE);
    } catch(e) {}
  " 2>/dev/null || true)
fi
CURRENT_TITLE="${CURRENT_TITLE:-SiliconBeest}"

# --- Registration Mode ---
CURRENT_REG=""
if [[ -f "$MAIN_DIR/wrangler.jsonc" ]]; then
  CURRENT_REG=$(sed 's|//.*$||' "$MAIN_DIR/wrangler.jsonc" | node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      if (d.vars?.REGISTRATION_MODE) console.log(d.vars.REGISTRATION_MODE);
    } catch(e) {}
  " 2>/dev/null || true)
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
echo "  KV FEDIFY:      ${KV_FEDIFY_ID:-NOT FOUND}"
echo "  Queue Fed:      ${QUEUE_FEDERATION}"
echo "  Queue Internal: ${QUEUE_INTERNAL}"
echo "  Queue Email:    ${QUEUE_EMAIL}"
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
  echo "  $MAIN_DIR/wrangler.jsonc"
  echo "  $CONSUMER_DIR/wrangler.jsonc"
  echo "  $EMAIL_DIR/wrangler.jsonc"
  exit 0
fi

# ============================================================================
# Apply — Generate wrangler.jsonc files
# ============================================================================

header "Updating wrangler.jsonc files"

# --- Unified worker wrangler.jsonc (siliconbeest-vue/) ---
info "Writing $MAIN_DIR/wrangler.jsonc"
cat > "$MAIN_DIR/wrangler.jsonc" << WRANGLER_EOF
{
	"\$schema": "node_modules/wrangler/config-schema.json",
	"name": "${MAIN_WORKER_NAME}",
	"main": "server/index.ts",
	"compatibility_date": "2026-03-17",
	"compatibility_flags": ["nodejs_compat"],
	"assets": {
		"directory": "./dist/client",
		"not_found_handling": "single-page-application"
	},
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
		},
		{
			"binding": "FEDIFY_KV",
			"id": "${KV_FEDIFY_ID}"
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
			},
			{
				"binding": "QUEUE_EMAIL",
				"queue": "${QUEUE_EMAIL}"
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

	// Workers Routes (custom domain)
	"routes": [
		{
			"custom_domain": true,
			"pattern": "${CURRENT_DOMAIN}"
		}
	]
}
WRANGLER_EOF
success "Unified worker config written"

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
	"workers_dev": false,
	"placement": {
		"mode": "smart"
	},
	"vars": {
		"INSTANCE_DOMAIN": "${CURRENT_DOMAIN}"
	},

	// D1 Database (same as main worker)
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
		},
		{
			"binding": "FEDIFY_KV",
			"id": "${KV_FEDIFY_ID}"
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
			"service": "${MAIN_WORKER_NAME}"
		}
	]
}
WRANGLER_EOF
success "Queue consumer config written"

# --- Email Sender wrangler.jsonc ---
info "Writing $EMAIL_DIR/wrangler.jsonc"
cat > "$EMAIL_DIR/wrangler.jsonc" << WRANGLER_EOF
{
	"\$schema": "node_modules/wrangler/config-schema.json",
	"name": "${EMAIL_SENDER_NAME}",
	"main": "src/index.ts",
	"compatibility_date": "2026-03-17",
	"compatibility_flags": ["nodejs_compat"],
	"observability": {
		"enabled": true
	},

	// Consumes from dedicated email queue
	"queues": {
		"consumers": [
			{
				"queue": "${QUEUE_EMAIL}",
				"max_retries": 3
			}
		]
	},

	// D1 for reading SMTP settings from settings table
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "${D1_DATABASE_NAME}",
			"database_id": "${D1_ID}"
		}
	]
}
WRANGLER_EOF
success "Email sender config written"

# ============================================================================
# Done
# ============================================================================

header "Sync Complete"

echo "  Updated files:"
echo "    $MAIN_DIR/wrangler.jsonc"
echo "    $CONSUMER_DIR/wrangler.jsonc"
echo "    $EMAIL_DIR/wrangler.jsonc"
echo ""
echo "  Next steps:"
echo "    1. Review the generated files"
echo "    2. Set secrets if needed:  wrangler secret put OTP_ENCRYPTION_KEY --name $MAIN_WORKER_NAME"
echo "    3. Apply migrations:       ./scripts/migrate.sh --remote"
echo "    4. Deploy:                  ./scripts/deploy.sh"
