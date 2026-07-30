/**
 * @vitest-environment jsdom
 *
 * feedback-reader.test.js (bd med-rbl.2)
 *
 * The base-domain /feedback reader: the capability token rides the URL
 * fragment, the queue comes back as opaque age ciphertext, and the pasted age
 * private key decrypts it HERE — never on the server. The module dynamic-imports
 * the vendored typage bundle by an absolute `/static/...` URL that doesn't
 * resolve under Node, so we inject a Node loader via setLoader() (same seam as
 * feedback-submit.test.js:31).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toBase64, utf8 } from '../crypto.js';
import {
  MSG,
  QUEUE_URL,
  TOKEN_HEADER,
  decryptAll,
  mount,
  readToken,
  setLoader,
} from '../feedback-reader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.resolve(__dirname, '../../../static/vendor/age.min.js');

let typage;
let identity;
let recipient;

beforeAll(async () => {
  setLoader(() => import(pathToFileURL(VENDOR).href));
  typage = await import(pathToFileURL(VENDOR).href);
  identity = await typage.generateIdentity();
  recipient = await typage.identityToRecipient(identity);
});

// encryptDoc mirrors what the client actually queues: the v1 plaintext document
// (feedback-submit.js serializeFeedback) age-encrypted to the developer.
async function encryptDoc(doc) {
  const e = new typage.Encrypter();
  e.addRecipient(recipient);
  return toBase64(await e.encrypt(utf8(JSON.stringify(doc))));
}

function item(id, ciphertext_b64, extra = {}) {
  return {
    id,
    kind: 'feedback',
    app_version: '1.2.3',
    created_at: '2026-07-30T10:00:00Z',
    ciphertext_b64,
    ...extra,
  };
}

// The page's real markup (web/cloud/feedback.html), minus the module tag.
function seedPage() {
  document.body.innerHTML = `
    <main class="wizard-step">
      <p id="fr-status" class="muted">Loading…</p>
      <div id="fr-key-row" class="note-form" hidden>
        <input id="fr-key" type="password" autocomplete="off" spellcheck="false">
        <button id="fr-decrypt" type="button">Decrypt</button>
      </div>
      <p id="fr-error" class="wizard-error"></p>
      <ul id="fr-items" class="fr-list"></ul>
    </main>`;
}

function q(sel) { return document.querySelector(sel); }
function click(el) { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }
async function flush() { await new Promise((r) => setTimeout(r, 0)); }

// Decryption is async per item, so a fixed number of microtask ticks is a race.
// Poll until the condition holds (or give up and let the assertion report).
async function waitFor(cond, tries = 200) {
  for (let i = 0; i < tries && !cond(); i++) await flush();
}

// queueResponder returns a fetch stub that answers the queue endpoint with the
// given items and records the requests it saw.
function queueResponder(items, status = 200) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init });
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ items }) };
  });
  fn.calls = calls;
  return fn;
}

beforeEach(() => {
  seedPage();
  window.location.hash = '';
  // jsdom has no object-URL support; the reader only needs a handle to hang off
  // an <img>/<audio> src.
  window.URL.createObjectURL = vi.fn(() => 'blob:mock');
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('readToken', () => {
  it('reads the token out of the fragment and ignores anything else', () => {
    expect(readToken('#t=abc123')).toBe('abc123');
    expect(readToken('t=abc123')).toBe('abc123');
    expect(readToken('#x=1&t=abc123')).toBe('abc123');
    expect(readToken('')).toBe('');
    expect(readToken('#')).toBe('');
    expect(readToken('#x=1')).toBe('');
    expect(readToken(undefined)).toBe('');
  });
});

describe('decryptAll', () => {
  it('round-trips a v1 doc: text plus both attachment types', async () => {
    const doc = {
      v: 1,
      created_at: '2026-07-30T09:00:00.000Z',
      text: 'the save button does nothing',
      attachments: [
        { type: 'image', mime: 'image/jpeg', data_b64: 'AQID' },
        { type: 'audio', mime: 'audio/webm', data_b64: 'BAUGBw==' },
      ],
    };
    const results = await decryptAll([item(1, await encryptDoc(doc))], identity);
    expect(results).toHaveLength(1);
    expect(results[0].error).toBeUndefined();
    expect(results[0].doc.text).toBe('the save button does nothing');
    expect(results[0].doc.attachments).toEqual(doc.attachments);
  });

  it('rejects a malformed key once, with a friendly message and no crash', async () => {
    const ct = await encryptDoc({ v: 1, text: 'hi', attachments: [] });
    await expect(decryptAll([item(1, ct)], 'not-an-age-key')).rejects.toThrow(MSG.badKey);
  });

  it('reports a well-formed but wrong key per item rather than throwing', async () => {
    const other = await typage.generateIdentity();
    const ct = await encryptDoc({ v: 1, text: 'hi', attachments: [] });
    const results = await decryptAll([item(1, ct)], other);
    expect(results[0].doc).toBeUndefined();
    expect(results[0].error).toBe(MSG.itemDecrypt);
  });

  it('flags a non-v1 document without failing the batch', async () => {
    const results = await decryptAll([
      item(1, await encryptDoc({ v: 2, text: 'from the future' })),
      item(2, await encryptDoc({ v: 1, text: 'ok', attachments: [] })),
    ], identity);
    expect(results[0].error).toBe(MSG.itemVersion);
    expect(results[1].doc.text).toBe('ok');
  });

  it('isolates a corrupt item: the other two still decrypt', async () => {
    const results = await decryptAll([
      item(1, await encryptDoc({ v: 1, text: 'first', attachments: [] })),
      item(2, 'bm90IGFuIGFnZSBmaWxlIGF0IGFsbA=='), // valid base64, not age
      item(3, await encryptDoc({ v: 1, text: 'third', attachments: [] })),
    ], identity);
    expect(results.map((r) => r.doc?.text)).toEqual(['first', undefined, 'third']);
    expect(results[1].error).toBe(MSG.itemDecrypt);
  });

  it('flags plaintext that decrypts but is not JSON', async () => {
    const e = new typage.Encrypter();
    e.addRecipient(recipient);
    const ct = toBase64(await e.encrypt(utf8('not json at all')));
    const results = await decryptAll([item(1, ct)], identity);
    expect(results[0].error).toBe(MSG.itemParse);
  });
});

describe('mount', () => {
  it('does not fetch at all when the link carried no token', async () => {
    const fetchStub = queueResponder([]);
    vi.stubGlobal('fetch', fetchStub);

    await mount();

    expect(fetchStub).not.toHaveBeenCalled();
    expect(q('#fr-status').textContent).toBe(MSG.noToken);
    expect(q('#fr-key-row').hidden).toBe(true);
  });

  it('sends the token in a header, never in the URL, and scrubs the fragment', async () => {
    const fetchStub = queueResponder([]);
    vi.stubGlobal('fetch', fetchStub);
    window.location.hash = '#t=secret-token';

    await mount();

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const { url, init } = fetchStub.calls[0];
    expect(url).toBe(QUEUE_URL);
    expect(url).not.toContain('secret-token');
    expect(init.headers[TOKEN_HEADER]).toBe('secret-token');
    // The token must not sit in the address bar once it has been read.
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('secret-token');
    expect(q('#fr-status').textContent).toBe(MSG.empty);
  });

  it('says the link expired on a 401 rather than showing a generic failure', async () => {
    vi.stubGlobal('fetch', queueResponder([], 401));
    window.location.hash = '#t=stale';

    await mount();

    expect(q('#fr-status').textContent).toBe(MSG.expired);
    expect(q('#fr-key-row').hidden).toBe(true);
  });

  it('renders decrypted items on submit, keeping a corrupt one inline', async () => {
    const items = [
      item(1, await encryptDoc({
        v: 1,
        text: 'first report',
        attachments: [{ type: 'image', mime: 'image/png', data_b64: 'AQID' }],
      })),
      item(2, 'bm90IGFuIGFnZSBmaWxlIGF0IGFsbA=='),
      item(3, await encryptDoc({ v: 1, text: 'third report', attachments: [] })),
    ];
    vi.stubGlobal('fetch', queueResponder(items));
    window.location.hash = '#t=live';

    await mount();
    expect(q('#fr-key-row').hidden).toBe(false);

    q('#fr-key').value = identity;
    click(q('#fr-decrypt'));
    await waitFor(() => document.querySelectorAll('#fr-items .fr-item').length === 3);

    const rendered = document.querySelectorAll('#fr-items .fr-item');
    expect(rendered).toHaveLength(3);
    expect(rendered[0].querySelector('.fr-text').textContent).toBe('first report');
    expect(rendered[0].querySelector('img.fr-attachment')).not.toBeNull();
    expect(rendered[1].querySelector('.fr-text')).toBeNull();
    expect(rendered[1].querySelector('.wizard-error').textContent).toBe(MSG.itemDecrypt);
    expect(rendered[2].querySelector('.fr-text').textContent).toBe('third report');
    expect(q('#fr-error').textContent).toBe('');
  });

  it('never persists the pasted key anywhere, and clears the field after use', async () => {
    const items = [item(1, await encryptDoc({ v: 1, text: 'hi', attachments: [] }))];
    vi.stubGlobal('fetch', queueResponder(items));
    window.location.hash = '#t=live';

    await mount();
    q('#fr-key').value = identity;
    click(q('#fr-decrypt'));
    await waitFor(() => document.querySelectorAll('#fr-items .fr-item').length === 1);

    // The field is emptied the moment its value is read.
    expect(q('#fr-key').value).toBe('');
    // Nothing wrote it to any web-storage bucket, a cookie, or the URL.
    const buckets = [
      JSON.stringify(window.localStorage),
      JSON.stringify(window.sessionStorage),
      document.cookie,
      window.location.href,
      document.body.innerHTML,
    ].join('|');
    expect(buckets).not.toContain(identity);
    // And the key does not leak into the rendered output either.
    expect(document.body.textContent).not.toContain(identity);
  });

  it('shows the friendly bad-key message without leaking the pasted value', async () => {
    const items = [item(1, await encryptDoc({ v: 1, text: 'hi', attachments: [] }))];
    vi.stubGlobal('fetch', queueResponder(items));
    window.location.hash = '#t=live';

    await mount();
    q('#fr-key').value = 'AGE-SECRET-KEY-NOPE';
    click(q('#fr-decrypt'));
    await waitFor(() => q('#fr-error').textContent !== '');

    expect(q('#fr-error').textContent).toBe(MSG.badKey);
    expect(document.body.textContent).not.toContain('AGE-SECRET-KEY-NOPE');
    expect(document.querySelectorAll('#fr-items .fr-item')).toHaveLength(0);
  });

  it('prompts instead of decrypting when the key field is empty', async () => {
    const items = [item(1, await encryptDoc({ v: 1, text: 'hi', attachments: [] }))];
    vi.stubGlobal('fetch', queueResponder(items));
    window.location.hash = '#t=live';

    await mount();
    click(q('#fr-decrypt'));
    await waitFor(() => q('#fr-error').textContent !== '');

    expect(q('#fr-error').textContent).toBe(MSG.needKey);
  });

  it('clears the key field when the page is hidden', async () => {
    vi.stubGlobal('fetch', queueResponder([]));
    window.location.hash = '#t=live';

    await mount();
    q('#fr-key').value = 'AGE-SECRET-KEY-1SOMETHING';
    window.dispatchEvent(new window.Event('pagehide'));

    expect(q('#fr-key').value).toBe('');
  });
});
