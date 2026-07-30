// bd med-eas.2.1 — the cold-unlock half of the local-only-passkey POC.
//
// The load-bearing invariant here is the NO-REGRESSION one: with the POC flag
// off (every deployment today), an assertion that returns no PRF output is
// rejected exactly as before and is never sent to the server. Only when the
// operator has turned the POC on does unlock spend a round trip asking the
// server which kind of credential just asserted — because "no PRF output" then
// has a second, legitimate cause.
//
// Pure-unit per repo rule 8's documented exception: the cloud unlock shell has
// no integration entry point.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../localdb.js', () => ({ openDb: vi.fn(async () => { throw new Error('no idb'); }) }));

import { assertPasskey } from '../unlock.js';

let dom;
let calls;
let pocEnabled;
let keyMode;

// A minimal assertion whose PRF result is absent — the Bitwarden-interception
// shape the research doc documents, and equally the shape a deliberately
// local-only credential produces.
const assertionWithoutPrf = {
  rawId: new Uint8Array([1, 2, 3]).buffer,
  getClientExtensionResults: () => ({}),
  toJSON: () => ({ id: 'cred-1', clientExtensionResults: {} }),
};

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://acct.example.test/' });
  globalThis.document = dom.window.document;
  calls = [];
  pocEnabled = false;
  keyMode = 'prf';

  globalThis.PublicKeyCredential = { parseRequestOptionsFromJSON: (o) => o };
  vi.stubGlobal('navigator', { credentials: { get: vi.fn(async () => assertionWithoutPrf) } });
  vi.stubGlobal('crypto', { ...dom.window.crypto, subtle: globalThis.crypto.subtle, getRandomValues: (a) => a });

  globalThis.fetch = vi.fn(async (url) => {
    calls.push(url);
    if (url === '/api/webauthn/login/begin') {
      return { ok: true, json: async () => ({ publicKey: { challenge: 'c', allowCredentials: [] } }) };
    }
    if (url === '/api/version') {
      return { ok: true, json: async () => (pocEnabled ? { local_only_passkey_poc: true } : { build_id: 'dev' }) };
    }
    if (url === '/api/webauthn/login/finish') {
      return { ok: true, json: async () => ({ account_id: 'acct-1', key_mode: keyMode }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete globalThis.document;
  delete globalThis.fetch;
  delete globalThis.PublicKeyCredential;
});

describe('cold unlock with no PRF output', () => {
  it('with the POC off, rejects as before and never sends the assertion', async () => {
    await expect(assertPasskey()).rejects.toThrow(/doesn't support the security feature/i);
    expect(calls).not.toContain('/api/webauthn/login/finish');
  });

  it('with the POC on, still rejects a genuinely PRF-incapable authenticator', async () => {
    pocEnabled = true;
    keyMode = 'prf';
    await expect(assertPasskey()).rejects.toThrow(/doesn't support the security feature/i);
  });

  it('with the POC on, names a local-only credential for what it is', async () => {
    pocEnabled = true;
    keyMode = 'local_only';
    // A distinct error type, so unlock.js renders the "use your Emergency Kit"
    // screen instead of re-offering a passkey that can never work here.
    await expect(assertPasskey()).rejects.toMatchObject({ name: 'LocalOnlyPasskeyError' });
  });
});
