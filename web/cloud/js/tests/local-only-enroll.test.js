// Local-only enrollment (med-eas.2.1 POC): warned consent, finish with an
// explicit mode and no envelope, then the two verifications (durable LDK
// wrapping + recovery material confirmed) with rollback on any failure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../unlock.js', () => ({
  establishLdkCache: vi.fn(async () => {}),
  readLdkRecord: vi.fn(async () => null),
  unwrapWithLdk: vi.fn(async () => {
    throw new Error('no key');
  }),
  clearLdkCache: vi.fn(async () => {}),
  restoreLdkCache: vi.fn(async () => {}),
}));
vi.mock('../signup.js', () => ({ renderUnsupportedAuthenticator: vi.fn() }));

import { enrollWithToken } from '../claim.js';
import { establishLdkCache, readLdkRecord, unwrapWithLdk, clearLdkCache, restoreLdkCache } from '../unlock.js';
import { renderUnsupportedAuthenticator } from '../signup.js';
import { resetLocalOnlyPocCacheForTests } from '../credential-mode.js';

const ACCOUNT = 'acct-local-1';
const DEK = new Uint8Array(32).fill(7);
const RAW_ID = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

let dom;
let app;
let fetchCalls;

function fakeCredential() {
  return {
    rawId: RAW_ID.buffer.slice(0),
    toJSON: () => ({ id: 'cred-1', rawId: 'AQIDBAUG', response: {}, clientExtensionResults: {} }),
  };
}

function installNavigator({ prf } = {}) {
  vi.stubGlobal('navigator', {
    credentials: {
      create: async () => fakeCredential(),
      get: async () => ({
        getClientExtensionResults: () => (prf ? { prf: { results: { first: new ArrayBuffer(32) } } } : {}),
      }),
    },
  });
  vi.stubGlobal('PublicKeyCredential', {
    parseCreationOptionsFromJSON: (x) => ({ ...x, user: { id: new TextEncoder().encode(ACCOUNT) } }),
  });
}

function installFetch({ envelopes = [{ credential_ref: 'recovery' }], finishOk = true, finishStatus = 200 } = {}) {
  fetchCalls = [];
  global.fetch = vi.fn(async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), opts });
    const u = String(url);
    if (u.endsWith('/api/webauthn/register/begin')) {
      return { ok: true, json: async () => ({ publicKey: {} }) };
    }
    if (u.endsWith('/api/webauthn/register/finish')) {
      return { ok: finishOk, status: finishStatus, json: async () => ({}) };
    }
    if (u.endsWith('/api/envelopes')) {
      return { ok: true, json: async () => envelopes };
    }
    if (u.endsWith('/api/version')) {
      return { ok: true, json: async () => ({ build_id: 'test', local_only_poc: true }) };
    }
    if (u.includes('/api/devices/')) {
      return { ok: true };
    }
    throw new Error('unexpected fetch ' + u);
  });
}

function enablePoc() {
  vi.stubGlobal('location', { search: '?local-only-poc=1' });
}

function disablePoc() {
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('localStorage', undefined);
}

