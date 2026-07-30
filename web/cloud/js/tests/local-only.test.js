// bd med-eas.2.1 — the local-only-passkey POC. These pin the properties that
// make the mode defensible rather than merely functional:
//   - it does not exist unless the operator turned it on;
//   - the user is told, before committing, that this passkey cannot recover
//     their data;
//   - nothing is registered until the encryption key is proven readable back
//     from this browser AND the Emergency Kit has actually been produced;
//   - the register/finish request carries recovery material and no envelope,
//     and never carries the recovery code itself;
//   - a cold open on a browser without the key says so honestly instead of
//     looping the user through "unlock with passkey".
//
// The cloud shell has no integration entry point, so this follows the pure-unit
// convention of cloud-boot.test.js / signup.emergency-kit.test.js (repo rule 8's
// documented exception).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { Blob as NodeBlob } from 'node:buffer';

import {
  LOCAL_ONLY,
  LocalOnlyPasskeyError,
  appendLocalOnlyOffer,
  localOnlyPocEnabled,
  proveLocalKeyStorage,
  renderLocalOnlyColdOpen,
  renderLocalOnlyWarning,
} from '../local-only.js';

// A fake LDK cache that really round-trips, so proveLocalKeyStorage is exercised
// rather than stubbed out.
const ldk = vi.hoisted(() => ({ record: null, dropWrites: false }));

vi.mock('../unlock.js', () => ({
  establishLdkCache: vi.fn(async (dek, accountId) => {
    if (!ldk.dropWrites) ldk.record = { dek: Uint8Array.from(dek), accountId };
  }),
  readLdkRecord: vi.fn(async () => ldk.record),
  unwrapWithLdk: vi.fn(async (record) => record.dek),
}));
vi.mock('../telegram.js', () => ({ mountTelegram: async (_app, { onDone }) => onDone() }));

let dom;
let requests;

beforeEach(() => {
  dom = new JSDOM('<div id="app"></div>');
  globalThis.document = dom.window.document;
  globalThis.location = { origin: 'https://acct.example', href: '' };
  globalThis.Blob = NodeBlob;
  ldk.record = null;
  ldk.dropWrites = false;
  requests = [];

  globalThis.fetch = vi.fn(async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200, json: async () => ({}) };
  });

  globalThis.URL.createObjectURL = vi.fn(() => 'blob:https://acct.example/1');
  globalThis.URL.revokeObjectURL = vi.fn();
  vi.spyOn(dom.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.document;
  delete globalThis.fetch;
  delete globalThis.location;
  delete globalThis.Blob;
});

const app = () => dom.window.document.getElementById('app');
const finishRequests = () =>
  requests.filter((r) => r.url === '/api/webauthn/register/finish');

// A credential stand-in: the ceremony only ever calls toJSON() on it.
function fakeCredential() {
  return {
    toJSON: () => ({ id: 'cred-1', response: {}, clientExtensionResults: { prf: { enabled: true } } }),
  };
}

