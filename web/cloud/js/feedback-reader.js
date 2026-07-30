// feedback-reader.js — the developer-facing web-feedback reader (bd med-rbl.2).
//
// Served at /feedback on the BASE domain. Web feedback is anonymous, so there is
// no account and no session here: the capability is a short-lived token that the
// manager bot put in the URL FRAGMENT of the "new feedback" DM link. The page
// reads it out of the fragment (browsers never send a fragment to the server, so
// it stays out of access logs and out of Telegram's link-preview prefetch),
// sends it in a header, and gets back the same opaque age ciphertext the server
// stored.
//
// EVERYTHING about the plaintext happens here, in the browser. The server holds
// no age private key and this page never sends one — that is the whole point,
// and it is the same trust model as cmd/feedbackpull, relocated to where the
// developer already is (their phone).
//
// KEY HANDLING (a required mitigation, not polish — see the epic's "accepted
// limitation"): the pasted private key is memory-only. It is never written to
// localStorage / sessionStorage / IndexedDB / a cookie / the URL, never logged,
// and never interpolated into an error message. Every error string this module
// produces is a fixed constant, so no library's exception text can carry key
// material into the DOM. The input is cleared the moment its value is read and
// again on pagehide, and the last reference is dropped when decryption finishes.
// JS strings are immutable, so dropping references is the ceiling available —
// we cannot zero the bytes.
import { fromBase64 } from './crypto.js';

// Overridable module loader for the vendored typage (age-encryption) ESM.
// Production uses the absolute browser path — cmd/cloud serves that one file on
// the base domain specifically for this page. Tests inject a Node loader by file
// URL (a dynamic import of an absolute `/static/...` URL doesn't resolve under
// Vitest). Same seam as feedback-submit.js:22 / core/backup-crypto.js:30.
// The path is held in a const rather than written inline so Vite's static
// import-analysis leaves it alone: under the jsdom (web) transform pipeline a
// literal '/static/...' specifier is resolved at collect time and hard-fails,
// which is why feedback-submit.js can inline it (its suite runs in the node
// environment) and this one cannot.
const AGE_BUNDLE_URL = '/static/vendor/age.min.js';
let _load = () => import(/* @vite-ignore */ AGE_BUNDLE_URL);
let _cachedAge = null;

export function setLoader(fn) {
  _load = fn;
  _cachedAge = null;
}

async function age() {
  if (!_cachedAge) _cachedAge = await _load();
  return _cachedAge;
}

// Must match feedbackReaderTokenHeader / feedbackQueuePath in
// internal/cloudserver/feedback_reader.go. A header, never a query param: query
// strings land in access logs and Referer headers.
export const TOKEN_HEADER = 'X-Feedback-Reader-Token';
export const QUEUE_URL = '/api/feedback/queue';

// Fixed, key-free message constants. Nothing derived from a caught exception is
// ever surfaced, so the key cannot leak through an error path.
export const MSG = {
  noToken: 'This page needs the link from the "new feedback" message. Open that link again — the token in it is what authorizes reading the queue.',
  expired: 'That link has expired (they last 30 minutes). Send a new piece of feedback, or read the queue with cmd/feedbackpull.',
  fetchFailed: 'Could not load the queue. Check the connection and reload.',
  empty: 'The queue is empty — nothing waiting to be read.',
  needKey: 'Paste the age private key to decrypt.',
  badKey: 'That does not look like an age private key (it should start with AGE-SECRET-KEY-1).',
  itemDecrypt: 'Could not decrypt this item with that key.',
  itemParse: 'Decrypted, but the contents are not readable as a feedback document.',
  itemVersion: 'Decrypted, but this is a newer document format than this page understands.',
  ackFailed: 'Could not delete — nothing was removed. The link may have expired; reopen it from the message.',
  allAcked: 'Queue drained. Everything readable has been deleted.',
};

// readToken(hash) -> the capability token carried in the URL fragment, '' when
// absent. The fragment is parsed as a query string ("#t=..."), matching the
// /claim page's existing fragment-carried-secret convention.
export function readToken(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return '';
  try {
    return new URLSearchParams(raw).get('t') || '';
  } catch {
    return '';
  }
}

// fetchQueue(token) -> { ok, status, items }. Never throws: a network failure is
// status 0, so the caller renders one explicit state per outcome rather than a
// stack trace.
export async function fetchQueue(token) {
  let res;
  try {
    res = await fetch(QUEUE_URL, { headers: { [TOKEN_HEADER]: token }, cache: 'no-store' });
  } catch {
    return { ok: false, status: 0, items: [] };
  }
  if (!res.ok) return { ok: false, status: res.status, items: [] };
  try {
    const body = await res.json();
    return { ok: true, status: res.status, items: Array.isArray(body.items) ? body.items : [] };
  } catch {
    return { ok: false, status: res.status, items: [] };
  }
}

