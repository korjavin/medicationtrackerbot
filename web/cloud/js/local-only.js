// PROOF OF CONCEPT — bd med-eas.2.1. NOT cleared for production rollout.
//
// An explicitly-chosen credential mode for authenticators that cannot evaluate
// the WebAuthn PRF extension (docs/2026-07-13-cloud-prf-compatibility-research.md).
// An ordinary passkey authenticates the device to the server; the DEK is wrapped
// by the existing device-local non-extractable LDK (unlock.js) and by the
// recovery code. Nothing new is stored server-side that can decrypt anything:
// the account gets a recovery envelope (wrapped under a 160-bit code the server
// never sees) and NO per-credential envelope at all.
//
// Deliberately NOT implemented, per the research doc and the bead:
//   - no server/client XOR key share (rejected: gives the operator a durable
//     decrypting share and still doesn't make a synced passkey portable);
//   - no passphrase- or PIN-derived KEK (rejected under R5);
//   - no inference of this mode from a missing envelope, and no automatic
//     selection when PRF is unavailable — the user is shown the limitation and
//     must opt in.
//
// The whole path is inert unless the operator sets CLOUD_LOCAL_ONLY_PASSKEY_POC=1,
// which is what localOnlyPocEnabled() below probes and what the server enforces
// independently in internal/cloudserver/webauthn.go.

import { generateDEK } from './crypto.js';
import { establishLdkCache, readLdkRecord, unwrapWithLdk } from './unlock.js';

export const LOCAL_ONLY = 'local_only';

// Thrown by unlock.js's cold-unlock ceremony when the asserted credential is
// local-only: server authentication succeeded but there is no envelope to
// unwrap, so the honest answer is "use your Emergency Kit", not "your passkey
// is broken".
export class LocalOnlyPasskeyError extends Error {
  constructor() {
    super('This passkey can sign you in, but it cannot unlock your data on this browser.');
    this.name = 'LocalOnlyPasskeyError';
  }
}

// Probes the operator flag advertised at GET /api/version. Fails closed: any
// error, any non-true value, and the POC simply does not exist for this client.
export async function localOnlyPocEnabled(fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  try {
    const res = await doFetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.local_only_passkey_poc === true;
  } catch {
    return false;
  }
}

// Appends the opt-in entry point below signup.js's unsupported-authenticator
// message. Deliberately just a door to the warning screen — no consequential
// choice is offered here, because the consequence needs a full screen to state.
export function appendLocalOnlyOffer(app, ctx) {
  const section = app.querySelector('section');
  if (!section) return;

  const heading = document.createElement('h2');
  heading.textContent = 'Experimental: local-only passkey';
  section.appendChild(heading);

  const blurb = document.createElement('p');
  blurb.textContent =
    'There is an experimental mode that lets this passkey sign you in anyway. ' +
    'It has a serious limitation you need to read before choosing it.';
  section.appendChild(blurb);

  const button = document.createElement('button');
  button.id = 'local-only-offer';
  button.className = 'secondary';
  button.textContent = 'Read about local-only mode';
  button.addEventListener('click', () => renderLocalOnlyWarning(app, ctx));
  section.appendChild(button);
}

