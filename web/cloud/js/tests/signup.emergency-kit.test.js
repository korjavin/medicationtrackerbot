// med-d5t.2: the Emergency Kit screen used to promise "save or print it now"
// and offer no way to do either — the only gate was a self-attestation
// checkbox. A friend who tapped through and later lost their phone had an
// unrecoverable vault. These pin the gate (a file, or an explicit print) and
// the invariant that matters most: the recovery code never leaves the browser.
//
// The cloud shell has no integration entry point, so this follows the
// pure-unit convention of cloud-boot.test.js (repo rule 8's documented exception).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
// node:buffer's Blob, not jsdom's: only this one implements .text(), which is
// how these tests read back what the user would actually have on disk.
import { Blob as NodeBlob } from 'node:buffer';

import { buildKitDocument, renderEmergencyKit } from '../signup.js';

vi.mock('../unlock.js', () => ({ establishLdkCache: vi.fn(async () => {}) }));
vi.mock('../telegram.js', () => ({ mountTelegram: async (_app, { onDone }) => onDone() }));

const CTX = { accountId: 'acct-1', dek: new Uint8Array(32).fill(7) };

let dom;
let blobs;     // every Blob handed to createObjectURL
let anchors;   // every <a> whose click() we intercepted
let printed;   // srcdoc of every iframe told to print

beforeEach(() => {
  dom = new JSDOM('<div id="app"></div>');
  globalThis.document = dom.window.document;
  globalThis.location = { origin: 'https://acct.example', href: '' };
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
  vi.spyOn(dom.window.HTMLIFrameElement.prototype, 'setAttribute');
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
  delete globalThis.Blob;
});

async function mountKit(ctx = CTX) {
  const app = dom.window.document.getElementById('app');
  await renderEmergencyKit(app, ctx);
  return app;
}

describe('Emergency Kit: the user must actually produce the kit', () => {
  it('offers a download and a print action, not just a checkbox', async () => {
    const app = await mountKit();
    expect(app.querySelector('#kit-download')).not.toBeNull();
    expect(app.querySelector('#kit-print')).not.toBeNull();
  });

  it('locks the checkbox and Continue until the kit is produced', async () => {
    const app = await mountKit();
    expect(app.querySelector('#kit-saved-checkbox').disabled).toBe(true);
    expect(app.querySelector('#kit-continue').disabled).toBe(true);
  });

  it('downloading a file unlocks the checkbox, and only then does Continue arm', async () => {
    const app = await mountKit();
    app.querySelector('#kit-download').click();

    const checkbox = app.querySelector('#kit-saved-checkbox');
    expect(checkbox.disabled).toBe(false);
    // Attestation is a second line of defence, not a bypass: still unticked.
    expect(app.querySelector('#kit-continue').disabled).toBe(true);

    checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event('change'));
    expect(app.querySelector('#kit-continue').disabled).toBe(false);
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
    const shownCode = app.querySelector('.recovery-code').textContent.trim();
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

  it('printing is an independent way through the gate (blob downloads can be blocked)', async () => {
    const app = await mountKit();
    app.querySelector('#kit-print').click();

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('Emergency Kit');
    expect(app.querySelector('#kit-saved-checkbox').disabled).toBe(false);
  });

  it('falls back to the printable view when the browser refuses a Blob download', async () => {
    globalThis.URL.createObjectURL = vi.fn(() => { throw new Error('blocked'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await mountKit();

    app.querySelector('#kit-download').click();

    // The user is never left stuck behind a gate they cannot open.
    expect(printed).toHaveLength(1);
    expect(app.querySelector('#kit-saved-checkbox').disabled).toBe(false);
  });

  it('the checkbox alone can never arm Continue', async () => {
    const app = await mountKit();
    const checkbox = app.querySelector('#kit-saved-checkbox');
    // Simulate a user (or a devtools poke) forcing the box without saving.
    checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event('change'));

    expect(app.querySelector('#kit-continue').disabled).toBe(true);
  });

  it('gates the forced code rotation in recover.js too, via the shared renderer', async () => {
    const onKitSaved = vi.fn();
    const app = await mountKit({ ...CTX, onKitSaved });
    expect(app.querySelector('#kit-saved-checkbox').disabled).toBe(true);

    app.querySelector('#kit-download').click();
    const checkbox = app.querySelector('#kit-saved-checkbox');
    checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event('change'));
    app.querySelector('#kit-continue').click();

    expect(onKitSaved).toHaveBeenCalled();
  });
});

describe('Emergency Kit: the recovery code never leaves the browser', () => {
  it('uploads only the verifier and the wrapped envelope, never the code', async () => {
    const app = await mountKit();
    const code = app.querySelector('.recovery-code').textContent.trim();
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

  it('never writes the code to a URL — a blob: URL is an opaque handle', async () => {
    const app = await mountKit();
    const bare = app.querySelector('.recovery-code').textContent.trim().replace(/[\s-]/g, '');
    app.querySelector('#kit-download').click();

    for (const a of anchors) expect(a.href).not.toContain(bare);
    expect(globalThis.location.href).not.toContain(bare);
  });

  it('never console-logs the code, on the happy path or the failure path', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    globalThis.URL.createObjectURL = vi.fn(() => { throw new Error('blocked'); });

    const app = await mountKit();
    const bare = app.querySelector('.recovery-code').textContent.trim().replace(/[\s-]/g, '');
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
