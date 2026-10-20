// The one Emergency Kit page (bd med-ckm5.2, design O1; earlier med-d5t.2):
// loss protection and the kit together, an "I saved it" choice that unlocks
// Continue at the user's own risk, the save state stashed for the synced
// vault record, and the invariant that matters most: the recovery code never
// leaves the browser. Plus the ceremony exit bar the app shells show on top
// of these pages (design N5).
//
// The cloud shell has no integration entry point, so this follows the
// pure-unit convention of cloud-boot.test.js (repo rule 8's documented exception).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
// node:buffer's Blob, not jsdom's: only this one implements .text(), which is
// how these tests read back what the user would actually have on disk.
import { Blob as NodeBlob } from 'node:buffer';

import { buildKitDocument, renderEmergencyKit } from '../signup.js';
import { mountExitBar } from '../exitbar.js';

vi.mock('../unlock.js', () => ({ establishLdkCache: vi.fn(async () => {}) }));
vi.mock('../telegram.js', () => ({ mountTelegram: vi.fn(async () => {}) }));

const CTX = { accountId: 'acct-1', dek: new Uint8Array(32).fill(7) };
const STASH = 'wg-emergency-kit-saved';

let dom;
let blobs;     // every Blob handed to createObjectURL
let anchors;   // every <a> whose click() we intercepted
let printed;   // srcdoc of every iframe told to print

beforeEach(() => {
  dom = new JSDOM('<div id="app"></div>', { url: 'https://acct.example/unlock' });
  globalThis.document = dom.window.document;
  globalThis.location = { origin: 'https://acct.example', href: '' };
  // defineProperty: newer Node ships its own getter-only localStorage global.
  Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true, writable: true });
  globalThis.Blob = NodeBlob;
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 }));

  blobs = [];
  anchors = [];
  printed = [];

  globalThis.URL.createObjectURL = vi.fn((blob) => {
    blobs.push(blob);
    return `blob:https://acct.example/${blobs.length}`;
  });
  globalThis.URL.revokeObjectURL = vi.fn();

  // jsdom does not navigate, and an <a download> click would only warn.
  vi.spyOn(dom.window.HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
    anchors.push(this);
  });
  // jsdom's iframe never fires load for srcdoc, so drive print off the append.
  const realAppend = dom.window.HTMLElement.prototype.appendChild;
  vi.spyOn(dom.window.HTMLElement.prototype, 'appendChild').mockImplementation(function append(node) {
    const r = realAppend.call(this, node);
    if (node.tagName === 'IFRAME' && node.className === 'kit-print-frame') printed.push(node.srcdoc);
    return r;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.document;
  delete globalThis.fetch;
  delete globalThis.location;
  delete globalThis.localStorage;
  delete globalThis.Blob;
});

async function mountKit(ctx = CTX) {
  const app = dom.window.document.getElementById('app');
  await renderEmergencyKit(app, ctx);
  return app;
}

const pressed = (app) => app.querySelector('#kit-saved').getAttribute('aria-pressed');
const stash = () => JSON.parse(dom.window.localStorage.getItem(STASH));

