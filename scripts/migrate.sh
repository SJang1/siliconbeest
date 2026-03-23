#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — D1 Migration Script
# Applies pending D1 migrations to local or remote database.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WORKER_DIR="$PROJECT_ROOT/siliconbeest-worker"

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
TARGET="remote"   # default to remote
DRY_RUN=false

usage() {
  echo "Usage: migrate.sh [OPTIONS]"
  echo
  echo "Applies pending D1 migrations for SiliconBeest."
  echo
  echo "Options:"
  echo "  --local       Apply migrations to the local D1 database"
  echo "  --remote      Apply migrations to the remote (production) D1 database (default)"
  echo "  --dry-run     List pending migrations without applying them"
  echo "  -h, --help    Show this help"
  echo
  echo "Examples:"
  echo "  ./scripts/migrate.sh --remote"
  echo "  ./scripts/migrate.sh --local"
  echo "  ./scripts/migrate.sh --dry-run"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)    TARGET="local"; shift ;;
    --remote)   TARGET="remote"; shift ;;
    --dry-run)  DRY_RUN=true; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          error "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
header "D1 Migrations"

if ! command -v wrangler &>/dev/null; then
  error "wrangler CLI is not installed."
  exit 1
fi
success "wrangler found"

DB_NAME="siliconbeest-db"
MIGRATIONS_DIR="$WORKER_DIR/migrations"

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  error "Migrations directory not found: $MIGRATIONS_DIR"
  exit 1
fi

# ---------------------------------------------------------------------------
# List available migrations
# ---------------------------------------------------------------------------
info "Target: ${BOLD}$TARGET${NC}"
info "Database: $DB_NAME"
info "Migrations directory: $MIGRATIONS_DIR"
echo

info "Available migration files:"
for FILE in "$MIGRATIONS_DIR"/*.sql; do
  if [[ -f "$FILE" ]]; then
    echo -e "  ${CYAN}$(basename "$FILE")${NC}"
  fi
done
echo

# ---------------------------------------------------------------------------
# List pending migrations
# ---------------------------------------------------------------------------
info "Checking migration status..."

if [[ "$TARGET" == "remote" ]]; then
  MIGRATION_LIST=$(cd "$WORKER_DIR" && wrangler d1 migrations list "$DB_NAME" --remote 2>&1 || true)
else
  MIGRATION_LIST=$(cd "$WORKER_DIR" && wrangler d1 migrations list "$DB_NAME" --local 2>&1 || true)
fi

echo "$MIGRATION_LIST"
echo

# ---------------------------------------------------------------------------
# Apply migrations
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" == true ]]; then
  info "[DRY RUN] Would apply pending migrations to $TARGET D1 database."
  info "Run without --dry-run to apply."
  exit 0
fi

if [[ "$TARGET" == "remote" ]]; then
  header "Applying Migrations to Remote D1"
  warn "This will modify the PRODUCTION database."
  read -rp "Continue? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
    info "Migration cancelled."
    exit 0
  fi

  info "Applying migrations..."
  (cd "$WORKER_DIR" && wrangler d1 migrations apply "$DB_NAME" --remote)
  success "Remote migrations applied successfully"
else
  header "Applying Migrations to Local D1"

  info "Applying migrations..."
  (cd "$WORKER_DIR" && wrangler d1 migrations apply "$DB_NAME" --local)
  success "Local migrations applied successfully"
fi

echo
success "Migration complete for $TARGET database."
echo
