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

const DB_NAME = 'medtracker-cloud';
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
      const dek = await unwrapWithLdk(cached);
      renderUnlocked(app, { accountId: cached.accountId, dek });
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

async function coldUnlock(app) {
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

  try {
    await establishLdkCache(dek, accountId);
  } catch {
    // Warm-cache is an optimization; a storage-blocked browser (private mode,
    // quota policy, partitioned iframe) must still reach the vault after a
    // successful cold unlock rather than bouncing back to a locked loop. This
    // mirrors the read-path tolerance in runUnlockFlow.
  }
  renderUnlocked(app, { accountId, dek });
}

function renderUnlocked(app, ctx) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Vault unlocked</h1>
      <p>Account <code id="account-id"></code></p>
      <p>Data sync arrives with the next update.</p>
      <button id="devices-button">Devices</button>
      <button id="lock-button">Lock</button>
    </section>`;
  // Server-controlled value — set via textContent, never innerHTML (E2EE
  // threat model treats the server as hostile; XSS here reads the DEK).
  app.querySelector('#account-id').textContent = ctx.accountId;
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

async function unwrapWithLdk(record) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: record.nonce, additionalData: LDK_AAD },
    record.ldk,
    record.ct
  );
  return new Uint8Array(pt);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readLdkRecord() {
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
