// Claim/registration wizard: the passkey signup ceremony described in
// docs/cloud-crypto.md "Signup (first device)". Drives the account shell
// (signup.html's #app) through create-passkey -> Emergency Kit (with the
// loss-protection ack) -> optional Telegram link -> optional AI trial, then enters the app itself. Each
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
import { createCredential, passkeyCeremony, prfProbe } from './passkey-get.js';
import { diagHttp } from './passkey-diag.js';
import { isIOS, isMobile, isStandalone, iosInstallStepsHtml } from './push.js';
import { downloadDoc, printDoc } from './print-doc.js';
import { stashKitSaved } from './kit-state.js';

const EXPIRED_LINK_MESSAGE = 'Could not start passkey registration — the invite link may be expired.';
// Android shell's steady busy step (passkey-get.js passkeyCeremony).
const CREATE_CEREMONY_COPY = {
  busy: 'Setting up your passkey…',
  hint: 'Google will then ask you to confirm the passkey you just created — choose it to finish.',
  failed: "Couldn't set up your passkey. Tap Create your passkey to try again.",
};

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
      <button id="unlock-instead" class="wg-btn wg-btn--primary">Unlock with your passkey</button>
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
      <p>Your vault is encrypted on this device. This server only stores an
         encrypted bundle it cannot read, and rings your reminders.</p>
      <p>Some optional extras send data outside the vault and are not
         end-to-end encrypted. Telegram, trial AI, trial voice, and the hosted
         Claude connector stay off until you switch them on. Food search and
         drug lookups have no switch — they go through an operator proxy
         whenever you use them. Settings lists exactly what each one shares.</p>
      <button id="create-passkey" class="wg-btn wg-btn--primary">Create your passkey</button>
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
    passkeyCeremony(app, CREATE_CEREMONY_COPY, () => startRegistration(app, claimToken)).catch((err) => {
      renderWelcome(app, claimToken, err.message || String(err));
    });
  });
}

async function startRegistration(app, claimToken) {
  const beginRes = diagHttp('register/begin', await beginRegistration(claimToken));
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

  const credential = await createCredential(creationOptions);

  // PRF availability is only reliable from a fresh assertion, never from
  // create()'s "enabled" flag alone — docs/cloud-crypto.md "Registration
  // caveat". Probe it before calling finish, so an unsupported authenticator
  // aborts here (register/finish is never called => no account is ever
  // claimed for it).
  const salt = await saltKek();
  const prfAssertion = await prfProbe(credential.rawId, salt);
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

  const finishRes = diagHttp('register/finish', await fetch('/api/webauthn/register/finish', {
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
  }));
  // Losing the claim race between begin and finish rolls the registration back
  // server-side ("claim already used or expired"); the winner owns the account.
  if (finishRes.status === 409) {
    renderAlreadyClaimed(app);
    return;
  }
  if (!finishRes.ok) throw new Error('Passkey registration failed. Please try again.');

  await showSignupKit(app, { accountId, dek });
}

