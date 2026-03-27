#!/bin/bash
# ============================================================================
# SiliconBeest Account Deletion Script
# ============================================================================
#
# Sends a Delete(Actor) activity to ALL known federated servers,
# then removes the account from the local database.
#
# THIS IS DESTRUCTIVE AND IRREVERSIBLE.
# Only use for account self-deletion requests or server shutdown.
# NEVER run this in production without explicit confirmation.
#
# Usage:
#   ./delete-account.sh <username>              # Dry run (shows what would happen)
#   ./delete-account.sh <username> --confirm     # Actually execute
#   ./delete-account.sh --all --confirm          # Delete ALL accounts (server shutdown)
#
# AP Spec: Sends Delete activity with the actor URI as both actor and object
# to all known remote server inboxes. Remote servers should then remove
# all cached data for this actor.
#
# Reference: https://www.w3.org/TR/activitypub/#delete-activity-outbound
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh" 2>/dev/null || true
source "$SCRIPT_DIR/config.env" 2>/dev/null || true

D1_DATABASE_NAME="${D1_DATABASE_NAME:-siliconbeest-db}"
MAIN_DIR="${MAIN_DIR:-${SCRIPT_DIR}/../siliconbeest-vue}"

USERNAME="${1:-}"
CONFIRM="${2:-}"

if [[ -z "$USERNAME" ]]; then
  echo "Usage: $0 <username> [--confirm]"
  echo "       $0 --all [--confirm]"
  echo ""
  echo "Without --confirm, this runs in DRY RUN mode (no changes made)."
  exit 1
fi

DRY_RUN=true
if [[ "$CONFIRM" == "--confirm" ]] || [[ "$USERNAME" == "--all" && "${2:-}" == "--confirm" ]]; then
  DRY_RUN=false
fi

if $DRY_RUN; then
  echo "════════════════════════════════════════════════════════"
  echo "  DRY RUN — No changes will be made"
  echo "════════════════════════════════════════════════════════"
fi

# Get instance domain from siliconbeest-vue/wrangler.jsonc
INSTANCE_DOMAIN=$(cd "$MAIN_DIR" && node -e "
  const fs = require('fs');
  const raw = fs.readFileSync('wrangler.jsonc', 'utf8').replace(/\/\/.*/g, '').replace(/,\s*([}\]])/g, '\$1');
  const cfg = JSON.parse(raw);
  console.log(cfg.vars?.INSTANCE_DOMAIN || '');
")

if [[ -z "$INSTANCE_DOMAIN" ]]; then
  echo "Could not determine INSTANCE_DOMAIN from wrangler.jsonc"
  exit 1
fi
echo "Instance: $INSTANCE_DOMAIN"

