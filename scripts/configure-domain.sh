#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — Custom Domain Configuration
# Sets up Workers Routes so a custom domain routes to the unified worker.
#
# Architecture: single unified worker (siliconbeest) handles all routes.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"
[[ -f "$SCRIPT_DIR/config.env" ]] && source "$SCRIPT_DIR/config.env"

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

# Update unified worker wrangler.jsonc
if [[ -f "$MAIN_DIR/wrangler.jsonc" ]]; then
  node -e "
const fs = require('fs');
let content = fs.readFileSync('$MAIN_DIR/wrangler.jsonc', 'utf8');
content = content.replace(/(\"INSTANCE_DOMAIN\":\s*\")[^\"]*(\")/, '\$1$DOMAIN\$2');
content = content.replace(/(\"pattern\":\s*\")[^\"]*(\")/, '\$1$DOMAIN\$2');
fs.writeFileSync('$MAIN_DIR/wrangler.jsonc', content);
"
  success "Updated siliconbeest/wrangler.jsonc"
else
  error "siliconbeest/wrangler.jsonc not found"
  exit 1
fi

# Update queue consumer wrangler.jsonc
if [[ -f "$CONSUMER_DIR/wrangler.jsonc" ]]; then
  node -e "
const fs = require('fs');
let content = fs.readFileSync('$CONSUMER_DIR/wrangler.jsonc', 'utf8');
content = content.replace(/(\"INSTANCE_DOMAIN\":\s*\")[^\"]*(\")/, '\$1$DOMAIN\$2');
fs.writeFileSync('$CONSUMER_DIR/wrangler.jsonc', content);
"
  success "Updated siliconbeest-queue-consumer/wrangler.jsonc"
else
  warn "siliconbeest-queue-consumer/wrangler.jsonc not found, skipping"
fi

# ---------------------------------------------------------------------------
# Redeploy worker to pick up config changes
# ---------------------------------------------------------------------------
header "Redeploying Worker"

info "Redeploying $MAIN_WORKER_NAME with updated domain..."
(cd "$MAIN_DIR" && pnpm run build && pnpm wrangler deploy)
success "$MAIN_WORKER_NAME redeployed"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
header "Domain Configuration Complete"

echo -e "${GREEN}${BOLD}Custom domain configured for: $DOMAIN${NC}"
echo
echo -e "  ${BOLD}Route Mapping:${NC}"
echo -e "    $DOMAIN (custom_domain) -> $MAIN_WORKER_NAME (unified worker)"
echo
echo -e "${YELLOW}Important:${NC}"
echo "  - The unified worker handles all routes (API + frontend)"
echo "  - Make sure your DNS has a proxied (orange cloud) record for $DOMAIN"
echo "  - If using a subdomain, add a CNAME or A record pointing to Cloudflare"
echo
echo -e "${RED}${BOLD}CRITICAL — Cloudflare Bot Protection:${NC}"
echo "  Cloudflare's Bot Fight Mode / Super Bot Fight Mode will block ActivityPub"
echo "  federation traffic to /users/* and /inbox endpoints (returns 403 to bots)."
echo
echo "  You MUST create a WAF exception rule in the Cloudflare Dashboard:"
echo "    1. Go to Security > WAF > Custom Rules"
echo "    2. Create a rule with expression:"
echo '       (http.request.uri.path matches "^/users/.*" or'
echo '        http.request.uri.path eq "/inbox" or'
echo '        http.request.uri.path eq "/actor" or'
echo '        http.request.uri.path matches "^/nodeinfo/.*" or'
echo '        http.request.uri.path matches "^/.well-known/.*")'
echo "    3. Action: Skip → check ALL remaining custom rules + Super Bot Fight Mode"
echo "    4. Place it FIRST in your rule list (highest priority)"
echo
echo "  Without this, other Fediverse servers cannot discover or communicate"
echo "  with your instance. Verify with:"
echo "    curl -H 'Accept: application/activity+json' https://$DOMAIN/users/admin"
echo "  It should return JSON, not an HTML challenge page."
echo
echo -e "${YELLOW}Verify with:${NC}"
echo "  curl https://$DOMAIN/.well-known/webfinger?resource=acct:admin@$DOMAIN"
echo
