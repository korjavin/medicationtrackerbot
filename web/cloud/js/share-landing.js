// share-landing.js — base-domain landing page for the blind workout-share
// short link (bd med-1yi5.2).
//
// A plain phone camera opens the short URL in a browser; this page expands it
// back into the plan without ever sending the key (or the plan) anywhere but
// the account subdomain the visitor picks. Flow:
//
//   id from location.pathname (/s/<id>), K from the URL fragment (base64url
//   of the 16 raw key bytes — fragments never reach a server) ->
//   GET /api/s/<id> (same origin; the only request this page makes) ->
//   AES-GCM decrypt (decryptSharePayload, AAD mt/v1/share) -> the sender's
//   p1 token string -> base64url + gunzip -> { v:1, plan } -> read-only
//   preview.
//
// Then the visitor either hands the bare p1 token to their own account app
// through the existing #share-plan deeplink ("Add to my Med Tracker"), or
// copies the bare token for an app on another instance ("Copy plan code").
//
// Privacy: K, the token and the plan never leave the page (no analytics, no
// other requests). The preview renders attacker-supplied ciphertext, so it is
// built with createElement/textContent only — never innerHTML with plan data.
// CSP is the strict default (script-src 'self', no inline): no inline
// handlers or styles here, only addEventListener and classes from
// /css/cloud.css.
import {
  decryptSharePayload,
  fromBase64,
  fromBase64Url,
  gunzip,
} from './crypto.js';

// Fixed user-facing strings. Decrypt/decode failures all map to notPlan so a
// wrong key is indistinguishable from a corrupt payload.
export const MSG = {
  incomplete: 'This link is incomplete — ask the sender to resend it.',
  expired: 'This link has expired or was never valid.',
  loadFailed: "Couldn't load the plan — try again in a minute.",
  notPlan: "That link doesn't carry a workout plan.",
  badHome: 'That address needs lowercase letters, numbers and dashes only (up to 63 characters).',
  copied: 'Copied',
};

export const SHARE_API_PREFIX = '/api/s/';
// Server caps stored ciphertext at 16 KiB (wire contract); anything larger on
// the read path is not a real share.
export const MAX_PACKED_BYTES = 16384;
// Gzip-bomb guard on the inflated export payload (same reasoning as
// share.js SHARE_IMPORT_MAX_TOKEN_CHARS).
export const MAX_JSON_BYTES = 1024 * 1024;
export const HOME_KEY = 'mt-share-home';
export const SUBDOMAIN_RE = /^[a-z0-9-]{1,63}$/;

