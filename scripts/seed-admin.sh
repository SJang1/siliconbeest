#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — Seed Admin User
# Creates the initial admin user in the D1 database.
# Generates an RSA keypair for ActivityPub federation.
#
# Uses siliconbeest-vue/wrangler.jsonc for configuration.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"
[[ -f "$SCRIPT_DIR/config.env" ]] && source "$SCRIPT_DIR/config.env"

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
INSTANCE_DOMAIN=$(read_wrangler_json "$MAIN_DIR/wrangler.jsonc" "config.vars?.INSTANCE_DOMAIN")

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

// PBKDF2 hash matching the Workers runtime format
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

DB_NAME="$D1_DATABASE_NAME"

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
