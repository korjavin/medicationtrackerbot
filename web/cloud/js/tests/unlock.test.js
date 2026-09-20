import { afterEach, describe, expect, it, vi } from 'vitest';
import { establishLdkCache, forwardableShareFragment, runUnlockFlow, unlockSuccessTarget } from '../unlock.js';
import { deriveKEK, deriveKMac, toBase64, wrapEnvelope } from '../crypto.js';

// Unlock-shell side of the shared-plan fragment round-trip (bd med-uo64.3):
// only #share-plan= rides between / and /unlock (cloud-boot.js forwards it
// here; the warm/cold success paths hand it back to /). Anything else —
// notably #claim= — must not forward, or the two shells ping-pong forever.
// runUnlockFlow is exercised two ways: with no indexedDB under node the
// LDK read throws and falls through to the cold renderLocked screen (hint
// cases); with an in-memory indexedDB seeded by the real establishLdkCache,
// the warm branch redirects through real WebCrypto (return-leg case).
describe('unlock share-plan fragment (med-uo64.3)', () => {
  it('forwardableShareFragment passes through only #share-plan=', () => {
    expect(forwardableShareFragment('#share-plan=p1.abc')).toBe('#share-plan=p1.abc');
    expect(forwardableShareFragment('#claim=tok123')).toBe('');
    expect(forwardableShareFragment('#other=x')).toBe('');
    expect(forwardableShareFragment('')).toBe('');
    expect(forwardableShareFragment(null)).toBe('');
    expect(forwardableShareFragment(undefined)).toBe('');
  });

  it('unlockSuccessTarget is the /unlock -> / return leg both success paths share', () => {
    expect(unlockSuccessTarget('#share-plan=p1.abc')).toBe('/#share-plan=p1.abc');
    expect(unlockSuccessTarget('')).toBe('/');
    expect(unlockSuccessTarget('#claim=tok123')).toBe('/');
    expect(unlockSuccessTarget('#other=x')).toBe('/');
  });

  // Node 21+ ships navigator/location as getter-only globals — plain
  // assignment throws, so install fakes via defineProperty and restore
  // the original descriptors afterwards. Shared by both inner suites.
  const GLOBAL_KEYS = ['document', 'location', 'navigator', 'indexedDB', 'fetch', 'PublicKeyCredential'];
  const savedDesc = {};
  for (const key of GLOBAL_KEYS) {
    savedDesc[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  }
  function setGlobal(key, value) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  afterEach(() => {
    for (const key of GLOBAL_KEYS) {
      if (!savedDesc[key]) delete globalThis[key];
      else Object.defineProperty(globalThis, key, savedDesc[key]);
    }
  });

  function fakeApp() {
    const listeners = {};
    const buttons = {
      '#unlock-button': { addEventListener: (ev, fn) => { listeners[`unlock:${ev}`] = fn; }, textContent: '' },
      '#share-plan-copy-button': { addEventListener: (ev, fn) => { listeners[`copy:${ev}`] = fn; }, textContent: 'Copy link' },
    };
    return {
      innerHTML: '',
      _listeners: listeners,
      _buttons: buttons,
      querySelector: (sel) => buttons[sel] || null,
    };
  }

  // In-memory indexedDB shared by both return-leg suites: openDb only
  // fires onsuccess (never onupgradeneeded, so applyUpgrade's schema calls
  // stay out of it).
  function installFakeIdb() {
    const store = new Map();
    const objectStore = () => ({
      get: (key) => {
        const req = {};
        queueMicrotask(() => { req.result = store.get(key); if (req.onsuccess) req.onsuccess(); });
        return req;
      },
      put: (rec, key) => {
        store.set(key, rec);
        const req = {};
        queueMicrotask(() => { if (req.onsuccess) req.onsuccess(); });
        return req;
      },
    });
    const tx = () => ({
      objectStore,
      set oncomplete(fn) { queueMicrotask(() => { if (fn) fn(); }); },
    });
    setGlobal('indexedDB', {
      open: () => {
        const req = {};
        queueMicrotask(() => { req.result = { transaction: tx, close() {} }; if (req.onsuccess) req.onsuccess(); });
        return req;
      },
    });
  }

  describe('cold unlock hint', () => {

    async function runColdUnlock({ hash, href }) {
      const app = fakeApp();
      setGlobal('location', { hash, href });
      setGlobal('document', { getElementById: (id) => (id === 'app' ? app : null) });
      await runUnlockFlow();
      return app;
    }

    it('renders the paste hint + Copy button when the fragment is present, and Copy copies the link', async () => {
      const href = 'https://acct.example.test/unlock#share-plan=p1.abc';
      const app = await runColdUnlock({ hash: '#share-plan=p1.abc', href });
      expect(app.innerHTML).toContain('share-plan-copy-button');
      expect(app.innerHTML).toContain('Import plan');

      const writeText = vi.fn(async () => {});
      setGlobal('navigator', { clipboard: { writeText } });
      await app._listeners['copy:click']();
      expect(writeText).toHaveBeenCalledWith(href);
      expect(app._buttons['#share-plan-copy-button'].textContent).toBe('Copied');
    });

    it('copy falls back to a by-hand hint when no clipboard is available', async () => {
      const app = await runColdUnlock({ hash: '#share-plan=p1.abc', href: 'https://acct.example.test/unlock#share-plan=p1.abc' });
      setGlobal('navigator', undefined);
      await app._listeners['copy:click']();
      expect(app._buttons['#share-plan-copy-button'].textContent).toBe('Copy this link by hand');
    });


    it('renders no hint without the fragment, and none for #claim=', async () => {
      const plain = await runColdUnlock({ hash: '', href: 'https://acct.example.test/unlock' });
      expect(plain.innerHTML).not.toContain('share-plan-copy-button');
      expect(plain.innerHTML).toContain('unlock-button');

      const claim = await runColdUnlock({ hash: '#claim=tok123', href: 'https://acct.example.test/unlock#claim=tok123' });
      expect(claim.innerHTML).not.toContain('share-plan-copy-button');
    });
  });

  describe('warm unlock return leg', () => {
    it('hands the fragment back to / (real LDK round-trip)', async () => {
    installFakeIdb();

    // A genuinely wrapped DEK via the real establishLdkCache, so the
    // warm path below unwraps through real WebCrypto, not a stub.
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    await establishLdkCache(dek, 'acct-1');

    // Success must redirect, never render (innerHTML stays untouched).
    const app = fakeApp();
    setGlobal('document', { getElementById: () => app });
    setGlobal('location', { hash: '#share-plan=p1.abc', href: '' });
    await runUnlockFlow();
    expect(globalThis.location.href).toBe('/#share-plan=p1.abc');
    expect(app.innerHTML).toBe('');

    setGlobal('location', { hash: '', href: '' });
    await runUnlockFlow();
    expect(globalThis.location.href).toBe('/');

    setGlobal('location', { hash: '#claim=tok123', href: '' });
    await runUnlockFlow();
    expect(globalThis.location.href).toBe('/');
    });
  });

  describe('cold unlock ceremony', () => {
    it('passkey unlock hands the fragment back to / (the path a forwarded link takes)', async () => {
      installFakeIdb(); // empty store: no LDK, so the locked screen renders
      const accountId = 'acct-9';
      const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
      const credId = globalThis.crypto.getRandomValues(new Uint8Array(32));
      const prfBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
      // The envelope the server would hold: wrapped by the real crypto with
      // the KEK this ceremony re-derives, so the whole path is genuine.
      const kek = await deriveKEK(prfBytes, accountId, credId);
      const envelope = await wrapEnvelope({
        kek, dek, kMac: await deriveKMac(dek), accountId, credentialId: credId,
      });

      setGlobal('PublicKeyCredential', { parseRequestOptionsFromJSON: (x) => x || {} });
      setGlobal('navigator', {
        credentials: {
          get: async () => ({
            rawId: credId.buffer,
            getClientExtensionResults: () => ({ prf: { results: { first: prfBytes.buffer } } }),
            toJSON: () => ({ id: 'cred-1', rawId: 'cred-1', response: {}, clientExtensionResults: {} }),
          }),
        },
      });
      setGlobal('fetch', async (url) => {
        const u = String(url);
        if (u === '/api/webauthn/login/begin') return { ok: true, json: async () => ({ publicKey: {} }) };
        if (u === '/api/webauthn/login/finish') return { ok: true, json: async () => ({ account_id: accountId }) };
        if (u.startsWith('/api/envelopes/')) {
          return { ok: true, json: async () => ({ nonce: toBase64(envelope.nonce), ct: toBase64(envelope.ct) }) };
        }
        throw new Error('unexpected fetch ' + u);
      });

      const app = fakeApp();
      setGlobal('document', { getElementById: () => app });
      setGlobal('location', { hash: '#share-plan=p1.abc', href: '' });
      await runUnlockFlow();
      // Cold device: the locked screen (with the paste hint) renders first.
      expect(app.innerHTML).toContain('share-plan-copy-button');
      // The Unlock button's passkey ceremony redirects back with the fragment.
      await app._listeners['unlock:click']();
      await vi.waitFor(() => expect(globalThis.location.href).toBe('/#share-plan=p1.abc'));
    });

  });
});
