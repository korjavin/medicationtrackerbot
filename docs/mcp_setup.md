# Claude MCP Connector Setup Guide

This guide explains how to deploy and configure the Claude MCP connector for your Health Data bot.

## 1. Overview

The MCP connector runs as a separate process (binary: `mcptool`) but shares the same Docker image and database as your main bot. It exposes an HTTP server that Claude connects to via a secure tunnel (handled by your Traefik setup).

## 2. Pocket-ID Configuration

Before deploying, you need to set up an OIDC client in Pocket-ID.

1.  **Log in** to your Pocket-ID instance.
2.  **Create a new Client**:
    *   **Name**: Claude Health MCP
    *   **Redirect URIs**: `https://claude.ai/api/mcp/auth_callback` AND `https://claude.com/api/mcp/auth_callback` (add both to be safe)
    *   **Access Type**: Public (or Confidential - MCP implementation is confidential client)
    *   **Trust Level**: High (recommended)
3.  **Note Credentials**: Copy the `Client ID` and `Client Secret`.
4.  **Get User Subject**:
    *   You need your unique User Subject UUID (`sub` claim) to restrict access.
    *   You can find this in your Pocket-ID user profile or by inspecting an ID token.

## 3. Docker Compose Configuration

Add a new service to your `docker-compose.yml` file to run the MCP server.

```yaml
  mcp-server:
    image: ghcr.io/korjavin/medicationtrackerbot:latest
    container_name: medtracker-mcp
    restart: unless-stopped
    command: ["./mcptool"]  # Override default command to run MCP server
    volumes:
      - medtracker_data:/app/data:ro  # Read-only access to data
    environment:
      - MCP_PORT=8081
      - MCP_DATABASE_PATH=/app/data/meds.db
      - MCP_MAX_QUERY_DAYS=90
      - MCP_SERVER_URL=https://mcp.yourdomain.com  # Your public MCP URL
      - MCP_ALLOWED_SUBJECT=your-user-uuid-here    # From Pocket-ID
      - POCKET_ID_URL=https://id.yourdomain.com
      - POCKET_ID_CLIENT_ID=your-client-id
      - POCKET_ID_CLIENT_SECRET=your-client-secret
      - TZ=${TZ:-Europe/Berlin}
    networks:
      - default
      - traefik_net
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.medtracker-mcp.rule=Host(`mcp.yourdomain.com`)" # Choose a subdomain
      - "traefik.http.routers.medtracker-mcp.entrypoints=websecure"
      - "traefik.http.routers.medtracker-mcp.tls.certresolver=myresolver"
      - "traefik.http.services.medtracker-mcp.loadbalancer.server.port=8081"
```

> [!IMPORTANT]
> Make sure `MCP_SERVER_URL` matches the Host rule in Traefik labels.

## 4. Deploying

1.  **Rebuild Docker Image** (to include the new `mcptool` binary):
    ```bash
    docker build -t ghcr.io/korjavin/medicationtrackerbot:latest .
    ```
    *(Or pull the new image if configured via CI/CD)*

2.  **Update Config**: Edit `.env` or `docker-compose.yml` with the environment variables.

3.  **Restart Stack**:
    ```bash
    docker-compose up -d
    ```

## 5. Configuring Claude

1.  Open **Claude Desktop** or **Claude.ai** (when MCP is enabled).
2.  Go to **Settings** -> **MCP**.
3.  Add a new MCP Server:
    *   **Type**: SSE / HTTP
    *   **URL**: `https://mcp.yourdomain.com/mcp/sse` (or just `/mcp` depending on SDK - our implementation supports HTTP transport)
    *   **Wait**: Currently Claude.ai MCP supports local stdio primarily. For remote HTTP MCP, you might need a local relay or wait for full remote support.
    
    *Additional Note*: If you are using Claude Desktop, you might need to run a local `mcp-proxy` or configure it to connect to your remote URL.
    
    **If using Claude Desktop with Stdio (Alternative Local Run):**
    You can also run the binary locally pointing to a local DB copy:
    ```json
    {
      "mcpServers": {
        "health-tracker": {
          "command": "/path/to/mcptool",
          "env": {
             "MCP_DATABASE_PATH": "..."
             ...
          }
        }
      }
    }
    ```

## 6. Verification

1.  Check logs: `docker logs medtracker-mcp`
2.  Verify health check: `curl https://mcp.yourdomain.com/health` -> should return `ok`.
3.  Ask Claude: "What was my blood pressure last week?" -> It should prompt for Pocket-ID login.
