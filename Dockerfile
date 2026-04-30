FROM golang:1.26.1-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
COPY . .
# CGO_ENABLED=0 for static binary, works with Checkpoint/ModernC SQLite
RUN CGO_ENABLED=0 GOOS=linux go build -o bot ./cmd/bot
RUN CGO_ENABLED=0 GOOS=linux go build -o mcptool ./cmd/mcptool

FROM alpine:latest
WORKDIR /app

# Install dependencies including su-exec for privilege dropping. Python is
# bundled so the MCP server's in-process executor (internal/mcp/executor)
# can spawn the sandbox runner from python/runner/runner.py without
# requiring a side container in MVP deployments.
RUN apk add --no-cache tzdata ca-certificates su-exec python3

COPY --from=builder /app/bot .
COPY --from=builder /app/mcptool .
COPY --from=builder /app/web ./web
# Vendor the Python helper + runner so the executor can spawn it in-process.
# The helper has no third-party deps (urllib + json from stdlib), which is
# why we don't need pip in the runtime image.
COPY --from=builder /app/python ./python
COPY entrypoint.sh /entrypoint.sh

# Replace TIMESTAMP_PLACEHOLDER with actual build time for cache busting
RUN BUILD_TIME=$(date +%s) && \
    sed -i "s/TIMESTAMP_PLACEHOLDER/$BUILD_TIME/g" /app/web/static/index.html

# Make entrypoint executable and create non-root user
RUN chmod +x /entrypoint.sh && \
    addgroup -g 1000 appuser && \
    adduser -D -u 1000 -G appuser appuser && \
    chown -R appuser:appuser /app

# Don't set USER here - entrypoint will handle privilege dropping
# This allows the container to fix volume permissions on startup

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
CMD ["./bot"]
