// Returning-device unlock flow: docs/cloud-crypto.md "Unlock" section. Warm
// unlock silently unwraps the cached DEK from the local LDK (a non-extractable
// WebCrypto key structured-cloned into IndexedDB); cold unlock re-derives the
// DEK from a fresh passkey assertion + PRF when the cache is absent or fails
// to open, then re-establishes the cache.
import {
  saltKek,
  deriveKEK,
  unwrapEnvelope,
  fromBase64,
  toBase64Url,
} from './crypto.js';
import { openDb } from './localdb.js';

const STORE_NAME = 'device';
const LDK_RECORD_KEY = 'ldk';
const LDK_AAD = new TextEncoder().encode('mt/v1/ldk');

export async function runUnlockFlow() {
  const app = document.getElementById('app');
  let cached = null;
  try {
    cached = await readLdkRecord();
  } catch {
    // IndexedDB unavailable (storage disabled, private mode, quota policy) —
    // fall through to cold unlock rather than leaving a blank page.
    cached = null;
  }
  if (cached) {
    try {
      await unwrapWithLdk(cached);
      // The real app (web/static, C1) reads the LDK cache itself via
      // cloud-boot.js — send the browser there instead of the toy menu below.
      location.href = '/';
      return;
    } catch {
      // Cache unreadable/corrupted (e.g. IndexedDB cleared mid-write) — fall
      // through to cold unlock rather than getting stuck.
      await clearLdkRecord();
    }
  }
  renderLocked(app);
}

function renderLocked(app, errorText) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Med Tracker</h1>
      <p>Unlock this device with your passkey to open your vault.</p>
      <button id="unlock-button">Unlock with passkey</button>
      <p><a href="/recover">Recover with your Emergency Kit</a></p>
    </section>`;
  // Error text may carry a browser exception message; render via textContent,
  // never interpolated into innerHTML (this page holds the DEK — XSS here reads it).
  if (errorText) {
    const p = document.createElement('p');
    p.className = 'wizard-error';
    p.textContent = errorText;
    app.querySelector('section').appendChild(p);
  }
  app.querySelector('#unlock-button').addEventListener('click', () => {
    coldUnlock(app).catch((err) => renderLocked(app, err.message || String(err)));
  });
}

// The cold-unlock ceremony proper: assert a passkey, evaluate PRF, and unwrap
// that credential's envelope into the DEK. Exported because it is also the
// *reauthentication* primitive — devices.js requires a fresh assertion before
// rotating the recovery code, so an unlocked tab left open on a shared laptop
// cannot invalidate someone's Emergency Kit (med-d5t.12). Its success proves
// the user is physically present, and hands back the DEK the rotation re-wraps.
export async function assertPasskey() {
  const beginRes = await fetch('/api/webauthn/login/begin', { method: 'POST' });
  if (!beginRes.ok) throw new Error('Could not start unlock — no passkey is registered yet.');
  const { publicKey } = await beginRes.json();
  const requestOptions = PublicKeyCredential.parseRequestOptionsFromJSON(publicKey);

  // Top-level prf.eval = salt_kek per docs/cloud-crypto.md "cold unlock" — the
  // salt applies to whichever allowed credential the authenticator picks.
  const salt = await saltKek();
  const assertion = await navigator.credentials.get({
    publicKey: { ...requestOptions, userVerification: 'required', extensions: { prf: { eval: { first: salt } } } },
  });

  const prfOutput = assertion.getClientExtensionResults().prf?.results?.first;
  if (!prfOutput) throw new Error("This passkey doesn't support the security feature this app needs.");

  const finishBody = assertion.toJSON();
  // Never transmit the PRF output — it lives client-side only.
  if (finishBody.clientExtensionResults) delete finishBody.clientExtensionResults.prf;

  const finishRes = await fetch('/api/webauthn/login/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(finishBody),
  });
  if (!finishRes.ok) throw new Error('Unlock failed. Please try again.');
  const { account_id: accountId } = await finishRes.json();

  const credentialId = new Uint8Array(assertion.rawId);
  const kek = await deriveKEK(new Uint8Array(prfOutput), accountId, credentialId);

  const envRes = await fetch(`/api/envelopes/${toBase64Url(credentialId)}`);
  if (!envRes.ok) throw new Error('Could not download the encrypted envelope.');
  const envJson = await envRes.json();
  const envelope = { nonce: fromBase64(envJson.nonce), ct: fromBase64(envJson.ct) };
  const dek = await unwrapEnvelope({ kek, envelope, accountId, credentialId });
  return { accountId, dek, credentialId };
}

async function coldUnlock(app) {
  const { accountId, dek } = await assertPasskey();

  try {
    await establishLdkCache(dek, accountId);
  } catch {
    // Warm-cache is an optimization, but a navigation to '/' hands off to
    // cloud-boot.js, which re-derives the DEK by re-reading that very cache —
    // if the write just failed (storage-blocked private mode, quota policy,
    // partitioned iframe), redirecting would bounce straight back to
    // /unlock in a loop. Fall back to the toy in-memory menu instead, which
    // still holds this cold-unlock's dek. ponytail: revisit once the real
    // app has a no-cache boot path to hand the in-memory dek to directly.
    renderUnlocked(app, { accountId, dek });
    return;
  }
  // The real app (web/static, C1) reads the LDK cache itself via
  // cloud-boot.js — send the browser there instead of the toy menu below.
  location.href = '/';
}

function renderUnlocked(app, ctx) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Vault unlocked</h1>
      <p>Account <code id="account-id"></code></p>
      <p id="sync-status" class="sync-status">Syncing&hellip;</p>
      <button id="reminders-button">Reminders</button>
      <button id="devices-button">Devices</button>
      <button id="connectors-button">Connectors</button>
      <button id="lock-button">Lock</button>
    </section>`;
  // Server-controlled value — set via textContent, never innerHTML (E2EE
  // threat model treats the server as hostile; XSS here reads the DEK).
  app.querySelector('#account-id').textContent = ctx.accountId;
  import('./sync.js')
    .then(({ pullOnOpen, describeSyncStatus, getSyncStatus, reauthenticate }) =>
      pullOnOpen(ctx)
        .catch(() => {})
        .then(() => Promise.all([describeSyncStatus(ctx), getSyncStatus(ctx)]))
        .then(([text, status]) => {
          const el = app.querySelector('#sync-status');
          if (!el) return;
          el.textContent = text;
          if (!status.authExpired || app.querySelector('#reauth-button')) return;
          const btn = document.createElement('button');
          btn.id = 'reauth-button';
          btn.textContent = 'Re-authenticate';
          btn.addEventListener('click', () => {
            btn.disabled = true;
            reauthenticate(ctx)
              .then(() => describeSyncStatus(ctx))
              .then((t) => {
                el.textContent = t;
                btn.remove();
              })
              .catch((err) => {
                btn.disabled = false;
                const p = document.createElement('p');
                p.className = 'wizard-error';
                p.textContent = `Re-authentication failed — try again. (${err.message || String(err)})`;
                app.querySelector('section').appendChild(p);
              });
          });
          el.after(btn);
        })
    )
    .catch(() => {});
  app.querySelector('#reminders-button').addEventListener('click', () => {
    import('./push.js')
      .then(({ renderPush }) => renderPush(app, ctx, () => renderUnlocked(app, ctx)))
      .catch(() => {
        const p = document.createElement('p');
        p.className = 'wizard-error';
        p.textContent = 'Could not open the reminders screen. Try again.';
        app.querySelector('section').appendChild(p);
      });
  });
  app.querySelector('#devices-button').addEventListener('click', () => {
    import('./devices.js')
      .then(({ renderDeviceList }) => renderDeviceList(app, ctx, () => renderUnlocked(app, ctx)))
      .catch(() => {
        const p = document.createElement('p');
        p.className = 'wizard-error';
        p.textContent = 'Could not open the devices screen. Try again.';
        app.querySelector('section').appendChild(p);
      });
  });
  // The connector picker used to live on the devices screen; med-lyv split it
  // onto its own page, so the unlocked shell needs its own way in — otherwise
  // shell users lose access to it entirely.
  app.querySelector('#connectors-button').addEventListener('click', () => {
    import('./connectors.js')
      .then(({ renderConnectors }) => renderConnectors(app, ctx, () => renderUnlocked(app, ctx)))
      .catch(() => {
        const p = document.createElement('p');
        p.className = 'wizard-error';
        p.textContent = 'Could not open the connectors screen. Try again.';
        app.querySelector('section').appendChild(p);
      });
  });
  app.querySelector('#lock-button').addEventListener('click', () => {
    // Only transition to locked once the cached DEK is confirmed gone; if the
    // delete rejects, stay on the unlocked screen with a visible error rather
    // than claiming a lock that didn't happen.
    clearLdkRecord()
      .then(() => renderLocked(app))
      .catch((err) => {
        const p = document.createElement('p');
        p.className = 'wizard-error';
        p.textContent = `Could not lock — try again. (${err.message || String(err)})`;
        app.querySelector('section').appendChild(p);
      });
  });
}

