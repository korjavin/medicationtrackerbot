// Returning-device unlock flow: docs/cloud-crypto.md "Unlock" section. Warm
// unlock silently reads the cached leaf keys (non-extractable WebCrypto keys
// structured-cloned into IndexedDB); cold unlock re-derives the DEK from a
// fresh passkey assertion + PRF when the cache is absent or fails to open,
// then re-establishes the cache.
import {
  saltKek,
  deriveKEK,
  deriveDataKeys,
  deriveKMac,
  unwrapEnvelope,
  fromBase64,
  timingSafeEqual,
  toBase64Url,
} from './crypto.js';
import { openDb } from './localdb.js';
import { getAssertion } from './passkey-get.js';
import { diagHttp } from './passkey-diag.js';

const STORE_NAME = 'device';
// v2 lives in its own slot: a pre-v2 shell reads only LDK_LEGACY_KEY, so it
// sees "no cache" (renders locked, clears nothing) instead of a record it
// can't open (which it deletes). Promotion empties the legacy slot.
const LDK_RECORD_KEY = 'ldk2';
const LDK_LEGACY_KEY = 'ldk';
const LDK_STAGING_PREFIX = 'ldk-staging-';
const LDK_AAD = new TextEncoder().encode('mt/v1/ldk');

export async function runUnlockFlow() {
  const app = document.getElementById('app');
  let cached = null;
  try {
    cached = await readLiveLdk();
  } catch {
    // IndexedDB unavailable (storage disabled, private mode, quota policy) —
    // fall through to cold unlock rather than leaving a blank page.
    cached = null;
  }
  if (cached) {
    try {
      await openLdkRecord(cached); // v2 leaf keys, or a legacy record migrated
      // The real app (web/static, C1) reads the LDK cache itself via
      // cloud-boot.js — send the browser there instead of the toy menu below.
      location.href = unlockSuccessTarget(location.hash);
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
  // A friend on another subdomain/instance who taps the sender's link lands
  // here (cold unlock shell) with the plan/gym fragment intact. They still
  // get it via paste: point them at their own app's Import. Keep it
  // to this paragraph + Copy button — no new module (bd med-uo64.3).
  const carriesSharePlan = forwardableShareFragment(
    typeof location !== 'undefined' ? location.hash : '') !== '';
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Med Tracker</h1>
      <p>Unlock this device with your passkey to open your vault.</p>
      ${carriesSharePlan ? '<p>This link carries a shared workout plan or gym. To add it to your own account, open your app and use Workouts → Plans → Import plan (or Equipment → Import), then paste this link.</p><button id="share-plan-copy-button" class="wg-btn" type="button">Copy link</button>' : ''}
      <button id="unlock-button" class="wg-btn wg-btn--primary">Unlock with passkey</button>
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
  if (carriesSharePlan) {
    const copyBtn = app.querySelector('#share-plan-copy-button');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const url = String(typeof location !== 'undefined' ? location.href : '');
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(url);
          copyBtn.textContent = 'Copied';
        } else {
          copyBtn.textContent = 'Copy this link by hand';
        }
      } catch (_) {
        copyBtn.textContent = 'Copy this link by hand';
      }
    });
  }
}

// The passkey login ceremony: assert a credential and let /login/finish re-mint
// the session cookie. With a salt (cold unlock) the PRF eval rides along and
// its output comes back for the KEK; without one (session renewal) nothing
// key-related is requested, so renewal works where PRF is unavailable.
async function loginCeremony(salt) {
  const beginRes = diagHttp('login/begin', await fetch('/api/webauthn/login/begin', { method: 'POST' }));
  if (!beginRes.ok) throw new Error('Could not start unlock — no passkey is registered yet.');
  const { publicKey } = await beginRes.json();
  const requestOptions = PublicKeyCredential.parseRequestOptionsFromJSON(publicKey);

  const options = { ...requestOptions, userVerification: 'required' };
  if (salt) options.extensions = { prf: { eval: { first: salt } } };
  const assertion = await getAssertion(options);

  const prfOutput = assertion.getClientExtensionResults().prf?.results?.first;
  if (salt && !prfOutput) throw new Error("This passkey doesn't support the security feature this app needs.");

  const finishBody = assertion.toJSON();
  // Never transmit the PRF output — it lives client-side only.
  if (finishBody.clientExtensionResults) delete finishBody.clientExtensionResults.prf;

  const finishRes = diagHttp('login/finish', await fetch('/api/webauthn/login/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(finishBody),
  }));
  if (!finishRes.ok) throw new Error('Unlock failed. Please try again.');
  const { account_id: accountId } = await finishRes.json();
  return { accountId, credentialId: new Uint8Array(assertion.rawId), prfOutput };
}

