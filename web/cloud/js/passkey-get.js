// The one place the cloud shells call navigator.credentials.get (bd med-nt9p.19).
//
// Web and iOS: a single get with the caller's options, untouched — same
// request, same thrown error as a direct call.
//
// Android shell only (window.wgNative, docs/android.md): a passkey created
// inside the app's WebView is filed by Google Password Manager as an app
// credential, and GPM never matches those against an allowCredentials list —
// only a discoverable get finds them. So under the bridge every get is
// discoverable (allowCredentials: []); rpId is the account's own host, so the
// sheet only lists that account's passkeys. The server still verifies the
// asserted credential belongs to the account (login/finish, account DELETE),
// so the allowlist was never the security control. Credential Manager's
// transient "unknown error" (NotReadableError) is retried with a short
// backoff under the same gate.

const RETRY_DELAYS_MS = [1000, 2000, 4000];

// Same detection rule as web/static/js/native/index.js (the passkey shell does
// not load it): iOS's handler wins, and a named-property clobber of
// window.wgNative (<iframe name=wgNative>, an element id) stays web.
export function inAndroidShell() {
  if (typeof window === 'undefined') return false;
  const ios = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wgNative;
  const b = window.wgNative;
  return !ios && !!b && typeof b.postMessage === 'function'
    && typeof b.addEventListener === 'function'
    && b.window !== b
    && !(typeof Node === 'function' && b instanceof Node);
}

export async function getAssertion(publicKey) {
  if (!inAndroidShell()) return navigator.credentials.get({ publicKey });
  const options = { publicKey: { ...publicKey, allowCredentials: [] } };
  for (const delay of RETRY_DELAYS_MS) {
    try {
      return await navigator.credentials.get(options);
    } catch (e) {
      if (!e || e.name !== 'NotReadableError') throw e;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return navigator.credentials.get(options);
}

// The post-create PRF probe (signup.js, claim.js): PRF output is only reliable
// from a fresh assertion (docs/cloud-crypto.md "Registration caveat"). On
// Android the discoverable get may return another passkey of this account
// (e.g. one left by an earlier failed claim), so it must be the one just made.
export async function prfProbe(rawId, salt) {
  const assertion = await getAssertion({
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [{ type: 'public-key', id: rawId }],
    userVerification: 'required',
    extensions: { prf: { eval: { first: salt } } },
  });
  if (inAndroidShell() && !sameBytes(assertion.rawId, rawId)) {
    throw new Error('That was a different passkey. Try again and choose the passkey you just created.');
  }
  return assertion;
}

function sameBytes(a, b) {
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
