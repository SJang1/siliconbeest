#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — Custom Domain Configuration
# Sets up Workers Routes so a custom domain routes to the correct workers.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WORKER_DIR="$PROJECT_ROOT/siliconbeest-worker"
VUE_DIR="$PROJECT_ROOT/siliconbeest-vue"

# ---------------------------------------------------------------------------
# Colors
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
# Usage
# ---------------------------------------------------------------------------
if [[ -z "$1" ]]; then
  echo "Usage: configure-domain.sh <domain>"
  echo
  echo "Example:"
  echo "  ./scripts/configure-domain.sh social.example.com"
  echo
  echo "Prerequisites:"
  echo "  - Domain must be added to your Cloudflare account"
  echo "  - DNS must be configured (A/AAAA or CNAME record)"
  echo "  - Workers must be deployed first (run deploy.sh)"
  exit 1
fi

DOMAIN="$1"

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
header "Checking Prerequisites"

if ! command -v wrangler &>/dev/null; then
  error "wrangler CLI is not installed."
  exit 1
fi
success "wrangler found"

if ! wrangler whoami &>/dev/null; then
  error "Not logged in to Cloudflare."
  exit 1
fi
success "Authenticated"

# ---------------------------------------------------------------------------
# Update INSTANCE_DOMAIN in wrangler.jsonc
# ---------------------------------------------------------------------------
header "Updating Instance Domain"

info "Setting INSTANCE_DOMAIN to: $DOMAIN"
if [[ -f "$WORKER_DIR/wrangler.jsonc" ]]; then
  node -e "
const fs = require('fs');
let content = fs.readFileSync('$WORKER_DIR/wrangler.jsonc', 'utf8');
content = content.replace(/(\"INSTANCE_DOMAIN\":\s*\")[^\"]*(\")/, '\$1$DOMAIN\$2');
fs.writeFileSync('$WORKER_DIR/wrangler.jsonc', content);
"
  success "Updated siliconbeest-worker/wrangler.jsonc"
else
  error "siliconbeest-worker/wrangler.jsonc not found"
  exit 1
fi

# ---------------------------------------------------------------------------
# Determine Cloudflare Zone ID
# ---------------------------------------------------------------------------
header "Looking Up Zone"

# Extract the root domain (last two parts) for zone lookup
ROOT_DOMAIN=$(echo "$DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')
info "Looking up zone for: $ROOT_DOMAIN"

ZONE_ID=$(wrangler zones list 2>/dev/null | grep -i "$ROOT_DOMAIN" | grep -oE '[0-9a-f]{32}' | head -1 || true)

if [[ -z "$ZONE_ID" ]]; then
  warn "Could not auto-detect zone ID for $ROOT_DOMAIN."
  read -rp "Enter your Cloudflare Zone ID manually: " ZONE_ID
  if [[ -z "$ZONE_ID" ]]; then
    error "Zone ID is required to configure routes."
    exit 1
  fi
fi
success "Zone ID: $ZONE_ID"

# ---------------------------------------------------------------------------
# Create Workers Routes
# ---------------------------------------------------------------------------
header "Configuring Workers Routes"

# Routes that should go to the API worker (siliconbeest-worker)
API_ROUTES=(
  "${DOMAIN}/api/*"
  "${DOMAIN}/oauth/*"
  "${DOMAIN}/.well-known/*"
  "${DOMAIN}/users/*"
  "${DOMAIN}/inbox"
  "${DOMAIN}/nodeinfo/*"
)

# The catch-all route for the frontend (siliconbeest-vue)
FRONTEND_ROUTE="${DOMAIN}/*"

info "Creating API routes (siliconbeest-worker)..."
for ROUTE in "${API_ROUTES[@]}"; do
  info "  Route: $ROUTE -> siliconbeest-worker"
  wrangler routes create "$ROUTE" \
    --worker "siliconbeest-worker" \
    --zone "$ZONE_ID" 2>/dev/null || \
  wrangler routes create "$ROUTE" \
    --worker "siliconbeest-worker" \
    --zone-id "$ZONE_ID" 2>/dev/null || \
  warn "  Could not create route: $ROUTE (may already exist or use 'wrangler routes' manually)"
done
success "API routes configured"

info "Creating frontend route (siliconbeest-vue)..."
info "  Route: $FRONTEND_ROUTE -> siliconbeest-vue"
wrangler routes create "$FRONTEND_ROUTE" \
  --worker "siliconbeest-vue" \
  --zone "$ZONE_ID" 2>/dev/null || \
wrangler routes create "$FRONTEND_ROUTE" \
  --worker "siliconbeest-vue" \
  --zone-id "$ZONE_ID" 2>/dev/null || \
warn "  Could not create frontend route (may already exist or use 'wrangler routes' manually)"
success "Frontend route configured"

# ---------------------------------------------------------------------------
# Redeploy workers to pick up config changes
# ---------------------------------------------------------------------------
header "Redeploying Workers"

info "Redeploying siliconbeest-worker with updated domain..."
(cd "$WORKER_DIR" && wrangler deploy)
success "siliconbeest-worker redeployed"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
header "Domain Configuration Complete"

echo -e "${GREEN}${BOLD}Custom domain configured for: $DOMAIN${NC}"
echo
echo -e "  ${BOLD}Route Mapping:${NC}"
for ROUTE in "${API_ROUTES[@]}"; do
  echo -e "    $ROUTE  ->  siliconbeest-worker"
done
echo -e "    $FRONTEND_ROUTE             ->  siliconbeest-vue"
echo
echo -e "${YELLOW}Important:${NC}"
echo "  - More specific routes (e.g. /api/*) take priority over the catch-all (/*)"
echo "  - Make sure your DNS has a proxied (orange cloud) record for $DOMAIN"
echo "  - If using a subdomain, add a CNAME or A record pointing to Cloudflare"
echo
echo -e "${YELLOW}Verify with:${NC}"
echo "  curl https://$DOMAIN/.well-known/webfinger?resource=acct:admin@$DOMAIN"
echo
