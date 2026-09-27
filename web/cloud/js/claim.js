// New-device claim flow (Path B QR hand-off): docs/cloud-crypto.md "Enrolling
// a new device" step 3. Reached at /claim; the transfer slot id + TK ride the
// URL fragment (`#slot_id.TK`, base64url) so they never touch the server — or
// are typed in as the fallback code (`slot_id.TK`, base32) when the fragment
// is absent (desktop, no camera). Claims the slot, decrypts the DEK with TK,
// then runs the same enrollment-token registration ceremony as signup.js's
// passkey step.
import {
  fromBase64,
  fromBase64Url,
  base32Decode,
  decryptTransferPayload,
  saltKek,
  deriveKEK,
  deriveKMac,
  wrapEnvelope,
  toBase64,
  toBase64Url,
  timingSafeEqual,
} from './crypto.js';
import { renderUnsupportedAuthenticator } from './signup.js';
import { establishLdkCache, readLdkRecord, unwrapWithLdk, clearLdkCache, restoreLdkCache } from './unlock.js';
import {
  CREDENTIAL_MODE_LOCAL_ONLY,
  LOCAL_ONLY_WARNING_COPY,
  isLocalOnlyPocAvailable,
} from './credential-mode.js';

export async function runClaimFlow() {
  const app = document.getElementById('app');
  const fromFragment = parseCode(location.hash.slice(1), fromBase64Url);
  if (fromFragment) {
    await claimAndEnroll(app, fromFragment).catch((err) => renderClaimForm(app, err.message || String(err)));
  } else {
    renderClaimForm(app);
  }
}

// Both the fragment (base64url TK) and the typed fallback (base32 TK) share
// the same `slot_id.TK` shape — only the TK alphabet differs.
function parseCode(raw, decodeTk) {
  const dot = raw.indexOf('.');
  if (dot < 0) return null;
  // Slot ids are lowercase base32 (server randomToken). The QR fragment already
  // carries lowercase, but a human transcribing the typed fallback may enter it
  // uppercased — the TK half is case-insensitive (Crockford), so normalize the
  // slot-id half too or a valid code 410s on a case mismatch.
  const slotId = raw.slice(0, dot).toLowerCase();
  const tkPart = raw.slice(dot + 1);
  if (!slotId || !tkPart) return null;
  try {
    const tk = decodeTk(tkPart);
    if (tk.length === 0) return null;
    return { slotId, tk };
  } catch {
    return null;
  }
}

function renderClaimForm(app, errorText) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Add this device</h1>
      <p>Type the fallback code shown on your other device (used when this
         device can't scan the QR code).</p>
      <input type="text" id="claim-code-input" placeholder="slot_id.code" autocomplete="off">
      <button id="claim-code-submit">Continue</button>
    </section>`;
  // Error text may carry a browser exception message; render via textContent,
  // never interpolated into innerHTML (this page ends up holding the DEK —
  // XSS here reads it).
  if (errorText) {
    const p = document.createElement('p');
    p.className = 'wizard-error';
    p.textContent = errorText;
    app.querySelector('section').appendChild(p);
  }
  app.querySelector('#claim-code-submit').addEventListener('click', () => {
    const parsed = parseCode(app.querySelector('#claim-code-input').value.trim(), base32Decode);
    if (!parsed) {
      renderClaimForm(app, 'Enter the code exactly as shown on your other device.');
      return;
    }
    claimAndEnroll(app, parsed).catch((err) => renderClaimForm(app, err.message || String(err)));
  });
}

async function claimAndEnroll(app, { slotId, tk }) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Add this device</h1>
      <p>Setting up your passkey&hellip;</p>
    </section>`;

  const claimRes = await fetch(`/api/transfer/${slotId}/claim`, { method: 'POST' });
  if (!claimRes.ok) {
    throw new Error('This code has expired or was already used — generate a new one on your other device.');
  }
  const { ct, enrollment_token: enrollmentToken, account_id: accountId } = await claimRes.json();

  let dek;
  try {
    dek = await decryptTransferPayload(tk, fromBase64(ct), accountId);
  } catch {
    throw new Error('Code invalid or tampered — generate a new one on your other device.');
  }

  if (!(await enrollWithToken(app, { enrollmentToken, accountId, dek }))) return;
  // Session cookie + LDK are both set now; hand off to the unlock flow's
  // normal "already unlocked" render instead of duplicating it here.
  location.href = '/';
}