// The account exists from here on, so a failed kit upload must not fall back
// to "Create your passkey" (the claim is spent): retry the kit in place.
function showSignupKit(app, ctx) {
  return renderEmergencyKit(app, ctx).catch((err) => {
    app.innerHTML = `
      <section class="wizard-step">
        <h1>Couldn't create your Emergency Kit</h1>
        <p class="wizard-error" id="kit-setup-error"></p>
        <button id="kit-retry" class="wg-btn wg-btn--primary">Try again</button>
      </section>`;
    app.querySelector('#kit-setup-error').textContent = err.message || String(err);
    app.querySelector('#kit-retry').addEventListener('click', () => showSignupKit(app, ctx));
  });
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

// Signup's tail after the kit page: the server-side loss acknowledgement
// (POST /api/loss-ack — the kit page's "I saved it" is that acknowledgement
// now, bd med-ckm5.2), then the optional Telegram step.
async function finishSignupKit(app, ctx) {
  const res = await fetch('/api/loss-ack', { method: 'POST' });
  if (!res.ok) throw new Error('Could not save your acknowledgment. Try again.');
  return renderTelegramStep(app, ctx);
}

// The one Emergency Kit page (bd med-ckm5.2, design O1 in
// screens-onboarding.html): loss protection and the kit together, three
// disclosures, an "I saved it" choice, Continue docked in .wg-pagefoot.
//
// Exported so recover.js re-renders the identical Emergency Kit screen for
// the forced code rotation after a successful recovery redemption, and so
// devices.js can offer "Regenerate Emergency Kit" (med-d5t.12), rather than a
// second copy of this ceremony. ctx.onKitSaved, if given, replaces the default
// loss-ack-then-telegram tail (recover.js redirects to the already-unlocked
// vault itself) and drops signup's step indicator; ctx.continueLabel renames
// its button.
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

  const signup = !ctx.onKitSaved;
  const disc = (icon, title, desc, body, extra = '', leadId = '') => `
        <details class="wg-disc">
          <summary><span class="wg-row__lead${icon === 'alert' ? ' wg-row__lead--sun' : ''}"${leadId}><i class="wg-ico" data-icon="${icon}"></i></span><span class="wg-setting__body"><span class="wg-setting__title">${title}</span><span class="wg-setting__desc"${extra ? ' id="kit-save-desc"' : ''}>${desc}</span></span>${extra}<i class="wg-ico wg-disc__chev" data-icon="chev-d"></i></summary>
          <div class="wg-disc__body">${body}</div>
        </details>`;
  app.innerHTML = `
    <section class="kit-page">
      <div class="wg-content">
        <div class="wg-vstack">
          ${signup ? '<span class="wg-hstack"><span class="wg-steps"><i class="is-done"></i><i class="is-done"></i><i class="is-now"></i><i></i><i></i></span><span class="wg-meta">Step 3 of 5</span></span>' : ''}
          <h1 class="wg-shell__title">Save your Emergency Kit</h1>
          <p class="wg-shell__lede">It's the only way back in if you lose every passkey.</p>
        </div>
        ${disc('alert', 'Why it matters', 'There\'s no password reset', `
          <p>Your account opens with passkeys on your devices. If you lose all of them, the kit is the only way back in. Nobody, including us, can reset it for you, and this page won't show the code again.</p>
          <p>If your passkey syncs (iCloud Keychain, Google Password Manager), losing one device locks nothing. You can add a second device later.</p>`)}
        ${disc('key', 'What\'s in the kit', 'Address, ID, recovery code, QR', `
          <dl class="wg-kv">
            <div><dt>Account address</dt><dd id="kit-url"></dd></div>
            <div><dt>Account ID</dt><dd id="kit-account-id"></dd></div>
            <div><dt>Recovery code</dt><dd id="kit-code">${formatted}</dd></div>
          </dl>
          <div class="wg-hstack"><span class="wg-qr">${qrSvg}</span><span class="wg-hint">The QR opens this account on a new phone: first run → Scan.</span></div>`)}
        ${disc('download', 'Download or print', 'A one-page document', `
          <div class="wg-hstack">
            <button type="button" id="kit-download" class="wg-btn"><i class="wg-ico wg-ico--sm" data-icon="download"></i>Download kit</button>
            <button type="button" id="kit-print" class="wg-btn wg-btn--ghost"><i class="wg-ico wg-ico--sm" data-icon="print"></i>Print</button>
          </div>
          <p>Keep it somewhere other than this device: printed, or in a password manager.</p>`,
          '<span class="wg-chip wg-chip--warn wg-chip--sm" id="kit-save-chip">Not saved</span>', ' id="kit-save-lead"')}
        <button type="button" id="kit-saved" class="wg-choice wg-choice--check" aria-pressed="false"><span>I saved my Emergency Kit<span class="wg-choice__sub">Somewhere other than this device</span></span></button>
        <div class="wg-note wg-note--warn" id="kit-risk" hidden><i class="wg-ico" data-icon="alert"></i><div class="wg-note__body"><span><b>We didn't see a download or print here.</b> That's fine if you saved it another way. Settings will show a reminder until you do.</span></div></div>
        <p class="wizard-error" id="kit-error" hidden></p>
      </div>
      <footer class="wg-pagefoot">
        <button type="button" id="kit-continue" class="wg-btn wg-btn--primary wg-btn--lg" disabled>${escapeHtml(ctx.continueLabel || 'Continue')}</button>
        <p class="wg-hint" id="kit-hint">Confirm you saved the kit to continue</p>
      </footer>
    </section>`;

  // Origin and server-assigned id — set via textContent, never innerHTML.
  app.querySelector('#kit-url').textContent = kitUrl;
  app.querySelector('#kit-account-id').textContent = ctx.accountId;
  const q = (sel) => app.querySelector(sel);
  const choice = q('#kit-saved');
  const button = q('#kit-continue');
  const hydrate = () => globalThis.WGIcons?.hydrate?.(app);
  hydrate();

  // "I saved it" alone unlocks Continue (at the user's own risk, design O1):
  // a download or print here only changes what the page says, and which `how`
  // the synced emergencykit record gets (kit-state.js) — Settings keeps a
  // reminder for an `ack` until a kit is actually produced.
  let produced = null; // { how: 'download' | 'print', at }
  const ticked = () => choice.getAttribute('aria-pressed') === 'true';
  const sync = () => {
    button.disabled = !ticked();
    q('#kit-hint').hidden = ticked();
    q('#kit-risk').hidden = !ticked() || !!produced;
  };
  const markProduced = (how) => {
    produced = { how, at: Date.now() };
    const time = new Date(produced.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const kb = Math.max(1, Math.round(new TextEncoder().encode(kitDoc).length / 1024));
    q('#kit-save-desc').textContent = how === 'download' ? `Downloaded ${time} · HTML, ${kb} KB` : `Printed ${time}`;
    q('#kit-save-lead').className = 'wg-row__lead wg-row__lead--ok';
    const chip = q('#kit-save-chip');
    chip.className = 'wg-chip wg-chip--ok wg-chip--sm';
    chip.innerHTML = '<i class="wg-ico" data-icon="check"></i>Saved';
    hydrate();
    // The download/print IS the confirmation — tick it for the user (med-eas.47);
    // it stays a toggle.
    choice.setAttribute('aria-pressed', 'true');
    sync();
  };

  choice.addEventListener('click', () => {
    choice.setAttribute('aria-pressed', String(!ticked()));
    sync();
  });
  q('#kit-download').addEventListener('click', () => {
    // In-app browsers (and a few privacy modes) refuse Blob downloads. Fall
    // through to the printable view rather than leaving the user without a kit.
    if (downloadKit(kitDoc, ctx.accountId)) markProduced('download');
    else { printKit(kitDoc); markProduced('print'); }
  });
  q('#kit-print').addEventListener('click', () => {
    printKit(kitDoc);
    markProduced('print');
  });

  button.addEventListener('click', () => {
    button.disabled = true;
    const error = q('#kit-error');
    error.hidden = true;
    stashKitSaved(produced ? { savedAt: produced.at, how: produced.how } : { savedAt: Date.now(), how: 'ack' });
    Promise.resolve()
      .then(() => (ctx.onKitSaved ? ctx.onKitSaved() : finishSignupKit(app, ctx)))
      .catch((err) => {
        error.textContent = err.message || String(err);
        error.hidden = false;
        button.disabled = false;
      });
  });
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
//
// Hoisted out of the template so printKit can hand the same bytes to
// print-doc.js: this origin's `style-src 'self'` refuses the inline <style>
// inside the print iframe (which inherits the embedder's policy), so the frame
// adopts this as a constructed stylesheet instead. The document keeps the
// inline copy — that is what styles the file saved to disk.
const KIT_CSS = `
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
`;

export function buildKitDocument({ kitUrl, accountId, formatted, qrSvg }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Med Tracker Emergency Kit — ${escapeHtml(accountId)}</title>
<style>${KIT_CSS}</style>
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

// The blob download + offscreen-iframe print live in print-doc.js — the
// doctor-visit brief (med-5k6t.2) needs the identical pair. Returns false when
// the browser refuses the download, so the caller can fall back to print. The
// recovery code lives in the Blob's *contents*; a blob: URL is an opaque UUID,
// so it never lands in a URL, a request, or a log.
function downloadKit(docHtml, accountId) {
  return downloadDoc(document, docHtml, `med-tracker-emergency-kit-${accountId}.html`);
}

function printKit(docHtml) {
  printDoc(document, docHtml, 'kit-print-frame', KIT_CSS);
}

// Wizard step 5: optional Telegram linking. mountTelegram self-gates on the
// server's status (enabled + state === 'none'); when Telegram is disabled or
// already resolved it calls onDone immediately, so the wizard falls straight
// through into the app with no dead step.
async function renderTelegramStep(app, ctx) {
  try {
    const { mountTelegram } = await import('./telegram.js');
    await mountTelegram(app, { onDone: () => renderTrialStep(app, ctx) });
  } catch (e) {
    console.error('[signup] telegram step failed', e);
    renderTrialStep(app, ctx);
  }
}

// Shared with web/static/js/features/firstrun (index.js + screens/integrations.js),
// which read it on the app's first open.
const TRIAL_CHOICE_KEY = 'wg-onboarding-trial-choice';

// Wizard step 5b (bd med-w6sx): the free AI trial, next to Telegram. Shown only
// where the operator configured a trial key (the same medtracker-trial-ai meta
// the app reads). This is the ONE trial question (bd med-nt9p.40): it shows the
// app's `ai` consent disclosure word for word (web/static/js/features/
// trial-consent.js COPY.ai + ALTERNATIVE — signup.install-step.test.js pins the
// match), so "Allow" here is the consent. This page cannot write the
// trialconsent vault record, so it stores 'trial-allowed' and the app records
// the grant on first open (WGFirstRun.mount) without asking again. The app
// opens in this same browser right after the wizard (enterApp), so
// localStorage carries the choice.
//
// Not shown where the next step sends the user to a fresh storage container:
// iOS Safari's install step ends in the Home Screen app, which cannot read this
// tab's localStorage, so its first-run overlay asks instead — still once.
// Nor where storage is blocked: the answer could not reach the app, which would
// then ask again.
function canCarryTrialChoice() {
  try {
    localStorage.setItem(TRIAL_CHOICE_KEY, localStorage.getItem(TRIAL_CHOICE_KEY) ?? '');
    return true;
  } catch {
    return false;
  }
}

function renderTrialStep(app, ctx) {
  if (document.querySelector('meta[name="medtracker-trial-ai"]')?.content !== '1'
      || (isIOS() && isMobile() && !isStandalone())
      || !canCarryTrialChoice()) {
    renderInstallStep(app, ctx);
    return;
  }
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Try the AI features for free</h1>
      <p>Log food by description or photo without your own AI key. The free
         trial is rate-limited and runs on the operator’s shared key, outside
         the vault.</p>
      <p data-trial-disclosure>Your meal descriptions and meal photos will be sent to an AI model for parsing.</p>
      <p data-trial-disclosure>This content transits the operator’s AI provider account (OpenAI or Anthropic, the operator’s choice) — the operator’s provider processes it on the operator’s key.</p>
      <p data-trial-disclosure>Alternative: add your own key in Settings → Integrations, and this data goes only to your own provider account.</p>
      <div class="wizard-actions">
        <button id="trial-try" class="wg-btn wg-btn--primary">Allow the free trial</button>
        <button id="trial-own-keys" class="wg-btn">Use my own keys</button>
        <button id="trial-skip" class="wg-btn wg-btn--ghost">Skip</button>
      </div>
      <p class="muted">You can switch any time in Settings → AI &amp; integrations.</p>
    </section>`;
  const pick = (choice) => {
    try {
      localStorage.setItem(TRIAL_CHOICE_KEY, choice);
    } catch {
      // Storage blocked: the app's onboarding overlay asks again instead.
    }
    renderInstallStep(app, ctx);
  };
  // 'trial-allowed', not the old 'trial': a shell from before bd med-nt9p.40
  // stored 'trial' WITHOUT showing the disclosure, and the app still asks that one.
  app.querySelector('#trial-try').addEventListener('click', () => pick('trial-allowed'));
  app.querySelector('#trial-own-keys').addEventListener('click', () => pick('own-keys'));
  app.querySelector('#trial-skip').addEventListener('click', () => pick('skip'));
}

// Wizard step 6: platform-aware "install & reopen". It is the last step before
// the app, i.e. immediately before anything arms reminders — the exact point
// where staying in a browser tab silently breaks push (med-v1z, bd med-eas.63).
//
// There is deliberately NO auto-redirect into the installed app: iOS exposes no
// API to open one, and Android's `beforeinstallprompt` only offers to install,
// never a handoff. Guiding is the whole of what the platform allows.
//
// Shown only when it can matter: a non-standalone MOBILE browser. Already
// standalone means installed (skip, no dead step); desktop delivers push to a
// plain tab, so nudging there is nagging. Never blocks — "Continue in browser
// anyway" always reaches the app, with the reactive Reminders-screen gate and
// Settings' iOS hint as fallbacks.
function renderInstallStep(app, ctx) {
  if (isStandalone() || !isMobile()) {
    enterApp(ctx);
    return;
  }
  if (isIOS()) {
    renderIOSInstallStep(app, ctx);
    return;
  }
  renderAndroidInstallStep(app, ctx);
}

// iOS gets the blunt truth: web push in a Safari tab is not degraded, it is
// absent. Reopening the installed app is a fresh storage container, so the
// wizard's progress cannot travel with it — the passkey can (platform keychain),
// which is why the instructions end on "unlock with the same passkey" rather
// than pretending the tab's session resumes. See docs/cloud-mode.md
// ("The wizard is stateless").
function renderIOSInstallStep(app, ctx) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Add to your Home Screen</h1>
      <p>Reminders cannot reach you in this browser tab. iOS delivers
         notifications only to an installed app — in Safari, Med Tracker cannot
         notify you at all.</p>
      ${iosInstallStepsHtml('Open Med Tracker from your Home Screen and unlock with the same passkey — everything you set up here is already saved.')}
      <button id="install-continue" class="wg-btn wg-btn--primary">I've installed it</button>
      <button id="install-skip" class="wg-btn wg-btn--ghost">Continue in browser anyway</button>
      <p class="muted">You can install later from Safari's Share menu — until
         you do, no reminders will arrive on this device.</p>
    </section>`;
  app.querySelector('#install-continue').addEventListener('click', () => enterApp(ctx));
  app.querySelector('#install-skip').addEventListener('click', () => enterApp(ctx));
}

// Android push DOES work from a browser tab — Chrome delivers to the service
// worker with the tab closed. Saying otherwise to make the install look
// necessary would be a lie, so this asks rather than warns.
function renderAndroidInstallStep(app, ctx) {
  const hasPrompt = !!deferredInstallPrompt;
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Add to your Home Screen</h1>
      <p>Installing gives you a home-screen icon and a full-screen app.
         Reminders work in Chrome either way, so this one is up to you.</p>
      ${hasPrompt
        ? '<button id="install-now" class="wg-btn wg-btn--primary">Add to Home Screen</button>'
        : '<p>Open your browser menu and choose “Install app” / “Add to Home Screen”.</p>'}
      <button id="install-skip" class="wg-btn wg-btn--ghost">Continue in browser anyway</button>
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
