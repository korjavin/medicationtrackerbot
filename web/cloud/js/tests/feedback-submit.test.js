// feedback-submit.test.js (bd med-dni.3)
// Task 1: serialize the anonymous bundle to the v1 plaintext document and
// age-encrypt it to the developer's recipient. The module dynamic-imports the
// vendored typage bundle by an absolute `/static/...` URL that doesn't resolve
// under Node, so we inject a Node loader via setLoader() (same seam as
// backup-crypto.test.js:53).
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
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
  });

  afterEach(() => {
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