// Registers a new passkey under an already-obtained DEK, gated by a
// device-transfer or recovery enrollment token — the shared tail of both
// claim.js (device-transfer) and recover.js (Emergency Kit redemption): the
// two flows differ only in how they obtain {enrollmentToken, accountId, dek},
// not in how they turn that into a live passkey + session. Returns false (having
// already rendered the terminal error state) if the authenticator lacks PRF
// support; true once the passkey + session + warm-unlock cache are all live.
//
// POC (med-eas.2.1): when the explicit local-only opt-in flag is on, a
// missing PRF output routes to a warned local-only consent screen instead of
// the terminal unsupported state. Cancel (or a failed verification) resolves
// false after rendering a terminal state, exactly like the PRF path.
export async function enrollWithToken(app, { enrollmentToken, accountId, dek }, opts = {}) {
  const beginRes = await fetch('/api/webauthn/register/begin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enrollment_token: enrollmentToken }),
  });
  if (!beginRes.ok) throw new Error('Could not start passkey registration — the code may be expired.');
  const { publicKey } = await beginRes.json();
  const creationOptions = PublicKeyCredential.parseCreationOptionsFromJSON(publicKey);

  const credential = await navigator.credentials.create({ publicKey: creationOptions });

  // PRF availability is only reliable from a fresh assertion — see signup.js.
  // Probed before finish so an unsupported authenticator aborts here (finish
  // is never called => no enrollment token is ever redeemed for it).
  const salt = await saltKek();
  const prfAssertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: credential.rawId }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const prfOutput = prfAssertion.getClientExtensionResults().prf?.results?.first;
  if (!prfOutput) {
    if ((await isLocalOnlyPocAvailable()) && opts.allowLocalOnly !== false) {
      return renderLocalOnlyConsent(app, { credential, enrollmentToken, accountId, dek });
    }
    renderUnsupportedAuthenticator(app);
    return false;
  }

  const credentialId = new Uint8Array(credential.rawId);
  const kek = await deriveKEK(new Uint8Array(prfOutput), accountId, credentialId);
  const kMac = await deriveKMac(dek);
  const envelope = await wrapEnvelope({ kek, dek, kMac, accountId, credentialId });

  const finishBody = credential.toJSON();
  // Never transmit the PRF output — it lives client-side only.
  if (finishBody.clientExtensionResults) delete finishBody.clientExtensionResults.prf;

  const finishRes = await fetch('/api/webauthn/register/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      credential: finishBody,
      envelope: {
        v: envelope.v,
        nonce: toBase64(envelope.nonce),
        ct: toBase64(envelope.ct),
        mac: toBase64(envelope.mac),
      },
    }),
  });
  if (!finishRes.ok) throw new Error('Passkey registration failed. Please try again.');

  try {
    await establishLdkCache(dek, accountId);
  } catch {
    // Warm-cache is an optimization; a storage-blocked browser must still
    // reach the vault after a successful enrollment — see unlock.js.
  }
  return true;
}

// --- Local-only fallback (med-eas.2.1 POC, explicit opt-in only) ------------
//
// A credential whose authenticator cannot evaluate PRF can still authenticate
// API access via ordinary WebAuthn; the device-local LDK wraps the DEK
// instead of a PRF-derived envelope. Enrollment completes ONLY after two
// verifications pass, in this order:
//   1. the DEK is wrapped by a fresh LDK and the record reads back intact
//      (durable local wrapping — a storage-blocked browser must not enroll);
//   2. the account's recovery envelope is confirmed on file (the Emergency
//      Kit is this mode's only cold-recovery path).
// LDK staging happens before finish (nothing committed yet on that path);
// the server refuses to commit without usable recovery material (409, token
// unspent); only a post-commit surprise rolls the credential back (DELETE),
// and then the user needs a fresh transfer code / recovery restart — the
// enrollment token was consumed.

// renderLocalOnlyConsent shows the warned-consent screen the research doc
// requires and resolves true once local-only enrollment (finish + both
// verifications) completes, false after rendering a terminal state on cancel
// or failure.
function renderLocalOnlyConsent(app, ctx) {
  return new Promise((resolve) => {
    app.innerHTML = `
      <section class="wizard-step">
        <h1>Use this passkey without PRF? (experimental)</h1>
        <p id="local-only-warning"></p>
        <p>Enrollment finishes only after this browser saves its local key
           and your Emergency Kit is confirmed on file. Without both, this
           passkey cannot hold your vault.</p>
        <label class="wizard-ack">
          <input type="checkbox" id="local-only-ack-checkbox">
          I understand this passkey cannot recover my vault by itself.
        </label>
        <button id="local-only-continue" disabled>Continue without PRF</button>
        <button id="local-only-cancel" class="secondary">Back</button>
      </section>`;
    app.querySelector('#local-only-warning').textContent = LOCAL_ONLY_WARNING_COPY;
    const checkbox = app.querySelector('#local-only-ack-checkbox');
    const confirm = app.querySelector('#local-only-continue');
    checkbox.addEventListener('change', () => { confirm.disabled = !checkbox.checked; });
    app.querySelector('#local-only-cancel').addEventListener('click', () => {
      renderUnsupportedAuthenticator(app);
      resolve(false);
    });
    confirm.addEventListener('click', () => {
      confirm.disabled = true;
      app.querySelector('#local-only-cancel').disabled = true;
      enrollLocalOnly(app, ctx).then(
        () => resolve(true),
        (err) => {
          renderLocalOnlyFailure(app, err);
          resolve(false);
        }
      );
    });
  });
}

