// Local-only device-list rendering (med-eas.2.1 POC): the explicit mode
// label drives the badge — local_only skips the envelope audit (no envelope
// is expected) instead of rendering "unverified".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../crypto.js', () => ({
  auditEnvelope: vi.fn(async () => true),
  fromBase64: vi.fn((x) => x),
  fromBase64Url: vi.fn((x) => x),
}));

import { auditEnvelope } from '../crypto.js';
import { renderDeviceList } from '../devices.js';

let dom;
let app;
const ctx = { dek: 'fake-dek' };

const DEVICES = [
  { credential_id: 'aaaabbbb', created_at: '2026-07-01T10:00:00Z', mode: 'prf', envelope: { nonce: 'n', ct: 'c', mac: 'm' } },
  { credential_id: 'ccccdddd', created_at: '2026-07-02T10:00:00Z', mode: 'local_only', envelope: null },
  { credential_id: 'eeeeffff', created_at: '2026-07-03T10:00:00Z', envelope: null },
];

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://acct.example.test/' });
  global.document = dom.window.document;
  vi.stubGlobal('navigator', dom.window.navigator);
  global.confirm = vi.fn(() => false);
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => DEVICES }));
  app = dom.window.document.getElementById('app');
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
  delete global.document;
  delete global.confirm;
  delete global.fetch;
});

async function renderAndSettle() {
  renderDeviceList(app, ctx, vi.fn());
  await vi.waitFor(() => {
    if (!app.querySelector('#add-device-button')) throw new Error('not rendered yet');
  });
}

describe('local-only device list (devices.js)', () => {
  it('badges local_only distinctly and skips its envelope audit', async () => {
    await renderAndSettle();
    const rows = app.querySelectorAll('#device-list .device-row');
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelector('.device-verified')).not.toBeNull();
    const localBadge = rows[1].querySelector('.device-local-only');
    expect(localBadge).not.toBeNull();
    expect(localBadge.textContent).toContain('this browser only');
    // A PRF credential without an envelope is still an audit failure — the
    // mode is explicit, never inferred from the missing envelope.
    expect(rows[2].querySelector('.device-unverified')).not.toBeNull();
    expect(auditEnvelope).toHaveBeenCalledTimes(1);
  });

  it('explains local-only removal differently from revocation', async () => {
    await renderAndSettle();
    const rows = app.querySelectorAll('#device-list .device-row');
    const buttons = [...app.querySelectorAll('#device-list .device-row button')];
    buttons[1].click();
    expect(global.confirm).toHaveBeenCalledTimes(1);
    expect(global.confirm.mock.calls[0][0]).toContain('local-only');
    expect(global.confirm.mock.calls[0][0]).toContain('lost or stolen');
    expect(rows[1].querySelector('.device-local-only')).not.toBeNull();
    buttons[0].click();
    expect(global.confirm.mock.calls[1][0]).toContain('Revoke this device');
  });
});
