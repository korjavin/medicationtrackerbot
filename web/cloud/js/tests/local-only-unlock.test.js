// Local-only unlock (med-eas.2.1 POC): a PRF-less assertion for an explicitly
// local_only credential opens the warm LDK cache; a cleared cache or fresh
// profile demands the Emergency Kit / trusted-device transfer; PRF
// credentials without PRF output keep the production error (no downgrade).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPasskey, establishLdkCache } from '../unlock.js';
import { resetLocalOnlyPocCacheForTests } from '../credential-mode.js';
import { toBase64Url } from '../crypto.js';

const ACCOUNT = 'acct-local-9';
const CRED_ID = globalThis.crypto.getRandomValues(new Uint8Array(16));

beforeEach(() => {
  resetLocalOnlyPocCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// In-memory indexedDB speaking just enough of the IDB protocol for
// localdb.openDb + unlock.js's LDK record helpers (get/put/delete).
function installFakeIdb() {
  const data = new Map();
  const tx = {
    oncomplete: null,
    onerror: null,
    error: null,
    objectStore: () => ({
      get: (key) => {
        const req = {};
        queueMicrotask(() => {
          req.result = data.has(key) ? data.get(key) : null;
          if (req.onsuccess) req.onsuccess();
        });
        return req;
      },
      put: (rec, key) => {
        data.set(key, rec);
        queueMicrotask(() => {
          if (tx.oncomplete) tx.oncomplete();
        });
        return {};
      },
      delete: (key) => {
        data.delete(key);
        queueMicrotask(() => {
          if (tx.oncomplete) tx.oncomplete();
        });
        return {};
      },
    }),
  };
  const db = { transaction: () => tx, close: () => {} };
  vi.stubGlobal('indexedDB', {
    open: () => {
      const req = { result: db };
      queueMicrotask(() => {
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  });
}

function installCeremony({ mode, prfBytes = null, pocAdvertised = true }) {
  const fetchUrls = [];
  vi.stubGlobal('PublicKeyCredential', { parseRequestOptionsFromJSON: (x) => x || {} });
  vi.stubGlobal('navigator', {
    credentials: {
      get: async () => ({
        rawId: CRED_ID.buffer.slice(0),
        getClientExtensionResults: () =>
          prfBytes ? { prf: { results: { first: prfBytes.buffer.slice(0) } } } : {},
        toJSON: () => ({ id: 'cred-9', response: {}, clientExtensionResults: {} }),
      }),
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const u = String(url);
      fetchUrls.push(u);
      if (u === '/api/version') {
        return { ok: true, json: async () => ({ build_id: 'test', local_only_poc: pocAdvertised }) };
      }
      if (u === '/api/webauthn/login/begin') return { ok: true, json: async () => ({ publicKey: {} }) };
      if (u === '/api/webauthn/login/finish') return { ok: true, json: async () => ({ account_id: ACCOUNT }) };
      if (u === '/api/devices') {
        return {
          ok: true,
          json: async () => [{ credential_id: toBase64Url(CRED_ID), mode, created_at: new Date().toISOString() }],
        };
      }
      throw new Error('unexpected fetch ' + u);
    })
  );
  return fetchUrls;
}

describe('local-only unlock (unlock.js)', () => {
  it('opens the warm LDK cache for an explicit local_only credential', async () => {
    installFakeIdb();
    vi.stubGlobal('location', { search: '?local-only-poc=1' });
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    await establishLdkCache(dek, ACCOUNT);
    installCeremony({ mode: 'local_only' });

    const ctx = await assertPasskey();
    expect(ctx.accountId).toBe(ACCOUNT);
    expect(ctx.mode).toBe('local_only');
    expect(Buffer.from(ctx.dek)).toEqual(Buffer.from(dek));
    // No envelope fetch: the DEK came from the LDK, never the server.
    expect(global.fetch.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
      expect.stringContaining('/api/envelopes/')
    );
  });

  it('demands the Emergency Kit when the LDK cache is gone (cleared site data / fresh profile)', async () => {
    installFakeIdb(); // empty store: nothing was ever cached here
    vi.stubGlobal('location', { search: '?local-only-poc=1' });
    installCeremony({ mode: 'local_only' });

    const err = await assertPasskey().catch((e) => e);
    expect(err.code).toBe('local-only-recovery-required');
    expect(err.message).toContain('Emergency Kit');
  });

  it('keeps the production error for a PRF credential without PRF output', async () => {
    installFakeIdb();
    vi.stubGlobal('location', { search: '?local-only-poc=1' });
    const fetchUrls = installCeremony({ mode: 'prf' });

    const err = await assertPasskey().catch((e) => e);
    expect(err.code).toBeUndefined();
    expect(err.message).toContain("doesn't support the security feature");
    // The POC path routes by stored mode after the assertion verifies.
    expect(fetchUrls).toContain('/api/devices');
  });

  it('still takes the LDK for a local_only credential that starts returning PRF', async () => {
    installFakeIdb();
    vi.stubGlobal('location', { search: '?local-only-poc=1' });
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    await establishLdkCache(dek, ACCOUNT);
    // The authenticator gained PRF after enrollment (browser update) — but
    // the credential has no envelope, so the stored mode must win over the
    // fresh output.
    installCeremony({ mode: 'local_only', prfBytes: globalThis.crypto.getRandomValues(new Uint8Array(32)) });

    const ctx = await assertPasskey();
    expect(ctx.mode).toBe('local_only');
    expect(Buffer.from(ctx.dek)).toEqual(Buffer.from(dek));
    expect(global.fetch.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
      expect.stringContaining('/api/envelopes/')
    );
  });

  it('stays on the production path when the operator switch is off (crafted link neutered)', async () => {
    installFakeIdb();
    vi.stubGlobal('location', { search: '?local-only-poc=1' });
    const fetchUrls = installCeremony({ mode: 'local_only', pocAdvertised: false });

    const err = await assertPasskey().catch((e) => e);
    expect(err.message).toContain("doesn't support the security feature");
    expect(fetchUrls).toContain('/api/webauthn/login/begin');
    expect(fetchUrls).not.toContain('/api/webauthn/login/finish');
  });

  it('throws before login/finish with the flag off (default path unchanged)', async () => {
    installFakeIdb();
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('localStorage', undefined);
    const fetchUrls = installCeremony({ mode: 'local_only' });

    const err = await assertPasskey().catch((e) => e);
    expect(err.message).toContain("doesn't support the security feature");
    expect(fetchUrls).toContain('/api/webauthn/login/begin');
    expect(fetchUrls).not.toContain('/api/webauthn/login/finish');
  });
});
