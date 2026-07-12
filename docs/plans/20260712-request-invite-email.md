# Cloud landing page: configurable "request an invite" contact line (med-eas.52)

## Overview
The cloud base-domain landing page (`web/cloud/index.html`) says "Invitations
only. There is no public signup here — … contact the operator who invited you."
but never tells a prospective user HOW to reach the operator. Add a contact line
with a working `mailto:` link whose address comes from a NEW operator env var
`REQUEST_INVITE_EMAIL`.

Behavior contract:
- **Env set** → landing page shows: "Contact us if you'd like an invite and
  aren't sure where to get one: <email>" with a `mailto:<email>` link.
- **Env unset (default)** → NO contact line; page is byte-identical to today.
- The email is HTML-escaped in both the visible text and the `mailto:` href
  (no HTML/attribute injection via the env value).

## Context (from discovery)
- Landing page is a **static file** served by `Handler.shell`
  (`http.FileServerFS(shellFS)`) for `host == baseDomain` in
  `internal/cloudserver/router.go` `ServeHTTP`. It does NOT receive the
  `window.__MEDTRACKER_CLOUD__` / `injectCloudBoot` treatment — that only
  applies to the per-subdomain app document (`appIndex`).
- The base-domain shell serves under a strict CSP: `script-src 'self'`,
  `style-src 'self'` (`setSecurityHeaders(w, false, nil)`), so **no inline
  script and no inline style** may be added to the landing page. The cleanest
  path is therefore **server-side HTML injection of a plain `<p><a mailto>`**,
  not a JS render.
- Existing escaping helper in the same file: `html.EscapeString` (already used
  by `injectCloudBoot` for the food-db meta). Reuse it.
- `cloudserver.New(...)` already has 8 params and ~35 test call sites pass
  literal defaults. Adding a 9th param churns all of them. There is an
  established **post-construction setter** precedent: `SetMCPHandler`. Use the
  same pattern (`SetRequestInviteEmail`) so only `cmd/cloud/main.go` changes and
  no existing test caller is touched.
- Config lives in `cmd/cloud/main.go` `loadConfig()` — env-only, no flags.
  Read `REQUEST_INVITE_EMAIL` there.
- Docs: `docs/environment.md` (Cloud service section, ~line 59) lists
  `CLOUD_*` / `VAPID_SUBJECT`; `docs/cloud-deployment.md` lists operator env.

## Development Approach
- NO unit tests scaffolding. One integration-style Go router test guards the
  real boundary (landing page rendering with/without the env, and escaping).
- Smallest working diff; reuse `html.EscapeString` and the `SetMCPHandler`
  setter pattern. Do not build a config system for one string.
- Default (unset) behavior MUST be identical to today.

## Testing Strategy
- **Unit tests**: none.
- **Integration tests**: one Go test in `internal/cloudserver/router_test.go`
  exercising `Handler.ServeHTTP` on the base domain — this guards a real
  boundary (rendered HTML + escaping + unset default) that manual checking
  can't guarantee across regressions.
- **E2E tests**: none (no existing suite covers this).

## Progress Tracking
- Mark completed items `[x]` immediately.
- ➕ for newly discovered tasks, ⚠️ for blockers.

## Implementation Steps

### Task 1: Read REQUEST_INVITE_EMAIL in cmd/cloud config
- [x] add `requestInviteEmail string` field to the `config` struct in
  `cmd/cloud/main.go`
- [x] set it from `os.Getenv("REQUEST_INVITE_EMAIL")` in `loadConfig()`
  (no validation, no default — empty means "no contact line")

### Task 2: Landing-page injection in the router
- [ ] in `internal/cloudserver/router.go` `New(...)`, read the shell's
  `index.html` from `shellFS` (`fs.ReadFile(shellFS, "index.html")`) and store
  the raw bytes on the `Handler` (e.g. `landingRaw []byte`); panic if missing
  (it is a required embedded asset, mirroring the appFS read)
- [ ] add a `landingIndex []byte` field on `Handler` (nil = serve the raw shell
  file unchanged, i.e. today's behavior)
- [ ] add `func (h *Handler) SetRequestInviteEmail(email string)`: on non-empty
  email, compute `h.landingIndex` by injecting the contact `<p>` before
  `</main>`; on empty email, leave `landingIndex` nil (no-op)
- [ ] add an `injectRequestInvite(idx []byte, email string) []byte` helper that
  builds `<p>Contact us if you'd like an invite and aren't sure where to get
  one: <a href="mailto:ESC">ESC</a></p>` where `ESC = html.EscapeString(email)`
  (escaped in BOTH the visible text and the href), inserted before the
  `</main>` marker; panic if the marker is absent (guards a broken real asset)
- [ ] in `ServeHTTP`, in the `host == h.baseDomain` branch, when
  `h.landingIndex != nil` AND the request path is `/` or `/index.html`, write
  `h.landingIndex` with `Content-Type: text/html; charset=utf-8`; otherwise fall
  through to `h.shell.ServeHTTP` unchanged
- [ ] no hardcoded colors / inline styles: the injected `<p>`/`<a>` use the
  page's existing `.landing` inherited styles (a plain `<p>`, no `style=` attr)

### Task 3: Wire the setter in cmd/cloud/main.go
- [ ] after `router := cloudserver.New(...)` (and near
  `router.SetMCPHandler(...)`), call
  `router.SetRequestInviteEmail(cfg.requestInviteEmail)`

### Task 4: Router test for the contact line
- [ ] add `TestRouter_RequestInviteEmail` in
  `internal/cloudserver/router_test.go` using a `fstest.MapFS` whose
  `index.html` contains a `<main class="landing">…</main>` body:
  - unset (setter not called) → GET base `/` body contains no `mailto:`
  - set to `ops@example.com` → GET base `/` body contains
    `mailto:ops@example.com` and the visible address
  - set to an injection payload (e.g. `a"><script>@x.test`) → body contains the
    HTML-escaped form and NOT a raw `<script>` / unescaped `">`

### Task 5: Verify acceptance criteria
- [ ] `npx vitest run` passes (frontend untouched — must stay green)
- [ ] `go build ./... && go build -tags mobile ./...`
- [ ] `TZ=UTC go test ./internal/cloudserver/... ./cmd/cloud/...`
- [ ] unset-env path renders the landing page identical to today
- [ ] email is escaped in both text and href

### Task 6: [Final] Documentation
- [ ] add `REQUEST_INVITE_EMAIL` to `docs/environment.md` under the Cloud
  service (`cmd/cloud`) section, describing: optional; sets the "request an
  invite" contact address on the landing page; unset = no contact line
- [ ] add a one-line mention to `docs/cloud-deployment.md`'s operator env list

## Technical Details
- `REQUEST_INVITE_EMAIL` is a plain string (an email address). No format
  validation — an operator misconfiguring it only affects their own landing
  page copy, and we escape it regardless.
- Injection marker: `</main>` (the real `web/cloud/index.html` closes its
  `<main class="landing">` with it). Insertion is a single `bytes.Replace`.
- Escaping: `html.EscapeString` neutralizes `< > & " '`, which is sufficient to
  prevent both element injection (visible text) and attribute breakout
  (double-quoted href).

## Post-Completion
**Manual verification** (optional):
- Deploy with `REQUEST_INVITE_EMAIL=hello@example.com`, load the apex domain,
  confirm the contact line + working mailto link; unset it and confirm the line
  disappears.

**External system updates**:
- Operators who want the line must add `REQUEST_INVITE_EMAIL` to their cloud
  stack env (documented in environment.md / cloud-deployment.md).
