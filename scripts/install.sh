#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — One-Command Installer
#
# Creates all Cloudflare resources, applies migrations, generates keys,
# seeds admin user, and outputs GitHub Variables/Secrets for CI deployment.
#
# Usage:
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/SJang1/siliconbeest/HEAD/scripts/install.sh)"
# =============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
header()  { echo -e "\n${BOLD}${CYAN}=== $* ===${NC}\n"; }

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║       SiliconBeest Installer             ║${NC}"
echo -e "${BOLD}║   Serverless Fediverse on CF Workers     ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
header "Checking Prerequisites"

if ! command -v git &>/dev/null; then
  error "git is required."
  exit 1
fi
success "git found"

if ! command -v node &>/dev/null; then
  error "Node.js >= 20 is required. Install from: https://nodejs.org/"
  exit 1
fi
success "Node.js found ($(node -v))"

# Use npx wrangler so no global install is needed
WRANGLER="npx wrangler@latest"

info "Checking Cloudflare authentication..."
if ! $WRANGLER whoami 2>/dev/null | grep -q "Account ID"; then
  warn "Not logged in to Cloudflare."
  info "Opening browser for authentication..."
  $WRANGLER login
fi
success "Authenticated with Cloudflare"

# ---------------------------------------------------------------------------
# Collect configuration
# ---------------------------------------------------------------------------
header "Instance Configuration"

read -rp "$(echo -e "${CYAN}Project prefix${NC} [siliconbeest]: ")" PROJECT_PREFIX
PROJECT_PREFIX="${PROJECT_PREFIX:-siliconbeest}"

read -rp "$(echo -e "${CYAN}Instance domain${NC} (e.g. social.example.com): ")" INSTANCE_DOMAIN
if [[ -z "$INSTANCE_DOMAIN" ]]; then
  error "Domain is required."
  exit 1
fi

read -rp "$(echo -e "${CYAN}Instance title${NC} [SiliconBeest]: ")" INSTANCE_TITLE
INSTANCE_TITLE="${INSTANCE_TITLE:-SiliconBeest}"

echo -e "${CYAN}Registration mode${NC}:"
echo "  1) open       — anyone can register"
echo "  2) approval   — registrations require admin approval"
echo "  3) closed     — registrations are disabled"
read -rp "Choose [1]: " REG_CHOICE
case "$REG_CHOICE" in
  2) REGISTRATION_MODE="approval" ;;
  3) REGISTRATION_MODE="closed" ;;
  *)  REGISTRATION_MODE="open" ;;
esac

# Admin credentials
header "Admin Account"

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

# Derive resource names
D1_DATABASE_NAME="${PROJECT_PREFIX}-db"
R2_BUCKET_NAME="${PROJECT_PREFIX}-media"
MAIN_WORKER_NAME="${PROJECT_PREFIX}"
QUEUE_FEDERATION="${PROJECT_PREFIX}-federation"
QUEUE_INTERNAL="${PROJECT_PREFIX}-internal"
QUEUE_EMAIL="${PROJECT_PREFIX}-email"
QUEUE_DLQ="${PROJECT_PREFIX}-federation-dlq"

echo
info "Domain:         $INSTANCE_DOMAIN"
info "Title:          $INSTANCE_TITLE"
info "Registration:   $REGISTRATION_MODE"
info "Prefix:         $PROJECT_PREFIX"
info "Admin:          $ADMIN_USERNAME ($ADMIN_EMAIL)"
echo
read -rp "Proceed? [Y/n] " CONFIRM
if [[ "$CONFIRM" =~ ^[Nn] ]]; then
  info "Cancelled."
  exit 0
fi

# ---------------------------------------------------------------------------
# Create Cloudflare resources
# ---------------------------------------------------------------------------
header "Creating Cloudflare Resources"

