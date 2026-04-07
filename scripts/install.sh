#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — Standalone Resource Provisioner
#
# Creates all Cloudflare resources needed for a SiliconBeest instance and
# outputs the values to set as GitHub Repository Variables.
#
# No repo clone required. Run directly:
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/SJang1/siliconbeest/HEAD/scripts/install.sh)"
# =============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
header()  { echo -e "\n${BOLD}${CYAN}=== $* ===${NC}\n"; }

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║       SiliconBeest Installer             ║${NC}"
echo -e "${BOLD}║   Serverless Fediverse on CF Workers     ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
header "Checking Prerequisites"

if ! command -v node &>/dev/null; then
  error "Node.js is required. Install from: https://nodejs.org/"
  exit 1
fi
success "Node.js found ($(node -v))"

if ! command -v npx &>/dev/null; then
  error "npx is required (comes with Node.js)."
  exit 1
fi

# Use npx wrangler so no global install is needed
WRANGLER="npx wrangler@latest"

info "Checking Cloudflare authentication..."
if ! $WRANGLER whoami 2>/dev/null | grep -q "Account ID"; then
  warn "Not logged in to Cloudflare."
  info "Opening browser for authentication..."
  $WRANGLER login
fi
success "Authenticated with Cloudflare"

# ---------------------------------------------------------------------------
# Collect configuration
# ---------------------------------------------------------------------------
header "Instance Configuration"

read -rp "$(echo -e "${CYAN}Project prefix${NC} [siliconbeest]: ")" PROJECT_PREFIX
PROJECT_PREFIX="${PROJECT_PREFIX:-siliconbeest}"

read -rp "$(echo -e "${CYAN}Instance domain${NC} (e.g. social.example.com): ")" INSTANCE_DOMAIN
if [[ -z "$INSTANCE_DOMAIN" ]]; then
  error "Domain is required."
  exit 1
fi

read -rp "$(echo -e "${CYAN}Instance title${NC} [SiliconBeest]: ")" INSTANCE_TITLE
INSTANCE_TITLE="${INSTANCE_TITLE:-SiliconBeest}"

echo -e "${CYAN}Registration mode${NC}:"
echo "  1) open       — anyone can register"
echo "  2) approval   — registrations require admin approval"
echo "  3) closed     — registrations are disabled"
read -rp "Choose [1]: " REG_CHOICE
case "$REG_CHOICE" in
  2) REGISTRATION_MODE="approval" ;;
  3) REGISTRATION_MODE="closed" ;;
  *)  REGISTRATION_MODE="open" ;;
esac

# Derive resource names
D1_DATABASE_NAME="${PROJECT_PREFIX}-db"
R2_BUCKET_NAME="${PROJECT_PREFIX}-media"
QUEUE_FEDERATION="${PROJECT_PREFIX}-federation"
QUEUE_INTERNAL="${PROJECT_PREFIX}-internal"
QUEUE_EMAIL="${PROJECT_PREFIX}-email"
QUEUE_DLQ="${PROJECT_PREFIX}-federation-dlq"

echo
info "Domain:         $INSTANCE_DOMAIN"
info "Title:          $INSTANCE_TITLE"
info "Registration:   $REGISTRATION_MODE"
info "Prefix:         $PROJECT_PREFIX"
echo
read -rp "Proceed? [Y/n] " CONFIRM
if [[ "$CONFIRM" =~ ^[Nn] ]]; then
  info "Cancelled."
  exit 0
fi

# ---------------------------------------------------------------------------
# Create Cloudflare resources
# ---------------------------------------------------------------------------
header "Creating Cloudflare Resources"