// Session renewal only (sync.js reauthenticate): a fresh assertion re-mints the
// 30-day session cookie. No PRF, no envelope, no raw DEK — the warm ctx already
// holds what the operational path needs.
export async function renewSession() {
  const { accountId } = await loginCeremony(null);
  return { accountId };
}

// The cold-unlock ceremony proper: assert a passkey, evaluate PRF, and unwrap
// that credential's envelope into the DEK. Exported because it is also the
// fresh-assertion gate for the raw-DEK ceremonies on a warm device —
// devices.js before rotating the recovery code (med-d5t.12) and transfer.js
// before handing the DEK to a new device (med-5h1t.3) — so an unlocked tab
// left open on a shared laptop can do neither. Its success proves the user is
// physically present, and hands back the DEK that ceremony needs.
export async function assertPasskey() {
  // Top-level prf.eval = salt_kek per docs/cloud-crypto.md "cold unlock" — the
  // salt applies to whichever allowed credential the authenticator picks.
  const { accountId, credentialId, prfOutput } = await loginCeremony(await saltKek());
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
    // still holds this cold-unlock's leaf keys. ponytail: revisit once the real
    // app has a no-cache boot path to hand the in-memory keys to directly.
    renderUnlocked(app, { accountId, ...(await deriveDataKeys(dek)) });
    return;
  }
  // The real app (web/static, C1) reads the LDK cache itself via
  // cloud-boot.js — send the browser there instead of the toy menu below.
  location.href = unlockSuccessTarget(location.hash);
}

