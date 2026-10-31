// Claude connector page (kit screens-connect-ai.html CC1–CC4, med-73xx): one
// way in onto the remote connector, per-app instructions from the same URL,
// and the packaged Private helper. Split out of the devices page by med-lyv.
// connectors.js drives the real DOM directly (no framework), so these tests run
// it against a real jsdom document with the pairing/remote modules mocked — the
// interesting behavior here is the page wiring, not mcp-pairing.js's /
// mcp-remote.js's own fetch calls (covered separately).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

vi.mock('../mcp-pairing.js', () => ({
  getPairing: vi.fn(),
  connectClaude: vi.fn(),
  disconnectClaude: vi.fn(),
  pairingNeedsReconnect: vi.fn(),
}));
vi.mock('../mcp-remote.js', () => ({
  getRemoteStatus: vi.fn(),
  connectRemote: vi.fn(),
  disconnectRemote: vi.fn(),
}));
vi.mock('../sync.js', () => ({ recordsPort: vi.fn() }));
vi.mock('../mcp-responder.js', () => ({ refreshResponder: vi.fn(), stopResponder: vi.fn(), clearNonceRing: vi.fn() }));
import { renderConnectors } from '../connectors.js';
import { installDialogs, answerDialog } from './helpers/dialogs.js';
import { getPairing, connectClaude, disconnectClaude, pairingNeedsReconnect } from '../mcp-pairing.js';
import { getRemoteStatus, connectRemote, disconnectRemote } from '../mcp-remote.js';
import { recordsPort } from '../sync.js';

let dom;
let app;
const ctx = { dek: 'fake-dek' };
const REMOTE_URL = 'https://acct.example.test/mcp/abc-def';
const COMMAND = `claude mcp add --transport http --scope user health ${REMOTE_URL}`;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://acct.example.test/', runScripts: 'outside-only' });
  global.document = dom.window.document;
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('window', dom.window);
  installDialogs(dom.window);
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => [] }));
  app = dom.window.document.getElementById('app');
  vi.clearAllMocks();
  pairingNeedsReconnect.mockReturnValue(false);
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
  delete global.document;
  delete global.fetch;
});

async function renderAndSettle() {
  renderConnectors(app, ctx);
  await vi.waitFor(() => {
    if (!app.querySelector('#claude-status')) throw new Error('not rendered yet');
  });
}

function stubClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

async function connectThroughConsent() {
  getPairing.mockResolvedValue(null);
  getRemoteStatus.mockResolvedValue({ enabled: false, url: '' });
  connectRemote.mockResolvedValue({ token: 'abc-def', url: REMOTE_URL });
  await renderAndSettle();
  app.querySelector('#claude-remote-connect-button').click();
  const dialog = await answerDialog(dom.window.document, true);
  await vi.waitFor(() => {
    if (!app.querySelector('#claude-code-prompt')) throw new Error('not rendered yet');
  });
  return dialog;
}

