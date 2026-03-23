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
# Project prefix — used as default for all resource names below
# Change this to rename everything at once (e.g. "myinstance")
# ---------------------------------------------------------------------------
PROJECT_PREFIX="${PROJECT_PREFIX:-siliconbeest}"

# ---------------------------------------------------------------------------
# Cloudflare Worker names (used by wrangler deploy --name)
# These also determine the *.workers.dev subdomain
# ---------------------------------------------------------------------------
WORKER_NAME="${WORKER_NAME:-${PROJECT_PREFIX}-worker}"
CONSUMER_NAME="${CONSUMER_NAME:-${PROJECT_PREFIX}-queue-consumer}"
VUE_NAME="${VUE_NAME:-${PROJECT_PREFIX}-vue}"

# ---------------------------------------------------------------------------
# Cloudflare resource names
# ---------------------------------------------------------------------------
D1_DATABASE_NAME="${D1_DATABASE_NAME:-${PROJECT_PREFIX}-db}"
R2_BUCKET_NAME="${R2_BUCKET_NAME:-${PROJECT_PREFIX}-media}"
KV_CACHE_TITLE="${KV_CACHE_TITLE:-${PROJECT_PREFIX}-CACHE}"
KV_SESSIONS_TITLE="${KV_SESSIONS_TITLE:-${PROJECT_PREFIX}-SESSIONS}"
QUEUE_FEDERATION="${QUEUE_FEDERATION:-${PROJECT_PREFIX}-federation}"
QUEUE_INTERNAL="${QUEUE_INTERNAL:-${PROJECT_PREFIX}-internal}"
QUEUE_DLQ="${QUEUE_DLQ:-${PROJECT_PREFIX}-federation-dlq}"

# ---------------------------------------------------------------------------
# Directory names (relative to project root)
# These match the actual folder names on disk
# ---------------------------------------------------------------------------
SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PROJECT_ROOT="${PROJECT_ROOT:-$(dirname "$SCRIPT_DIR")}"
WORKER_DIR="${WORKER_DIR:-$PROJECT_ROOT/siliconbeest-worker}"
CONSUMER_DIR="${CONSUMER_DIR:-$PROJECT_ROOT/siliconbeest-queue-consumer}"
VUE_DIR="${VUE_DIR:-$PROJECT_ROOT/siliconbeest-vue}"

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
const cleaned = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
try {
  const config = JSON.parse(cleaned);
  const result = $EXPR;
  process.stdout.write(String(result || ''));
} catch(e) { process.stdout.write(''); }
" 2>/dev/null
}
