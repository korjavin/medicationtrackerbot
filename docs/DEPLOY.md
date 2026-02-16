# Deployment Guide

## Prerequisites
- Docker & Docker Compose
- A domain configured (e.g., `meds.your-domain.com`) pointing to your server.
- Traefik installed and running (as per your existing infrastructure).

## 1. Secrets Setup (GitHub)
On your GitHub repository, go to **Settings > Secrets and variables > Actions** and add:
- `PORTAINER_REDEPLOY_HOOK`: The webhook URL from your Portainer stack (see below).

## 2. Build & Push Image
The **GitHub Actions workflow** (`.github/workflows/deploy.yml`) will automatically:
1. Build and push the image to GHCR.
2. Update the `deploy` branch with the specific image SHA.
3. Trigger Portainer to redeploy.

For the first time, you can trigger the workflow manually or push to `main`.

## 2. Deploy via Portainer
1.  Go to your Portainer instance.
2.  Open **Stacks**.
3.  Click **Add stack**.
4.  Name: `medtracker`.
5.  **Repository settings**:
    - Select **Git Repository**.
    - Repository URL: `https://github.com/korjavin/medicationtrackerbot` (or your repo URL).
    - Repository Reference: `refs/heads/deploy` (IMPORTANT: Use the `deploy` branch!).
    - Compose path: `docker-compose.yml`.
    - Automatic updates: **Enable**.
    - Mechanism: **Webhook**.
    - Copy the **Webhook URL** (Save this as `PORTAINER_REDEPLOY_HOOK` in GitHub Secrets).
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
