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
  await renderTransferScreen(app, ctx, onExit, { qrUrl, fallback, expiresAt: new Date(expiresAt).getTime() });
}

async function renderTransferScreen(app, ctx, onExit, { qrUrl, fallback, expiresAt }) {
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
      <button id="transfer-cancel">Cancel</button>
    </section>`;
  // Server-controlled slot id rides in this code — set via textContent, never
  // innerHTML (this page holds the DEK; XSS here reads it).
  app.querySelector('#transfer-fallback').textContent = fallback;

  const countdownEl = app.querySelector('#transfer-countdown');
  const timer = setInterval(tick, 1000);
  function tick() {
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      clearInterval(timer);
      renderExpired(app, ctx, onExit);
      return;
    }
    const totalSeconds = Math.floor(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    countdownEl.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
  tick();

  app.querySelector('#transfer-cancel').addEventListener('click', () => {
    clearInterval(timer);
    onExit();
  });
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
