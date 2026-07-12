# Cloud (E2EE) mode — privacy & security review

**Date:** 2026-07-12
**Reviewer:** Fable 5 (architecture audit)
**Scope:** `cmd/cloud`, `internal/cloudserver`, `internal/cloudstore`, `web/cloud`, `web/domain`, and the cloud-mode docs. Bot/mobile modes out of scope (bot mode is legacy; mobile is frozen).

This is a point-in-time assessment, not a set of applied changes. File/line references were current at the date above.

---

## Verdict

The cryptographic core is well-built, and — unusually — the project is honest about its own limits. The in-app privacy page (`web/cloud/js/privacy.js`) is kept in sync with the docs by a drift test, and the hard accepted risks (web-delivered-crypto poisoning, XSS-while-unlocked, Telegram-can't-be-E2EE) are stated plainly rather than glossed.

The real problems are **not in the crypto**. They are: one server-side auth-scoping bug, plaintext that lingers or leaks around the edges of the sealed core, and a documentation structure that never consolidates the cloud threat model. **Nothing here breaks the "server can't read your vault" claim.** Several items chip at the stronger "the server learns nothing but timing" framing, which a couple of docs oversell.

---

## What holds up (verified — do not touch)

- **The vault is sealed.** Envelopes, oplog, snapshots, transfer slots, web-push payloads, and the Telegram inbox are all opaque ciphertext; the server holds no key for any of them. The inbox is provably write-only (no private-key column, `internal/cloudstore/migrations/012_inbox.sql`). No `Decrypt`/AES exists anywhere in the cloud server packages.
- **Crypto hygiene is right.** Fresh random 12-byte nonce per encryption at every call site (no static IVs, no reuse path); thorough AAD context-binding — envelopes bind `accountId‖credentialId`, oplog binds `accountId‖recordType‖recordId‖seq` — so the server cannot swap or reorder envelopes between records or accounts; 160-bit recovery code with a domain-separated verifier.
- **No PRF fallback.** If the authenticator cannot produce PRF output the client aborts (`web/cloud/js/signup.js`, `unlock.js`) rather than silently downgrading to a weaker key path.
- **CSP/egress is injection-proof.** `validEgressHost` (`internal/cloudserver/egress.go:88`) rejects anything but `[a-z0-9.-]`, so no space/scheme/`//` can inject a second `connect-src` token; `buildConnectSrc` never emits a bare `https:` wildcard, and a read failure degrades to the fixed allowlist, not open.
- **Auth scoping is otherwise clean.** Every account-scoped handler derives `accountID` from the session, not client input; store SQL carries `WHERE account_id = ?`. Unauthenticated endpoints (claim, recover) return identical errors across failure modes — no enumeration oracle.
- **Logging is disciplined.** No handler logs request bodies, ciphertext, tokens, PRF output, or verifiers. Trial/food proxies carry enforced "log a fixed string only" invariants.

---

## Findings

Severity is relative to a zero-knowledge health app. None of these expose sealed vault content.

### 1. [Medium — real bug] Device-revocation bypass via non-account-scoped `CredentialExists`

`internal/cloudstore/repo.go:627` checks `SELECT 1 FROM credentials WHERE id = ?` with **no `account_id` predicate**. It backs `RequireSession` (`internal/cloudserver/session.go:128`).

Because `credentials.id` is authenticator-chosen and globally unique, a holder of account A's still-valid 30-day session for a *revoked* credential X can register a new credential with the same ID X under a second account B (the UNIQUE constraint no longer blocks it once A's row is deleted). A's old session token then passes all of `RequireSession`'s checks again — defeating device revocation. Convoluted but real, and it directly undoes the revocation the surrounding TOCTOU-hardened code works to guarantee.

**Fix:** `WHERE id = ? AND account_id = ?`, threading the token's accountID through. One clause. This is the only finding I'd call a defect rather than a tradeoff.

### 2. [Medium] Sent Telegram reminders keep medication names in plaintext forever

`MarkPushSent` (`internal/cloudstore/push.go:204`) sets `sent_at_unix` but never clears `tg_text`/`ct`. For Telegram-delivery accounts, `tg_text` holds detailed reminder text (med name + dose). A fired reminder never needs its payload again, yet it accumulates in the clear until account deletion.

**Fix:** null `ct`/`tg_text` in the `MarkPushSent` UPDATE. Shrinks the plaintext-at-rest window from "forever" to "until fired."

### 3. [Medium] Telegram delivery defaults to `detailed` verbosity

`web/domain/reminders.js:342` — once a user enables the (clearly disclosed) Telegram channel, med names transit the relay in cleartext by default. A `generic` (name-free) twin exists for every reminder and is test-pinned.

**Fix:** default to `generic`, make `detailed` an explicit opt-in.

### 4. [Medium — broken feature + stale disclosure] RxNav is CSP-blocked

`web/cloud/js/rxnorm.js:17` calls `https://rxnav.nlm.nih.gov`, but that host is neither in the fixed CSP list (`internal/cloudserver/router.go:199` adds only `api.elevenlabs.io`) nor registered by `web/cloud/js/egress-hosts.js`. The app-document `connect-src` therefore blocks it; `fetchJson`'s catch degrades silently to "no interaction warnings" — while `privacy.js:112` still describes the flow as working. Same omission for the food-DB bare-`domain` fallback host.

