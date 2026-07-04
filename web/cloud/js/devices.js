// Device-list + revocation screen: docs/cloud-crypto.md "Removing a device /
// revocation" and the envelope-audit MAC ("Malicious operator adds their own
// credential"). An unlocked device already holds the DEK, so it re-derives
// K_mac and checks every envelope's mac before rendering a verified /
// unverified badge — a forged envelope (no DEK access) fails the audit.
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
  app.querySelector('#devices-back').addEventListener('click', onExit);
}

function renderDeviceRow(app, ctx, onExit, d) {
  const li = document.createElement('li');
  li.className = 'device-row';

  // Server-controlled fields (credential id, timestamps) — textContent only,
  // never innerHTML (this page holds the DEK; XSS here reads it).
  const label = document.createElement('span');
  label.textContent = `Passkey ${d.credential_id.slice(0, 8)}… — added ${new Date(d.created_at).toLocaleDateString()}`;
  li.appendChild(label);

  const badge = document.createElement('span');
  badge.className = d.verified ? 'device-verified' : 'device-unverified';
  badge.textContent = d.verified ? 'verified' : 'unverified — remove?';
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
