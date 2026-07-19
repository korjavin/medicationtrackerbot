# Cloud feedback channel — server: blind queue + intake endpoint + ENV recipient (bd med-dni.1)

## Overview

First slice of the cloud user-feedback channel (epic med-dni). Anyone in cloud mode
can send feedback/bug reports (text, voice, screenshot) to the developer. This task
builds the **server foundation only** — later beads (med-dni.2/.3) build the browser
capture UI and the age-encrypt + reliable submit queue, med-dni.4 the developer
decrypt CLI, med-dni.5 the Telegram channel.

Server responsibilities (this task):
- A new **blind queue** table in `internal/cloudstore` that stores an opaque,
  client-age-encrypted ciphertext blob the server can never read (consistent with the
  zero-knowledge model — same posture as inbox/envelope storage).
- `POST /api/feedback` — an authenticated endpoint that accepts one age-armored blob +
  minimal non-PII metadata and appends it to the queue, idempotently.
- Serve the developer's **age X25519 recipient public key** from an ENV var
  (`FEEDBACK_AGE_RECIPIENT`) to the browser via a `<meta>` tag, so the client
  (med-dni.3) can encrypt to it. When the ENV var is unset the feature is disabled: no
  meta tag is emitted and the endpoint returns 503.

**Cloud-first.** All changes are in `internal/cloudstore`, `internal/cloudserver`,
`cmd/cloud`. No bot-mode (`internal/server`) changes. age is client-side only (not a Go
dep) — the server treats the blob as opaque bytes.

## Context (from discovery)

- **Route pattern** — topic struct + `New*API(store, sessionSecret)` + `RegisterRoutes(mux)`
  mounting `mux.Handle("POST /api/...", RequireSession(store, sessionSecret, http.HandlerFunc(h)))`.
  Copy `internal/cloudserver/inbox.go:44-58`. Auth'd account id inside a handler:
  `session, ok := SessionFromContext(r.Context())` → `session.AccountID`
  (`inbox.go:72-76`). Wire the new API in `cmd/cloud/main.go` (~`:215` construct,
  ~`:230-238` `RegisterRoutes(apiMux)`).
- **Migration** — `//go:embed migrations/*.sql` (`internal/cloudstore/repo.go:26-27`),
  run in `New()` via `d.Migrate(...)` (`repo.go:119-124`). Next file is
  **`018_feedback.sql`** (goose Up/Down, copy `migrations/012_inbox.sql`).
- **Store repo** — methods hang off `*Repo` (`repo.go:114-116`); opaque-blob append
  template is `AppendInboxEvent` (`internal/cloudstore/inbox.go:44-50`). Timestamps are
  `*_unix INTEGER` via `storedb.TimeToUnix` / `UnixToTime` — never DATETIME.
- **Account-cascade guard** — a table with `account_id` MUST be added to
  `accountKeyedTables` (`repo.go:521-536`) or `TestDeleteAccountLeavesNoRows` fails.
- **Idempotent insert** — no `INSERT OR IGNORE` in this codebase; the idiom is a UNIQUE
  column + `INSERT ... ON CONFLICT(col) DO NOTHING` (mirror `UpsertPushSubscription`,
  `internal/cloudstore/push.go:27-33`). Use `client_id TEXT UNIQUE`.
- **ENV → browser** — read `os.Getenv` in `cmd/cloud/main.go` (~`:50-62`), thread through
  `cloudserver.New(...)` (`main.go:280`), emit a `<meta>` in `injectCloudBoot`
  (`internal/cloudserver/router.go:148-169` — `html.EscapeString` the content). Client
  reads via `document.querySelector('meta[name="..."]')?.content` (pattern:
  `web/cloud/js/fooddb.js:10-22`). A new `Getenv` name must be added to the list
  `cmd/cloud/env_compose_test.go:29` scrapes.
- **No MCP-coverage guard on cloud routes** — that test is bot-mode only
  (`internal/server`); `internal/cloudserver/router_test.go` has no route-registry test.
  A new `/api/feedback` route needs no exempt entry.

## Development Approach