This is exactly the class of bug a CSP-vs-client-egress consistency test would catch; there isn't one.

**Fix:** add `rxnav.nlm.nih.gov` (and the food `domain` fallback) to the emitted `connect-src`, or route them through an operator proxy; add a test asserting every client-side fetch host is CSP-reachable.

### 5. [Medium] Under-disclosure of the plaintext `record_type_tag` channel

Every synced op carries `"<type>:<recordId>"` in the clear (`web/cloud/js/sync.js:22`), and for vitals the recordId embeds calendar dates (e.g. `hrsample-2026-07-08`). The operator therefore learns which features you use, how many meds/BP readings you log, and when. The privacy page says only "how often your device syncs… No content."

Content *is* sealed and the tag was deliberately never confidential — but "cadence and blob sizes" understates it. For a health app, a record-type histogram plus timing is itself an inference channel (a BP-heavy profile implies hypertension monitoring). This is an honesty gap in the disclosure copy, not a content leak.

**Fix:** update `privacy.js` (and the leakage tables it drifts against) to name the record-type + timing channel explicitly.

### 6. [Medium] Trial-AI chat agent sends vault reads through the operator

The Telegram free-text agent (`web/cloud/js/tg-agent.js`, `inbox-apply.js:463`) runs a tool-call loop whose `mcp_call` results — arbitrary vault reads such as BP history and notes — are fed back into the model messages. On the operator trial key, all of that transits the operator's OpenAI account. The privacy page discloses only "meal descriptions and photos."

**Fix:** either narrow what the trial agent can read, or widen the disclosure to cover tool-result content.

### 7. [Low] Local plaintext mirror + silent warm unlock absent from the in-app privacy page

All health records sit decrypted in IndexedDB (`web/cloud/js/sync.js:130`), and presence of the LDK record opens the vault with no passkey prompt and no auto-lock (`unlock.js:29`). This is the shared-computer threat; it's documented only in developer docs, not where users see it.

### 8. [Low] Assorted

- `encodeFields` uint16 length truncation has no guard (`web/cloud/js/crypto.js:67`) — theoretical today (no field approaches 64 KiB), but a one-line length assert closes it.
- Fresh-device snapshot rollback is undetectable (`sync.js:384`) — inherent to the model; worth a doc line rather than a fix.
- Vault export includes plaintext API keys by default (`cloud-boot.js:108`, `includeSecrets = true`) — consider secrets-off default or a UI warning.
- `POST /api/recover` has a sound per-account DB throttle (5/hr) but no per-IP limiter — the one auth ceremony without an in-memory limiter.
- `mcp_remote` persists the Tier-2 pairing key unencrypted at rest while every other secret (TG token) is sealed under the HKDF key — a defense-in-depth gap, given the Tier-2 consent model already discloses in-transit visibility.

### Non-finding (noted for completeness)

The uncommitted `ListAccountsForGraph` / `AccountGraphNode` addition in `internal/cloudstore/repo.go` is a read-only invite-provenance query with no caller wired up yet. It exposes no ciphertext or health data — only the who-invited-whom graph already stored in plaintext by migration 010. Either finish wiring the admin subcommand or drop it before commit rather than leaving dead code.

---

## Documentation assessment

Strengths: the leakage table in `docs/cloud-mode.md`, the threat table in `docs/cloud-crypto.md`, and the in-app `privacy.js` are all real and cross-checked by `web/cloud/js/tests/privacy.drift.test.js`. Gaps:

1. **No consolidated cloud threat model.** `threat-model.md` predates cloud mode (dated 2026-03-14, scoped to bot/server + MCP) and never mentions the DEK, passkeys, envelopes, or the zero-knowledge property. The actual product has no formal attacker-capability enumeration, asset table, or developed server-operator adversary — it's all scattered prose. **This is the biggest documentation gap.**
2. **The CSP defense is served by the distrusted server.** The docs present the per-account egress allowlist as an XSS-exfil bound without noting it assumes an *honest* server emitting honest headers — a malicious operator can serve a wildcard `connect-src`. This doesn't weaken the design; the docs should state what the defense is and isn't for.
3. **No retention/deletion policy.** Logging invariants exist as scattered asserts, but nothing states IP-log retention, unclaimed-account lifecycle, or that litestream/R2 keeps replicated history — so a deleted account's ciphertext can persist in the bucket indefinitely. A privacy-claiming health app needs a documented "right to erasure" story.
4. **`SESSION_SECRET`-sealed Telegram tokens live in the same `cloud.db`/R2 replica** the docs call "ciphertext only." A combined env + bucket leak defeats that seal; the bucket-security section should say so.
5. **`docs/security/` is effectively empty** — one stale 15-line CORS note for an E2EE health app.

---

## Suggested next steps

| Priority | Item | Type |
|----------|------|------|
| 1 | Finding 1 — account-scope `CredentialExists` | code (1-line + test) |
| 2 | Finding 2 — clear `tg_text`/`ct` on send | code (small) |
| 3 | Finding 4 — RxNav/food-DB CSP host + consistency test | code (small) |
| 4 | Findings 3, 5, 6, 7 — default-tightening & disclosure copy | code + docs |
| 5 | Write a real cloud-mode threat model; add retention/deletion policy | docs |

Findings 1, 2, and 4 are small and high-value. The largest doc task is replacing the stale bot-era threat model with a cloud-mode one.
