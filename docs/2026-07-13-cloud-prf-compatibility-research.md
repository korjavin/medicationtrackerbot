# WebAuthn PRF compatibility and non-PRF fallback research

**Date:** 2026-07-13
**Issue:** `med-eas.2`
**Status:** architecture research decision; implementation requires a separate POC

## Decision

Keep WebAuthn PRF as the default and preferred cloud-vault enrollment path. Do
not silently downgrade, do not infer support from a browser or password-manager
name, and do not add a server-held XOR/key share.

The only fallback worth a POC is an explicitly labelled **local-only passkey**:

- ordinary WebAuthn still authenticates the device to the server;
- the already-implemented, non-extractable WebCrypto Local Device Key (LDK)
  wraps the DEK in IndexedDB;
- the server receives no new decrypting key or key share;
- clearing this browser's storage, losing the device, or opening a synced
  passkey on a new device does **not** recover the DEK;
- cold recovery requires the Emergency Kit or transfer from an unlocked device.

This is not equivalent to a PRF credential. It preserves the server
zero-knowledge boundary, but deliberately trades away passkey-only cold recovery
and synced-passkey portability. The UI must present that limitation before the
credential is committed and must never call the mode simply "PRF compatible."

## Why this research exists

Cloud mode currently derives one KEK per credential from a client-only WebAuthn
PRF result, then uses the KEK to wrap the random vault DEK. Some credential
managers can create and assert passkeys while dropping or not implementing the
`prf` extension. Those users can authenticate but cannot produce the entropy
needed to open a DEK envelope.

The existing implementation correctly treats PRF as a cryptographic capability,
not an authentication decoration:

- registration is followed by an immediate assertion because `create()` may
  report `prf.enabled` without returning an output;
- the assertion must return `getClientExtensionResults().prf.results.first`;
- the PRF output is kept client-side and stripped from the WebAuthn response sent
  to the server;
- unsupported credentials abort before registration is finalized.

See [cloud-crypto.md](cloud-crypto.md), `web/cloud/js/signup.js`,
`web/cloud/js/claim.js`, and `web/cloud/js/unlock.js`.

## Research method and source quality

An Antigravity CLI researcher performed two web-search passes. The first report
proposed a server/client split wrapping key. The second pass withdrew that
proposal and attempted to validate its compatibility claims. Both reports were
then checked against current source and primary specifications.

Several delegated claims failed validation. They are recorded here so they are
not accidentally repeated:

| Delegated claim | Validation result |
|---|---|
| Bitwarden does not return third-party PRF results | **Supported by current source**, but not by the generic community-page citation the report supplied. See the source finding below. |
| A June 2026 1Password issue `FS-5593` proves an Array/ArrayBuffer bug | **Not validated.** The supplied direct URL returns 404. Do not cite or design around this claim without new evidence. |
| Windows update KB5077181 introduced Windows Hello PRF | **Not validated.** The Microsoft KB establishes build numbers but contains no PRF, WebAuthn, or Windows Hello change. Physical testing or a direct Microsoft implementation reference is required. |
| YubiKey PRF requires FIDO2.1 | **Rejected as a general premise.** WebAuthn PRF can map to CTAP `hmac-secret`; exact model/firmware/browser support still requires a real active probe. The delegated firmware citation was only a generic homepage and did not validate its replacement version claim. |
| A non-extractable LDK cannot be used by XSS | **False.** Non-extractable prevents exporting raw key bytes; same-origin script can still invoke the key for unwrap/decrypt. The project already documents this precisely in `cloud-crypto.md`. |

## What is actually verified

### The standard and the authoritative capability test

