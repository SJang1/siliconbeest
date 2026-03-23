#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — Update Script
# Pulls latest code, installs dependencies, applies migrations, and redeploys.
# Designed for production update workflow.
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
SKIP_PULL=false
SKIP_TESTS=false
BRANCH="main"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-pull)    SKIP_PULL=true; shift ;;
    --skip-tests)   SKIP_TESTS=true; shift ;;
    --branch)       BRANCH="$2"; shift 2 ;;
    --branch=*)     BRANCH="${1#*=}"; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    -h|--help)
      echo "Usage: update.sh [OPTIONS]"
      echo
      echo "Pulls latest code, runs tests, applies migrations, and deploys."
      echo
      echo "Options:"
      echo "  --branch <name>   Git branch to pull (default: main)"
      echo "  --skip-pull       Skip git pull (use current working tree)"
      echo "  --skip-tests      Skip running tests before deploy"
      echo "  --dry-run         Run all checks without deploying"
      echo "  -h, --help        Show this help"
      exit 0
      ;;
    *) error "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Helper: read D1 database name from wrangler.jsonc
# ---------------------------------------------------------------------------
get_d1_name() {
  local DIR="$1"
  node -e "
const fs = require('fs');
const content = fs.readFileSync('$DIR/wrangler.jsonc', 'utf8');
const cleaned = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
try {
  const config = JSON.parse(cleaned);
  const db = (config.d1_databases || [])[0];
  process.stdout.write(db ? db.database_name : '');
} catch(e) { process.stdout.write(''); }
" 2>/dev/null
}

get_domain() {
  node -e "
const fs = require('fs');
const content = fs.readFileSync('$WORKER_DIR/wrangler.jsonc', 'utf8');
const cleaned = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
try {
  const config = JSON.parse(cleaned);
  process.stdout.write(config.vars?.INSTANCE_DOMAIN || 'unknown');
} catch(e) { process.stdout.write('unknown'); }
" 2>/dev/null
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
# Step 1: Git Pull
# ---------------------------------------------------------------------------
if [[ "$SKIP_PULL" == false ]]; then
  header "Step 1: Pulling Latest Code"

  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  info "Current branch: $CURRENT_BRANCH"

  if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
    info "Switching to branch: $BRANCH"
    git checkout "$BRANCH"
  fi

  BEFORE_HASH=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
  info "Current commit: $BEFORE_HASH"

  git pull origin "$BRANCH"

  AFTER_HASH=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
  if [[ "$BEFORE_HASH" == "$AFTER_HASH" ]]; then
    success "Already up to date ($AFTER_HASH)"
  else
    success "Updated: $BEFORE_HASH -> $AFTER_HASH"
    echo
    info "Changes pulled:"
    git log --oneline "$BEFORE_HASH..$AFTER_HASH" 2>/dev/null | head -20
  fi
else
  header "Step 1: Skipping git pull (--skip-pull)"
fi

# ---------------------------------------------------------------------------
# Step 2: Install / Update Dependencies
# ---------------------------------------------------------------------------
header "Step 2: Installing Dependencies"

for DIR in "$WORKER_DIR" "$CONSUMER_DIR" "$VUE_DIR"; do
  DIRNAME=$(basename "$DIR")
  if [[ -f "$DIR/package.json" ]]; then
    info "Installing dependencies for $DIRNAME..."
    (cd "$DIR" && npm install --silent)
    success "$DIRNAME"
  fi
done

# ---------------------------------------------------------------------------
# Step 3: Type Checking
# ---------------------------------------------------------------------------
header "Step 3: Type Checking"

info "Checking siliconbeest-worker..."
(cd "$WORKER_DIR" && npx -p typescript tsc --noEmit)
success "Worker: 0 errors"

info "Checking siliconbeest-vue..."
(cd "$VUE_DIR" && npx vue-tsc --noEmit)
success "Vue: 0 errors"

# ---------------------------------------------------------------------------
# Step 4: Run Tests
# ---------------------------------------------------------------------------
if [[ "$SKIP_TESTS" == false ]]; then
  header "Step 4: Running Tests"

  info "Running worker tests..."
  (cd "$WORKER_DIR" && npm test)
  success "Worker tests passed"

  info "Running Vue tests..."
  (cd "$VUE_DIR" && npm test)
  success "Vue tests passed"
else
  header "Step 4: Skipping tests (--skip-tests)"
fi

# ---------------------------------------------------------------------------
# Step 5: Apply D1 Migrations
# ---------------------------------------------------------------------------
header "Step 5: Database Migrations"

DB_NAME=$(get_d1_name "$WORKER_DIR")
if [[ -z "$DB_NAME" ]]; then
  warn "Could not read D1 database name from wrangler.jsonc — skipping migrations"
else
  info "D1 database: $DB_NAME"

  # Check for pending migrations
  MIGRATION_DIR="$WORKER_DIR/migrations"
  if [[ -d "$MIGRATION_DIR" ]]; then
    MIGRATION_COUNT=$(ls "$MIGRATION_DIR"/*.sql 2>/dev/null | wc -l | tr -d ' ')
    info "Found $MIGRATION_COUNT migration file(s)"

    if [[ "$DRY_RUN" == true ]]; then
      info "[DRY RUN] Would apply migrations to $DB_NAME"
    else
      info "Applying pending migrations..."
      (cd "$WORKER_DIR" && wrangler d1 migrations apply "$DB_NAME" --remote)
      success "Migrations applied"
    fi
  else
    info "No migrations directory found"
  fi
fi

# ---------------------------------------------------------------------------
# Step 6: Build Frontend
# ---------------------------------------------------------------------------
header "Step 6: Building Frontend"

info "Building Vue SPA..."
(cd "$VUE_DIR" && npx vite build)
success "Frontend built"

# ---------------------------------------------------------------------------
# Step 7: Deploy
# ---------------------------------------------------------------------------
header "Step 7: Deploying"

if [[ "$DRY_RUN" == true ]]; then
  info "[DRY RUN] Would deploy the following:"
  echo "  - siliconbeest-worker"
  echo "  - siliconbeest-queue-consumer"
  echo "  - siliconbeest-vue"
  echo
  info "Run without --dry-run to actually deploy."
else
  info "Deploying siliconbeest-worker..."
  (cd "$WORKER_DIR" && wrangler deploy)
  success "siliconbeest-worker deployed"

  info "Deploying siliconbeest-queue-consumer..."
  (cd "$CONSUMER_DIR" && wrangler deploy)
  success "siliconbeest-queue-consumer deployed"

  info "Deploying siliconbeest-vue..."
  (cd "$VUE_DIR" && wrangler deploy)
  success "siliconbeest-vue deployed"
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
