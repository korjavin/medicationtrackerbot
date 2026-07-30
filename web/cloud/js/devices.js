// Device-list + revocation screen: docs/cloud-crypto.md "Removing a device /
// revocation" and the envelope-audit MAC ("Malicious operator adds their own
// credential"). An unlocked device already holds the DEK, so it re-derives
// K_mac and checks every envelope's mac before rendering a verified /
// unverified badge — a forged envelope (no DEK access) fails the audit.
//
// Devices only. The Claude/MCP connector picker moved to connectors.js
// (/connectors) and Telegram to Settings → Integrations, per med-lyv: which
// passkeys may open the vault is a separate question from which AI client may
// read it, and answering both on one screen made the second look like a
// property of the first.
import { auditEnvelope, fromBase64, fromBase64Url } from './crypto.js';

export function renderDeviceList(app, ctx, onExit) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Devices</h1>
      <p>Loading your devices&hellip;</p>
    </section>`;
  loadDevices(app, ctx, onExit).catch((err) => {
    renderDeviceListError(app, ctx, onExit, err.message || String(err));
  });
}

async function loadDevices(app, ctx, onExit) {
  const res = await fetch('/api/devices');
  if (!res.ok) throw new Error('Could not load your devices.');
  const devices = await res.json();

  const audited = await Promise.all(
    (devices || []).map(async (d) => {
      const credentialId = fromBase64Url(d.credential_id);
      let verified = false;
      if (d.envelope) {
        verified = await auditEnvelope({
          dek: ctx.dek,
          envelope: {
            nonce: fromBase64(d.envelope.nonce),
            ct: fromBase64(d.envelope.ct),
            mac: fromBase64(d.envelope.mac),
          },
          credentialId,
        });
      }
      return { ...d, verified };
    })
  );

  renderDevices(app, ctx, onExit, audited);
}

function renderDevices(app, ctx, onExit, devices) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Devices</h1>
      <ul class="device-list" id="device-list"></ul>
      <button id="add-device-button">Add a device</button>
      <button id="regenerate-kit-button" class="secondary">Regenerate Emergency Kit</button>
      <button id="devices-back">Back</button>
    </section>`;

  const list = app.querySelector('#device-list');
  for (const d of devices) {
    list.appendChild(renderDeviceRow(app, ctx, onExit, d));
  }

  app.querySelector('#add-device-button').addEventListener('click', () => {
    import('./transfer.js')
      .then(({ renderAddDevice }) => renderAddDevice(app, ctx, () => renderDeviceList(app, ctx, onExit)))
      .catch(() => renderDeviceListError(app, ctx, onExit, 'Could not open the add-device flow. Try again.'));
  });

  app.querySelector('#regenerate-kit-button').addEventListener('click', () => {
    renderRegenerateKit(app, ctx, () => renderDeviceList(app, ctx, onExit));
  });

  app.querySelector('#devices-back').addEventListener('click', onExit);
}

