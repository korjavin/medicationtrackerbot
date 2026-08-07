# Single origin instead of per-account subdomains — what we would lose

**Class: analysis.** Not a proposal (nothing here is designed to be built) and not
normative (it describes a system we do *not* have). It exists to make the cost of
switching `cmd/cloud` from `https://<petname>-<random>.app.<domain>` to one shared
origin explicit, so the decision is made against the real inventory rather than
against the intuition that "it's just Host routing."

Prompted by the sibling project [`myportfolio`](https://github.com/korjavin/myportfolio),
which runs the same zero-knowledge design (device-held keys, passkey + PRF, opaque
blob on a dumb server) on **one URL for every client** and documents the divergence
from its side in `docs/ARCHITECTURE.md` §8.2 and in the comment atop
`internal/store/migrations/001_init.sql`.

**Verdict up front.** The Go-side host-routing surface is genuinely small — 7 call
sites across 3 files. The cost is almost entirely elsewhere: one hard migration
blocker (§1), four capabilities needing replacement work of which exactly one has no
good answer (§2), and a pile of origin-scoped browser state the frontend never had to
scope because per-origin isolation did it for free (§3). None of it is a privacy loss:
the vault guarantee is identical either way.

Two results are worth pulling out of the detail, because both cut against the
intuition. **Push is not the blocker it looks like** — targeting an account never
depended on the subdomain, and the browser-side fix is small (§2.2). **The per-account
CSP is** — it is the one capability with no single-origin equivalent at all (§2.1).

---

## 1. The blocker: WebAuthn RP ID is the account subdomain

`rpForRequest` sets `RPID` to the request host — the account's own subdomain
(`internal/cloudserver/webauthn.go:219-224`), which `docs/cloud-crypto.md:29` states
as deliberate: "per-account credential isolation for free."

Two consequences, and the second is the expensive one:

1. **A credential registered for RP ID `sub.app.example` cannot be asserted from
   origin `app.example`.** An RP ID may be the origin's domain or a *registrable
   suffix* of it — you may walk up the tree, never down. Every existing passkey
   stops working on the new origin.
2. **The PRF output changes with the RP ID, so the KEK changes, so the envelope
   will not open.** `KEK = HKDF(PRF, salt=account_id, info="mt/v1/kek" ‖ cred_id)`
   (`web/cloud/js/crypto.js:143-146`). A new RP means a new credential means a new
   PRF means a new KEK. Existing envelopes are undecryptable by the new origin. This
   is data loss, not an inconvenience, for anyone who does not migrate.

### The escape hatch exists, and this codebase already proves the ceremony

From origin `sub.app.example` a browser *may* create a credential scoped to RP ID
`app.example`. So a migration ceremony is possible while the old origin is still
served:

1. User unlocks normally on their subdomain → DEK in memory.
2. `navigator.credentials.create()` with `rp.id = app.example`, then a follow-up
   `navigator.credentials.get()` to evaluate PRF. **This is exactly the shape
   `web/cloud/js/signup.js:146-175` already uses** — create, then a separate get for
   `prf.eval` — because PRF-at-creation is not universally returned. No new
   technique needed.
3. Derive the new KEK, re-wrap the *same* DEK into a second envelope, store it.
4. Unlock on the new origin works; the vault is byte-identical.

**Safety net for anyone who never runs it:** the recovery envelope does not involve
a credential at all — `deriveKEKRec(codeBytes, accountId)`
(`web/cloud/js/recover.js:66,85-88`) derives from the Emergency Kit code and account
id only. It is RP-ID-independent, so a user with their Kit can unlock on the new
origin cold and enroll a fresh passkey. Recovery is already single-origin-shaped: it
asks for the account id explicitly rather than reading it from the host.

**It is an envelope migration, not a data migration.** The DEK is unchanged, so no
record or snapshot is re-encrypted and sync sees nothing. `K_mac = HKDF(DEK, "mt/v1/envmac")`
is unchanged for the same reason. Only the `envelopes` table gains rows.

### How much of it is automatic

Most of the server side already exists: `RegisterBegin`/`RegisterFinish` already
support `gateSession` — "an already-unlocked device just adds the credential under the
live session" (`internal/cloudserver/webauthn.go:106-111`) — which is precisely this
ceremony. The code delta is `rpForRequest` building the RP at the base domain for that
one ceremony instead of `stripPort(r.Host)`.

The client side **cannot be silent, and this is a hard boundary rather than a design
choice.** `navigator.credentials.create()` requires user presence and user
verification: no background execution, no service worker, no server-driven sweep. The
PRF is the entropy protecting the DEK; it is bound to the credential, which is bound to
the RP ID. A new RP ID means new entropy that only the authenticator can produce, and
only with the user verified. The alternatives — the server holding the DEK, or the
server holding the recovery code — each destroy the property the whole system exists to
provide.

So the realistic shape is an interstitial after unlock: one button, one biometric
prompt, no typing and no recovery code. Once per authenticator, or **once for all
devices on a synced passkey** (`docs/cloud-crypto.md:203` — same credential ⇒ same PRF
⇒ the same envelope serves every device in the sync fabric).

**Related Origin Requests does not rescue this**, though `docs/cloud-crypto.md:29`
names it as the escape hatch for a domain migration. An assertion must *name* its
`rpId`, and on a shared origin the account is unknown until after the assertion — which
is exactly why single origin requires discoverable credentials at one RP ID. ROR
relates origins; it does not make a per-account RP ID discoverable.

### The tail

- **It is measurable.** "Does this account have an envelope under a base-RP
  credential?" is a query, so retiring the subdomains becomes a data-driven call
  rather than a guess. Recording an `rp_id` on `credentials` (no such column today)
  makes it a one-liner and lets the server serve a correct `allowCredentials`.
- **Missing the window is not immediately fatal.** `deriveKEKRec(codeBytes, accountId)`
  is RP-ID-independent and `recover.js` already asks for the account id explicitly
  instead of reading it from the host, so the Emergency Kit unlocks cold on the new
  origin with no changes.
- **Push shrinks the tail** — reminders keep working on the old origin throughout, and
  payloads are NK-encrypted, so they can carry real "tap to migrate" copy rather than a
  content-free nudge.
- **Genuinely unrecoverable**: never opens the app during the window *and* skipped or
  lost the Kit. Loss protection is skippable behind an acknowledgment (`cloud-mode.md`,
  onboarding step 3), so this set is not empty.

---

## 2. Capabilities that need replacement work

### 2.1 Per-account CSP `connect-src` — the one that is structurally impossible

The app document emits a `connect-src` allowlist built from *that account's*
registered egress hosts (`internal/cloudserver/router.go:210-220,256-294`,
`PUT /api/egress-hosts`), pinned by `TestRouter_HostVariants` and
`TestRouter_AppDocumentReflectsEgressHosts`, and called out as a CLAUDE.md invariant:
the app document must never serve a wildcard `https:`/`wss:`.

This works only because the account is known *before the document is written*. One
origin means one document means one CSP, so the allowlist becomes the **union of
every user's BYO provider hosts** — served to everyone. `docs/cloud-crypto.md:198`
names this allowlist as the bound on XSS exfiltration; the union removes the bound.

myportfolio does not pay this because its egress is a fixed shared quote blob plus
one opt-in proxy — the same set for every account.

### 2.2 Push — solvable, and cheaper than it looks

**Server-side targeting is unaffected.** A subscription is an opaque endpoint URL
stored against an account row; the relay POSTs to it (`internal/cloudserver/push.go`).
Nothing in the send path reads the Host header. One origin does not cost us the
ability to push to a specific account.

What breaks is the browser side, and **only when one device holds two accounts**:

1. **One subscription per service-worker scope.** `web/cloud/js/push.js:169-174`
   fetches *the calling account's* VAPID public key
   (`GET /api/push/vapid-public-key` → `push.go:193-205`) and passes it to
   `pushManager.subscribe()`. A registration holds exactly one subscription, so a
   second account subscribing with a different `applicationServerKey` throws
   `InvalidStateError`. The near-miss is worse than the throw: `push.js:247` calls
   `getSubscription()` first, so account B would adopt account A's subscription and
   store it on B's row. B's sends are then signed with B's key against a subscription
   minted for A's key, the push service rejects them, and **reminders stop silently**.
2. **`readNK()` returns a single NK** from `device['nk']` in a fixed-name IndexedDB
   (`web/cloud/sw.js:313-315,387`) — no account dimension. The payload is blind
   ciphertext, so the SW cannot tell which account it belongs to.

Both have cheap fixes:

- **One server-wide VAPID keypair**, so a single subscription per device serves every
  account and the server maps endpoint → account. The re-subscribe this forces is
  free: subscriptions are per-origin, so every device re-subscribes on the new origin
  regardless. The migration is already paying that cost.
- **Key the NK store by account id, then trial-decrypt.** AES-GCM's auth tag makes
  wrong-key detection free and unambiguous, so no plaintext account hint is needed in
  the payload.

**Per-account VAPID buys nothing once the origin is shared.** Its value today is that
the push service sees two unrelated origins with two unrelated app-server keys. On one
origin it sees one origin and one browser instance for both subscriptions — the
linkage is structural, and a distinct VAPID key does not undo it. Dropping it
surrenders no property the origin change has not already voided.

Worth noting that myportfolio sidesteps this entirely rather than solving it — its
§8.3 has no push at all, "no push, no NK, no inbox keypair… deletes the single largest
compromise in medtracker's design." That is not a single-origin consequence; it is a
separate product decision we have not made.

### 2.3 The MCP connector token is short because the subdomain scopes the throttle

`generateMCPRemoteToken` mints ~30 bits, "deliberately short enough to type across
devices," with the comment stating plainly that "the throttle at the MCP endpoint is
the actual security boundary" (`internal/cloudserver/mcp_remote.go:45-49,156-159`).
That throttle is per-account because the host resolves the account *before* the token
is checked. myportfolio flags this exact divergence from its side (`ARCHITECTURE.md`
§11: "we cannot, because the token is the only identifier we have until it is looked
up") and pays for it with a high-entropy token the user copies rather than types.

Single origin means: high-entropy token, and the `xxx-xxx` typed pairing UX dies.

### 2.4 Account deletion's guarantee that no page on that origin can run again

The delete flow leans on "the deleted account's subdomain serves 404s, so no page on
that origin can ever run again" (`docs/cloud-mode.md:257`) — that is what makes a
post-delete wipe retry safe and same-tab-only. On a shared origin the app keeps
serving; a stale tab from a deleted account can still boot. The double-wipe reasoning
needs re-deriving, not just re-implementing.

---

## 3. Origin-scoped browser state the frontend never had to scope

`web/static` was inherited from the single-tenant Telegram bot. Per-origin isolation
is what retrofitted multi-tenancy onto it for free. On a shared origin, every one of
these becomes an account-scoping task:

- **IndexedDB, fixed names**: `medtracker-cloud` (`web/cloud/js/localdb.js:5`, and the
  SW opens it by literal name) and Dexie's `MedTrackerDB`.
- **Cache Storage**: `CACHE_PREFIX = 'medtracker-cloud'` (`web/cloud/sw.js:17`).
- **15 unscoped `localStorage` keys** in `web/static/js/`: `mt-active-tab`,
  `mt-bp-range`, `mt-health-subtab`, `mt-meds-subtab`, `mt-weight-range`,
  `mt-workouts-*`, `trialconsent`, `wg.clientId`, `medtracker_cache_pruned_at`, and
  **`medtracker_changes_cursor`** — the last is a sync cursor, so a collision between
  two accounts on one device is a correctness bug, not a cosmetic one.
- **`window.cachedFetch` keys**, shared with the bootstrap warm-cache path in
  `app.js` — no account component today.
- **Session cookie**, "scoped to the whole subdomain origin"
  (`internal/cloudserver/session.go:82-93`). One origin means one cookie jar and an
  in-app account switcher.
- **The installed PWA is one install per origin.** Today the home-screen icon *is*
  your instance. Shared origin: one install, one account at a time, switching happens
  inside the app. Fine for a solo product; a regression for a device holding two
  household accounts, which invite-only distribution makes likely.

---

## 4. Losses that are real but acceptable

- **The capability moat.** The unguessable name is defense in depth, explicitly "a
  moat, not the auth" (`docs/cloud-mode.md:191`), and it already leaks via DNS and
  TLS SNI. Losing it costs a layer, not a control.
- **Per-account rate limits and storage quotas** keyed by host — re-key them to the
  session's account id. Mechanical.
- **`cloud admin inspect <subdomain>`** and the admin listing become account-id
  addressed. Mechanical.
- **Invite / claim flow.** The claim link stops being `https://<sub>.<base>/#claim=<t>`
  and becomes `https://<base>/#claim=<t>` — the token was always the secret; the
  subdomain never was. Invite-only can survive single origin unchanged (no public
  signup form ≠ no shared URL).

## 5. What we would gain, stated honestly

- Ops: no wildcard DNS, no DNS-01 wildcard cert, no DNS-provider API credentials, no
  Host-routing layer, no `*.localhost` dev special-casing.
- **The URL stops being losable state** — which removes the reason the optional
  recovery email exists, today the only stored PII in an otherwise PII-free system.
- The cloud domain stops being effectively permanent. `docs/cloud-crypto.md:29`
  notes a domain migration would currently need WebAuthn Related Origin Requests;
  with RP ID at the base domain that gets no easier, but it stops being per-account.
- A demo URL, a landing page, and the app can share one host.
- Anything cross-account (household view, sharing with a clinician) stops being a
  cross-origin problem.

## 6. Decision criteria

**Per-account BYO provider keys are the one thing per-account origins genuinely buy**
(§2.1). If they stop being a product requirement — or if we accept serving the union
of everyone's provider hosts in one CSP, and say so plainly in the threat model rather
than quietly — the case against switching mostly dissolves. Everything else in §2–§3
is retrofit cost that a one-time migration pays down.

Do not switch on ops-simplicity grounds alone. The Go diff is small; the browser diff,
the CSP regression, and a per-device passkey re-enrollment ceremony with real data-loss
tails are not. And note that the migration blocker in §1 is a **one-way door**: once
credentials are re-enrolled at the base RP ID, going back to per-account subdomains
means running the whole ceremony again in reverse.

If it is done anyway, the sequencing is forced: dual-serve both origins → ship the
re-wrap ceremony (§1) → account-scope the browser state (§3) → decide what replaces
the per-account CSP (§2.1) → only then retire the subdomains.
