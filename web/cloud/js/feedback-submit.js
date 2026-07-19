// feedback-submit.js — the single integration seam between the capture UI
// (feedback-ui.js, med-dni.2) and the durable submit pipeline (med-dni.3).
//
// A `bundle` is `{ text: string, attachments: [{ type: 'image'|'audio',
// mime: string, bytes: ArrayBuffer|Uint8Array }] }`. It carries ONLY
// user-authored content — no account id, no PII (decided: feedback is
// anonymous). App/version metadata is added at submit time by med-dni.3, not
// here and not by the UI.
//
// med-dni.3: age-encrypt the bundle to the operator recipient
// (feedback-config.js) at enqueue time so plaintext never persists, enqueue the
// ciphertext into a durable IndexedDB outbox, and drain via retry/backoff
// POST /api/feedback.
import { toBase64, utf8 } from './crypto.js';
import { openDb } from './localdb.js';
import { getFeedbackRecipient } from './feedback-config.js';

// Overridable module loader for the vendored typage (age-encryption) ESM.
// Production uses the absolute browser path; tests inject a Node loader by file
// URL (dynamic import of an absolute `/static/...` URL doesn't resolve under
// Vitest). Copied from core/backup-crypto.js:30.
let _load = () => import('/static/vendor/age.min.js');
let _cachedAge = null;

export function setLoader(fn) {
  _load = fn;
  _cachedAge = null;
}

async function age() {
  if (!_cachedAge) _cachedAge = await _load();
  return _cachedAge;
}

function toU8(bytes) {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

// serializeFeedback(bundle, meta) -> Uint8Array (UTF-8 of the v1 plaintext
// document). This is the contract with med-dni.4's decrypt CLI; attachment
// `bytes` become base64 `data_b64`. See docs/plans → Technical Details.
export function serializeFeedback(bundle, meta) {
  const src = bundle && Array.isArray(bundle.attachments) ? bundle.attachments : [];
  const attachments = src.map((a) => ({
    type: a.type,
    mime: a.mime,
    data_b64: toBase64(toU8(a.bytes)),
  }));
  const doc = {
    v: 1,
    created_at: (meta && meta.created_at) || new Date().toISOString(),
    text: (bundle && bundle.text) || '',
    attachments,
  };
  return utf8(JSON.stringify(doc));
}

// encryptToRecipient(bytes, recipient) -> base64 age v1 ciphertext. `recipient`
// is the developer's `age1...` X25519 pubkey (getFeedbackRecipient()). typage's
// Encrypter.addRecipient decodes the bech32 internally; the server only ever
// stores this ciphertext.
export async function encryptToRecipient(bytes, recipient) {
  if (!recipient) throw new Error('encryptToRecipient: recipient required (feedback misconfigured)');
  const { Encrypter } = await age();
  const e = new Encrypter();
  e.addRecipient(recipient);
  const ct = await e.encrypt(toU8(bytes));
  return toBase64(ct);
}

// --- durable outbox (medtracker-cloud DB, 'feedback_outbox' store) ----------
// Stores only age-ciphertext rows keyed by client_id — plaintext is encrypted
// at enqueue time so it never persists. Mirrors sync.js's put/getAll/delete
// shape on the shared localdb handle.

function outboxTx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('feedback_outbox', mode);
    const store = tx.objectStore('feedback_outbox');
    const req = fn(store);
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }).finally(() => db.close()));
}

export function putFeedbackItem(item) {
  return outboxTx('readwrite', (store) => store.put(item));
}

export function getAllFeedbackItems() {
  return outboxTx('readonly', (store) => store.getAll());
}

export function deleteFeedbackItem(clientId) {
  return outboxTx('readwrite', (store) => store.delete(clientId));
}

function appVersion() {
  if (typeof document === 'undefined') return 'dev';
  return document.querySelector('meta[name="medtracker-build-id"]')?.content || 'dev';
}

// enqueueFeedback(bundle): age-encrypt the anonymous bundle to the operator
// recipient and durably persist the ciphertext to the outbox. The UI's "sent"
// is optimistic — actual delivery is the drain loop's job (Task 3). Throws if
// feedback is misconfigured (no recipient) so the UI can gate before calling.
export async function enqueueFeedback(bundle) {
  const recipient = getFeedbackRecipient();
  if (!recipient) throw new Error('enqueueFeedback: feedback recipient not configured');
  const meta = {
    client_id: crypto.randomUUID(),
    kind: 'feedback',
    app_version: appVersion(),
    created_at: new Date().toISOString(),
  };
  const ciphertext = await encryptToRecipient(serializeFeedback(bundle, meta), recipient);
  await putFeedbackItem({
    client_id: meta.client_id,
    kind: meta.kind,
    app_version: meta.app_version,
    ciphertext,
    attempts: 0,
    created_at: meta.created_at,
  });
  // Task 3 wires drainFeedbackOutbox() here (fire-and-forget).
}