// Regenerating is a ROTATION, never a reveal (med-d5t.12). The recovery code is
// derived client-side at signup and only its verifier and the recovery-wrapped
// envelope are uploaded, so the server has never seen the code and cannot show
// it to anyone — including the account's owner. The only thing Settings can do
// is mint a fresh one, which necessarily invalidates the old.
//
// Say that plainly before the user commits: a friend with a printed kit in a
// drawer is about to turn it into wastepaper.
export function renderRegenerateKit(app, ctx, onDone) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Regenerate Emergency Kit</h1>
      <p>We cannot show you your current recovery code. It was created on your
         device and never sent to the server — that is what makes your data
         unreadable to us.</p>
      <p>We can issue you a <strong>new</strong> kit. Doing so
         <strong>permanently invalidates your old recovery code</strong>. If you
         have one saved or printed somewhere, it will stop working the moment
         you continue.</p>
      <p class="wizard-error" id="regen-error"></p>
      <label class="wizard-ack">
        <input type="checkbox" id="regen-ack-checkbox">
        I understand my old Emergency Kit will stop working.
      </label>
      <button id="regen-continue" disabled>Confirm with passkey</button>
      <button id="regen-cancel" class="secondary">Cancel</button>
    </section>`;

  const checkbox = app.querySelector('#regen-ack-checkbox');
  const confirmButton = app.querySelector('#regen-continue');
  checkbox.addEventListener('change', () => { confirmButton.disabled = !checkbox.checked; });
  app.querySelector('#regen-cancel').addEventListener('click', onDone);

  confirmButton.addEventListener('click', () => {
    confirmButton.disabled = true;
    confirmButton.textContent = 'Waiting for your passkey…';
    rotateEmergencyKit(app, ctx, onDone).catch((err) => {
      // Nothing has been rotated: assertPasskey throws before any upload, and
      // renderEmergencyKit uploads the new envelope + verifier together in one
      // atomic request. The old kit still works.
      const errorEl = app.querySelector('#regen-error');
      if (errorEl) errorEl.textContent = `${err.message || String(err)} Your existing Emergency Kit still works.`;
      confirmButton.disabled = false;
      confirmButton.textContent = 'Confirm with passkey';
    });
  });
}

async function rotateEmergencyKit(app, ctx, onDone) {
  // A fresh assertion, not ctx.dek: an unlocked tab left open on a shared
  // laptop must not be enough to rotate someone's recovery credential. The
  // ceremony also hands back the DEK, so the rotation re-wraps the key the
  // authenticator just proved this user can reach.
  const { assertPasskey } = await import('./unlock.js');
  const { accountId, dek } = await assertPasskey();
  if (accountId !== ctx.accountId) {
    throw new Error('That passkey belongs to a different account.');
  }

  // Reuse the signup ceremony wholesale — including the download/print gate
  // from med-d5t.2. A second copy of this screen would drift, and the copy that
  // drifted would be the one that fails a friend who has lost their phone.
  const { renderEmergencyKit } = await import('./signup.js');
  await renderEmergencyKit(app, { accountId, dek, onKitSaved: onDone, continueLabel: 'Done' });
}

function renderDeviceRow(app, ctx, onExit, d) {
  const li = document.createElement('li');
  li.className = 'device-row';

  // Server-controlled fields (credential id, timestamps) — textContent only,
  // never innerHTML (this page holds the DEK; XSS here reads it).
  const label = document.createElement('span');
  label.textContent = `Passkey ${d.credential_id.slice(0, 8)}… — added ${new Date(d.created_at).toLocaleDateString()}`;
  li.appendChild(label);

  // A local-only credential (bd med-eas.2.1 POC) has no envelope by design, so
  // the audit has nothing to check. Calling that "unverified — remove?" would
  // be a false alarm on a credential the user deliberately chose — and would
  // teach them to ignore the badge that flags a genuinely forged envelope.
  const badge = document.createElement('span');
  if (d.key_mode === 'local_only') {
    badge.className = 'device-local-only';
    badge.textContent = 'local-only — key not backed up on the server';
  } else {
    badge.className = d.verified ? 'device-verified' : 'device-unverified';
    badge.textContent = d.verified ? 'verified' : 'unverified — remove?';
  }
  li.appendChild(badge);

  const revokeButton = document.createElement('button');
  revokeButton.textContent = 'Revoke';
  revokeButton.addEventListener('click', () => {
    // Retiring a device you still control vs. a stolen one need different
    // responses: revocation alone only removes access going forward. A
    // stolen unlocked device already saw the DEK, so recovering from that
    // needs key rotation — out of scope here (docs/cloud-crypto.md "Removing
    // a device / revocation" status note) — hence the copy pointing there.
    const confirmed = confirm(
      'Revoke this device?\n\nUse this to retire a device you still control. If it was lost or ' +
        'stolen, revoking here does not protect your data on its own — see the recovery guide ' +
        'about rotating your keys.'
    );
    if (!confirmed) return;
    revokeDevice(app, ctx, onExit, d.credential_id);
  });
  li.appendChild(revokeButton);

  return li;
}

async function revokeDevice(app, ctx, onExit, credentialId) {
  try {
    const res = await fetch(`/api/devices/${credentialId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Could not revoke that device. Try again.');
    renderDeviceList(app, ctx, onExit);
  } catch (err) {
    renderDeviceListError(app, ctx, onExit, err.message || String(err));
  }
}

function renderDeviceListError(app, ctx, onExit, errorText) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Devices</h1>
      <p class="wizard-error"></p>
      <button id="devices-retry">Try again</button>
      <button id="devices-back">Back</button>
    </section>`;
  app.querySelector('.wizard-error').textContent = errorText;
  app.querySelector('#devices-retry').addEventListener('click', () => renderDeviceList(app, ctx, onExit));
  app.querySelector('#devices-back').addEventListener('click', onExit);
}
