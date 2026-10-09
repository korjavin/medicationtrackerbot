// Device-list + revocation: docs/cloud-crypto.md "Removing a device /
// revocation" and the envelope-audit MAC ("Malicious operator adds their own
// credential"). An unlocked device already holds the DEK, so it re-derives
// K_mac and checks every envelope's mac before rendering a verified /
// unverified chip — a forged envelope (no DEK access) fails the audit.
//
// Mounted by the app's Settings → Devices & connectors page (med-xso6.25,
// kit S4; features/settings.js mountCloudDevices) — the module renders kit
// markup into the mount it is given and owns no page chrome. The one
// full-document ceremony left here is the Emergency Kit rotation
// (renderRegenerateKit), which the passkey shell runs at
// /devices?flow=emergency-kit (web/cloud/js/app.js).
//
// Devices only. The Claude/MCP connector lives in connectors.js and Telegram
// in Settings → Integrations, per med-lyv: which passkeys may open the vault
// is a separate question from which AI client may read it.
import { auditEnvelope, fromBase64, fromBase64Url } from './crypto.js';
import { CREDENTIAL_MODE_LOCAL_ONLY, normalizeCredentialMode } from './credential-mode.js';

// hooks: { onAddDevice() — the page opens the transfer flow;
//          onLoaded(devices) — the page refreshes its summary/nudge }
export function renderDeviceList(mount, ctx, hooks = {}) {
  mount.innerHTML = '<p class="wg-hint">Loading your devices&hellip;</p>';
  loadDevices(mount, ctx, hooks).catch((err) => {
    renderDeviceListError(mount, ctx, hooks, err.message || String(err));
  });
}

async function loadDevices(mount, ctx, hooks) {
  const res = await fetch('/api/devices');
  if (!res.ok) throw new Error('Could not load your devices.');
  const devices = await res.json();

  const audited = await Promise.all(
    (devices || []).map(async (d) => {
      const mode = normalizeCredentialMode(d.mode);
      // Local-only credentials carry no envelope by design — that absence is
      // expected, not an audit failure, so they skip the MAC audit entirely
      // and render their own chip. The mode is explicit, never inferred
      // from the missing envelope.
      if (mode === CREDENTIAL_MODE_LOCAL_ONLY) {
        return { ...d, mode, verified: false, localOnly: true };
      }
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
      return { ...d, mode, verified };
    })
  );

  renderDevices(mount, ctx, hooks, audited);
  if (typeof hooks.onLoaded === 'function') hooks.onLoaded(audited);
}

// Kit S4: one sun primary ("Add a device"); Revoke sits behind each row's
// overflow and confirms through a destructive dialog.
function renderDevices(mount, ctx, hooks, devices) {
  mount.innerHTML = `
    <section class="wg-section">
      <div class="wg-section__head"><span class="wg-eyebrow">Devices with a passkey</span></div>
      <div class="wg-list" id="device-list"></div>
      <button type="button" id="add-device-button" class="wg-btn wg-btn--primary wg-btn--block"><i class="wg-ico wg-ico--sm" data-icon="qr"></i>Add a device</button>
    </section>`;

  const list = mount.querySelector('#device-list');
  for (const d of devices) {
    list.appendChild(renderDeviceRow(mount, ctx, hooks, d));
  }

  mount.querySelector('#add-device-button').addEventListener('click', () => {
    if (typeof hooks.onAddDevice === 'function') hooks.onAddDevice();
  });
  hydrateIcons(mount);
}