// ackItems(token, ids) -> true when the server accepted the delete (bd
// med-rbl.3). Same capability token as the read, in the same header.
//
// Callers must pass only ids whose plaintext is already on the screen. That
// ordering is cmd/feedbackpull's rule (run() writes the rendered item before it
// acks, so a failed write cannot destroy the only copy of the feedback) and it
// has to be enforced HERE: the server never sees plaintext, so it cannot check
// that anything was read. renderResults makes it structural by only ever
// attaching an ack control to an item that decrypted.
export async function ackItems(token, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return false;
  let res;
  try {
    res = await fetch(QUEUE_URL, {
      method: 'DELETE',
      headers: { [TOKEN_HEADER]: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
      cache: 'no-store',
    });
  } catch {
    return false;
  }
  return !!res.ok;
}

// decryptAll(items, identity) -> [{ item, doc }] | [{ item, error }] per input,
// in the same order. Per-item failure is ISOLATED — one unreadable row shows an
// inline error and the rest still render, mirroring cmd/feedbackpull's fail-open
// drain. A malformed key is different: it fails every item identically, so it is
// detected once up front and thrown as a single message.
export async function decryptAll(items, identity) {
  const { Decrypter } = await age();
  try {
    // addIdentity parses the bech32 key and throws synchronously on garbage.
    new Decrypter().addIdentity(identity);
  } catch {
    throw new Error(MSG.badKey);
  }

  const out = [];
  for (const item of items) {
    // A fresh Decrypter per item: typage's decrypt() is single-use.
    const d = new Decrypter();
    d.addIdentity(identity);
    let plaintext;
    try {
      plaintext = await d.decrypt(fromBase64(item.ciphertext_b64));
    } catch {
      out.push({ item, error: MSG.itemDecrypt });
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      out.push({ item, error: MSG.itemParse });
      continue;
    }
    if (!doc || doc.v !== 1) {
      out.push({ item, error: MSG.itemVersion });
      continue;
    }
    out.push({ item, doc });
  }
  return out;
}

// --- DOM ------------------------------------------------------------------

function el(id) {
  return document.getElementById(id);
}

function setText(node, text) {
  if (node) node.textContent = text;
}

function metaLine(item) {
  const when = item.created_at ? new Date(item.created_at).toLocaleString() : 'unknown time';
  return `#${item.id} · ${item.kind || '—'} · app ${item.app_version || '—'} · ${when}`;
}

// renderAttachment builds one inline media element from a decoded attachment.
// Only image/* and audio/* are rendered; anything else becomes a plain note, so
// an unexpected mime can never become an active element on the page.
function renderAttachment(att) {
  let bytes;
  try {
    bytes = fromBase64(att.data_b64 || '');
  } catch {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Attachment could not be decoded.';
    return p;
  }
  const mime = String(att.mime || '');
  if (att.type === 'image' && mime.startsWith('image/')) {
    const img = document.createElement('img');
    img.className = 'fr-attachment';
    img.alt = 'feedback screenshot';
    img.src = URL.createObjectURL(new Blob([bytes], { type: mime }));
    return img;
  }
  if (att.type === 'audio' && mime.startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.className = 'fr-attachment';
    audio.controls = true;
    audio.src = URL.createObjectURL(new Blob([bytes], { type: mime }));
    return audio;
  }
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = `Attachment of unsupported type (${mime || 'unknown'}).`;
  return p;
}

// renderResults paints the decrypt results into the list, replacing whatever was
// there. textContent everywhere — feedback text is untrusted user input.
//
// onAck(item, li), when supplied, adds a per-item delete control — but ONLY to
// an item that decrypted and painted. An item that failed gets no control at
// all, so "never ack what the developer has not seen" is a property of the
// markup rather than a rule someone has to remember (bd med-rbl.3).
export function renderResults(list, results, onAck) {
  if (!list) return;
  list.replaceChildren();
  for (const res of results) {
    const li = document.createElement('li');
    li.className = 'fr-item';

    const meta = document.createElement('p');
    meta.className = 'muted fr-meta';
    meta.textContent = metaLine(res.item);
    li.append(meta);

    if (res.error) {
      const err = document.createElement('p');
      err.className = 'wizard-error';
      err.textContent = res.error;
      li.append(err);
      list.append(li);
      continue;
    }

    const body = document.createElement('p');
    body.className = 'fr-text';
    body.textContent = res.doc.text || '(no text)';
    li.append(body);

    for (const att of Array.isArray(res.doc.attachments) ? res.doc.attachments : []) {
      li.append(renderAttachment(att));
    }
    if (onAck) {
      const ack = document.createElement('button');
      ack.type = 'button';
      ack.className = 'secondary fr-ack';
      ack.textContent = 'Delete';
      ack.addEventListener('click', () => {
        ack.disabled = true;
        Promise.resolve(onAck(res.item, li))
          .catch(() => {})
          .then(() => { ack.disabled = false; });
      });
      li.append(ack);
    }
    list.append(li);
  }
}

// mount wires the page: pull the token out of the fragment, scrub it from the
// address bar, load the queue, then decrypt on demand with the pasted key.
export async function mount() {
  const status = el('fr-status');
  const error = el('fr-error');
  const keyRow = el('fr-key-row');
  const keyInput = el('fr-key');
  const button = el('fr-decrypt');
  const ackAll = el('fr-ack-all');
  const list = el('fr-items');

  const token = readToken(window.location.hash);
  // Strip the token from the visible URL before anything else: it should not sit
  // in the address bar to be shoulder-surfed, screenshotted, or copied onward.
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname);
  }
  // Clear the key field if the tab is being backgrounded/closed. pagehide fires
  // on bfcache navigations too, where a plain unload does not.
  window.addEventListener('pagehide', () => {
    if (keyInput) keyInput.value = '';
  });

  if (!token) {
    setText(status, MSG.noToken);
    return; // No token: nothing to fetch, and no request to leak an empty one.
  }

  setText(status, 'Loading queue…');
  const { ok, status: code, items } = await fetchQueue(token);
  if (!ok) {
    setText(status, code === 401 ? MSG.expired : MSG.fetchFailed);
    return;
  }
  if (items.length === 0) {
    setText(status, MSG.empty);
    return;
  }
  setText(status, `${items.length} item${items.length === 1 ? '' : 's'} waiting. The key is used here only — it is never sent to the server.`);
  if (keyRow) keyRow.hidden = false;

  // Ack state: the local snapshot of the queue, the ids currently on screen WITH
  // their plaintext visible, and the results they came from. Nothing outside
  // readIds is ever eligible for deletion.
  let queue = items;
  let readIds = [];
  let lastResults = [];

  const refreshAckAll = () => {
    if (!ackAll) return;
    ackAll.hidden = readIds.length === 0;
    ackAll.textContent = `Delete all ${readIds.length} read`;
  };

  // Drop acked ids from the local snapshot as well as the screen. Without this,
  // pressing Decrypt a second time in the same session would re-render rows that
  // are no longer in the queue — the page would claim there is unread feedback
  // after it has been drained.
  const dropAcked = (ids) => {
    const gone = new Set(ids);
    queue = queue.filter((it) => !gone.has(it.id));
    lastResults = lastResults.filter((r) => !gone.has(r.item.id));
  };

  const ackOne = async (it, li) => {
    setText(error, '');
    if (!(await ackItems(token, [it.id]))) {
      setText(error, MSG.ackFailed);
      return;
    }
    li.remove();
    dropAcked([it.id]);
    readIds = readIds.filter((id) => id !== it.id);
    refreshAckAll();
  };

  const ackRead = async () => {
    if (readIds.length === 0) return;
    setText(error, '');
    if (!(await ackItems(token, readIds))) {
      setText(error, MSG.ackFailed);
      return;
    }
    dropAcked(readIds);
    readIds = [];
    // What survives dropAcked is exactly the items that did NOT decrypt. They
    // were never read, so they were never acked, and they must stay on screen
    // (and in the queue) for cmd/feedbackpull to look at.
    const stuck = lastResults;
    renderResults(list, stuck);
    refreshAckAll();
    setText(status, stuck.length === 0 ? MSG.allAcked : `${stuck.length} item${stuck.length === 1 ? '' : 's'} could not be read — left in the queue.`);
  };

  const decrypt = async () => {
    if (!keyInput) return;
    // Read and clear in one step, so the DOM stops holding the key immediately.
    let identity = keyInput.value.trim();
    keyInput.value = '';
    if (!identity) {
      setText(error, MSG.needKey);
      return;
    }
    setText(error, '');
    try {
      const results = await decryptAll(queue, identity);
      lastResults = results;
      readIds = results.filter((r) => r.doc).map((r) => r.item.id);
      renderResults(list, results, ackOne);
      refreshAckAll();
      setText(status, `${results.length} item${results.length === 1 ? '' : 's'}.`);
    } catch (err) {
      // Only our own fixed messages reach the DOM (decryptAll throws MSG.badKey
      // and nothing else); anything unexpected degrades to a constant.
      setText(error, err && err.message === MSG.badKey ? MSG.badKey : MSG.fetchFailed);
    } finally {
      identity = null; // drop the last reference we hold
    }
  };

  if (button) button.addEventListener('click', () => { decrypt().catch(() => {}); });
  if (ackAll) ackAll.addEventListener('click', () => { ackRead().catch(() => {}); });
  if (keyInput) {
    keyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') decrypt().catch(() => {});
    });
  }
}

// Auto-mount only on the real page (feedback.html sets the marker); importing
// this module in a test must not kick off a fetch.
if (typeof document !== 'undefined' && document.body && document.body.dataset.page === 'feedback-reader') {
  mount().catch(() => {});
}
