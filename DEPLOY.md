# Deployment Guide

## Prerequisites
- Docker & Docker Compose
- A domain configured (e.g., `meds.your-domain.com`) pointing to your server.
- Traefik installed and running (as per your existing infrastructure).

## 1. Build & Push Image
If you are using GitHub Actions, this will be handled automatically. Otherwise, build locally:

```bash
docker build -t ghcr.io/korjavin/medicationtrackerbot:latest .
docker push ghcr.io/korjavin/medicationtrackerbot:latest
```

## 2. Deploy via Portainer
1.  Go to your Portainer instance.
2.  Open **Stacks**.
3.  Click **Add stack**.
4.  Name: `medtracker`.
5.  Paste the contents of `docker-compose.yml`.
6.  **Environment variables**: Add the following:
    - `TELEGRAM_BOT_TOKEN`: Your Bot Token.
    - `ALLOWED_USER_ID`: Your Telegram numeric ID.
    - `DOMAIN`: The domain where the app will be accessible (e.g. `meds.your-domain.com`).
    - `NETWORK_NAME`: The name of your Traefik network (e.g. `proxy_net`).
    - `TZ` (Optional): Timezone (default: `Europe/Berlin`).
    - `PORT` (Optional): Internal port (default: `8080`).
7.  Deploy the stack.

## 3. Verify
- Open your bot in Telegram.
- Send `/start`.
- Click "Open App" or the menu button (if configured in BotFather).
- Add a test medication.
- Wait for notification.
