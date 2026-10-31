// Claude connector page (kit screens-connect-ai.html CC1–CC4, med-73xx): one
// way in onto the remote connector, per-app instructions from the same URL,
// and a hidden local-shim offer. Split out of the devices page by med-lyv.
// connectors.js drives the real DOM directly (no framework), so these tests run
// it against a real jsdom document with the pairing/remote modules mocked — the
// interesting behavior here is the page wiring, not mcp-pairing.js's /
// mcp-remote.js's own fetch calls (covered separately).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

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
import { renderConnectors } from '../connectors.js';
import { installDialogs, answerDialog } from './helpers/dialogs.js';
import { getPairing, connectClaude, disconnectClaude } from '../mcp-pairing.js';
import { getRemoteStatus, connectRemote, disconnectRemote } from '../mcp-remote.js';

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
  it('offers one primary "Connect an AI app" and no local shim when nothing is connected', async () => {
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
  it('a local-shim pairing keeps its status and Disconnect, with no shim connect offer', async () => {
    getPairing.mockResolvedValue({ recordId: 'mcppairing' });
    getRemoteStatus.mockResolvedValue({ enabled: false, url: '' });
    disconnectClaude.mockResolvedValue();
    await renderAndSettle();

    expect(app.querySelector('#claude-status').textContent).toBe('Linked with the local shim');
    expect(app.querySelector('#claude-local-connect-button')).toBeNull();
    expect(app.textContent).not.toMatch(/go build|mcpshim/);
    const connect = app.querySelector('#claude-remote-connect-button');
    expect(connect.textContent).toBe('Connect an AI app instead');
    expect(connect.classList.contains('wg-btn--primary')).toBe(false);
    expect(app.textContent).toContain('This disconnects the local shim first.');

    app.querySelector('#claude-disconnect-button').click();
    await answerDialog(dom.window.document, true);
    await vi.waitFor(() => {
      if (disconnectClaude.mock.calls.length === 0) throw new Error('not called yet');
    });

    expect(disconnectClaude).toHaveBeenCalledWith(ctx);
    expect(disconnectRemote).not.toHaveBeenCalled();
    expect(connectClaude).not.toHaveBeenCalled();
  });
});
