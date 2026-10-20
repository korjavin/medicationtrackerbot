// invite-landing.js — the invite landing page, https://<base>/i/<sub>#<token>
// (bd med-ta2n.10; design: screens-onboarding-v3.html L1-L3; contract: the
// design field of med-ta2n.7, sections 1 and 4).
//
// sub from the path, token from the fragment (fragments never reach a server).
// ONE same-origin request: GET /api/i/<sub> -> {state, expires_at?}; it never
// carries the token. Then, by state and platform:
//
//   pending + iPhone  -> L1 (Get the app for iPhone) -> L3 after the tap,
//                        sticky for this tab (sessionStorage)
//   pending + Android -> L1 · Android (Play link carries the invite as the
//                        install referrer) -> "Opening the app…"
//   pending + desktop -> L2 (QR of this page's full URL)
//   expired / claimed -> L1 · expired
//
// "Get the app" copies this page's URL to the clipboard first (the F1 Paste
// fallback when no referrer / no return to Safari reaches the app), then opens
// the store. "Continue in the browser" goes to the old claim form
// https://<sub>.<base>/#claim=<token>. Store ids come from the metas the server
// splices after <head>; a missing one hides that platform's store buttons.
//
// Strict CSP (script-src 'self', no inline): createElement/textContent and
// addEventListener only, classes from components.css / cloud.css. No analytics.
import { isIOS, isMobile } from './platform.js';

export const STATUS_API_PREFIX = '/api/i/';
export const L3_KEY_PREFIX = 'mt-invite-l3:';
export const ASK_TEXT = 'My Med Tracker invite has expired — could you send me a new one?';
// Contract A2 (med-ta2n.7 design): the sub is lowercased, then must match
// [a-z0-9-]+; the token is lowercase hex as minted (NewClaimToken). Raw path and
// fragment — no percent-decoding — the same rules as the shells' parseInvite.
const SUB_RE = /^\/i\/([a-z0-9-]+)$/;
const TOKEN_RE = /^[0-9a-f]+$/;

export const COPY = {
  title: "You're invited to Med Tracker",
  lede: 'A private log for your meds, blood pressure, weight and training.',
  getIOS: 'Get the app for iPhone',
  getAndroid: 'Get the app for Android',
  browser: 'Continue in the browser',
  browserDesk: 'Continue in this browser instead',
  scan: "Scan with your phone's camera",
  scanHint: 'It opens this invite on your phone, ready to install.',
  opening: 'Opening the app…',
  l3Title: 'Installed? Tap to continue',
  l3Lede: 'Opens Med Tracker with your invite, so you skip the setup.',
  l3Steps: ['Get the app from the App Store', 'Come back to this page', 'Tap Open in the app'],
  openApp: 'Open in the app',
  storeAgain: 'Open the App Store again',
  expiredTitle: 'This invite has expired',
  expiredLede: 'Invites work once, for 14 days. Ask the person who sent it for a new link.',
  ask: 'Ask for a new invite',
  anyway: 'Get the app anyway',
  askCopied: 'Message copied — send it to the person who invited you.',
  incomplete: 'This invite link is incomplete. Open the full link you were sent.',
};

