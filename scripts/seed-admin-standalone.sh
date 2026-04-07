#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — Standalone Admin Seeding Script
#
# Creates the initial admin user in a remote D1 database.
# Does NOT require the repository to be cloned — only needs wrangler + node.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/SJang1/siliconbeest/main/scripts/seed-admin-standalone.sh | bash
#   # or
#   bash <(curl -fsSL https://raw.githubusercontent.com/SJang1/siliconbeest/main/scripts/seed-admin-standalone.sh)
# =============================================================================

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
# Prerequisites
# ---------------------------------------------------------------------------
header "Checking Prerequisites"

if ! command -v node &>/dev/null; then
  error "Node.js is required but not installed."
  exit 1
fi
success "Node.js found ($(node -v))"

if ! command -v wrangler &>/dev/null; then
  # Try npx fallback
  if command -v npx &>/dev/null; then
    warn "wrangler not found globally, will use 'npx wrangler'"
    wrangler() { npx wrangler "$@"; }
  else
    error "wrangler CLI is not installed. Install with: npm i -g wrangler"
    exit 1
  fi
fi
success "wrangler found"

info "Checking Cloudflare authentication..."
if ! wrangler whoami &>/dev/null; then
  error "Not logged in to Cloudflare. Run: wrangler login"
  exit 1
fi
success "Authenticated with Cloudflare"

# ---------------------------------------------------------------------------
# Collect configuration
# ---------------------------------------------------------------------------
header "Instance Configuration"

read -rp "$(echo -e "${CYAN}D1 database name${NC}: ")" DB_NAME
if [[ -z "$DB_NAME" ]]; then
  error "D1 database name is required."
  exit 1
fi

read -rp "$(echo -e "${CYAN}Instance domain${NC} (e.g. social.example.com): ")" INSTANCE_DOMAIN
if [[ -z "$INSTANCE_DOMAIN" ]]; then
  error "Instance domain is required."
  exit 1
fi

read -rp "$(echo -e "${CYAN}Admin email${NC}: ")" ADMIN_EMAIL
if [[ -z "$ADMIN_EMAIL" ]]; then
  error "Admin email is required."
  exit 1
fi

read -rp "$(echo -e "${CYAN}Admin username${NC}: ")" ADMIN_USERNAME
if [[ -z "$ADMIN_USERNAME" ]]; then
  error "Admin username is required."
  exit 1
fi

read -rsp "$(echo -e "${CYAN}Admin password${NC}: ")" ADMIN_PASSWORD
echo
if [[ -z "$ADMIN_PASSWORD" ]]; then
  error "Admin password is required."
  exit 1
fi

echo
info "D1 Database:       $DB_NAME"
info "Domain:            $INSTANCE_DOMAIN"
info "Admin email:       $ADMIN_EMAIL"
info "Admin username:    $ADMIN_USERNAME"
echo
read -rp "Proceed? [Y/n] " CONFIRM
if [[ "$CONFIRM" =~ ^[Nn] ]]; then
  info "Cancelled."
  exit 0
fi

# ---------------------------------------------------------------------------
# Generate IDs, hash password, create RSA + Ed25519 keypairs
# ---------------------------------------------------------------------------
header "Generating Admin User Data"

SEED_DATA=$(node -e "
const crypto = require('crypto');

function generateId() {
  const time = Date.now().toString(36).padStart(10, '0');
  const rand = crypto.randomBytes(10).toString('hex').slice(0, 16);
  return time + rand;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 100000, 32, 'sha256', (err, derivedKey) => {
      if (err) reject(err);
      const hash = 'pbkdf2:' + salt.toString('hex') + ':' + derivedKey.toString('hex');
      resolve(hash);
    });
  });
}

async function main() {
  const accountId = generateId();
  const userId    = generateId();
  const keyId     = generateId();
  const now       = new Date().toISOString();
  const domain    = process.env.INSTANCE_DOMAIN;
  const username  = process.env.ADMIN_USERNAME;
  const email     = process.env.ADMIN_EMAIL;
  const password  = process.env.ADMIN_PASSWORD;

  const actorUri  = 'https://' + domain + '/users/' + username;
  const actorUrl  = 'https://' + domain + '/@' + username;

  const passwordHash = await hashPassword(password);

  // RSA-2048 keypair for ActivityPub
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  // Ed25519 keypair
  const ed = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const keyIdUri = actorUri + '#main-key';

  process.stdout.write(JSON.stringify({
    accountId, userId, keyId, now,
    domain, username, email,
    passwordHash,
    actorUri, actorUrl,
    publicKey, privateKey,
    ed25519PublicKey: ed.publicKey,
    ed25519PrivateKey: ed.privateKey,
    keyIdUri
  }));
}

main().catch(e => { console.error(e); process.exit(1); });
")

success "Data generated"

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
ED25519_PUBLIC_KEY=$(get_field ed25519PublicKey)
ED25519_PRIVATE_KEY=$(get_field ed25519PrivateKey)
KEY_ID_URI=$(get_field keyIdUri)

# ---------------------------------------------------------------------------
# Insert into D1
# ---------------------------------------------------------------------------
header "Inserting Admin User into D1"

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

# Insert actor keys — use temp file for multiline PEM keys
info "Creating keypairs for federation..."
PUBKEY_ESCAPED=$(echo "$PUBLIC_KEY" | sed "s/'/''/g")
PRIVKEY_ESCAPED=$(echo "$PRIVATE_KEY" | sed "s/'/''/g")
ED25519_PUB_ESCAPED=$(echo "$ED25519_PUBLIC_KEY" | sed "s/'/''/g")
ED25519_PRIV_ESCAPED=$(echo "$ED25519_PRIVATE_KEY" | sed "s/'/''/g")

TEMP_SQL=$(mktemp)
cat > "$TEMP_SQL" << EOSQL
INSERT OR IGNORE INTO actor_keys (id, account_id, public_key, private_key, ed25519_public_key, ed25519_private_key, key_id, created_at)
VALUES ('$KEY_ID', '$ACCOUNT_ID', '$PUBKEY_ESCAPED', '$PRIVKEY_ESCAPED', '$ED25519_PUB_ESCAPED', '$ED25519_PRIV_ESCAPED', '$KEY_ID_URI', '$NOW');
EOSQL

wrangler d1 execute "$DB_NAME" --remote --file "$TEMP_SQL"
rm -f "$TEMP_SQL"
success "Actor keys created: $KEY_ID"

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
echo -e "${YELLOW}You can now log in at:${NC} https://$INSTANCE_DOMAIN/login"
echo
