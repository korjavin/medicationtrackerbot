#!/usr/bin/env bash
set -euo pipefail

APP_NAME="medtracker"
DEFAULT_INSTALL_DIR="/opt/medtracker"
COMPOSE_FILE="docker-compose.yml"
ENV_FILE=".env"
DEFAULT_PUID="$(id -u 2>/dev/null || echo 1000)"
DEFAULT_PGID="$(id -g 2>/dev/null || echo 1000)"

say() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }

USE_WHIPTAIL=false
if has_cmd whiptail; then
  USE_WHIPTAIL=true
fi

prompt() {
  local message="$1"
  local default="$2"
  local value=""
  if "$USE_WHIPTAIL"; then
    value=$(whiptail --inputbox "$message" 10 78 "$default" 3>&1 1>&2 2>&3) || exit 1
  else
    read -r -p "$message [$default]: " value
    value="${value:-$default}"
  fi
  printf '%s' "$value"
}

prompt_secret() {
  local message="$1"
  local value=""
  if "$USE_WHIPTAIL"; then
    value=$(whiptail --passwordbox "$message" 10 78 3>&1 1>&2 2>&3) || exit 1
  else
    read -r -s -p "$message: " value
    printf '\n'
  fi
  printf '%s' "$value"
}

confirm() {
  local message="$1"
  local default_yes="${2:-yes}"
  local result=1
  if "$USE_WHIPTAIL"; then
    if [ "$default_yes" = "no" ]; then
      whiptail --defaultno --yesno "$message" 10 78
    else
      whiptail --yesno "$message" 10 78
    fi
    result=$?
  else
    local prompt_suffix="[Y/n]"
    if [ "$default_yes" = "no" ]; then
      prompt_suffix="[y/N]"
    fi
    local answer
    read -r -p "$message $prompt_suffix " answer
    answer="${answer:-$default_yes}"
    case "$answer" in
      y|Y|yes|YES) result=0 ;;
      *) result=1 ;;
    esac
  fi
  return $result
}

detect_timezone() {
  local tz=""
  if has_cmd timedatectl; then
    tz=$(timedatectl show -p Timezone --value 2>/dev/null || true)
  fi
  if [ -z "$tz" ] && [ -f /etc/timezone ]; then
    tz=$(cat /etc/timezone 2>/dev/null || true)
  fi
  if [ -z "$tz" ]; then
    tz="UTC"
  fi
  printf '%s' "$tz"
}

detect_public_ip() {
  local ip=""
  if has_cmd curl; then
    ip=$(curl -fsSL https://api.ipify.org 2>/dev/null || true)
    if [ -z "$ip" ]; then
      ip=$(curl -fsSL https://ifconfig.me 2>/dev/null || true)
    fi
  elif has_cmd wget; then
    ip=$(wget -qO- https://api.ipify.org 2>/dev/null || true)
  fi
  printf '%s' "$ip"
}

validate_oidc_discovery() {
  local issuer="$1"
  if [ -z "$issuer" ]; then
    return 0
  fi
  local url="${issuer%/}/.well-known/openid-configuration"
  local body=""
  if has_cmd curl; then
    body=$(curl -fsSL "$url" 2>/dev/null || true)
  elif has_cmd wget; then
    body=$(wget -qO- "$url" 2>/dev/null || true)
  fi
  if [ -z "$body" ]; then
    warn "OIDC discovery check failed at $url"
    return 1
  fi
  if ! printf '%s' "$body" | grep -q '"authorization_endpoint"'; then
    warn "OIDC discovery missing authorization_endpoint"
    return 1
  fi
  if ! printf '%s' "$body" | grep -q '"token_endpoint"'; then
    warn "OIDC discovery missing token_endpoint"
    return 1
  fi
  if ! printf '%s' "$body" | grep -q '"userinfo_endpoint"'; then
    warn "OIDC discovery missing userinfo_endpoint"
    return 1
  fi
  return 0
}

maybe_open_url() {
  local url="$1"
  if [ -z "$url" ]; then
    return 0
  fi
  if has_cmd xdg-open; then
    xdg-open "$url" >/dev/null 2>&1 || true
    return 0
  fi
  if has_cmd open; then
    open "$url" >/dev/null 2>&1 || true
    return 0
  fi
  return 0
}

gen_random_base64() {
  if ! has_cmd openssl; then
    die "openssl is required to generate secrets. Please install openssl and re-run."
  fi
  openssl rand -base64 32
}

b64url_from_hex() {
  local hex="$1"
  if has_cmd python3; then
    python3 - "$hex" <<'PY'
import base64, binascii, sys
hexstr = sys.argv[1]
raw = binascii.unhexlify(hexstr.encode())
print(base64.urlsafe_b64encode(raw).rstrip(b"=").decode())
PY
    return
  fi
  if has_cmd python; then
    python - "$hex" <<'PY'
import base64, binascii, sys
hexstr = sys.argv[1]
raw = binascii.unhexlify(hexstr.encode())
print(base64.urlsafe_b64encode(raw).rstrip(b"=").decode())
PY
    return
  fi
  if has_cmd xxd; then
    printf '%s' "$hex" | xxd -r -p | openssl base64 -A | tr '+/' '-_' | tr -d '='
    return
  fi
  die "python3 or xxd is required to generate VAPID keys. Please install one and re-run."
}

gen_vapid_keys() {
  if ! has_cmd openssl; then
    die "openssl is required to generate VAPID keys. Please install openssl and re-run."
  fi
  local tmpdir keytext priv_hex pub_hex
  tmpdir=$(mktemp -d)
  openssl ecparam -name prime256v1 -genkey -noout -out "$tmpdir/key.pem" >/dev/null 2>&1
  keytext=$(openssl ec -in "$tmpdir/key.pem" -text -noout 2>/dev/null)
  priv_hex=$(printf '%s\n' "$keytext" | awk '
    $1=="priv:" {flag=1; next}
    $1=="pub:" {flag=0}
    flag {gsub(":", ""); gsub(" ", ""); printf $0}
  ')
  pub_hex=$(printf '%s\n' "$keytext" | awk '
    $1=="pub:" {flag=1; next}
    $1=="ASN1" || $1=="NIST" {flag=0}
    flag {gsub(":", ""); gsub(" ", ""); printf $0}
  ')
  rm -rf "$tmpdir"
  if [ -z "$priv_hex" ] || [ -z "$pub_hex" ]; then
    die "Failed to generate VAPID keys."
  fi
  VAPID_PRIVATE_KEY=$(b64url_from_hex "$priv_hex")
  VAPID_PUBLIC_KEY=$(b64url_from_hex "$pub_hex")
}

print_container_install_help() {
  local os_id=""
  local os_name=""
  local os_version=""
  local os_codename=""
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    os_id="${ID:-}"
    os_name="${NAME:-}"
    os_version="${VERSION_ID:-}"
    os_codename="${VERSION_CODENAME:-}"
  fi

  say "No Docker/Podman compose command was found."
  say ""
  say "Install Docker (recommended), then re-run this installer."
  say ""

  case "$os_id" in
    ubuntu|debian)
      local distro="$os_id"
      local codename="$os_codename"
      local codename_note=""
      if [ -z "$codename" ]; then
        codename="<codename>"
        codename_note="(replace <codename> with your distro codename, e.g., jammy or bookworm)"
      fi
      say "Detected: ${os_name:-$os_id} ${os_version}"
      say ""
      say "Copy/paste these commands:"
      say "  sudo apt-get update"
      say "  sudo apt-get install -y ca-certificates curl gnupg"
      say "  sudo install -m 0755 -d /etc/apt/keyrings"
      say "  curl -fsSL https://download.docker.com/linux/${distro}/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg"
      say "  sudo chmod a+r /etc/apt/keyrings/docker.gpg"
      say "  echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${distro} ${codename} stable\" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null"
      say "  sudo apt-get update"
      say "  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
      say "  sudo usermod -aG docker \$USER"
      say "  newgrp docker"
      say "  docker compose version"
      if [ -n "$codename_note" ]; then
        say "  ${codename_note}"
      fi
      ;;
    fedora)
      say "Detected: ${os_name:-$os_id} ${os_version}"
      say ""
      say "Copy/paste these commands:"
      say "  sudo dnf -y install dnf-plugins-core"
      say "  sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo"
      say "  sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
      say "  sudo systemctl enable --now docker"
      say "  sudo usermod -aG docker \$USER"
      say "  newgrp docker"
      say "  docker compose version"
      ;;
    rhel|centos|rocky|almalinux)
      say "Detected: ${os_name:-$os_id} ${os_version}"
      say ""
      say "Copy/paste these commands:"
      say "  sudo dnf -y install dnf-plugins-core"
      say "  sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo"
      say "  sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
      say "  sudo systemctl enable --now docker"
      say "  sudo usermod -aG docker \$USER"
      say "  newgrp docker"
      say "  docker compose version"
      ;;
    amzn)
      say "Detected: ${os_name:-Amazon Linux} ${os_version}"
      say ""
      say "Copy/paste these commands:"
      say "  sudo yum -y install docker"
      say "  sudo systemctl enable --now docker"
      say "  sudo usermod -aG docker \$USER"
      say "  newgrp docker"
      say "  docker compose version"
      ;;
    *)
      say "Detected: ${os_name:-Unknown Linux}"
      say ""
      say "Please install Docker Engine and the Docker Compose plugin for your OS."
      say "After installing, ensure your user can run docker, then re-run this installer."
      ;;
  esac

  say ""
  say "If you prefer Podman instead of Docker:"
  say "  - Install podman and podman-compose (or ensure 'podman compose' works)."
  say "  - Enable the Podman socket if you plan to use Traefik."
  say ""
}

