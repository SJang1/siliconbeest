#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — Deploy Script
# Builds and deploys all 3 workers to Cloudflare.
# The unified worker (Vue + API) deploys from siliconbeest/.
# Optionally configures custom domain routes.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"
[[ -f "$SCRIPT_DIR/config.env" ]] && source "$SCRIPT_DIR/config.env"

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
for DIR in "$MAIN_DIR" "$CONSUMER_DIR" "$EMAIL_DIR"; do
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

  # --- Update INSTANCE_DOMAIN in wrangler.jsonc ---
  info "Updating INSTANCE_DOMAIN to: $DOMAIN"
  if [[ -f "$MAIN_DIR/wrangler.jsonc" ]]; then
    node -e "
const fs = require('fs');
let content = fs.readFileSync('$MAIN_DIR/wrangler.jsonc', 'utf8');
content = content.replace(/(\"INSTANCE_DOMAIN\":\s*\")[^\"]*(\")/, '\$1$DOMAIN\$2');
fs.writeFileSync('$MAIN_DIR/wrangler.jsonc', content);
"
    success "Updated wrangler.jsonc INSTANCE_DOMAIN"
  else
    error "siliconbeest/wrangler.jsonc not found"
    exit 1
  fi

  # --- Update custom_domain route pattern ---
  info "Setting custom domain route in wrangler.jsonc..."
  node -e "
const fs = require('fs');
let content = fs.readFileSync('$MAIN_DIR/wrangler.jsonc', 'utf8');
content = content.replace(/(\"pattern\":\s*\")[^\"]*(\")/, '\$1$DOMAIN\$2');
fs.writeFileSync('$MAIN_DIR/wrangler.jsonc', content);
"
  success "Updated custom domain route"
fi

# ---------------------------------------------------------------------------
# Install dependencies
# ---------------------------------------------------------------------------
header "Installing Dependencies"

for DIR in "$MAIN_DIR" "$CONSUMER_DIR" "$EMAIL_DIR"; do
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

  # Read D1 database name from wrangler.jsonc
  DB_NAME=$(read_wrangler_json "$MAIN_DIR/wrangler.jsonc" "(config.d1_databases||[])[0]?.database_name")
  if [[ -z "$DB_NAME" ]]; then
    warn "Could not read D1 database name from wrangler.jsonc — skipping migrations"
  elif [[ "$DRY_RUN" == true ]]; then
    info "[DRY RUN] Would apply D1 migrations to: $DB_NAME"
  else
    info "Applying pending migrations to remote D1 ($DB_NAME)..."
    (cd "$MAIN_DIR" && wrangler d1 migrations apply "$DB_NAME" --remote)
    success "Migrations applied"
  fi
else
  info "Skipping migrations (--skip-migrations)"
fi

# ---------------------------------------------------------------------------
# Deploy $MAIN_WORKER_NAME (unified Vue + API worker)
# ---------------------------------------------------------------------------
header "Deploying $MAIN_WORKER_NAME"

if [[ "$DRY_RUN" == true ]]; then
  info "[DRY RUN] Would build and deploy $MAIN_WORKER_NAME"
else
  info "Building Vue frontend and deploying unified worker..."
  (cd "$MAIN_DIR" && npm run build && wrangler deploy)
  success "$MAIN_WORKER_NAME deployed"
fi

# ---------------------------------------------------------------------------
# Deploy $CONSUMER_NAME
# ---------------------------------------------------------------------------
header "Deploying $CONSUMER_NAME"

if [[ "$DRY_RUN" == true ]]; then
  info "[DRY RUN] Would deploy $CONSUMER_NAME"
else
  info "Deploying queue consumer worker..."
  (cd "$CONSUMER_DIR" && wrangler deploy)
  success "$CONSUMER_NAME deployed"
fi

# ---------------------------------------------------------------------------
# Deploy $EMAIL_SENDER_NAME (Email sender)
# ---------------------------------------------------------------------------
header "Deploying $EMAIL_SENDER_NAME"

if [[ "$DRY_RUN" == true ]]; then
  info "[DRY RUN] Would deploy $EMAIL_SENDER_NAME"
else
  info "Deploying email sender worker..."
  (cd "$EMAIL_DIR" && wrangler deploy)
  success "$EMAIL_SENDER_NAME deployed"
fi

# ---------------------------------------------------------------------------
# Print deployment info
# ---------------------------------------------------------------------------
header "Deployment Complete"

echo -e "${GREEN}${BOLD}All workers deployed successfully!${NC}"
echo
echo -e "  ${BOLD}Workers deployed:${NC}"
echo -e "    - $MAIN_WORKER_NAME     (Unified Vue + API + ActivityPub)"
echo -e "    - $CONSUMER_NAME (Federation queue processor)"
echo -e "    - $EMAIL_SENDER_NAME (Email queue consumer)"
echo

# Extract domain from wrangler.jsonc
CONFIGURED_DOMAIN=$(node -e "
const fs = require('fs');
try {
  const content = fs.readFileSync('$MAIN_DIR/wrangler.jsonc', 'utf8');
  const cleaned = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const config = JSON.parse(cleaned);
  process.stdout.write(config.vars?.INSTANCE_DOMAIN || 'not configured');
} catch(e) { process.stdout.write('not configured'); }
" 2>/dev/null || echo "not configured")

echo -e "  ${BOLD}Instance domain:${NC} $CONFIGURED_DOMAIN"
echo

if [[ -n "$DOMAIN" ]]; then
  echo -e "  ${BOLD}Custom domain configured:${NC} $DOMAIN"
  echo -e "    All routes handled by unified worker $MAIN_WORKER_NAME"
  echo
  echo -e "${YELLOW}Important:${NC}"
  echo "  - Make sure your DNS has a proxied (orange cloud) record for $DOMAIN"
  echo "  - If using a subdomain, add a CNAME or A record pointing to Cloudflare"
  echo
  echo -e "${YELLOW}Verify with:${NC}"
  echo "  curl https://$DOMAIN/.well-known/webfinger?resource=acct:admin@$DOMAIN"
else
  echo -e "  ${BOLD}Default worker URL:${NC}"
  echo -e "    - Main:     https://$MAIN_WORKER_NAME.<your-subdomain>.workers.dev"
  echo -e "    - Consumer: https://$CONSUMER_NAME.<your-subdomain>.workers.dev"
  echo
  echo -e "${YELLOW}To configure a custom domain, run:${NC}"
  echo -e "  ${BOLD}./scripts/deploy.sh --domain $CONFIGURED_DOMAIN${NC}"
fi
echo
