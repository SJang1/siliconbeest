#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — Seed Admin User
# Creates the initial admin user in the D1 database.
# Generates an RSA keypair for ActivityPub federation.
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
# Collect arguments or prompt
# ---------------------------------------------------------------------------
ADMIN_EMAIL="${1:-}"
ADMIN_USERNAME="${2:-}"
ADMIN_PASSWORD="${3:-}"

if [[ -z "$ADMIN_EMAIL" ]]; then
  read -rp "$(echo -e "${CYAN}Admin email:${NC} ")" ADMIN_EMAIL
fi
if [[ -z "$ADMIN_USERNAME" ]]; then
  read -rp "$(echo -e "${CYAN}Admin username:${NC} ")" ADMIN_USERNAME
fi
if [[ -z "$ADMIN_PASSWORD" ]]; then
  read -rsp "$(echo -e "${CYAN}Admin password:${NC} ")" ADMIN_PASSWORD
  echo
fi

if [[ -z "$ADMIN_EMAIL" || -z "$ADMIN_USERNAME" || -z "$ADMIN_PASSWORD" ]]; then
  error "All fields are required: email, username, password"
  echo "Usage: seed-admin.sh [email] [username] [password]"
  exit 1
fi

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
if ! command -v node &>/dev/null; then
  error "Node.js is required."
  exit 1
fi

if ! command -v wrangler &>/dev/null; then
  error "wrangler CLI is required."
  exit 1
fi

# ---------------------------------------------------------------------------
# Read INSTANCE_DOMAIN from wrangler.jsonc
# ---------------------------------------------------------------------------
INSTANCE_DOMAIN=$(node -e "
const fs = require('fs');
try {
  const content = fs.readFileSync('$WORKER_DIR/wrangler.jsonc', 'utf8');
  const cleaned = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const config = JSON.parse(cleaned);
  process.stdout.write(config.vars?.INSTANCE_DOMAIN || '');
} catch(e) { process.stderr.write(e.message); }
")

if [[ -z "$INSTANCE_DOMAIN" ]]; then
  error "Could not read INSTANCE_DOMAIN from wrangler.jsonc"
  exit 1
fi

info "Instance domain: $INSTANCE_DOMAIN"

# ---------------------------------------------------------------------------
# Generate IDs, hash password, create RSA keypair
# ---------------------------------------------------------------------------
header "Generating Admin User Data"

SEED_DATA=$(node -e "
const crypto = require('crypto');

// Simple ULID-like ID generator (timestamp + random)
function generateId() {
  const time = Date.now().toString(36).padStart(10, '0');
  const rand = crypto.randomBytes(10).toString('hex').slice(0, 16);
  return time + rand;
}

// bcrypt-compatible hash using scrypt as fallback for environments without bcrypt
// We use a simple approach: generate a hash that the app can verify
async function hashPassword(password) {
  // Use Node.js built-in scrypt wrapped in a bcrypt-like format
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      // Store as \\\$scrypt\\\$ prefix so the app knows the algorithm
      const hash = '\$scrypt\$' + salt.toString('hex') + '\$' + derivedKey.toString('hex');
      resolve(hash);
    });
  });
}

async function main() {
  const accountId = generateId();
  const userId    = generateId();
  const keyId     = generateId();
  const now       = new Date().toISOString();
  const domain    = '$INSTANCE_DOMAIN';
  const username  = '$ADMIN_USERNAME';
  const email     = '$ADMIN_EMAIL';
  const password  = '$ADMIN_PASSWORD';

  const actorUri  = 'https://' + domain + '/users/' + username;
  const actorUrl  = 'https://' + domain + '/@' + username;

  // Hash password
  const passwordHash = await hashPassword(password);

  // Generate RSA-2048 keypair for ActivityPub
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const keyIdUri = actorUri + '#main-key';

  const result = {
    accountId, userId, keyId, now,
    domain, username, email,
    passwordHash,
    actorUri, actorUrl,
    publicKey, privateKey,
    keyIdUri
  };

  process.stdout.write(JSON.stringify(result));
}

main().catch(e => { console.error(e); process.exit(1); });
")

info "Data generated. Inserting into D1..."

# ---------------------------------------------------------------------------
# Extract fields from JSON
# ---------------------------------------------------------------------------
get_field() {
  echo "$SEED_DATA" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))['$1'] || '')"
}

ACCOUNT_ID=$(get_field accountId)
USER_ID=$(get_field userId)
KEY_ID=$(get_field keyId)
NOW=$(get_field now)
ACTOR_URI=$(get_field actorUri)
ACTOR_URL=$(get_field actorUrl)
PASSWORD_HASH=$(get_field passwordHash)
PUBLIC_KEY=$(get_field publicKey)
PRIVATE_KEY=$(get_field privateKey)
KEY_ID_URI=$(get_field keyIdUri)

# ---------------------------------------------------------------------------
# Insert into D1
# ---------------------------------------------------------------------------
header "Inserting Admin User into D1"

DB_NAME="siliconbeest-db"

# Insert account
info "Creating account..."
wrangler d1 execute "$DB_NAME" --remote --command \
  "INSERT OR IGNORE INTO accounts (id, username, domain, display_name, note, uri, url, locked, bot, discoverable, created_at, updated_at) VALUES ('$ACCOUNT_ID', '$ADMIN_USERNAME', NULL, '$ADMIN_USERNAME', '', '$ACTOR_URI', '$ACTOR_URL', 0, 0, 1, '$NOW', '$NOW');"

success "Account created: $ACCOUNT_ID"

# Insert user
info "Creating user with admin role..."
wrangler d1 execute "$DB_NAME" --remote --command \
  "INSERT OR IGNORE INTO users (id, account_id, email, encrypted_password, role, approved, confirmed_at, created_at, updated_at) VALUES ('$USER_ID', '$ACCOUNT_ID', '$ADMIN_EMAIL', '$PASSWORD_HASH', 'admin', 1, '$NOW', '$NOW', '$NOW');"

success "User created: $USER_ID (role=admin)"

# Insert actor key — use a temp file for the PEM keys since they contain newlines
info "Creating RSA keypair for federation..."
PUBKEY_ESCAPED=$(echo "$PUBLIC_KEY" | sed "s/'/''/g")
PRIVKEY_ESCAPED=$(echo "$PRIVATE_KEY" | sed "s/'/''/g")

# Write SQL to temp file to handle multiline PEM keys
TEMP_SQL=$(mktemp)
cat > "$TEMP_SQL" << EOSQL
INSERT OR IGNORE INTO actor_keys (id, account_id, public_key, private_key, key_id, created_at)
VALUES ('$KEY_ID', '$ACCOUNT_ID', '$PUBKEY_ESCAPED', '$PRIVKEY_ESCAPED', '$KEY_ID_URI', '$NOW');
EOSQL

wrangler d1 execute "$DB_NAME" --remote --file "$TEMP_SQL"
rm -f "$TEMP_SQL"

success "Actor key created: $KEY_ID"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
header "Admin User Created"

echo -e "${GREEN}${BOLD}Admin user seeded successfully!${NC}"
echo
echo -e "  ${BOLD}Username:${NC}    $ADMIN_USERNAME"
echo -e "  ${BOLD}Email:${NC}       $ADMIN_EMAIL"
echo -e "  ${BOLD}Role:${NC}        admin"
echo -e "  ${BOLD}Actor URI:${NC}   $ACTOR_URI"
echo -e "  ${BOLD}Account ID:${NC}  $ACCOUNT_ID"
echo -e "  ${BOLD}User ID:${NC}     $USER_ID"
echo
