#!/usr/bin/env bash
# =============================================================================
# SiliconBeest — Shared Script Configuration
#
# All resource names are defined here. Edit these values to customize
# your instance's Cloudflare resource naming.
#
# This file is sourced by all other scripts via:
#   source "$(dirname "${BASH_SOURCE[0]}")/config.sh"
# =============================================================================

# ---------------------------------------------------------------------------
# Instance overrides (config.env) — must load BEFORE the derived names below:
# CI writes PROJECT_PREFIX there from GitHub Variables, and every
# ${PROJECT_PREFIX}-* default is frozen at the moment it is evaluated.
# ---------------------------------------------------------------------------
_CONFIG_ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.env"
[[ -f "$_CONFIG_ENV_FILE" ]] && source "$_CONFIG_ENV_FILE"

# ---------------------------------------------------------------------------
# Project prefix — used as default for all resource names below
# Change this to rename everything at once (e.g. "myinstance")
# ---------------------------------------------------------------------------
PROJECT_PREFIX="${PROJECT_PREFIX:-siliconbeest}"
# Cloudflare worker, queue, and R2 names must be lowercase (alphanumeric and
# dashes). Normalize so a mixed-case prefix — e.g. a GitHub Variable set to
# "SiliconBeest" — resolves to the lowercase names wrangler accepts.
PROJECT_PREFIX=$(printf '%s' "$PROJECT_PREFIX" | tr '[:upper:]' '[:lower:]')
if [[ ! "$PROJECT_PREFIX" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "[ERROR] PROJECT_PREFIX must contain only letters, numbers, and dashes, got: $PROJECT_PREFIX" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Cloudflare Worker names (used by wrangler deploy --name)
# These also determine the *.workers.dev subdomain
# ---------------------------------------------------------------------------
# The unified worker (Vue frontend + API worker in one)
MAIN_WORKER_NAME="${MAIN_WORKER_NAME:-${PROJECT_PREFIX}}"
CONSUMER_NAME="${CONSUMER_NAME:-${PROJECT_PREFIX}-queue-consumer}"
EMAIL_SENDER_NAME="${EMAIL_SENDER_NAME:-${PROJECT_PREFIX}-email-sender}"

# ---------------------------------------------------------------------------
# Cloudflare resource names
# ---------------------------------------------------------------------------
D1_DATABASE_NAME="${D1_DATABASE_NAME:-${PROJECT_PREFIX}-db}"
R2_BUCKET_NAME="${R2_BUCKET_NAME:-${PROJECT_PREFIX}-media}"
KV_CACHE_TITLE="${KV_CACHE_TITLE:-${PROJECT_PREFIX}-CACHE}"
KV_SESSIONS_TITLE="${KV_SESSIONS_TITLE:-${PROJECT_PREFIX}-SESSIONS}"
KV_FEDIFY_TITLE="${KV_FEDIFY_TITLE:-${PROJECT_PREFIX}-FEDIFY_KV}"
QUEUE_FEDERATION="${QUEUE_FEDERATION:-${PROJECT_PREFIX}-federation}"
INBOX_QUEUE_LANES=8
QUEUE_INTERNAL="${QUEUE_INTERNAL:-${PROJECT_PREFIX}-internal}"
QUEUE_EMAIL="${QUEUE_EMAIL:-${PROJECT_PREFIX}-email}"
QUEUE_DLQ="${QUEUE_DLQ:-${PROJECT_PREFIX}-federation-dlq}"
QUEUE_DB_INSERT="${QUEUE_DB_INSERT:-${PROJECT_PREFIX}-db-insert}"
QUEUE_DB_UPDATE="${QUEUE_DB_UPDATE:-${PROJECT_PREFIX}-db-update}"
QUEUE_DB_INSERT_DLQ="${QUEUE_DB_INSERT_DLQ:-${PROJECT_PREFIX}-db-insert-dlq}"
QUEUE_DB_UPDATE_DLQ="${QUEUE_DB_UPDATE_DLQ:-${PROJECT_PREFIX}-db-update-dlq}"
QUEUE_REGISTRATION="${QUEUE_REGISTRATION:-${PROJECT_PREFIX}-registration}"
QUEUE_REGISTRATION_DLQ="${QUEUE_REGISTRATION_DLQ:-${PROJECT_PREFIX}-registration-dlq}"

# ---------------------------------------------------------------------------
# Directory names (relative to project root)
# These match the actual folder names on disk
# ---------------------------------------------------------------------------
SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PROJECT_ROOT="${PROJECT_ROOT:-$(dirname "$SCRIPT_DIR")}"
MAIN_DIR="${MAIN_DIR:-$PROJECT_ROOT/siliconbeest}"
CONSUMER_DIR="${CONSUMER_DIR:-$PROJECT_ROOT/siliconbeest-queue-consumer}"
EMAIL_DIR="${EMAIL_DIR:-$PROJECT_ROOT/siliconbeest-email-sender}"

# ---------------------------------------------------------------------------
# Colors (shared across scripts)
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
header()  { echo -e "\n${BOLD}${CYAN}=== $* ===${NC}\n"; }

# ---------------------------------------------------------------------------
# Helper: read a value from a wrangler.jsonc file
# Usage: read_wrangler_json "/path/to/wrangler.jsonc" "config.vars?.INSTANCE_DOMAIN"
# ---------------------------------------------------------------------------
read_wrangler_json() {
  local FILE="$1"
  local EXPR="$2"
  node -e "
const fs = require('fs');
const content = fs.readFileSync('$FILE', 'utf8');
// Strip full-line comments only: a trailing-comment regex would also eat
// the slashes inside string values like the REPOSITORY_URL https URL.
const cleaned = content.replace(/^[ \t]*\/\/.*$/gm, '');
try {
  const config = JSON.parse(cleaned);
  const result = $EXPR;
  process.stdout.write(String(result || ''));
} catch(e) { process.stdout.write(''); }
" 2>/dev/null
}