function setChecked(el, checked) {
  el.checked = checked;
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

beforeEach(() => {
  resetLocalOnlyPocCacheForTests();
  dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://acct.example.test/' });
  global.document = dom.window.document;
  app = dom.window.document.getElementById('app');
  installNavigator();
  installFetch();
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
  delete global.document;
  delete global.fetch;
});

async function driveConsentToConfirm() {
  await vi.waitFor(() => {
    if (!app.querySelector('#local-only-continue')) throw new Error('consent not rendered yet');
  });
  setChecked(app.querySelector('#local-only-ack-checkbox'), true);
  app.querySelector('#local-only-continue').click();
}

describe('local-only enrollment (claim.js)', () => {
  it('routes a PRF-less authenticator to warned consent behind the flag', async () => {
    enablePoc();
    const pending = enrollWithToken(app, { enrollmentToken: 'tok', accountId: ACCOUNT, dek: DEK });
    await vi.waitFor(() => {
      if (!app.querySelector('#local-only-continue')) throw new Error('consent not rendered yet');
    });
    expect(app.querySelector('#local-only-warning').textContent).toContain('cannot recover');
    expect(app.querySelector('#local-only-warning').textContent).toContain('Emergency Kit');
    expect(app.querySelector('#local-only-continue').disabled).toBe(true);
    app.querySelector('#local-only-cancel').click();
    await expect(pending).resolves.toBe(false);
    expect(renderUnsupportedAuthenticator).toHaveBeenCalled();
  });

  it('stays on the terminal unsupported state with the flag off', async () => {
    disablePoc();
    await expect(enrollWithToken(app, { enrollmentToken: 'tok', accountId: ACCOUNT, dek: DEK })).resolves.toBe(
      false
    );
    expect(renderUnsupportedAuthenticator).toHaveBeenCalled();
    expect(establishLdkCache).not.toHaveBeenCalled();
  });

  it('finishes with explicit local_only mode, no envelope, then verifies LDK + recovery', async () => {
    enablePoc();
    readLdkRecord.mockResolvedValue({ accountId: ACCOUNT });
    unwrapWithLdk.mockResolvedValue(DEK);
    const pending = enrollWithToken(app, { enrollmentToken: 'tok', accountId: ACCOUNT, dek: DEK });
    await driveConsentToConfirm();
    await expect(pending).resolves.toBe(true);

    const finish = fetchCalls.find((c) => c.url.endsWith('/api/webauthn/register/finish'));
    expect(finish).toBeDefined();
    const body = JSON.parse(finish.opts.body);
    expect(body.mode).toBe('local_only');
    expect(body).not.toHaveProperty('envelope');
    expect(body.credential.clientExtensionResults).not.toHaveProperty('prf');
    expect(establishLdkCache).toHaveBeenCalledWith(DEK, ACCOUNT);
    expect(fetchCalls.some((c) => c.url.endsWith('/api/envelopes'))).toBe(true);
    expect(fetchCalls.some((c) => c.opts.method === 'DELETE')).toBe(false);
    expect(clearLdkCache).not.toHaveBeenCalled();
    expect(restoreLdkCache).not.toHaveBeenCalled();
  });

  it('fails before finish when the LDK record does not persist (nothing committed)', async () => {
    enablePoc();
    readLdkRecord.mockResolvedValue(null);
    const pending = enrollWithToken(app, { enrollmentToken: 'tok', accountId: ACCOUNT, dek: DEK });
    await driveConsentToConfirm();
    await expect(pending).resolves.toBe(false);
    // Staged first, so the token is still unspent: no finish, no rollback —
    // and no prior cache, so the staged record is cleared outright.
    expect(establishLdkCache).toHaveBeenCalledWith(DEK, ACCOUNT);
    expect(fetchCalls.some((c) => c.url.endsWith('/api/webauthn/register/finish'))).toBe(false);
    expect(fetchCalls.some((c) => c.opts.method === 'DELETE')).toBe(false);
    expect(clearLdkCache).toHaveBeenCalled();
    expect(restoreLdkCache).not.toHaveBeenCalled();
    expect(app.innerHTML).toContain('Local-only enrollment failed');
  });

  it('clears the staged LDK when finish fails, without a rollback', async () => {
    enablePoc();
    installFetch({ finishOk: false, finishStatus: 500 });
    // First read is the pre-existing cache (none here); later reads see the
    // staged record.
    readLdkRecord.mockResolvedValueOnce(null).mockResolvedValue({ accountId: ACCOUNT });
    unwrapWithLdk.mockResolvedValue(DEK);
    const pending = enrollWithToken(app, { enrollmentToken: 'tok', accountId: ACCOUNT, dek: DEK });
    await driveConsentToConfirm();
    await expect(pending).resolves.toBe(false);
    expect(clearLdkCache).toHaveBeenCalled();
    expect(restoreLdkCache).not.toHaveBeenCalled();
    expect(fetchCalls.some((c) => c.opts.method === 'DELETE')).toBe(false);
  });

  it('maps a 409 finish to the kit-required error (server refused to commit)', async () => {
    enablePoc();
    installFetch({ finishOk: false, finishStatus: 409 });
    readLdkRecord.mockResolvedValueOnce(null).mockResolvedValue({ accountId: ACCOUNT });
    unwrapWithLdk.mockResolvedValue(DEK);
    const pending = enrollWithToken(app, { enrollmentToken: 'tok', accountId: ACCOUNT, dek: DEK });
    await driveConsentToConfirm();
    await expect(pending).resolves.toBe(false);
    expect(clearLdkCache).toHaveBeenCalled();
    expect(fetchCalls.some((c) => c.opts.method === 'DELETE')).toBe(false);
    expect(app.querySelector('.wizard-error').textContent).toContain('Emergency Kit');
  });

  it('restores the pre-existing cache when enrollment fails over it', async () => {
    enablePoc();
    installFetch({ finishOk: false, finishStatus: 500 });
    const prior = { accountId: 'other-acct', ldk: 'prior-key' };
    readLdkRecord.mockResolvedValueOnce(prior).mockResolvedValue({ accountId: ACCOUNT });
    unwrapWithLdk.mockResolvedValue(DEK);
    const pending = enrollWithToken(app, { enrollmentToken: 'tok', accountId: ACCOUNT, dek: DEK });
    await driveConsentToConfirm();
    await expect(pending).resolves.toBe(false);
    // A browser that already held a warm cache (e.g. re-running recovery)
    // keeps it — the failed enrollment must not cost warm unlock.
    expect(restoreLdkCache).toHaveBeenCalledWith(prior);
    expect(clearLdkCache).not.toHaveBeenCalled();
  });

  it('rolls the credential back when no recovery material is on file', async () => {
    enablePoc();
    installFetch({ envelopes: [{ credential_ref: 'aGVsbG8' }] });
    readLdkRecord.mockResolvedValueOnce(null).mockResolvedValue({ accountId: ACCOUNT });
    unwrapWithLdk.mockResolvedValue(DEK);
    const pending = enrollWithToken(app, { enrollmentToken: 'tok', accountId: ACCOUNT, dek: DEK });
    await driveConsentToConfirm();
    await expect(pending).resolves.toBe(false);
    expect(fetchCalls.some((c) => c.opts.method === 'DELETE')).toBe(true);
    // ...and the staged cache goes with it, so no warm redirect implies an
    // enrollment that never happened.
    expect(clearLdkCache).toHaveBeenCalled();
    expect(app.querySelector('.wizard-error').textContent).toContain('Emergency Kit');
  });
});