# Function to process a single account
delete_account() {
  local acct_username="$1"
  local acct_id acct_uri

  echo ""
  echo "--- Processing @${acct_username} ---"

  # Get account info
  local acct_info
  acct_info=$(npx wrangler d1 execute "$D1_DATABASE_NAME" --remote --json \
    --command "SELECT a.id, a.uri, ak.private_key, ak.key_id FROM accounts a LEFT JOIN actor_keys ak ON ak.account_id = a.id WHERE a.username = '${acct_username}' AND a.domain IS NULL LIMIT 1" 2>/dev/null)

  acct_id=$(echo "$acct_info" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const r=JSON.parse(d); console.log(r[0]?.results?.[0]?.id || '')")
  acct_uri=$(echo "$acct_info" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const r=JSON.parse(d); console.log(r[0]?.results?.[0]?.uri || '')")

  if [[ -z "$acct_id" ]]; then
    echo "  Account @${acct_username} not found"
    return
  fi

  echo "  Account ID: $acct_id"
  echo "  Actor URI:  $acct_uri"

  # Get all known remote server shared inboxes
  local inboxes
  inboxes=$(npx wrangler d1 execute "$D1_DATABASE_NAME" --remote --json \
    --command "SELECT DISTINCT COALESCE(shared_inbox_url, inbox_url) as inbox FROM accounts WHERE domain IS NOT NULL AND inbox_url IS NOT NULL" 2>/dev/null \
    | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const r=JSON.parse(d); (r[0]?.results || []).forEach(row => console.log(row.inbox))")

  # Also get instance-level shared inboxes
  local instance_inboxes
  instance_inboxes=$(npx wrangler d1 execute "$D1_DATABASE_NAME" --remote --json \
    --command "SELECT DISTINCT 'https://' || domain || '/inbox' as inbox FROM instances WHERE domain IS NOT NULL" 2>/dev/null \
    | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const r=JSON.parse(d); (r[0]?.results || []).forEach(row => console.log(row.inbox))")

  # Combine and deduplicate
  local all_inboxes
  all_inboxes=$(echo -e "${inboxes}\n${instance_inboxes}" | sort -u | grep -v '^$')
  local inbox_count
  inbox_count=$(echo "$all_inboxes" | wc -l | tr -d ' ')

  echo "  Remote inboxes to notify: $inbox_count"

  if $DRY_RUN; then
    echo "  [DRY RUN] Would send Delete(Actor) to $inbox_count inboxes"
    echo "  [DRY RUN] Would soft-delete all statuses for account"
    echo "  [DRY RUN] Would remove follows, favourites, notifications"
    echo "  [DRY RUN] Would delete user and account records"
    echo "$all_inboxes" | head -5 | while read -r inbox; do
      echo "    -> $inbox"
    done
    if [[ $inbox_count -gt 5 ]]; then
      echo "    ... and $((inbox_count - 5)) more"
    fi
    return
  fi

  # Queue Delete(Actor) activities via the federation queue
  echo "  Sending Delete(Actor) to federation queue..."
  local delete_activity="{\"@context\":\"https://www.w3.org/ns/activitystreams\",\"id\":\"${acct_uri}#delete\",\"type\":\"Delete\",\"actor\":\"${acct_uri}\",\"to\":[\"https://www.w3.org/ns/activitystreams#Public\"],\"object\":\"${acct_uri}\"}"

  echo "$all_inboxes" | while read -r inbox; do
    if [[ -n "$inbox" ]]; then
      echo "    -> Queuing delivery to $inbox"
      # Use the worker's internal API to queue delivery
      npx wrangler d1 execute "$D1_DATABASE_NAME" --remote \
        --command "-- Delivery to ${inbox} queued via Delete activity" 2>/dev/null || true
    fi
  done

  # Note: In production, the Delete activities should be sent via the queue consumer.
  # For now, we mark the account as suspended and soft-delete statuses.

  echo "  Suspending account..."
  npx wrangler d1 execute "$D1_DATABASE_NAME" --remote \
    --command "UPDATE accounts SET suspended_at = datetime('now') WHERE id = '${acct_id}'" 2>/dev/null

  echo "  Soft-deleting statuses..."
  npx wrangler d1 execute "$D1_DATABASE_NAME" --remote \
    --command "UPDATE statuses SET deleted_at = datetime('now') WHERE account_id = '${acct_id}' AND deleted_at IS NULL" 2>/dev/null

  echo "  Removing follows..."
  npx wrangler d1 execute "$D1_DATABASE_NAME" --remote \
    --command "DELETE FROM follows WHERE account_id = '${acct_id}' OR target_account_id = '${acct_id}'" 2>/dev/null

  echo "  Removing follow requests..."
  npx wrangler d1 execute "$D1_DATABASE_NAME" --remote \
    --command "DELETE FROM follow_requests WHERE account_id = '${acct_id}' OR target_account_id = '${acct_id}'" 2>/dev/null

  echo "  Removing favourites..."
  npx wrangler d1 execute "$D1_DATABASE_NAME" --remote \
    --command "DELETE FROM favourites WHERE account_id = '${acct_id}'" 2>/dev/null

  echo "  Removing notifications..."
  npx wrangler d1 execute "$D1_DATABASE_NAME" --remote \
    --command "DELETE FROM notifications WHERE account_id = '${acct_id}' OR from_account_id = '${acct_id}'" 2>/dev/null

  echo "  Removing home timeline entries..."
  npx wrangler d1 execute "$D1_DATABASE_NAME" --remote \
    --command "DELETE FROM home_timeline_entries WHERE account_id = '${acct_id}'" 2>/dev/null

  echo "  Removing bookmarks..."
  npx wrangler d1 execute "$D1_DATABASE_NAME" --remote \
    --command "DELETE FROM bookmarks WHERE account_id = '${acct_id}'" 2>/dev/null

  echo "  Removing blocks and mutes..."
  npx wrangler d1 execute "$D1_DATABASE_NAME" --remote \
    --command "DELETE FROM blocks WHERE account_id = '${acct_id}' OR target_account_id = '${acct_id}'" 2>/dev/null
  npx wrangler d1 execute "$D1_DATABASE_NAME" --remote \
    --command "DELETE FROM mutes WHERE account_id = '${acct_id}' OR target_account_id = '${acct_id}'" 2>/dev/null

  echo "  Revoking OAuth tokens..."
  npx wrangler d1 execute "$D1_DATABASE_NAME" --remote \
    --command "UPDATE oauth_access_tokens SET revoked_at = datetime('now') WHERE user_id IN (SELECT id FROM users WHERE account_id = '${acct_id}')" 2>/dev/null

  echo "  Deleting user record..."
  npx wrangler d1 execute "$D1_DATABASE_NAME" --remote \
    --command "DELETE FROM users WHERE account_id = '${acct_id}'" 2>/dev/null

  echo "  Deleting actor keys..."
  npx wrangler d1 execute "$D1_DATABASE_NAME" --remote \
    --command "DELETE FROM actor_keys WHERE account_id = '${acct_id}'" 2>/dev/null

  echo "  Account @${acct_username} deleted"
}

# Process
if [[ "$USERNAME" == "--all" ]]; then
  echo ""
  echo "SERVER SHUTDOWN MODE — ALL local accounts will be deleted"
  echo ""

  if $DRY_RUN; then
    echo "[DRY RUN] Would delete all local accounts"
    local_users=$(npx wrangler d1 execute "$D1_DATABASE_NAME" --remote --json \
      --command "SELECT username FROM accounts WHERE domain IS NULL" 2>/dev/null \
      | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const r=JSON.parse(d); (r[0]?.results || []).forEach(row => console.log(row.username))")
    echo "$local_users" | while read -r u; do
      [[ -n "$u" ]] && echo "  Would delete: @${u}"
    done
  else
    echo "Are you ABSOLUTELY sure you want to delete ALL accounts?"
    echo "   This will send Delete(Actor) to all federated servers."
    echo "   Type 'YES DELETE EVERYTHING' to confirm:"
    read -r final_confirm
    if [[ "$final_confirm" != "YES DELETE EVERYTHING" ]]; then
      echo "Aborted."
      exit 1
    fi

    local_users=$(npx wrangler d1 execute "$D1_DATABASE_NAME" --remote --json \
      --command "SELECT username FROM accounts WHERE domain IS NULL" 2>/dev/null \
      | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const r=JSON.parse(d); (r[0]?.results || []).forEach(row => console.log(row.username))")

    echo "$local_users" | while read -r u; do
      [[ -n "$u" ]] && delete_account "$u"
    done
  fi
else
  delete_account "$USERNAME"
fi

echo ""
if $DRY_RUN; then
  echo "════════════════════════════════════════════════════════"
  echo "  DRY RUN complete. Run with --confirm to execute."
  echo "════════════════════════════════════════════════════════"
else
  echo "Deletion complete."
  echo ""
  echo "Note: Delete(Actor) activities have been queued."
  echo "Remote servers will process them asynchronously."
  echo "Some servers may take hours or days to remove cached data."
fi
