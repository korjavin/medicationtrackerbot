// Spike (bd med-nt9p.4), injected at document start on the account origins
// only. Passive wrapper around the app's own WebAuthn calls: passes every call
// through unchanged and reports (via the wgSpike bridge) whether PRF results
// came back — never the bytes.
(() => {
  const c = navigator.credentials;
  const b = window.wgSpike;
  if (!c || !b) return;
  const clientOrigin = (cred) => {
    try { return JSON.parse(new TextDecoder().decode(cred.response.clientDataJSON)).origin; } catch (_) { return null; }
  };
  const post = (m) => { try { b.postMessage(JSON.stringify(Object.assign({ op: 'log' }, m))); } catch (_) {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const RETRY_MS = [1000, 3000, 8000, 20000, 45000];
  for (const op of ['create', 'get']) {
    const orig = c[op].bind(c);
    c[op] = async (opts) => {
      const pk = opts && opts.publicKey;
      const ev = { event: 'webauthn.' + op, host: location.host, publicKey: !!pk,
                   wantsPrf: !!(pk && pk.extensions && pk.extensions.prf) };
      if (op === 'get') ev.allowCredentials = pk && pk.allowCredentials ? pk.allowCredentials.length : 0;
      try {
        let cred;
        try {
          cred = await orig(opts);
        } catch (e) {
          // med-nt9p.18: retry NotReadableError get with logged delays; last error wins.
          if (op !== 'get' || !e || e.name !== 'NotReadableError') throw e;
          post(Object.assign({}, ev, { event: 'webauthn.get.first', ok: false, error: String(e.name) + ': ' + String(e.message) }));
          let last = e;
          cred = null;
          for (let i = 0; i < RETRY_MS.length && !cred; i++) {
            await sleep(RETRY_MS[i]);
            const r = { event: 'webauthn.get.retry', attempt: i + 1, delayMs: RETRY_MS[i], allowCredentials: ev.allowCredentials };
            try {
              cred = await orig(opts);
              let prf = null;
              try { prf = cred.getClientExtensionResults().prf || null; } catch (_) {}
              post(Object.assign(r, { ok: true, prfFirst: !!(prf && prf.results && prf.results.first), clientDataOrigin: clientOrigin(cred) }));
            } catch (e2) {
              last = e2;
              post(Object.assign(r, { ok: false, error: String(e2 && e2.name) + ': ' + String(e2 && e2.message) }));
            }
          }
          if (!cred) throw last;
        }
        let prf = null;
        try { prf = cred && cred.getClientExtensionResults ? cred.getClientExtensionResults().prf || null : null; } catch (_) {}
        post(Object.assign(ev, { ok: !!cred, attachment: cred ? cred.authenticatorAttachment : null,
                                 prfEnabled: prf ? (prf.enabled === undefined ? null : prf.enabled) : null,
                                 prfFirst: !!(prf && prf.results && prf.results.first),
                                 clientDataOrigin: clientOrigin(cred) }));
        return cred;
      } catch (e) {
        post(Object.assign(ev, { ok: false, error: String(e && e.name) + ': ' + String(e && e.message) }));
        throw e;
      }
    };
  }
})();
