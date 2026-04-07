#!/usr/bin/env bash
set -e

# =============================================================================
# SiliconBeest — Interactive Setup Script
# Creates all Cloudflare resources, sets secrets, applies migrations, and seeds
# an initial admin user.
#
# Architecture: unified worker deployed from siliconbeest/
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"
[[ -f "$SCRIPT_DIR/config.env" ]] && source "$SCRIPT_DIR/config.env"

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
header "Checking prerequisites"

if ! command -v wrangler &>/dev/null; then
  error "wrangler CLI is not installed. Install with: pnpm add -g wrangler"
  exit 1
fi
success "wrangler found"

if ! command -v node &>/dev/null; then
  error "Node.js is required but not installed."
  exit 1
fi
success "Node.js found ($(node -v))"

# Check wrangler auth
if ! wrangler whoami &>/dev/null; then
  error "Not logged in to Cloudflare. Run: wrangler login"
  exit 1
fi
success "Authenticated with Cloudflare"

# ---------------------------------------------------------------------------
# Collect configuration
# ---------------------------------------------------------------------------
header "Instance Configuration"

read -rp "$(echo -e "${CYAN}Project prefix${NC} [${PROJECT_PREFIX}]: ")" USER_PREFIX
if [[ -n "$USER_PREFIX" ]]; then
  export PROJECT_PREFIX="$USER_PREFIX"
  # Re-source config.sh to recompute all derived names with the new prefix
  source "$SCRIPT_DIR/config.sh"
  [[ -f "$SCRIPT_DIR/config.env" ]] && source "$SCRIPT_DIR/config.env"
fi
info "Using prefix: $PROJECT_PREFIX"

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
echo -e "${CYAN}Sentry DSN${NC} (optional — for error tracking, leave blank to skip):"
read -rp "  DSN: " SENTRY_DSN

echo
info "Domain:            $INSTANCE_DOMAIN"
info "Title:             $INSTANCE_TITLE"
info "Registration:      $REGISTRATION_MODE"
info "Admin email:       $ADMIN_EMAIL"
info "Admin username:    $ADMIN_USERNAME"
info "Sentry:            ${SENTRY_DSN:-disabled}"
echo
read -rp "Proceed with setup? [Y/n] " CONFIRM
if [[ "$CONFIRM" =~ ^[Nn] ]]; then
  info "Setup cancelled."
  exit 0
fi

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
// Extract raw 32-byte private key (last 32 bytes of PKCS8 DER for P-256)
const privRaw = privJwk.slice(-32);
// Extract raw 65-byte public key (last 65 bytes of SPKI DER for P-256 uncompressed)
const pubRaw  = pubJwk.slice(-65);
const b64url = (buf) => buf.toString('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+\$/, '');
console.log(JSON.stringify({ private: b64url(privRaw), public: b64url(pubRaw) }));
")
VAPID_PRIVATE_KEY=$(echo "$VAPID_KEYS" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).private)")
VAPID_PUBLIC_KEY=$(echo "$VAPID_KEYS"  | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).public)")
success "VAPID keys generated"

info "Generating OTP encryption key (32-byte hex)..."
OTP_ENCRYPTION_KEY=$(openssl rand -hex 32)
success "OTP encryption key generated"

# ---------------------------------------------------------------------------
# Create Cloudflare resources
# ---------------------------------------------------------------------------
header "Creating Cloudflare Resources"

