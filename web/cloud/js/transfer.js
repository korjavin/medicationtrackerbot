// "Add a device" flow (old, unlocked device): docs/cloud-crypto.md "Path B —
// QR hand-off". Generates a one-shot transfer key TK, hands the DEK to the
// server AES-GCM-wrapped under TK (the server never sees TK), and renders the
// QR/typed-fallback code the new device claims. onExit returns to whatever
// screen hosted the "Add a device" entry point.
import { encryptTransferPayload, toBase64, toBase64Url, base32Encode } from './crypto.js';

const TRANSFER_TK_BYTES = 32;

export function renderAddDevice(app, ctx, onExit) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Add a device</h1>
      <p>Generating a one-time transfer code&hellip;</p>
    </section>`;
  startTransfer(app, ctx, onExit).catch((err) => {
    renderAddDeviceError(app, ctx, onExit, err.message || String(err));
  });
}

async function startTransfer(app, ctx, onExit) {
  const tk = crypto.getRandomValues(new Uint8Array(TRANSFER_TK_BYTES));
  const packed = await encryptTransferPayload(tk, ctx.dek, ctx.accountId);

  const res = await fetch('/api/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ct: toBase64(packed) }),
  });
  if (!res.ok) throw new Error('Could not start the device transfer.');
  const { slot_id: slotId, expires_at: expiresAt } = await res.json();

  const qrUrl = `${location.origin}/claim#${slotId}.${toBase64Url(tk)}`;
  const fallback = `${slotId}.${base32Encode(tk)}`;
  await renderTransferScreen(app, ctx, onExit, { slotId, qrUrl, fallback, expiresAt: new Date(expiresAt).getTime() });
}

// How often the originating device asks whether its slot was claimed. The
// ceremony is a human scanning a QR, so 2s is well inside "feels instant"
// while costing at most ~300 requests over the slot's whole 10-minute life.
const POLL_INTERVAL_MS = 2000;

async function renderTransferScreen(app, ctx, onExit, { slotId, qrUrl, fallback, expiresAt }) {
  const { qrcode } = await import('../vendor/qrcode.mjs');
  const qr = qrcode(0, 'M');
  qr.addData(qrUrl);
  qr.make();

  app.innerHTML = `
    <section class="wizard-step kit">
      <h1>Add a device</h1>
      <p>On your new device, open the camera app and scan this code — or type
         the fallback code if it can't scan (e.g. a desktop).</p>
      <div class="kit-qr">${qr.createSvgTag(4)}</div>
      <dl>
        <dt>Fallback code</dt><dd class="recovery-code" id="transfer-fallback"></dd>
        <dt>Expires in</dt><dd id="transfer-countdown"></dd>
      </dl>
      <p class="wizard-error" id="transfer-error"></p>
      <button id="transfer-cancel">Cancel</button>
    </section>`;
  // Server-controlled slot id rides in this code — set via textContent, never
  // innerHTML (this page holds the DEK; XSS here reads it).
  app.querySelector('#transfer-fallback').textContent = fallback;

  const countdownEl = app.querySelector('#transfer-countdown');
  const cancelButton = app.querySelector('#transfer-cancel');

  let timer;
  let poller;
  const stop = () => { clearInterval(timer); clearInterval(poller); };

  timer = setInterval(tick, 1000);
  function tick() {
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      stop();
      renderExpired(app, ctx, onExit);
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
  poller = setInterval(() => { pollSlot(); }, POLL_INTERVAL_MS);
  async function pollSlot() {
    let res;
    try {
      res = await fetch(`/api/transfer/${encodeURIComponent(slotId)}`);
    } catch {
      return; // transient: the countdown keeps running, the next tick retries
    }
    if (res.status === 404) {
      // Expired or swept server-side. The countdown will land on the same
      // conclusion; let it, rather than racing it.
      return;
    }
    if (!res.ok) return;
    const { status } = await res.json();
    if (status === 'claimed') {
      stop();
      renderTransferComplete(app, ctx, onExit);
    }
  }

  cancelButton.addEventListener('click', () => {
    cancelButton.disabled = true;
    cancelTransfer(app, ctx, onExit, slotId, stop).catch(() => {
      // Never navigate away on failure: leaving would imply the code is dead.
      app.querySelector('#transfer-error').textContent =
        'Could not cancel the transfer code — it may still work. Check your connection and try again.';
      cancelButton.disabled = false;
    });
  });
}

// Cancel must mean cancelled. The old handler cleared a local timer and left
// the slot live and claimable for the rest of its 10-minute window, so a user
// who had shown the QR to the wrong person pressed Cancel and believed the
// code was dead. It was not.
async function cancelTransfer(app, ctx, onExit, slotId, stop) {
  const res = await fetch(`/api/transfer/${encodeURIComponent(slotId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('cancel failed');
  stop();
  onExit();
}

// Names the newly enrolled device so an unexpected one is visible immediately.
// Best-effort: the enrollment already succeeded, so a failed lookup must not
// present as a failed transfer.
async function renderTransferComplete(app, ctx, onExit) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Device added</h1>
      <p id="transfer-complete-detail">Your new device has been enrolled and can now open your vault.</p>
      <p>If you did not expect this, remove it from your device list now.</p>
      <button id="transfer-done">Back to devices</button>
    </section>`;
  app.querySelector('#transfer-done').addEventListener('click', onExit);

  try {
    const res = await fetch('/api/devices');
    if (!res.ok) return;
    const devices = await res.json();
    if (!Array.isArray(devices) || devices.length === 0) return;
    const newest = devices.reduce((a, b) => (new Date(a.created_at) > new Date(b.created_at) ? a : b));
    const detail = app.querySelector('#transfer-complete-detail');
    // Server-controlled — textContent, never innerHTML (this page holds the DEK).
    if (detail) detail.textContent = `Passkey ${newest.credential_id.slice(0, 8)}… can now open your vault.`;
  } catch {
    // Leave the generic success copy.
  }
}

function renderExpired(app, ctx, onExit) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Transfer code expired</h1>
      <p>That code is no longer valid. Generate a new one if you still want
         to add a device.</p>
      <button id="transfer-retry">Generate new code</button>
      <button id="transfer-back">Back</button>
    </section>`;
  app.querySelector('#transfer-retry').addEventListener('click', () => renderAddDevice(app, ctx, onExit));
  app.querySelector('#transfer-back').addEventListener('click', onExit);
}

function renderAddDeviceError(app, ctx, onExit, errorText) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Add a device</h1>
      <p class="wizard-error"></p>
      <button id="transfer-retry">Try again</button>
      <button id="transfer-back">Back</button>
    </section>`;
  app.querySelector('.wizard-error').textContent = errorText;
  app.querySelector('#transfer-retry').addEventListener('click', () => renderAddDevice(app, ctx, onExit));
  app.querySelector('#transfer-back').addEventListener('click', onExit);
}
