#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — Deploy Script
# Builds and deploys all 3 workers to Cloudflare.
# Optionally configures custom domain routes.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WORKER_DIR="$PROJECT_ROOT/siliconbeest-worker"
CONSUMER_DIR="$PROJECT_ROOT/siliconbeest-queue-consumer"
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
# Parse arguments
# ---------------------------------------------------------------------------
DRY_RUN=false
SKIP_MIGRATIONS=false
DOMAIN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)         DRY_RUN=true; shift ;;
    --skip-migrations) SKIP_MIGRATIONS=true; shift ;;
    --domain)
      if [[ -z "$2" || "$2" == --* ]]; then
        error "--domain requires a value (e.g. --domain social.example.com)"
        exit 1
      fi
      DOMAIN="$2"; shift 2 ;;
    --domain=*)
      DOMAIN="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: deploy.sh [OPTIONS]"
      echo
      echo "Options:"
      echo "  --domain <domain>   Configure custom domain routes (e.g. social.example.com)"
      echo "  --dry-run           Print what would be deployed without deploying"
      echo "  --skip-migrations   Skip D1 migration step"
      echo "  -h, --help          Show this help"
      exit 0
      ;;
    *) error "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Helper: read config values from wrangler.jsonc
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
  process.stdout.write(result || '');
} catch(e) { process.stdout.write(''); }
" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
header "Checking Prerequisites"

if ! command -v wrangler &>/dev/null; then
  error "wrangler CLI is not installed. Install with: npm i -g wrangler"
  exit 1
fi
success "wrangler found"

if ! wrangler whoami &>/dev/null; then
  error "Not logged in to Cloudflare. Run: wrangler login"
  exit 1
fi
success "Authenticated with Cloudflare"

# Check that project directories exist
for DIR in "$WORKER_DIR" "$CONSUMER_DIR" "$VUE_DIR"; do
  if [[ ! -d "$DIR" ]]; then
    error "Directory not found: $DIR"
    exit 1
  fi
done
success "All project directories found"