# --- D1 Database ---
info "Creating D1 database: $D1_DATABASE_NAME"
DB_OUTPUT=$($WRANGLER d1 create "$D1_DATABASE_NAME" 2>&1 || true)
DB_ID=$(echo "$DB_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
if [[ -n "$DB_ID" ]]; then
  success "D1: $D1_DATABASE_NAME → $DB_ID"
else
  warn "D1 database may already exist. Check Cloudflare dashboard for the ID."
fi

# --- R2 Bucket ---
info "Creating R2 bucket: $R2_BUCKET_NAME"
R2_OUTPUT=$($WRANGLER r2 bucket create "$R2_BUCKET_NAME" 2>&1 || true)
if echo "$R2_OUTPUT" | grep -qi "already exists"; then
  warn "R2 bucket '$R2_BUCKET_NAME' already exists."
else
  success "R2 bucket created: $R2_BUCKET_NAME"
fi

# --- KV Namespaces ---
create_kv() {
  local TITLE="$1"
  info "Creating KV namespace: $TITLE"
  local OUTPUT
  OUTPUT=$($WRANGLER kv namespace create "$TITLE" 2>&1 || true)
  local KV_ID
  KV_ID=$(echo "$OUTPUT" | grep -oE '[0-9a-f]{32}' | head -1)
  if [[ -n "$KV_ID" ]]; then
    success "KV $TITLE: $KV_ID"
  else
    warn "KV '$TITLE' may already exist. Check dashboard."
  fi
  echo "$KV_ID"
}

KV_CACHE_ID=$(create_kv "CACHE")
KV_SESSIONS_ID=$(create_kv "SESSIONS")
KV_FEDIFY_ID=$(create_kv "FEDIFY_KV")

# --- Queues ---
create_queue() {
  local NAME="$1"
  info "Creating queue: $NAME"
  $WRANGLER queues create "$NAME" 2>/dev/null || warn "Queue '$NAME' may already exist."
  success "Queue: $NAME"
}

create_queue "$QUEUE_FEDERATION"
create_queue "$QUEUE_INTERNAL"
create_queue "$QUEUE_EMAIL"
create_queue "$QUEUE_DLQ"

# ---------------------------------------------------------------------------
# Output — copy these to GitHub Repository Variables
# ---------------------------------------------------------------------------
header "Setup Complete"

echo -e "${GREEN}${BOLD}All Cloudflare resources created!${NC}"
echo
echo -e "${BOLD}Copy the values below to your GitHub repository:${NC}"
echo -e "${BOLD}Settings > Secrets and variables > Actions > Variables${NC}"
echo
echo "┌─────────────────────────────────────────────────────────────"
echo "│ Variable               Value"
echo "├─────────────────────────────────────────────────────────────"
echo "│ PROJECT_PREFIX          $PROJECT_PREFIX"
echo "│ INSTANCE_DOMAIN         $INSTANCE_DOMAIN"
echo "│ INSTANCE_TITLE          $INSTANCE_TITLE"
echo "│ REGISTRATION_MODE       $REGISTRATION_MODE"
echo "│ D1_DATABASE_ID          ${DB_ID:-<check dashboard>}"
echo "│ KV_CACHE_ID             ${KV_CACHE_ID:-<check dashboard>}"
echo "│ KV_SESSIONS_ID          ${KV_SESSIONS_ID:-<check dashboard>}"
echo "│ KV_FEDIFY_ID            ${KV_FEDIFY_ID:-<check dashboard>}"
echo "└─────────────────────────────────────────────────────────────"
echo
echo -e "${BOLD}Also set these as GitHub Secrets:${NC}"
echo
echo "┌─────────────────────────────────────────────────────────────"
echo "│ CLOUDFLARE_API_TOKEN    <your API token>"
echo "│ CLOUDFLARE_ACCOUNT_ID   <your account ID>"
echo "└─────────────────────────────────────────────────────────────"
echo
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Set the variables and secrets above in your GitHub repository"
echo "  2. Go to Actions > Deploy > Run workflow to deploy"
echo "  3. Configure Cloudflare WAF Skip rule for ActivityPub (see docs)"
echo