describe('connectors.js Claude connector page', () => {
  it('loads a mount staged immediately before the Settings page push', async () => {
    getPairing.mockResolvedValue(null);
    getRemoteStatus.mockResolvedValue({ enabled: false });
    const body = dom.window.document.createElement('div');
    renderConnectors(body, ctx);
    app.appendChild(body);
    await vi.waitFor(() => expect(body.querySelector('#claude-status')?.textContent).toBe('Not connected'));
  });

  it.each(['pairing', 'remote', 'error', 'teardown'])('does not continue a pending %s read after provider reload commits or the mount leaves', async (stage) => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    getPairing.mockImplementation(() => stage === 'pairing' ? pending : Promise.resolve(null));
    getRemoteStatus.mockImplementation(() => pending);
    renderConnectors(app, ctx);
    await vi.waitFor(() => expect(stage === 'pairing' ? getPairing : getRemoteStatus).toHaveBeenCalled());
    const before = app.innerHTML;
    if (stage === 'teardown') app.remove();
    else dom.window.document.documentElement.setAttribute('data-provider-reload-committed', '');
    release(stage === 'pairing' ? null : stage === 'error' ? Promise.reject(new Error('unavailable')) : { enabled: true, url: REMOTE_URL });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.innerHTML).toBe(before);
    if (stage === 'pairing') expect(getRemoteStatus).not.toHaveBeenCalled();
    expect(app.querySelector('#connectors-retry')).toBeNull();
  });

  // CC1: one way in, the build-from-source shim is no longer offered.
  it('keeps remote as the sole primary and offers Private second without mutating a pairing', async () => {
    getPairing.mockResolvedValue(null);
    getRemoteStatus.mockResolvedValue({ enabled: false, url: '' });
    await renderAndSettle();

    const connect = app.querySelector('#claude-remote-connect-button');
    expect(connect.textContent).toBe('Connect an AI app');
    expect(connect.classList.contains('wg-btn--primary')).toBe(true);
    expect(app.querySelectorAll('.wg-btn--primary')).toHaveLength(1);
    expect(app.querySelector('#claude-status').textContent).toBe('Not connected');
    expect(app.textContent).toContain('One AI app per account.');
    expect(app.querySelector('#claude-local-connect-button')).toBeNull();
    expect(app.querySelector('#claude-private-button').classList.contains('wg-btn--primary')).toBe(false);
    expect(connectClaude).not.toHaveBeenCalled();
    // Inactive controls are not rendered at all: kit .wg-btn/.wg-vstack set
    // display, which beats a [hidden] attribute in the body-level page.
    expect(app.querySelector('#claude-disconnect-button')).toBeNull();
    expect(app.querySelector('[hidden]')).toBeNull();
    expect(app.textContent).not.toMatch(/go build|mcpshim/);
  });

  it('gates the connect on consent: declining the dialog never calls connectRemote', async () => {
    getPairing.mockResolvedValue(null);
    getRemoteStatus.mockResolvedValue({ enabled: false, url: '' });
    await renderAndSettle();

    app.querySelector('#claude-remote-connect-button').click();
    const dialog = await answerDialog(dom.window.document, false);
    expect(dialog.querySelector('.wg-dialog__title').textContent).toBe('Connect an AI app?');
    await Promise.resolve();

    expect(connectRemote).not.toHaveBeenCalled();
  });

  // CC3: the Claude Code prompt is the one primary; terminal fallback, the
  // key warning and the keep-open line sit below; Done is secondary.
  it('after consent shows the Claude Code prompt with the exact command, the fallback and the warnings', async () => {
    const dialog = await connectThroughConsent();
    expect(dialog.querySelector('.wg-dialog__body').textContent).toMatch(/stores none of them/);
    expect(dialog.querySelector('.wg-dialog__body').textContent).toMatch(/until you Disconnect/);
    const writeText = stubClipboard();

    expect(app.querySelector('#claude-code-prompt').textContent).toBe(
      `Add my health records to Claude Code: run ${COMMAND} then tell me to restart Claude Code.`,
    );
    expect(app.querySelector('#claude-code-command').textContent).toBe(COMMAND);
    expect(app.textContent).toContain('Or run this in a terminal');
    expect(app.querySelector('#claude-key-warning').textContent).toContain('This link opens your records to whoever has it');
    expect(app.textContent).toContain('Keep this app open and unlocked on one device while Claude works.');
    expect(app.textContent).not.toMatch(/go build|mcpshim/);

    const copyPrompt = app.querySelector('#claude-code-copy-prompt');
    expect([...app.querySelectorAll('.wg-btn--primary')]).toEqual([copyPrompt]);
    expect(app.querySelector('#claude-remote-done').classList.contains('wg-btn--primary')).toBe(false);
    copyPrompt.click();
    expect(writeText).toHaveBeenLastCalledWith(app.querySelector('#claude-code-prompt').textContent);
    app.querySelector('#claude-code-copy-command').click();
    expect(writeText).toHaveBeenLastCalledWith(COMMAND);
  });

  // Argus, med-73xx: styles.css loads before components.css (index.html), so a
  // (0,1,0)/(0,1,1) wrap modifier ties with .wg-code / .wg-code>span and loses
  // on source order, clipping the prompt to one ellipsized line. jsdom computes
  // no cascade (see health.notes.test.js), so pin the load order and the
  // doubled-class selectors that outweigh components.css on their own.
  it('the prompt field wraps: its modifier outweighs components.css .wg-code', async () => {
    const read = (f) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    const html = read('web/static/index.html');
    expect(html.indexOf('/static/css/styles.css')).toBeLessThan(html.indexOf('/static/css/components.css'));
    const styles = read('web/static/css/styles.css');
    expect(styles).toMatch(/\.wg-code\.wg-code--wrap \{[^}]*height: auto;/);
    expect(styles).toMatch(/\.wg-code\.wg-code--wrap > span \{[^}]*white-space: normal;[^}]*text-overflow: clip;/);

    await connectThroughConsent();
    expect(app.querySelector('#claude-code-prompt').parentElement.classList.contains('wg-code--wrap')).toBe(true);
  });

  it('switches to the Claude app and ChatGPT instructions for the same URL', async () => {
    await connectThroughConsent();
    const seg = (label) => [...app.querySelectorAll('.wg-seg__opt')].find((b) => b.textContent === label);
    expect(seg('Claude Code').getAttribute('aria-pressed')).toBe('true');

    seg('Claude app').click();
    expect(seg('Claude app').getAttribute('aria-pressed')).toBe('true');
    expect(seg('Claude Code').getAttribute('aria-pressed')).toBe('false');
    expect(app.querySelector('#claude-code-prompt')).toBeNull();
    expect(app.querySelector('#claude-remote-url').textContent).toBe(REMOTE_URL);
    expect(app.textContent).toContain('Settings → Connectors → Add custom connector');

    seg('ChatGPT').click();
    expect(app.querySelector('#claude-remote-url').textContent).toBe(REMOTE_URL);
    expect(app.textContent).toContain('Settings → Connectors → Add MCP');
  });

  // CC4: coming back later — the instructions again, with no primary.
  it('while remote is linked re-shows the per-app instructions with no primary', async () => {
    getPairing.mockResolvedValue({ recordId: 'mcppairing' });
    getRemoteStatus.mockResolvedValue({ enabled: true, url: REMOTE_URL });
    await renderAndSettle();

    expect(app.querySelector('#claude-status').textContent).toBe('Connected');
    expect(app.querySelector('#claude-code-command').textContent).toBe(COMMAND);
    expect(app.querySelectorAll('.wg-btn--primary')).toHaveLength(0);
    // No connect offer at all (Argus, med-73xx): an empty Connect button left
    // in the DOM would re-mint and revoke the working URL.
    expect(app.querySelector('#claude-remote-connect-button')).toBeNull();
    expect(app.querySelector('[hidden]')).toBeNull();
    expect(app.querySelector('#claude-disconnect-button')).not.toBeNull();
    expect(app.textContent).toContain('Keep this app open and unlocked on one device while Claude works.');
  });

  it('copies the connector URL from its code field', async () => {
    getPairing.mockResolvedValue({ recordId: 'mcppairing' });
    getRemoteStatus.mockResolvedValue({ enabled: true, url: REMOTE_URL });
    const writeText = stubClipboard();
    await renderAndSettle();

    [...app.querySelectorAll('.wg-seg__opt')].find((b) => b.textContent === 'Claude app').click();
    const copy = app.querySelector('#claude-remote-copy');
    expect(copy.closest('.wg-code').querySelector('#claude-remote-url')).not.toBeNull();
    copy.click();
    expect(writeText).toHaveBeenCalledWith(REMOTE_URL);
  });

  it('disconnect calls disconnectRemote when the remote mode is active', async () => {
    getPairing.mockResolvedValue({ recordId: 'mcppairing' });
    getRemoteStatus.mockResolvedValue({ enabled: true, url: REMOTE_URL });
    disconnectRemote.mockResolvedValue();
    await renderAndSettle();

    app.querySelector('#claude-disconnect-button').click();
    // Kit S5: danger-ghost → destructive dialog → filled clay confirm.
    const dialog = await answerDialog(dom.window.document, true);
    expect(dialog.querySelector('.wg-dialog__title').textContent).toBe('Disconnect Claude?');
    expect(dialog.querySelector('.mt-confirm-modal__confirm').classList.contains('wg-btn--danger')).toBe(true);
    await vi.waitFor(() => {
      if (disconnectRemote.mock.calls.length === 0) throw new Error('not called yet');
    });

    expect(disconnectRemote).toHaveBeenCalledWith(ctx);
    expect(disconnectClaude).not.toHaveBeenCalled();
  });

  it('declining the disconnect dialog keeps the connector', async () => {
    getPairing.mockResolvedValue({ recordId: 'mcppairing' });
    getRemoteStatus.mockResolvedValue({ enabled: true, url: REMOTE_URL });
    await renderAndSettle();

    expect(app.querySelector('#claude-disconnect-button').classList.contains('wg-btn--danger-ghost')).toBe(true);
    app.querySelector('#claude-disconnect-button').click();
    await answerDialog(dom.window.document, false);
    await new Promise((r) => setTimeout(r, 0));

    expect(disconnectRemote).not.toHaveBeenCalled();
    expect(disconnectClaude).not.toHaveBeenCalled();
  });

  // CC4 · Local shim: an existing pairing keeps status + Disconnect; it is not
  // offered again, only the switch to the remote connector.
  it('an existing local pairing keeps honest saved status, explicit reconnect and Disconnect', async () => {
    getPairing.mockResolvedValue({ recordId: 'mcppairing' });
    getRemoteStatus.mockResolvedValue({ enabled: false, url: '' });
    disconnectClaude.mockResolvedValue();
    await renderAndSettle();

    expect(app.querySelector('#claude-status').textContent).toBe('Private pairing saved');
    expect(app.querySelector('#claude-local-connect-button')).toBeNull();
    expect(app.textContent).not.toMatch(/go build|mcpshim/);
    const connect = app.querySelector('#claude-remote-connect-button');
    expect(connect.textContent).toBe('Use the standard connection instead');
    expect(connect.classList.contains('wg-btn--primary')).toBe(false);
    expect(app.textContent).toContain('To set up again or replace this connection, reconnect.');

    app.querySelector('#claude-disconnect-button').click();
    await answerDialog(dom.window.document, true);
    await vi.waitFor(() => {
      if (disconnectClaude.mock.calls.length === 0) throw new Error('not called yet');
    });

    expect(disconnectClaude).toHaveBeenCalledWith(ctx);
    expect(disconnectRemote).not.toHaveBeenCalled();
    expect(connectClaude).not.toHaveBeenCalled();
  });

  async function choosePrivate(pairing = null, remote = { enabled: false }) {
    getPairing.mockResolvedValue(pairing);
    getRemoteStatus.mockResolvedValue(remote);
    await renderAndSettle();
    app.querySelector('#claude-private-button').click();
  }

  const CODE = 'mtmcp1.eyJmaXh0dXJlIjoib25seSJ9';

  it('waits for explicit destination OS, creates once and copies the same published command across OS/retry', async () => {
    await choosePrivate();
    const create = app.querySelector('#claude-private-create');
    expect(create.disabled).toBe(true);
    expect(app.querySelector('[aria-pressed="true"]')).toBeNull();
    expect(connectClaude).not.toHaveBeenCalled();
    app.querySelector('[data-computer="linux"]').click();
    let release;
    connectClaude.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    create.click();
    await vi.waitFor(() => expect(connectClaude).toHaveBeenCalledTimes(1));
    expect(create.disabled).toBe(true);
    create.click();
    expect(connectClaude).toHaveBeenCalledTimes(1);
    release({ code: CODE });
    await vi.waitFor(() => expect(app.querySelector('#claude-private-prompt')).not.toBeNull());
    const writeText = stubClipboard();
    const posix = app.querySelector('#claude-private-command').textContent;
    expect(posix).toContain(`--pairing-code '${CODE}'`);
    expect(posix).toContain('/mcpshim-v0.1.0/install.sh');
    expect(posix).not.toMatch(/latest|ExecutionPolicy|npm/);
    expect(app.querySelectorAll('.wg-btn--primary')).toHaveLength(1);
    app.querySelector('#claude-private-copy-prompt').click();
    await vi.waitFor(() => expect(app.querySelector('#claude-private-feedback').textContent).toBe('Copied. Paste into Claude Code.'));
    expect(writeText).toHaveBeenLastCalledWith(app.querySelector('#claude-private-prompt').textContent);
    app.querySelector('[data-computer="macos"]').click();
    expect(app.querySelector('#claude-private-command').textContent).toBe(posix);
    app.querySelector('[data-computer="windows"]').click();
    const powershell = app.querySelector('#claude-private-command').textContent;
    expect(powershell).toContain(`-PairingCode '${CODE}'`);
    expect(powershell).toContain('/mcpshim-v0.1.0/install.ps1');
    // Exact published commands.json SHA256, independently verified at release.
    // This binds the complete template bytes, not just a URL/substring.
    const contract = {
      version: '0.1.0', tag: 'mcpshim-v0.1.0', source_commit: '1a7c640616108cc79f1ce1b2b5e52cac56d7fc6c', placeholder: '<PAIRING_CODE>',
      posix: posix.replace(CODE, '<PAIRING_CODE>'), powershell: powershell.replace(CODE, '<PAIRING_CODE>'),
      installer_sha256: { 'install.sh': '8be0fc4a40e7ce634567413a5f4dd34c62a81aac002c6fbfd1d18ef9b8065f8c', 'install.ps1': 'd380d9c008c0d396b959d93709a09225660e007f9e6b54074949cc8013f94d57' },
    };
    expect(createHash('sha256').update(JSON.stringify(contract, null, 2) + '\n').digest('hex')).toBe('074ee55fb58b2455d4d35ee60e15d3fa5149538bfd8ab1d478aa718e126acadd');
    writeText.mockRejectedValueOnce(new Error('denied'));
    app.querySelector('#claude-private-copy-prompt').click();
    await vi.waitFor(() => expect(app.querySelector('#claude-private-feedback').textContent).toContain('Could not copy.'));
    expect(app.querySelector('#claude-private-prompt').textContent).toContain(powershell);
    app.querySelector('#claude-private-copy-prompt').click();
    await vi.waitFor(() => expect(app.querySelector('#claude-private-feedback').textContent).toContain('Copied.'));
    app.querySelector('#claude-private-copy-command').click();
    expect(writeText).toHaveBeenLastCalledWith(powershell);
    expect(connectClaude).toHaveBeenCalledTimes(1);
    expect(connectRemote).not.toHaveBeenCalled();
    expect(app.textContent).toContain('do not establish a live connection');
    expect(app.textContent).toContain('does not erase earlier data or transcripts');
  });

  it.each(['local', 'remote'])('confirms %s to Private before the first mutation; Cancel starts focused and preserves the old connection', async (mode) => {
    await choosePrivate({ recordId: 'mcppairing' }, { enabled: mode === 'remote', url: REMOTE_URL });
    app.querySelector('[data-computer="macos"]').click();
    app.querySelector('#claude-private-create').click();
    const dialog = await vi.waitFor(() => {
      const modal = dom.window.document.querySelector('mt-modal');
      expect(modal).not.toBeNull();
      return modal;
    });
    expect(dialog.querySelector('.wg-dialog__title').textContent).toBe('Replace this connection?');
    expect(dom.window.document.activeElement).toBe(dialog.querySelector('.mt-confirm-modal__cancel'));
    expect(dialog.querySelector('.mt-confirm-modal__confirm').classList.contains('wg-btn--danger')).toBe(false);
    expect(connectClaude).not.toHaveBeenCalled();
    await answerDialog(dom.window.document, false);
    await vi.waitFor(() => expect(app.querySelector('#claude-private-create').disabled).toBe(false));
    expect(disconnectClaude).not.toHaveBeenCalled();
    expect(disconnectRemote).not.toHaveBeenCalled();
    connectClaude.mockResolvedValue({ code: CODE });
    app.querySelector('#claude-private-create').click();
    await answerDialog(dom.window.document, true);
    await vi.waitFor(() => expect(app.querySelector('#claude-private-command')).not.toBeNull());
    expect(connectClaude).toHaveBeenCalledTimes(1);
    expect(connectRemote).not.toHaveBeenCalled();
  });

  it('confirms Private to remote before consent and mutation, and cancels without changing the old key', async () => {
    getPairing.mockResolvedValue({ recordId: 'mcppairing' });
    getRemoteStatus.mockResolvedValue({ enabled: false });
    await renderAndSettle();
    app.querySelector('#claude-remote-connect-button').click();
    let dialog = await answerDialog(dom.window.document, false);
    expect(dialog.textContent).toContain('new link');
    expect(connectRemote).not.toHaveBeenCalled();
    connectRemote.mockResolvedValue({ url: REMOTE_URL });
    await vi.waitFor(() => expect(app.querySelector('#claude-remote-connect-button').disabled).toBe(false));
    app.querySelector('#claude-remote-connect-button').click();
    dialog = await answerDialog(dom.window.document, true);
    expect(dialog.textContent).toContain('Replace this connection?');
    expect(connectRemote).not.toHaveBeenCalled();
    await answerDialog(dom.window.document, true);
    await vi.waitFor(() => expect(app.querySelector('#claude-code-command')).not.toBeNull());
    expect(connectRemote).toHaveBeenCalledTimes(1);
  });

  it('keeps status truthful after failed replacement, with an explicit status/retry path and no leaked error/code', async () => {
    await choosePrivate();
    connectClaude.mockRejectedValue(new Error(`sensitive diagnostic ${CODE}`));
    app.querySelector('[data-computer="linux"]').click();
    app.querySelector('#claude-private-create').click();
    await vi.waitFor(() => expect(app.querySelector('#connectors-retry')).not.toBeNull());
    expect(app.textContent).toContain('previous connection may have been replaced');
    expect(app.textContent).not.toContain(CODE);
    expect(app.textContent).not.toContain('Connected');
    getPairing.mockResolvedValue({ recordId: 'mcppairing' });
    app.querySelector('#connectors-retry').click();
    await vi.waitFor(() => expect(app.querySelector('#claude-status')?.textContent).toBe('Private pairing saved'));
    expect(app.querySelector('#claude-private-command')).toBeNull();
  });

  it('uses only proven pairing-gone evidence for the reconnect screen, never a generic offline error', async () => {
    getPairing.mockResolvedValue(null);
    getRemoteStatus.mockResolvedValue({ enabled: false });
    pairingNeedsReconnect.mockReturnValue(true);
    renderConnectors(app, ctx);
    await vi.waitFor(() => expect(app.querySelector('#claude-private-create')).not.toBeNull());
    expect(app.textContent).toContain('Reconnect needed');
    expect(app.querySelector('#claude-private-create').disabled).toBe(true);
    expect(connectClaude).not.toHaveBeenCalled();
    pairingNeedsReconnect.mockReturnValue(false);
    getRemoteStatus.mockRejectedValue(new Error('No unlocked device is online'));
    renderConnectors(app, ctx);
    await vi.waitFor(() => expect(app.querySelector('#connectors-retry')).not.toBeNull());
    expect(app.textContent).not.toContain('Reconnect needed');
  });

  it.each(["mtmcp1.';touch /tmp/invalid", '<img src=x>', ''])('refuses an unsafe pairing result as shell data: %s', async (code) => {
    await choosePrivate();
    connectClaude.mockResolvedValue({ code });
    app.querySelector('[data-computer="linux"]').click();
    app.querySelector('#claude-private-create').click();
    await vi.waitFor(() => expect(app.querySelector('#connectors-retry')).not.toBeNull());
    expect(app.querySelector('#claude-private-prompt')).toBeNull();
    expect(app.querySelector('img')).toBeNull();
  });

  it('drives the real pairing/remote boundary: Private posts no key, replacement tears remote down, expired purge alone requests reconnect', async () => {
    const realPairing = await vi.importActual('../mcp-pairing.js');
    const realRemote = await vi.importActual('../mcp-remote.js');
    const rows = new Map();
    rows.set('mcppairing', { recordId: 'mcppairing', pairingId: 'old', key: 'old-private-fixture-key' });
    recordsPort.mockReturnValue({
      list: async () => [...rows.values()],
      put: async (_type, record) => rows.set(record.recordId, record),
      del: async (_type, id) => rows.delete(id),
    });
    vi.stubGlobal('location', dom.window.location);
    let remoteEnabled = true;
    const calls = [];
    // Contract: MCPRelayAPI.CreatePairing wraps legacy mint in
    // onLegacyPairingMutation, which atomically tears down Tier2 remote first
    // (internal/cloudserver/mcp_relay.go + mcp_remote.go). No fake secret POST.
    global.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url, ...options });
      if (url === '/api/mcp/remote' && !options.method) return { ok: true, json: async () => ({ enabled: remoteEnabled, token: remoteEnabled ? 'old' : '' }) };
      if (url === '/api/mcp/pairings' && options.method === 'POST') {
        remoteEnabled = false;
        return { ok: true, json: async () => ({ pairing_id: 'fresh-private-fixture' }) };
      }
      if (url === '/api/mcp/pairings' && options.method === 'DELETE') return { ok: true };
      throw new Error('unexpected request');
    });
    getPairing.mockImplementation(realPairing.getPairing);
    connectClaude.mockImplementation(realPairing.connectClaude);
    disconnectClaude.mockImplementation(realPairing.disconnectClaude);
    pairingNeedsReconnect.mockImplementation(realPairing.pairingNeedsReconnect);
    getRemoteStatus.mockImplementation(realRemote.getRemoteStatus);
    await renderAndSettle();
    app.querySelector('#claude-private-button').click();
    app.querySelector('[data-computer="linux"]').click();
    app.querySelector('#claude-private-create').click();
    await answerDialog(dom.window.document, false);
    await vi.waitFor(() => expect(app.querySelector('#claude-private-create').disabled).toBe(false));
    expect(calls.filter((c) => c.method)).toEqual([]);
    expect(rows.get('mcppairing').key).toBe('old-private-fixture-key');
    app.querySelector('#claude-private-create').click();
    await answerDialog(dom.window.document, true);
    await vi.waitFor(() => expect(app.querySelector('#claude-private-command')).not.toBeNull());
    const code = app.querySelector('#claude-private-command').textContent.match(/--pairing-code '([^']+)'/)[1];
    const wire = JSON.parse(Buffer.from(code.slice('mtmcp1.'.length), 'base64url').toString());
    expect(wire.pairing_id).toBe('fresh-private-fixture');
    expect(wire.key).toBe(rows.get('mcppairing').key);
    expect(calls.filter((c) => c.method)).toEqual([{ url: '/api/mcp/pairings', method: 'POST' }]);
    expect(JSON.stringify(calls)).not.toContain(code);
    expect(JSON.stringify(calls)).not.toContain(wire.key);
    expect(dom.window.localStorage.length).toBe(0);
    await realPairing.purgePairing(ctx); // only real 4404 controller path invokes this.
    expect(realPairing.pairingNeedsReconnect(ctx)).toBe(true);
    renderConnectors(app, ctx);
    await vi.waitFor(() => expect(app.querySelector('#claude-private-create')).not.toBeNull());
    expect(app.textContent).toContain('Reconnect needed');
    await realPairing.disconnectClaude(ctx);
    expect(realPairing.pairingNeedsReconnect(ctx)).toBe(false);
  });
});