// parseShareLink(pathname, hash) -> { id, key }. key is the 16 raw key bytes,
// or null when the fragment is missing or malformed. Never throws: malformed
// input is an ordinary "ask the sender to resend it" state, not an exception.
export function parseShareLink(pathname, hash) {
  const m = /^\/s\/([^/?#]+)/.exec(String(pathname || ''));
  const id = m ? m[1] : '';
  const frag = String(hash || '');
  const enc = frag.startsWith('#') ? frag.slice(1) : frag;
  let key = null;
  try {
    const bytes = fromBase64Url(enc);
    if (bytes.length === 16) key = bytes;
  } catch {
    key = null;
  }
  return { id, key };
}

// decodeSharedPlan(packed, key) -> { token, doc }. Throws on anything that is
// not a well-formed share: oversize blob, AEAD failure (wrong K / tamper),
// non-token plaintext, bad gzip, oversize JSON, or a payload that is not a
// v1 export ({ v:1, plan:{ name, days:[...] } }). Callers map every throw to
// one generic message.
export async function decodeSharedPlan(packed, key) {
  if (!packed || packed.length === 0 || packed.length > MAX_PACKED_BYTES) {
    throw new Error('bad packed length');
  }
  const pt = await decryptSharePayload(key, packed);
  const token = new TextDecoder().decode(pt);
  if (!token.startsWith('p1.')) throw new Error('not a p1 token');
  const jsonBytes = await gunzip(fromBase64Url(token.slice(3)));
  if (jsonBytes.length > MAX_JSON_BYTES) throw new Error('plan too large');
  const doc = JSON.parse(new TextDecoder().decode(jsonBytes));
  if (!doc || doc.v !== 1 || !doc.plan || typeof doc.plan !== 'object') {
    throw new Error('not a v1 plan export');
  }
  if (!Array.isArray(doc.plan.days)) throw new Error('plan has no days');
  return { token, doc };
}

// appHref(location, sub, token) — the EXISTING #share-plan deeplink onto the
// visitor's account subdomain (deeplink-router.js), so the handoff needs zero
// app-side change. http only when the landing page itself is http (dev).
// Built by concatenation: no host literal, nothing for the privacy-claims
// host scan to flag.
export function appHref(location, sub, token) {
  const scheme = location.protocol === 'http:' ? 'http://' : 'https://';
  return scheme + sub + '.' + location.host + '/#share-plan=' + token;
}

function readHome(storage) {
  try {
    return storage ? storage.getItem(HOME_KEY) || '' : '';
  } catch {
    return '';
  }
}

function writeHome(storage, sub) {
  try {
    if (storage) storage.setItem(HOME_KEY, sub);
  } catch {
    // Private-mode storage (or none): remembering the address is a
    // convenience, never a reason to block the handoff.
  }
}

// renderPreview(previewEl, doc) — read-only plan summary. textContent
// everywhere: the plan is attacker-supplied ciphertext decrypted client-side.
export function renderPreview(previewEl, doc) {
  const owner = previewEl.ownerDocument;
  previewEl.replaceChildren();
  const days = doc.plan.days;
  const title = owner.createElement('h2');
  title.textContent =
    typeof doc.plan.name === 'string' && doc.plan.name ? doc.plan.name : 'Shared workout plan';
  previewEl.append(title);

  const total = days.reduce(
    (n, d) => n + (d && Array.isArray(d.exercises) ? d.exercises.length : 0),
    0
  );
  const counts = owner.createElement('p');
  counts.className = 'muted';
  counts.textContent = `${days.length} days · ${total} exercises`;
  previewEl.append(counts);

  days.forEach((day, i) => {
    const label = owner.createElement('h3');
    label.textContent =
      day && typeof day.name === 'string' && day.name ? day.name : `Day ${i + 1}`;
    previewEl.append(label);
    const ul = owner.createElement('ul');
    const exercises = day && Array.isArray(day.exercises) ? day.exercises : [];
    for (const ex of exercises) {
      const li = owner.createElement('li');
      li.textContent =
        ex && typeof ex.name === 'string' && ex.name ? ex.name : 'Exercise';
      ul.append(li);
    }
    previewEl.append(ul);
  });
}

function setText(node, text) {
  if (node) node.textContent = text;
}

// mount(root, deps) — wire the page. Seams (fetchImpl, location, storage,
// clipboard) are injectable so tests need no globals; production calls
// mount() bare and the defaults read the live browser environment.
export async function mount(root = document, deps = {}) {
  const {
    fetchImpl = (...args) => globalThis.fetch(...args),
    location = globalThis.location,
    storage = (() => {
      try {
        return globalThis.localStorage;
      } catch {
        return null;
      }
    })(),
    clipboard =
      globalThis.navigator && globalThis.navigator.clipboard
        ? globalThis.navigator.clipboard
        : null,
  } = deps;

  const el = (id) => root.getElementById(id);
  const status = el('share-status');
  const preview = el('share-preview');
  const actions = el('share-actions');
  const home = el('share-home');
  const suffix = el('share-home-suffix');
  const add = el('share-add');
  const copy = el('share-copy');

  const { id, key } = parseShareLink(location.pathname, location.hash);
  if (!key) {
    setText(status, MSG.incomplete);
    return; // No key: nothing to fetch, and no request to waste.
  }
  if (!id) {
    setText(status, MSG.expired);
    return;
  }

  let res;
  try {
    res = await fetchImpl(SHARE_API_PREFIX + id, { cache: 'no-store' });
  } catch {
    setText(status, MSG.loadFailed);
    return;
  }
  if (res.status === 404) {
    setText(status, MSG.expired);
    return;
  }
  if (!res.ok) {
    setText(status, MSG.loadFailed);
    return;
  }
  let packed;
  try {
    const body = await res.json();
    packed = fromBase64(String((body && body.ct) || ''));
  } catch {
    setText(status, MSG.loadFailed);
    return;
  }

  let token;
  let doc;
  try {
    ({ token, doc } = await decodeSharedPlan(packed, key));
  } catch {
    setText(status, MSG.notPlan);
    return;
  }

  setText(status, '');
  if (preview) {
    renderPreview(preview, doc);
    preview.hidden = false;
  }
  if (!actions) return;
  actions.hidden = false;
  setText(suffix, '.' + location.host);
  if (home) home.value = readHome(storage);

  // Inline validation error node, created once. A wizard-error paragraph keeps
  // the message next to the field without touching the epic-fixed skeleton.
  let homeError = el('share-error');
  if (!homeError) {
    homeError = actions.ownerDocument.createElement('p');
    homeError.id = 'share-error';
    homeError.className = 'wizard-error';
    actions.append(homeError);
  }

  if (add) {
    add.addEventListener('click', () => {
      const sub = home ? home.value.trim().toLowerCase() : '';
      if (!SUBDOMAIN_RE.test(sub)) {
        setText(homeError, MSG.badHome);
        return;
      }
      setText(homeError, '');
      writeHome(storage, sub);
      location.href = appHref(location, sub, token);
    });
  }

  if (copy) {
    copy.addEventListener('click', () => {
      const done = () => {
        copy.textContent = MSG.copied;
      };
      if (clipboard && typeof clipboard.writeText === 'function') {
        Promise.resolve()
          .then(() => clipboard.writeText(token))
          .then(done)
          .catch(() => showTokenFallback(actions, token));
        return;
      }
      showTokenFallback(actions, token);
    });
  }
}

// showTokenFallback — no clipboard API (or it refused): render the bare token
// in a readonly textarea so it can still be selected and copied by hand. The
// app's paste field accepts the bare token (share.js decodeShareToken).
export function showTokenFallback(actions, token) {
  if (!actions) return;
  let area = actions.ownerDocument.getElementById('share-token-fallback');
  if (!area) {
    area = actions.ownerDocument.createElement('textarea');
    area.id = 'share-token-fallback';
    area.readOnly = true;
    area.rows = 4;
    actions.append(area);
  }
  area.value = token;
}

// Auto-mount only on the real page (share.html sets the marker); importing
// this module in a test must not kick off a fetch.
if (
  typeof document !== 'undefined' &&
  document.body &&
  document.body.dataset.page === 'share-landing'
) {
  mount().catch(() => {});
}
