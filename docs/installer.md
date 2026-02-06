# Easy Installer (Recommended)

This installer sets up a simple single-server deployment with HTTPS, optional MCP connector, and optional backups.

## Requirements

- A Linux server with public IPv4/IPv6.
- A domain name you control.
- Ports 80 and 443 open to the internet.
- Docker + Docker Compose plugin (recommended), or Podman + compose.
- A Telegram bot token and your Telegram user ID (required for auth).

## One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/korjavin/medicationtrackerbot/main/install.sh | bash
```

## What the Installer Asks

- Domain for the web app (e.g., `meds.example.com`).
- Whether to run bundled Traefik + Let's Encrypt.
- Timezone.
- Telegram bot token and your Telegram user ID (required for auth).
- Optional local Telegram Bot API server (larger file downloads).
- Optional browser login (OIDC).
- Optional web push (VAPID keys auto-generated).
- Optional MCP connector and Pocket-ID settings.
- Optional Litestream backups to Cloudflare R2.

## After Install

- DNS: point your domain A/AAAA records to the server’s public IP.
- Wait for DNS to propagate, then open `https://your-domain`.
- In Telegram, open your bot and send `/start`.

## Updating

```bash
cd /opt/medtracker
docker compose pull
docker compose up -d
```

## Where Files Live

- `docker-compose.yml` and `.env` are written to the install directory (default: `/opt/medtracker`).
- Edit `.env` to change settings, then re-run `docker compose up -d`.
- `SESSION_SECRET` is generated automatically for web auth sessions.

## Telegram Setup

- Create a bot with BotFather and copy the token.
- Get your numeric Telegram user ID via @userinfobot or @myidbot.

## Optional Local Telegram Bot API

This removes the default Telegram file size limit.

- Create API ID and Hash at `https://my.telegram.org`.
- Choose the local Telegram API option in the installer.

## Optional Browser Login (OIDC)

This allows browser login outside Telegram. It is only needed if you want browser access.

The installer defaults to Pocket-ID (recommended), but you can use any OIDC provider.

Minimum settings:

- Redirect URL: `https://your-domain/auth/oidc/callback`.
- Restrict access by email or by subject (`sub`).
If both are set, both must match.

OIDC discovery uses the system CA trust store. Ensure your server has up-to-date CA certificates.

If you choose the combined Pocket-ID flow, the installer will deploy Pocket-ID once and guide you to set up:

- One client for web login (redirect URL above).
- One client for MCP (Claude redirect URLs).

Helper page with copy buttons:

- `https://your-domain/oidc-setup`

## Web Push (VAPID)

If you enable web push, the installer can auto-generate VAPID keys. Use a plain email address for the subject (no `mailto:` prefix).

## MCP + Pocket-ID

The MCP connector requires Pocket-ID as the OIDC provider. If you do not already run Pocket-ID, install it first, then run the installer with MCP enabled.

The installer can also deploy Pocket-ID on the same server. You will need a separate domain (for example, `id.example.com`) and a DNS record pointing to the server.

Minimum Pocket-ID client settings:

- Redirect URIs:
  - `https://claude.ai/api/mcp/auth_callback`
  - `https://claude.com/api/mcp/auth_callback`
- Access Type: Public or Confidential.
- Trust Level: High (recommended).

You will also need your Pocket-ID user subject UUID (`sub`) to restrict access.

If you install Pocket-ID with the installer, finish setup at `https://id.example.com/setup`, create an admin user, then create the MCP client and re-run the installer (or update `.env` and enable `COMPOSE_PROFILES=mcp`).

## Litestream Backups

Litestream replicates your SQLite DB to Cloudflare R2. This is optional but recommended.

- Keep your R2 bucket private.
- Use access keys with minimal permissions.
- Treat backups as sensitive medical data.