function renderUnlocked(app, ctx) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Vault unlocked</h1>
      <p>Account <code id="account-id"></code></p>
      <p id="sync-status" class="sync-status">Syncing&hellip;</p>
      <button id="reminders-button" class="wg-btn">Reminders</button>
      <button id="devices-button" class="wg-btn">Devices</button>
      <button id="connectors-button" class="wg-btn">Connectors</button>
      <button id="lock-button" class="wg-btn">Lock</button>
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
          btn.className = 'wg-btn wg-btn--primary';
          btn.textContent = 'Re-authenticate';
          btn.addEventListener('click', () => {
            btn.disabled = true;
            reauthenticate(ctx)
              .then((status) => describeSyncStatus(ctx).then((t) => {
                el.textContent = t;
                // The post-ceremony drain can 401 again (cookie dropped by an
                // intermediary, credential revoked mid-flight) — keep the
                // button so the user can retry, same guard as cloud-boot.js.
                if (status.authExpired) { btn.disabled = false; return; }
                btn.remove();
                app.querySelector('section .wizard-error')?.remove();
              }))
              .catch((err) => {
                btn.disabled = false;
                // Reuse a single error node — repeated retries must not stack
                // a paragraph per failure.
                app.querySelector('section .wizard-error')?.remove();
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
  // This menu is the storage-blocked fallback: the app cannot boot without the
  // LDK cache, so device and connector management must stay reachable here.
  // Same modules the app's Settings page mounts (med-xso6.25), in a bare
  // shell frame with its own Back.
  app.querySelector('#devices-button').addEventListener('click', () => {
    import('./devices.js')
      .then(({ renderDeviceList, renderRegenerateKit }) => {
        const backToMenu = () => renderUnlocked(app, ctx);
        const showDevices = () => renderShellFrame(app, 'Devices', (mount) => {
          renderDeviceList(mount, ctx, {
            onAddDevice: () => import('./transfer.js').then(({ renderAddDevice }) => {
              // Back goes through the flow's server-side cancel, like the
              // in-app page's Back: a live code must never look dead.
              renderShellFrame(app, 'Add a device', (m) => renderAddDevice(m, ctx, showDevices),
                async (flow) => { if (await flow.cancel()) showDevices(); });
            }),
          });
          const kit = document.createElement('button');
          kit.className = 'wg-btn';
          kit.textContent = 'Regenerate Emergency Kit';
          kit.addEventListener('click', () => renderRegenerateKit(app, ctx, showDevices));
          mount.after(kit);
        }, backToMenu);
        showDevices();
      })
      .catch(() => {
        const p = document.createElement('p');
        p.className = 'wizard-error';
        p.textContent = 'Could not open the devices screen. Try again.';
        app.querySelector('section').appendChild(p);
      });
  });
  app.querySelector('#connectors-button').addEventListener('click', () => {
    import('./connectors.js')
      .then(({ renderConnectors }) => renderShellFrame(app, 'Connectors', (mount) => renderConnectors(mount, ctx),
        () => renderUnlocked(app, ctx)))
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

// A titled shell section around a module that renders into a mount (the
// modules own no chrome). onBack receives whatever mountFn returned.
function renderShellFrame(app, title, mountFn, onBack) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1></h1>
      <div id="shell-frame-mount"></div>
      <button id="shell-frame-back" class="wg-btn">Back</button>
    </section>`;
  app.querySelector('h1').textContent = title;
  const handle = mountFn(app.querySelector('#shell-frame-mount'));
  app.querySelector('#shell-frame-back').addEventListener('click', () => onBack(handle));
}

// --- LDK cache (docs/cloud-crypto.md "LDK"): the warm-unlock record holds the
// operational leaf keys K_data / K_mac as non-extractable CryptoKeys,
// structured-cloned into IndexedDB directly, so a warm launch reopens the
// vault without a biometric and without any DEK bytes on disk or in memory.
//
// v2 = { v: 2, accountId, kData, kMac } under LDK_RECORD_KEY. v1 =
// { ldk, nonce, ct, accountId } (an AES-GCM-wrapped DEK, no `v`) under
// LDK_LEGACY_KEY is what older shells wrote; warm unlock migrates it once and
// empties the legacy slot. A rolled-back /unlock shell therefore finds no
// cache and wipes nothing; if its cold unlock writes v1 again, that is the
// fresher ceremony and the next warm launch re-migrates it.

// Seeds the cache from a ceremony DEK (signup, cold unlock, device transfer).
// The write is probed before it counts; one that fails the probe never
// reaches the live slot.
export async function establishLdkCache(dek, accountId) {
  await persistLeafKeys(dek, accountId);
}

// Stage → probe → promote: the v2 record is written under a per-call staging
// key (concurrent tabs never share one), read back through a fresh IDB handle
// and probed, then moved into the live slot in one transaction that also
// empties the legacy slot. Neither slot (a legacy v1 mid-migration, another
// tab's fresh cache) is touched unless that final transaction commits.
async function persistLeafKeys(dek, accountId) {
  const { kData, kMac } = await deriveDataKeys(dek);
  const record = { v: 2, accountId, kData, kMac };
  const staging = LDK_STAGING_PREFIX + crypto.randomUUID();
  try {
    await deviceTx('readwrite', (store) => store.put(record, staging));
    await verifyLdkDurable(dek, accountId, staging);
    await deviceTx('readwrite', (store) => {
      store.put(record, LDK_RECORD_KEY);
      store.delete(LDK_LEGACY_KEY);
      store.delete(staging);
    });
  } catch (e) {
    // ponytail: a tab killed mid-call orphans its staging row (leaf keys only,
    // never read by warmUnlock); sweep by prefix if that ever matters.
    await deviceTx('readwrite', (store) => { store.delete(staging); }).catch(() => {});
    throw e;
  }
  return { kData, kMac };
}

// Proves the stored record holds THIS ceremony's leaf keys, read back from
// IndexedDB (write → close → reopen → use). Never a self-roundtrip, which
// passes for any key: the challenge is sealed with a K_data derived afresh
// from the ceremony DEK and opened with the stored one; the MAC is minted
// from the ceremony DEK's raw K_mac and verified with the stored one.
// Exported for the unlock test.
export async function verifyLdkDurable(dek, accountId, key = LDK_RECORD_KEY) {
  const rec = await readLdkRecord(key);
  if (!rec || rec.v !== 2 || rec.accountId !== accountId) {
    throw new Error('This browser could not save its local key.');
  }
  const sameUsages = (k, want) => [...k.usages].sort().join() === want;
  if (rec.kData?.extractable !== false || !sameUsages(rec.kData, 'decrypt,encrypt')
    || rec.kMac?.extractable !== false || !sameUsages(rec.kMac, 'verify')) {
    throw new Error('Local key has the wrong shape.');
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const { kData } = await deriveDataKeys(dek);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kData, challenge);
  const opened = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, rec.kData, sealed));
  const signKey = await crypto.subtle.importKey(
    'raw', await deriveKMac(dek), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const tag = await crypto.subtle.sign('HMAC', signKey, challenge);
  if (!timingSafeEqual(opened, challenge) || !(await crypto.subtle.verify('HMAC', rec.kMac, tag, challenge))) {
    throw new Error('Local key verification failed — this browser’s storage may be unreliable.');
  }
}

// v1 only: the wrapped DEK an older shell left behind.
async function unwrapWithLdk(record) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: record.nonce, additionalData: LDK_AAD },
    record.ldk,
    record.ct
  );
  return new Uint8Array(pt);
}

// Record → operational ctx { accountId, kData, kMac }. Throws on a record it
// can't open (callers clear it / go cold).
async function openLdkRecord({ record, legacy }) {
  if (record.v === 2) {
    if (typeof record.accountId !== 'string' || record.kData?.algorithm?.name !== 'AES-GCM'
      || record.kMac?.algorithm?.name !== 'HMAC') {
      throw new Error('Corrupt local key record.');
    }
    // A v2 in the legacy slot (written by a shell from before the slot split)
    // was probed when written: just move it. A failed move retries next launch.
    if (legacy) {
      await deviceTx('readwrite', (store) => {
        store.put(record, LDK_RECORD_KEY);
        store.delete(LDK_LEGACY_KEY);
      }).catch(() => {});
    }
    return { accountId: record.accountId, kData: record.kData, kMac: record.kMac };
  }
  // v1 (legacy slot): unwrap once, derive the leaf keys, promote to v2. A
  // failed promotion keeps v1 (persistLeafKeys touches neither slot until it
  // commits) and this launch runs on the in-memory keys; the next one retries.
  const dek = await unwrapWithLdk(record);
  try {
    try {
      return { accountId: record.accountId, ...(await persistLeafKeys(dek, record.accountId)) };
    } catch {
      return { accountId: record.accountId, ...(await deriveDataKeys(dek)) };
    }
  } finally {
    dek.fill(0);
  }
}

// Warm-unlock in one step: read the cache into the ctx shape every caller
// needs ({ accountId, kData, kMac }). Returns null when there's no cache
// (fresh/cleared device) so callers can redirect to /unlock; throws are left
// to the caller's catch. Shared by cloud-boot.js (real-app shim) and app.js's
// /devices branch so the ctx shape lives in exactly one place.
export async function warmUnlock() {
  const cached = await readLiveLdk();
  if (!cached) return null;
  return openLdkRecord(cached);
}

// The record warm unlock opens. A legacy-slot record wins: every promotion
// empties that slot, so anything there was written after the v2 (an older
// shell's cold unlock) and is the fresher ceremony.
async function readLiveLdk() {
  const legacy = await readLdkRecord(LDK_LEGACY_KEY);
  if (legacy) return { record: legacy, legacy: true };
  const record = await readLdkRecord();
  return record ? { record, legacy: false } : null;
}

// Exported for the unlock test (inspects what the cache actually holds).
export async function readLdkRecord(key = LDK_RECORD_KEY) {
  return (await deviceTx('readonly', (store) => store.get(key))) || null;
}

// One transaction on the 'device' store over a fresh handle (closed after),
// resolving with the last request's result once the transaction commits.
async function deviceTx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const req = fn(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function clearLdkRecord() {
  await deviceTx('readwrite', (store) => {
    store.delete(LDK_RECORD_KEY);
    store.delete(LDK_LEGACY_KEY);
  });
}

// Shared-plan/gym fragment forwarding (med-uo64.3, med-8j5w.3): only a
// #share-plan= / #share-gym= fragment rides between / and /unlock. Anything else — notably #claim=,
// which cloud-boot.js routes the other way — must not forward, or the two
// shells ping-pong the browser forever. Placed at file end (not beside its
// callers) so the privacy-manifest file:line citations above don't shift.
// Exported for the unlock test.
export function forwardableShareFragment(hash) {
  const h = String(hash === null || hash === undefined ? '' : hash);
  return /^#share-(?:plan|gym)=/.test(h) ? h : '';
}

// The /unlock → / return leg both success paths share (warm LDK unwrap and
// cold passkey ceremony). One function so the fragment logic is unit-covered
// once instead of once per call site.
export function unlockSuccessTarget(hash) {
  return '/' + forwardableShareFragment(hash);
}