say ""
say "Medication Tracker Bot Installer"
say ""

COMPOSE_CMD=""
CONTAINER_CLI=""

if has_cmd docker; then
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
    CONTAINER_CLI="docker"
  elif has_cmd docker-compose; then
    COMPOSE_CMD="docker-compose"
    CONTAINER_CLI="docker"
  fi
fi

if [ -z "$COMPOSE_CMD" ] && has_cmd podman; then
  if podman compose version >/dev/null 2>&1; then
    COMPOSE_CMD="podman compose"
    CONTAINER_CLI="podman"
  elif has_cmd podman-compose; then
    COMPOSE_CMD="podman-compose"
    CONTAINER_CLI="podman"
  fi
fi

if [ -z "$COMPOSE_CMD" ]; then
  print_container_install_help
  exit 1
fi

INSTALL_DIR=$(prompt "Install directory" "$DEFAULT_INSTALL_DIR")
if [ -z "$INSTALL_DIR" ]; then
  die "Install directory is required"
fi

if [ ! -d "$INSTALL_DIR" ]; then
  if mkdir -p "$INSTALL_DIR" 2>/dev/null; then
    :
  else
    if has_cmd sudo; then
      sudo mkdir -p "$INSTALL_DIR"
    else
      die "Cannot create $INSTALL_DIR (missing permissions). Run as root or choose another directory."
    fi
  fi
fi

if [ -f "$INSTALL_DIR/$COMPOSE_FILE" ] || [ -f "$INSTALL_DIR/$ENV_FILE" ]; then
  if ! confirm "Existing config found in $INSTALL_DIR. Overwrite?" "no"; then
    die "Aborted"
  fi
fi

cd "$INSTALL_DIR"

DOMAIN=$(prompt "Primary domain for web app (e.g., meds.example.com)" "")
if [ -z "$DOMAIN" ]; then
  die "Domain is required"
fi

USE_TRAEFIK=true
if ! confirm "Use bundled Traefik + Let's Encrypt (recommended)?" "yes"; then
  USE_TRAEFIK=false
fi

CERT_RESOLVER="letsencrypt"
LE_EMAIL=""
NETWORK_NAME=""

if $USE_TRAEFIK; then
  LE_EMAIL=$(prompt "Email for Let's Encrypt" "user@domain.example")
  if [ -z "$LE_EMAIL" ]; then
    die "Let's Encrypt email is required"
  fi
else
  NETWORK_NAME=$(prompt "Existing Traefik network name" "traefik_net")
  CERT_RESOLVER=$(prompt "Existing Traefik cert resolver name" "myresolver")
fi

TZ=$(prompt "Timezone" "$(detect_timezone)")

