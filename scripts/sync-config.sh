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
# Architecture: unified worker deployed from siliconbeest/
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
  MAIN_DIR="$PROJECT_ROOT/siliconbeest"
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

# Check if all IDs are pre-configured (skip auth check if so)
_PRE_D1="${D1_DATABASE_ID:-}"
_PRE_KVC="${KV_CACHE_ID:-}"
_PRE_KVS="${KV_SESSIONS_ID:-}"
_PRE_KVF="${KV_FEDIFY_ID:-}"

if [[ -n "$_PRE_D1" && -n "$_PRE_KVC" && -n "$_PRE_KVS" && -n "$_PRE_KVF" ]]; then
  info "All resource IDs provided in config.env — skipping wrangler auth check"
else
  # Verify wrangler is authenticated (needed to fetch missing IDs)
  info "Checking wrangler authentication..."
  if ! npx wrangler whoami 2>/dev/null | grep -q "Account ID"; then
    error "Not authenticated. Run: npx wrangler login"
    exit 1
  fi
  success "Authenticated"
fi

# ============================================================================
# Resolve resource IDs — prefer config.env values, fallback to Cloudflare API
# ============================================================================

# Check if all IDs are already provided (e.g. from config.env or GitHub Variables)
HAS_ALL_IDS=true
[[ -z "${D1_DATABASE_ID:-}" ]] && HAS_ALL_IDS=false
[[ -z "${KV_CACHE_ID:-}" ]] && HAS_ALL_IDS=false
[[ -z "${KV_SESSIONS_ID:-}" ]] && HAS_ALL_IDS=false
[[ -z "${KV_FEDIFY_ID:-}" ]] && HAS_ALL_IDS=false

if $HAS_ALL_IDS; then
  header "Using Resource IDs from config.env"
  D1_ID="$D1_DATABASE_ID"
  success "D1: $D1_DATABASE_NAME → $D1_ID"
  success "KV CACHE: $KV_CACHE_ID"
  success "KV SESSIONS: $KV_SESSIONS_ID"
  success "KV FEDIFY: $KV_FEDIFY_ID"
  info "R2 bucket: $R2_BUCKET_NAME (name only, no ID needed)"
