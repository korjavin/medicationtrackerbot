FROM golang:1.24-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
COPY . .
# CGO_ENABLED=0 for static binary, works with Checkpoint/ModernC SQLite
RUN CGO_ENABLED=0 GOOS=linux go build -mod=vendor -o bot ./cmd/bot

FROM alpine:latest
WORKDIR /app
RUN apk add --no-cache tzdata ca-certificates

COPY --from=builder /app/bot .
COPY --from=builder /app/web ./web

# Replace TIMESTAMP_PLACEHOLDER with actual build time for cache busting
RUN BUILD_TIME=$(date +%s) && \
    sed -i "s/TIMESTAMP_PLACEHOLDER/$BUILD_TIME/g" /app/web/static/index.html

# Create non-root user and switch to it
RUN addgroup -g 1000 appuser && \
    adduser -D -u 1000 -G appuser appuser && \
    chown -R appuser:appuser /app

USER appuser

EXPOSE 8080
CMD ["./bot"]