The current [WebAuthn Level 3 specification](https://www.w3.org/TR/webauthn-3/#prf-extension)
defines `prf` outputs as exactly 32 bytes and explicitly notes that outputs might
not be available during credential creation, in which case an assertion is
needed. It also says client capability enumeration may report implemented
extensions under an `extension:<identifier>` key. Therefore
`getClientCapabilities()["extension:prf"]` can improve explanatory UX, but it
does not prove that the authenticator the user selects can evaluate PRF.

The only enrollment-grade test is:

1. request `prf` during `navigator.credentials.create()`;
2. immediately call `navigator.credentials.get()` for that exact credential with
   `extensions: {prf: {eval: {first: salt}}}`;
3. require `getClientExtensionResults().prf.results.first` to be a 32-byte
   `ArrayBuffer`/buffer source accepted by WebCrypto;
4. derive the KEK and wrap the DEK before finalizing enrollment;
5. otherwise offer retry with another authenticator or the explicit local-only
   mode.

This is already the important shape of the cloud signup and claim code. A static
compatibility table must never replace it.

### Bitwarden browser extension, current source

At Bitwarden clients commit
[`b3b4683` (2026-07-10)](https://github.com/bitwarden/clients/commit/b3b4683334f5c53668900a3f3e66165319a28f11),
the browser-extension WebAuthn adapter's
[`webauthn-utils.ts`](https://github.com/bitwarden/clients/blob/b3b4683334f5c53668900a3f3e66165319a28f11/apps/browser/src/autofill/fido2/utils/webauthn-utils.ts):

- copies only `credProps` from creation extension inputs;
- omits assertion extension inputs entirely; and
- returns `{}` from assertion `getClientExtensionResults()`.

That intercepted browser-extension path cannot satisfy this application's PRF
probe at that revision even though it can perform ordinary passkey registration
and authentication. This is direct implementation evidence, not an inference
from Bitwarden using PRF to unlock its own vault.

### Other clients and platforms

The WebAuthn working group's
[Level 3 implementation wiki](https://github.com/w3c/webauthn/wiki/Level-3-Implementations)
listed PRF client implementations as Chromium, WebKit, and 1Password when last
edited on 2025-02-19. It is useful context, not a current authenticator guarantee.
It notably distinguishes general passkey features from PRF support.

Apple's [AuthenticationServices update notes](https://developer.apple.com/documentation/updates/authenticationservices)
document platform PRF APIs from June 2024. WebKit's later
[PRF/`hmac-secret` issue](https://bugs.webkit.org/show_bug.cgi?id=259934) and
[Safari Technology Preview 234 notes](https://webkit.org/blog/17674/release-notes-for-safari-technology-preview-234/)
show why platform passkeys, roaming security keys, browser builds, and OS builds
must not be collapsed into a single "Safari supports PRF" cell.

Google's [supported passkey environments](https://developers.google.com/identity/passkeys/supported-environments)
also states that the password manager is opaque to the relying party until a
credential is returned. Its general passkey matrix does not prove PRF for every
provider selectable in Chrome or Android Credential Manager.

The product conclusion is therefore deliberately manager-agnostic: **probe the
credential, not the brand.** A dated lab matrix is useful for support diagnostics,
but it cannot be an enrollment security decision.

## Architecture options

| Option | Server zero-knowledge | Cold recovery | Portability | Decision |
|---|---|---|---|---|
| Require a PRF-capable credential | Preserved | Passkey envelope or Emergency Kit | Best when the PRF credential syncs | Keep as default |
| Retry with platform authenticator or security key | Preserved | Same as PRF baseline | Depends on authenticator | Keep as first unsupported-path action |
| Ordinary passkey + existing local LDK cache | Preserved | Emergency Kit or trusted-device transfer only | Local browser only | POC as explicit fallback |
| Recovery code on every cold open | Preserved | Recovery code itself | Manual and error-prone | Recovery path, not routine UX |
| Server/client XOR split wrapping key | Server has a reusable key share; combined server/profile compromise decrypts | Still depends on the local share | Poor | Reject |
| `largeBlob` without PRF | Storage only; no suitable wrapping key appears | Unsolved | More fragmented | Reject as a solution to this problem |
| Password/PIN-derived KEK | Introduces low-entropy offline guessing material | Password-dependent | Broad | Reject under current R1/R5 invariants |
| Native secure-keystore wrapper | Can preserve zero knowledge | Platform dependent | Requires installed native product | Separate future product, not a PWA fallback |

## Why the server-share proposal is rejected

Splitting a random wrapping key into `S_local XOR S_server` is cryptographically
sound secret sharing, but it changes the system's trust and failure model without
solving the principal portability problem:

- `S_local` remains bound to one browser profile, so a synced ordinary passkey on
  another device still cannot open the vault;
- a server database compromise obtains a durable share for every fallback user;
- server compromise plus browser-profile compromise becomes sufficient to
  decrypt, whereas the current server database contributes no decrypting key;
- session theft can make the server share retrievable unless every release is
  gated by a fresh, carefully bound assertion;
- malicious same-origin code can read the local share and, because the operator
  serves the PWA, can arrange to receive the other share;
- IndexedDB eviction still forces recovery.

It is more complex and strictly worse than using the LDK cache the product already
accepts for normal warm unlock. It should not be implemented.

## Local-only fallback security contract

The existing local posture is explicit: the cloud is the E2EE boundary and the OS
is the local boundary. The app already keeps plaintext application caches and an
LDK-wrapped DEK locally. The LDK is a script-level non-exportability control, not
a hardware or disk-forensics guarantee. XSS can use it, and an unlocked device can
read the vault.

A local-only fallback reuses that posture rather than adding server trust. Its
regression is availability/recovery, not a claim that ordinary WebAuthn somehow
becomes a KEK:

- a standard passkey authenticates API access but never decrypts an envelope;
- the LDK record is the only routine local route to the DEK;
- a copied or synced passkey alone is insufficient on a fresh browser profile;
- clearing site data makes the Emergency Kit or trusted-device handoff mandatory;
- strict mode (no LDK) is incompatible with a local-only credential;
- removal/revocation UX must distinguish PRF-backed and local-only credentials;
- a local-only credential cannot count as a recoverable second device until that
  device has successfully stored its LDK cache and recovery remains available.

This mode should be opt-in after a warning, never automatic. Suggested copy:

> This passkey can sign this browser in, but it cannot recover your encryption
> key. If this browser's storage is cleared or you move to another device, you
> will need your Emergency Kit or an already unlocked device.

## POC boundary and acceptance tests

The POC should prove the contract before changing production signup:

1. Add a diagnostic enrollment harness that records only capability outcomes,
   never PRF bytes, credential IDs, or identifying attestation.
2. Exercise create plus immediate-get against Bitwarden interception, platform
   passkeys, at least one roaming key, and the browsers available to the team.
3. Model a credential explicitly as `prf` or `local_only`; do not infer the mode
   from envelope absence.
4. For `local_only`, atomically finish standard WebAuthn registration only after
   the DEK is wrapped by a newly generated LDK and complete recovery material is
   confirmed.
5. Prove normal warm reopen works without PRF.
6. Delete the LDK/site data and prove the UI requires Emergency Kit or
   trusted-device transfer rather than pretending the passkey can recover.
7. Prove a synced ordinary passkey on a fresh device cannot bypass that recovery
   requirement.
8. Prove server DB contents contain no new decrypting share or low-entropy
   verifier.
9. Prove account/device removal, last-credential guards, envelope audit, and
   recovery-code rotation handle the new credential type deliberately.
10. Keep the current PRF enrollment path and its 32-byte immediate assertion
    check unchanged.

## Open questions

- Does the product want to support a mode whose synced passkey authenticates on a
  new device but cannot decrypt until recovery? The warning is accurate, but the
  distinction may still confuse users.
- Can the browser reliably confirm durable LDK persistence before consuming a
  signup claim or enrollment token? Failure must be atomic and retryable.
- Should local-only enrollment be permitted for the first credential, or only
  after an account already has one PRF-backed credential?
- Which exact browser/provider/version combinations should be in the support lab
  matrix? Windows Hello, current 1Password, Google Password Manager, Apple
  Passwords, Bitwarden on desktop/mobile, and one roaming key all need physical
  tests; web-search claims are not enough.
- Should the UI expose a small downloadable self-test report containing browser,
  OS, outcome stage, and error class, with no credential or PRF material?

## Final recommendation

Proceed with a small POC of explicit local-only credentials, not a production
fallback yet. Preserve PRF as the default, show "try another authenticator" first,
and require the Emergency Kit before enabling local-only mode. Do not add a
server key share, passphrase KEK, manager allowlist, or optimistic feature sniff.

The POC should be accepted only if it demonstrates honest recovery UX and no
server-side cryptographic regression. If users cannot understand that an ordinary
synced passkey will not recover their vault on a fresh device, retain the current
PRF-only product policy and improve the unsupported-authenticator guidance instead.
