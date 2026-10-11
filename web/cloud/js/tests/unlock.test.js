import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  establishLdkCache, forwardableShareFragment, readLdkRecord, runUnlockFlow, unlockSuccessTarget,
  verifyLdkDurable, warmUnlock,
} from '../unlock.js';
import { deriveDataKeys, deriveKEK, deriveKMac, generateDEK, toBase64, wrapEnvelope } from '../crypto.js';
import { openDb } from '../localdb.js';

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
    // A shared gym (med-8j5w.3) survives the round-trip the same way.
    expect(forwardableShareFragment('#share-gym=g1.abc')).toBe('#share-gym=g1.abc');
    expect(unlockSuccessTarget('#share-gym=g1.abc')).toBe('/#share-gym=g1.abc');
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

  // A fresh fake-indexeddb per test: real structured clone (CryptoKeys
  // included) and a real handle close/reopen between every cache operation.
  function installFakeIdb() {
    setGlobal('indexedDB', new IDBFactory());
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

    // A genuine v2 cache via the real establishLdkCache, so the warm path
    // below opens it through real WebCrypto + IndexedDB, not a stub.
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
    // The /unlock shell recognises v2 and never wipes a valid cache.
    expect((await readLdkRecord()).v).toBe(2);
    });
  });

  // med-5h1t.4: the warm-unlock cache holds leaf CryptoKeys, never DEK bytes.
  describe('LDK cache v2', () => {
    const AAD = new TextEncoder().encode('mt/v1/ldk');

    // What a pre-v2 shell wrote: the DEK AES-GCM-wrapped under a local key.
    async function writeV1(dek, accountId) {
      const ldk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: AAD }, ldk, dek));
      const v1 = { ldk, nonce, ct, accountId };
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('device', 'readwrite');
        tx.objectStore('device').put(v1, 'ldk');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }

    // The ctx's keys are this DEK's leaf keys: AES sealed by an independent
    // derivation opens with ctx.kData; a MAC from the raw K_mac verifies.
    async function expectKeysOf(ctx, dek) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const msg = crypto.getRandomValues(new Uint8Array(16));
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, (await deriveDataKeys(dek)).kData, msg);
      expect(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, ctx.kData, sealed))).toEqual(msg);
      const signKey = await crypto.subtle.importKey('raw', await deriveKMac(dek), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const tag = await crypto.subtle.sign('HMAC', signKey, msg);
      expect(await crypto.subtle.verify('HMAC', ctx.kMac, tag, msg)).toBe(true);
    }

    function expectNoDekBytes(rec) {
      expect(Object.keys(rec).sort()).toEqual(['accountId', 'kData', 'kMac', 'v']);
      expect(rec.kData.extractable).toBe(false);
      expect(rec.kMac.extractable).toBe(false);
      expect([...rec.kData.usages].sort()).toEqual(['decrypt', 'encrypt']);
      expect([...rec.kMac.usages]).toEqual(['verify']);
    }

    it('establishLdkCache writes v2 leaf keys that survive write → close → reopen → use', async () => {
      installFakeIdb();
      const dek = generateDEK();
      await establishLdkCache(dek, 'acct-1');

      const rec = await readLdkRecord();
      expect(rec.v).toBe(2);
      expectNoDekBytes(rec);
      expect(await readLdkRecord('ldk-staging')).toBeNull();

      const ctx = await warmUnlock();
      expect(Object.keys(ctx).sort()).toEqual(['accountId', 'kData', 'kMac']);
      expect(ctx.accountId).toBe('acct-1');
      await expectKeysOf(ctx, dek);
    });

    it('migrates a v1 record silently to v2 on warm unlock', async () => {
      installFakeIdb();
      const dek = generateDEK();
      await writeV1(dek, 'acct-1');

      const ctx = await warmUnlock();
      await expectKeysOf(ctx, dek);
      expect(ctx.dek).toBeUndefined();
      const rec = await readLdkRecord();
      expect(rec.v).toBe(2);
      expectNoDekBytes(rec);
      await expectKeysOf(await warmUnlock(), dek);
    });

    it('a failed conversion keeps v1 and still unlocks this launch; the next launch migrates', async () => {
      installFakeIdb();
      const dek = generateDEK();
      await writeV1(dek, 'acct-1');

      // The durability probe fails → the live slot is never touched.
      const spy = vi.spyOn(crypto.subtle, 'verify').mockResolvedValueOnce(false);
      const ctx = await warmUnlock();
      spy.mockRestore();
      await expectKeysOf(ctx, dek);
      const kept = await readLdkRecord();
      expect(kept.v).toBeUndefined();
      expect(kept.ct).toBeInstanceOf(Uint8Array);

      await warmUnlock();
      expect((await readLdkRecord()).v).toBe(2);
    });

    it('old-shell overlap: a v1 rewritten over v2 is re-migrated on the next launch', async () => {
      installFakeIdb();
      const dek = generateDEK();
      await establishLdkCache(dek, 'acct-1');
      // An old SW-cached /unlock shell can't read v2, clears it, and its cold
      // unlock writes v1 again.
      await writeV1(dek, 'acct-1');

      await expectKeysOf(await warmUnlock(), dek);
      expectNoDekBytes(await readLdkRecord());
    });

    it('the durability probe rejects a stored key from a different DEK', async () => {
      installFakeIdb();
      const dek = generateDEK();
      await establishLdkCache(dek, 'acct-1');

      await expect(verifyLdkDurable(dek, 'acct-1')).resolves.toBeUndefined();
      await expect(verifyLdkDurable(generateDEK(), 'acct-1')).rejects.toThrow();
      await expect(verifyLdkDurable(dek, 'acct-other')).rejects.toThrow();
    });

    it('a cache that fails its probe is cleared, not left to strand the next launch', async () => {
      installFakeIdb();
      const spy = vi.spyOn(crypto.subtle, 'verify').mockResolvedValueOnce(false);
      await expect(establishLdkCache(generateDEK(), 'acct-1')).rejects.toThrow();
      spy.mockRestore();
      expect(await readLdkRecord()).toBeNull();
      expect(await readLdkRecord('ldk-staging')).toBeNull();
      expect(await warmUnlock()).toBeNull();
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

  // med-5h1t.3: session renewal is login-only — no PRF requested, none needed,
  // no envelope fetched, no DEK returned.
  describe('session renewal', () => {
    it('renewSession re-mints the session without PRF or an envelope unwrap', async () => {
      let requested;
      setGlobal('PublicKeyCredential', { parseRequestOptionsFromJSON: (x) => x || {} });
      setGlobal('navigator', {
        credentials: {
          get: async (opts) => {
            requested = opts.publicKey;
            return {
              rawId: new Uint8Array(4).buffer,
              getClientExtensionResults: () => ({}), // a passkey without PRF
              toJSON: () => ({ id: 'cred-1', rawId: 'cred-1', response: {}, clientExtensionResults: {} }),
            };
          },
        },
      });
      const urls = [];
      setGlobal('fetch', async (url) => {
        const u = String(url);
        urls.push(u);
        if (u === '/api/webauthn/login/begin') return { ok: true, json: async () => ({ publicKey: {} }) };
        if (u === '/api/webauthn/login/finish') return { ok: true, json: async () => ({ account_id: 'acct-9' }) };
        throw new Error('unexpected fetch ' + u);
      });

      const { renewSession } = await import('../unlock.js');
      const result = await renewSession();

      expect(result).toEqual({ accountId: 'acct-9' });
      expect(requested.userVerification).toBe('required');
      expect(requested.extensions).toBeUndefined();
      expect(urls).toEqual(['/api/webauthn/login/begin', '/api/webauthn/login/finish']);
    });
  });
});
