# Cloud feedback channel — developer decrypt CLI (bd med-dni.4)

## Overview

Fourth slice of the cloud feedback channel (epic med-dni). The consumer side: a small
Go CLI the **developer** runs to drain the blind `feedback_queue`, **age-decrypt** each
item with the developer's private key (the counterpart to the `FEEDBACK_AGE_RECIPIENT`
pubkey clients encrypt to), print the feedback text + metadata, and save any image/voice
attachments to disk. Optionally ack (delete) drained items.

This closes the loop: med-dni.1 stores ciphertext blindly, med-dni.3 encrypts + reliably
uploads, med-dni.4 is the only place the age **private key** exists and plaintext is
recovered — never on the server.

**New Go dependency**: `filippo.io/age` (recipient/identity decrypt). age was previously
client-side JS only; this CLI is a dev/ops tool, not part of the shipped server or mobile
binary, so the dep lands in a `cmd/feedbackpull` package.

## Context (from discovery)

- **Store methods already shipped (med-dni.1)** — `internal/cloudstore/feedback.go`:
  `FeedbackItem{ID, AccountID, ClientID, Kind, AppVersion, Ciphertext []byte, CreatedAt}`;
  `ListFeedback(ctx, limit)` (oldest-first drain order, `:79`); `DeleteFeedback(ctx, id)`
  (idempotent ack, `:105`). `Ciphertext` is the **raw age v1 binary** — med-dni.1's
  handler base64-decodes the wire field before storing, so the CLI decrypts
  `item.Ciphertext` directly (no base64 step).
- **Open the store** — mirror `cmd/cloud/main.go:178-185`: `sharedDB, _ := storedb.Open(dbPath)`
  then `store, _ := cloudstore.New(sharedDB)`. (cloudstore imports only `internal/store/db`
  — the goose-registry landmine; the CLI must import `cloudstore` + `storedb` the same way
  cmd/cloud does, nothing from `internal/store`.)
- **CLI template** — `cmd/genvapid/main.go` (tiny standalone) and `cmd/seeddemo/main.go`
  (flags + opens the store, has a `main_test.go`) are the structure to copy.
- **Plaintext document format (contract from med-dni.3)** — the decrypted bytes are a v1
  JSON doc: `{ "v":1, "created_at":"<iso8601>", "text":"...", "attachments":[ { "type":"image"|"audio",
  "mime":"image/jpeg"|"audio/webm", "data_b64":"..." } ] }`. Cleartext DB metadata:
  `ClientID`, `Kind`, `AppVersion`, `CreatedAt`.
- **age Go API** — `age.ParseIdentities(r)` (identity file) or `age.ParseX25519Identity(s)`;
  `age.Decrypt(bytes.NewReader(item.Ciphertext), identities...)` → an `io.Reader` of
  plaintext.

## Development Approach

- **Testing approach**: Regular. The drain logic goes in a testable function (not `main`),
  so `main_test.go` can generate an age identity, encrypt a sample doc, seed an in-memory
  cloudstore, and assert text + attachments + ack.
