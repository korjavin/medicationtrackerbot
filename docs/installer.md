# Easy Installer (Recommended)

This guide is written for non-technical users. It explains what each step does and why it is required.

## What This Installer Does

The installer sets up a single server with HTTPS, the web app, the Telegram bot, and optional extras like browser login, Claude MCP connector, and backups.

## Requirements (Why You Need These)

- A Linux server with public IPv4/IPv6. The app runs on your own machine.
- A domain name you control. HTTPS requires a domain to issue certificates.
- Ports 80 and 443 open to the internet. HTTPS needs these ports.
- Docker + Docker Compose plugin, or Podman. This is how the app runs.
- A Telegram bot token and your Telegram user ID. These protect access to your data.

## DNS Names You May Need (Important)

You can use up to three DNS names. Not everyone needs all three.

- Web app domain, for example `meds.example.com`. Required.
- Pocket-ID domain, for example `id.example.com`. Required if you want browser login or MCP.
- MCP domain, for example `mcp.example.com`. Required if you want Claude MCP connector.

Why three domains?

- Web app is the main UI.
- Pocket-ID is the identity provider (login server).
- MCP is a separate endpoint Claude connects to.

If you skip browser login and MCP, you only need the web app domain.

## Install (Recommended)

```bash
curl -fsSLO https://raw.githubusercontent.com/korjavin/medicationtrackerbot/main/install.sh
chmod +x install.sh
./install.sh
```

If you prefer one-line install, you can pipe to bash, but review the script first:

```bash
curl -fsSL https://raw.githubusercontent.com/korjavin/medicationtrackerbot/main/install.sh | bash
```

If Docker is missing, the installer will detect your OS and print exact install commands.

## What the Installer Asks (With Explanations)

- **Install directory**: Where files like `.env` and `docker-compose.yml` will live.
- **Web app domain**: Your main domain for the app, used for HTTPS.
- **Traefik + Let's Encrypt**: Handles HTTPS certificates automatically.
- **Timezone**: Required to schedule medication reminders correctly.
- **Telegram bot token**: Required to run the bot.
- **Telegram user ID**: Extra security. Only this ID can access your data.
- **Local Telegram Bot API (optional)**: Removes Telegram file size limits, more setup.
- **Browser login (OIDC) (optional)**: Lets you log in via browser without Telegram.
- **Web push (optional)**: Browser notifications. Installer can auto-generate keys.
- **Claude MCP connector (optional)**: Lets Claude read your data via MCP.
- **Litestream backup (optional)**: Replicates SQLite to Cloudflare R2.

The installer saves your answers in `INSTALL_DIR/.installer_state` so you can rerun without losing progress.

## Telegram Setup (Simple Steps)

- Create a bot with BotFather and copy the token.
- Get your numeric Telegram user ID via @userinfobot or @myidbot.
- This ID is an allowlist to prevent anyone else from accessing your data.

## Browser Login (OIDC)

Why use it? If you want to log in from a browser without Telegram.

The installer defaults to Pocket-ID (recommended), but any OIDC provider works.

Minimum settings:

- Redirect URL: `https://your-domain/auth/oidc/callback`.
- Restrict access by email or by subject (`sub`). If both are set, both must match.

What is "subject" (`sub`)?

- It is the unique user ID from your OIDC provider.
- In Pocket-ID, open your user profile and copy the Subject.

Helper page with copy buttons:

- `https://your-domain/oidc-setup`

OIDC discovery uses the system CA trust store. Ensure your server has up-to-date CA certificates.

Rate limiting for auth endpoints trusts proxy headers by default. If you are not behind a reverse proxy, set `AUTH_TRUST_PROXY=false`.

## Pocket-ID (If You Use Browser Login or MCP)

Pocket-ID is the login server.

If the installer deploys Pocket-ID, you need a separate domain like `id.example.com` and a DNS record pointing to your server.

You will create two Pocket-ID clients:

- Web login client, redirect URL: `https://your-domain/auth/oidc/callback`.
- MCP client, redirect URI: `https://claude.ai/api/mcp/auth_callback`.
- MCP client, redirect URI: `https://claude.com/api/mcp/auth_callback`.

After Pocket-ID starts, open:

- `https://id.example.com/setup` to create your admin user.

## Claude MCP Connector (Optional)

Why use it? This lets Claude query your health data with your permission.

You need a separate domain like `mcp.example.com`, pointing to your server.

If you chose "setup later", update `.env` with:

- `POCKET_ID_CLIENT_ID`
- `POCKET_ID_CLIENT_SECRET`
- `MCP_ALLOWED_SUBJECT`

Then set `COMPOSE_PROFILES=mcp` and run `docker compose up -d`.

## Web Push (Optional)

If enabled, the installer can auto-generate VAPID keys.

Use a plain email address for the VAPID subject (no `mailto:` prefix).

## Litestream Backups (Optional)

Litestream replicates your SQLite DB to any S3-compatible storage.

Why use it? It protects you from server loss.

Common options:

- Cloudflare R2
- Backblaze B2 (S3-compatible)
- Wasabi
- AWS S3
- MinIO (self-hosted)

Risks:

- Backups contain sensitive health data.
- If R2 credentials leak, your data can be accessed.
- Always keep the bucket private and restrict access keys.

## After Install

- Point your DNS A/AAAA records to your server IP.
- Open `https://your-domain` and log in.
- In Telegram, open your bot and send `/start`.
- If Pocket-ID was installed, complete setup at `https://id.example.com/setup`.

## Updating

```bash
cd /opt/medtracker
docker compose pull
docker compose up -d
```

## Where Files Live

- `docker-compose.yml` and `.env` are in the install directory (default `/opt/medtracker`).
- `SESSION_SECRET` is generated automatically for web auth sessions.
- `.env` is created with mode 600 (owner read/write only).