- **Testing approach**: Regular (code, then tests) — each task ends with passing tests.
- Go changes only (+ one tiny JS meta reader). Store test uses the in-memory/temp DB
  harness the other `internal/cloudstore` tests use; handler test uses the
  `RequireSession` + `httptest` harness the other `internal/cloudserver` tests use
  (copy `inbox_test.go` / `push_test.go`).
- `go test ./internal/cloudstore/... ./internal/cloudserver/... ./cmd/cloud/...` must
  pass before moving on. Final task also runs `go build ./...` + `go build -tags mobile ./...`.

## Progress Tracking
- Mark `[x]` immediately. `➕` new task, `⚠️` blocker.

## Implementation Steps

### Task 1: feedback_queue table + cloudstore repo methods
- [x] Add `internal/cloudstore/migrations/018_feedback.sql` (goose Up/Down, copy the
      shape of `012_inbox.sql`): table `feedback_queue` with
      `id INTEGER PRIMARY KEY AUTOINCREMENT`,
      `account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE`,
      `client_id TEXT NOT NULL UNIQUE`, `kind TEXT NOT NULL DEFAULT ''`,
      `app_version TEXT NOT NULL DEFAULT ''`, `ciphertext BLOB NOT NULL`,
      `created_at_unix INTEGER NOT NULL`. Index on `created_at_unix` for the drain order.
- [x] Add `internal/cloudstore/feedback.go`: `AppendFeedback(ctx, accountID, clientID, kind, appVersion string, ciphertext []byte, now time.Time) error`
      using `INSERT ... ON CONFLICT(client_id) DO NOTHING` (idempotent retry-safe);
      `ListFeedback(ctx, limit int) ([]FeedbackItem, error)` ordered by `created_at_unix ASC`
      (for the med-dni.4 CLI drain); `DeleteFeedback(ctx, id int64) error`. Define
      `type FeedbackItem struct` (Id, AccountID, ClientID, Kind, AppVersion, Ciphertext, CreatedAt).
- [x] Add `"feedback_queue"` to `accountKeyedTables` (`internal/cloudstore/repo.go:521-536`).
- [x] Write `internal/cloudstore/feedback_test.go`: append→list round-trip (ciphertext
      bytes preserved verbatim); duplicate `client_id` append is a no-op (still one row);
      delete removes it; list respects `limit` + ASC order.
- [x] Run `go test ./internal/cloudstore/...` (incl. `TestDeleteAccountLeavesNoRows`) — must pass before Task 2.

### Task 2: POST /api/feedback handler (blind append, idempotent, disabled-guard)
- [x] Add `internal/cloudserver/feedback.go`: `FeedbackAPI{store, sessionSecret, recipient string}`,
      `NewFeedbackAPI(store, sessionSecret, recipient string)`, `RegisterRoutes(mux)` mounting
      `POST /api/feedback` under `RequireSession` (copy `inbox.go:44-58`).
- [x] Handler `SubmitFeedback`: if `recipient == ""` → 503 (feature disabled). Read body
      under `http.MaxBytesReader` (cap ~5 MB — audio/screenshot ciphertext; name a const).
      Accept JSON `{ "client_id", "kind", "app_version", "ciphertext" }` where `ciphertext`
      is base64 (age-armored ASCII would also work, but base64-of-bytes keeps it opaque).
      Validate `client_id` non-empty and `ciphertext` decodes + non-empty; 400 otherwise.
      Get `session.AccountID` via `SessionFromContext`. Call `store.AppendFeedback(...)`
      with `time.Now()`. Return 204 on success (dedupe makes retries safe).
- [x] Write `internal/cloudserver/feedback_test.go` (copy the `RequireSession`+`httptest`
      harness from `inbox_test.go`/`push_test.go`): happy-path 204 stores one row scoped to
      the session account; retry with same `client_id` → still 204, still one row; empty
      recipient → 503; oversized body → 413; missing `client_id` / bad base64 → 400; no
      session → 401.
- [x] Run `go test ./internal/cloudserver/...` — must pass before Task 3.

### Task 3: serve FEEDBACK_AGE_RECIPIENT (ENV → meta tag) + client reader
- [x] `cmd/cloud/main.go`: read `feedbackAgeRecipient: os.Getenv("FEEDBACK_AGE_RECIPIENT")`
      (~`:50-62`), thread it into `NewFeedbackAPI(...)` at construction and into the router
      via `router.SetFeedbackRecipient(...)`. Used a setter (mirroring
      `SetRequestInviteEmail`/`SetMCPHandler`) instead of a `New` param to avoid churning the
      ~35 `New` call sites — the food-db meta lives in `appIndex`, which the setter splices.
