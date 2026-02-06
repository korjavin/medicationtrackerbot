# Hetzner Quickstart

This guide gets you from a blank Hetzner server to a running instance with HTTPS.

## 1. Create a Server

- Provider: Hetzner Cloud.
- Type: CX11 or similar is fine to start.
- OS: Ubuntu 22.04 LTS.
- Add your SSH key.
- Enable backups if you want snapshots.

## 2. Open Firewall Ports

Allow inbound:

- 22 (SSH)
- 80 (HTTP)
- 443 (HTTPS)

## 3. Point Your Domain

- Create A/AAAA DNS records for your domain.
- Point them to the server’s public IP.

If you use Cloudflare, disable proxying for the first certificate issuance (DNS only), then you can re-enable if desired.

## 4. SSH In and Run the Installer

```bash
ssh root@YOUR_SERVER_IP

curl -fsSL https://raw.githubusercontent.com/korjavin/medicationtrackerbot/main/install.sh | bash
```

Follow the prompts and start the stack.

## 5. Verify

- Open `https://your-domain` in a browser.
- In Telegram, send `/start` to your bot.
- If you enabled MCP, verify `https://mcp.your-domain/health` returns `ok`.

