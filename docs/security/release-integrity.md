# Release integrity and the client-code boundary (cloud mode)

**Status:** implemented (bd med-yor.8). Sources: finding P2 in
`docs/2026-07-12-gpt-5.6-sol-cloud-privacy-audit.md`, `docs/cloud-crypto.md`.

The cloud vault is end-to-end encrypted, but the browser code that holds the
decryption key is served by the operator. This document states that boundary
plainly, describes what has been done to narrow it, and — more importantly —
what remains true after all of it.

## The residual risk, stated first

**The operator serves the code that handles your DEK. An operator who wants to
read your records can ship JavaScript that reads them.** Encryption at rest and
in transit does not change this: the key is reconstructed in the page, the
records are decrypted in the page, and the page comes from the operator's
origin.

Everything below narrows that boundary. None of it eliminates it:

- **A malicious or coerced operator** can serve modified JavaScript, to
  everybody or to one targeted account, and read the vault after unlock.
- **A poisoned update** — compromised CI, compromised registry credentials, a
  compromised deploy host — has the same reach.
- **On-origin XSS** is equivalent to malicious code for the duration of the
  page: it can read the in-memory DEK and drive the non-extractable local device
  key. The CSP raises the cost; it does not make the page safe to inject into.
- **Nothing in the browser can attest what it ran.** A web page cannot prove to
  itself, or to you, that its own bytes match a published build. Verification is
  something a person does from outside the page (see below), after the fact.

This is a property of web delivery, not of this implementation. A user who does
not want to trust the operator's code delivery should self-host `cmd/cloud`,
which moves "the operator" to themselves.

**The frozen mobile build is not a mitigation.** It was removed; branch `mobile`
holds its last working state. It is not built, not shipped, and must not be
cited as the answer to this risk.

## What narrows it

### 1. No third-party script, ever

`script-src 'self'` on every document the cloud origin serves — including the
account app document, the one holding the DEK. No CDN, no analytics, no tag
manager, no `blob:`, no `data:`, no `'unsafe-inline'`, no `'unsafe-eval'`. The
ElevenLabs voice SDK is vendored into `web/static/vendor/` and its AudioWorklet
modules are self-hosted (`web/static/vendor/worklets/*.js`) and passed to the
SDK as explicit paths, which is what removed the last `blob: data:` allowance
the audit called out. Enforced by `TestSecurityHeaders_NoBlobOrDataScript` and
`TestRouter_HostVariants` in `internal/cloudserver/router_test.go`; a re-vendor
that drifts the worklet files fails
`web/static/js/tests/vendor.elevenlabs-client.test.js`.

Known gap, pre-existing and unrelated to the DEK: on engines that do not support
the `sampleRate` media constraint, the voice SDK resamples via a libsamplerate
worklet it fetches from `cdn.jsdelivr.net`. `script-src 'self'` blocks that, so
voice degrades on those engines. Self-hosting that file (the SDK accepts a
`libsampleratePath`) is the fix if it ever matters; widening the CSP is not.

### 2. Scoped egress, so injected code has nowhere to send data

The app document's `connect-src` is a per-account allowlist — `'self'`, the
provider hosts the account itself registered after unlock, and the fixed
ElevenLabs host. No document on the origin ever serves a bare `https:`/`wss:`
token, so a script that does get onto the page cannot POST the DEK to an
arbitrary origin.

Honest residual: an XSS with persistence can call `PUT /api/egress-hosts` to add
its own host and force a reload to pick up the widened policy. That is a
strictly harder attack than instant arbitrary-origin exfiltration — it needs a
write and a navigation — not a closed door.

### 3. Verifiable builds

Every push to `master` builds one image, pushes it to GHCR by commit SHA, and
signs a SLSA provenance statement for it with a short-lived Sigstore certificate
bound to the GitHub Actions OIDC identity (`.github/workflows/deploy.yml`). The
same job publishes `SHA256SUMS` over every browser-delivered file in the tree
the image was built from.

This does not stop a malicious operator. What it provides is *evidence*: a
divergence between the code an origin serves and the code this repository
published becomes detectable by anyone who looks, rather than being invisible.

## How to verify a deployment

**1. Ask the origin which build it claims to be.** The Settings screen shows the
short commit SHA (`VERSION_PLACEHOLDER` is stamped at build time), and
`GET /api/version` returns the asset build id a running tab polls against.

**2. Check that this repository built that image.**

```bash
gh attestation verify \
  oci://ghcr.io/korjavin/medicationtrackerbot:<commit-sha> \
  --repo korjavin/medicationtrackerbot
```

A pass means: an image with that digest was built by this repository's workflow,
from that commit. A failure — or a missing attestation — means the running image
is not one CI produced, which is exactly the signal worth having.

Caveat: GitHub only persists attestations for public repositories (and paid orgs),
so while this repo is private the deploy workflow skips the attest step and step 2
has nothing to check. Step 3 (published bundle hashes) still runs.

**3. Check that the origin serves those bytes.** Download
`web-bundle-sha256sums-<sha>` from the corresponding workflow run (or regenerate
it from the tagged commit — the list is reproducible from the tree), then
compare any asset:

```bash
curl -s https://<account>.<base-domain>/static/js/app.js | sha256sum
grep 'web/static/js/app.js$' SHA256SUMS-web.txt
```

Path mapping between the manifest and the URLs:

| Manifest path | Served at |
|---|---|
| `web/static/<p>` | `/static/<p>` |
| `web/domain/<p>` | `/domain/<p>` |
| `web/cloud/<p>` | `/<p>` (the shell is mounted at the root) |

Two files are deliberately not byte-comparable, and both are assembly, not
logic:

- **`/`** — the app document is `web/static/index.html` plus a runtime-injected
  build-id meta tag and two `<script src>` lines (`injectCloudBoot` in
  `internal/cloudserver/router.go`). Compare `/static/index.html` instead, which
  is served verbatim, and read the injected block by eye.
- **`/static/config.js`** — synthesized per mode by the server; there is no such
  file in the repo. Its whole body is two constant assignments.

The `?v=<build_ts>` query on asset URLs is a cache buster and does not change
the bytes; omit it or keep it, the hash is the same.

## What is still missing

- **No independent review** of the browser crypto and WebAuthn ceremonies yet —
  tracked as bd med-yor.9.
- **No reproducible build.** The provenance attestation says *who* built the
  image and from which commit; it does not let a third party rebuild the same
  bytes and compare. The Go binaries are close to reproducible (`CGO_ENABLED=0`,
  pinned toolchain), but the image embeds a build timestamp, so a byte-identical
  rebuild is not currently achievable.
- **No binary transparency log or update pinning.** Nothing forces an operator
  to keep serving an attested build, and a browser will not notice if they stop.
  Detection is manual and after the fact.
- **No subresource integrity (SRI) on same-origin assets.** SRI would only pin
  assets against the very document that names them — an operator rewriting the
  code rewrites the hashes too — so it adds no defense against the operator, who
  is the actor this section is about.
