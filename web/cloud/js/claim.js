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
} from './crypto.js';
import { renderUnsupportedAuthenticator } from './signup.js';
import { establishLdkCache } from './unlock.js';

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
// allowLocalOnlyFallback (recover.js only, bd med-eas.2.1 POC) lets a non-PRF
// authenticator finish an Emergency Kit redemption in local-only mode instead of
// dead-ending — otherwise the recovery path that mode declares mandatory would
// be unusable on exactly the authenticators it exists for. The device-transfer
// caller does not pass it: that flow ends by navigating into the app with no
// Emergency Kit step, so a local-only device would be enrolled there with no
// moment to state what it costs.
export async function enrollWithToken(app, { enrollmentToken, accountId, dek, allowLocalOnlyFallback }) {
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
    if (allowLocalOnlyFallback) {
      const { localOnlyPocEnabled, offerLocalOnlyEnrollment } = await import('./local-only.js');
      if (await localOnlyPocEnabled()) {
        return offerLocalOnlyEnrollment(app, { credential, accountId, dek });
      }
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
