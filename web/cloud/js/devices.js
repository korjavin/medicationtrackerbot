// Device-list + revocation: docs/cloud-crypto.md "Removing a device /
// revocation" and the envelope-audit MAC ("Malicious operator adds their own
// credential"). An unlocked device holds the verify-only K_mac leaf key, so it
// checks every envelope's mac before rendering a verified /
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
import { auditEnvelopeWithKey, fromBase64, fromBase64Url } from './crypto.js';

// AD11 (med-r1j2.6): the platform is the coarse label a v2 transfer reported
// (web|android|ios), shown as reported, never as proof. Rows without one
// keep the old "Passkey <id8>…" title.
const PLATFORM_LABELS = { web: 'Browser', android: 'Android phone', ios: 'iPhone' };
const KNOWN_DEVICES_KEY = 'knownDevices';
const NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
const SETTINGS_DEVICES_URL = '/?tab=settings&page=devices';
const renderBlocked = (mount) => !mount.isConnected || !mount.ownerDocument?.documentElement
  || mount.ownerDocument.documentElement.hasAttribute('data-provider-reload-committed');

function deviceLabel(d) {
  return PLATFORM_LABELS[d.platform] || `Passkey ${d.credential_id.slice(0, 8)}…`;
}

function shortDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function noticeText(d) {
  return `New device added: ${deviceLabel(d)}, ${shortDate(d.created_at)}`;
}

// The device-local, never-synced value store (sync.js 'device' object store).
// Lazy: the passkey shell renders this list too and has no business loading
// sync.js until it is asked for. null when it cannot be read.
async function deviceStore() {
  try {
    return (await import('./sync.js')).deviceValues;
  } catch {
    return null;
  }
}

async function readKnownDevices() {
  try {
    const store = await deviceStore();
    return store ? await store.get(KNOWN_DEVICES_KEY) : null;
  } catch {
    return null;
  }
}

// AD11 · notice: on account boot, diff the server's device list against the
// credential set this device last saw. The first run seeds the baseline
// silently; a new credential (never this device's own) toasts once, and stays
// a notice in Devices for 7 days in case the toast is missed. No server push.
export async function checkNewDevices(now = Date.now()) {
  const store = await deviceStore();
  if (!store) return;
  const res = await fetch('/api/devices');
  if (!res.ok) return;
  const devices = (await res.json()) || [];
  const known = await store.get(KNOWN_DEVICES_KEY);
  const ids = devices.map((d) => d.credential_id);
  const fresh = known ? devices.filter((d) => !d.current && !known.ids.includes(d.credential_id)) : [];
  const notices = [
    ...((known && known.notices) || []).filter((n) => now - n.at < NOTICE_MS && ids.includes(n.credential_id)),
    ...fresh.map((d) => ({ credential_id: d.credential_id, at: now })),
  ];
  await store.set(KNOWN_DEVICES_KEY, { ids, notices });
  for (const d of fresh) {
    window.safeToast(noticeText(d), 'info', {
      detail: 'Not you? Revoke it now.',
      duration: 10000,
      action: { label: 'Revoke', onClick: () => window.location.assign(SETTINGS_DEVICES_URL) },
    });
  }
}

// hooks: { onAddDevice() — the page opens the transfer flow;
//          onLoaded(devices) — the page refreshes its summary/nudge }
export function renderDeviceList(mount, ctx, hooks = {}) {
  if (renderBlocked(mount)) return;
  mount.innerHTML = '<p class="wg-hint">Loading your devices&hellip;</p>';
  loadDevices(mount, ctx, hooks).catch((err) => {
    renderDeviceListError(mount, ctx, hooks, err.message || String(err));
  });
}

// A redeploy blip (network error / 5xx) gets one quiet retry before the
// owner sees anything (med-e92o); a 4xx answer is final. The copy stays calm:
// a list that won't load says nothing about the vault itself.
const LIST_RETRY_MS = 1500;
const LIST_ERROR = "Couldn't reach the server. Your data is safe — try again.";