# --- D1 Database ---
info "Creating D1 database: $D1_DATABASE_NAME"
DB_OUTPUT=$($WRANGLER d1 create "$D1_DATABASE_NAME" 2>&1 || true)
DB_ID=$(echo "$DB_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
if [[ -n "$DB_ID" ]]; then
  success "D1: $D1_DATABASE_NAME → $DB_ID"
else
  warn "D1 database may already exist. Check Cloudflare dashboard for the ID."
fi

# --- R2 Bucket ---
info "Creating R2 bucket: $R2_BUCKET_NAME"
$WRANGLER r2 bucket create "$R2_BUCKET_NAME" 2>/dev/null || warn "R2 bucket '$R2_BUCKET_NAME' may already exist."
success "R2 bucket: $R2_BUCKET_NAME"

# --- KV Namespaces ---
create_kv() {
  local TITLE="$1"
  info "Creating KV namespace: $TITLE"
  local OUTPUT
  OUTPUT=$($WRANGLER kv namespace create "$TITLE" 2>&1 || true)
  local KV_ID
  KV_ID=$(echo "$OUTPUT" | grep -oE '[0-9a-f]{32}' | head -1)
  if [[ -n "$KV_ID" ]]; then
    success "KV $TITLE: $KV_ID"
  else
    warn "KV '$TITLE' may already exist. Check dashboard."
  fi
  echo "$KV_ID"
}

KV_CACHE_ID=$(create_kv "CACHE")
KV_SESSIONS_ID=$(create_kv "SESSIONS")
KV_FEDIFY_ID=$(create_kv "FEDIFY_KV")

# --- Queues ---
create_queue() {
  local NAME="$1"
  info "Creating queue: $NAME"
  $WRANGLER queues create "$NAME" 2>/dev/null || warn "Queue '$NAME' may already exist."
}

create_queue "$QUEUE_FEDERATION"
create_queue "$QUEUE_INTERNAL"
create_queue "$QUEUE_EMAIL"
create_queue "$QUEUE_DLQ"
success "All queues created"

# ---------------------------------------------------------------------------
# Generate cryptographic keys
# ---------------------------------------------------------------------------
header "Generating Cryptographic Keys"

info "Generating VAPID key pair (ECDSA P-256)..."
VAPID_KEYS=$(node -e "
const crypto = require('crypto');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const privJwk = privateKey.export({ type: 'pkcs8', format: 'der' });
const pubJwk  = publicKey.export({ type: 'spki', format: 'der' });
const privRaw = privJwk.slice(-32);
const pubRaw  = pubJwk.slice(-65);
const b64url = (buf) => buf.toString('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+\$/, '');
console.log(JSON.stringify({ private: b64url(privRaw), public: b64url(pubRaw) }));
")
VAPID_PRIVATE_KEY=$(echo "$VAPID_KEYS" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).private)")
VAPID_PUBLIC_KEY=$(echo "$VAPID_KEYS"  | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).public)")
success "VAPID keys generated"

info "Generating OTP encryption key..."
OTP_ENCRYPTION_KEY=$(openssl rand -hex 32)
success "OTP encryption key generated"

# ---------------------------------------------------------------------------
# Clone repo temporarily for migrations & admin seeding
# ---------------------------------------------------------------------------
header "Applying Database Migrations & Seeding Admin"

TEMP_DIR=$(mktemp -d)
info "Cloning SiliconBeest to temp directory..."
git clone --depth 1 https://github.com/SJang1/siliconbeest.git "$TEMP_DIR" 2>/dev/null
success "Cloned to $TEMP_DIR"

# Patch wrangler.jsonc with actual DB ID for migrations
if [[ -n "$DB_ID" ]]; then
  sed -i.bak "s|YOUR_D1_DATABASE_ID|$DB_ID|g" "$TEMP_DIR/siliconbeest/wrangler.jsonc"
  sed -i.bak "s|social.example.com|$INSTANCE_DOMAIN|g" "$TEMP_DIR/siliconbeest/wrangler.jsonc"
  rm -f "$TEMP_DIR/siliconbeest/wrangler.jsonc.bak"
fi

# Apply migrations
info "Applying D1 migrations..."
cd "$TEMP_DIR/siliconbeest"
$WRANGLER d1 migrations apply "$D1_DATABASE_NAME" --remote
success "Migrations applied"

# Store VAPID keys in D1
info "Storing VAPID keys in database..."
$WRANGLER d1 execute "$D1_DATABASE_NAME" --remote --command \
  "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('vapid_private_key', '$VAPID_PRIVATE_KEY', datetime('now')), ('vapid_public_key', '$VAPID_PUBLIC_KEY', datetime('now'));"
success "VAPID keys stored"

# Set OTP encryption key as wrangler secret
info "Setting OTP encryption key as worker secret..."
echo "$OTP_ENCRYPTION_KEY" | $WRANGLER secret put "OTP_ENCRYPTION_KEY" --name "$MAIN_WORKER_NAME" 2>/dev/null || warn "Could not set secret (worker may not be deployed yet). Set manually later."

# Seed admin user
info "Creating admin account..."
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
      resolve('pbkdf2:' + salt.toString('hex') + ':' + derivedKey.toString('hex'));
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
  const actorUri  = 'https://' + domain + '/users/' + username;
  const actorUrl  = 'https://' + domain + '/@' + username;
  const passwordHash = await hashPassword('$ADMIN_PASSWORD');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const ed = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  process.stdout.write(JSON.stringify({
    accountId, userId, keyId, now, actorUri, actorUrl, passwordHash,
    publicKey, privateKey,
    ed25519PublicKey: ed.publicKey, ed25519PrivateKey: ed.privateKey,
    keyIdUri: actorUri + '#main-key'
  }));
}
main().catch(e => { console.error(e); process.exit(1); });
")

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

