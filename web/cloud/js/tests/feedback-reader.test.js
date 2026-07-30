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
  ackItems,
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
      <button id="fr-ack-all" class="secondary" type="button" hidden>Delete all read</button>
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
// given items, serves the DELETE (ack) half, and records the requests it saw —
// including every id the page asked to delete, which is what the ordering rule
// is asserted against.
function queueResponder(items, status = 200, { ackOk = true } = {}) {
  const calls = [];
  const acked = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init });
    if ((init?.method || 'GET') === 'DELETE') {
      if (!ackOk) return { ok: false, status: 401, json: async () => ({}) };
      const ids = JSON.parse(init.body).ids;
      acked.push(...ids);
      return { ok: true, status: 200, json: async () => ({ deleted: ids.length }) };
    }
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ items }) };
  });
  fn.calls = calls;
  fn.acked = acked;
  return fn;
}

// decryptedPage mounts the reader with the given items and decrypts them, so an
// ack test starts from the only state in which acking is legal: rendered.
async function decryptedPage(items, opts) {
  const fetchStub = queueResponder(items, 200, opts);
  vi.stubGlobal('fetch', fetchStub);
  window.location.hash = '#t=live';
  await mount();
  q('#fr-key').value = identity;
  click(q('#fr-decrypt'));
  await waitFor(() => document.querySelectorAll('#fr-items .fr-item').length === items.length);
  return fetchStub;
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

  it('offers nothing to delete before anything has been decrypted', async () => {
    const items = [item(1, await encryptDoc({ v: 1, text: 'hi', attachments: [] }))];
    vi.stubGlobal('fetch', queueResponder(items));
    window.location.hash = '#t=live';

    await mount();

    // The queue is loaded but still ciphertext: acking now would delete
    // feedback nobody has read.
    expect(q('#fr-ack-all').hidden).toBe(true);
    expect(document.querySelectorAll('#fr-items button')).toHaveLength(0);
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

// The ack half (bd med-rbl.3). The rule these tests exist to pin, copied from
// cmd/feedbackpull's run(): an item is only ever deleted AFTER its plaintext has
// decrypted and rendered. feedbackpull writes the rendered item before acking so
// a failed write cannot destroy the only copy of the feedback; the page cannot
// delegate that to the server, which never sees plaintext, so it has to hold the
// property itself.
describe('ack', () => {
  // Two readable items around one that will never decrypt.
  async function mixedItems() {
    return [
      item(1, await encryptDoc({ v: 1, text: 'readable one', attachments: [] })),
      item(2, 'bm90IGFuIGFnZSBmaWxlIGF0IGFsbA=='),
      item(3, await encryptDoc({ v: 1, text: 'readable two', attachments: [] })),
    ];
  }

  it('sends the ack with the token in the header, ids in the body, nothing in the URL', async () => {
    const fetchStub = queueResponder([]);
    vi.stubGlobal('fetch', fetchStub);

    expect(await ackItems('secret-token', [7, 9])).toBe(true);

    const { url, init } = fetchStub.calls[0];
    expect(init.method).toBe('DELETE');
    expect(url).toBe(QUEUE_URL);
    expect(url).not.toContain('secret-token');
    expect(url).not.toContain('7');
    expect(init.headers[TOKEN_HEADER]).toBe('secret-token');
    expect(JSON.parse(init.body)).toEqual({ ids: [7, 9] });
  });

  it('refuses to send an empty ack — an empty list must never mean "drain everything"', async () => {
    const fetchStub = queueResponder([]);
    vi.stubGlobal('fetch', fetchStub);

    expect(await ackItems('live', [])).toBe(false);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('gives an item that failed to decrypt no delete control at all', async () => {
    await decryptedPage(await mixedItems());

    const rendered = document.querySelectorAll('#fr-items .fr-item');
    expect(rendered[0].querySelector('button')).not.toBeNull();
    // Structurally unackable, not merely discouraged: there is no control to press.
    expect(rendered[1].querySelector('button')).toBeNull();
    expect(rendered[2].querySelector('button')).not.toBeNull();
  });

  it('deletes only the item whose button was pressed', async () => {
    const fetchStub = await decryptedPage(await mixedItems());

    click(document.querySelectorAll('#fr-items .fr-item')[0].querySelector('button'));
    await waitFor(() => document.querySelectorAll('#fr-items .fr-item').length === 2);

    expect(fetchStub.acked).toEqual([1]);
    const left = document.querySelectorAll('#fr-items .fr-item');
    expect(left).toHaveLength(2);
    expect(left[0].querySelector('.wizard-error').textContent).toBe(MSG.itemDecrypt);
    expect(left[1].querySelector('.fr-text').textContent).toBe('readable two');
    // The batch button now offers one fewer item.
    expect(q('#fr-ack-all').textContent).toContain('1');
  });

  it('delete-all acks every READ item and leaves the unreadable one queued', async () => {
    const fetchStub = await decryptedPage(await mixedItems());
    expect(q('#fr-ack-all').hidden).toBe(false);

    click(q('#fr-ack-all'));
    await waitFor(() => document.querySelectorAll('#fr-items .fr-item').length === 1);

    // Item 2 never decrypted, so it is not in the request and stays on screen.
    expect(fetchStub.acked).toEqual([1, 3]);
    const left = document.querySelectorAll('#fr-items .fr-item');
    expect(left).toHaveLength(1);
    expect(left[0].querySelector('.wizard-error').textContent).toBe(MSG.itemDecrypt);
    expect(left[0].querySelector('button')).toBeNull();
    expect(q('#fr-ack-all').hidden).toBe(true);
  });

  it('keeps the item on screen and says so when the delete is rejected', async () => {
    const fetchStub = await decryptedPage(await mixedItems(), { ackOk: false });

    click(document.querySelectorAll('#fr-items .fr-item')[0].querySelector('button'));
    await waitFor(() => q('#fr-error').textContent !== '');

    expect(q('#fr-error').textContent).toBe(MSG.ackFailed);
    expect(fetchStub.acked).toEqual([]);
    // Nothing vanished on a failed ack: the developer can retry or fall back to
    // cmd/feedbackpull, and the plaintext is still on the page.
    expect(document.querySelectorAll('#fr-items .fr-item')).toHaveLength(3);
    expect(q('#fr-ack-all').textContent).toContain('2');
  });

  it('does not resurrect an acked item when the key is pasted a second time', async () => {
    const fetchStub = await decryptedPage(await mixedItems());

    click(document.querySelectorAll('#fr-items .fr-item')[0].querySelector('button'));
    await waitFor(() => document.querySelectorAll('#fr-items .fr-item').length === 2);

    // The queue snapshot is local, so a second Decrypt must not re-render a row
    // the server no longer has — the page would be claiming unread feedback that
    // does not exist, and offering to delete it again.
    q('#fr-key').value = identity;
    click(q('#fr-decrypt'));
    await waitFor(() => q('#fr-status').textContent === '2 items.');

    const shown = document.querySelectorAll('#fr-items .fr-item');
    expect(shown).toHaveLength(2);
    expect(document.body.textContent).not.toContain('readable one');
    expect(q('#fr-ack-all').textContent).toContain('1');

    click(q('#fr-ack-all'));
    await waitFor(() => q('#fr-status').textContent.includes('could not be read'));
    // Item 1 was acked once, not twice: the batch only carried what was left.
    expect(fetchStub.acked).toEqual([1, 3]);
  });

  it('never puts the pasted key on the ack request', async () => {
    const fetchStub = await decryptedPage(await mixedItems());

    click(q('#fr-ack-all'));
    await waitFor(() => fetchStub.acked.length > 0);

    const wire = JSON.stringify(fetchStub.calls);
    expect(wire).not.toContain(identity);
    expect(q('#fr-key').value).toBe('');
  });
});