function renderLocalOnlyFailure(app, err) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Local-only enrollment failed</h1>
      <p class="wizard-error"></p>
      <p>Generate a new code on your other device — or restart recovery — to try again.</p>
    </section>`;
  app.querySelector('.wizard-error').textContent = err.message || String(err);
}

// enrollLocalOnly finishes a standard WebAuthn registration with the explicit
// local_only mode and NO envelope. The LDK is staged and verified BEFORE
// finish — a storage-blocked browser fails while its enrollment token is
// still unspent and nothing is committed anywhere — and the server commits
// only when usable recovery material exists (checked in the same transaction
// as the insert, so a crash past finish cannot strand a kit-less
// credential). Throws on any failure; EVERY failure path below funnels
// through the outer catch, which puts the LDK cache back the way it found
// it — restoring the pre-existing record when there was one, clearing the
// staged one otherwise — so a failed enrollment never leaves a warm cache
// for a device that was never enrolled (that cache would warm-redirect into
// the app with no valid session and 401 on every call).
export async function enrollLocalOnly(app, { credential, accountId, dek }) {
  const prior = await readLdkRecord().catch(() => null);
  await establishLdkCache(dek, accountId);
  try {
    await verifyLdkDurable(dek, accountId);

    const finishBody = credential.toJSON();
    // Never transmit the PRF output — and a local-only finish carries no
    // envelope at all (the server rejects one if present).
    if (finishBody.clientExtensionResults) delete finishBody.clientExtensionResults.prf;

    const finishRes = await fetch('/api/webauthn/register/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: finishBody, mode: CREDENTIAL_MODE_LOCAL_ONLY }),
    });
    if (finishRes.status === 409) {
      // The server refused to commit without usable recovery material; the
      // token is unspent, so saving a kit and retrying needs no fresh code.
      throw new Error('No Emergency Kit is on file for this account — save one from a PRF device first.');
    }
    if (!finishRes.ok) {
      throw new Error('Passkey registration failed. Please try again.');
    }

    // The server committed only because usable recovery material exists; the
    // client-visible half is re-confirmed as defense-in-depth, rolling the
    // credential back on anything unexpected.
    const credentialId = new Uint8Array(credential.rawId);
    try {
      await confirmRecoveryMaterial();
    } catch (err) {
      try {
        await fetch(`/api/devices/${toBase64Url(credentialId)}`, { method: 'DELETE' });
      } catch {
        // The rollback is best-effort; the user-visible error is the reason
        // enrollment failed, not the cleanup.
      }
      throw err;
    }
  } catch (err) {
    try {
      if (prior) await restoreLdkCache(prior);
      else await clearLdkCache();
    } catch {
      // Cache housekeeping must not mask the enrollment error.
    }
    throw err;
  }
  return true;
}

// verifyLdkDurable proves the fresh LDK record actually persisted: it reads
// the record back and unwraps it, comparing against the DEK this ceremony
// holds. A write that silently vanished (storage-blocked private mode, quota
// policy) fails enrollment instead of stranding the vault.
async function verifyLdkDurable(dek, accountId) {
  let record = null;
  try {
    record = await readLdkRecord();
  } catch {
    record = null;
  }
  if (!record || record.accountId !== accountId) {
    throw new Error('This browser could not save its local key — local-only enrollment needs working site storage.');
  }
  let roundTrip = null;
  try {
    roundTrip = await unwrapWithLdk(record);
  } catch {
    roundTrip = null;
  }
  if (!roundTrip || !timingSafeEqual(roundTrip, dek)) {
    throw new Error('Local key verification failed — this browser\u2019s storage may be unreliable.');
  }
}

// confirmRecoveryMaterial requires the account's recovery envelope on file
// before a local-only credential counts as enrolled — the Emergency Kit is
// this mode's only cold-recovery path. (The server writes the recovery
// envelope + verifier atomically and re-checks both halves in its
// last-credential guard; envelope presence here is the client-visible half.)
async function confirmRecoveryMaterial() {
  const res = await fetch('/api/envelopes');
  if (!res.ok) throw new Error('Could not confirm your Emergency Kit is on file.');
  const envelopes = await res.json();
  if (!Array.isArray(envelopes) || !envelopes.some((e) => e && e.credential_ref === 'recovery')) {
    throw new Error('No Emergency Kit is on file for this account — save one from a PRF device first.');
  }
}
