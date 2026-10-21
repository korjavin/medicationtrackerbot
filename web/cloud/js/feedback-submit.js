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

// Local mode (bd med-ta2n.20, local-policy.js) swaps the transport for
// { recipient(), send(body, signal), onDropped(item, status), notice() }: the
// recipient from the attest challenge and a signed POST /api/attest/feedback.
// recipient() throws an Error with a userMessage the sheet shows when nothing
// can be sent; onDropped records an item the server refused for good after
// the sheet closed, and notice() hands the sheet the line about it (once).
// Unset = cloud: the <meta> recipient and the same-origin POST /api/feedback.
let transport = null;
export function setFeedbackTransport(t) {
  transport = t;
}

// The line the sheet shows on open ('' when nothing to say).
export function takeFeedbackNotice() {
  return (transport && transport.notice && transport.notice()) || '';
}

// client_id → outcome of a send the sheet is waiting on (local mode).
const awaiting = new Map();

function appVersion() {
  if (typeof document === 'undefined') return 'dev';
  return document.querySelector('meta[name="medtracker-build-id"]')?.content || 'dev';
}

// enqueueFeedback(bundle, { shouldAbort }): age-encrypt the anonymous bundle
// to the operator recipient and durably persist the ciphertext to the outbox.
// Throws if feedback is misconfigured (no recipient) so the UI can gate before
// calling. Resolves to:
//   undefined   cloud: queued, and the UI's "sent" is optimistic — delivery is
//               the drain loop's job (Task 3).
//   'cancelled' shouldAbort() turned true while the recipient was awaited
//               (local: a challenge and maybe an enroll); nothing was sealed.
//   'sent' | 'queued' | 'dropped'  local: the first drain's outcome for it,
//               so the sheet never says "sent" before the server took it.
export async function enqueueFeedback(bundle, { shouldAbort } = {}) {
  const recipient = transport ? await transport.recipient() : getFeedbackRecipient();
  if (shouldAbort && shouldAbort()) return 'cancelled';
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
  if (transport) {
    // Local: wait for the first attempt (each step is bounded) and report it.
    awaiting.set(meta.client_id, 'queued');
    try {
      await drainFeedbackOutbox();
    } catch { /* stays queued; the backoff retries */ }
    const outcome = awaiting.get(meta.client_id);
    awaiting.delete(meta.client_id);
    return outcome;
  }
  // Cloud: delivery is the queue's job — the UI's "sent" is optimistic. Kick a
  // drain but don't await it: resolve as soon as the item is durably queued.
  drainFeedbackOutbox().catch(() => {});
  return undefined;
}

// --- drain loop: POST, error policy, exponential backoff, reconnect ----------
// Mirrors sync.js's flush shape (single-slot promise-chain lock, same 4xx-drop /
// 5xx-network-retry classification) and adds the one thing sync lacks: a
// self-rescheduling backoff timer so a persistently-offline device retries
// without a user action, capped so it parks rather than spins.
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 20; // then park the item for the next online/session

// POST one item's ciphertext to the feedback endpoint (cloud: same-origin, the
// session cookie rides along; local: the transport's signed attest POST).
// Returns {ok,status} like sync's snapshotAt: a network throw is status 0
// (retryable).
async function postFeedback(item) {
  const body = JSON.stringify({
    client_id: item.client_id,
    kind: item.kind,
    app_version: item.app_version,
    ciphertext: item.ciphertext,
  });
  // Bound the request like apiCallDirect (api.js, 60s default): a hung
  // connection must never wedge the single-slot drainChain forever.
  const signal = AbortSignal.timeout(60_000);
  let res;
  try {
    res = transport
      ? await transport.send(body, signal)
      : await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal,
      });
  } catch {
    return { ok: false, status: 0 }; // network error / timeout abort — retryable
  }
  return { ok: res.ok, status: res.status };
}

let drainChain = Promise.resolve();
export function drainFeedbackOutbox() {
  const run = drainChain.then(() => drainOutboxUnlocked());
  drainChain = run.catch(() => {});
  return run;
}