- `go test ./cmd/feedbackpull/...` + `go build ./...` + `go build -tags mobile ./...`
  (the new cmd must not break either build; it's server-side tooling but the tree must
  compile under both tags — the mobile build simply won't include this cmd, confirm it
  doesn't get pulled in).

## Progress Tracking
- Mark `[x]` immediately. `➕` new, `⚠️` blocker.

## Implementation Steps

### Task 1: add filippo.io/age + the decrypt-one-item core
- [x] `go get filippo.io/age` (adds to go.mod/go.sum). Confirm it compiles and does NOT
      get linked into `go build -tags mobile ./cmd/bot` (it's only imported by
      `cmd/feedbackpull`, which mobile doesn't build). — verified: `go list -tags mobile -deps ./cmd/bot` shows 0 age refs.
- [x] Add `cmd/feedbackpull/main.go` with a testable core, e.g.
      `decodeItem(item cloudstore.FeedbackItem, ids []age.Identity) (feedbackDoc, error)`:
      `age.Decrypt(bytes.NewReader(item.Ciphertext), ids...)`, read all, `json.Unmarshal`
      into `type feedbackDoc struct { V int; CreatedAt string; Text string; Attachments []struct{ Type, Mime, DataB64 string } }`.
      Validate `V == 1`.
- [x] `saveAttachments(doc, item, outDir) ([]string, error)`: base64-decode each
      `DataB64`, write to `outDir` named `<client_id>-<i><ext>` (ext from mime:
      image/jpeg→.jpg, image/png→.png, audio/webm→.webm, fallback .bin). Return written
      paths. Create `outDir` if missing.
- [x] Tests `cmd/feedbackpull/main_test.go`: generate an identity via
      `age.GenerateX25519Identity()`, encrypt a sample v1 doc (text + one image + one
      audio attachment) with `age.Encrypt(...recipient...)`, wrap as a `FeedbackItem`,
      then `decodeItem` returns the text + attachments; `saveAttachments` writes files
      with the right extensions + bytes; a wrong-key item returns an error (not a panic);
      a `V != 1` doc errors.
- [x] Run `go test ./cmd/feedbackpull/...` — must pass before Task 2.

### Task 2: wire the CLI — flags, store drain, render, optional ack
- [ ] Flags: `-db` (cloud sqlite path, required), `-identity` (age identity file;
      default from `FEEDBACK_AGE_IDENTITY` env), `-out` (attachment output dir, default
      `./feedback`), `-limit` (default 100), `-delete` (ack items after a successful
      decrypt+save; default false), `-json` (optional: emit each item as a JSON line
      instead of the human render).
- [ ] `run(store *cloudstore.Repo, ids []age.Identity, outDir string, limit int, del, jsonOut bool, w io.Writer) error`:
      `ListFeedback(ctx, limit)`; for each item — `decodeItem` + `saveAttachments`; on
      success print a header (id, account_id, kind, app_version, created_at, saved
      attachment paths) + the text (or a JSON line); if `del` then `DeleteFeedback(id)`.
      **On decrypt/parse error for one item: log to stderr and continue** (never delete a
      failed item; don't abort the whole drain).
- [ ] `main()`: parse flags, load identities (`age.ParseIdentities`), open the store
      (`storedb.Open` → `cloudstore.New`), call `run(..., os.Stdout)`, exit non-zero on a
      fatal (bad flags / can't open DB / no identities), zero otherwise.
- [ ] Tests: `run` over a seeded in-memory store with two items (one decryptable, one
      wrong-key) prints the good one, saves its attachments, and with `-delete` acks
      **only** the good one (assert the bad item remains via `ListFeedback`); `-json`
      emits parseable lines; empty queue is a clean no-op.
- [ ] Run `go test ./cmd/feedbackpull/...` — must pass before Task 3.

### Task 3: verify + docs
- [ ] `go build ./...` + `go build -tags mobile ./...` (both green; confirm the age dep
      doesn't bloat the mobile binary — it isn't imported by mobile targets).
- [ ] `go vet ./cmd/feedbackpull/...`, `gofmt` clean.
- [ ] Docs: add `cmd/feedbackpull` to the `cmd/` list in `CLAUDE.md` (Code Layout) and a
      short usage block in `docs/cloud-operations-security.md` (or `docs/cloud-mode.md`):
      how the operator generates the age keypair (`age-keygen`), sets
      `FEEDBACK_AGE_RECIPIENT` on the server (med-dni.1) and keeps the identity private
      for this CLI, and the drain command. Note `FEEDBACK_AGE_IDENTITY` in
      `docs/environment.md`.

### Task 4: Verify acceptance criteria
- [ ] The CLI reads `feedback_queue`, age-decrypts with the developer's private key, and
      renders text + metadata + saves image/voice attachments to `-out`.
- [ ] `-delete` acks only successfully-processed items; failed (wrong-key/corrupt) items
      are left in the queue and never block the drain.
- [ ] The age private key exists only here; the server/store never sees plaintext.
- [ ] Server + mobile builds pass; `cmd/feedbackpull` tests pass.

## Technical Details

- **Round-trip is the test**: encrypt a v1 doc with a generated recipient, decrypt with
  its identity — the same age wire format med-dni.3 produces in JS (typage and
  `filippo.io/age` are both `age-encryption.org/v1`, interoperable).
- **Attachment naming**: `<client_id>-<index><ext>` keeps a submission's files grouped
  and collision-free across runs; ext derived from the declared `mime`.
- **Fail-open drain**: one undecryptable row (key rotation, corruption) must not stop the
  operator from reading the rest — log and skip, keep the row for investigation.
- **Not shipped in the binary**: `filippo.io/age` is imported only by `cmd/feedbackpull`;
  the server (`cmd/bot`/`cmd/cloud`) and mobile builds don't link it.

## Post-Completion

**Manual verification**: `age-keygen -o dev.key` → set its recipient as
`FEEDBACK_AGE_RECIPIENT` on a cloud deploy, submit feedback from the app (med-dni.2/.3),
then `go run ./cmd/feedbackpull -db <cloud.db> -identity dev.key -out ./inbox -delete` and
confirm the text prints and the attachments land in `./inbox`, and the queue empties.

**Follow-on**: med-dni.5 (Telegram manager-bot channel into the same `feedback_queue`,
server-side age-encrypt before store).