async function fetchDeviceList() {
  const get = () => fetch('/api/devices').catch(() => null);
  let res = await get();
  if (!res || res.status >= 500) {
    await new Promise((resolve) => setTimeout(resolve, LIST_RETRY_MS));
    res = await get();
  }
  if (!res || !res.ok) throw new Error(LIST_ERROR);
  return res;
}

async function loadDevices(mount, ctx, hooks) {
  const res = await fetchDeviceList();
  if (renderBlocked(mount)) return;
  const devices = await res.json();
  if (renderBlocked(mount)) return;

  // Verify-only K_mac leaf key from the warm ctx (unlock.js warmUnlock).
  const audited = await Promise.all(
    (devices || []).map(async (d) => {
      const credentialId = fromBase64Url(d.credential_id);
      let verified = false;
      if (d.envelope) {
        verified = await auditEnvelopeWithKey({
          kMac: ctx.kMac,
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

  if (renderBlocked(mount)) return;
  const known = await readKnownDevices();
  if (renderBlocked(mount)) return;
  const noticed = new Set(((known && known.notices) || [])
    .filter((n) => Date.now() - n.at < NOTICE_MS)
    .map((n) => n.credential_id));
  renderDevices(mount, ctx, hooks, audited, audited.filter((d) => noticed.has(d.credential_id)));
  if (typeof hooks.onLoaded === 'function') hooks.onLoaded(audited);
}

// Kit S4: one sun primary ("Add a device"); Revoke sits behind each row's
// overflow and confirms through a destructive dialog.
// AD11 revises it: section "Devices" with a count, platform rows with a
// "This device" tag and the synced-passkey hint, the copyable account address
// (Path 0 on another device asks for it), and any new-device notices.
function renderDevices(mount, ctx, hooks, devices, notices = []) {
  if (renderBlocked(mount)) return;
  mount.innerHTML = `
    <section class="wg-section">
      <div class="wg-section__head"><span class="wg-eyebrow">Devices</span><span class="wg-meta" id="device-count"></span></div>
      <div class="wg-list" id="device-notices"></div>
      <div class="wg-list" id="device-list"></div>
      <p class="wg-hint">&ldquo;This device&rdquo; is our best guess. A passkey that syncs through iCloud Keychain, Google Password Manager or another manager can work on several of your devices.</p>
      <button type="button" id="add-device-button" class="wg-btn wg-btn--primary wg-btn--block"><i class="wg-ico wg-ico--sm" data-icon="qr"></i>Add a device</button>
    </section>
    <div class="wg-list"><div class="wg-setting"><span class="wg-row__lead"><i class="wg-ico" data-icon="link"></i></span><span class="wg-setting__body"><span class="wg-setting__title">Account address</span><span class="wg-setting__desc wg-mono" id="account-address"></span></span><button type="button" id="copy-account-address" class="wg-btn wg-btn--ghost wg-btn--icon wg-btn--sm" aria-label="Copy address"><i class="wg-ico wg-ico--sm" data-icon="copy"></i></button></div></div>`;

  mount.querySelector('#device-count').textContent = String(devices.length);
  const noticeList = mount.querySelector('#device-notices');
  if (!notices.length) noticeList.remove();
  for (const d of notices) noticeList.appendChild(renderNoticeRow(mount, ctx, hooks, d));

  const list = mount.querySelector('#device-list');
  for (const d of devices) {
    list.appendChild(renderDeviceRow(mount, ctx, hooks, d));
  }

  mount.querySelector('#add-device-button').addEventListener('click', () => {
    if (typeof hooks.onAddDevice === 'function') hooks.onAddDevice();
  });

  const address = window.location.host;
  mount.querySelector('#account-address').textContent = address;
  mount.querySelector('#copy-account-address').addEventListener('click', () => {
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(address))
      .then(() => window.safeToast('Address copied', 'success'))
      .catch(() => window.safeToast('Could not copy — select the text instead.', 'error'));
  });
  hydrateIcons(mount);
}

// AD11 · notice kept in Devices: Revoke opens the same destructive dialog as
// the row's overflow — never a one-tap revoke.
function renderNoticeRow(mount, ctx, hooks, d) {
  const row = document.createElement('div');
  row.className = 'wg-row device-notice';
  const lead = document.createElement('span');
  lead.className = 'wg-row__lead';
  lead.innerHTML = '<i class="wg-ico" data-icon="device"></i>';
  const body = document.createElement('span');
  body.className = 'wg-row__body';
  const title = document.createElement('span');
  title.className = 'wg-row__title';
  title.textContent = noticeText(d);
  const meta = document.createElement('span');
  meta.className = 'wg-row__meta';
  meta.textContent = 'Not you? Revoke it now.';
  body.append(title, meta);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wg-btn wg-btn--sm wg-btn--danger-ghost';
  button.textContent = 'Revoke';
  button.addEventListener('click', () => confirmRevoke(mount, ctx, hooks, d));
  row.append(lead, body, button);
  return row;
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

  // Reuse the signup Emergency Kit page wholesale (bd med-ckm5.2). A second copy of this screen would drift, and the copy that
  // drifted would be the one that fails a friend who has lost their phone.
  const { renderEmergencyKit } = await import('./signup.js');
  await renderEmergencyKit(app, { accountId, dek, onKitSaved: onDone, continueLabel: 'Done' });
}

function renderDeviceRow(mount, ctx, hooks, d) {
  const row = document.createElement('div');
  row.className = 'wg-row device-row';

  const lead = document.createElement('span');
  lead.className = d.verified ? 'wg-row__lead wg-row__lead--ok' : 'wg-row__lead';
  lead.innerHTML = `<i class="wg-ico" data-icon="${d.platform === 'web' ? 'globe' : 'device'}"></i>`;

  // Server-controlled fields (credential id, timestamps) — textContent only,
  // never innerHTML (this page holds the DEK; XSS here reads it).
  const body = document.createElement('span');
  body.className = 'wg-row__body';
  const title = document.createElement('span');
  title.className = 'wg-row__title';
  title.textContent = deviceLabel(d);
  const meta = document.createElement('span');
  meta.className = 'wg-row__meta';
  meta.textContent = `added ${shortDate(d.created_at)}`;

  const chip = document.createElement('span');
  if (d.verified) {
    chip.className = 'wg-chip wg-chip--sm wg-chip--ok device-verified';
    chip.textContent = 'Verified';
  } else {
    chip.className = 'wg-chip wg-chip--sm wg-chip--danger device-unverified';
    chip.textContent = 'Unverified — remove?';
  }
  meta.appendChild(chip);
  body.append(title, meta);
  row.append(lead, body);
  if (d.current) {
    const tag = document.createElement('span');
    tag.className = 'wg-tag device-this';
    tag.textContent = 'This device';
    row.appendChild(tag);
  }

  const label = 'Revoke';
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
    'Use this to retire a device you still control. If it was lost or ' +
      'stolen, revoking here does not protect your data on its own — see the recovery guide ' +
      'about rotating your keys.',
    null,
    { title: 'Revoke this device?', confirmLabel: 'Revoke', destructive: true, icon: 'device' },
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
  if (renderBlocked(mount)) return;
  mount.innerHTML = `
    <section class="wg-section">
      <p class="wg-error"></p>
      <button type="button" id="devices-retry" class="wg-btn wg-btn--block">Try again</button>
    </section>`;
  mount.querySelector('.wg-error').textContent = errorText;
  mount.querySelector('#devices-retry').addEventListener('click', () => renderDeviceList(mount, ctx, hooks));
}
