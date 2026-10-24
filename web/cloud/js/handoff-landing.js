// handoff-landing.js — the add-device hand-off, https://<base>/d/<sub>#<slot>.<TK>
// (bd med-r1j2.4; design: screens-add-device.html AD8, AD8 · no code, AD8 ·
// desktop). The twin of invite-landing.js for the QR an unlocked device shows
// in Settings → Devices & connectors → Add a device (transfer.js).
//
// Shown only when the universal link / App Link did not open the app. sub from
// the path, the code from the fragment (fragments never reach a server). No
// request at all: the slot is read by /claim on the account host.
//
//   fragment + iPhone/Android -> AD8: Open in the app (medtracker://d/…),
//                                Get the app (copies this link first, then the
//                                store; no Play referrer: the code stays off
//                                Google's servers), Continue in this browser
//                                (https://<sub>.<base>/claim#<frag>)
//   no fragment, or a computer -> AD8 · no code / desktop: the typed "Code for
//                                a computer" (28 letters, prefilled from a
//                                fragment) → /claim#<slot>.<TK>
// Every screen ends with "Already set up in this browser? Open my account"
// (Path 0, AD10): InviteSheet.parseAddress's /unlock URL for <sub>.<base>.
//
// Strict CSP (script-src 'self', no inline): createElement/textContent and
// addEventListener only, classes from components.css / cloud.css.
import { appStoreHref, playHref, detectPlatform } from './invite-landing.js';
import { decodeTransferCode, encodeTransferCode, fromBase64Url, toBase64Url, transferSlotId } from './crypto.js';

const SUB_RE = /^\/d\/([a-z0-9-]+)$/;
const FRAG_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export const COPY = {
  lede: 'Your other device made this link. It works once, for 10 minutes.',
  openApp: 'Open in the app',
  getIOS: 'Get the app for iPhone',
  getAndroid: 'Get the app for Android',
  browser: 'Continue in this browser',
  missingTitle: 'This link is missing its code',
  missingLede: 'Some apps cut links short. Scan the code again on your other device, or type the code shown under it.',
  deskTitle: 'Add this browser to your account',
  deskLede: 'Type the code your other device shows under the QR.',
  codeLabel: 'Code for a computer',
  codePlaceholder: 'KXR QDW BMT LPA ZRE HNV CUG YSF TJO W',
  continue: 'Continue',
  deskHint: 'Works once · expires 10 minutes after it was made',
  openAccount: 'Already set up in this browser? Open my account',
  incomplete: 'This link is incomplete. Scan the code again on your other device.',
};

