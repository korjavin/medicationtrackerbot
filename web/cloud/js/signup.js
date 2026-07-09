// Claim/registration wizard: the passkey signup ceremony described in
// docs/cloud-crypto.md "Signup (first device)". Drives the account shell
// (signup.html's #app) through create-passkey -> loss-protection ack ->
// Emergency Kit. Each screen is rendered fresh from the outcome of the
// previous step rather than a stored step counter, per docs/cloud-mode.md
// Onboarding ("the wizard is stateless").
import {
  saltKek,
  generateDEK,
  deriveKEK,
  deriveKMac,
  wrapEnvelope,
  generateRecoveryCode,
  deriveKEKRec,
  deriveVerifier,
  toBase64,
} from './crypto.js';

const EXPIRED_LINK_MESSAGE = 'Could not start passkey registration — the invite link may be expired.';

// Probe register/begin before rendering: a claimed link must never show
// "Create your passkey". The probe's challenge cookie is harmlessly overwritten
// when the user clicks through and startRegistration calls begin again.
export async function runSignupWizard(claimToken) {
  const app = document.getElementById('app');
  let res;
  try {
    res = await beginRegistration(claimToken);
  } catch (err) {
    renderWelcome(app, claimToken, err.message || String(err));
    return;
  }
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    if (body.error === 'already_claimed') {
      renderAlreadyClaimed(app);
      return;
    }
  }
  renderWelcome(app, claimToken, res.ok ? undefined : EXPIRED_LINK_MESSAGE);
}

function beginRegistration(claimToken) {
  return fetch('/api/webauthn/register/begin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claim_token: claimToken }),
  });
}

function renderAlreadyClaimed(app) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>This invite has already been claimed</h1>
      <p>Unlock your vault with the passkey you already created.</p>
      <p>If this is a new device, open Med Tracker on your former device and
         share access from there.</p>
      <button id="unlock-instead">Unlock with your passkey</button>
    </section>`;
  app.querySelector('#unlock-instead').addEventListener('click', () => {
    // Same module app.js dispatches to for a returning device, so a claimed
    // link converges on the normal unlock path.
    import('./unlock.js')
      .then(({ runUnlockFlow }) => runUnlockFlow())
      .catch((err) => {
        const p = document.createElement('p');
        p.className = 'wizard-error';
        p.textContent = err.message || String(err);
        app.querySelector('section').appendChild(p);
      });
  });
}

function renderWelcome(app, claimToken, errorText) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Welcome to Med Tracker Cloud</h1>
      <p>Your data is encrypted on this device. This server only stores an
         encrypted bundle it cannot read, and rings your reminders.</p>
      <button id="create-passkey">Create your passkey</button>
    </section>`;
  // Error text may carry a browser exception message; render via textContent,
  // never interpolated into innerHTML (this page holds the DEK — XSS here reads it).
  if (errorText) {
    const p = document.createElement('p');
    p.className = 'wizard-error';
    p.textContent = errorText;
    app.querySelector('section').appendChild(p);
  }
  app.querySelector('#create-passkey').addEventListener('click', () => {
    startRegistration(app, claimToken).catch((err) => {
      renderWelcome(app, claimToken, err.message || String(err));
    });
  });
}

async function startRegistration(app, claimToken) {
  const beginRes = await beginRegistration(claimToken);
  if (!beginRes.ok) throw new Error(EXPIRED_LINK_MESSAGE);
  const { publicKey } = await beginRes.json();
  const creationOptions = PublicKeyCredential.parseCreationOptionsFromJSON(publicKey);

  // account_id is server-assigned but already present in the begin options
  // (user.id), so the client can derive the KEK and wrap the first envelope
  // before finish — letting finish persist credential + envelope atomically.
  const accountId = new TextDecoder().decode(creationOptions.user.id);

  const credential = await navigator.credentials.create({ publicKey: creationOptions });

  // PRF availability is only reliable from a fresh assertion, never from
  // create()'s "enabled" flag alone — docs/cloud-crypto.md "Registration
  // caveat". Probe it before calling finish, so an unsupported authenticator
  // aborts here (register/finish is never called => no account is ever
  // claimed for it).
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
    renderUnsupportedAuthenticator(app);
    return;
  }

  // Derive the DEK envelope up front and send it with the attestation response.
  // The server stores credential + envelope in one transaction, so a reload or
  // crash mid-signup can never leave a claimed credential with no envelope to
  // unwrap its DEK (which would dead-end cold unlock). If finish fails the whole
  // registration rolls back server-side and the still-valid claim can retry.
  const credentialId = new Uint8Array(credential.rawId);
  const dek = generateDEK();
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

  renderLossProtection(app, { accountId, dek });
}