describe('local-only passkey POC (bd med-eas.2.1)', () => {
  describe('operator flag', () => {
    it('is enabled only when /api/version says so explicitly', async () => {
      const probe = (body) => localOnlyPocEnabled(async () => ({ ok: true, json: async () => body }));
      await expect(probe({ local_only_passkey_poc: true })).resolves.toBe(true);
      await expect(probe({ build_id: 'dev' })).resolves.toBe(false);
      await expect(probe({ local_only_passkey_poc: 'true' })).resolves.toBe(false);
      await expect(probe({ local_only_passkey_poc: false })).resolves.toBe(false);
    });

    it('fails closed when the probe errors or 404s', async () => {
      await expect(localOnlyPocEnabled(async () => ({ ok: false, status: 404 }))).resolves.toBe(false);
      await expect(localOnlyPocEnabled(async () => { throw new Error('offline'); })).resolves.toBe(false);
    });
  });

  describe('informed consent', () => {
    it('offers only a door to the warning, never a one-click downgrade', () => {
      app().innerHTML = '<section></section>';
      appendLocalOnlyOffer(app(), { accountId: 'a', credential: fakeCredential() });
      const button = app().querySelector('#local-only-offer');
      expect(button).toBeTruthy();
      // Opening the door must not start any ceremony of its own.
      button.click();
      expect(finishRequests()).toHaveLength(0);
    });

    it('states the recovery limitation up front, before anything is committed', () => {
      renderLocalOnlyWarning(app(), { accountId: 'a', credential: fakeCredential() });
      const text = app().textContent;
      expect(text).toMatch(/cannot unlock your data/i);
      expect(text).toMatch(/only in this browser/i);
      expect(text).toMatch(/Emergency Kit/);
      expect(text).toMatch(/will not unlock your data there/i);
    });

    it('keeps the commit button disabled until the user acknowledges', () => {
      renderLocalOnlyWarning(app(), { accountId: 'a', credential: fakeCredential() });
      const button = app().querySelector('#local-only-continue');
      const checkbox = app().querySelector('#local-only-ack');
      expect(button.disabled).toBe(true);
      checkbox.checked = true;
      checkbox.dispatchEvent(new dom.window.Event('change'));
      expect(button.disabled).toBe(false);
    });
  });

  describe('local key storage proof', () => {
    it('accepts a cache that reads back byte-identically', async () => {
      const dek = new Uint8Array(32).fill(9);
      await expect(proveLocalKeyStorage(dek, 'acct-1')).resolves.toBeUndefined();
      expect(ldk.record.accountId).toBe('acct-1');
    });

    it('refuses when the browser silently drops the write', async () => {
      ldk.dropWrites = true;
      await expect(proveLocalKeyStorage(new Uint8Array(32), 'acct-1')).rejects.toThrow(/did not keep/i);
    });

    it('refuses when the cache reads back different bytes', async () => {
      ldk.dropWrites = true;
      ldk.record = { dek: new Uint8Array(32).fill(1), accountId: 'acct-1' };
      await expect(proveLocalKeyStorage(new Uint8Array(32).fill(2), 'acct-1')).rejects.toThrow(/incorrectly/i);
    });
  });

  describe('enrollment ordering', () => {
    // Drives the real screens: warning -> ack -> continue -> Emergency Kit ->
    // download -> finish. Returns once the flow has settled.
    async function runEnrollment() {
      renderLocalOnlyWarning(app(), { accountId: 'acct-1', credential: fakeCredential() });
      const checkbox = app().querySelector('#local-only-ack');
      checkbox.checked = true;
      checkbox.dispatchEvent(new dom.window.Event('change'));
      app().querySelector('#local-only-continue').click();
      await vi.waitFor(() => expect(app().querySelector('#kit-continue')).toBeTruthy());
    }

    it('registers nothing until the Emergency Kit is produced and confirmed', async () => {
      await runEnrollment();

      // The kit screen is up and the key is already cached locally, but the
      // account does not exist yet — the claim is still spendable.
      expect(finishRequests()).toHaveLength(0);
      expect(app().querySelector('#kit-continue').disabled).toBe(true);

      app().querySelector('#kit-download').click();
      expect(app().querySelector('#kit-continue').disabled).toBe(false);
      expect(finishRequests()).toHaveLength(0);

      app().querySelector('#kit-continue').click();
      await vi.waitFor(() => expect(finishRequests()).toHaveLength(1));
    });

    it('sends key_mode + recovery material, no envelope, and never the code itself', async () => {
      await runEnrollment();
      const code = app().querySelector('.recovery-code').textContent;
      expect(code).toMatch(/^[0-9A-Z-]+$/);

      app().querySelector('#kit-download').click();
      app().querySelector('#kit-continue').click();
      await vi.waitFor(() => expect(finishRequests()).toHaveLength(1));

      const raw = finishRequests()[0].init.body;
      const body = JSON.parse(raw);
      expect(body.key_mode).toBe(LOCAL_ONLY);
      expect(body.recovery.envelope.ct).toBeTruthy();
      expect(body.recovery.verifier).toBeTruthy();
      // A local-only credential has no KEK, so there is nothing to wrap the DEK
      // with — an envelope here could only be junk.
      expect(body.envelope).toBeUndefined();
      // The PRF field is stripped on this path too, and the recovery code stays
      // in the browser: only material derived from it goes up.
      expect(body.credential.clientExtensionResults.prf).toBeUndefined();
      expect(raw).not.toContain(code);
      expect(raw).not.toContain(code.replace(/-/g, ''));
    });

    it('leaves the invite spendable when the finish call fails', async () => {
      await runEnrollment();
      globalThis.fetch = vi.fn(async (url, init) => {
        requests.push({ url, init });
        return { ok: false, status: 500, json: async () => ({}) };
      });

      app().querySelector('#kit-download').click();
      app().querySelector('#kit-continue').click();
      await vi.waitFor(() => expect(app().textContent).toMatch(/has not been used/i));
      expect(globalThis.location.href).toBe('');
    });
  });

  describe('cold open on a browser without the key', () => {
    it('is a distinct error type, so unlock does not loop the user', () => {
      expect(new LocalOnlyPasskeyError().name).toBe('LocalOnlyPasskeyError');
    });

    it('names the two paths that actually work', () => {
      renderLocalOnlyColdOpen(app());
      const text = app().textContent;
      expect(text).toMatch(/cannot recover it/i);
      expect(text).toMatch(/Emergency Kit/);
      expect(text).toMatch(/still unlocked/i);
      expect(app().querySelector('a[href="/recover"]')).toBeTruthy();
    });
  });
});
