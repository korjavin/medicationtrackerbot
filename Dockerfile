FROM golang:1.26.5-alpine AS builder

WORKDIR /app

# Download modules into the layer filesystem (no cache mount) so a layer-cache
# hit on this step — go.mod/go.sum unchanged — also carries the modules along.
# A cache-mount here would write modules to a separate BuildKit volume that the
# GHA layer-cache import does not restore, leaving /go/pkg/mod empty for the
# build step and forcing a full re-download on every CI run.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# Only ./cloud is shipped. cmd/bot, cmd/mcptool and cmd/seeddemo still exist in
# the tree and still compile under `go build ./...` in CI — they are simply not
# deployed anywhere any more, so they are not in the image.
# CGO_ENABLED=0 for static binary, works with Checkpoint/ModernC SQLite.
# Only mount the go-build cache here; mounting /go/pkg/mod would shadow the
# modules baked into the previous layer.
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -o cloud ./cmd/cloud

FROM alpine:latest
WORKDIR /app

RUN apk upgrade --no-cache && \
    apk add --no-cache tzdata ca-certificates su-exec

# cmd/cloud serves the frontend from go:embed (web/static/embed.go,
# web/cloud/embed.go), so there is no web tree to copy — the bytes are already
# in the binary. Python is gone with the MCP executor, which only ever ran in
# the bot / mcptool binaries.
COPY --from=builder /app/cloud .
COPY entrypoint.sh /entrypoint.sh

# Make entrypoint executable and create non-root user
RUN chmod +x /entrypoint.sh && \
    addgroup -g 1000 appuser && \
    adduser -D -u 1000 -G appuser appuser && \
    chown -R appuser:appuser /app

# Don't set USER here - entrypoint will handle privilege dropping
# This allows the container to fix volume permissions on startup

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
CMD ["./cloud"]
