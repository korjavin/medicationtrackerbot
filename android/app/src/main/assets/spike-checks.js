// Spike (bd med-nt9p.4) diagnostic, evaluated by MainActivity on the page
// currently loaded. wgSpikeRun(op, id, args) runs one op and leaves its JSON
// text in window.__wgSpikeDone = { id, text }, which the native side polls —
// so results come back even when the wgSpike bridge (check 6) is broken.
// Throwaway: the shell bead (med-nt9p.5) deletes it. Never reports PRF bytes.
window.wgSpikeRun = (op, id, args) => {
  const done = (out) => { window.__wgSpikeDone = { id, text: JSON.stringify(out, null, 1) }; };
  const err = (e) => ({ error: String(e && e.name) + ': ' + String(e && e.message) });
  const prfSalt = () => ({ prf: { eval: { first: new Uint8Array(32).fill(7) } } });
  // The origin the authenticator signed: https://<host>, or android:apk-key-hash:…
  // in FOR_APP mode — which the server's WebAuthn config must then accept.
  const clientOrigin = (cred) => {
    try { return JSON.parse(new TextDecoder().decode(cred.response.clientDataJSON)).origin; } catch (e) { return 'unreadable: ' + e; }
  };
  const prfBytes = (cred) => {
    const prf = cred.getClientExtensionResults().prf || null;
    return { prfEnabled: prf ? (prf.enabled === undefined ? null : prf.enabled) : null,
             prfFirstBytes: prf && prf.results && prf.results.first ? prf.results.first.byteLength : 0,
             clientDataOrigin: clientOrigin(cred) };
  };

  // WebAuthn and the file chooser want a user gesture, which an injected
  // script lacks: put a button on the page and run the op from its tap.
  const tapThen = (label, fn) => new Promise((res, rej) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.setAttribute('style', 'position:fixed;left:16px;right:16px;bottom:96px;z-index:2147483647;padding:16px;font-size:18px');
    btn.onclick = () => { btn.remove(); try { Promise.resolve(fn()).then(res, rej); } catch (e) { rej(e); } };
    document.body.appendChild(btn);
  });

  const ping = () => new Promise((res, rej) => {
    const b = window.wgSpike;
    if (!b) { rej(new Error('no window.wgSpike (origin not matched by the listener rules?)')); return; }
    const t0 = performance.now();
    const timer = setTimeout(() => rej(new Error('no reply in 5 s')), 5000);
    b.onmessage = (e) => { clearTimeout(timer); res({ reply: JSON.parse(e.data), rttMs: Math.round(performance.now() - t0) }); };
    b.postMessage(JSON.stringify({ op: 'ping' }));
  });

  const idb = async () => {
    // Own database: never touches the app's Dexie data.
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('wg-android-spike', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = (mode, fn) => new Promise((res, rej) => {
      const x = db.transaction('kv', mode);
      const req = fn(x.objectStore('kv'));
      x.oncomplete = () => res(req.result);
      x.onerror = () => rej(x.error);
    });
    const previous = (await tx('readonly', (s) => s.get('marker'))) || null;
    let key = await tx('readonly', (s) => s.get('key'));
    const keyFromEarlierRun = !!key;
    if (!key) {
      // Same shape as the warm-unlock cache: a non-extractable CryptoKey structured-cloned into IDB.
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await tx('readwrite', (s) => s.put(key, 'key'));
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('spike'));
    const back = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
    await tx('readwrite', (s) => s.put({ launchId: args.launchId, versionCode: args.versionCode, at: new Date().toISOString() }, 'marker'));
    db.close();
    return { previousMarker: previous, markerFromEarlierLaunch: !!previous && previous.launchId !== args.launchId,
             markerFromOlderVersion: !!previous && previous.versionCode !== args.versionCode,
             keyFromEarlierRun, keyExtractable: key.extractable, keyUsable: back === 'spike' };
  };

  const ops = {
    async checks() {
      const out = {};
      const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = err(e); } };
      await t('context', async () => ({ origin: location.origin, secureContext: isSecureContext, online: navigator.onLine,
        ua: navigator.userAgent, publicKeyCredential: typeof PublicKeyCredential,
        uvpa: window.PublicKeyCredential ? await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() : null }));
      await t('bridge', ping);
      await t('serviceWorker', async () => {
        if (!('serviceWorker' in navigator)) return { supported: false };
        const regs = await navigator.serviceWorker.getRegistrations();
        return { supported: true, controlled: !!navigator.serviceWorker.controller,
                 registrations: regs.map((r) => ({ scope: r.scope, active: r.active ? r.active.state : null })),
                 cacheNames: self.caches ? (await caches.keys()).length : null };
      });
      await t('storage', async () => ({
        persisted: navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null,
        estimateMB: navigator.storage && navigator.storage.estimate
          ? Math.round(((await navigator.storage.estimate()).usage || 0) / 1e6) : null,
        databases: indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : null }));
      await t('idb', idb);
      await t('camera', async () => {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const videoTracks = s.getVideoTracks().length;
        s.getTracks().forEach((x) => x.stop());
        return { videoTracks, barcodeDetector: 'BarcodeDetector' in window };
      });
      return out;
    },

    create: () => tapThen('Spike: tap to create a passkey', async () => {
      const cred = await navigator.credentials.create({ publicKey: {
        rp: { id: location.hostname, name: 'Android spike' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'android-spike', displayName: 'Android spike - delete me' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: prfSalt() } });
      window.__wgSpikeCredId = cred.rawId;
      return Object.assign({ ok: true, attachment: cred.authenticatorAttachment }, prfBytes(cred));
    }),

    // After a create in this page: asks for that credential; else a discoverable get.
    get: () => tapThen('Spike: tap to get a passkey', async () => {
      const id = window.__wgSpikeCredId;
      const a = await navigator.credentials.get({ publicKey: {
        rpId: location.hostname, challenge: crypto.getRandomValues(new Uint8Array(32)),
        userVerification: 'required', allowCredentials: id ? [{ type: 'public-key', id }] : [],
        extensions: prfSalt() } });
      return Object.assign({ ok: true, usedCreatedCredential: !!id }, prfBytes(a));
    }),

    file: () => tapThen('Spike: tap to open the file chooser', () => new Promise((res) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => res({ ok: true, files: input.files.length, types: Array.from(input.files).map((f) => f.type) });
      input.oncancel = () => res({ ok: true, files: 0, cancelled: true });
      input.click();
    })),
  };

  window.__wgSpikeDone = null;
  Promise.resolve().then(() => ops[op]()).then(done, (e) => done(Object.assign({ ok: false }, err(e))));
};
