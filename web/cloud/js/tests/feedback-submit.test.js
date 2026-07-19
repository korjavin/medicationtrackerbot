// feedback-submit.test.js (bd med-dni.3)
// Task 1: serialize the anonymous bundle to the v1 plaintext document and
// age-encrypt it to the developer's recipient. The module dynamic-imports the
// vendored typage bundle by an absolute `/static/...` URL that doesn't resolve
// under Node, so we inject a Node loader via setLoader() (same seam as
// backup-crypto.test.js:53).
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { fromBase64 } from '../crypto.js';
import {
  serializeFeedback,
  encryptToRecipient,
  setLoader,
  enqueueFeedback,
  getAllFeedbackItems,
  putFeedbackItem,
  drainFeedbackOutbox,
  startFeedbackAutoDrain,
  MAX_ATTEMPTS,
  __resetDrainForTest,
} from '../feedback-submit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.resolve(__dirname, '../../../static/vendor/age.min.js');

let typage;
beforeAll(async () => {
  setLoader(() => import(pathToFileURL(VENDOR).href));
  typage = await import(pathToFileURL(VENDOR).href);
});

describe('feedback-submit serialize + encrypt (Task 1)', () => {
  it('round-trips text + both attachment types as base64 in the v1 doc', () => {
    const bundle = {
      text: 'app crashed on save',
      attachments: [
        { type: 'image', mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) },
        { type: 'audio', mime: 'audio/webm', bytes: new Uint8Array([4, 5, 6, 7]).buffer },
      ],
    };
    const bytes = serializeFeedback(bundle, { created_at: '2026-07-19T00:00:00.000Z' });
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    expect(doc.v).toBe(1);
    expect(doc.created_at).toBe('2026-07-19T00:00:00.000Z');
    expect(doc.text).toBe('app crashed on save');
    expect(doc.attachments).toHaveLength(2);
    expect(doc.attachments[0]).toEqual({ type: 'image', mime: 'image/jpeg', data_b64: 'AQID' });
    expect(doc.attachments[1]).toEqual({ type: 'audio', mime: 'audio/webm', data_b64: 'BAUGBw==' });
  });

  it('defaults created_at and empty text/attachments', () => {
    const doc = JSON.parse(new TextDecoder().decode(serializeFeedback({}, {})));
    expect(doc.text).toBe('');
    expect(doc.attachments).toEqual([]);
    expect(typeof doc.created_at).toBe('string');
  });

  it('encrypts to the recipient and decrypts back to the same plaintext', async () => {
    const identity = await typage.generateIdentity();
    const recipient = await typage.identityToRecipient(identity);

    const bundle = { text: 'hello', attachments: [] };
    const plaintext = serializeFeedback(bundle, { created_at: '2026-07-19T00:00:00.000Z' });
    const b64 = await encryptToRecipient(plaintext, recipient);
    expect(typeof b64).toBe('string');
    expect(b64.length).toBeGreaterThan(0);

    const ct = fromBase64(b64);
    // age v1 files begin with the ASCII line "age-encryption.org/v1\n".
    expect(new TextDecoder().decode(ct.subarray(0, 21))).toBe('age-encryption.org/v1');

    const d = new typage.Decrypter();
    d.addIdentity(identity);
    const back = await d.decrypt(ct);
    expect(JSON.parse(new TextDecoder().decode(back))).toEqual({
      v: 1,
      created_at: '2026-07-19T00:00:00.000Z',
      text: 'hello',
      attachments: [],
    });
  });

  it('throws when the recipient is empty (feature misconfigured)', async () => {
    await expect(encryptToRecipient(new Uint8Array([1]), '')).rejects.toThrow(/recipient required/);
  });
});

