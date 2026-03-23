#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — Backup Script
# Exports D1 database and lists R2 objects.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$PROJECT_ROOT/backups"

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
SKIP_R2=false
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir|-o) OUTPUT_DIR="$2"; shift 2 ;;
    --skip-r2)       SKIP_R2=true; shift ;;
    -h|--help)
      echo "Usage: backup.sh [OPTIONS]"
      echo
      echo "Options:"
      echo "  -o, --output-dir DIR   Directory for backup files (default: ./backups)"
      echo "  --skip-r2              Skip R2 bucket listing"
      echo "  -h, --help             Show this help"
      exit 0
      ;;
    *) error "Unknown option: $1"; exit 1 ;;
  esac
done

BACKUP_DIR="${OUTPUT_DIR:-$BACKUP_DIR}"

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
# Create backup directory
# ---------------------------------------------------------------------------
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_SUBDIR="$BACKUP_DIR/$TIMESTAMP"
mkdir -p "$BACKUP_SUBDIR"
info "Backup directory: $BACKUP_SUBDIR"

# ---------------------------------------------------------------------------
# Export D1 Database
# ---------------------------------------------------------------------------
header "Backing Up D1 Database"

DB_NAME="siliconbeest-db"
DB_BACKUP_FILE="$BACKUP_SUBDIR/d1_${DB_NAME}_${TIMESTAMP}.sql"

info "Exporting D1 database: $DB_NAME"

# Export each table's data
TABLES=(
  accounts users actor_keys statuses media_attachments polls poll_votes
  follows follow_requests favourites blocks mutes bookmarks
  notifications mentions tags status_tags tag_follows
  oauth_applications oauth_access_tokens oauth_authorization_codes
  lists list_accounts instances domain_blocks domain_allows
  web_push_subscriptions reports account_warnings ip_blocks email_domain_blocks
  home_timeline_entries markers user_preferences filters filter_keywords filter_statuses
  settings custom_emojis announcements rules
  conversations conversation_accounts
)

echo "-- SiliconBeest D1 Database Backup" > "$DB_BACKUP_FILE"
echo "-- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$DB_BACKUP_FILE"
echo "-- Database: $DB_NAME" >> "$DB_BACKUP_FILE"
echo "" >> "$DB_BACKUP_FILE"

for TABLE in "${TABLES[@]}"; do
  info "  Exporting table: $TABLE"
  RESULT=$(wrangler d1 execute "$DB_NAME" --remote --command "SELECT * FROM $TABLE;" --json 2>/dev/null || echo "[]")

  # Write table data as JSON (for later import)
  echo "-- Table: $TABLE" >> "$DB_BACKUP_FILE"
  echo "-- Data (JSON): $RESULT" >> "$DB_BACKUP_FILE"
  echo "" >> "$DB_BACKUP_FILE"
done

success "D1 database exported to: $DB_BACKUP_FILE"

# Also get row counts for summary
info "Gathering table statistics..."
STATS_FILE="$BACKUP_SUBDIR/d1_stats_${TIMESTAMP}.txt"
echo "SiliconBeest D1 Database Statistics" > "$STATS_FILE"
echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$STATS_FILE"
echo "---" >> "$STATS_FILE"

for TABLE in "${TABLES[@]}"; do
  COUNT=$(wrangler d1 execute "$DB_NAME" --remote --command "SELECT COUNT(*) as count FROM $TABLE;" --json 2>/dev/null | node -e "
    try {
      const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const results = Array.isArray(data) ? data[0]?.results : data?.results;
      process.stdout.write(String(results?.[0]?.count ?? '?'));
    } catch(e) { process.stdout.write('?'); }
  " 2>/dev/null || echo "?")
  echo "  $TABLE: $COUNT rows" >> "$STATS_FILE"
done

success "Statistics saved to: $STATS_FILE"

# ---------------------------------------------------------------------------
# List R2 Objects
# ---------------------------------------------------------------------------
if [[ "$SKIP_R2" == false ]]; then
  header "Listing R2 Objects"

  BUCKET_NAME="siliconbeest-media"
  R2_LIST_FILE="$BACKUP_SUBDIR/r2_objects_${TIMESTAMP}.txt"

  info "Listing objects in R2 bucket: $BUCKET_NAME"
  wrangler r2 object list "$BUCKET_NAME" 2>/dev/null > "$R2_LIST_FILE" || \
    warn "Could not list R2 objects. The bucket may be empty or inaccessible."

  if [[ -s "$R2_LIST_FILE" ]]; then
    OBJECT_COUNT=$(wc -l < "$R2_LIST_FILE" | tr -d ' ')
    success "R2 object listing saved ($OBJECT_COUNT entries): $R2_LIST_FILE"
  else
    info "R2 bucket appears empty or listing returned no results."
  fi
else
  info "Skipping R2 listing (--skip-r2)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
header "Backup Complete"

echo -e "${GREEN}${BOLD}Backup completed successfully!${NC}"
echo
echo -e "  ${BOLD}Backup directory:${NC}  $BACKUP_SUBDIR"
echo -e "  ${BOLD}Files:${NC}"

for FILE in "$BACKUP_SUBDIR"/*; do
  if [[ -f "$FILE" ]]; then
    SIZE=$(du -h "$FILE" | cut -f1)
    echo -e "    $(basename "$FILE")  ($SIZE)"
  fi
done

echo
echo -e "${YELLOW}Note:${NC} R2 objects are listed but not downloaded."
echo "  To download specific R2 objects, use:"
echo "  wrangler r2 object get siliconbeest-media <key> --file <local-path>"
echo
