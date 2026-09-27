// Explicit credential modes for the local-only passkey POC (med-eas.2.1, see
// docs/2026-07-13-cloud-prf-compatibility-research.md). The mode is a type
// label carried end to end — never inferred from envelope absence:
//   prf        — the default production path: the credential's PRF output
//                wraps the DEK in a server-stored envelope.
//   local_only — explicit, warned fallback for non-PRF authenticators:
//                ordinary WebAuthn authenticates API access while the
//                device-local non-extractable LDK wraps the DEK. No envelope
//                is stored server-side, and the passkey alone cannot cold-
//                recover after site-data loss or on a fresh device.
//
// The fallback is gated behind an explicit opt-in flag (URL or localStorage)
// so the default product stays PRF-only and the POC cannot silently
// downgrade any enrollment or unlock.
export const CREDENTIAL_MODE_PRF = 'prf';
export const CREDENTIAL_MODE_LOCAL_ONLY = 'local_only';

export function isValidCredentialMode(mode) {
  return mode === CREDENTIAL_MODE_PRF || mode === CREDENTIAL_MODE_LOCAL_ONLY;
}

// normalizeCredentialMode treats a missing mode as the production default so
// older servers (or fixtures) that omit the field keep meaning "prf".
export function normalizeCredentialMode(mode) {
  if (mode === undefined || mode === null || mode === '') return CREDENTIAL_MODE_PRF;
  return mode;
}

const POC_QUERY_PARAM = 'local-only-poc';
const POC_STORAGE_KEY = 'med-local-only-poc';

// isLocalOnlyPocEnabled is the POC's explicit opt-in: ?local-only-poc=1 in
// the URL, or localStorage 'med-local-only-poc' === '1' (set by pasting
// `localStorage.setItem('med-local-only-poc','1')` in devtools — there is
// deliberately no in-product toggle, so nobody enables this by accident).
// Default is off everywhere, including the unsupported-authenticator screen.
//
// A query-string opt-in is sticky: enrollment redirects (/claim -> /) drop
// the query string, so the flag is persisted to storage on first sight —
// otherwise a later reauthentication on a bare URL would reject the
// local-only credential just enrolled.
export function isLocalOnlyPocEnabled() {
  let viaQuery = false;
  try {
    if (typeof location !== 'undefined' && location.search) {
      if (new URLSearchParams(location.search).get(POC_QUERY_PARAM) === '1') viaQuery = true;
    }
  } catch {
    // Non-browser runtimes (node/vitest without a location stub) fall
    // through to the storage check below.
  }
  let storage = null;
  try {
    storage =
      typeof localStorage !== 'undefined'
        ? localStorage
        : typeof globalThis !== 'undefined' && globalThis.localStorage
          ? globalThis.localStorage
          : null;
  } catch {
    storage = null;
  }
  if (viaQuery) {
    try {
      storage?.setItem(POC_STORAGE_KEY, '1');
    } catch {
      // Storage denied — the flag still holds for this page view.
    }
    return true;
  }
  try {
    if (storage && storage.getItem(POC_STORAGE_KEY) === '1') return true;
  } catch {
    // Storage denied — the flag stays off.
  }
  return false;
}

// The warned-consent copy the research doc requires before a local-only
// credential is committed. Shown verbatim on the enrollment consent screen;
// never shortened to "PRF compatible".
export const LOCAL_ONLY_WARNING_COPY =
  'This passkey can sign this browser in, but it cannot recover your ' +
  'encryption key. If this browser\u2019s storage is cleared or you move to ' +
  'another device, you will need your Emergency Kit or an already unlocked device.';