describe('feedback-submit durable enqueue (Task 2)', () => {
  const RECIPIENT = 'meta-recipient';

  function withDocument(recipient) {
    const meta = recipient
      ? `<meta name="medtracker-feedback-age-recipient" content="${recipient}"><meta name="medtracker-build-id" content="20260719-1200">`
      : '';
    global.document = new JSDOM(`<!doctype html><html><head>${meta}</head></html>`).window.document;
  }

  beforeEach(async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    global.indexedDB = new IDBFactory();
    // encryptToRecipient hits real typage, so give it a valid recipient key.
    withDocument(await typage.identityToRecipient(await typage.generateIdentity()));
    // enqueueFeedback now fire-and-forgets a drain; a never-resolving fetch keeps
    // the in-flight POST from mutating/deleting the row under assertion.
    vi.stubGlobal('fetch', () => new Promise(() => {}));
  });

  afterEach(() => {
    __resetDrainForTest();
    vi.unstubAllGlobals();
    delete global.document;
  });

  it('persists exactly one ciphertext item with no plaintext fields', async () => {
    await enqueueFeedback({ text: 'secret words', attachments: [] });
    const items = await getAllFeedbackItems();
    expect(items).toHaveLength(1);
    const row = items[0];
    expect(typeof row.ciphertext).toBe('string');
    expect(row.ciphertext.length).toBeGreaterThan(0);
    expect(row.attempts).toBe(0);
    expect(row.kind).toBe('feedback');
    expect(row.app_version).toBe('20260719-1200');
    // client_id is a uuid.
    expect(row.client_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // No plaintext leaks into the stored row.
    expect(JSON.stringify(row)).not.toContain('secret words');
    expect(row.text).toBeUndefined();
  });

  it('stores a second distinct item for a second call', async () => {
    await enqueueFeedback({ text: 'one', attachments: [] });
    await enqueueFeedback({ text: 'two', attachments: [] });
    const items = await getAllFeedbackItems();
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.client_id)).size).toBe(2);
  });

  it('throws before persisting when the recipient is missing', async () => {
    withDocument('');
    await expect(enqueueFeedback({ text: 'x', attachments: [] })).rejects.toThrow(/recipient/);
    expect(await getAllFeedbackItems()).toHaveLength(0);
  });
});

describe('feedback-submit drain loop (Task 3)', () => {
  const ITEM = () => ({
    client_id: 'cid-1',
    kind: 'feedback',
    app_version: '20260719-1200',
    ciphertext: 'YWdlLWN0', // base64 stand-in — drain doesn't inspect it
    attempts: 0,
    created_at: '2026-07-19T00:00:00.000Z',
  });

  beforeEach(async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    global.indexedDB = new IDBFactory();
    __resetDrainForTest();
  });

  afterEach(() => {
    __resetDrainForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('happy path: 204 removes the item and POSTs client_id + ciphertext', async () => {
    let seen = null;
    vi.stubGlobal('fetch', (url, init) => {
      seen = { url, body: JSON.parse(init.body) };
      return Promise.resolve({ ok: true, status: 204 });
    });
    await putFeedbackItem(ITEM());
    await drainFeedbackOutbox();
    expect(seen.url).toBe('/api/feedback');
    expect(seen.body).toEqual({
      client_id: 'cid-1',
      kind: 'feedback',
      app_version: '20260719-1200',
      ciphertext: 'YWdlLWN0',
    });
    expect(await getAllFeedbackItems()).toHaveLength(0);
  });

  it('a duplicate re-POST still deletes on the 2xx the server dedupes to', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, status: 200 }));
    await putFeedbackItem(ITEM());
    await drainFeedbackOutbox();
    expect(await getAllFeedbackItems()).toHaveLength(0);
  });

  it('a network throw keeps the item and increments attempts', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    await putFeedbackItem(ITEM());
    await drainFeedbackOutbox();
    const items = await getAllFeedbackItems();
    expect(items).toHaveLength(1);
    expect(items[0].attempts).toBe(1);
  });

  it('a 503 keeps the item and retries later', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 503 }));
    await putFeedbackItem(ITEM());
    await drainFeedbackOutbox();
    const items = await getAllFeedbackItems();
    expect(items).toHaveLength(1);
    expect(items[0].attempts).toBe(1);
  });

  it('a 429 (queue full) keeps the item and retries later', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 429 }));
    await putFeedbackItem(ITEM());
    await drainFeedbackOutbox();
    const items = await getAllFeedbackItems();
    expect(items).toHaveLength(1);
    expect(items[0].attempts).toBe(1);
  });

  it('a 400 drops the item (permanent, not retried)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 400 }));
    await putFeedbackItem(ITEM());
    await drainFeedbackOutbox();
    expect(await getAllFeedbackItems()).toHaveLength(0);
  });

  it('a 401 keeps the item without burning the attempt cap', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 401 }));
    await putFeedbackItem(ITEM());
    await drainFeedbackOutbox();
    const items = await getAllFeedbackItems();
    expect(items).toHaveLength(1);
    expect(items[0].attempts).toBe(0);
  });

  it('parks the item at MAX_ATTEMPTS and stops rescheduling drains', async () => {
    // The attempt cap is the safety valve against an infinite retry spin: once
    // an item hits MAX_ATTEMPTS it is kept but no backoff timer is scheduled.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      calls += 1;
      return Promise.reject(new Error('offline'));
    });
    await putFeedbackItem({ ...ITEM(), attempts: MAX_ATTEMPTS - 1 });
    await drainFeedbackOutbox();
    const items = await getAllFeedbackItems();
    expect(items).toHaveLength(1);
    expect(items[0].attempts).toBe(MAX_ATTEMPTS); // kept, not dropped
    expect(calls).toBe(1);
    // Parked: advancing well past the backoff cap must NOT fire a second drain.
    await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS * 2);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(calls).toBe(1);
  });

  it('backoff reschedules a second drain after the timer fires', async () => {
    // Fake only setTimeout/clearTimeout — fake-indexeddb relies on real
    // setImmediate, so faking it would deadlock the IDB reads in the drain.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      calls += 1;
      return Promise.reject(new Error('offline'));
    });
    await putFeedbackItem(ITEM());
    await drainFeedbackOutbox();
    expect(calls).toBe(1);
    // Backoff timer scheduled; advancing it triggers a second drain, whose IDB
    // reads run on real setImmediate — flush those after the fake-timer advance
    // until the retry POST lands (bounded so a genuine failure still fails).
    await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS);
    for (let i = 0; i < 50 && calls < 2; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(calls).toBe(2);
  });
});

