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
  const GLOBAL_KEYS = ['document', 'location', 'navigator', 'indexedDB', 'fetch', 'PublicKeyCredential', 'window', 'wgNative', 'LocalNotifications'];
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

    // One readwrite transaction on the device store, resolving with the
    // last request's result.
    async function deviceStore(fn) {
      const db = await openDb();
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction('device', 'readwrite');
          const req = fn(tx.objectStore('device'));
          tx.oncomplete = () => resolve(req?.result);
          tx.onerror = () => reject(tx.error);
        });
      } finally { db.close(); }
    }

    // What a pre-v2 shell wrote: the DEK AES-GCM-wrapped under a local key.
    async function writeV1(dek, accountId) {
      const ldk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: AAD }, ldk, dek));
      await deviceStore((s) => s.put({ ldk, nonce, ct, accountId }, 'ldk'));
    }

    // The pre-#1019 /unlock shell's warm branch, verbatim in effect: read
    // 'ldk', try to unwrap it as v1, and delete it on ANY failure.
    async function runOldShellWarmBranch() {
      const cached = await deviceStore((s) => s.get('ldk'));
      if (!cached) return;
      try {
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: cached.nonce, additionalData: AAD }, cached.ldk, cached.ct);
      } catch {
        await deviceStore((s) => { s.delete('ldk'); });
      }
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

    async function deviceKeys() {
      const db = await openDb();
      try {
        return await new Promise((resolve, reject) => {
          const req = db.transaction('device', 'readonly').objectStore('device').getAllKeys();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      } finally { db.close(); }
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
      expect(await deviceKeys()).toEqual(['ldk2']); // no staging row left behind
      expect(await readLdkRecord('ldk')).toBeNull();

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
      expect(await deviceKeys()).toEqual(['ldk2']); // the wrapped DEK is gone
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
      expect(await readLdkRecord()).toBeNull();
      const kept = await readLdkRecord('ldk');
      expect(kept.v).toBeUndefined();
      expect(kept.ct).toBeInstanceOf(Uint8Array);

      await warmUnlock();
      expect((await readLdkRecord()).v).toBe(2);
      expect(await deviceKeys()).toEqual(['ldk2']);
    });

    // med-5h1t.5: a rollback to the pre-v2 /unlock shell must see "no cache",
    // never "corrupt cache", or it wipes the only warm path.
    it('old shell cannot destroy v2, even when its cold unlock then fails', async () => {
      installFakeIdb();
      const dek = generateDEK();
      await writeV1(dek, 'acct-1');
      await warmUnlock(); // migrates

      await runOldShellWarmBranch();
      // ...then its cold unlock fails (offline / cancelled): nothing written.

      const ctx = await warmUnlock();
      expect(ctx.accountId).toBe('acct-1');
      await expectKeysOf(ctx, dek);
      expect(await deviceKeys()).toEqual(['ldk2']);
    });

    it('old shell cold unlock after v2: its v1 is migrated and the legacy slot emptied', async () => {
      installFakeIdb();
      const dek = generateDEK();
      await establishLdkCache(dek, 'acct-1');
      await runOldShellWarmBranch();
      await writeV1(dek, 'acct-1'); // the old shell's successful cold unlock

      await expectKeysOf(await warmUnlock(), dek);
      expect(await deviceKeys()).toEqual(['ldk2']);
      expectNoDekBytes(await readLdkRecord());
    });

    it('a v1 for another account is the fresher ceremony and wins', async () => {
      installFakeIdb();
      await establishLdkCache(generateDEK(), 'acct-1');
      const dek = generateDEK();
      await writeV1(dek, 'acct-2');

      const ctx = await warmUnlock();
      expect(ctx.accountId).toBe('acct-2');
      await expectKeysOf(ctx, dek);
      expect((await readLdkRecord()).accountId).toBe('acct-2');
      expect(await deviceKeys()).toEqual(['ldk2']);
    });

    it('a v2 left in the legacy slot by a pre-split shell moves to the new slot', async () => {
      installFakeIdb();
      const dek = generateDEK();
      const { kData, kMac } = await deriveDataKeys(dek);
      await deviceStore((s) => s.put({ v: 2, accountId: 'acct-1', kData, kMac }, 'ldk'));

      await expectKeysOf(await warmUnlock(), dek);
      expect(await deviceKeys()).toEqual(['ldk2']);
      await expectKeysOf(await warmUnlock(), dek);
    });

    it('an unreadable cache is cleared from both slots before the locked screen', async () => {
      installFakeIdb();
      await establishLdkCache(generateDEK(), 'acct-1');
      await deviceStore((s) => s.put({ v: 2, accountId: 'acct-1' }, 'ldk')); // corrupt
      const app = fakeApp();
      setGlobal('document', { getElementById: () => app });
      setGlobal('location', { hash: '', href: '' });
      await runUnlockFlow();
      expect(app.innerHTML).toContain('unlock-button');
      expect(await deviceKeys()).toEqual([]);
    });

    it('the durability probe rejects a stored key from a different DEK', async () => {
      installFakeIdb();
      const dek = generateDEK();
      await establishLdkCache(dek, 'acct-1');

      await expect(verifyLdkDurable(dek, 'acct-1')).resolves.toBeUndefined();
      await expect(verifyLdkDurable(generateDEK(), 'acct-1')).rejects.toThrow();
      await expect(verifyLdkDurable(dek, 'acct-other')).rejects.toThrow();
    });

    it('a write that fails its probe never reaches the live slot or clobbers what is there', async () => {
      installFakeIdb();
      const spy = vi.spyOn(crypto.subtle, 'verify').mockResolvedValueOnce(false);
      await expect(establishLdkCache(generateDEK(), 'acct-1')).rejects.toThrow();
      spy.mockRestore();
      expect(await deviceKeys()).toEqual([]);
      expect(await warmUnlock()).toBeNull();

      // Another tab's committed cache survives this tab's failed write.
      const dek = generateDEK();
      await establishLdkCache(dek, 'acct-1');
      const again = vi.spyOn(crypto.subtle, 'verify').mockResolvedValueOnce(false);
      await expect(establishLdkCache(generateDEK(), 'acct-1')).rejects.toThrow();
      again.mockRestore();
      expect(await deviceKeys()).toEqual(['ldk2']);
      await expectKeysOf(await warmUnlock(), dek);
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

    // bd med-r1j2.5 AD10 · none: Path 0 lands here; a NotAllowedError means no
    // passkey for this account on this device (or a cancel — indistinguishable),
    // so the locked screen keeps its error and points at the QR flow.
    it('a NotAllowedError points at Add a device; an app error does not', async () => {
      installFakeIdb();
      let fail = Object.assign(new Error('not allowed'), { name: 'NotAllowedError' });
      setGlobal('PublicKeyCredential', { parseRequestOptionsFromJSON: (x) => x || {} });
      setGlobal('navigator', { credentials: { get: async () => { throw fail; } } });
      setGlobal('fetch', async (url) => {
        if (String(url) === '/api/webauthn/login/begin') return { ok: true, json: async () => ({ publicKey: {} }) };
        throw new Error('unexpected fetch ' + url);
      });
      const app = fakeApp();
      let appended = [];
      const lookup = app.querySelector;
      app.querySelector = (sel) => (sel === 'section' ? { appendChild: (n) => appended.push(n) } : lookup(sel));
      setGlobal('document', { getElementById: () => app, createElement: () => ({ addEventListener(type, fn) { this.onclick = fn; } }) });
      setGlobal('location', { hash: '', href: '' });
      await runUnlockFlow();
      await app._listeners['unlock:click']();
      // On the web: no shell, so no "Back to local mode".
      await vi.waitFor(() => expect(appended.map((n) => n.id || n.className)).toEqual(['wizard-error', 'unlock-no-passkey', 'unlock-add-device']));
      expect(appended[1].textContent).toMatch(/^No passkey for this account on this device\? .*Settings → Devices & connectors → Add a device\.$/);
      // bd med-r1j2.10: the sun opens /claim's in-app scanner.
      expect(appended[2].textContent).toBe('Add this device from another device');
      appended[2].onclick();
      expect(globalThis.location.href).toBe('/claim#scan');

      appended = [];
      fail = new Error('Unlock failed. Please try again.');
      await app._listeners['unlock:click']();
      await vi.waitFor(() => expect(appended.map((n) => n.id || n.className)).toEqual(['wizard-error']));
    });

    // med-r1j2.17: "Back to local mode" lands without the invite sheet only
    // where the shell advertises account.leave.forget.
    it.each([
      ['a shell with account.leave.forget', true, ['account.leave', { then: 'local', forget: true }]],
      ['an older shell', false, ['account.leave']],
    ])('Back to local mode on %s', async (_name, advertised, expected) => {
      installFakeIdb();
      setGlobal('PublicKeyCredential', { parseRequestOptionsFromJSON: (x) => x || {} });
      setGlobal('navigator', { credentials: { get: async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); } } });
      setGlobal('fetch', async () => ({ ok: true, json: async () => ({ publicKey: {} }) }));
      const call = vi.fn(async () => null);
      const has = vi.fn(async (op) => advertised && op === 'account.leave.forget');
      setGlobal('LocalNotifications', { __native: { platform: 'ios', call, has } });
      const app = fakeApp();
      const appended = [];
      const lookup = app.querySelector;
      app.querySelector = (sel) => (sel === 'section' ? { appendChild: (n) => appended.push(n) } : lookup(sel));
      setGlobal('document', { getElementById: () => app, createElement: () => ({ addEventListener(type, fn) { this.onclick = fn; } }) });
      setGlobal('location', { hash: '', href: '' });
      await runUnlockFlow();
      await app._listeners['unlock:click']();
      await vi.waitFor(() => expect(appended.some((n) => n.id === 'unlock-back-local')).toBe(true));
      appended.find((n) => n.id === 'unlock-back-local').onclick();
      await vi.waitFor(() => expect(call).toHaveBeenCalledWith(...expected));
      expect(call).toHaveBeenCalledTimes(1);
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

  // med-nt9p.19: inside the Android shell (window.wgNative) GPM only finds
  // app-created passkeys by a discoverable get, so the server allowlist is
  // dropped there and Credential Manager's transient NotReadableError is
  // retried; on web/iOS the request is the server's, sent once.
  describe('Android shell discoverable login', () => {
    const ALLOW = [{ type: 'public-key', id: new Uint8Array([1, 2]).buffer }];
    function install(getImpl) {
      const calls = [];
      setGlobal('PublicKeyCredential', { parseRequestOptionsFromJSON: () => ({ challenge: 'c', allowCredentials: ALLOW }) });
      setGlobal('navigator', {
        credentials: {
          get: async (opts) => {
            calls.push(opts.publicKey);
            return getImpl(calls.length);
          },
        },
      });
      setGlobal('fetch', async (url) => {
        const u = String(url);
        if (u === '/api/webauthn/login/begin') return { ok: true, json: async () => ({ publicKey: {} }) };
        if (u === '/api/webauthn/login/finish') return { ok: true, json: async () => ({ account_id: 'acct-9' }) };
        throw new Error('unexpected fetch ' + u);
      });
      return calls;
    }
    const assertion = () => ({
      rawId: new Uint8Array(4).buffer,
      getClientExtensionResults: () => ({}),
      toJSON: () => ({ id: 'cred-1', rawId: 'cred-1', response: {}, clientExtensionResults: {} }),
    });
    const notReadable = () => Object.assign(new Error('unknown error talking to the credential manager'), { name: 'NotReadableError' });

    it('web: sends the server allowlist in a single get, and a NotReadableError is not retried', async () => {
      setGlobal('window', globalThis);
      const calls = install(() => { throw notReadable(); });
      const { renewSession } = await import('../unlock.js');
      await expect(renewSession()).rejects.toThrow(/credential manager/);
      expect(calls).toHaveLength(1);
      expect(calls[0].allowCredentials).toBe(ALLOW);
    });

    it('Android shell: sends allowCredentials: [] and retries a NotReadableError', async () => {
      setGlobal('window', globalThis);
      setGlobal('wgNative', { postMessage() {}, addEventListener() {} });
      // One real 1 s backoff — cheaper to wait than to drive fake timers
      // through the begin/finish fetch microtasks.
      const calls = install((n) => { if (n === 1) throw notReadable(); return assertion(); });
      const { renewSession } = await import('../unlock.js');
      await expect(renewSession()).resolves.toEqual({ accountId: 'acct-9' });
      expect(calls).toHaveLength(2);
      expect(calls.every((c) => Array.isArray(c.allowCredentials) && c.allowCredentials.length === 0)).toBe(true);
      expect(calls[0].challenge).toBe('c');
    });

    it('Android shell: any other error is not retried', async () => {
      setGlobal('window', globalThis);
      setGlobal('wgNative', { postMessage() {}, addEventListener() {} });
      const calls = install(() => { throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }); });
      const { renewSession } = await import('../unlock.js');
      await expect(renewSession()).rejects.toThrow('cancelled');
      expect(calls).toHaveLength(1);
    });

    it('an <iframe name=wgNative>-style clobber (a Window) stays web', async () => {
      setGlobal('window', globalThis);
      const clobber = { postMessage() {}, addEventListener() {} };
      clobber.window = clobber;
      setGlobal('wgNative', clobber);
      const calls = install(() => assertion());
      const { renewSession } = await import('../unlock.js');
      await renewSession();
      expect(calls[0].allowCredentials).toBe(ALLOW);
    });
  });
});