async function drainOutboxUnlocked() {
  const items = await getAllFeedbackItems();
  let retryable = false;
  for (const item of items) {
    const { ok, status } = await postFeedback(item);
    if (ok) {
      // 2xx (incl. 204, and a 2xx dedupe of a re-POSTed client_id) → done.
      await deleteFeedbackItem(item.client_id);
      if (awaiting.has(item.client_id)) awaiting.set(item.client_id, 'sent');
      continue;
    }
    if (status === 401 && !transport) {
      // Cloud: auth not ready (session not yet minted) — retry later, don't
      // drop and don't burn the attempt cap on it.
      retryable = true;
      continue;
    }
    if (status >= 400 && status < 500 && status !== 429 && status !== 401) {
      // Any other client-error 4xx is permanent — the origin server emits 400
      // (bad payload) / 413 (too large), and an intermediary (Traefik/WAF) can
      // emit 403/404. None succeed on retry, so give up rather than re-POST on
      // every reconnect forever. (Cloud 401 auth-pending is handled above; 429
      // queue-full is transient, so it falls through to the retry branch.)
      await deleteFeedbackItem(item.client_id);
      // Local: the open sheet says so; else the next one does.
      if (awaiting.has(item.client_id)) awaiting.set(item.client_id, 'dropped');
      else if (transport && transport.onDropped) transport.onDropped(item, status);
      continue;
    }
    // Network (status 0), 429 (queue full), 5xx, 503 (feature temporarily
    // disabled), or a local attest 401 (the attest client already re-signed
    // and re-enrolled once; a key that still fails is capped like the rest)
    // → retry.
    const attempts = (item.attempts || 0) + 1;
    await putFeedbackItem({ ...item, attempts });
    if (attempts < MAX_ATTEMPTS) retryable = true; // else park it
  }
  if (retryable) {
    scheduleBackoffDrain();
  } else {
    // Clean pass: nothing left to retry. Cancel any stale armed timer too —
    // leaving an old (possibly near-5min) delay armed would trip the
    // scheduleBackoffDrain guard and block a fresh short backoff for a later
    // failed enqueue.
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
    backoffRound = 0; // reset the backoff floor
  }
  return items.length;
}

// Single guarded self-rescheduling timer (see the ponytail note in the plan:
// one global backoff timer is fine for a low-rate anonymous outbox).
let backoffTimer = null;
let backoffRound = 0;
function scheduleBackoffDrain() {
  if (backoffTimer) return; // guard against overlapping timers
  const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** backoffRound);
  const jittered = delay * (0.5 + Math.random() * 0.5); // 50–100% jitter
  backoffRound += 1;
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    drainFeedbackOutbox().catch(() => {});
  }, jittered);
}

// startFeedbackAutoDrain: drain queued items on reconnect / tab-visible, copying
// sync.js:1064's startReconnectAutoDrain shape (online + visibilitychange gated
// on navigator.onLine, 250ms debounce, in-flight guard, teardown). No-op outside
// a DOM context.
let autoDrainInstalled = false;
let feedbackDrainInFlight = null;
export function startFeedbackAutoDrain() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  if (autoDrainInstalled) return () => {}; // idempotent — one listener pair per session
  autoDrainInstalled = true;
  let debounce = null;
  let stopped = false;
  let rerun = false;
  const drain = () => {
    if (feedbackDrainInFlight) { rerun = true; return feedbackDrainInFlight; }
    feedbackDrainInFlight = drainFeedbackOutbox()
      .catch(() => {})
      .finally(() => {
        feedbackDrainInFlight = null;
        if (rerun && !stopped) { rerun = false; drain(); }
      });
    return feedbackDrainInFlight;
  };
  const trigger = () => {
    clearTimeout(debounce);
    debounce = setTimeout(drain, 250);
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible' && navigator.onLine) trigger();
  };
  window.addEventListener('online', trigger);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    stopped = true;
    autoDrainInstalled = false;
    clearTimeout(debounce);
    window.removeEventListener('online', trigger);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

// Test-only: reset the module-level drain/backoff state between cases.
export function __resetDrainForTest() {
  if (backoffTimer) clearTimeout(backoffTimer);
  backoffTimer = null;
  backoffRound = 0;
  drainChain = Promise.resolve();
  autoDrainInstalled = false;
  feedbackDrainInFlight = null;
  transport = null;
  awaiting.clear();
}
