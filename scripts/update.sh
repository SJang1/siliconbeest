#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — Update Script
# Installs dependencies, applies migrations, and redeploys all 3 workers
# from local code. Designed for production update workflow.
#
# Architecture: unified worker deployed from siliconbeest/
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"
[[ -f "$SCRIPT_DIR/config.env" ]] && source "$SCRIPT_DIR/config.env"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
SKIP_TESTS=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests)   SKIP_TESTS=true; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    -h|--help)
      echo "Usage: update.sh [OPTIONS]"
      echo
      echo "Runs tests, applies migrations, and deploys from local code."
      echo
      echo "Options:"
      echo "  --skip-tests      Skip running tests before deploy"
      echo "  --dry-run         Run all checks without deploying"
      echo "  -h, --help        Show this help"
      exit 0
      ;;
    *) error "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
get_d1_name() {
  local DIR="$1"
  read_wrangler_json "$DIR/wrangler.jsonc" "(config.d1_databases||[])[0]?.database_name"
}

get_domain() {
  read_wrangler_json "$MAIN_DIR/wrangler.jsonc" "config.vars?.INSTANCE_DOMAIN"
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
header "Pre-flight Checks"

if ! command -v wrangler &>/dev/null; then
  error "wrangler CLI is not installed."
  exit 1
fi
success "wrangler found"

if ! wrangler whoami &>/dev/null; then
  error "Not logged in to Cloudflare. Run: wrangler login"
  exit 1
fi
success "Authenticated with Cloudflare"

CURRENT_DOMAIN=$(get_domain)
info "Instance domain: $CURRENT_DOMAIN"

# Check for uncommitted changes
cd "$PROJECT_ROOT"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  warn "You have uncommitted changes:"
  git status --short
  echo
  read -rp "Continue anyway? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
    info "Aborted."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Step 1: Install / Update Dependencies
# ---------------------------------------------------------------------------
header "Step 1: Installing Dependencies"

for DIR in "$MAIN_DIR" "$CONSUMER_DIR" "$EMAIL_DIR"; do
  DIRNAME=$(basename "$DIR")
  if [[ -f "$DIR/package.json" ]]; then
    info "Installing dependencies for $DIRNAME..."
    (cd "$DIR" && npm install --silent)
    success "$DIRNAME"
  fi
done

# ---------------------------------------------------------------------------
# Step 2: Type Checking
# ---------------------------------------------------------------------------
header "Step 2: Type Checking"

info "Checking $MAIN_WORKER_NAME (Vue + Worker)..."
(cd "$MAIN_DIR" && npx vue-tsc --noEmit)
success "$MAIN_WORKER_NAME: 0 errors"

info "Checking $CONSUMER_NAME..."
(cd "$CONSUMER_DIR" && npx -p typescript tsc --noEmit)
success "$CONSUMER_NAME: 0 errors"

info "Checking $EMAIL_SENDER_NAME..."
(cd "$EMAIL_DIR" && npx -p typescript tsc --noEmit)
success "$EMAIL_SENDER_NAME: 0 errors"

# ---------------------------------------------------------------------------
# Step 3: Run Tests
# ---------------------------------------------------------------------------
if [[ "$SKIP_TESTS" == false ]]; then
  header "Step 3: Running Tests"

  info "Running tests (worker + Vue)..."
  (cd "$MAIN_DIR" && npm test)
  success "All tests passed"
else
  header "Step 3: Skipping tests (--skip-tests)"
fi

# ---------------------------------------------------------------------------
# Step 4: Apply D1 Migrations
# ---------------------------------------------------------------------------
header "Step 4: Database Migrations"

DB_NAME=$(get_d1_name "$MAIN_DIR")
if [[ -z "$DB_NAME" ]]; then
  warn "Could not read D1 database name from wrangler.jsonc — skipping migrations"
else
  info "D1 database: $DB_NAME"

  # Check for pending migrations
  MIGRATION_DIR="$MAIN_DIR/migrations"
  if [[ -d "$MIGRATION_DIR" ]]; then
    MIGRATION_COUNT=$(ls "$MIGRATION_DIR"/*.sql 2>/dev/null | wc -l | tr -d ' ')
    info "Found $MIGRATION_COUNT migration file(s)"

    if [[ "$DRY_RUN" == true ]]; then
      info "[DRY RUN] Would apply migrations to $DB_NAME"
    else
      info "Applying pending migrations..."
      (cd "$MAIN_DIR" && wrangler d1 migrations apply "$DB_NAME" --remote)
      success "Migrations applied"
    fi
  else
    info "No migrations directory found"
  fi
fi

# ---------------------------------------------------------------------------
# Step 5: Deploy
# ---------------------------------------------------------------------------
header "Step 5: Deploying"

if [[ "$DRY_RUN" == true ]]; then
  info "[DRY RUN] Would deploy the following:"
  echo "  - $MAIN_WORKER_NAME (build + deploy from siliconbeest)"
  echo "  - $CONSUMER_NAME"
  echo "  - $EMAIL_SENDER_NAME"
  echo
  info "Run without --dry-run to actually deploy."
else
  info "Building and deploying $MAIN_WORKER_NAME..."
  (cd "$MAIN_DIR" && npm run build && wrangler deploy)
  success "$MAIN_WORKER_NAME deployed"

  info "Deploying $CONSUMER_NAME..."
  (cd "$CONSUMER_DIR" && wrangler deploy)
  success "$CONSUMER_NAME deployed"

  info "Deploying $EMAIL_SENDER_NAME..."
  (cd "$EMAIL_DIR" && wrangler deploy)
  success "$EMAIL_SENDER_NAME deployed"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
header "Update Complete"

echo -e "${GREEN}${BOLD}SiliconBeest has been updated successfully!${NC}"
echo
echo -e "  ${BOLD}Domain:${NC}  $CURRENT_DOMAIN"
echo -e "  ${BOLD}Branch:${NC}  $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
echo -e "  ${BOLD}Commit:${NC}  $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo
echo -e "${YELLOW}Verify:${NC}"
echo "  curl https://$CURRENT_DOMAIN/api/v2/instance"
echo "  curl https://$CURRENT_DOMAIN/.well-known/nodeinfo"
echo
