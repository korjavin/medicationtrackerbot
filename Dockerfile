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

EXPOSE 8080
CMD ["./bot"]