describe('Emergency Kit page: one page, "I saved it" at the user\'s own risk', () => {
  it('is one page: three disclosures, a choice (no native checkbox), Continue in the docked footer', async () => {
    const app = await mountKit();
    expect(app.querySelector('h1').textContent).toBe('Save your Emergency Kit');
    expect(app.querySelectorAll('details.wg-disc')).toHaveLength(3);
    expect(app.querySelector('input[type=checkbox]')).toBeNull();
    expect(app.querySelector('#kit-saved').classList.contains('wg-choice--check')).toBe(true);
    expect(app.querySelector('.wg-pagefoot #kit-continue')).not.toBeNull();
    expect(app.querySelector('#kit-download')).not.toBeNull();
    expect(app.querySelector('#kit-print')).not.toBeNull();
    // Signup no longer shows this page (it gets the W5 offer), so no step indicator.
    expect(app.querySelector('.wg-steps')).toBeNull();
  });

  it('puts a long account ID and the recovery code in the wrapping .wg-kv list (med-i0fj)', async () => {
    const accountId = 'acc_7Q2M9X4KJ8R3TZ6V1N5B0WHC2YFD8LPEQ3XYZ';
    const app = await mountKit({ ...CTX, accountId });
    const kv = app.querySelector('dl.wg-kv');
    expect(kv.querySelector('#kit-account-id').textContent).toBe(accountId);
    expect(kv.querySelector('#kit-code').textContent.trim()).not.toBe('');
    expect(kv.querySelector('#kit-url').textContent).toBe('https://acct.example');
  });

  it('keeps Continue disabled, with the hint, until "I saved it" is ticked', async () => {
    const app = await mountKit();
    expect(pressed(app)).toBe('false');
    expect(app.querySelector('#kit-continue').disabled).toBe(true);
    expect(app.querySelector('#kit-hint').hidden).toBe(false);
    expect(app.querySelector('#kit-save-chip').textContent).toBe('Not saved');
    // The new code is already live, so a page closed now must read as unsaved.
    expect(stash().how).toBe('none');
  });

  it('ticked without a download or print: Continue unlocks, the warn note says so, and the stash says ack', async () => {
    const app = await mountKit();
    app.querySelector('#kit-saved').click();

    expect(pressed(app)).toBe('true');
    expect(app.querySelector('#kit-continue').disabled).toBe(false);
    expect(app.querySelector('#kit-hint').hidden).toBe(true);
    expect(app.querySelector('#kit-risk').hidden).toBe(false);
    expect(app.querySelector('#kit-risk').textContent).toContain("We didn't see a download or print here");

    app.querySelector('#kit-continue').click();
    expect(stash()).toEqual({ savedAt: expect.any(Number), how: 'ack' });

    // Unticking re-gates it.
    app.querySelector('#kit-saved').click();
    expect(app.querySelector('#kit-continue').disabled).toBe(true);
  });

  it('a download marks the row saved, ticks the choice, hides the warn note and stashes download', async () => {
    const app = await mountKit();
    app.querySelector('#kit-download').click();

    expect(app.querySelector('#kit-save-chip').textContent).toBe('Saved');
    expect(app.querySelector('#kit-save-chip').classList.contains('wg-chip--ok')).toBe(true);
    expect(app.querySelector('#kit-save-desc').textContent).toMatch(/^Downloaded .+ · HTML, \d+ KB$/);
    expect(pressed(app)).toBe('true');
    expect(app.querySelector('#kit-risk').hidden).toBe(true);
    expect(app.querySelector('#kit-continue').disabled).toBe(false);

    app.querySelector('#kit-continue').click();
    expect(stash().how).toBe('download');
  });

  it('names the downloaded file after the account', async () => {
    const app = await mountKit();
    app.querySelector('#kit-download').click();

    expect(anchors).toHaveLength(1);
    expect(anchors[0].download).toBe('med-tracker-emergency-kit-acct-1.html');
    expect(anchors[0].href).toMatch(/^blob:/);
  });

  it('the downloaded file carries the URL, account id, recovery code and QR', async () => {
    const app = await mountKit();
    const shownCode = app.querySelector('#kit-code').textContent.trim();
    app.querySelector('#kit-download').click();

    expect(blobs).toHaveLength(1);
    const text = await blobs[0].text();
    expect(text).toContain('https://acct.example');
    expect(text).toContain('acct-1');
    expect(text).toContain(shownCode);
    expect(text).toContain('<svg');
    // Self-contained: it has to open years later from a Downloads folder.
    expect(text).not.toMatch(/<link|<script|src="http/);
  });

  it('printing marks the row saved and stashes print', async () => {
    const app = await mountKit();
    app.querySelector('#kit-print').click();

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('Emergency Kit');
    expect(app.querySelector('#kit-save-desc').textContent).toMatch(/^Printed /);
    app.querySelector('#kit-continue').click();
    expect(stash().how).toBe('print');
  });

  it('falls back to the printable view when the browser refuses a Blob download', async () => {
    globalThis.URL.createObjectURL = vi.fn(() => { throw new Error('blocked'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await mountKit();

    app.querySelector('#kit-download').click();

    expect(printed).toHaveLength(1);
    expect(pressed(app)).toBe('true');
  });

  it('recover / regenerate render the same page and hand Continue to the caller', async () => {
    const onKitSaved = vi.fn();
    const app = await mountKit({ ...CTX, onKitSaved, continueLabel: 'Done' });
    expect(app.querySelector('.wg-steps')).toBeNull();
    expect(app.querySelector('#kit-continue').textContent).toBe('Done');

    app.querySelector('#kit-download').click();
    app.querySelector('#kit-continue').click();

    await vi.waitFor(() => expect(onKitSaved).toHaveBeenCalled());
    expect(globalThis.fetch.mock.calls.map(([url]) => url)).not.toContain('/api/loss-ack');
    expect(stash().how).toBe('download');
  });
});

// bd med-ta2n.8, design W5 · kit: signup's kit is an offer after sync turns on.
describe('Emergency Kit offer (signup, entered from Settings)', () => {
  const mountOffer = () => mountKit({ ...CTX, offer: true });

  it('two facts, Save and Print, Done always enabled, the skip hint, no acknowledgement choice', async () => {
    const app = await mountOffer();
    expect(app.querySelector('h1').textContent).toBe('One more thing: a way back in');
    expect(app.querySelector('.wg-chip--ok').textContent).toBe('Sync is on');
    expect(app.querySelectorAll('.wg-facts li')).toHaveLength(2);
    expect(app.textContent).toContain('Nobody can reset it for you');
    expect(app.querySelector('#kit-download').textContent).toBe('Save kit');
    expect(app.querySelector('#kit-print').textContent).toBe('Print');
    expect(app.querySelector('.wg-pagefoot #kit-done').disabled).toBe(false);
    expect(app.querySelector('#kit-hint').textContent).toBe('Skip for now and Settings will remind you.');
    expect(app.querySelector('#kit-saved, #kit-continue, input[type=checkbox], details')).toBeNull();
    // The new code is already live, so a page closed now must read as unsaved.
    expect(stash().how).toBe('none');
  });

  it('Done without a save stashes none, sends the loss acknowledgement, then moves on', async () => {
    const { mountTelegram } = await import('../telegram.js');
    const app = await mountOffer();
    app.querySelector('#kit-done').click();

    expect(stash()).toEqual({ savedAt: expect.any(Number), how: 'none' });
    await vi.waitFor(() => expect(mountTelegram).toHaveBeenCalled());
    expect(globalThis.fetch.mock.calls.map(([url]) => url)).toContain('/api/loss-ack');
  });

  it('a save stashes download, a print stashes print', async () => {
    let app = await mountOffer();
    app.querySelector('#kit-download').click();
    expect(anchors).toHaveLength(1);
    app.querySelector('#kit-done').click();
    expect(stash().how).toBe('download');

    app = await mountOffer();
    app.querySelector('#kit-print').click();
    expect(printed).toHaveLength(1);
    app.querySelector('#kit-done').click();
    expect(stash().how).toBe('print');
  });

  it('a failed loss acknowledgement stays on the page with the error and Done re-armed', async () => {
    const app = await mountOffer();
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    app.querySelector('#kit-done').click();

    await vi.waitFor(() => expect(app.querySelector('#kit-error').hidden).toBe(false));
    expect(app.querySelector('#kit-error').textContent).toContain('Could not save your acknowledgment');
    expect(app.querySelector('#kit-done').disabled).toBe(false);
  });
});

describe('Emergency Kit: the recovery code never leaves the browser', () => {
  it('uploads only the verifier and the wrapped envelope, never the code', async () => {
    const app = await mountKit();
    const code = app.querySelector('#kit-code').textContent.trim();
    const bare = code.replace(/[\s-]/g, '');

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/recovery-material');
    expect(url).not.toContain(bare);
    expect(init.body).not.toContain(code);
    expect(init.body).not.toContain(bare);

    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(['envelope', 'verifier']);
  });

  it('never writes the code to a URL or the save-state stash', async () => {
    const app = await mountKit();
    const bare = app.querySelector('#kit-code').textContent.trim().replace(/[\s-]/g, '');
    app.querySelector('#kit-download').click();
    app.querySelector('#kit-continue').click();

    for (const a of anchors) expect(a.href).not.toContain(bare);
    expect(globalThis.location.href).not.toContain(bare);
    expect(dom.window.localStorage.getItem(STASH)).not.toContain(bare);
  });

  it('never console-logs the code, on the happy path or the failure path', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    globalThis.URL.createObjectURL = vi.fn(() => { throw new Error('blocked'); });

    const app = await mountKit();
    const bare = app.querySelector('#kit-code').textContent.trim().replace(/[\s-]/g, '');
    app.querySelector('#kit-download').click();

    for (const call of [...spy.mock.calls, ...logSpy.mock.calls]) {
      expect(call.join(' ')).not.toContain(bare);
    }
  });
});

describe('buildKitDocument', () => {
  const ARGS = {
    kitUrl: 'https://acct.example',
    accountId: 'acct-1',
    formatted: 'ABCD-EFGH-IJKL',
    qrSvg: '<svg></svg>',
  };

  it('is a standalone document with no external references', () => {
    const doc = buildKitDocument(ARGS);
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).not.toMatch(/<link|<script|src="http/);
  });

  it('warns that whoever holds the page can unlock the vault', () => {
    expect(buildKitDocument(ARGS)).toContain('Anyone holding this page');
  });

  it('escapes account-derived values rather than interpolating them raw', () => {
    const doc = buildKitDocument({ ...ARGS, accountId: '<img src=x onerror=alert(1)>' });
    expect(doc).not.toContain('<img src=x');
    expect(doc).toContain('&lt;img src=x');
  });

  it('tells the user the code rotates after use, so a stale printout is not trusted', () => {
    expect(buildKitDocument(ARGS)).toContain('new code afterwards');
  });
});

// Design N5: the web-owned exit strip the iOS/Android shells show instead of
// their native bottom bar. Its action is the shells' existing account.leave op.
describe('ceremony exit bar (.wg-exitbar)', () => {
  function shellWindow({ path = '/unlock', hash = '', platform = 'android' } = {}) {
    const d = new JSDOM('<body><main id="app"></main></body>', { url: `https://vivid-vole.qa.test${path}${hash}` });
    const call = vi.fn(async () => true);
    let confirmCb = null;
    let confirmOpts = null;
    const win = {
      location: d.window.location,
      LocalNotifications: platform ? { __native: { platform, call } } : undefined,
      safeConfirm: vi.fn((msg, cb, opts) => { confirmCb = cb; confirmOpts = opts; }),
      safeAlert: vi.fn(),
    };
    return { d, win, call, confirm: (ok) => confirmCb(ok), opts: () => confirmOpts };
  }

  it('renders at the top of the page, before #app, naming the account being set up', () => {
    const { d, win } = shellWindow({ hash: '#claim=tok' });
    const bar = mountExitBar(d.window.document, win);

    expect(d.window.document.body.firstElementChild).toBe(bar);
    expect(bar.className).toBe('wg-exitbar');
    expect(bar.querySelector('.wg-exitbar__who').textContent).toBe('Setting up vivid-vole.qa.test');
    expect(bar.querySelector('button.wg-exitbar__leave').textContent).toBe('Not your account?');
  });

  it('confirms in-page, then calls account.leave with no args', async () => {
    const { d, win, call, confirm, opts } = shellWindow({ path: '/claim', platform: 'ios' });
    mountExitBar(d.window.document, win).querySelector('button').click();

    expect(win.safeConfirm).toHaveBeenCalled();
    expect(opts()).toMatchObject({ title: 'Use another invite?', confirmLabel: 'Use another invite', cancelLabel: 'Keep setting up' });
    expect(call).not.toHaveBeenCalled();

    confirm(true);
    expect(call).toHaveBeenCalledWith('account.leave');
  });

  it('keeping the setup calls nothing', () => {
    const { d, win, call, confirm } = shellWindow({ path: '/recover' });
    mountExitBar(d.window.document, win).querySelector('button').click();
    confirm(false);
    expect(call).not.toHaveBeenCalled();
  });

  it('is absent on the web (no shell to go back to) and off the ceremony pages', () => {
    const web = shellWindow({ platform: null });
    expect(mountExitBar(web.d.window.document, web.win)).toBeNull();
    const devices = shellWindow({ path: '/devices' });
    expect(mountExitBar(devices.d.window.document, devices.win)).toBeNull();
    expect(devices.d.window.document.querySelector('.wg-exitbar')).toBeNull();
  });
});