# ---------------------------------------------------------------------------
# Configure custom domain (if provided)
# ---------------------------------------------------------------------------
if [[ -n "$DOMAIN" ]]; then
  header "Configuring Custom Domain: $DOMAIN"

  # Extract the zone name (root domain — last two parts)
  ZONE_NAME=$(echo "$DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')

  # --- Update INSTANCE_DOMAIN in siliconbeest-worker/wrangler.jsonc ---
  info "Updating INSTANCE_DOMAIN to: $DOMAIN"
  if [[ -f "$WORKER_DIR/wrangler.jsonc" ]]; then
    node -e "
const fs = require('fs');
let content = fs.readFileSync('$WORKER_DIR/wrangler.jsonc', 'utf8');
content = content.replace(/(\"INSTANCE_DOMAIN\":\s*\")[^\"]*(\")/, '\$1$DOMAIN\$2');
fs.writeFileSync('$WORKER_DIR/wrangler.jsonc', content);
"
    success "Updated siliconbeest-worker/wrangler.jsonc INSTANCE_DOMAIN"
  else
    error "siliconbeest-worker/wrangler.jsonc not found"
    exit 1
  fi

  # --- Add routes to siliconbeest-worker/wrangler.jsonc for API paths ---
  info "Setting API routes in siliconbeest-worker/wrangler.jsonc..."
  node -e "
const fs = require('fs');
let content = fs.readFileSync('$WORKER_DIR/wrangler.jsonc', 'utf8');

// Remove existing routes block (including any trailing comma issues)
content = content.replace(/,?\s*\"routes\"\s*:\s*\[[\s\S]*?\]\s*/g, '');

// Build the routes JSON
const routes = [
  { pattern: '$DOMAIN/api/*', zone_name: '$ZONE_NAME' },
  { pattern: '$DOMAIN/oauth/*', zone_name: '$ZONE_NAME' },
  { pattern: '$DOMAIN/.well-known/*', zone_name: '$ZONE_NAME' },
  { pattern: '$DOMAIN/users/*', zone_name: '$ZONE_NAME' },
  { pattern: '$DOMAIN/inbox', zone_name: '$ZONE_NAME' },
  { pattern: '$DOMAIN/nodeinfo/*', zone_name: '$ZONE_NAME' }
];
const routesJson = JSON.stringify(routes, null, 2).replace(/^/gm, '\t');

// Insert routes before the closing brace
const lastBrace = content.lastIndexOf('}');
const before = content.substring(0, lastBrace).trimEnd();
// Ensure there's a comma before routes
const needsComma = !before.endsWith(',');
const insertion = (needsComma ? ',' : '') + '\n\n\t// Workers Routes (API paths)\n\t\"routes\": ' + routesJson.trim() + '\n';
content = before + insertion + '}' + '\n';

fs.writeFileSync('$WORKER_DIR/wrangler.jsonc', content);
"
  success "Added API routes to siliconbeest-worker/wrangler.jsonc"

  # --- Add routes to siliconbeest-vue/wrangler.jsonc for catch-all ---
  info "Setting catch-all route in siliconbeest-vue/wrangler.jsonc..."
  node -e "
const fs = require('fs');
let content = fs.readFileSync('$VUE_DIR/wrangler.jsonc', 'utf8');

// Remove existing routes block
content = content.replace(/,?\s*\"routes\"\s*:\s*\[[\s\S]*?\]\s*/g, '');

// Build the catch-all route
const routes = [
  { pattern: '$DOMAIN/*', zone_name: '$ZONE_NAME' }
];
const routesJson = JSON.stringify(routes, null, 2).replace(/^/gm, '\t');

// Insert routes before the closing brace
const lastBrace = content.lastIndexOf('}');
const before = content.substring(0, lastBrace).trimEnd();
const needsComma = !before.endsWith(',');
const insertion = (needsComma ? ',' : '') + '\n\n\t// Workers Routes (catch-all for custom domain)\n\t\"routes\": ' + routesJson.trim() + '\n';
content = before + insertion + '}' + '\n';

fs.writeFileSync('$VUE_DIR/wrangler.jsonc', content);
"
  success "Added catch-all route to siliconbeest-vue/wrangler.jsonc"
fi

# ---------------------------------------------------------------------------
# Install dependencies
# ---------------------------------------------------------------------------
header "Installing Dependencies"

for DIR in "$WORKER_DIR" "$CONSUMER_DIR" "$VUE_DIR"; do
  DIRNAME=$(basename "$DIR")
  if [[ -f "$DIR/package.json" ]]; then
    info "Installing dependencies for $DIRNAME..."
    (cd "$DIR" && npm install --silent)
    success "$DIRNAME dependencies installed"
  fi
done

# ---------------------------------------------------------------------------
# Apply D1 migrations
# ---------------------------------------------------------------------------
if [[ "$SKIP_MIGRATIONS" == false ]]; then
  header "Applying D1 Migrations"

  # Read D1 database name from wrangler.jsonc (not hardcoded)
  DB_NAME=$(read_wrangler_json "$WORKER_DIR/wrangler.jsonc" "(config.d1_databases||[])[0]?.database_name")
  if [[ -z "$DB_NAME" ]]; then
    warn "Could not read D1 database name from wrangler.jsonc — skipping migrations"
  elif [[ "$DRY_RUN" == true ]]; then
    info "[DRY RUN] Would apply D1 migrations to: $DB_NAME"
  else
    info "Applying pending migrations to remote D1 ($DB_NAME)..."
    (cd "$WORKER_DIR" && wrangler d1 migrations apply "$DB_NAME" --remote)
    success "Migrations applied"
  fi
else
  info "Skipping migrations (--skip-migrations)"
fi

# ---------------------------------------------------------------------------
# Deploy siliconbeest-worker (API)
# ---------------------------------------------------------------------------
header "Deploying siliconbeest-worker"

if [[ "$DRY_RUN" == true ]]; then
  info "[DRY RUN] Would deploy siliconbeest-worker"
else
  info "Deploying API worker..."
  (cd "$WORKER_DIR" && wrangler deploy)
  success "siliconbeest-worker deployed"
fi

# ---------------------------------------------------------------------------
# Deploy siliconbeest-queue-consumer
# ---------------------------------------------------------------------------
header "Deploying siliconbeest-queue-consumer"

if [[ "$DRY_RUN" == true ]]; then
  info "[DRY RUN] Would deploy siliconbeest-queue-consumer"
else
  info "Deploying queue consumer worker..."
  (cd "$CONSUMER_DIR" && wrangler deploy)
  success "siliconbeest-queue-consumer deployed"
fi

# ---------------------------------------------------------------------------
# Deploy siliconbeest-vue (Frontend)
# ---------------------------------------------------------------------------
header "Deploying siliconbeest-vue"

if [[ "$DRY_RUN" == true ]]; then
  info "[DRY RUN] Would deploy siliconbeest-vue"
else
  info "Building and deploying frontend..."
  (cd "$VUE_DIR" && wrangler deploy)
  success "siliconbeest-vue deployed"
fi

# ---------------------------------------------------------------------------
# Print deployment info
# ---------------------------------------------------------------------------
header "Deployment Complete"

echo -e "${GREEN}${BOLD}All workers deployed successfully!${NC}"
echo
echo -e "  ${BOLD}Workers deployed:${NC}"
echo -e "    - siliconbeest-worker       (API + ActivityPub)"
echo -e "    - siliconbeest-queue-consumer (Federation queue processor)"
echo -e "    - siliconbeest-vue          (Frontend SPA)"
echo

# Extract domain from wrangler.jsonc
CONFIGURED_DOMAIN=$(node -e "
const fs = require('fs');
try {
  const content = fs.readFileSync('$WORKER_DIR/wrangler.jsonc', 'utf8');
  const cleaned = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const config = JSON.parse(cleaned);
  process.stdout.write(config.vars?.INSTANCE_DOMAIN || 'not configured');
} catch(e) { process.stdout.write('not configured'); }
" 2>/dev/null || echo "not configured")

echo -e "  ${BOLD}Instance domain:${NC} $CONFIGURED_DOMAIN"
echo

if [[ -n "$DOMAIN" ]]; then
  echo -e "  ${BOLD}Custom domain routes configured:${NC}"
  echo -e "    - ${DOMAIN}/api/*           -> siliconbeest-worker"
  echo -e "    - ${DOMAIN}/oauth/*         -> siliconbeest-worker"
  echo -e "    - ${DOMAIN}/.well-known/*   -> siliconbeest-worker"
  echo -e "    - ${DOMAIN}/users/*         -> siliconbeest-worker"
  echo -e "    - ${DOMAIN}/inbox           -> siliconbeest-worker"
  echo -e "    - ${DOMAIN}/nodeinfo/*      -> siliconbeest-worker"
  echo -e "    - ${DOMAIN}/*               -> siliconbeest-vue (catch-all)"
  echo
  echo -e "${YELLOW}Important:${NC}"
  echo "  - More specific routes (e.g. /api/*) take priority over the catch-all (/*)"
  echo "  - Make sure your DNS has a proxied (orange cloud) record for $DOMAIN"
  echo "  - If using a subdomain, add a CNAME or A record pointing to Cloudflare"
  echo
  echo -e "${YELLOW}Verify with:${NC}"
  echo "  curl https://$DOMAIN/.well-known/webfinger?resource=acct:admin@$DOMAIN"
else
  echo -e "  ${BOLD}Default worker URLs:${NC}"
  echo -e "    - API:      https://siliconbeest-worker.<your-subdomain>.workers.dev"
  echo -e "    - Consumer: https://siliconbeest-queue-consumer.<your-subdomain>.workers.dev"
  echo -e "    - Frontend: https://siliconbeest-vue.<your-subdomain>.workers.dev"
  echo
  echo -e "${YELLOW}To configure a custom domain, run:${NC}"
  echo -e "  ${BOLD}./scripts/deploy.sh --domain $CONFIGURED_DOMAIN${NC}"
fi
echo
