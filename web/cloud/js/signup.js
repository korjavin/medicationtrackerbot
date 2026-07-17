// Claim/registration wizard: the passkey signup ceremony described in
// docs/cloud-crypto.md "Signup (first device)". Drives the account shell
// (signup.html's #app) through create-passkey -> loss-protection ack ->
// Emergency Kit -> optional Telegram link, then enters the app itself. Each
// screen is rendered fresh from the outcome of the previous step rather than a
// stored step counter, per docs/cloud-mode.md Onboarding ("the wizard is
// stateless").
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
import { establishLdkCache } from './unlock.js';
import { isIOS, isStandalone, iosInstallStepsHtml } from './push.js';

const EXPIRED_LINK_MESSAGE = 'Could not start passkey registration — the invite link may be expired.';

// Android/desktop fire `beforeinstallprompt` when the origin becomes
// installable — which can happen well before the wizard reaches its install
// step. Capture (and suppress) it at module load so the install step can offer a
// real one-tap "Add to Home Screen" instead of only browser-menu instructions.
// iOS never fires this event, which is why that platform gets manual steps.
let deferredInstallPrompt = null;
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });
}

// Probe register/begin before rendering: a claimed link must never show
// "Create your passkey". The probe's challenge cookie is harmlessly overwritten
// when the user clicks through and startRegistration calls begin again.
export async function runSignupWizard(claimToken) {
  const app = document.getElementById('app');
  // The probe is a network round-trip; without this #app would be blank until
  // it resolves (and forever on a hung connection).
  renderChecking(app);
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

function renderChecking(app) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Checking your invite…</h1>
    </section>`;
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
  // The probe said "pending", but another tab/device may have claimed the invite
  // between then and this click. 409 is register/begin's only conflict status and
  // it always means already_claimed — route to unlock, not back to the welcome screen.
  if (beginRes.status === 409) {
    renderAlreadyClaimed(app);
    return;
  }
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
  // Losing the claim race between begin and finish rolls the registration back
  // server-side ("claim already used or expired"); the winner owns the account.
  if (finishRes.status === 409) {
    renderAlreadyClaimed(app);
    return;
  }
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
// the forced code rotation after a successful recovery redemption, and so
// devices.js can offer "Regenerate Emergency Kit" (med-d5t.12), rather than a
// second copy of this ceremony. ctx.onKitSaved, if given, replaces the default
// telegram-step-then-enter-app tail (recover.js redirects to the
// already-unlocked vault itself); ctx.continueLabel renames its button.
//
// Every caller is a rotation of the same shape: mint a code, re-wrap the DEK,
// upload envelope + verifier atomically, make the user actually save it. The
// upload happens BEFORE the kit renders, so any failure leaves the previous
// recovery material untouched and the old code still working.
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

  const qrSvg = qr.createSvgTag(4);
  const kitDoc = buildKitDocument({ kitUrl, accountId: ctx.accountId, formatted, qrSvg });

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
      <div class="kit-qr">${qrSvg}</div>
      <div class="kit-actions">
        <button id="kit-download">Download Emergency Kit</button>
        <button id="kit-print" class="secondary">Print it instead</button>
      </div>
      <label class="wizard-ack">
        <input type="checkbox" id="kit-saved-checkbox" disabled>
        I saved my Emergency Kit.
      </label>
      <p class="kit-hint" id="kit-hint">Download or print the kit to continue.</p>
      <button id="kit-continue" disabled>${escapeHtml(ctx.continueLabel || 'Enter Med Tracker')}</button>
    </section>`;

  // Server-controlled value — set via textContent, never innerHTML.
  app.querySelector('#kit-account-id').textContent = ctx.accountId;
  const checkbox = app.querySelector('#kit-saved-checkbox');
  const button = app.querySelector('#kit-continue');
  const hint = app.querySelector('#kit-hint');

  // Two gates, deliberately. Producing a file (or printing) is the one that
  // actually saves the account; the checkbox stays as a second line of defence
  // but can no longer be the ONLY one — ticking a box saved nobody's vault.
  let kitProduced = false;
  const sync = () => {
    checkbox.disabled = !kitProduced;
    button.disabled = !(kitProduced && checkbox.checked);
  };
  const markProduced = () => {
    kitProduced = true;
    // The download/print IS the confirmation — auto-tick the attestation so the
    // user isn't asked to separately confirm what they just did. Honest because
    // this only fires after a real save action, never on step view. The box
    // stays interactive as a manual fallback (untick/re-tick still works).
    checkbox.checked = true;
    hint.textContent = 'Kit saved and confirmed.';
    sync();
  };

  checkbox.addEventListener('change', sync);
  app.querySelector('#kit-download').addEventListener('click', () => {
    // In-app browsers (and a few privacy modes) refuse Blob downloads. Fall
    // through to the printable view rather than leaving the user stuck behind
    // a gate they cannot open.
    if (downloadKit(kitDoc, ctx.accountId)) markProduced();
    else { printKit(kitDoc); markProduced(); }
  });
  app.querySelector('#kit-print').addEventListener('click', () => {
    printKit(kitDoc);
    markProduced();
  });

  button.addEventListener('click', () => (ctx.onKitSaved ? ctx.onKitSaved() : renderTelegramStep(app, ctx)));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// A standalone document, because it has to survive being opened from the
// Downloads folder years later with no network and no stylesheet: inline SVG
// QR, inline CSS, no external references of any kind. HTML rather than .txt so
// the QR comes along, and so the same bytes are both savable and printable.
//
// ponytail: the few literal colors here are intentional — this file renders
// outside the app, where --wg-* tokens do not exist, and it is printed on
// white paper.
export function buildKitDocument({ kitUrl, accountId, formatted, qrSvg }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Med Tracker Emergency Kit — ${escapeHtml(accountId)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff;
         max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; }
  dt { font-weight: 600; margin-top: 1rem; }
  dd { margin: 0.25rem 0 0; }
  .code { font-family: ui-monospace, monospace; font-size: 1.25rem;
          letter-spacing: 0.08em; word-break: break-all; }
  .warn { border: 1px solid #111; padding: 0.75rem 1rem; margin: 1.5rem 0; }
  svg { max-width: 12rem; height: auto; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
<h1>Med Tracker — Emergency Kit</h1>
<p class="warn"><strong>This is the only way back into your account if you
lose every passkey.</strong> Anyone holding this page can unlock your health
data. Keep it on paper, or somewhere offline that only you can reach. It is
not stored anywhere else — not even on the server.</p>
<dl>
  <dt>URL</dt><dd>${escapeHtml(kitUrl)}</dd>
  <dt>Account ID</dt><dd class="code">${escapeHtml(accountId)}</dd>
  <dt>Recovery code</dt><dd class="code">${escapeHtml(formatted)}</dd>
</dl>
<p>Scan to recover:</p>
${qrSvg}
<p>To use it: open the URL above, choose “Recover account”, and enter the
recovery code. You will be issued a new code afterwards — this page then
becomes worthless, so replace it.</p>
</body>
</html>`;
}

// Returns false when the browser refuses the download, so the caller can fall
// back to print. The recovery code lives in the Blob's *contents*; a blob: URL
// is an opaque UUID, so it never lands in a URL, a request, or a log.
function downloadKit(docHtml, accountId) {
  try {
    const url = URL.createObjectURL(new Blob([docHtml], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `med-tracker-emergency-kit-${accountId}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Deferred: revoking synchronously can cancel the download in Safari.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  } catch (e) {
    console.error('[signup] emergency kit download failed');
    return false;
  }
}

// An offscreen iframe rather than window.print(): it prints the kit document
// itself, identically to the downloaded file, instead of the wizard chrome.
function printKit(docHtml) {
  const frame = document.createElement('iframe');
  frame.className = 'kit-print-frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.srcdoc = docHtml;
  frame.addEventListener('load', () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (e) {
      console.error('[signup] emergency kit print failed');
    }
  });
  document.body.appendChild(frame);
}

// Wizard step 5: optional Telegram linking. mountTelegram self-gates on the
// server's status (enabled + state === 'none'); when Telegram is disabled or
// already resolved it calls onDone immediately, so the wizard falls straight
// through into the app with no dead step.
async function renderTelegramStep(app, ctx) {
  try {
    const { mountTelegram } = await import('./telegram.js');
    await mountTelegram(app, { onDone: () => renderInstallStep(app, ctx) });
  } catch (e) {
    console.error('[signup] telegram step failed', e);
    renderInstallStep(app, ctx);
  }
}

// Wizard step 6: platform-aware "Add to Home Screen". Installing the PWA is what
// makes iOS web push work at all — Safari only delivers push to an installed
// app, so a user who finishes signup and never installs gets no reminders
// (med-v1z). It also improves push reliability + engagement on Android/desktop,
// so every non-standalone user is nudged, not just iOS. Derived state per
// docs/cloud-mode.md: already running standalone means it's installed, so skip
// straight through with no dead step. Never blocks — a "Skip for now" path
// always reaches the app, with the reactive Reminders-screen gate as fallback.
function renderInstallStep(app, ctx) {
  if (isStandalone()) {
    enterApp(ctx);
    return;
  }
  if (isIOS()) {
    renderIOSInstallStep(app, ctx);
    return;
  }
  renderGenericInstallStep(app, ctx);
}

function renderIOSInstallStep(app, ctx) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Add to your Home Screen</h1>
      <p>Install Med Tracker to your Home Screen so reminders can reach you —
         iOS only delivers notifications to an installed app.</p>
      ${iosInstallStepsHtml('Open Med Tracker from your Home Screen — your reminders will work from there.')}
      <button id="install-continue">I've installed it</button>
      <button id="install-skip" class="secondary">Skip for now</button>
    </section>`;
  app.querySelector('#install-continue').addEventListener('click', () => enterApp(ctx));
  app.querySelector('#install-skip').addEventListener('click', () => enterApp(ctx));
}

function renderGenericInstallStep(app, ctx) {
  const hasPrompt = !!deferredInstallPrompt;
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Add to your Home Screen</h1>
      <p>Install Med Tracker for reliable reminders and one-tap access.</p>
      ${hasPrompt
        ? '<button id="install-now">Add to Home Screen</button>'
        : '<p>Open your browser menu and choose “Install app” / “Add to Home Screen”.</p>'}
      <button id="install-skip" class="secondary">Skip for now</button>
    </section>`;
  app.querySelector('#install-skip').addEventListener('click', () => enterApp(ctx));
  const now = app.querySelector('#install-now');
  if (now) {
    now.addEventListener('click', async () => {
      now.disabled = true;
      try {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
      } catch (e) {
        // A rejected/interrupted prompt must not strand the wizard — the app is
        // installable later from the browser menu, and reminders re-arm on the
        // Reminders screen regardless.
        console.error('[signup] install prompt failed', e);
      }
      // One-shot: the browser will not let the same event prompt twice.
      deferredInstallPrompt = null;
      enterApp(ctx);
    });
  }
}

// The wizard's last step is the app itself: warm the LDK cache so cloud-boot's
// warmUnlock succeeds on '/', then go there. There is no confirmation screen —
// the app, with the first-run overlay on top, is the confirmation.
async function enterApp(ctx) {
  try {
    await establishLdkCache(ctx.dek, ctx.accountId);
  } catch {
    // Warm-cache is an optimization; a storage-blocked browser must still
    // reach the vault after a successful enrollment — cloud-boot routes it to
    // /unlock, where it signs in with the passkey it just created.
  }
  location.href = '/';
}
