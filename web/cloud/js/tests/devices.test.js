// Device list + revocation. med-lyv split the Claude/MCP connector picker out
// into connectors.js (see connectors.test.js) and moved Telegram to Settings →
// Integrations, so this page now answers exactly one question: which passkeys
// can open this vault. The "renders neither" case below pins that split — it is
// the assertion that fails if the connector UI creeps back onto this screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../crypto.js', () => ({
  auditEnvelope: vi.fn(async () => true),
  fromBase64: vi.fn((x) => x),
  fromBase64Url: vi.fn((x) => x),
}));

import { renderDeviceList } from '../devices.js';

let dom;
let app;
let onExit;
const ctx = { dek: 'fake-dek' };

const DEVICES = [
  { credential_id: 'aaaabbbbcccc', created_at: '2026-07-01T10:00:00Z', envelope: { nonce: 'n', ct: 'c', mac: 'm' } },
  { credential_id: 'ddddeeeeffff', created_at: '2026-07-02T10:00:00Z', envelope: null },
];

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://acct.example.test/' });
  global.document = dom.window.document;
  vi.stubGlobal('navigator', dom.window.navigator);
  global.confirm = vi.fn(() => true);
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => DEVICES }));
  app = dom.window.document.getElementById('app');
  onExit = vi.fn();
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
  delete global.document;
  delete global.confirm;
  delete global.fetch;
});

async function renderAndSettle() {
  renderDeviceList(app, ctx, onExit);
  await vi.waitFor(() => {
    if (!app.querySelector('#add-device-button')) throw new Error('not rendered yet');
  });
}

describe('devices.js device list', () => {
  it('renders one row per device with its audit badge', async () => {
    await renderAndSettle();

    const rows = app.querySelectorAll('#device-list .device-row');
    expect(rows).toHaveLength(2);
    // auditEnvelope is mocked true; the envelope-less device stays unverified.
    expect(rows[0].querySelector('.device-verified')).not.toBeNull();
    expect(rows[1].querySelector('.device-unverified')).not.toBeNull();
  });

  // The point of med-lyv: devices and connectors are separate pages now.
  it('renders neither the connector picker nor the Telegram mount', async () => {
    await renderAndSettle();

    expect(app.querySelector('#claude-remote-connect-button')).toBeNull();
    expect(app.querySelector('#claude-local-connect-button')).toBeNull();
    expect(app.querySelector('#claude-disconnect-button')).toBeNull();
    expect(app.querySelector('#claude-status')).toBeNull();
    expect(app.querySelector('#telegram-mount')).toBeNull();
  });

  it('revokes a device and re-renders the list', async () => {
    await renderAndSettle();

    global.fetch.mockClear();
    app.querySelectorAll('#device-list .device-row button')[0]
      .dispatchEvent(new dom.window.Event('click'));

    await vi.waitFor(() => {
      if (global.fetch.mock.calls.length === 0) throw new Error('not called yet');
    });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/devices/aaaabbbbcccc');
    expect(opts.method).toBe('DELETE');
  });

  it('Back exits the page', async () => {
    await renderAndSettle();

    app.querySelector('#devices-back').dispatchEvent(new dom.window.Event('click'));
    expect(onExit).toHaveBeenCalled();
  });
});