// --- LDK cache (docs/cloud-crypto.md "LDK"): a non-extractable AES-GCM key
// wraps the DEK locally so a warm launch unwraps silently instead of
// demanding a biometric every time. Non-extractable keys structured-clone
// into IndexedDB directly — no export/import round-trip needed.

// Exported so claim.js (device-transfer enrollment) seeds the same warm-unlock
// cache on the new device after its own registration ceremony finishes.
export async function establishLdkCache(dek, accountId) {
  const ldk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: LDK_AAD }, ldk, dek)
  );
  await writeLdkRecord({ ldk, nonce, ct, accountId });
}

export async function unwrapWithLdk(record) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: record.nonce, additionalData: LDK_AAD },
    record.ldk,
    record.ct
  );
  return new Uint8Array(pt);
}

// Warm-unlock in one step: read the LDK cache and unwrap the DEK into the ctx
// shape every caller needs ({ accountId, dek }). Returns null when there's no
// cache (fresh/cleared device) so callers can redirect to /unlock; throws are
// left to the caller's catch. Shared by cloud-boot.js (real-app shim) and
// app.js's /devices branch so the ctx shape lives in exactly one place.
export async function warmUnlock() {
  const cached = await readLdkRecord();
  if (!cached) return null;
  const dek = await unwrapWithLdk(cached);
  return { accountId: cached.accountId, dek };
}

// Exported so cloud-boot.js (web/static's cloud boot shim) can perform the
// same warm-unlock read/unwrap without duplicating the LDK cache format.
export async function readLdkRecord() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(LDK_RECORD_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function writeLdkRecord(record) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record, LDK_RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function clearLdkRecord() {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(LDK_RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
