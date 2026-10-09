// "Add a device" flow (old, unlocked device): docs/cloud-crypto.md "Path B —
// QR hand-off". Generates a one-shot transfer key TK, hands the DEK to the
// server AES-GCM-wrapped under TK (the server never sees TK), and renders the
// QR/typed-fallback code the new device claims.
//
// Mounted into the app's "Add a device" page (med-xso6.25; features/settings.js
// openAddDevicePage). The module renders into the mount it is given and owns no
// page chrome: onExit leaves the flow, and the returned controller lets the
// host's Back go through the same server-side cancel as the Cancel button.
import { encryptTransferPayload, toBase64, toBase64Url, base32Encode } from './crypto.js';

const TRANSFER_TK_BYTES = 32;

// How often the originating device asks whether its slot was claimed. The
// ceremony is a human scanning a QR, so 2s is well inside "feels instant"
// while costing at most ~300 requests over the slot's whole 10-minute life.
const POLL_INTERVAL_MS = 2000;

// Returns { cancel(): Promise<boolean>, stop() }. cancel() resolves true once
// nothing claimable is left (the live slot was deleted server-side, or there
// never was one) and false when the DELETE failed — the host must then stay put,
// since leaving would imply a still-live code is dead. stop() only clears the
// timers (the host calls it after its page is gone, however it closed).
export function renderAddDevice(mount, ctx, onExit) {
  const flow = { slotId: null, live: false, closed: false, timer: null, poller: null };
  const stop = () => {
    clearInterval(flow.timer);
    clearInterval(flow.poller);
    flow.live = false;
  };

  function start() {
    stop();
    mount.innerHTML = '<p class="wg-hint">Generating a one-time transfer code&hellip;</p>';
    startTransfer().catch((err) => renderError(err.message || String(err)));
  }

  async function startTransfer() {
    const tk = crypto.getRandomValues(new Uint8Array(TRANSFER_TK_BYTES));
    const packed = await encryptTransferPayload(tk, ctx.dek, ctx.accountId);

    const res = await fetch('/api/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ct: toBase64(packed) }),
    });
    if (!res.ok) throw new Error('Could not start the device transfer.');
    const { slot_id: slotId, expires_at: expiresAt } = await res.json();
    if (flow.closed) {
      // The host left while the slot was being minted. Nobody saw TK, but
      // don't leave a live slot behind either.
      fetch(`/api/transfer/${encodeURIComponent(slotId)}`, { method: 'DELETE' }).catch(() => {});
      return;
    }
    flow.slotId = slotId;
    flow.live = true;

    const qrUrl = `${location.origin}/claim#${slotId}.${toBase64Url(tk)}`;
    const fallback = `${slotId}.${base32Encode(tk)}`;
    await renderTransferScreen({ qrUrl, fallback, expiresAt: new Date(expiresAt).getTime() });
  }

  async function renderTransferScreen({ qrUrl, fallback, expiresAt }) {
    const { qrcode } = await import('../vendor/qrcode.mjs');
    // Back during the import already deleted the slot; don't restart timers
    // on a detached mount.
    if (flow.closed) return;
    const qr = qrcode(0, 'M');
    qr.addData(qrUrl);
    qr.make();

    mount.innerHTML = `
      <section class="wg-section">
        <p>On your new device, open the camera app and scan this code — or type
           the fallback code if it can't scan (e.g. a desktop).</p>
        <div class="kit-qr wg-invite-modal__qr">${qr.createSvgTag(4)}</div>
        <div class="wg-field">
          <span class="wg-label">Fallback code</span>
          <div class="wg-code wg-code--wrap"><span id="transfer-fallback"></span></div>
        </div>
        <p class="wg-meta">Expires in <span id="transfer-countdown"></span></p>
        <p class="wg-error" id="transfer-error"></p>
        <button type="button" id="transfer-cancel" class="wg-btn wg-btn--block">Cancel</button>
      </section>`;
    // Server-controlled slot id rides in this code — set via textContent, never
    // innerHTML (this page holds the DEK; XSS here reads it).
    mount.querySelector('#transfer-fallback').textContent = fallback;

    const countdownEl = mount.querySelector('#transfer-countdown');
    const cancelButton = mount.querySelector('#transfer-cancel');

    flow.timer = setInterval(tick, 1000);
    function tick() {
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        stop();
        renderExpired();
        return;
      }
      const totalSeconds = Math.floor(remainingMs / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      countdownEl.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
    }
    tick();

    // Ask the server whether the other device finished. Without this the screen
    // counted down and offered Cancel long after enrollment had succeeded, and
    // the user could not tell whether it had worked (med-tuv).
    flow.poller = setInterval(() => { pollSlot(); }, POLL_INTERVAL_MS);
    async function pollSlot() {
      let res;
      try {
        res = await fetch(`/api/transfer/${encodeURIComponent(flow.slotId)}`);
      } catch {
        return; // transient: the countdown keeps running, the next tick retries
      }
      if (res.status === 404) {
        // Expired or swept server-side. The countdown will land on the same
        // conclusion; let it, rather than racing it.
        return;
      }
      if (!res.ok || !flow.live) return;
      const { status } = await res.json();
      if (status === 'claimed' && flow.live) {
        stop();
        renderTransferComplete();
      }
    }

    cancelButton.addEventListener('click', async () => {
      cancelButton.disabled = true;
      if (await cancel()) onExit();
      else cancelButton.disabled = false;
    });
  }

  // Cancel must mean cancelled. The old handler cleared a local timer and left
  // the slot live and claimable for the rest of its 10-minute window, so a user
  // who had shown the QR to the wrong person pressed Cancel and believed the
  // code was dead. It was not.
  async function cancel() {
    if (!flow.live) {
      flow.closed = true;
      stop();
      return true;
    }
    try {
      const res = await fetch(`/api/transfer/${encodeURIComponent(flow.slotId)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('cancel failed');
    } catch {
      // Never leave on failure: leaving would imply the code is dead.
      const errorEl = mount.querySelector('#transfer-error');
      if (errorEl) {
        errorEl.textContent =
          'Could not cancel the transfer code — it may still work. Check your connection and try again.';
      }
      return false;
    }
    flow.closed = true;
    stop();
    return true;
  }

  // Names the newly enrolled device so an unexpected one is visible immediately.
  // Best-effort: the enrollment already succeeded, so a failed lookup must not
  // present as a failed transfer.
  async function renderTransferComplete() {
    mount.innerHTML = `
      <section class="wg-section">
        <p class="wg-row__title">Device added</p>
        <p id="transfer-complete-detail">Your new device has been enrolled and can now open your vault.</p>
        <p class="wg-hint">If you did not expect this, revoke it from your device list now.</p>
        <button type="button" id="transfer-done" class="wg-btn wg-btn--primary wg-btn--block">Back to devices</button>
      </section>`;
    mount.querySelector('#transfer-done').addEventListener('click', onExit);

    try {
      const res = await fetch('/api/devices');
      if (!res.ok) return;
      const devices = await res.json();
      if (!Array.isArray(devices) || devices.length === 0) return;
      const newest = devices.reduce((a, b) => (new Date(a.created_at) > new Date(b.created_at) ? a : b));
      const detail = mount.querySelector('#transfer-complete-detail');
      // Server-controlled — textContent, never innerHTML (this page holds the DEK).
      if (detail) detail.textContent = `Passkey ${newest.credential_id.slice(0, 8)}… can now open your vault.`;
    } catch {
      // Leave the generic success copy.
    }
  }

  function renderExpired() {
    mount.innerHTML = `
      <section class="wg-section">
        <p class="wg-row__title">Transfer code expired</p>
        <p>That code is no longer valid. Generate a new one if you still want
           to add a device.</p>
        <button type="button" id="transfer-retry" class="wg-btn wg-btn--primary wg-btn--block">Generate new code</button>
      </section>`;
    mount.querySelector('#transfer-retry').addEventListener('click', start);
  }

  function renderError(errorText) {
    mount.innerHTML = `
      <section class="wg-section">
        <p class="wg-error"></p>
        <button type="button" id="transfer-retry" class="wg-btn wg-btn--primary wg-btn--block">Try again</button>
      </section>`;
    mount.querySelector('.wg-error').textContent = errorText;
    mount.querySelector('#transfer-retry').addEventListener('click', start);
  }

  start();
  return {
    cancel,
    // The host's page is gone. A close that bypassed cancel() (anything but
    // Back / Cancel) still must not leave a claimable slot behind: best-effort
    // delete it.
    stop() {
      if (flow.live) {
        fetch(`/api/transfer/${encodeURIComponent(flow.slotId)}`, { method: 'DELETE' }).catch(() => {});
      }
      flow.closed = true;
      stop();
    },
  };
}