TELEGRAM_BOT_TOKEN=""
ALLOWED_USER_ID=""
ENABLE_LOCAL_TG_API=false
TELEGRAM_API_ID=""
TELEGRAM_API_HASH=""
TELEGRAM_API_ENDPOINT=""
SESSION_SECRET=""

TELEGRAM_BOT_TOKEN=$(prompt_secret "Telegram Bot Token")
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  die "Telegram Bot Token is required"
fi
say ""
say "Your Telegram User ID is used as an access allowlist (extra security)."
say "Get it by messaging @userinfobot or @myidbot in Telegram."
ALLOWED_USER_ID=$(prompt "Your Telegram User ID" "")
if [ -z "$ALLOWED_USER_ID" ]; then
  die "Telegram User ID is required"
fi

if confirm "Use local Telegram Bot API server (larger files, more setup)?" "no"; then
  ENABLE_LOCAL_TG_API=true
  TELEGRAM_API_ID=$(prompt "Telegram API ID (from my.telegram.org)" "")
  TELEGRAM_API_HASH=$(prompt_secret "Telegram API Hash")
  if [ -z "$TELEGRAM_API_ID" ] || [ -z "$TELEGRAM_API_HASH" ]; then
    die "Telegram API ID and Hash are required for local Telegram API"
  fi
  TELEGRAM_API_ENDPOINT="http://telegram-bot-api:8081"
fi

SESSION_SECRET=$(gen_random_base64)

ENABLE_POCKET_ID=false
POCKET_ID_DOMAIN=""
POCKET_ID_APP_URL=""
POCKET_ID_ENCRYPTION_KEY=""
POCKET_ID_TRUST_PROXY="true"
POCKET_ID_PUID="$DEFAULT_PUID"
POCKET_ID_PGID="$DEFAULT_PGID"
POCKET_ID_URL=""
POCKET_ID_CLIENT_ID=""
POCKET_ID_CLIENT_SECRET=""

ENABLE_OIDC=false
OIDC_ISSUER_URL=""
OIDC_AUTH_URL=""
OIDC_TOKEN_URL=""
OIDC_USERINFO_URL=""
OIDC_CLIENT_ID=""
OIDC_CLIENT_SECRET=""
OIDC_REDIRECT_URL=""
OIDC_ADMIN_EMAIL=""
OIDC_ALLOWED_SUBJECT=""
OIDC_BUTTON_LABEL=""
OIDC_BUTTON_COLOR=""
OIDC_BUTTON_TEXT_COLOR=""
OIDC_SCOPES=""
OIDC_NEEDS_SETUP=false
POCKET_ID_BUNDLE=false

if confirm "Use Pocket-ID for browser login and MCP (recommended)?" "yes"; then
  POCKET_ID_BUNDLE=true
  ENABLE_OIDC=true
  ENABLE_MCP=true
  ENABLE_POCKET_ID=true
  POCKET_ID_DOMAIN=$(prompt "Pocket-ID domain (e.g., id.example.com)" "")
  if [ -z "$POCKET_ID_DOMAIN" ]; then
    die "Pocket-ID domain is required"
  fi
  POCKET_ID_APP_URL="https://${POCKET_ID_DOMAIN}"
  POCKET_ID_URL="$POCKET_ID_APP_URL"
  POCKET_ID_ENCRYPTION_KEY=$(gen_random_base64)

  OIDC_REDIRECT_URL="https://${DOMAIN}/auth/oidc/callback"
  OIDC_ISSUER_URL="$POCKET_ID_APP_URL"
  OIDC_BUTTON_LABEL="Login with Pocket-ID"

  if confirm "Do you already have an OIDC client for web login?" "no"; then
    OIDC_CLIENT_ID=$(prompt "OIDC Client ID" "")
    OIDC_CLIENT_SECRET=$(prompt_secret "OIDC Client Secret")
    if [ -z "$OIDC_CLIENT_ID" ] || [ -z "$OIDC_CLIENT_SECRET" ]; then
      die "OIDC Client ID and Secret are required"
    fi
  else
    OIDC_NEEDS_SETUP=true
  fi

  OIDC_ADMIN_EMAIL=$(prompt "Allowed email for web login (optional)" "")
  say "Allowed subject is the unique user ID from your OIDC provider."
  say "For Pocket-ID: open your user profile and copy the Subject (sub)."
  say "Leave blank if you want to restrict by email only."
  OIDC_ALLOWED_SUBJECT=$(prompt "Allowed subject (sub UUID) for web login (optional)" "")
  if [ -z "$OIDC_ADMIN_EMAIL" ] && [ -z "$OIDC_ALLOWED_SUBJECT" ]; then
    if $OIDC_NEEDS_SETUP; then
      warn "No allowed email/subject set. You must set OIDC_ADMIN_EMAIL or OIDC_ALLOWED_SUBJECT before enabling OIDC."
    else
      die "Set at least one of allowed email or allowed subject for OIDC login"
    fi
  fi
elif confirm "Enable browser login (OIDC)?" "no"; then
  ENABLE_OIDC=true
  OIDC_REDIRECT_URL="https://${DOMAIN}/auth/oidc/callback"

  if confirm "Use Pocket-ID for browser login (recommended)?" "yes"; then
    if ! $ENABLE_POCKET_ID; then
      ENABLE_POCKET_ID=true
      POCKET_ID_DOMAIN=$(prompt "Pocket-ID domain (e.g., id.example.com)" "")
      if [ -z "$POCKET_ID_DOMAIN" ]; then
        die "Pocket-ID domain is required"
      fi
      POCKET_ID_APP_URL="https://${POCKET_ID_DOMAIN}"
      POCKET_ID_URL="$POCKET_ID_APP_URL"
      POCKET_ID_ENCRYPTION_KEY=$(gen_random_base64)
    fi
    OIDC_ISSUER_URL="$POCKET_ID_APP_URL"
    OIDC_BUTTON_LABEL="Login with Pocket-ID"
  else
    OIDC_ISSUER_URL=$(prompt "OIDC Issuer URL (e.g., https://id.example.com)" "")
    if [ -z "$OIDC_ISSUER_URL" ]; then
      die "OIDC Issuer URL is required"
    fi
  fi

  if confirm "Do you already have OIDC client credentials?" "no"; then
    OIDC_CLIENT_ID=$(prompt "OIDC Client ID" "")
    OIDC_CLIENT_SECRET=$(prompt_secret "OIDC Client Secret")
    if [ -z "$OIDC_CLIENT_ID" ] || [ -z "$OIDC_CLIENT_SECRET" ]; then
      die "OIDC Client ID and Secret are required"
    fi
  else
    OIDC_NEEDS_SETUP=true
  fi

  OIDC_ADMIN_EMAIL=$(prompt "Allowed email for web login (optional)" "")
  say "Allowed subject is the unique user ID from your OIDC provider."
  say "For Pocket-ID: open your user profile and copy the Subject (sub)."
  say "Leave blank if you want to restrict by email only."
  OIDC_ALLOWED_SUBJECT=$(prompt "Allowed subject (sub UUID) for web login (optional)" "")
  if [ -z "$OIDC_ADMIN_EMAIL" ] && [ -z "$OIDC_ALLOWED_SUBJECT" ]; then
    if $OIDC_NEEDS_SETUP; then
      warn "No allowed email/subject set. You must set OIDC_ADMIN_EMAIL or OIDC_ALLOWED_SUBJECT before enabling OIDC."
    else
      die "Set at least one of allowed email or allowed subject for OIDC login"
    fi
  fi