# --- D1 Database ---
DB_NAME="$D1_DATABASE_NAME"
info "Creating D1 database: $DB_NAME"
DB_OUTPUT=$(wrangler d1 create "$DB_NAME" 2>&1 || true)
if echo "$DB_OUTPUT" | grep -q "already exists"; then
  warn "D1 database '$DB_NAME' already exists, skipping creation."
  DB_ID=$(echo "$DB_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
else
  DB_ID=$(echo "$DB_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  success "D1 database created: $DB_ID"
fi

if [[ -z "$DB_ID" ]]; then
  error "Could not determine D1 database ID. Check output:"
  echo "$DB_OUTPUT"
  exit 1
fi

# --- R2 Bucket ---
BUCKET_NAME="$R2_BUCKET_NAME"
info "Creating R2 bucket: $BUCKET_NAME"
R2_OUTPUT=$(wrangler r2 bucket create "$BUCKET_NAME" 2>&1 || true)
if echo "$R2_OUTPUT" | grep -qi "already exists"; then
  warn "R2 bucket '$BUCKET_NAME' already exists, skipping."
else
  success "R2 bucket created: $BUCKET_NAME"
fi

# --- KV Namespaces ---
create_kv_namespace() {
  local TITLE="$1"
  info "Creating KV namespace: $TITLE"
  local KV_OUTPUT
  KV_OUTPUT=$(wrangler kv namespace create "$TITLE" 2>&1 || true)
  if echo "$KV_OUTPUT" | grep -qi "already exists"; then
    warn "KV namespace '$TITLE' may already exist."
  fi
  local KV_ID
  KV_ID=$(echo "$KV_OUTPUT" | grep -oE '[0-9a-f]{32}' | head -1)
  if [[ -z "$KV_ID" ]]; then
    KV_ID=$(echo "$KV_OUTPUT" | grep -oE '"id":\s*"[^"]*"' | head -1 | grep -oE '[0-9a-f]{32}')
  fi
  echo "$KV_ID"
}

CACHE_KV_ID=$(create_kv_namespace "CACHE")
if [[ -n "$CACHE_KV_ID" ]]; then
  success "KV CACHE created: $CACHE_KV_ID"
else
  warn "Could not determine CACHE KV ID. You may need to update wrangler.jsonc manually."
fi

SESSIONS_KV_ID=$(create_kv_namespace "SESSIONS")
if [[ -n "$SESSIONS_KV_ID" ]]; then
  success "KV SESSIONS created: $SESSIONS_KV_ID"
else
  warn "Could not determine SESSIONS KV ID. You may need to update wrangler.jsonc manually."
fi

FEDIFY_KV_ID=$(create_kv_namespace "FEDIFY_KV")
if [[ -n "$FEDIFY_KV_ID" ]]; then
  success "KV FEDIFY_KV created: $FEDIFY_KV_ID"
else
  warn "Could not determine FEDIFY_KV ID. You may need to update wrangler.jsonc manually."
fi

# --- Queues ---
create_queue() {
  local QUEUE_NAME="$1"
  info "Creating queue: $QUEUE_NAME"
  local Q_OUTPUT
  Q_OUTPUT=$(wrangler queues create "$QUEUE_NAME" 2>&1 || true)
  if echo "$Q_OUTPUT" | grep -qi "already exists"; then
    warn "Queue '$QUEUE_NAME' already exists, skipping."
  else
    success "Queue created: $QUEUE_NAME"
  fi
}

create_queue "$QUEUE_FEDERATION"
create_queue "$QUEUE_INTERNAL"
create_queue "$QUEUE_EMAIL"
create_queue "$QUEUE_DLQ"

# ---------------------------------------------------------------------------
# Update wrangler.jsonc files with resource IDs
# ---------------------------------------------------------------------------
header "Updating wrangler.jsonc Configuration Files"

# Update D1 database_id in unified worker wrangler.jsonc
if [[ -n "$DB_ID" ]]; then
  info "Updating D1 database_id in wrangler.jsonc files..."
  for DIR in "$MAIN_DIR" "$CONSUMER_DIR" "$EMAIL_DIR"; do
    if [[ -f "$DIR/wrangler.jsonc" ]]; then
      sed -i.bak "s|\"database_id\":.*|\"database_id\": \"$DB_ID\"|g" "$DIR/wrangler.jsonc"
      rm -f "$DIR/wrangler.jsonc.bak"
    fi
  done
  success "D1 database_id updated"
fi

# Update KV namespace IDs in unified worker wrangler.jsonc
if [[ -n "$CACHE_KV_ID" ]]; then
  info "Updating CACHE KV ID..."
  for DIR in "$MAIN_DIR" "$CONSUMER_DIR"; do
    if [[ -f "$DIR/wrangler.jsonc" ]]; then
      node -e "
const fs = require('fs');
let content = fs.readFileSync('$DIR/wrangler.jsonc', 'utf8');
content = content.replace(/(\"binding\":\s*\"CACHE\",[\s\S]*?\"id\":\s*\")[^\"]*(\")/, '\$1$CACHE_KV_ID\$2');
fs.writeFileSync('$DIR/wrangler.jsonc', content);
"
    fi
  done
  success "CACHE KV ID updated"
fi

if [[ -n "$SESSIONS_KV_ID" ]]; then
  info "Updating SESSIONS KV ID..."
  if [[ -f "$MAIN_DIR/wrangler.jsonc" ]]; then
    node -e "
const fs = require('fs');
let content = fs.readFileSync('$MAIN_DIR/wrangler.jsonc', 'utf8');
content = content.replace(/(\"binding\":\s*\"SESSIONS\",[\s\S]*?\"id\":\s*\")[^\"]*(\")/, '\$1$SESSIONS_KV_ID\$2');
fs.writeFileSync('$MAIN_DIR/wrangler.jsonc', content);
"
  fi
  success "SESSIONS KV ID updated"
fi

if [[ -n "$FEDIFY_KV_ID" ]]; then
  info "Updating FEDIFY_KV ID..."
  for DIR in "$MAIN_DIR" "$CONSUMER_DIR"; do
    if [[ -f "$DIR/wrangler.jsonc" ]]; then
      node -e "
const fs = require('fs');
let content = fs.readFileSync('$DIR/wrangler.jsonc', 'utf8');
content = content.replace(/(\"binding\":\s*\"FEDIFY_KV\",[\s\S]*?\"id\":\s*\")[^\"]*(\")/, '\$1$FEDIFY_KV_ID\$2');
fs.writeFileSync('$DIR/wrangler.jsonc', content);
"
    fi
  done
  success "FEDIFY_KV ID updated"
fi

# Update instance vars in unified worker wrangler.jsonc
info "Updating instance variables..."
for DIR in "$MAIN_DIR" "$CONSUMER_DIR"; do
  if [[ -f "$DIR/wrangler.jsonc" ]]; then
    node -e "
const fs = require('fs');
let content = fs.readFileSync('$DIR/wrangler.jsonc', 'utf8');
content = content.replace(/(\"INSTANCE_DOMAIN\":\s*\")[^\"]*(\")/, '\$1$INSTANCE_DOMAIN\$2');
content = content.replace(/(\"INSTANCE_TITLE\":\s*\")[^\"]*(\")/, '\$1$INSTANCE_TITLE\$2');
content = content.replace(/(\"REGISTRATION_MODE\":\s*\")[^\"]*(\")/, '\$1$REGISTRATION_MODE\$2');
fs.writeFileSync('$DIR/wrangler.jsonc', content);
"
  fi
done
success "Instance variables updated"

# Write Vue .env file (Sentry DSN + public VAPID key)
info "Writing Vue environment file..."
cat > "$MAIN_DIR/.env" <<ENVEOF
# Auto-generated by setup.sh — $(date -u +%Y-%m-%dT%H:%M:%SZ)
VITE_INSTANCE_DOMAIN=$INSTANCE_DOMAIN
VITE_VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY
ENVEOF

if [[ -n "$SENTRY_DSN" ]]; then
  echo "VITE_SENTRY_DSN=$SENTRY_DSN" >> "$MAIN_DIR/.env"
  success "Sentry DSN configured for frontend"
else
  echo "# VITE_SENTRY_DSN=  # uncomment and set to enable Sentry error tracking" >> "$MAIN_DIR/.env"
  info "Sentry DSN not set — error tracking disabled (can be enabled later in .env)"
fi
success "Vue .env written"

# ---------------------------------------------------------------------------
# Set secrets via wrangler
# ---------------------------------------------------------------------------
header "Setting Wrangler Secrets"

set_secret() {
  local WORKER="$1"
  local KEY="$2"
  local VALUE="$3"
  info "Setting $KEY for $WORKER..."
  echo "$VALUE" | wrangler secret put "$KEY" --name "$WORKER" 2>/dev/null
  success "$KEY set for $WORKER"
}

# Only OTP_ENCRYPTION_KEY needs to be a wrangler secret
# VAPID keys are stored in the DB (not env secrets)
set_secret "$MAIN_WORKER_NAME" "OTP_ENCRYPTION_KEY" "$OTP_ENCRYPTION_KEY"

# ---------------------------------------------------------------------------
# Apply D1 migrations
# ---------------------------------------------------------------------------
header "Applying D1 Migrations"

info "Running migrations on remote D1 database..."
cd "$MAIN_DIR"
wrangler d1 migrations apply "$DB_NAME" --remote
success "Migrations applied"

# ---------------------------------------------------------------------------
# Store VAPID keys in D1 settings table
# ---------------------------------------------------------------------------
header "Storing VAPID Keys in Database"

info "Inserting VAPID keys into settings table..."
wrangler d1 execute "$DB_NAME" --remote --command \
  "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('vapid_private_key', '$VAPID_PRIVATE_KEY', datetime('now')), ('vapid_public_key', '$VAPID_PUBLIC_KEY', datetime('now'));"
success "VAPID keys stored in DB"

# ---------------------------------------------------------------------------
# Seed admin user
# ---------------------------------------------------------------------------
header "Seeding Admin User"

info "Creating admin account..."
"$SCRIPT_DIR/seed-admin.sh" "$ADMIN_EMAIL" "$ADMIN_USERNAME" "$ADMIN_PASSWORD"
success "Admin user seeded"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
header "Setup Complete"

echo -e "${GREEN}${BOLD}SiliconBeest has been configured successfully!${NC}"
echo
echo -e "  ${BOLD}Instance Domain:${NC}    $INSTANCE_DOMAIN"
echo -e "  ${BOLD}Instance Title:${NC}     $INSTANCE_TITLE"
echo -e "  ${BOLD}Registration Mode:${NC}  $REGISTRATION_MODE"
echo -e "  ${BOLD}Admin Email:${NC}        $ADMIN_EMAIL"
echo -e "  ${BOLD}Admin Username:${NC}     $ADMIN_USERNAME"
echo
echo -e "  ${BOLD}D1 Database ID:${NC}     $DB_ID"
echo -e "  ${BOLD}R2 Bucket:${NC}          $BUCKET_NAME"
echo -e "  ${BOLD}CACHE KV ID:${NC}        ${CACHE_KV_ID:-<check manually>}"
echo -e "  ${BOLD}SESSIONS KV ID:${NC}     ${SESSIONS_KV_ID:-<check manually>}"
echo -e "  ${BOLD}FEDIFY_KV ID:${NC}      ${FEDIFY_KV_ID:-<check manually>}"
echo
echo -e "  ${BOLD}VAPID Public Key:${NC}   $VAPID_PUBLIC_KEY"
if [[ -n "$SENTRY_DSN" ]]; then
  echo -e "  ${BOLD}Sentry DSN:${NC}         $SENTRY_DSN"
else
  echo -e "  ${BOLD}Sentry:${NC}             disabled"
fi
echo
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Run ${BOLD}./scripts/deploy.sh --domain $INSTANCE_DOMAIN${NC} to deploy with custom domain"
echo "     or ${BOLD}./scripts/deploy.sh${NC} to deploy to workers.dev subdomains"
echo
echo -e "${YELLOW}Optional:${NC}"
echo "  - Enable Sentry: edit ${BOLD}siliconbeest/.env${NC} and set VITE_SENTRY_DSN"
echo "  - Customize: edit ${BOLD}siliconbeest/wrangler.jsonc${NC} vars section"
echo
