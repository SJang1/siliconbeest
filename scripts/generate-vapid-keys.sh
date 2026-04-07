#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — VAPID Key Generator
# Generates ECDSA P-256 key pair for Web Push notifications.
# Outputs base64url-encoded private (32 bytes) and public (65 bytes) keys.
#
# In the unified architecture, VAPID keys are stored in the D1 database
# (settings table), NOT as wrangler env secrets.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"
[[ -f "$SCRIPT_DIR/config.env" ]] && source "$SCRIPT_DIR/config.env"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
STORE_IN_DB=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --store-in-db) STORE_IN_DB=true; shift ;;
    -h|--help)
      echo "Usage: generate-vapid-keys.sh [OPTIONS]"
      echo
      echo "Generates an ECDSA P-256 key pair suitable for VAPID (Web Push)."
      echo
      echo "Options:"
      echo "  --store-in-db   Store the keys in the D1 settings table"
      echo "  -h, --help      Show this help"
      exit 0
      ;;
    *) error "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
if ! command -v node &>/dev/null; then
  error "Node.js is required but not installed."
  exit 1
fi

# ---------------------------------------------------------------------------
# Generate VAPID keys
# ---------------------------------------------------------------------------
header "Generating VAPID Key Pair"

info "Algorithm: ECDSA P-256"
info "Private key: 32 bytes (base64url-encoded)"
info "Public key:  65 bytes uncompressed (base64url-encoded)"
echo

VAPID_OUTPUT=$(node -e "
const crypto = require('crypto');

// Generate ECDSA P-256 key pair
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'P-256'
});

// Export to DER format
const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
const pubDer  = publicKey.export({ type: 'spki', format: 'der' });

// Extract raw key bytes
// PKCS8 DER for P-256: the last 32 bytes are the raw private key
const privRaw = privDer.slice(-32);
// SPKI DER for P-256: the last 65 bytes are the uncompressed public key (0x04 || x || y)
const pubRaw  = pubDer.slice(-65);

// base64url encode (no padding)
const b64url = (buf) =>
  buf.toString('base64')
     .replace(/\+/g, '-')
     .replace(/\//g, '_')
     .replace(/=+$/, '');

const result = {
  privateKey: b64url(privRaw),
  publicKey:  b64url(pubRaw)
};

console.log(JSON.stringify(result));
")

VAPID_PRIVATE_KEY=$(echo "$VAPID_OUTPUT" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).privateKey)")
VAPID_PUBLIC_KEY=$(echo "$VAPID_OUTPUT"  | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).publicKey)")

echo -e "${BOLD}VAPID Private Key:${NC}"
echo "  $VAPID_PRIVATE_KEY"
echo
echo -e "${BOLD}VAPID Public Key:${NC}"
echo "  $VAPID_PUBLIC_KEY"
echo

success "Keys generated successfully"

# ---------------------------------------------------------------------------
# Optionally store in D1 database
# ---------------------------------------------------------------------------
if [[ "$STORE_IN_DB" == true ]]; then
  header "Storing VAPID Keys in D1 Database"

  if ! command -v wrangler &>/dev/null; then
    error "wrangler CLI not found. Install with: pnpm add -g wrangler"
    exit 1
  fi

  DB_NAME="$D1_DATABASE_NAME"

  info "Storing VAPID keys in D1 settings table ($DB_NAME)..."
  wrangler d1 execute "$DB_NAME" --remote --command \
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('vapid_private_key', '$VAPID_PRIVATE_KEY', datetime('now')), ('vapid_public_key', '$VAPID_PUBLIC_KEY', datetime('now'));"
  success "VAPID keys stored in DB"

  echo
  success "Keys stored in D1 settings table"
fi

echo
echo -e "${YELLOW}To store these keys in the database manually:${NC}"
echo "  wrangler d1 execute $D1_DATABASE_NAME --remote --command \\"
echo "    \"INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('vapid_private_key', '$VAPID_PRIVATE_KEY', datetime('now')), ('vapid_public_key', '$VAPID_PUBLIC_KEY', datetime('now'));\""
echo
echo -e "${YELLOW}NOTE:${NC} VAPID keys are stored in the D1 database (not env secrets)."
echo "  Rotating keys invalidates all existing Web Push subscriptions."
echo
