// Recovery ceremony (docs/cloud-crypto.md "Recovery", Path C): reached at
// /recover on a fresh device that has neither a synced passkey nor a warm
// LDK cache. The user types the Account ID and recovery code printed on
// their Emergency Kit; account_id is never sent to the server (the subdomain
// host already resolves it) — it only seeds the client-side KEK_rec/verifier
// derivation, so a wrong account id just fails AEAD/verifier checks rather
// than reaching a different account.
import {
  parseRecoveryCode,
  deriveKEKRec,
  deriveVerifier,
  unwrapEnvelope,
  fromBase64,
  toBase64,
} from './crypto.js';
import { enrollWithToken } from './claim.js';
import { renderEmergencyKit } from './signup.js';

export async function runRecoverFlow() {
  renderRecoverForm(document.getElementById('app'));
}

function renderRecoverForm(app, errorText) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Recover your account</h1>
      <p>Enter the Account ID and recovery code from your Emergency Kit.</p>
      <input type="text" id="recover-account-input" placeholder="Account ID" autocomplete="off">
      <input type="text" id="recover-code-input" placeholder="Recovery code" autocomplete="off">
      <button id="recover-submit">Recover</button>
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
  app.querySelector('#recover-submit').addEventListener('click', () => {
    const accountId = app.querySelector('#recover-account-input').value.trim();
    const code = app.querySelector('#recover-code-input').value.trim();
    if (!accountId || !code) {
      renderRecoverForm(app, 'Enter both the Account ID and the recovery code exactly as printed.');
      return;
    }
    redeem(app, accountId, code).catch((err) => renderRecoverForm(app, err.message || String(err)));
  });
}

async function redeem(app, accountId, code) {
  let codeBytes;
  try {
    codeBytes = await parseRecoveryCode(code);
  } catch {
    throw new Error('Recovery code is invalid — check it against your Emergency Kit.');
  }

  app.innerHTML = `
    <section class="wizard-step">
      <h1>Recover your account</h1>
      <p>Verifying&hellip;</p>
    </section>`;

  const kekRec = await deriveKEKRec(codeBytes, accountId);
  const verifier = await deriveVerifier(codeBytes, accountId);

  const recoverRes = await fetch('/api/recover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verifier: toBase64(verifier) }),
  });
  if (recoverRes.status === 429) {
    throw new Error('Too many recovery attempts — try again in an hour.');
  }
  if (!recoverRes.ok) {
    throw new Error('Account ID or recovery code is incorrect.');
  }
  const { envelope, enrollment_token: enrollmentToken } = await recoverRes.json();

  let dek;
  try {
    dek = await unwrapEnvelope({
      kek: kekRec,
      envelope: { nonce: fromBase64(envelope.nonce), ct: fromBase64(envelope.ct) },
      accountId,
      credentialId: 'recovery',
    });
  } catch {
    throw new Error('Could not unlock your data with this Account ID and code.');
  }

  if (!(await enrollWithToken(app, { enrollmentToken, accountId, dek }))) return;

  // Forced rotation: a redeemed recovery code is burned per
  // docs/cloud-crypto.md — re-run the same Emergency Kit ceremony signup
  // uses so the account leaves with a fresh code/envelope/verifier.
  await renderEmergencyKit(app, { accountId, dek, onKitSaved: () => { location.href = '/'; } });
}
