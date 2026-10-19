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
// backoff under the same gate; on the post-create probe so is NotAllowedError
// (device logs: the probe right after create fails once, every time, and
// succeeds about a second later — bd med-nt9p.19).

import { diagCeremony } from './passkey-diag.js';

const RETRY_DELAYS_MS = [1000, 2000, 4000];
// Android shell: let Credential Manager settle after create before the probe.
const PROBE_SETTLE_MS = 1500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ceremonyInFlight = false;

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

// The one navigator.credentials.create: web/iOS call it directly; the shell
// also logs it (passkey-diag.js).
export function createCredential(publicKey) {
  if (!inAndroidShell()) return navigator.credentials.create({ publicKey });
  return diagCeremony('create', publicKey, 1, () => navigator.credentials.create({ publicKey }));
}

// One passkey ceremony at a time (begin → create/get → probe + its retries →
// finish). Android shell only: the page shows one steady busy step (no button
// left to tap — on the device a tap landing as the Credential Manager sheet
// closed started a second begin mid-retry, superseding the server challenge
// and colliding with "A request is already pending"), extra calls are dropped
// until it settles, and a browser/Credential Manager error is replaced by
// copy.failed. Errors this app throws itself (plain Error) keep their text.
// The caller's catch then renders its normal screen, whose button restarts
// with a fresh begin. Web/iOS: `run()` exactly as before.
export function passkeyCeremony(app, copy, run) {
  if (!inAndroidShell()) return run();
  if (ceremonyInFlight) return Promise.resolve();
  ceremonyInFlight = true;
  app.innerHTML = `
    <section class="wizard-step" aria-busy="true">
      <div class="wizard-spinner" aria-hidden="true"></div>
      <h1></h1>
      <p></p>
    </section>`;
  app.querySelector('h1').textContent = copy.busy;
  app.querySelector('p').textContent = copy.hint;
  return run()
    .catch((e) => {
      throw e && e.name && e.name !== 'Error' ? new Error(copy.failed) : e;
    })
    .finally(() => { ceremonyInFlight = false; });
}

// `op` only labels the Android ceremony log ('get' or 'probe').
export async function getAssertion(publicKey, op = 'get') {
  if (!inAndroidShell()) return navigator.credentials.get({ publicKey });
  const options = { publicKey: { ...publicKey, allowCredentials: [] } };
  const attempt = (n) => diagCeremony(op, publicKey, n, () => navigator.credentials.get(options));
  // NotAllowedError is also a user cancel: at most one reopen of the sheet.
  let notAllowedRetries = op === 'probe' ? 1 : 0;
  const retryable = (e) => e && (e.name === 'NotReadableError'
    || (e.name === 'NotAllowedError' && notAllowedRetries-- > 0));
  for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
    try {
      return await attempt(i + 1);
    } catch (e) {
      if (!retryable(e)) throw e;
      await sleep(delay);
    }
  }
  return attempt(RETRY_DELAYS_MS.length + 1);
}

// The post-create PRF probe (signup.js, claim.js): PRF output is only reliable
// from a fresh assertion (docs/cloud-crypto.md "Registration caveat"). On
// Android the discoverable get may return another passkey of this account
// (e.g. one left by an earlier failed claim), so it must be the one just made.
export async function prfProbe(rawId, salt) {
  if (inAndroidShell()) await sleep(PROBE_SETTLE_MS);
  const assertion = await getAssertion({
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [{ type: 'public-key', id: rawId }],
    userVerification: 'required',
    extensions: { prf: { eval: { first: salt } } },
  }, 'probe');
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