- [x] `internal/cloudserver/router.go` `SetFeedbackRecipient`: when the recipient is
      non-empty, splice `<meta name="medtracker-feedback-age-recipient" content="...">` after
      `<head>` in the built `appIndex` (`html.EscapeString` the value, same as the food-db
      meta). When empty, emit nothing.
- [x] Add `FEEDBACK_AGE_RECIPIENT` to `docker-compose.cloud.yml` (env_compose_test scrapes
      `Getenv` against compose) so that test stays green.
- [x] `web/cloud/js/feedback-config.js` (tiny): export `getFeedbackRecipient()` reading
      `document.querySelector('meta[name="medtracker-feedback-age-recipient"]')?.content || ''`
      (mirror `fooddb.js:10-22`). Consumed by med-dni.3; kept minimal here.
- [x] Tests: extended `internal/cloudserver/router_test.go` (`TestRouter_FeedbackRecipientMeta`)
      — app document with a recipient set includes the escaped meta tag and does not widen
      connect-src (feedback POSTs to same-origin `/api/feedback`, no bare-scheme token); with
      it unset the meta is absent.
- [x] Run `go test ./internal/cloudserver/... ./cmd/cloud/...` — passed.

### Task 4: wire, verify, docs
- [x] Confirm `FeedbackAPI.RegisterRoutes(apiMux)` is called in `cmd/cloud/main.go`
      alongside the other APIs. (main.go:241)
- [x] Run `go build ./...` + `go build -tags mobile ./...` (mobile must still compile —
      cloud files are server-only but the whole tree must build under both tags). Both pass.
- [x] Run `go test ./internal/cloudstore/... ./internal/cloudserver/... ./cmd/cloud/...`
      and `gofmt`/`go vet` on changed files — all green.
- [x] Update `docs/environment.md` with `FEEDBACK_AGE_RECIPIENT` (age X25519 recipient
      pubkey; unset = feedback disabled) and add a one-line note to `docs/cloud-mode.md`
      pointing at the feedback queue as the med-dni epic's server foundation.

### Task 5: Verify acceptance criteria
- [ ] `POST /api/feedback` stores an opaque ciphertext blob scoped to the session account,
      idempotent on `client_id`, 503 when disabled, size-capped.
- [ ] The queue table is blind (ciphertext BLOB only; no plaintext content column) and
      cascades on account delete (`TestDeleteAccountLeavesNoRows` green).
- [ ] The recipient pubkey is exposed to the browser via meta only when configured.
- [ ] Full server + mobile builds pass; the three affected test packages pass.

## Technical Details

- **Blind by construction**: the only content column is `ciphertext BLOB`. The server
  never has the age private key (that lives with the developer, med-dni.4). Metadata
  columns (`kind`, `app_version`) are non-PII and optional.
- **Idempotency**: `client_id` is a client-generated unique id; `ON CONFLICT DO NOTHING`
  makes the reliable-retry client (med-dni.3) safe to POST the same item repeatedly over
  a flaky connection without dupes.
- **Disabled state**: unset `FEEDBACK_AGE_RECIPIENT` → no meta (client hides the UI) and
  503 from the endpoint. One switch controls the whole feature.
- **Size cap**: `http.MaxBytesReader` at the handler; a screenshot+voice ciphertext is
  the large case. 5 MB const, adjust if med-dni.2 attachment limits differ.

## Post-Completion

**Manual verification** (cloud deploy): set `FEEDBACK_AGE_RECIPIENT` to a real age
recipient, `curl -X POST /api/feedback` with a session cookie + a base64 blob, confirm a
row lands in `feedback_queue` and re-POST with the same `client_id` is a no-op. Decrypt
side is med-dni.4.

**Follow-on beads**: med-dni.2 (capture UI), med-dni.3 (age-encrypt + reliable submit
queue, consumes `getFeedbackRecipient()`), med-dni.4 (dev decrypt CLI, consumes
`ListFeedback`/`DeleteFeedback`), med-dni.5 (Telegram channel).