fi

ENABLE_WEBPUSH=false
VAPID_PUBLIC_KEY=""
VAPID_PRIVATE_KEY=""
VAPID_SUBJECT=""

if confirm "Enable web push (browser notifications)?" "yes"; then
  ENABLE_WEBPUSH=true
  VAPID_SUBJECT_DEFAULT="$LE_EMAIL"
  if [ -z "$VAPID_SUBJECT_DEFAULT" ]; then
    VAPID_SUBJECT_DEFAULT="user@domain.example"
  fi
  VAPID_SUBJECT=$(prompt "VAPID subject email" "$VAPID_SUBJECT_DEFAULT")
  if confirm "Auto-generate VAPID keys now?" "yes"; then
    gen_vapid_keys
  else
    VAPID_PUBLIC_KEY=$(prompt "VAPID public key" "")
    VAPID_PRIVATE_KEY=$(prompt_secret "VAPID private key")
  fi
  if [ -z "$VAPID_PUBLIC_KEY" ] || [ -z "$VAPID_PRIVATE_KEY" ] || [ -z "$VAPID_SUBJECT" ]; then
    die "VAPID public key, private key, and subject are required for web push."
  fi
fi

ENABLE_MCP=false
MCP_DOMAIN=""
MCP_SERVER_URL=""
MCP_ALLOWED_SUBJECT=""
MCP_MAX_QUERY_DAYS="90"
MCP_PROFILE_ENABLED=false
MCP_NEEDS_SETUP=false

if $ENABLE_MCP; then
  MCP_DOMAIN=$(prompt "MCP domain (e.g., mcp.example.com)" "")
  if [ -z "$MCP_DOMAIN" ]; then
    die "MCP domain is required"
  fi
  MCP_SERVER_URL="https://${MCP_DOMAIN}"

  if confirm "Do you already have Pocket-ID client credentials + user subject for MCP?" "no"; then
    MCP_ALLOWED_SUBJECT=$(prompt "Pocket-ID user subject (sub UUID)" "")
    POCKET_ID_CLIENT_ID=$(prompt "Pocket-ID Client ID" "")
    POCKET_ID_CLIENT_SECRET=$(prompt_secret "Pocket-ID Client Secret")
    MCP_MAX_QUERY_DAYS=$(prompt "MCP max query days" "$MCP_MAX_QUERY_DAYS")

    if [ -z "$MCP_ALLOWED_SUBJECT" ] || [ -z "$POCKET_ID_CLIENT_ID" ] || [ -z "$POCKET_ID_CLIENT_SECRET" ]; then
      die "Pocket-ID client ID/secret and user subject are required for MCP"
    fi
    MCP_PROFILE_ENABLED=true
  else
    MCP_NEEDS_SETUP=true
  fi
elif confirm "Enable Claude MCP connector (optional)?" "no"; then
  ENABLE_MCP=true
  MCP_DOMAIN=$(prompt "MCP domain (e.g., mcp.example.com)" "")
  if [ -z "$MCP_DOMAIN" ]; then
    die "MCP domain is required"
  fi
  MCP_SERVER_URL="https://${MCP_DOMAIN}"
  if $ENABLE_POCKET_ID; then
    if [ -z "$POCKET_ID_URL" ]; then
      POCKET_ID_URL="$POCKET_ID_APP_URL"
    fi
  else
    if confirm "Install Pocket-ID on this server?" "yes"; then
      ENABLE_POCKET_ID=true
      POCKET_ID_DOMAIN=$(prompt "Pocket-ID domain (e.g., id.example.com)" "")
      if [ -z "$POCKET_ID_DOMAIN" ]; then
        die "Pocket-ID domain is required"
      fi
      POCKET_ID_APP_URL="https://${POCKET_ID_DOMAIN}"
      POCKET_ID_URL="$POCKET_ID_APP_URL"
      POCKET_ID_ENCRYPTION_KEY=$(gen_random_base64)
    else
      POCKET_ID_URL=$(prompt "Pocket-ID URL (e.g., https://id.example.com)" "")
      if [ -z "$POCKET_ID_URL" ]; then
        die "Pocket-ID URL is required"
      fi
    fi
  fi

  if confirm "Do you already have Pocket-ID client credentials + user subject?" "no"; then
    MCP_ALLOWED_SUBJECT=$(prompt "Pocket-ID user subject (sub UUID)" "")
    POCKET_ID_CLIENT_ID=$(prompt "Pocket-ID Client ID" "")
    POCKET_ID_CLIENT_SECRET=$(prompt_secret "Pocket-ID Client Secret")
    MCP_MAX_QUERY_DAYS=$(prompt "MCP max query days" "$MCP_MAX_QUERY_DAYS")

    if [ -z "$MCP_ALLOWED_SUBJECT" ] || [ -z "$POCKET_ID_CLIENT_ID" ] || [ -z "$POCKET_ID_CLIENT_SECRET" ]; then
      die "Pocket-ID client ID/secret and user subject are required for MCP"
    fi
    MCP_PROFILE_ENABLED=true
  else
    MCP_NEEDS_SETUP=true
  fi
fi