// parseHandoffLink(pathname, hash) -> { sub, frag } ('' for a missing or
// malformed part). Raw, no percent-decoding (the shells' parse rules).
export function parseHandoffLink(pathname, hash) {
  const m = SUB_RE.exec(String(pathname || '').toLowerCase());
  const frag = String(hash || '').replace(/^#/, '');
  return { sub: m ? m[1] : '', frag: FRAG_RE.test(frag) ? frag : '' };
}

// The decoder target on the account host. http only when this page is (dev).
export function claimHref(location, sub, frag) {
  const scheme = location.protocol === 'http:' ? 'http://' : 'https://';
  return scheme + sub + '.' + location.host + '/claim#' + frag;
}

export function appSchemeHref(sub, frag) {
  return 'medtracker://d/' + sub + '#' + frag;
}

// The typed code (any case, with or without spaces) as the claim fragment, or
// '' while it is not 28 valid letters.
export async function fragFromCode(text) {
  let tk;
  try {
    tk = decodeTransferCode(text);
  } catch {
    return '';
  }
  return (await transferSlotId(tk)) + '.' + toBase64Url(tk);
}

function codeFromFrag(frag) {
  try {
    return encodeTransferCode(fromBase64Url(frag.slice(frag.indexOf('.') + 1)));
  } catch {
    return '';
  }
}

function meta(root, name) {
  const m = root.querySelector(`meta[name="${name}"]`);
  return m ? m.getAttribute('content') || '' : '';
}

export async function mount(root = document, deps = {}) {
  const {
    location = globalThis.location,
    navigator: nav = globalThis.navigator,
    platform = detectPlatform(),
    inviteSheet = globalThis.InviteSheet,
  } = deps;
  const clipboard = nav && nav.clipboard ? nav.clipboard : null;
  const app = root.getElementById('handoff-app');
  const make = (tag, cls, text) => {
    const n = root.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
  const go = (url) => {
    location.href = url;
  };
  const button = (id, kind, label, onClick) => {
    const b = make('button', 'wg-btn' + (kind ? ' ' + kind : ''), label);
    b.type = 'button';
    b.id = id;
    b.addEventListener('click', onClick);
    return b;
  };

  const { sub, frag } = parseHandoffLink(location.pathname, location.hash);
  if (!sub) {
    const shell = make('div', 'wg-shell wg-shell--center');
    shell.append(make('h1', 'wg-shell__title wg-shell__title--md', 'Add this device'), make('p', 'wg-shell__lede', COPY.incomplete));
    app.replaceChildren(shell);
    return;
  }
  // Path 0 (AD10): Webb's strict address check; a host it refuses (dev ports)
  // just hides the link.
  const unlockUrl = inviteSheet && typeof inviteSheet.parseAddress === 'function'
    ? inviteSheet.parseAddress(sub + '.' + location.host, location.host)
    : null;
  const openAccount = unlockUrl ? button('handoff-open-account', 'wg-btn--ghost wg-btn--sm', COPY.openAccount, () => go(unlockUrl)) : null;

  const hydrate = () => {
    if (globalThis.WGIcons && typeof globalThis.WGIcons.hydrate === 'function') globalThis.WGIcons.hydrate(app);
  };

  if (frag && platform !== 'desktop') {
    // AD8: the sun for the likely path (the other device has the app).
    const ios = platform === 'ios';
    const shell = make('div', 'wg-shell wg-shell--center');
    const mark = make('span', 'wg-mark wg-mark--lg');
    const ico = make('i', 'wg-ico');
    ico.dataset.icon = 'pill';
    mark.append(ico);
    shell.append(mark, make('h1', 'wg-shell__title wg-shell__title--md', `Add this ${ios ? 'iPhone' : 'phone'} to your account`),
      make('p', 'wg-shell__lede', COPY.lede));
    const foot = make('footer', 'wg-shell__foot');
    foot.append(button('handoff-open', 'wg-btn--primary wg-btn--lg', COPY.openApp, () => go(appSchemeHref(sub, frag))));
    const store = ios ? appStoreHref(meta(root, 'medtracker-ios-app-store-id')) : playHref(meta(root, 'medtracker-android-package'));
    if (store) {
      const link = location.origin + '/d/' + sub + '#' + frag;
      foot.append(button('handoff-get', '', ios ? COPY.getIOS : COPY.getAndroid, () => {
        // Copy first, inside the tap, so the app can pick the link up after
        // the install; then the store whether or not the copy worked.
        let copied;
        try {
          copied = Promise.resolve(clipboard && clipboard.writeText(link));
        } catch {
          copied = Promise.resolve();
        }
        return copied.catch(() => {}).then(() => go(store));
      }));
    }
    foot.append(button('handoff-browser', 'wg-btn--ghost', COPY.browser, () => go(claimHref(location, sub, frag))));
    if (openAccount) foot.append(openAccount);
    app.replaceChildren(shell, foot);
    hydrate();
    return;
  }

  // AD8 · no code (phone, the fragment cut off) / AD8 · desktop (a computer).
  const desk = platform === 'desktop';
  const shell = make('div', desk ? 'wg-shell wg-shell--center' : 'wg-shell');
  if (desk) {
    const mark = make('span', 'wg-mark');
    const ico = make('i', 'wg-ico');
    ico.dataset.icon = 'pill';
    mark.append(ico);
    shell.append(mark, make('h1', 'wg-shell__title', COPY.deskTitle), make('p', 'wg-shell__lede', COPY.deskLede));
  } else {
    const warn = make('span', 'wg-shell__icon wg-shell__icon--warn');
    const ico = make('i', 'wg-ico');
    ico.dataset.icon = 'link';
    warn.append(ico);
    const head = make('div', 'wg-vstack');
    head.append(make('h1', 'wg-shell__title wg-shell__title--md', COPY.missingTitle), make('p', 'wg-shell__lede', COPY.missingLede));
    shell.append(warn, head);
  }
  const field = make('div', 'wg-field');
  const label = make('label', 'wg-label', COPY.codeLabel);
  label.htmlFor = 'handoff-code';
  const input = make('textarea', 'wg-input wg-input--code');
  input.id = 'handoff-code';
  input.rows = 2;
  input.placeholder = COPY.codePlaceholder;
  input.setAttribute('autocapitalize', 'characters');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');
  if (frag) input.value = codeFromFrag(frag);
  field.append(label, input);
  let typed = '';
  const cont = button('handoff-continue', 'wg-btn--primary wg-btn--lg' + (desk ? ' wg-btn--block' : ''), COPY.continue, () => {
    if (typed) go(claimHref(location, sub, typed));
  });
  cont.disabled = true;
  // Continue stays off until all 28 letters decode.
  const check = async () => {
    const value = input.value;
    const next = await fragFromCode(value);
    if (input.value !== value) return; // a later keystroke owns the answer
    typed = next;
    cont.disabled = !typed;
  };
  input.addEventListener('input', check);
  if (desk) {
    const col = make('div', 'wg-vstack');
    col.append(field, cont, make('p', 'wg-hint', COPY.deskHint));
    shell.append(col);
    if (openAccount) shell.append(openAccount);
    app.replaceChildren(shell);
  } else {
    shell.append(field);
    const foot = make('footer', 'wg-pagefoot');
    foot.append(cont);
    if (openAccount) foot.append(openAccount);
    app.replaceChildren(shell, foot);
  }
  hydrate();
  await check();
}

// Auto-mount only on the real page (handoff.html sets the marker).
if (typeof document !== 'undefined' && document.body && document.body.dataset.page === 'handoff-landing') {
  mount().catch(() => {});
}
