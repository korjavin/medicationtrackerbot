// Task 3: devices-page mode picker (remote connector primary, local shim
// alternative). devices.js drives the real DOM directly (no framework), so
// these tests run it against a real jsdom document with the pairing/remote
// modules mocked — the interesting behavior here is the mode-picker wiring,
// not mcp-pairing.js's/mcp-remote.js's own fetch calls (covered separately).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../mcp-pairing.js', () => ({
  getPairing: vi.fn(),
  connectClaude: vi.fn(),
  disconnectClaude: vi.fn(),
}));
vi.mock('../mcp-remote.js', () => ({
  getRemoteStatus: vi.fn(),
  connectRemote: vi.fn(),
  disconnectRemote: vi.fn(),
}));
vi.mock('../crypto.js', () => ({
  auditEnvelope: vi.fn(async () => true),
  fromBase64: vi.fn((x) => x),
  fromBase64Url: vi.fn((x) => x),
}));

import { renderDeviceList } from '../devices.js';
import { getPairing, connectClaude, disconnectClaude } from '../mcp-pairing.js';
import { getRemoteStatus, connectRemote, disconnectRemote } from '../mcp-remote.js';

let dom;
let app;
let onExit;
const ctx = { dek: 'fake-dek' };

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://acct.example.test/' });
  global.document = dom.window.document;
  vi.stubGlobal('navigator', dom.window.navigator);
  global.confirm = vi.fn(() => true);
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => [] }));
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
    if (!app.querySelector('#claude-remote-connect-button')) throw new Error('not rendered yet');
  });
}

describe('devices.js Claude connector mode picker', () => {
  it('gates remote enable on consent: declining the confirm dialog never calls connectRemote', async () => {
    getPairing.mockResolvedValue(null);
    getRemoteStatus.mockResolvedValue(false);
    global.confirm.mockReturnValue(false);
    await renderAndSettle();

    app.querySelector('#claude-remote-connect-button').dispatchEvent(new dom.window.Event('click'));
    await Promise.resolve();

    expect(connectRemote).not.toHaveBeenCalled();
  });

  // Nothing connected: both connectors are on offer, neither is hidden (med-3mx).
  it('offers both connectors when no pairing is active', async () => {
    getPairing.mockResolvedValue(null);
    getRemoteStatus.mockResolvedValue(false);
    await renderAndSettle();

    expect(app.querySelector('#claude-remote-connect-button').hidden).toBe(false);
    expect(app.querySelector('#claude-local-connect-button').hidden).toBe(false);
    expect(app.querySelector('#claude-disconnect-button').hidden).toBe(true);
  });

  it('renders the connector URL once consent is given and enable succeeds', async () => {
    getPairing.mockResolvedValue(null);
    getRemoteStatus.mockResolvedValue(false);
    connectRemote.mockResolvedValue({ token: 'abc-def', url: 'https://acct.example.test/mcp/abc-def' });
    await renderAndSettle();

    app.querySelector('#claude-remote-connect-button').dispatchEvent(new dom.window.Event('click'));
    await vi.waitFor(() => {
      if (!app.querySelector('#claude-remote-url')) throw new Error('not rendered yet');
    });

    expect(app.querySelector('#claude-remote-url').textContent).toBe('https://acct.example.test/mcp/abc-def');
  });

  it('shows the remote-linked status and disconnects the old pairing before switching to local', async () => {
    getPairing.mockResolvedValue({ recordId: 'mcppairing' });
    getRemoteStatus.mockResolvedValue(true);
    disconnectRemote.mockResolvedValue();
    connectClaude.mockResolvedValue({ code: 'mtmcp1.fake' });
    await renderAndSettle();

    expect(app.querySelector('#claude-status').textContent).toContain('remote (claude.ai / ChatGPT) linked');
    // Remote is already on: don't offer to enable it (med-3mx). The local
    // button stays visible — it is the switch control.
    expect(app.querySelector('#claude-remote-connect-button').hidden).toBe(true);
    expect(app.querySelector('#claude-local-connect-button').hidden).toBe(false);

    app.querySelector('#claude-local-connect-button').dispatchEvent(new dom.window.Event('click'));
    await vi.waitFor(() => {
      if (!app.querySelector('#claude-code')) throw new Error('not rendered yet');
    });

    expect(disconnectRemote).toHaveBeenCalledWith(ctx);
    expect(connectClaude).toHaveBeenCalledWith(ctx);
    expect(app.querySelector('#claude-code').textContent).toBe('mtmcp1.fake');
  });

  it('disconnect calls disconnectRemote when the remote mode is active', async () => {
    getPairing.mockResolvedValue({ recordId: 'mcppairing' });
    getRemoteStatus.mockResolvedValue(true);
    disconnectRemote.mockResolvedValue();
    await renderAndSettle();

    app.querySelector('#claude-disconnect-button').dispatchEvent(new dom.window.Event('click'));
    await vi.waitFor(() => {
      if (disconnectRemote.mock.calls.length === 0) throw new Error('not called yet');
    });

    expect(disconnectRemote).toHaveBeenCalledWith(ctx);
    expect(disconnectClaude).not.toHaveBeenCalled();
  });

  it('disconnect calls disconnectClaude when the local mode is active', async () => {
    getPairing.mockResolvedValue({ recordId: 'mcppairing' });
    getRemoteStatus.mockResolvedValue(false);
    disconnectClaude.mockResolvedValue();
    await renderAndSettle();

    expect(app.querySelector('#claude-status').textContent).toContain('local shim (Claude Code) linked');
    // Mirror of the remote case: local is on, so hide its connect button and
    // keep the remote one as the switch control (med-3mx).
    expect(app.querySelector('#claude-local-connect-button').hidden).toBe(true);
    expect(app.querySelector('#claude-remote-connect-button').hidden).toBe(false);

    app.querySelector('#claude-disconnect-button').dispatchEvent(new dom.window.Event('click'));
    await vi.waitFor(() => {
      if (disconnectClaude.mock.calls.length === 0) throw new Error('not called yet');
    });

    expect(disconnectClaude).toHaveBeenCalledWith(ctx);
    expect(disconnectRemote).not.toHaveBeenCalled();
  });
});
