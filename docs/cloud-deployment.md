# Cloud-mode deployment

Self-hosted deployment guide for the `cloud` binary (`cmd/cloud`): a zero-knowledge
cloud service on wildcard subdomains. See [cloud-mode.md](cloud-mode.md) for the
design and [cloud-crypto.md](cloud-crypto.md) for the crypto spec.

Two-layer setup: a static infra layer (Traefik + Portainer) run once with plain
`docker compose`, and the app stack deployed as a Portainer gitops stack —
mirroring this repo's existing bot deployment pattern.

## 1. DNS

Point both `<base>` and `*.<base>` at the server's IP. On Cloudflare, set the
wildcard record to **DNS only (grey cloud)**, not proxied — Cloudflare's proxy
only covers `*.<apex>` wildcards on paid plans, and proxying would terminate
TLS at Cloudflare instead of the origin's wildcard cert.

## 2. Infra layer (once, on the fresh server)

Mint a scoped Cloudflare API token: Zone → DNS → Edit, restricted to the single
zone containing your base domain.

```bash
cp .env.infra.cloud.example .env
# fill in CLOUD_BASE_DOMAIN, ACME_EMAIL, CF_DNS_API_TOKEN
docker compose -f docker-compose.infra.cloud.yml up -d
```

Verify the wildcard cert issues on first request (`docker compose -f
docker-compose.infra.cloud.yml logs traefik`) and that individual subdomains
don't leak into public CT logs (DNS-01 issuance for the wildcard doesn't log
per-subdomain names).

## 3. App stack (Portainer gitops)

Open `https://portainer.<base>`, finish the initial admin setup, then:

1. Create a stack from a Git repository: this repo, `deploy` branch,
   compose path `docker-compose.cloud.yml`.
2. Set stack env vars: `CLOUD_BASE_DOMAIN`, `SESSION_SECRET` (≥32 chars,
   Shannon entropy ≥3.5 — same rule as the bot's session secret).
3. Enable the stack's redeploy webhook and append its URL as a new line in
   the `PORTAINER_REDEPLOY_HOOK` GitHub secret (multiline — one URL per line,
   same secret the bot stack already uses).

Operators who don't want gitops can instead run
`docker compose -f docker-compose.cloud.yml up -d` directly against the same
external `proxy` network.

## 4. Mint the first invite

```bash
docker exec -it medtracker-cloud ./cloud admin invite
```

Prints the claim URL (and a terminal QR) for the operator to hand to the
first user. See [cloud-mode.md](cloud-mode.md) for the claim → passkey →
Emergency Kit flow this link starts.

## Local dev loop

`CLOUD_BASE_DOMAIN=localhost` works without any DNS or infra: `*.localhost`
subdomains are secure contexts and resolve without configuration, giving a
full local loop including passkeys on desktop.