else
  header "Fetching Cloudflare Resources"

  # --- D1 Database ---
  if [[ -n "${D1_DATABASE_ID:-}" ]]; then
    D1_ID="$D1_DATABASE_ID"
    success "D1: $D1_DATABASE_NAME → $D1_ID (from config.env)"
  else
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
  fi

  # --- KV Namespaces ---
  if [[ -n "${KV_CACHE_ID:-}" && -n "${KV_SESSIONS_ID:-}" && -n "${KV_FEDIFY_ID:-}" ]]; then
    success "KV CACHE: $KV_CACHE_ID (from config.env)"
    success "KV SESSIONS: $KV_SESSIONS_ID (from config.env)"
    success "KV FEDIFY: $KV_FEDIFY_ID (from config.env)"
  else
    info "Looking up KV namespaces..."
    KV_JSON=$(npx wrangler kv namespace list 2>/dev/null || echo "[]")

    if [[ -z "${KV_CACHE_ID:-}" ]]; then
      KV_CACHE_ID=$(echo "$KV_JSON" | node -e "
        const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
        const ns = d.find(x => x.title === '${KV_CACHE_TITLE}' || x.title === '${MAIN_WORKER_NAME}-${KV_CACHE_TITLE}' || x.title.includes('CACHE'));
        if (ns) console.log(ns.id);
      " 2>/dev/null || true)
    fi

    if [[ -z "${KV_SESSIONS_ID:-}" ]]; then
      KV_SESSIONS_ID=$(echo "$KV_JSON" | node -e "
        const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
        const ns = d.find(x => x.title === '${KV_SESSIONS_TITLE}' || x.title === '${MAIN_WORKER_NAME}-${KV_SESSIONS_TITLE}' || x.title.includes('SESSIONS'));
        if (ns) console.log(ns.id);
      " 2>/dev/null || true)
    fi

    if [[ -z "${KV_FEDIFY_ID:-}" ]]; then
      KV_FEDIFY_ID=$(echo "$KV_JSON" | node -e "
        const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
        const ns = d.find(x => x.title === '${KV_FEDIFY_TITLE}' || x.title === '${MAIN_WORKER_NAME}-${KV_FEDIFY_TITLE}' || x.title.includes('FEDIFY'));
        if (ns) console.log(ns.id);
      " 2>/dev/null || true)
    fi

    [[ -n "$KV_CACHE_ID" ]] && success "KV CACHE: $KV_CACHE_ID" || warn "KV CACHE not found"
    [[ -n "$KV_SESSIONS_ID" ]] && success "KV SESSIONS: $KV_SESSIONS_ID" || warn "KV SESSIONS not found"
    [[ -n "$KV_FEDIFY_ID" ]] && success "KV FEDIFY: $KV_FEDIFY_ID" || warn "KV FEDIFY not found"
  fi

  # --- R2 Bucket ---
  info "Looking up R2 bucket: ${R2_BUCKET_NAME}"
  R2_EXISTS=$(npx wrangler r2 bucket list 2>/dev/null | grep -w "$R2_BUCKET_NAME" || true)
  if [[ -n "$R2_EXISTS" ]]; then
    success "R2: $R2_BUCKET_NAME exists"
  else
    warn "R2 bucket '$R2_BUCKET_NAME' not found"
  fi
fi

# ============================================================================
# Resolve instance configuration — prefer config.env, fallback to wrangler.jsonc
# ============================================================================

# --- Instance Domain ---
CURRENT_DOMAIN="${INSTANCE_DOMAIN:-}"
if [[ -z "$CURRENT_DOMAIN" && -f "$MAIN_DIR/wrangler.jsonc" ]]; then
  CURRENT_DOMAIN=$(sed '/^[[:space:]]*\/\//d' "$MAIN_DIR/wrangler.jsonc" | node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      if (d.vars?.INSTANCE_DOMAIN) console.log(d.vars.INSTANCE_DOMAIN);
    } catch(e) {}
  " 2>/dev/null || true)
fi
if [[ -n "$CURRENT_DOMAIN" ]]; then
  info "Instance domain: $CURRENT_DOMAIN"
else
  warn "No INSTANCE_DOMAIN configured — using placeholder"
  CURRENT_DOMAIN="${PROJECT_PREFIX}.example.com"
fi

# --- Instance Title ---
CURRENT_TITLE="${INSTANCE_TITLE:-}"
if [[ -z "$CURRENT_TITLE" && -f "$MAIN_DIR/wrangler.jsonc" ]]; then
  CURRENT_TITLE=$(sed '/^[[:space:]]*\/\//d' "$MAIN_DIR/wrangler.jsonc" | node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      if (d.vars?.INSTANCE_TITLE) console.log(d.vars.INSTANCE_TITLE);
    } catch(e) {}
  " 2>/dev/null || true)
fi
CURRENT_TITLE="${CURRENT_TITLE:-SiliconBeest}"

# --- Registration Mode ---
CURRENT_REG="${REGISTRATION_MODE:-}"
if [[ -z "$CURRENT_REG" && -f "$MAIN_DIR/wrangler.jsonc" ]]; then
  CURRENT_REG=$(sed '/^[[:space:]]*\/\//d' "$MAIN_DIR/wrangler.jsonc" | node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      if (d.vars?.REGISTRATION_MODE) console.log(d.vars.REGISTRATION_MODE);
    } catch(e) {}
  " 2>/dev/null || true)
fi
CURRENT_REG="${CURRENT_REG:-open}"

# --- Repository URL ---
CURRENT_REPOSITORY_URL="${REPOSITORY_URL:-}"
if [[ -z "$CURRENT_REPOSITORY_URL" && -f "$MAIN_DIR/wrangler.jsonc" ]]; then
  CURRENT_REPOSITORY_URL=$(sed '/^[[:space:]]*\/\//d' "$MAIN_DIR/wrangler.jsonc" | node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      if (d.vars?.REPOSITORY_URL) console.log(d.vars.REPOSITORY_URL);
    } catch(e) {}
  " 2>/dev/null || true)
fi
CURRENT_REPOSITORY_URL="${CURRENT_REPOSITORY_URL:-https://github.com/SJang1/siliconbeest}"

# --- Optional Workers AI ---
CURRENT_WORKERS_AI_ENABLED="${WORKERS_AI_ENABLED:-false}"
if [[ "$CURRENT_WORKERS_AI_ENABLED" != "true" \
   && "$CURRENT_WORKERS_AI_ENABLED" != "false" ]]; then
  error "WORKERS_AI_ENABLED must be boolean true or false"
  exit 1
fi

CURRENT_WORKERS_AI_RECOMMENDATION_MODEL="${WORKERS_AI_RECOMMENDATION_MODEL:-@cf/baai/bge-m3}"
CURRENT_WORKERS_AI_TRANSLATION_MODEL="${WORKERS_AI_TRANSLATION_MODEL:-@cf/meta/m2m100-1.2b}"
CURRENT_WORKERS_AI_IMAGE_CAPTION_MODEL="${WORKERS_AI_IMAGE_CAPTION_MODEL:-@cf/moondream/moondream3.1-9B-A2B}"
CURRENT_WORKERS_AI_RATE_LIMITS="${WORKERS_AI_RATE_LIMITS:-true}"
if [[ "$CURRENT_WORKERS_AI_RATE_LIMITS" != "true" \
   && "$CURRENT_WORKERS_AI_RATE_LIMITS" != "false" ]]; then
  error "WORKERS_AI_RATE_LIMITS must be boolean true or false"
  exit 1
fi

CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT="${WORKERS_AI_RECOMMENDATION_RATE_LIMIT:-2}"
CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS="${WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS:-60}"
CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT="${WORKERS_AI_TRANSLATION_RATE_LIMIT:-6}"
CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS="${WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS:-60}"
CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT="${WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT:-4}"
CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS="${WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS:-60}"
CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID="${WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID:-1001}"
CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID="${WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID:-1002}"
CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID="${WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID:-1003}"

validate_positive_integer() {
  local variable_name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    error "$variable_name must be a positive integer"
    exit 1
  fi
}

validate_rate_limit_period() {
  local variable_name="$1"
  local value="$2"
  if [[ "$value" != "10" && "$value" != "60" ]]; then
    error "$variable_name must be 10 or 60"
    exit 1
  fi
}

validate_positive_integer \
  "WORKERS_AI_RECOMMENDATION_RATE_LIMIT" \
  "$CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT"
validate_positive_integer \
  "WORKERS_AI_TRANSLATION_RATE_LIMIT" \
  "$CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT"
validate_positive_integer \
  "WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT" \
  "$CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT"
validate_rate_limit_period \
  "WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS" \
  "$CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS"
validate_rate_limit_period \
  "WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS" \
  "$CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS"
validate_rate_limit_period \
  "WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS" \
  "$CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS"

if [[ "$CURRENT_WORKERS_AI_ENABLED" == "true" \
   && "$CURRENT_WORKERS_AI_RATE_LIMITS" == "true" ]]; then
  validate_positive_integer \
    "WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID" \
    "$CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID"
  validate_positive_integer \
    "WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID" \
    "$CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID"
  validate_positive_integer \
    "WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID" \
    "$CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID"

  if [[ "$CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID" == "$CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID" \
     || "$CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID" == "$CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID" \
     || "$CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID" == "$CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID" ]]; then
    error "Workers AI rate-limit namespace IDs must be pairwise distinct"
    exit 1
  fi
fi

WORKERS_AI_BINDING_BLOCK=""
if [[ "$CURRENT_WORKERS_AI_ENABLED" == "true" ]]; then
  WORKERS_AI_BINDING_BLOCK=$(cat <<EOF

	// Optional Workers AI (remote inference)
	"ai": {
		"binding": "AI",
		"remote": true
	},
EOF
)
fi

if [[ "$CURRENT_WORKERS_AI_ENABLED" == "true" \
   && "$CURRENT_WORKERS_AI_RATE_LIMITS" == "true" ]]; then
  WORKERS_AI_BINDING_BLOCK+=$(cat <<EOF

	// Account-keyed, per-feature Workers AI request limits
	"ratelimits": [
		{
			"name": "AI_RECOMMENDATION_RATE_LIMITER",
			"namespace_id": "${CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID}",
			"simple": {
				"limit": ${CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT},
				"period": ${CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS}
			}
		},
		{
			"name": "AI_TRANSLATION_RATE_LIMITER",
			"namespace_id": "${CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID}",
			"simple": {
				"limit": ${CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT},
				"period": ${CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS}
			}
		},
		{
			"name": "AI_IMAGE_DESCRIPTION_RATE_LIMITER",
			"namespace_id": "${CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID}",
			"simple": {
				"limit": ${CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT},
				"period": ${CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS}
			}
		}
	],
EOF
)
fi

if [[ -n "$WORKERS_AI_BINDING_BLOCK" ]]; then
  WORKERS_AI_BINDING_BLOCK+=$'\n'
fi

# Preserve the checked-in main Wrangler formatting byte-for-byte. Keeping the
# mixed legacy indent in a value avoids introducing whitespace errors here.
WRANGLER_COMPATIBILITY_FLAGS_INDENT=$'  \t'

# --- Fedify Signature Verification Override ---
# config.env/environment wins. Otherwise preserve the main worker value; the
# main worker is canonical when the two checked-in configs disagree.
read_signature_verification_override() {
  local config_file="$1"
  if [[ ! -f "$config_file" ]]; then
    return
  fi

  sed '/^[[:space:]]*\/\//d' "$config_file" | node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
      const value = d.vars?.SKIP_SIGNATURE_VERIFICATION;
      if (value !== undefined) {
        console.log(typeof value === 'boolean' ? String(value) : 'INVALID');
      }
    } catch (e) {}
  " 2>/dev/null || true
}

MAIN_SKIP_SIGNATURE_VERIFICATION=$(
  read_signature_verification_override "$MAIN_DIR/wrangler.jsonc"
)
CONSUMER_SKIP_SIGNATURE_VERIFICATION=$(
  read_signature_verification_override "$CONSUMER_DIR/wrangler.jsonc"
)

if [[ "$MAIN_SKIP_SIGNATURE_VERIFICATION" == "INVALID" ]]; then
  error "Main wrangler SKIP_SIGNATURE_VERIFICATION must be boolean true or false"
  exit 1
fi
if [[ "$CONSUMER_SKIP_SIGNATURE_VERIFICATION" == "INVALID" ]]; then
  error "Queue consumer wrangler SKIP_SIGNATURE_VERIFICATION must be boolean true or false"
  exit 1
fi
if [[ -n "$MAIN_SKIP_SIGNATURE_VERIFICATION" \
   && -n "$CONSUMER_SKIP_SIGNATURE_VERIFICATION" \
   && "$MAIN_SKIP_SIGNATURE_VERIFICATION" != "$CONSUMER_SKIP_SIGNATURE_VERIFICATION" ]]; then
  warn "Signature verification overrides differ; the main worker value is canonical"
fi

CURRENT_SKIP_SIGNATURE_VERIFICATION="${SKIP_SIGNATURE_VERIFICATION:-}"
if [[ -z "$CURRENT_SKIP_SIGNATURE_VERIFICATION" ]]; then
  CURRENT_SKIP_SIGNATURE_VERIFICATION="${MAIN_SKIP_SIGNATURE_VERIFICATION:-false}"
fi
if [[ "$CURRENT_SKIP_SIGNATURE_VERIFICATION" != "true" \
   && "$CURRENT_SKIP_SIGNATURE_VERIFICATION" != "false" ]]; then
  error "SKIP_SIGNATURE_VERIFICATION must be boolean true or false"
  exit 1
fi

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
echo "  Repository URL: ${CURRENT_REPOSITORY_URL}"
echo "  Registration:   ${CURRENT_REG}"
echo "  Skip signatures: ${CURRENT_SKIP_SIGNATURE_VERIFICATION}"
echo "  Workers AI:      ${CURRENT_WORKERS_AI_ENABLED}"
echo "  AI recommend:    ${CURRENT_WORKERS_AI_RECOMMENDATION_MODEL}"
echo "  AI translation:  ${CURRENT_WORKERS_AI_TRANSLATION_MODEL}"
echo "  AI image caption: ${CURRENT_WORKERS_AI_IMAGE_CAPTION_MODEL}"
echo "  AI rate limits:   ${CURRENT_WORKERS_AI_RATE_LIMITS}"
echo "  AI rate-limit levels: ${CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT}/${CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS}s, ${CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT}/${CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS}s, ${CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT}/${CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS}s"
if [[ "$CURRENT_WORKERS_AI_ENABLED" == "true" \
   && "$CURRENT_WORKERS_AI_RATE_LIMITS" == "true" ]]; then
  echo "  AI rate-limit namespaces: ${CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT_NAMESPACE_ID}/${CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT_NAMESPACE_ID}/${CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_NAMESPACE_ID}"
fi
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

# --- Unified worker wrangler.jsonc (siliconbeest/) ---
info "Writing $MAIN_DIR/wrangler.jsonc"
cat > "$MAIN_DIR/wrangler.jsonc" << WRANGLER_EOF
{
	"\$schema": "node_modules/wrangler/config-schema.json",
	"name": "${MAIN_WORKER_NAME}",
	"preview_urls": false,
	"compatibility_date": "2026-06-16",
	// Nuxt emits the production Cloudflare Worker entrypoint during \`pnpm run build\`.
	"main": ".output/server/index.mjs",
	"assets": {
		"directory": "./.output/public",
		"not_found_handling": "none",
		"binding": "ASSETS"
	},
	"observability": {
	  "enabled": false,
	  "head_sampling_rate": 1,
	  "logs": {
	    "enabled": true,
	    "head_sampling_rate": 1,
	    "persist": true,
	    "invocation_logs": true
	  },
	  "traces": {
	    "enabled": true,
	    "persist": true,
	    "head_sampling_rate": 1
	  }
	},
${WRANGLER_COMPATIBILITY_FLAGS_INDENT}"compatibility_flags": ["nodejs_compat"],
	"placement": {
		"mode": "smart"
	},

	// Environment Variables (set SETUP_SECRET via \`wrangler secret put SETUP_SECRET\` before first-run setup)
	"vars": {
		"INSTANCE_DOMAIN": "${CURRENT_DOMAIN}",
		"INSTANCE_TITLE": "${CURRENT_TITLE}",
		"REPOSITORY_URL": "${CURRENT_REPOSITORY_URL}",
		"REGISTRATION_MODE": "${CURRENT_REG}",
		"SKIP_SIGNATURE_VERIFICATION": ${CURRENT_SKIP_SIGNATURE_VERIFICATION},
		"WORKERS_AI_ENABLED": ${CURRENT_WORKERS_AI_ENABLED},
		"WORKERS_AI_RECOMMENDATION_MODEL": "${CURRENT_WORKERS_AI_RECOMMENDATION_MODEL}",
		"WORKERS_AI_TRANSLATION_MODEL": "${CURRENT_WORKERS_AI_TRANSLATION_MODEL}",
		"WORKERS_AI_IMAGE_CAPTION_MODEL": "${CURRENT_WORKERS_AI_IMAGE_CAPTION_MODEL}",
		"WORKERS_AI_RATE_LIMITS": ${CURRENT_WORKERS_AI_RATE_LIMITS},
		"WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS": ${CURRENT_WORKERS_AI_RECOMMENDATION_RATE_LIMIT_PERIOD_SECONDS},
		"WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS": ${CURRENT_WORKERS_AI_TRANSLATION_RATE_LIMIT_PERIOD_SECONDS},
		"WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS": ${CURRENT_WORKERS_AI_IMAGE_DESCRIPTION_RATE_LIMIT_PERIOD_SECONDS}
	},
${WORKERS_AI_BINDING_BLOCK}
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

	// Workers Routes (catch-all for custom domain)
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
	"compatibility_date": "2026-06-16",
	"compatibility_flags": ["nodejs_compat"],
	"observability": {
		"enabled": true
	},
	"workers_dev": false,
	// Force all @fedify/* imports (including cross-package from siliconbeest-worker)
	// to resolve from THIS package's node_modules to avoid dual-package bundling.
	"alias": {
		"@fedify/fedify": "./node_modules/@fedify/fedify/dist/mod.js",
		"@fedify/fedify/vocab": "./node_modules/@fedify/fedify/dist/vocab/mod.js",
		"@fedify/cfworkers": "./node_modules/@fedify/cfworkers/dist/mod.js"
	},
	"placement": {
		"mode": "smart"
	},
	"vars": {
		"INSTANCE_DOMAIN": "${CURRENT_DOMAIN}",
		"REPOSITORY_URL": "${CURRENT_REPOSITORY_URL}",
		"SKIP_SIGNATURE_VERIFICATION": ${CURRENT_SKIP_SIGNATURE_VERIFICATION}
	},
	// D1 Database
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

	// Queues (consume federation + internal + federation-dlq, produce for re-enqueue/fanout)
	"queues": {
		"consumers": [
			{
				"queue": "${QUEUE_FEDERATION}",
				"max_retries": 5,
				"dead_letter_queue": "${QUEUE_DLQ}"
			},
			{
				"queue": "${QUEUE_INTERNAL}",
				"max_retries": 3
			},
			{
				// Dead-lettered federation messages: reprocess once more, then
				// park persistent failures into the federation_dlq_parked table.
				"queue": "${QUEUE_DLQ}",
				"max_retries": 2
			}
		],
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

	// Capability-scoped RPC binding to the main Worker's private entrypoint
	"services": [
		{
			"binding": "INTERNAL_CONNECTION_MAIN",
			"service": "${MAIN_WORKER_NAME}",
			"entrypoint": "Internal"
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
	"compatibility_date": "2026-06-16",
	"compatibility_flags": ["nodejs_compat"],
	"observability": {
		"enabled": true
	},
	"workers_dev": false,

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
echo "    2. Set secrets if needed:  wrangler secret put OTP_ENCRYPTION_KEY --name $MAIN_WORKER_NAME && wrangler secret put SETUP_SECRET --name $MAIN_WORKER_NAME"
echo "    3. Apply migrations:       ./scripts/migrate.sh --remote"
echo "    4. Deploy:                  ./scripts/deploy.sh"