// parseInviteLink(pathname, hash) -> { sub, token } ('' for a missing or
// malformed part). Never throws.
export function parseInviteLink(pathname, hash) {
  const m = SUB_RE.exec(String(pathname || '').toLowerCase());
  const frag = String(hash || '').replace(/^#/, '');
  return { sub: m ? m[1] : '', token: TOKEN_RE.test(frag) ? frag : '' };
}

// claimHref — the old claim form on the account host. http only when this page
// is http (dev). Concatenation, no host literal.
export function claimHref(location, sub, token) {
  const scheme = location.protocol === 'http:' ? 'http://' : 'https://';
  return scheme + sub + '.' + location.host + '/#claim=' + token;
}

// landingHref — this page's canonical URL, origin + /i/<sub> + #<token>.
export function landingHref(location, sub, token) {
  return location.origin + '/i/' + sub + '#' + token;
}

export function appSchemeHref(sub, token) {
  return 'medtracker://i/' + sub + '#' + token;
}

export function appStoreHref(id) {
  return id ? 'https://apps.apple.com/app/id' + encodeURIComponent(id) : '';
}

// playHref(pkg, landingUrl?) — with a landing URL the invite rides the install
// referrer: referrer = encodeURIComponent("invite=" + encodeURIComponent(url)),
// so the app's installReferrer reads "invite=<percent-encoded landing URL>".
export function playHref(pkg, landingUrl) {
  if (!pkg) return '';
  const base = 'https://play.google.com/store/apps/details?id=' + encodeURIComponent(pkg);
  return landingUrl
    ? base + '&referrer=' + encodeURIComponent('invite=' + encodeURIComponent(landingUrl))
    : base;
}

export function detectPlatform() {
  if (isIOS()) return 'ios';
  return isMobile() ? 'android' : 'desktop';
}

// "3 Nov" — the frames' short day-month; '' for a missing or bad date.
export function formatExpiry(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function meta(root, name) {
  const m = root.querySelector(`meta[name="${name}"]`);
  return m ? m.getAttribute('content') || '' : '';
}

function storageGet(storage, key) {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

function storageSet(storage, key) {
  try {
    if (storage) storage.setItem(key, '1');
  } catch {
    // Private mode: L3 just won't survive a reload; the tap still works.
  }
}

async function fetchState(fetchImpl, sub) {
  try {
    const res = await fetchImpl(STATUS_API_PREFIX + sub, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body.state === 'string' ? body : null;
  } catch {
    return null;
  }
}

// mount(root, deps) — wire the page. Seams are injectable so tests need no
// globals; production calls mount() bare.
export async function mount(root = document, deps = {}) {
  const {
    fetchImpl = (...args) => globalThis.fetch(...args),
    location = globalThis.location,
    storage = (() => {
      try {
        return globalThis.sessionStorage;
      } catch {
        return null;
      }
    })(),
    navigator: nav = globalThis.navigator,
    platform = detectPlatform(),
    loadQr = () => import('../vendor/qrcode.mjs'),
  } = deps;
  const clipboard = nav && nav.clipboard ? nav.clipboard : null;
  const app = root.getElementById('invite-app');
  const make = (tag, cls, text) => {
    const n = root.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };

  const { sub, token } = parseInviteLink(location.pathname, location.hash);
  if (!sub || !token) {
    render({ title: 'Your invite', lede: COPY.incomplete });
    return;
  }

  // Canonical, never location.href: a ?query (e.g. a tracker a messenger
  // appended) must not ride into the Play referrer, the clipboard or the QR —
  // the shells' parseInvite rejects a landing URL with a query (contract §1).
  const landingUrl = landingHref(location, sub, token);
  const iosId = meta(root, 'medtracker-ios-app-store-id');
  const pkg = meta(root, 'medtracker-android-package');
  const l3Key = L3_KEY_PREFIX + sub;
  const go = (url) => {
    location.href = url;
  };
  const toBrowser = () => go(claimHref(location, sub, token));
  // Copy first (from the tap, so it keeps the user activation), then open the
  // store whether or not the copy worked.
  const copyThen = (url) => {
    let copied;
    try {
      copied = Promise.resolve(clipboard && clipboard.writeText(landingUrl));
    } catch {
      copied = Promise.resolve();
    }
    return copied.catch(() => {}).then(() => go(url));
  };

  // render({title, lede, steps?, qr?, buttons, hint?}) — one kit screen. Mobile
  // buttons dock in the footer; the desktop screen keeps them in the column.
  function render(view) {
    const shell = make('div', 'wg-shell wg-shell--center');
    const mark = make('span', 'wg-mark wg-mark--lg');
    const ico = make('i', 'wg-ico');
    ico.dataset.icon = 'pill';
    mark.append(ico);
    shell.append(mark, make('h1', 'wg-shell__title wg-shell__title--md', view.title));
    shell.append(make('p', 'wg-shell__lede', view.lede));
    if (view.steps) {
      const ol = make('ol', 'wg-olist');
      for (const s of view.steps) ol.append(make('li', '', s));
      shell.append(ol);
    }
    const nodes = [];
    for (const b of view.buttons || []) {
      const btn = make('button', 'wg-btn ' + (b.kind || ''), '');
      btn.type = 'button';
      btn.id = b.id;
      if (b.icon) {
        const i = make('i', 'wg-ico');
        i.dataset.icon = b.icon;
        btn.append(i);
      }
      btn.append(b.label);
      btn.addEventListener('click', b.onClick);
      nodes.push(btn);
    }
    let hint = null;
    if (view.hint !== undefined) {
      hint = make('p', 'wg-hint', view.hint);
      hint.id = 'invite-hint';
    }
    if (view.qr) {
      shell.append(view.qr, make('p', 'wg-shell__lede', COPY.scan), make('p', 'wg-hint', COPY.scanHint));
      shell.append(...nodes);
      app.replaceChildren(shell);
    } else {
      const foot = make('footer', 'wg-shell__foot');
      foot.append(...nodes);
      if (hint) foot.append(hint);
      app.replaceChildren(shell, foot);
    }
    if (globalThis.WGIcons && typeof globalThis.WGIcons.hydrate === 'function') {
      globalThis.WGIcons.hydrate(app);
    }
    return hint;
  }

  const browserBtn = { id: 'invite-browser', label: COPY.browser, kind: 'wg-btn--ghost', onClick: toBrowser };
  const expiryHint = (body) => {
    const date = formatExpiry(body && body.expires_at);
    return date ? `This invite works once and expires on ${date}.` : '';
  };

  const body = await fetchState(fetchImpl, sub);
  const state = body ? body.state : 'pending'; // unreachable API: let the claim page decide

  if (state !== 'pending') {
    const store = platform === 'ios' ? appStoreHref(iosId) : platform === 'android' ? playHref(pkg) : '';
    const buttons = [{ id: 'invite-ask', label: COPY.ask, kind: 'wg-btn--primary wg-btn--lg', icon: 'message', onClick: ask }];
    if (store) buttons.push({ id: 'invite-anyway', label: COPY.anyway, onClick: () => go(store) });
    const hint = render({ title: COPY.expiredTitle, lede: COPY.expiredLede, buttons, hint: '' });
    async function ask() {
      if (nav && typeof nav.share === 'function') {
        try {
          await nav.share({ text: ASK_TEXT });
        } catch {
          // Dismissed share sheet: nothing to do.
        }
        return;
      }
      try {
        await clipboard.writeText(ASK_TEXT);
        hint.textContent = COPY.askCopied;
      } catch {
        hint.textContent = ASK_TEXT; // no clipboard: show it to copy by hand
      }
    }
    return;
  }

  const hintText = expiryHint(body);

  if (platform === 'desktop') {
    const qr = make('span', 'wg-qr');
    qr.id = 'invite-qr';
    try {
      const { qrcode } = await loadQr();
      const code = qrcode(0, 'M');
      code.addData(landingUrl);
      code.make();
      // Generated module paths only — the URL is not echoed into the markup.
      qr.innerHTML = code.createSvgTag(4);
    } catch {
      qr.hidden = true;
    }
    render({
      title: COPY.title,
      lede: COPY.lede,
      qr,
      buttons: [{ id: 'invite-browser', label: COPY.browserDesk, kind: 'wg-btn--ghost', onClick: toBrowser }],
    });
    return;
  }

  if (platform === 'android') {
    const store = playHref(pkg, landingUrl);
    const showL1 = (title) =>
      render({
        title,
        lede: COPY.lede,
        buttons: [
          ...(store ? [{ id: 'invite-get', label: COPY.getAndroid, kind: 'wg-btn--primary wg-btn--lg', onClick: getApp }] : []),
          browserBtn,
        ],
        hint: hintText,
      });
    function getApp() {
      showL1(COPY.opening);
      return copyThen(store);
    }
    showL1(COPY.title);
    return;
  }

  // iPhone (and iPad).
  const store = appStoreHref(iosId);
  const showL3 = () =>
    render({
      title: COPY.l3Title,
      lede: COPY.l3Lede,
      steps: COPY.l3Steps,
      buttons: [
        { id: 'invite-open', label: COPY.openApp, kind: 'wg-btn--primary wg-btn--lg', onClick: () => go(appSchemeHref(sub, token)) },
        ...(store ? [{ id: 'invite-store-again', label: COPY.storeAgain, kind: 'wg-btn--ghost', onClick: getApp }] : []),
      ],
    });
  function getApp() {
    storageSet(storage, l3Key);
    showL3();
    return copyThen(store);
  }
  if (storageGet(storage, l3Key) === '1') {
    showL3();
    return;
  }
  render({
    title: COPY.title,
    lede: COPY.lede,
    buttons: [
      ...(store ? [{ id: 'invite-get', label: COPY.getIOS, kind: 'wg-btn--primary wg-btn--lg', onClick: getApp }] : []),
      browserBtn,
    ],
    hint: hintText,
  });
}

// Auto-mount only on the real page (invite.html sets the marker); importing
// this module in a test must not kick off a fetch.
if (typeof document !== 'undefined' && document.body && document.body.dataset.page === 'invite-landing') {
  mount().catch(() => {});
}
