# Sandbox browser-direct BYO provider calls to restore connect-src 'self'

## Overview

The cloud-mode account app (`<account>.<baseDomain>`) is a DEK-bearing document:
it holds the in-memory Data Encryption Key and decrypted health records. Its CSP
currently relaxes `connect-src` to `'self' https: wss:` because three browser-direct
BYO-provider modules make cross-origin calls whose destinations are user-configured
(vault secrets) and therefore unknowable server-side. That relaxation means an
on-origin XSS can POST the DEK + decrypted records to **any** `https:` origin —
rated CATASTROPHIC in `docs/cloud-crypto.md`.

This change moves the BYO cross-origin provider calls into a **sandboxed iframe with
an opaque origin** (served from a dedicated path with its own relaxed CSP), so the
DEK-bearing app page can restore a strict `connect-src`. The iframe is pinned to its
provider destinations **once at unlock** and thereafter accepts only per-call payload
messages — a later stored-XSS in the parent cannot repoint it at an attacker origin
(worst case it relays to the user's own provider, not the attacker), and cannot script
into the iframe (opaque origin, postMessage-only).

**Owner design decisions (locked — do not re-litigate):**
1. Real fix via a sandboxed iframe (opaque origin, `sandbox` without `allow-same-origin`).
2. Destination pinned at unlock, immutable for the session; parent sends only `{payload}` afterward.

**Acceptance criteria (from bd med-tc1.6):** app-page `connect-src` is `'self'` (plus
`wss:` only if unavoidable); provider calls run in a context with no DEK access;
`TestRouter_HostVariants` extended to pin the new policy.

## Context (from discovery)

- **BYO modules (move the cross-origin calls into the iframe):**
  - `web/cloud/js/aiclient.js` — BYO OpenAI-compatible chat/vision, POST `${openai.url}/chat/completions`, `Authorization: Bearer`. Has a **same-origin trial fallback** `/api/trial/openai/...` (NOT BYO) that must stay parent-side.
  - `web/cloud/js/fooddb.js` — BYO FastFoodDB GET search/barcode, `X-API-Key`. Has a **same-origin operator-default fallback** `/api/food/...` that must stay parent-side.
  - `web/cloud/js/elevenlabs-agent.js` + `web/cloud/js/elevenlabs-signed-url.js` — `https://api.elevenlabs.io` REST (tools/agents provisioning + get_signed_url), header `xi-api-key`. Note: `elevenlabs-agent.js` also does **vault reads/writes** via `getVoiceProvisioning`/`setVoiceProvisioning` — those need the DEK and stay parent-side; only the `api.elevenlabs.io` HTTP calls move.
- **Leave in-page (do NOT move):** the `@elevenlabs/client` voice SDK in `web/static/js/features/elevenlabs-call.js` opens the live `wss://api.elevenlabs.io` socket + AudioWorklets + mic. `api.elevenlabs.io` is a fixed host (only the api_key is BYO), so the app page scopes `connect-src` to `'self' wss://api.elevenlabs.io` — the AC's permitted "wss: only if unavoidable". This still closes the attacker-exfil path.
- **Single credential seam:** all four modules read secrets only through `settingsDomain.readIntegrationsUnmasked()` (`web/domain/settings.js`; vault singleton recordType `integrations`; groups `openai{api_key,url,model,vision_*}`, `food{api_key,url,domain}`, `elevenlabs{api_key,agent_id}`; plus `voiceprovisioning` singleton).
- **Single construction site:** `installApiShim` (`web/cloud/js/apishim.js:717-783`), reached from `cloud-boot.js:175` — the one post-unlock "vault open" join point. Publishes `window.CloudFoodAI` (`:745`), `window.CloudFoodSearch` (`:749`), `window.CloudElevenLabs` (`:753`), `window.CloudElevenLabsAgent` (`:758`). Consumers: `web/static/js/features/{food/photo.js,food/log.js,food/products.js,elevenlabs-call.js}` and `web/cloud/js/inbox-apply.js`. Keep the global method signatures identical — turn each into a thin postMessage proxy.
- **CSP is path-driven:** `internal/cloudserver/router.go` `setSecurityHeaders(w, accountApp bool)` (`:156-177`); `accountApp` computed at `:181` = `host != baseDomain && isAppPath(path)`; `isAppPath` (`:315-317`) = `/`, `/static/`, `/domain/`. Static assets served via `http.FileServerFS` over `cloudweb.FS`/`webstatic.FS`/`domainweb.FS`; `web/cloud/embed.go` `//go:embed index.html signup.html sw.js css js vendor`.
- **Tests:** `TestRouter_HostVariants` (`internal/cloudserver/router_test.go:104-202`) asserts per-path `connect-src`/`script-src`/`worker-src`; a med-7e7.1 invariant asserts `script-src` contains no `//` (no third-party host).
- **No existing frame-messaging pattern** — this establishes the first one. (Only Service-Worker postMessage exists.)

## Development Approach
- **Testing approach**: NO unit tests. The one integration test that adds a real guarantee is the router-CSP test (`TestRouter_HostVariants`), which the AC explicitly requires — extend it. Do not add per-module JS unit tests; extend the existing cloud frontend suite only if a proxy behavior needs a real guarantee.
- Complete each task fully before the next; small focused changes; keep the existing test suite green throughout.
- **Preserve the four `window.Cloud*` global method signatures** so consumers in `web/static/js/features/*` are untouched (backward compatibility).
- **CRITICAL: update this plan file when scope changes during implementation.**

## Testing Strategy
- **Unit tests**: none.
- **Integration tests**: extend `TestRouter_HostVariants` (real boundary — the served CSP per path). Extend the cloud frontend suite (`web/cloud/js/tests/`) only where a proxy round-trip needs a guarantee jsdom can actually give.
- **E2E tests**: none new. Live provider round-trips (AI parse, food search, ElevenLabs) are manual — Post-Completion.

## Progress Tracking
- Mark completed items `[x]` immediately.
- New tasks: plus-prefix. Blockers: warning-prefix.
- Keep the plan in sync with actual work.

## Implementation Steps

### Task 1: Sandboxed provider-call iframe document + message protocol
- [ ] add `web/cloud/provider-sandbox.html` — minimal document that loads only `js/provider-sandbox.js` (no DEK, no app JS, no vault, no service worker)
- [ ] add `web/cloud/js/provider-sandbox.js` implementing a request/response `postMessage` protocol with correlation ids: an `init` message pins provider config **once** (subsequent `init` messages are ignored/rejected); `call` messages dispatch `{ module, method, args }` and post back `{ id, ok, result | error }`; validate `event.origin` is the account origin
- [ ] inside the iframe, construct the BYO modules (`aiclient`, `fooddb`, `elevenlabs-agent` HTTP surface, `elevenlabs-signed-url`) backed by a **synthetic `settingsDomain`** whose `readIntegrationsUnmasked()` returns the config pinned at `init` — reuse the existing modules unchanged where possible
- [ ] add `provider-sandbox.html` + `js/provider-sandbox.js` to the `//go:embed` list in `web/cloud/embed.go`

### Task 2: Serve the iframe path with a dedicated CSP; restore the app-page connect-src
- [ ] `internal/cloudserver/router.go`: replace the 2-way `accountApp bool` in `setSecurityHeaders` with a 3-mode selector (base shell / app page / sandbox frame) — sandbox-frame mode = `connect-src 'self' https: wss:`, `script-src 'self'` (no blob/data — the moved modules need neither), no `worker-src`/`media-src`, and **`frame-ancestors 'self'`** so the app page may embed it (the app page's `X-Frame-Options: DENY` must NOT be applied to the sandbox-frame response — use `SAMEORIGIN`/CSP `frame-ancestors 'self'` for that path)
- [ ] change the app-page branch: `connect-src 'self' wss://api.elevenlabs.io` (drop bare `https:` and bare `wss:`); keep `script-src 'self' blob: data:` + `worker-src`/`media-src blob:` for the in-page voice SDK
- [ ] route the new sandbox path (e.g. `/provider-sandbox`) in `ServeHTTP` to serve the iframe doc from `cloudweb.FS`, and make the CSP selector pick sandbox-frame mode for it (add a predicate alongside `isAppPath`)

### Task 3: Parent-side wiring — pin config at unlock, proxy the four globals
- [ ] `web/cloud/js/apishim.js` `installApiShim`: create a hidden `<iframe src="/provider-sandbox" sandbox>` (no `allow-same-origin`), read the three provider config groups via `settingsDomain.readIntegrationsUnmasked()` (+ voiceprovisioning), and `postMessage` a single `init` once the frame signals ready
- [ ] add a small parent-side iframe-RPC client (correlation ids to promise resolve/reject; timeout) and replace `window.CloudFoodAI` / `CloudFoodSearch` / `CloudElevenLabs` / `CloudElevenLabsAgent` with thin proxies that keep the **same method signatures**; the **BYO branch** dispatches to the iframe, the **same-origin fallback branch** (trial AI `/api/trial/...`, operator food-db `/api/food/...`) stays parent-side
- [ ] keep `elevenlabs-agent`'s vault I/O (`getVoiceProvisioning`/`setVoiceProvisioning`) parent-side; only its `api.elevenlabs.io` HTTP calls go through the iframe
- [ ] route `web/cloud/js/inbox-apply.js`'s `aiclient`/`fooddb` usage through the same iframe-backed proxies (no direct cross-origin fetch left on the DEK page)

### Task 4: Extend TestRouter_HostVariants to pin the new CSP
- [ ] app-page case: assert `connect-src` is `'self' wss://api.elevenlabs.io` and contains **no bare `https:`** token (extend the med-7e7.1-style directive helper to connect-src)
- [ ] add a sandbox-frame-path case: assert its relaxed `connect-src 'self' https: wss:`, `script-src 'self'` (no `//`), and `frame-ancestors 'self'` (framable by the app page), i.e. NOT `X-Frame-Options: DENY`
- [ ] keep the existing no-third-party-host-in-script-src invariant passing for every case

### Task 5: Verify acceptance criteria
- [ ] `go build ./...` and `go build -tags mobile ./...` clean
- [ ] `go test ./internal/cloudserver/...` green
- [ ] `pnpm test` green (frontend suite, incl. any extended cloud tests)
- [ ] grep the served app-page CSP: `connect-src` has no bare `https:`; the sandbox path's CSP does
- [ ] confirm no remaining direct cross-origin `fetch`/`WebSocket` to a BYO/`api.elevenlabs.io` REST origin executes on the DEK page (only the in-page voice `wss://api.elevenlabs.io` socket remains, which the scoped app-page CSP permits)

### Task 6: [Final] Update documentation
- [ ] update the `setSecurityHeaders` comment in `internal/cloudserver/router.go` (the current comment says sandboxing is "deferred" — describe the implemented sandbox-frame trust boundary)
- [ ] update `docs/cloud-crypto.md` and `docs/cloud-mode.md` CSP/trust-boundary sections to describe the provider-sandbox iframe and the pinned-at-unlock destination model
- [ ] append a note to the CLAUDE.md cloud-mode notes if a new invariant test was added

## Technical Details

- **Opaque origin & same-origin fallback:** the sandboxed iframe (no `allow-same-origin`) has a `null` origin, so a fetch back to `https://<account>.<base>/api/...` is cross-origin (Origin: null, no credentials). That is why the same-origin fallbacks (trial AI, operator food-db) **stay parent-side** — only genuinely-cross-origin BYO calls run in the iframe. The parent proxy decides BYO-vs-fallback (it has the DEK/config) and routes accordingly.
- **Message protocol:** `{ type:'init', config }` (once) then iframe replies `{ type:'ready' }`; `{ type:'call', id, module, method, args }` then `{ type:'result', id, ok, result|error }`. Parent validates `event.source === iframe.contentWindow`; iframe validates `event.origin === <account origin>`.
- **Config shape pinned at init:** the three `readIntegrationsUnmasked()` groups (`openai`, `food`, `elevenlabs`) + the `voiceprovisioning` fields the HTTP calls need (agent_id). No DEK, no LDK, no vault handle crosses the boundary.
- **CSP selector:** one `setSecurityHeaders` call site (`router.go:181`) chooses among {base shell, app page, sandbox frame} by path; the sandbox frame is the only relaxed-connect context and is DEK-free.

## Post-Completion
*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification (needs a live account + configured providers):**
- Configure a BYO OpenAI-compatible provider; run a food-photo parse and a chat — confirm it works through the iframe and that the DEK page's Network panel shows no cross-origin request from the app document.
- Configure a BYO food-DB; run a product search; confirm operator-default fallback still works when BYO is unset (parent-side, same origin).
- Configure ElevenLabs; run agent provisioning + a voice call — confirm REST goes through the iframe and the live `wss://api.elevenlabs.io` voice socket still connects from the app page under the scoped CSP.
- Confirm in DevTools that the app-page response `Content-Security-Policy` `connect-src` is `'self' wss://api.elevenlabs.io` and the `/provider-sandbox` response is the relaxed variant.

**Security review:**
- Confirm a simulated on-origin XSS on the app page can no longer `fetch`/`WebSocket` to an arbitrary attacker `https:` origin (blocked by `connect-src 'self' wss://api.elevenlabs.io`), and that postMessaging a forged destination to the iframe is rejected (config immutable after init).