function hydrateIcons(root) {
  if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(root);
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
      <button id="regen-continue" class="wg-btn wg-btn--primary" disabled>Confirm with passkey</button>
      <button id="regen-cancel" class="wg-btn">Cancel</button>
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

function renderDeviceRow(mount, ctx, hooks, d) {
  const row = document.createElement('div');
  row.className = 'wg-row device-row';

  const lead = document.createElement('span');
  lead.className = d.verified ? 'wg-row__lead wg-row__lead--ok' : 'wg-row__lead';
  lead.innerHTML = '<i class="wg-ico" data-icon="device"></i>';

  // Server-controlled fields (credential id, timestamps) — textContent only,
  // never innerHTML (this page holds the DEK; XSS here reads it).
  const body = document.createElement('span');
  body.className = 'wg-row__body';
  const title = document.createElement('span');
  title.className = 'wg-row__title';
  title.textContent = `Passkey ${d.credential_id.slice(0, 8)}…`;
  const meta = document.createElement('span');
  meta.className = 'wg-row__meta';
  meta.textContent = `added ${new Date(d.created_at).toLocaleDateString()}`;

  const chip = document.createElement('span');
  if (d.localOnly) {
    chip.className = 'wg-chip wg-chip--sm wg-chip--stale device-local-only';
    chip.textContent = 'Local-only — this browser only';
  } else if (d.verified) {
    chip.className = 'wg-chip wg-chip--sm wg-chip--ok device-verified';
    chip.textContent = 'Verified';
  } else {
    chip.className = 'wg-chip wg-chip--sm wg-chip--danger device-unverified';
    chip.textContent = 'Unverified — remove?';
  }
  meta.appendChild(chip);
  body.append(title, meta);
  row.append(lead, body);

  const label = d.localOnly ? 'Remove' : 'Revoke';
  const onClick = () => confirmRevoke(mount, ctx, hooks, d);
  if (window.WGRowActions) {
    window.WGRowActions.attach(row, { label: title.textContent, extra: [{ label, icon: 'trash', danger: true, onClick }] });
  } else {
    // The passkey shell's storage-blocked fallback menu (unlock.js) has no
    // row-actions component: a plain outlined destructive button.
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wg-btn wg-btn--sm wg-btn--danger-ghost';
    button.textContent = label;
    button.addEventListener('click', onClick);
    row.appendChild(button);
  }
  return row;
}

async function confirmRevoke(mount, ctx, hooks, d) {
  // Retiring a device you still control vs. a stolen one need different
  // responses: revocation alone only removes access going forward. A
  // stolen unlocked device already saw the DEK, so recovering from that
  // needs key rotation — out of scope here (docs/cloud-crypto.md "Removing
  // a device / revocation" status note) — hence the copy pointing there.
  const confirmed = await window.safeConfirm(
    d.localOnly
      ? 'Use this to sign out a browser you still control — it holds ' +
          'no vault key of its own. If the device was lost or stolen, removing here does not protect the ' +
          'copy it may have seen while unlocked — see the recovery guide about rotating your keys.'
      : 'Use this to retire a device you still control. If it was lost or ' +
          'stolen, revoking here does not protect your data on its own — see the recovery guide ' +
          'about rotating your keys.',
    null,
    d.localOnly
      ? { title: 'Remove this local-only sign-in?', confirmLabel: 'Remove', destructive: true, icon: 'device' }
      : { title: 'Revoke this device?', confirmLabel: 'Revoke', destructive: true, icon: 'device' },
  );
  if (!confirmed) return;
  revokeDevice(mount, ctx, hooks, d.credential_id);
}

async function revokeDevice(mount, ctx, hooks, credentialId) {
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(credentialId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Could not revoke that device. Try again.');
    renderDeviceList(mount, ctx, hooks);
  } catch (err) {
    renderDeviceListError(mount, ctx, hooks, err.message || String(err));
  }
}

function renderDeviceListError(mount, ctx, hooks, errorText) {
  mount.innerHTML = `
    <section class="wg-section">
      <p class="wg-error"></p>
      <button type="button" id="devices-retry" class="wg-btn wg-btn--block">Try again</button>
    </section>`;
  mount.querySelector('.wg-error').textContent = errorText;
  mount.querySelector('#devices-retry').addEventListener('click', () => renderDeviceList(mount, ctx, hooks));
}
