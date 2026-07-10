// bd med-d5t.8 — client half of self-service account deletion. The security
// property (a stolen session alone cannot delete) is enforced server-side and
// tested in internal/cloudserver/account_test.go; these cover the browser flow:
// the re-auth ceremony is actually driven, the export-first safety copy works,
// and the local mirror is cleared afterwards.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reauthAndDelete, exportVaultToFile, baseDomainURL, clearLocalVault, DELETE_CONFIRM_PHRASE } from '../account-delete.js';

let fetchCalls;

// Node exposes globalThis.navigator as a read-only accessor, so a plain
// assignment throws.
function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

beforeEach(() => {
  fetchCalls = [];
  globalThis.window = globalThis;
  globalThis.PublicKeyCredential = {
    parseRequestOptionsFromJSON: (pk) => ({ ...pk, _parsed: true }),
  };
  setNavigator({
    credentials: {
      get: vi.fn(async () => ({ toJSON: () => ({ id: 'assertion-id', response: {} }) })),
    },
  });
});

afterEach(() => {
  delete globalThis.PublicKeyCredential;
  delete globalThis.navigator;
  delete globalThis.fetch;
  delete globalThis.window;
  vi.restoreAllMocks();
});

function stubFetch({ beginOk = true, deleteStatus = 204 } = {}) {
  globalThis.fetch = vi.fn(async (url, init) => {
    fetchCalls.push({ url, method: (init && init.method) || 'GET', body: init && init.body });
    if (url === '/api/account/reauth') {
      return { ok: beginOk, status: beginOk ? 200 : 500, json: async () => ({ publicKey: { challenge: 'x' } }) };
    }
    if (url === '/api/account') {
      return { ok: deleteStatus === 204, status: deleteStatus };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe('reauthAndDelete (med-d5t.8)', () => {
  it('runs the re-auth ceremony then DELETEs, sending the assertion', async () => {
    stubFetch();

    await reauthAndDelete();

    expect(fetchCalls[0]).toMatchObject({ url: '/api/account/reauth', method: 'POST' });
    expect(navigator.credentials.get).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: expect.objectContaining({ userVerification: 'required' }) }),
    );
    const del = fetchCalls.find((c) => c.url === '/api/account');
    expect(del.method).toBe('DELETE');
    expect(JSON.parse(del.body)).toMatchObject({ id: 'assertion-id' });
  });

  it('never DELETEs when the passkey prompt is cancelled', async () => {
    stubFetch();
    navigator.credentials.get = vi.fn(async () => { throw new Error('NotAllowedError'); });

    await expect(reauthAndDelete()).rejects.toThrow(/cancelled/i);
    expect(fetchCalls.some((c) => c.url === '/api/account')).toBe(false);
  });

  it('surfaces a 403 (assertion rejected) as a retryable message', async () => {
    stubFetch({ deleteStatus: 403 });
    await expect(reauthAndDelete()).rejects.toThrow(/did not verify/i);
  });

  it('does not attempt the assertion if the challenge cannot be started', async () => {
    stubFetch({ beginOk: false });
    await expect(reauthAndDelete()).rejects.toThrow(/could not start/i);
    expect(navigator.credentials.get).not.toHaveBeenCalled();
  });
});

describe('exportVaultToFile', () => {
  it('downloads the vault JSON before any delete', async () => {
    const clicks = [];
    globalThis.document = {
      createElement: () => ({ click() { clicks.push(this.download); }, remove() {}, set href(v) { this._href = v; }, get href() { return this._href; } }),
      body: { appendChild() {} },
    };
    globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
    const blobs = [];
    globalThis.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
    window.CloudVault = { exportAll: vi.fn(async () => '{"meds":[]}') };

    await exportVaultToFile(Date.parse('2026-07-10T00:00:00Z'));

    expect(window.CloudVault.exportAll).toHaveBeenCalledWith({ includeSecrets: true });
    expect(clicks[0]).toBe('medtracker-vault-2026-07-10.json');
    expect(blobs[0]).toBe('{"meds":[]}');

    delete globalThis.document;
    delete globalThis.URL;
    delete globalThis.Blob;
    delete window.CloudVault;
  });

  it('refuses to claim an export when the vault is not ready', async () => {
    window.CloudVault = undefined;
    await expect(exportVaultToFile()).rejects.toThrow(/unlock/i);
  });
});

describe('baseDomainURL', () => {
  it('drops the account subdomain so the target still exists post-delete', () => {
    expect(baseDomainURL({ protocol: 'https:', hostname: 'amber-falcon.app.example.com', port: '' }))
      .toBe('https://app.example.com/');
  });
  it('handles a bare host (local dev *.localhost)', () => {
    expect(baseDomainURL({ protocol: 'http:', hostname: 'acct.localhost', port: '8080' }))
      .toBe('http://localhost:8080/');
  });
});

describe('clearLocalVault', () => {
  it('deletes the local mirror and caches, swallowing failures', async () => {
    const deleted = [];
    globalThis.indexedDB = { deleteDatabase: (n) => deleted.push(n) };
    globalThis.caches = { keys: async () => ['c1', 'c2'], delete: vi.fn(async () => true) };

    await clearLocalVault();

    expect(deleted).toContain('medtracker-cloud');
    expect(globalThis.caches.delete).toHaveBeenCalledTimes(2);

    delete globalThis.indexedDB;
    delete globalThis.caches;
  });
});

describe('DELETE_CONFIRM_PHRASE', () => {
  it('is a fixed intent phrase', () => {
    expect(DELETE_CONFIRM_PHRASE).toBe('delete my account');
  });
});
