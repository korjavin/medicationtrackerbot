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
  for (const op of ['create', 'get']) {
    const orig = c[op].bind(c);
    c[op] = async (opts) => {
      const pk = opts && opts.publicKey;
      const ev = { event: 'webauthn.' + op, host: location.host, publicKey: !!pk,
                   wantsPrf: !!(pk && pk.extensions && pk.extensions.prf) };
      try {
        const cred = await orig(opts);
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