// The informed-consent screen. Every claim on it is literally true of the mode
// as implemented; nothing here is a footnote after the fact — the credential is
// not registered until the user has read this AND saved an Emergency Kit.
export function renderLocalOnlyWarning(app, ctx) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Local-only passkey</h1>
      <p>This passkey will be able to <strong>sign you in</strong>, but it
         <strong>cannot unlock your data</strong>. Your encryption key will be
         stored only in this browser, on this device.</p>
      <ul>
        <li>Clear this site's data, and this passkey <strong>cannot get your
            data back</strong>.</li>
        <li>Open your account in another browser or a private window, and this
            passkey <strong>cannot get your data back</strong>.</li>
        <li>Even if your passkey syncs to your other devices, it
            <strong>will not unlock your data there</strong>.</li>
        <li>The only ways back in are your <strong>Emergency Kit</strong> or a
            transfer from a device that is still unlocked.</li>
        <li>Saving the Emergency Kit is <strong>required</strong> here, not
            optional. It is your only backup.</li>
      </ul>
      <p>If you can use a hardware security key or a different browser instead,
         that is the better choice — it keeps a backup of your key that survives
         losing this browser.</p>
      <p class="wizard-error" id="local-only-error"></p>
      <label class="wizard-ack">
        <input type="checkbox" id="local-only-ack">
        I understand this passkey cannot recover my data, and that my Emergency
        Kit is my only backup.
      </label>
      <button id="local-only-continue" disabled>Continue with local-only mode</button>
      <button id="local-only-back" class="secondary">Go back</button>
    </section>`;

  const checkbox = app.querySelector('#local-only-ack');
  const button = app.querySelector('#local-only-continue');
  checkbox.addEventListener('change', () => { button.disabled = !checkbox.checked; });

  app.querySelector('#local-only-back').addEventListener('click', () => {
    import('./signup.js').then(({ renderUnsupportedAuthenticator }) =>
      renderUnsupportedAuthenticator(app, ctx));
  });

  button.addEventListener('click', () => {
    button.disabled = true;
    startLocalOnlyEnrollment(app, ctx).catch((err) => {
      // Nothing is claimed until register/finish, which is the very last step —
      // so every failure here leaves the invite still spendable.
      const errorEl = app.querySelector('#local-only-error');
      if (errorEl) errorEl.textContent = `${err.message || String(err)} Nothing was registered — you can try again.`;
      button.disabled = false;
    });
  });
}

// Order matters and is the point of the POC:
//   1. wrap the DEK with a fresh LDK and prove it reads back,
//   2. mint the recovery material,
//   3. make the user actually save the Emergency Kit,
//   4. only then finish WebAuthn registration — which persists the credential,
//      the recovery envelope and the verifier in ONE server transaction.
// A failure at any step leaves the claim unspent and the account non-existent.
export async function startLocalOnlyEnrollment(app, ctx) {
  const dek = generateDEK();
  await proveLocalKeyStorage(dek, ctx.accountId);

  const { buildRecoveryMaterial, renderKitScreen } = await import('./signup.js');
  const material = await buildRecoveryMaterial({ accountId: ctx.accountId, dek });

  await renderKitScreen(app, {
    accountId: ctx.accountId,
    dek,
    continueLabel: 'Finish setup',
    onKitSaved: () => {
      finishLocalOnlyRegistration(ctx.credential, material)
        .then(() => { location.href = '/'; })
        .catch((err) => renderEnrollmentFailure(app, ctx, err));
    },
  }, material.formatted);
}

// The DEK of a local-only credential exists in exactly two places: this
// browser's IndexedDB and the recovery envelope. So don't assume the write
// landed — write it, reopen the database, unwrap, and compare bytes. A browser
// that silently drops the record (partitioned storage, private mode, a quota
// policy) must fail here, before anything irreversible happens, rather than
// after the user has an account whose key evaporates when the tab closes.
//
// ponytail: this proves readable-now, not durable-forever. No web API can
// promise the latter; navigator.storage.persist() is the closest thing, so we
// ask for it best-effort. Eviction remains a real residual risk of the mode and
// is exactly why the Emergency Kit gate below is mandatory rather than skippable.
export async function proveLocalKeyStorage(dek, accountId) {
  try {
    await globalThis.navigator?.storage?.persist?.();
  } catch {
    // Unsupported or refused — the read-back check below is what actually gates.
  }

  await establishLdkCache(dek, accountId);
  const record = await readLdkRecord();
  if (!record) {
    throw new Error('This browser did not keep the encryption key.');
  }
  const roundTripped = await unwrapWithLdk(record);
  if (roundTripped.length !== dek.length || !roundTripped.every((b, i) => b === dek[i])) {
    throw new Error('This browser stored the encryption key incorrectly.');
  }
}

// register/finish carries key_mode plus the recovery material, so the server
// commits credential + recovery envelope + verifier atomically. It carries NO
// credential envelope — there is no KEK to make one with, and the server
// rejects the request if one is present anyway.
export async function finishLocalOnlyRegistration(credential, material) {
  const { recoveryMaterialWire } = await import('./signup.js');
  const finishBody = credential.toJSON();
  // Symmetry with the PRF path: never ship extension results to the server.
  if (finishBody.clientExtensionResults) delete finishBody.clientExtensionResults.prf;

  const res = await fetch('/api/webauthn/register/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      credential: finishBody,
      key_mode: LOCAL_ONLY,
      recovery: recoveryMaterialWire(material),
    }),
  });
  if (!res.ok) throw new Error('Registration failed.');
  // The warning screen is a strictly stronger acknowledgement than the generic
  // loss-protection step, and the user has already passed it; record it so the
  // app doesn't re-nag. Best effort — a failure here costs a duplicate prompt,
  // not access.
  fetch('/api/loss-ack', { method: 'POST' }).catch(() => {});
}

function renderEnrollmentFailure(app, ctx, err) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Registration didn't finish</h1>
      <p>Your invite has not been used, so you can try again.</p>
      <p class="wizard-error" id="local-only-error"></p>
      <button id="local-only-retry">Try again</button>
    </section>`;
  app.querySelector('#local-only-error').textContent = err.message || String(err);
  app.querySelector('#local-only-retry').addEventListener('click', () => renderLocalOnlyWarning(app, ctx));
}

// Cold open on a browser that does not hold this account's LDK cache: the
// passkey asserted fine (that is what the mode buys), but there is no envelope
// for it. Say exactly that, and point at the two paths that actually work.
export function renderLocalOnlyColdOpen(app) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>This passkey can't unlock your data here</h1>
      <p>You signed in successfully, but this is a <strong>local-only
         passkey</strong>: your encryption key was only ever stored in the
         browser where you set it up. It is not on the server, so signing in on
         this browser cannot recover it.</p>
      <p>Two things work:</p>
      <ul>
        <li><strong>Your Emergency Kit</strong> — recover with the code you
            saved when you created the account.</li>
        <li><strong>A device that is still unlocked</strong> — open Med Tracker
            there, go to Devices, and choose "Add a device".</li>
      </ul>
      <p><a href="/recover">Recover with your Emergency Kit</a></p>
    </section>`;
}