# Insert account
$WRANGLER d1 execute "$D1_DATABASE_NAME" --remote --command \
  "INSERT OR IGNORE INTO accounts (id, username, domain, display_name, note, uri, url, locked, bot, discoverable, created_at, updated_at) VALUES ('$ACCOUNT_ID', '$ADMIN_USERNAME', NULL, '$ADMIN_USERNAME', '', '$ACTOR_URI', '$ACTOR_URL', 0, 0, 1, '$NOW', '$NOW');"

# Insert user
$WRANGLER d1 execute "$D1_DATABASE_NAME" --remote --command \
  "INSERT OR IGNORE INTO users (id, account_id, email, encrypted_password, role, approved, confirmed_at, created_at, updated_at) VALUES ('$USER_ID', '$ACCOUNT_ID', '$ADMIN_EMAIL', '$PASSWORD_HASH', 'admin', 1, '$NOW', '$NOW', '$NOW');"

# Insert actor keys
PUBKEY_ESCAPED=$(echo "$PUBLIC_KEY" | sed "s/'/''/g")
PRIVKEY_ESCAPED=$(echo "$PRIVATE_KEY" | sed "s/'/''/g")
ED25519_PUB_ESCAPED=$(echo "$ED25519_PUBLIC_KEY" | sed "s/'/''/g")
ED25519_PRIV_ESCAPED=$(echo "$ED25519_PRIVATE_KEY" | sed "s/'/''/g")

TEMP_SQL=$(mktemp)
cat > "$TEMP_SQL" << EOSQL
INSERT OR IGNORE INTO actor_keys (id, account_id, public_key, private_key, ed25519_public_key, ed25519_private_key, key_id, created_at)
VALUES ('$KEY_ID', '$ACCOUNT_ID', '$PUBKEY_ESCAPED', '$PRIVKEY_ESCAPED', '$ED25519_PUB_ESCAPED', '$ED25519_PRIV_ESCAPED', '$KEY_ID_URI', '$NOW');
EOSQL

$WRANGLER d1 execute "$D1_DATABASE_NAME" --remote --file "$TEMP_SQL"
rm -f "$TEMP_SQL"

success "Admin user created: $ADMIN_USERNAME ($ADMIN_EMAIL)"

# Cleanup temp clone
cd /
rm -rf "$TEMP_DIR"

# ---------------------------------------------------------------------------
# Output — copy these to GitHub
# ---------------------------------------------------------------------------
header "Setup Complete"

echo -e "${GREEN}${BOLD}All Cloudflare resources created and configured!${NC}"
echo
echo -e "${BOLD}Admin Account:${NC}"
echo "  Username:    $ADMIN_USERNAME"
echo "  Email:       $ADMIN_EMAIL"
echo "  Actor URI:   https://$INSTANCE_DOMAIN/users/$ADMIN_USERNAME"
echo
echo -e "${BOLD}Copy these to your GitHub repository:${NC}"
echo -e "${BOLD}Settings > Secrets and variables > Actions${NC}"
echo
echo -e "${YELLOW}── Secrets ──${NC}"
echo
echo "┌─────────────────────────────────────────────────────────────"
echo "│ CLOUDFLARE_API_TOKEN    <your API token>"
echo "│ CLOUDFLARE_ACCOUNT_ID   <your account ID>"
echo "└─────────────────────────────────────────────────────────────"
echo
echo -e "${YELLOW}── Repository Variables ──${NC}"
echo
echo "┌─────────────────────────────────────────────────────────────"
echo "│ PROJECT_PREFIX          $PROJECT_PREFIX"
echo "│ INSTANCE_DOMAIN         $INSTANCE_DOMAIN"
echo "│ INSTANCE_TITLE          $INSTANCE_TITLE"
echo "│ REGISTRATION_MODE       $REGISTRATION_MODE"
echo "│ D1_DATABASE_ID          ${DB_ID:-<check dashboard>}"
echo "│ KV_CACHE_ID             ${KV_CACHE_ID:-<check dashboard>}"
echo "│ KV_SESSIONS_ID          ${KV_SESSIONS_ID:-<check dashboard>}"
echo "│ KV_FEDIFY_ID            ${KV_FEDIFY_ID:-<check dashboard>}"
echo "└─────────────────────────────────────────────────────────────"
echo
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Set the secrets and variables above in your GitHub repository"
echo "  2. Go to Actions > Deploy > Run workflow"
echo "  3. Configure Cloudflare WAF Skip rule for ActivityPub (see docs)"
echo