// Exported so claim.js (device-transfer enrollment) shows the identical
// unsupported-authenticator state rather than a second copy of this copy.
export function renderUnsupportedAuthenticator(app) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>This device can't be used yet</h1>
      <p>Your passkey doesn't support the security feature (PRF) this app
         needs to protect your data. Try a hardware security key (e.g. a
         YubiKey) or a different device or browser.</p>
    </section>`;
}

function renderLossProtection(app, ctx) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Protect against device loss</h1>
      <p>We cannot recover your data if you lose every passkey and the
         Emergency Kit — there is no password reset. Before continuing:</p>
      <ul>
        <li>Check whether your passkey is synced (iCloud Keychain / Google
            Password Manager) — if so, losing this device is a non-event.</li>
        <li>You can add a second device later.</li>
        <li>Save the Emergency Kit on the next screen.</li>
      </ul>
      <label class="wizard-ack">
        <input type="checkbox" id="loss-ack-checkbox">
        I understand my data is unrecoverable if I lose this device.
      </label>
      <button id="loss-ack-continue" disabled>Continue</button>
    </section>`;
  const checkbox = app.querySelector('#loss-ack-checkbox');
  const button = app.querySelector('#loss-ack-continue');
  checkbox.addEventListener('change', () => { button.disabled = !checkbox.checked; });
  button.addEventListener('click', () => {
    button.disabled = true;
    fetch('/api/loss-ack', { method: 'POST' })
      .then((res) => {
        if (!res.ok) throw new Error('Could not save your acknowledgment.');
        return renderEmergencyKit(app, ctx);
      })
      .catch((err) => {
        button.disabled = false;
        renderLossProtectionError(app, err);
      });
  });
}

function renderLossProtectionError(app, err) {
  const p = document.createElement('p');
  p.className = 'wizard-error';
  p.textContent = err.message || String(err);
  app.querySelector('section').appendChild(p);
}

// Exported so recover.js re-renders the identical Emergency Kit screen for
// the forced code rotation after a successful recovery redemption, rather
// than a second copy of this ceremony. ctx.onKitSaved, if given, replaces the
// default "You're set up" done screen (recover.js redirects to the unlocked
// vault instead).
export async function renderEmergencyKit(app, ctx) {
  const { codeBytes, formatted } = await generateRecoveryCode();
  const kekRec = await deriveKEKRec(codeBytes, ctx.accountId);
  const verifier = await deriveVerifier(codeBytes, ctx.accountId);
  const kMac = await deriveKMac(ctx.dek);
  const envelopeRec = await wrapEnvelope({
    kek: kekRec, dek: ctx.dek, kMac, accountId: ctx.accountId, credentialId: 'recovery',
  });

  // Envelope + verifier go up in one atomic request: a partial write would
  // pair a new envelope with the old verifier, silently breaking recovery
  // (one code authenticates but can't decrypt, the other decrypts but can't
  // authenticate) and can strand the account past the last-credential guard.
  const recoveryRes = await fetch('/api/recovery-material', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      envelope: {
        v: envelopeRec.v,
        nonce: toBase64(envelopeRec.nonce),
        ct: toBase64(envelopeRec.ct),
        mac: toBase64(envelopeRec.mac),
      },
      verifier: toBase64(verifier),
    }),
  });
  if (!recoveryRes.ok) throw new Error('Could not save recovery material.');

  const kitUrl = location.origin;
  const { qrcode } = await import('../vendor/qrcode.mjs');
  const qr = qrcode(0, 'M');
  qr.addData(`${kitUrl}\n${ctx.accountId}\n${formatted}`);
  qr.make();

  app.innerHTML = `
    <section class="wizard-step kit">
      <h1>Your Emergency Kit</h1>
      <p>This is the only way back into your account if you lose every
         passkey. Save or print it now — it will not be shown again.</p>
      <dl>
        <dt>URL</dt><dd>${kitUrl}</dd>
        <dt>Account ID</dt><dd id="kit-account-id"></dd>
        <dt>Recovery code</dt><dd class="recovery-code">${formatted}</dd>
      </dl>
      <div class="kit-qr">${qr.createSvgTag(4)}</div>
      <label class="wizard-ack">
        <input type="checkbox" id="kit-saved-checkbox">
        I saved my Emergency Kit.
      </label>
      <button id="kit-continue" disabled>Enter Med Tracker</button>
    </section>`;

  // Server-controlled value — set via textContent, never innerHTML.
  app.querySelector('#kit-account-id').textContent = ctx.accountId;
  const checkbox = app.querySelector('#kit-saved-checkbox');
  const button = app.querySelector('#kit-continue');
  checkbox.addEventListener('change', () => { button.disabled = !checkbox.checked; });
  button.addEventListener('click', () => (ctx.onKitSaved ? ctx.onKitSaved() : renderTelegramStep(app)));
}

// Wizard step 5: optional Telegram linking. mountTelegram self-gates on the
// server's status (enabled + state === 'none'); when Telegram is disabled or
// already resolved it calls onDone immediately, so the wizard falls straight
// through to the done screen with no dead step.
async function renderTelegramStep(app) {
  try {
    const { mountTelegram } = await import('./telegram.js');
    await mountTelegram(app, { onDone: () => renderDone(app) });
  } catch (e) {
    console.error('[signup] telegram step failed', e);
    renderDone(app);
  }
}

function renderDone(app) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>You're set up</h1>
      <p>Your vault is unlocked on this device. The full app arrives with
         the next update.</p>
    </section>`;
}
