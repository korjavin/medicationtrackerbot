// QA soft authenticator (bd med-nt9p.25, docs/android.md → Agent QA harness).
// DEBUG SOURCE SET ONLY: the release APK has no such file. The shell injects it at
// document start only when the launch intent carries the adb-only extra qaSoftAuthn
// (DebugHooks.kt), so the emulator harness can claim a runner-minted invite: CDP
// virtual authenticators do not exist in Android WebView and Google Password
// Manager cannot run headless.
//
// A software platform authenticator on WebCrypto that the real server verifies as
// is: ES256 key per credential, "none" attestation, flags UP|UV|BE|BS(+AT), sign
// count 0, discoverable, and a PRF extension (HMAC-SHA256 over a per-credential
// secret, salted per the WebAuthn PRF spec). Credentials live in localStorage per
// rpId so a relaunch within the run finds them. The page code is unchanged.
(() => {
  'use strict';
  const enc = new TextEncoder();
  const subtle = crypto.subtle;
  const STORE = (rpId) => `qa-softauthn:${rpId}`;

  const bytes = (x) => (x instanceof ArrayBuffer ? new Uint8Array(x)
    : ArrayBuffer.isView(x) ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : new Uint8Array(0));
  const buf = (u8) => u8.slice().buffer;
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const b64u = (x) => {
    let s = '';
    for (const b of bytes(x)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const unb64u = (s) => {
    const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  };
  const sha256 = async (u8) => new Uint8Array(await subtle.digest('SHA-256', u8));
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  // Minimal CBOR: unsigned/negative ints, byte/text strings, maps (a Map keeps key order).
  function cbor(value) {
    const out = [];
    const head = (major, n) => {
      const m = major << 5;
      if (n < 24) out.push(m | n);
      else if (n < 0x100) out.push(m | 24, n);
      else if (n < 0x10000) out.push(m | 25, n >> 8, n & 255);
      else out.push(m | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255);
    };
    const put = (v) => {
      if (typeof v === 'number') v >= 0 ? head(0, v) : head(1, -1 - v);
      else if (typeof v === 'string') { const b = enc.encode(v); head(3, b.length); out.push(...b); }
      else if (v instanceof Uint8Array) { head(2, v.length); out.push(...v); }
      else if (v instanceof Map) { head(5, v.size); for (const [k, x] of v) { put(k); put(x); } }
      else throw new TypeError('cbor: unsupported value');
    };
    put(value);
    return new Uint8Array(out);
  }

  // WebCrypto signs ECDSA as raw r||s; WebAuthn wants ASN.1 DER.
  function der(raw) {
    const int = (x) => {
      let i = 0;
      while (i < x.length - 1 && x[i] === 0) i++;
      x = x.slice(i);
      if (x[0] & 0x80) x = concat(new Uint8Array([0]), x);
      return concat(new Uint8Array([2, x.length]), x);
    };
    const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
    return concat(new Uint8Array([0x30, body.length]), body);
  }

  const load = (rpId) => { try { return JSON.parse(localStorage.getItem(STORE(rpId)) || '[]'); } catch { return []; } };
  const save = (rpId, list) => localStorage.setItem(STORE(rpId), JSON.stringify(list));

  // UP 0x01 | UV 0x04 | BE 0x08 | BS 0x10 (| AT 0x40 on create); sign count stays 0.
  const authData = async (rpId, flags, attested) => concat(await sha256(enc.encode(rpId)), new Uint8Array([flags, 0, 0, 0, 0]), attested || new Uint8Array(0));
  const clientData = (type, challenge) => enc.encode(JSON.stringify({
    type, challenge: b64u(challenge), origin: location.origin, crossOrigin: false,
  }));

  async function prfFirst(cred, ext) {
    const input = ext && ext.prf && ext.prf.eval && ext.prf.eval.first;
    if (!input) return undefined;
    const salt = await sha256(concat(enc.encode('WebAuthn PRF'), new Uint8Array([0]), bytes(input)));
    const key = await subtle.importKey('raw', unb64u(cred.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return subtle.sign('HMAC', key, salt);
  }

  function credential(id, response, ext, json) {
    return {
      id: b64u(id), rawId: buf(id), type: 'public-key', authenticatorAttachment: 'platform', response,
      getClientExtensionResults: () => ext,
      toJSON: () => ({
        id: b64u(id), rawId: b64u(id), type: 'public-key', authenticatorAttachment: 'platform',
        clientExtensionResults: JSON.parse(JSON.stringify(ext, (k, v) => (v instanceof ArrayBuffer ? b64u(v) : v))),
        response: json,
      }),
    };
  }

  async function create(pk) {
    const rpId = (pk.rp && pk.rp.id) || location.hostname;
    const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey)); // 0x04 || x || y
    const spki = new Uint8Array(await subtle.exportKey('spki', kp.publicKey));
    const id = crypto.getRandomValues(new Uint8Array(16));
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, pub.slice(1, 33)], [-3, pub.slice(33)]]));
    const attested = concat(new Uint8Array(16), new Uint8Array([0, id.length]), id, cose);
    const ad = await authData(rpId, 0x5d, attested);
    const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
    const cd = clientData('webauthn.create', bytes(pk.challenge));
    const cred = {
      id: b64u(id), jwk: await subtle.exportKey('jwk', kp.privateKey),
      secret: b64u(crypto.getRandomValues(new Uint8Array(32))), user: b64u(bytes(pk.user && pk.user.id)),
    };
    save(rpId, [...load(rpId), cred]);
    const ext = {};
    if (pk.extensions && pk.extensions.prf) {
      ext.prf = { enabled: true };
      const first = await prfFirst(cred, pk.extensions);
      if (first) ext.prf.results = { first };
    }
    const response = {
      clientDataJSON: buf(cd), attestationObject: buf(att),
      getTransports: () => ['internal'], getAuthenticatorData: () => buf(ad),
      getPublicKey: () => buf(spki), getPublicKeyAlgorithm: () => -7,
    };
    return credential(id, response, ext, {
      clientDataJSON: b64u(cd), attestationObject: b64u(att), transports: ['internal'],
      authenticatorData: b64u(ad), publicKey: b64u(spki), publicKeyAlgorithm: -7,
    });
  }

  async function get(pk) {
    const rpId = pk.rpId || location.hostname;
    const list = load(rpId);
    const allow = (pk.allowCredentials || []).map((c) => bytes(c.id));
    // Discoverable (empty allowlist, as the shell's passkey-get.js sends): the newest one.
    const cred = allow.length ? list.find((c) => allow.some((a) => same(a, unb64u(c.id)))) : list[list.length - 1];
    if (!cred) throw new DOMException('qa soft authenticator: no credential for ' + rpId, 'NotAllowedError');
    const id = unb64u(cred.id);
    const ad = await authData(rpId, 0x1d);
    const cd = clientData('webauthn.get', bytes(pk.challenge));
    const key = await subtle.importKey('jwk', cred.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const sig = der(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, concat(ad, await sha256(cd)))));
    const user = unb64u(cred.user);
    const ext = {};
    const first = await prfFirst(cred, pk.extensions);
    if (first) ext.prf = { results: { first } };
    const response = { clientDataJSON: buf(cd), authenticatorData: buf(ad), signature: buf(sig), userHandle: buf(user) };
    return credential(id, response, ext, {
      clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: b64u(user),
    });
  }

  const real = navigator.credentials;
  const soft = {
    create: (o) => (o && o.publicKey ? create(o.publicKey) : real.create(o)),
    get: (o) => (o && o.publicKey ? get(o.publicKey) : real.get(o)),
    store: (c) => real.store(c),
    preventSilentAccess: () => real.preventSilentAccess(),
  };
  Object.defineProperty(Navigator.prototype, 'credentials', { configurable: true, get: () => soft });

  // WebView 113 on the emulator image predates parse*FromJSON (Chrome 129); polyfill them.
  const PKC = window.PublicKeyCredential || (window.PublicKeyCredential = function PublicKeyCredential() {
    throw new TypeError('Illegal constructor');
  });
  const ids = (list) => (list || []).map((c) => ({ ...c, id: buf(unb64u(c.id)) }));
  const statics = {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
    isConditionalMediationAvailable: async () => false,
  };
  if (!PKC.parseCreationOptionsFromJSON) {
    statics.parseCreationOptionsFromJSON = (j) => ({
      ...j, challenge: buf(unb64u(j.challenge)), user: { ...j.user, id: buf(unb64u(j.user.id)) },
      excludeCredentials: ids(j.excludeCredentials),
    });
  }
  if (!PKC.parseRequestOptionsFromJSON) {
    statics.parseRequestOptionsFromJSON = (j) => ({ ...j, challenge: buf(unb64u(j.challenge)), allowCredentials: ids(j.allowCredentials) });
  }
  for (const [k, value] of Object.entries(statics)) Object.defineProperty(PKC, k, { configurable: true, writable: true, value });
  console.log('[qa-softauthn] installed for', location.hostname);
})();