describe('feedback-submit reconnect autodrain (Task 3/4)', () => {
  const ITEM = () => ({
    client_id: 'cid-auto',
    kind: 'feedback',
    app_version: '20260719-1200',
    ciphertext: 'YWdlLWN0',
    attempts: 0,
    created_at: '2026-07-19T00:00:00.000Z',
  });

  let dom;
  beforeEach(async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    global.indexedDB = new IDBFactory();
    __resetDrainForTest();
    dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://x.test' });
    global.window = dom.window;
    global.document = dom.window.document;
  });

  afterEach(() => {
    __resetDrainForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete global.window;
    delete global.document;
  });

  it('installs exactly one online listener pair and is idempotent', () => {
    const spy = vi.spyOn(dom.window, 'addEventListener');
    const stop1 = startFeedbackAutoDrain();
    const stop2 = startFeedbackAutoDrain(); // second call must be a no-op
    const onlineListeners = spy.mock.calls.filter((c) => c[0] === 'online').length;
    expect(onlineListeners).toBe(1);
    stop1();
    stop2();
  });

  it('drains on an online event (after debounce) and teardown stops it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      calls += 1;
      return Promise.resolve({ ok: true, status: 204 });
    });
    await putFeedbackItem(ITEM());
    const stop = startFeedbackAutoDrain();

    dom.window.dispatchEvent(new dom.window.Event('online'));
    await vi.advanceTimersByTimeAsync(250); // debounce
    for (let i = 0; i < 50 && calls < 1; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(calls).toBe(1);
    expect(await getAllFeedbackItems()).toHaveLength(0);

    // After teardown a fresh online event must not drain again.
    stop();
    await putFeedbackItem(ITEM());
    dom.window.dispatchEvent(new dom.window.Event('online'));
    await vi.advanceTimersByTimeAsync(250);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(calls).toBe(1); // no second drain
    expect(await getAllFeedbackItems()).toHaveLength(1);
  });
});

const BACKOFF_CAP_MS = 5 * 60 * 1000;