ENABLE_LITESTREAM=false
LITESTREAM_ACCESS_KEY_ID=""
LITESTREAM_SECRET_ACCESS_KEY=""
R2_ENDPOINT=""
R2_BUCKET=""

if confirm "Enable Litestream backup to Cloudflare R2 (optional)?" "no"; then
  ENABLE_LITESTREAM=true
  LITESTREAM_ACCESS_KEY_ID=$(prompt "R2 Access Key ID" "")
  LITESTREAM_SECRET_ACCESS_KEY=$(prompt_secret "R2 Secret Access Key")
  R2_ENDPOINT=$(prompt "R2 Endpoint (e.g., https://<account>.r2.cloudflarestorage.com)" "")
  R2_BUCKET=$(prompt "R2 Bucket name" "")
  if [ -z "$LITESTREAM_ACCESS_KEY_ID" ] || [ -z "$LITESTREAM_SECRET_ACCESS_KEY" ] || [ -z "$R2_ENDPOINT" ] || [ -z "$R2_BUCKET" ]; then
    die "R2 credentials are required for Litestream"
  fi
fi

PUBLIC_IP=$(detect_public_ip)

# Write .env
{
  printf 'COMPOSE_PROJECT_NAME=%s\n' "$APP_NAME"
  printf 'TZ=%s\n' "$TZ"
  printf 'DOMAIN=%s\n' "$DOMAIN"
  printf 'PORT=8080\n'
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_BOT_TOKEN"
  printf 'ALLOWED_USER_ID=%s\n' "$ALLOWED_USER_ID"
  printf 'TELEGRAM_API_ENDPOINT=%s\n' "$TELEGRAM_API_ENDPOINT"
  printf 'TELEGRAM_API_ID=%s\n' "$TELEGRAM_API_ID"
  printf 'TELEGRAM_API_HASH=%s\n' "$TELEGRAM_API_HASH"
  printf 'SESSION_SECRET=%s\n' "$SESSION_SECRET"
  printf 'AUTH_TRUST_PROXY=%s\n' "true"
  printf 'GOOGLE_CLIENT_ID=%s\n' ""
  printf 'GOOGLE_CLIENT_SECRET=%s\n' ""
  printf 'GOOGLE_REDIRECT_URL=%s\n' ""
  printf 'ADMIN_EMAIL=%s\n' ""
  printf 'OIDC_ISSUER_URL=%s\n' "$OIDC_ISSUER_URL"
  printf 'OIDC_AUTH_URL=%s\n' "$OIDC_AUTH_URL"
  printf 'OIDC_TOKEN_URL=%s\n' "$OIDC_TOKEN_URL"
  printf 'OIDC_USERINFO_URL=%s\n' "$OIDC_USERINFO_URL"
  printf 'OIDC_CLIENT_ID=%s\n' "$OIDC_CLIENT_ID"
  printf 'OIDC_CLIENT_SECRET=%s\n' "$OIDC_CLIENT_SECRET"
  printf 'OIDC_REDIRECT_URL=%s\n' "$OIDC_REDIRECT_URL"
  printf 'OIDC_ADMIN_EMAIL=%s\n' "$OIDC_ADMIN_EMAIL"
  printf 'OIDC_ALLOWED_SUBJECT=%s\n' "$OIDC_ALLOWED_SUBJECT"
  printf 'OIDC_BUTTON_LABEL=%s\n' "$OIDC_BUTTON_LABEL"
  printf 'OIDC_BUTTON_COLOR=%s\n' "$OIDC_BUTTON_COLOR"
  printf 'OIDC_BUTTON_TEXT_COLOR=%s\n' "$OIDC_BUTTON_TEXT_COLOR"
  printf 'OIDC_SCOPES=%s\n' "$OIDC_SCOPES"
  printf 'VAPID_PUBLIC_KEY=%s\n' "$VAPID_PUBLIC_KEY"
  printf 'VAPID_PRIVATE_KEY=%s\n' "$VAPID_PRIVATE_KEY"
  printf 'VAPID_SUBJECT=%s\n' "$VAPID_SUBJECT"
  printf 'MCP_DOMAIN=%s\n' "$MCP_DOMAIN"
  printf 'MCP_SERVER_URL=%s\n' "$MCP_SERVER_URL"
  printf 'MCP_ALLOWED_SUBJECT=%s\n' "$MCP_ALLOWED_SUBJECT"
  printf 'MCP_MAX_QUERY_DAYS=%s\n' "$MCP_MAX_QUERY_DAYS"
  printf 'COMPOSE_PROFILES=%s\n' "$([ "$MCP_PROFILE_ENABLED" = true ] && echo "mcp" || echo "")"
  printf 'POCKET_ID_DOMAIN=%s\n' "$POCKET_ID_DOMAIN"
  printf 'POCKET_ID_APP_URL=%s\n' "$POCKET_ID_APP_URL"
  printf 'POCKET_ID_ENCRYPTION_KEY=%s\n' "$POCKET_ID_ENCRYPTION_KEY"
  printf 'POCKET_ID_TRUST_PROXY=%s\n' "$POCKET_ID_TRUST_PROXY"
  printf 'POCKET_ID_PUID=%s\n' "$POCKET_ID_PUID"
  printf 'POCKET_ID_PGID=%s\n' "$POCKET_ID_PGID"
  printf 'POCKET_ID_URL=%s\n' "$POCKET_ID_URL"
  printf 'POCKET_ID_CLIENT_ID=%s\n' "$POCKET_ID_CLIENT_ID"
  printf 'POCKET_ID_CLIENT_SECRET=%s\n' "$POCKET_ID_CLIENT_SECRET"
  printf 'LITESTREAM_ACCESS_KEY_ID=%s\n' "$LITESTREAM_ACCESS_KEY_ID"
  printf 'LITESTREAM_SECRET_ACCESS_KEY=%s\n' "$LITESTREAM_SECRET_ACCESS_KEY"
  printf 'R2_ENDPOINT=%s\n' "$R2_ENDPOINT"
  printf 'R2_BUCKET=%s\n' "$R2_BUCKET"
  if ! $USE_TRAEFIK; then
    printf 'NETWORK_NAME=%s\n' "$NETWORK_NAME"
    printf 'CERT_RESOLVER=%s\n' "$CERT_RESOLVER"
  else
    printf 'CERT_RESOLVER=%s\n' "$CERT_RESOLVER"
    printf 'LE_EMAIL=%s\n' "$LE_EMAIL"
  fi
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
say "Created ${ENV_FILE} with mode 600 (owner read/write only)."

# Build compose file
{
  printf "version: '3.8'\n\n"
  printf "services:\n"

  if $USE_TRAEFIK; then
    printf "  traefik:\n"
    printf "    image: traefik:v3.1\n"
    printf "    container_name: ${APP_NAME}-traefik\n"
    printf "    restart: unless-stopped\n"
    printf "    command:\n"
    printf "      - --providers.docker=true\n"
    printf "      - --providers.docker.exposedbydefault=false\n"
    if [ "$CONTAINER_CLI" = "podman" ]; then
      printf "      - --providers.docker.endpoint=unix:///var/run/podman.sock\n"
    fi
    printf "      - --entrypoints.web.address=:80\n"
    printf "      - --entrypoints.websecure.address=:443\n"
    printf "      - --entrypoints.web.http.redirections.entrypoint.to=websecure\n"
    printf "      - --entrypoints.web.http.redirections.entrypoint.scheme=https\n"
    printf "      - --certificatesresolvers.${CERT_RESOLVER}.acme.email=${LE_EMAIL}\n"
    printf "      - --certificatesresolvers.${CERT_RESOLVER}.acme.storage=/letsencrypt/acme.json\n"
    printf "      - --certificatesresolvers.${CERT_RESOLVER}.acme.httpchallenge.entrypoint=web\n"
    printf "    ports:\n"
    printf "      - 80:80\n"
    printf "      - 443:443\n"
    printf "    volumes:\n"
    if [ "$CONTAINER_CLI" = "podman" ]; then
      printf "      - ${XDG_RUNTIME_DIR:-/run}/podman/podman.sock:/var/run/podman.sock:ro\n"
    else
      printf "      - /var/run/docker.sock:/var/run/docker.sock:ro\n"
    fi
    printf "      - traefik_letsencrypt:/letsencrypt\n"
    printf "    networks:\n"
    printf "      - proxy\n\n"
  fi

  if $ENABLE_POCKET_ID; then
    printf "  pocket-id:\n"
    printf "    image: ghcr.io/pocket-id/pocket-id:v2\n"
    printf "    container_name: ${APP_NAME}-pocket-id\n"
    printf "    restart: unless-stopped\n"
    printf "    environment:\n"
    printf "      - APP_URL=\${POCKET_ID_APP_URL}\n"
    printf "      - TRUST_PROXY=\${POCKET_ID_TRUST_PROXY}\n"
    printf "      - ENCRYPTION_KEY=\${POCKET_ID_ENCRYPTION_KEY}\n"
    printf "      - PUID=\${POCKET_ID_PUID}\n"
    printf "      - PGID=\${POCKET_ID_PGID}\n"
    printf "    volumes:\n"
    printf "      - pocket_id_data:/app/data\n"
    if $USE_TRAEFIK; then
      printf "    networks:\n"
      printf "      - proxy\n"
    else
      printf "    networks:\n"
      printf "      - traefik_net\n"
    fi
    printf "    labels:\n"
    printf "      - traefik.enable=true\n"
    printf "      - traefik.http.routers.pocket-id.rule=Host(\`\${POCKET_ID_DOMAIN}\`)\n"
    printf "      - traefik.http.routers.pocket-id.entrypoints=websecure\n"
    printf "      - traefik.http.routers.pocket-id.tls.certresolver=\${CERT_RESOLVER}\n"
    printf "      - traefik.http.services.pocket-id.loadbalancer.server.port=1411\n\n"
  fi

  printf "  medtracker:\n"
  printf "    image: ghcr.io/korjavin/medicationtrackerbot:latest\n"
  printf "    container_name: ${APP_NAME}\n"
  printf "    restart: unless-stopped\n"
  printf "    volumes:\n"
  printf "      - medtracker_data:/app/data\n"
  if $ENABLE_LOCAL_TG_API; then
    printf "      - telegram_bot_api_data:/var/lib/telegram-bot-api\n"
  fi
  printf "    environment:\n"
  printf "      - TELEGRAM_BOT_TOKEN=\${TELEGRAM_BOT_TOKEN}\n"
  printf "      - ALLOWED_USER_ID=\${ALLOWED_USER_ID}\n"
  printf "      - DB_PATH=\${DB_PATH:-/app/data/meds.db}\n"
  printf "      - PORT=\${PORT:-8080}\n"
  printf "      - TZ=\${TZ}\n"
  printf "      - SESSION_SECRET=\${SESSION_SECRET}\n"
  printf "      - AUTH_TRUST_PROXY=\${AUTH_TRUST_PROXY}\n"
  printf "      - APP_DOMAIN=\${DOMAIN}\n"
  printf "      - MCP_DOMAIN=\${MCP_DOMAIN}\n"
  printf "      - POCKET_ID_DOMAIN=\${POCKET_ID_DOMAIN}\n"
  printf "      - GOOGLE_CLIENT_ID=\${GOOGLE_CLIENT_ID}\n"
  printf "      - GOOGLE_CLIENT_SECRET=\${GOOGLE_CLIENT_SECRET}\n"
  printf "      - GOOGLE_REDIRECT_URL=\${GOOGLE_REDIRECT_URL}\n"
  printf "      - ADMIN_EMAIL=\${ADMIN_EMAIL}\n"
  printf "      - OIDC_ISSUER_URL=\${OIDC_ISSUER_URL}\n"
  printf "      - OIDC_AUTH_URL=\${OIDC_AUTH_URL}\n"
  printf "      - OIDC_TOKEN_URL=\${OIDC_TOKEN_URL}\n"
  printf "      - OIDC_USERINFO_URL=\${OIDC_USERINFO_URL}\n"
  printf "      - OIDC_CLIENT_ID=\${OIDC_CLIENT_ID}\n"
  printf "      - OIDC_CLIENT_SECRET=\${OIDC_CLIENT_SECRET}\n"
  printf "      - OIDC_REDIRECT_URL=\${OIDC_REDIRECT_URL}\n"
  printf "      - OIDC_ADMIN_EMAIL=\${OIDC_ADMIN_EMAIL}\n"
  printf "      - OIDC_ALLOWED_SUBJECT=\${OIDC_ALLOWED_SUBJECT}\n"
  printf "      - OIDC_BUTTON_LABEL=\${OIDC_BUTTON_LABEL}\n"
  printf "      - OIDC_BUTTON_COLOR=\${OIDC_BUTTON_COLOR}\n"
  printf "      - OIDC_BUTTON_TEXT_COLOR=\${OIDC_BUTTON_TEXT_COLOR}\n"
  printf "      - OIDC_SCOPES=\${OIDC_SCOPES}\n"
  printf "      - TELEGRAM_API_ENDPOINT=\${TELEGRAM_API_ENDPOINT}\n"
  printf "      - VAPID_PUBLIC_KEY=\${VAPID_PUBLIC_KEY}\n"
  printf "      - VAPID_PRIVATE_KEY=\${VAPID_PRIVATE_KEY}\n"
  printf "      - VAPID_SUBJECT=\${VAPID_SUBJECT}\n"
  if $USE_TRAEFIK; then
    printf "    networks:\n"
    printf "      - proxy\n"
  else
    printf "    networks:\n"
    printf "      - traefik_net\n"
  fi
  printf "    labels:\n"
  printf "      - traefik.enable=true\n"
  printf "      - traefik.http.routers.medtracker.rule=Host(\`\${DOMAIN}\`)\n"
  printf "      - traefik.http.routers.medtracker.entrypoints=websecure\n"
  printf "      - traefik.http.routers.medtracker.tls.certresolver=\${CERT_RESOLVER}\n"
  printf "      - traefik.http.services.medtracker.loadbalancer.server.port=\${PORT:-8080}\n\n"

  if $ENABLE_MCP; then
    printf "  mcp-server:\n"
    printf "    image: ghcr.io/korjavin/medicationtrackerbot:latest\n"
    printf "    container_name: ${APP_NAME}-mcp\n"
    printf "    restart: unless-stopped\n"
    printf "    profiles:\n"
    printf "      - mcp\n"
    printf "    command: [\"./mcptool\"]\n"
    printf "    volumes:\n"
    printf "      - medtracker_data:/app/data:ro\n"
    printf "    environment:\n"
    printf "      - MCP_PORT=\${MCP_PORT:-8081}\n"
    printf "      - MCP_DATABASE_PATH=\${MCP_DATABASE_PATH:-/app/data/meds.db}\n"
    printf "      - MCP_MAX_QUERY_DAYS=\${MCP_MAX_QUERY_DAYS:-90}\n"
    printf "      - MCP_SERVER_URL=\${MCP_SERVER_URL}\n"
    printf "      - MCP_ALLOWED_SUBJECT=\${MCP_ALLOWED_SUBJECT}\n"
    printf "      - ALLOWED_USER_ID=\${ALLOWED_USER_ID}\n"
    printf "      - POCKET_ID_URL=\${POCKET_ID_URL}\n"
    printf "      - POCKET_ID_CLIENT_ID=\${POCKET_ID_CLIENT_ID}\n"
    printf "      - POCKET_ID_CLIENT_SECRET=\${POCKET_ID_CLIENT_SECRET}\n"
    printf "      - POCKET_ID_JWKS_JSON=\${POCKET_ID_JWKS_JSON}\n"
    printf "      - SKIP_PERMS_FIX=true\n"
    printf "      - TZ=\${TZ}\n"
    if $USE_TRAEFIK; then
      printf "    networks:\n"
      printf "      - proxy\n"
    else
      printf "    networks:\n"
      printf "      - traefik_net\n"
    fi
    printf "    labels:\n"
    printf "      - traefik.enable=true\n"
    printf "      - traefik.http.routers.medtracker-mcp.rule=Host(\`\${MCP_DOMAIN}\`)\n"
    printf "      - traefik.http.routers.medtracker-mcp.entrypoints=websecure\n"
    printf "      - traefik.http.routers.medtracker-mcp.tls.certresolver=\${CERT_RESOLVER}\n"
    printf "      - traefik.http.services.medtracker-mcp.loadbalancer.server.port=\${MCP_PORT:-8081}\n\n"
  fi

  if $ENABLE_LOCAL_TG_API; then
    printf "  telegram-bot-api:\n"
    printf "    image: aiogram/telegram-bot-api:latest\n"
    printf "    container_name: ${APP_NAME}-telegram-api\n"
    printf "    restart: unless-stopped\n"
    printf "    entrypoint: /bin/sh\n"
    printf "    command:\n"
    printf "      - -c\n"
    printf "      - |\n"
    printf "        grep -q :1000: /etc/group || echo \"appgroup:x:1000:\" >> /etc/group\n"
    printf "        grep -q :1000: /etc/passwd || echo \"appuser:x:1000:1000:appuser:/var/lib/telegram-bot-api:/bin/sh\" >> /etc/passwd\n"
    printf "        chown -R 1000:1000 /var/lib/telegram-bot-api\n"
    printf "        exec telegram-bot-api --local \\\n          --api-id=\$\${TELEGRAM_API_ID} \\\n          --api-hash=\$\${TELEGRAM_API_HASH} \\\n          --dir=/var/lib/telegram-bot-api \\\n          --temp-dir=/tmp \\\n          --username=appuser \\\n          --groupname=appgroup \\\n          --http-port=8081\n"
    printf "    volumes:\n"
    printf "      - telegram_bot_api_data:/var/lib/telegram-bot-api\n"
    printf "    environment:\n"
    printf "      - TELEGRAM_API_ID=\${TELEGRAM_API_ID}\n"
    printf "      - TELEGRAM_API_HASH=\${TELEGRAM_API_HASH}\n"
    printf "      - TELEGRAM_LOCAL=1\n"
    printf "    networks:\n"
    if $USE_TRAEFIK; then
      printf "      - proxy\n\n"
    else
      printf "      - traefik_net\n\n"
    fi
  fi

  if $ENABLE_LITESTREAM; then
    printf "  litestream:\n"
    printf "    image: litestream/litestream:latest\n"
    printf "    container_name: ${APP_NAME}-litestream\n"
    printf "    restart: unless-stopped\n"
    printf "    entrypoint: /bin/sh\n"
    printf "    command:\n"
    printf "      - -c\n"
    printf "      - |\n"
    printf "        cat << EOF > /tmp/litestream.yml\n"
    printf "        dbs:\n"
    printf "          - path: /app/data/meds.db\n"
    printf "            replicas:\n"
    printf "              - type: s3\n"
    printf "                bucket: \$\${R2_BUCKET}\n"
    printf "                path: medtracker\n"
    printf "                endpoint: \$\${R2_ENDPOINT}\n"
    printf "                sync-interval: 1h\n"
    printf "                snapshot-interval: 24h\n"
    printf "                retention: 168h\n"
    printf "        EOF\n"
    printf "        exec litestream replicate -config /tmp/litestream.yml\n"
    printf "    volumes:\n"
    printf "      - medtracker_data:/app/data\n"
    printf "    environment:\n"
    printf "      - LITESTREAM_ACCESS_KEY_ID=\${LITESTREAM_ACCESS_KEY_ID}\n"
    printf "      - LITESTREAM_SECRET_ACCESS_KEY=\${LITESTREAM_SECRET_ACCESS_KEY}\n"
    printf "      - R2_ENDPOINT=\${R2_ENDPOINT}\n"
    printf "      - R2_BUCKET=\${R2_BUCKET}\n"
    printf "    depends_on:\n"
    printf "      - medtracker\n"
    printf "    networks:\n"
    if $USE_TRAEFIK; then
      printf "      - proxy\n\n"
    else
      printf "      - traefik_net\n\n"
    fi
  fi

  printf "networks:\n"
  if $USE_TRAEFIK; then
    printf "  proxy:\n"
  else
    printf "  traefik_net:\n"
    printf "    external: true\n"
    printf "    name: \${NETWORK_NAME}\n"
  fi

  printf "\nvolumes:\n"
  printf "  medtracker_data:\n"
  if $ENABLE_POCKET_ID; then
    printf "  pocket_id_data:\n"
  fi
  if $ENABLE_LOCAL_TG_API; then
    printf "  telegram_bot_api_data:\n"
  fi
  if $USE_TRAEFIK; then
    printf "  traefik_letsencrypt:\n"
  fi
} > "$COMPOSE_FILE"

say ""
say "Configuration written to: $INSTALL_DIR/$COMPOSE_FILE and $INSTALL_DIR/$ENV_FILE"

STACK_STARTED=false
if confirm "Start the stack now?" "yes"; then
  $COMPOSE_CMD up -d
  STACK_STARTED=true
else
  STACK_STARTED=false
fi

say ""
say "Next steps:"
if [ -n "$PUBLIC_IP" ]; then
  say "- Point your DNS A/AAAA record for ${DOMAIN} to ${PUBLIC_IP}."
else
  say "- Point your DNS A/AAAA record for ${DOMAIN} to your server's public IP."
fi

if $ENABLE_POCKET_ID; then
  if [ -n "$PUBLIC_IP" ]; then
    say "- Point your DNS A/AAAA record for ${POCKET_ID_DOMAIN} to ${PUBLIC_IP}."
  else
    say "- Point your DNS A/AAAA record for ${POCKET_ID_DOMAIN} to your server's public IP."
  fi
fi

if $ENABLE_MCP; then
  if [ -n "$PUBLIC_IP" ]; then
    say "- Point your DNS A/AAAA record for ${MCP_DOMAIN} to ${PUBLIC_IP}."
  else
    say "- Point your DNS A/AAAA record for ${MCP_DOMAIN} to your server's public IP."
  fi
fi

say "- Wait for DNS to propagate, then open https://${DOMAIN}."

say "- In Telegram, open your bot and send /start to launch the app."

if $ENABLE_POCKET_ID; then
  say "- OIDC setup helper: https://${DOMAIN}/oidc-setup"
  if $STACK_STARTED; then
    maybe_open_url "https://${POCKET_ID_DOMAIN}/setup"
    say "- Attempted to open Pocket-ID setup at https://${POCKET_ID_DOMAIN}/setup"
  fi
fi

if $ENABLE_OIDC; then
  if $OIDC_NEEDS_SETUP; then
    if $ENABLE_POCKET_ID; then
      say "- Finish Pocket-ID setup at https://${POCKET_ID_DOMAIN}/setup and create your admin user."
    fi
    say "- Create an OIDC client with redirect URL ${OIDC_REDIRECT_URL}."
    say "- Update ${INSTALL_DIR}/${ENV_FILE} with OIDC_CLIENT_ID and OIDC_CLIENT_SECRET."
    say "- Set OIDC_ADMIN_EMAIL or OIDC_ALLOWED_SUBJECT, then run: $COMPOSE_CMD up -d"
  fi

  if ! validate_oidc_discovery "$OIDC_ISSUER_URL"; then
    warn "OIDC discovery may fail until Pocket-ID is fully initialized."
  fi
fi

if $ENABLE_MCP; then
  if $MCP_NEEDS_SETUP; then
    if $ENABLE_POCKET_ID; then
      say "- Finish Pocket-ID setup at https://${POCKET_ID_DOMAIN}/setup and create your admin user."
    fi
    say "- Create a Pocket-ID client (redirect URIs: https://claude.ai/api/mcp/auth_callback and https://claude.com/api/mcp/auth_callback)."
    say "- Update ${INSTALL_DIR}/${ENV_FILE} with POCKET_ID_CLIENT_ID, POCKET_ID_CLIENT_SECRET, MCP_ALLOWED_SUBJECT."
    say "- Set COMPOSE_PROFILES=mcp in ${INSTALL_DIR}/${ENV_FILE}, then run: $COMPOSE_CMD up -d"
  else
    say "- Configure Claude MCP with: https://${MCP_DOMAIN}/mcp/sse (HTTP/SSE)."
    say "- Ensure Pocket-ID client redirect URIs include https://claude.ai/api/mcp/auth_callback and https://claude.com/api/mcp/auth_callback."
  fi
fi

if $ENABLE_LITESTREAM; then
  say "- Litestream is enabled. Make sure your R2 bucket is private and access keys are restricted."
fi

say ""
say "Manage the stack:"
say "- Logs: $COMPOSE_CMD logs -f"
say "- Update: $COMPOSE_CMD pull && $COMPOSE_CMD up -d"
