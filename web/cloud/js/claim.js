// New-device half of "Add a device": docs/cloud-crypto.md "Path B", protocol
// v2 (epic med-r1j2, bead med-r1j2.3; screens AD5–AD7 in
// docs/design/claude-design/ui_kits/app-v2/screens-add-device.html).
//
// Reached at /claim with `#<slot>.<base64url TK>` from the QR/link, or with
// the typed "Code for a computer" (TK as 28 letters; the slot id is derived
// from it), or with `#scan` for the in-app scanner (AD13 when there is no
// camera; bd med-r1j2.10). The device reads the slot's commit, claims it with an ephemeral
// ECDH key and a MAC proving it holds TK, then waits: once the origin reveals
// its key, the commit and MAC are checked and both screens show the same
// 6-digit code. Only after the owner approves on the origin does a ciphertext
// arrive that this device alone can open; then it enrolls its own passkey.
//
// TK, the ECDH key, the derived keys and the DEK live in this module's
// closures for the page's life only: never stored, never logged.
import {
  fromBase64,
  fromBase64Url,
  toBase64,
  saltKek,
  deriveKEK,
  deriveKMac,
  wrapEnvelope,
  timingSafeEqual,
  TRANSFER_TK_BYTES,
  transferSlotId,
  decodeTransferCode,
  generateTransferKeyPair,
  transferCommit,
  transferTranscript,
  transferClaimMac,
  transferRevealMac,
  verifyTransferMac,
  deriveTransferKeys,
  unwrapTransferDek,
  transferConfirmMac,
} from './crypto.js';
import { renderUnsupportedAuthenticator } from './signup.js';
import { establishLdkCache } from './unlock.js';
import { createCredential, passkeyCeremony, prfProbe, iosShellBridge, inAndroidShell } from './passkey-get.js';
import { diagHttp } from './passkey-diag.js';

// Android shell's steady busy step (passkey-get.js passkeyCeremony).
const ENROLL_CEREMONY_COPY = {
  busy: 'Setting up your passkey…',
  hint: 'Google will then ask you to confirm the passkey you just created — choose it to finish.',
  failed: "Couldn't set up your passkey. Please try again.",
};

// Same cadence as the origin (transfer.js).
const POLL_INTERVAL_MS = 2000;

const NEW_CODE_HINT = 'Ask for a new code on your other device: Settings → Devices & connectors → Add a device.';
const OLD_CODE_ERROR = `This code is from an older version of the app and no longer works. ${NEW_CODE_HINT}`;
const BAD_CODE_ERROR = 'Enter all 28 letters exactly as shown on your other device.';

class CodeError extends Error {}

// QR/link fragment `<slot>.<base64url TK>`. The slot id is derived from TK,
// so a fragment whose halves disagree is damaged. A v1 code (random base32
// slot id, 32-byte TK) gets the "ask for a new code" answer, not a hang.
async function parseFragment(raw) {
  const dot = raw.indexOf('.');
  if (dot < 0) return null;
  let tk;
  try {
    tk = fromBase64Url(raw.slice(dot + 1));
  } catch {
    throw new CodeError(OLD_CODE_ERROR);
  }
  if (tk.length !== TRANSFER_TK_BYTES) throw new CodeError(OLD_CODE_ERROR);
  const slot = await transferSlotId(tk);
  if (raw.slice(0, dot) !== slot) throw new CodeError(OLD_CODE_ERROR);
  return { slot, tk };
}

// The typed field also takes a pasted link or fragment.
async function parseTyped(raw) {
  const text = raw.trim();
  const hash = text.indexOf('#');
  if (hash < 0) {
    try {
      const tk = decodeTransferCode(text);
      return { slot: await transferSlotId(tk), tk };
    } catch {
      if (!text.includes('.')) throw new CodeError(BAD_CODE_ERROR);
    }
  }
  const parsed = await parseFragment(hash >= 0 ? text.slice(hash + 1) : text);
  if (parsed) return parsed;
  throw new CodeError(OLD_CODE_ERROR);
}

// The only names the server accepts. Shell detection is passkey-get.js's
// (the passkey shell does not load web/static/js/native).
function currentPlatform() {
  if (iosShellBridge()) return 'ios';
  if (inAndroidShell()) return 'android';
  return 'web';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const i = el('i', 'wg-ico');
  i.dataset.icon = name;
  return i;
}

export async function runClaimFlow() {
  const app = document.getElementById('app');
  const raw = location.hash.slice(1);
  // The fragment is the secret: keep it out of the session history.
  if (raw && globalThis.history && history.replaceState) history.replaceState(null, '', location.pathname);
  if (!raw) {
    renderClaimForm(app);
    return;
  }
  // /claim#scan: the in-app scanner (/unlock AD10 · none, the /d/ landing).
  if (raw === 'scan') {
    renderScanner(app);
    return;
  }
  let parsed;
  try {
    parsed = await parseFragment(raw);
  } catch (err) {
    renderClaimForm(app, err.message);
    return;
  }
  if (parsed) startClaim(app, parsed);
  else renderClaimForm(app, OLD_CODE_ERROR);
}

// One kit screen: an optional page bar, the shell column, then the docked
// footer (`foot`: its class, the kit's .wg-shell__foot unless a page bar
// makes it a .wg-pagefoot page).
function render(app, shell, buttons = [], { bar = null, foot: footClass = 'wg-shell__foot' } = {}) {
  const screen = el('div', 'wg-app claim-page');
  if (bar) screen.append(bar);
  screen.append(shell);
  if (buttons.length) {
    const foot = el('footer', footClass);
    foot.append(...buttons);
    screen.append(foot);
  }
  app.replaceChildren(screen);
  if (globalThis.WGIcons && typeof globalThis.WGIcons.hydrate === 'function') globalThis.WGIcons.hydrate(app);
}

function button(id, label, kind, onClick, iconName) {
  const btn = el('button', `wg-btn${kind ? ` ${kind}` : ''}`);
  btn.type = 'button';
  btn.id = id;
  if (iconName) btn.append(icon(iconName));
  btn.append(label);
  btn.addEventListener('click', onClick);
  return btn;
}

// The typed "Code for a computer": its field, Continue and error line, shared
// by the form (AD8 · desktop) and the camera-off scanner (AD13). Call sync()
// once the nodes are in the page.
function codeEntry(app, errorText, submitClass) {
  const field = el('div', 'wg-field');
  const label = el('label', 'wg-label', 'Code for a computer');
  label.htmlFor = 'claim-code-input';
  const input = el('textarea', 'wg-input wg-input--code');
  input.id = 'claim-code-input';
  input.rows = 2;
  input.placeholder = 'KXR QDW BMT LPA ZRE HNV CUG YSF TJO W';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'characters');
  field.append(label, input);
  const submit = button('claim-code-submit', 'Continue', submitClass, onSubmit);
  // Error text is rendered as text, never HTML: this page ends up holding the DEK.
  const error = el('p', 'wg-error', errorText || '');
  error.id = 'claim-error';

  // Continue waits for all 28 letters; a pasted link or an old code (has a
  // dot) is let through so it gets its own answer.
  const sync = () => {
    const v = input.value;
    submit.disabled = !(v.includes('.') || v.replace(/[^a-z]/gi, '').length >= 28);
  };
  input.addEventListener('input', sync);

  async function onSubmit() {
    submit.disabled = true;
    try {
      startClaim(app, await parseTyped(input.value));
    } catch (err) {
      error.textContent = err instanceof CodeError ? err.message : BAD_CODE_ERROR;
      sync();
    }
  }
  return { field, submit, error, sync };
}

// The typed "Code for a computer" (AD8 · desktop layout).
function renderClaimForm(app, errorText) {
  const shell = el('div', 'wg-shell wg-shell--center');
  const mark = el('span', 'wg-mark');
  mark.append(icon('pill'));
  const code = codeEntry(app, errorText, 'wg-btn--primary wg-btn--lg wg-btn--block');
  const col = el('div', 'wg-vstack');
  col.append(code.field, code.submit, code.error, el('p', 'wg-hint', 'Works once · expires 10 minutes after it was made'));
  shell.append(
    mark,
    el('h1', 'wg-shell__title wg-shell__title--md', 'Add this device to your account'),
    el('p', 'wg-shell__lede', 'Type the code your other device shows under the QR.'),
    col,
  );
  render(app, shell);
  code.sync();
}

// ---- In-app Scan (bd med-r1j2.10; AD7 "Scan a new code", AD13) ------------
// Camera and decode go through window.MediaCapture / window.Barcode, never the
// browser APIs (CLAUDE.md rule 10). No camera, a denied one, or no live
// decoder → AD13: the typed code, plus "Allow camera in Settings".

const SCAN_MS = 200;
const HANDOFF_RE = /^(?:https?:\/\/[^/?#]+\/d\/|medtracker:\/\/d\/)([a-z0-9-]+)#([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;
const CLAIM_LINK_RE = /^https?:\/\/([a-z0-9-]+)\.[^/?#]+\/claim#([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

// A scanned QR → { sub, frag } for an add-device code (the /d/ hand-off link,
// its medtracker:// twin, or a /claim link), else null.
function parseScanned(raw) {
  const text = String(raw || '').trim();
  const m = HANDOFF_RE.exec(text) || CLAIM_LINK_RE.exec(text);
  return m ? { sub: m[1].toLowerCase(), frag: m[2] } : null;
}

// The ZXing decoder Barcode falls back to where the platform has no native
// one (WebKit), loaded on first use: it is too big for every ceremony page.
let zxingLoad = null;
function loadZxing() {
  if (globalThis.ZXing) return Promise.resolve();
  if (!zxingLoad) {
    zxingLoad = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = '/static/vendor/zxing.min.js';
      s.onload = resolve;
      s.onerror = () => { zxingLoad = null; resolve(); };
      document.head.append(s);
    });
  }
  return zxingLoad;
}

function scanBar(onBack) {
  const bar = el('header', 'wg-pagebar');
  const back = el('button', 'wg-back');
  back.type = 'button';
  back.id = 'claim-scan-back';
  back.append(icon('chev-l'), 'Back');
  back.addEventListener('click', onBack);
  const center = el('div', 'wg-pagebar__center');
  center.append(el('div', 'wg-pagebar__title', 'Scan code'));
  bar.append(back, center, el('span'));
  return bar;
}

function stopTracks(stream) {
  try {
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // already stopped
  }
}

async function renderScanner(app) {
  const media = globalThis.MediaCapture;
  const barcode = globalThis.Barcode;
  const scan = { stopped: false, stream: null, timer: null };
  const stop = () => {
    scan.stopped = true;
    clearTimeout(scan.timer);
    if (scan.stream) stopTracks(scan.stream);
    scan.stream = null;
    globalThis.removeEventListener?.('pagehide', stop);
  };
  globalThis.addEventListener?.('pagehide', stop);

  const shell = el('div', 'wg-shell');
  const video = el('video', 'claim-scan-video');
  video.id = 'claim-scan-video';
  video.muted = true;
  video.setAttribute('playsinline', '');
  const status = el('p', 'wg-hint', 'Point the camera at the QR code on your other device.');
  status.id = 'claim-scan-status';
  shell.append(video, status);
  const back = () => { stop(); renderClaimForm(app); };
  render(app, shell, [button('claim-scan-type', 'Type the code instead', 'wg-btn--ghost', back)], { bar: scanBar(back), foot: 'wg-pagefoot' });

  let stream;
  try {
    const live = () => !!barcode && typeof barcode.supportsLiveScan === 'function' && barcode.supportsLiveScan();
    if (barcode && !live()) await loadZxing();
    if (!live()) throw Object.assign(new Error('no live scan'), { code: 'UNAVAILABLE' });
    if (scan.stopped) return;
    stream = await media.openCameraStream({ facingMode: 'environment' });
  } catch (err) {
    if (scan.stopped) return;
    stop();
    renderCameraOff(app, err && err.code === 'PERMISSION_DENIED');
    return;
  }
  if (scan.stopped) {
    stopTracks(stream);
    return;
  }
  scan.stream = stream;
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    // the decoder reads the stream either way
  }
  loop();

  function loop() {
    if (scan.stopped) return;
    Promise.resolve()
      .then(() => barcode.scan({ source: video, formats: ['qr_code'] }))
      .catch(() => null) // an unready frame: try again
      .then((result) => {
        if (scan.stopped) return;
        if (result && result.rawValue) {
          const code = parseScanned(result.rawValue);
          if (code) {
            stop();
            openScanned(app, code);
            return;
          }
          status.textContent = "That QR code isn't from Add a device. Scan the one on your other device.";
        }
        scan.timer = setTimeout(loop, SCAN_MS);
      });
  }
}

// A scanned code for this account claims here; another account's opens its
// own /claim (the same place its /d/ link leads). In an app shell that is
// account.leave {url}: the shells keep navigation on this account host and
// would hand another subdomain to the system browser.
async function openScanned(app, { sub, frag }) {
  const [here, ...base] = location.host.split('.');
  if (sub !== here.toLowerCase()) {
    const url = `${location.protocol}//${sub}.${base.join('.')}/claim#${frag}`;
    const native = globalThis.LocalNotifications && globalThis.LocalNotifications.__native;
    if (!native || (native.platform !== 'ios' && native.platform !== 'android')) {
      location.href = url;
      return;
    }
    try {
      await native.call('account.leave', { url });
    } catch {
      renderClaimForm(app, 'This code is for another account. Update Med Tracker to switch to it from here.');
    }
    return;
  }
  let parsed;
  try {
    parsed = await parseFragment(frag);
  } catch (err) {
    renderClaimForm(app, err.message);
    return;
  }
  startClaim(app, parsed);
}

// AD13: in-app Scan without a camera — the AD8 · no code layout.
function renderCameraOff(app, denied) {
  const shell = el('div', 'wg-shell');
  const ico = el('span', 'wg-shell__icon wg-shell__icon--warn');
  ico.append(icon('camera'));
  const head = el('div', 'wg-vstack');
  const title = el('h1', 'wg-shell__title wg-shell__title--md', denied ? 'The camera is off for this app' : "Scanning isn't available here");
  title.id = 'claim-camera-off';
  head.append(title, el('p', 'wg-shell__lede', 'Type the code shown under the QR on your other device instead.'));
  const code = codeEntry(app, '', 'wg-btn--primary wg-btn--lg');
  shell.append(ico, head, code.field, code.error);
  if (denied) {
    // Appended on the first miss (the kit's display rules beat [hidden]).
    const hint = el('p', 'wg-hint');
    hint.id = 'claim-camera-hint';
    const allow = button('claim-camera-settings', 'Allow camera in Settings', 'wg-btn--ghost wg-btn--sm', async () => {
      const media = globalThis.MediaCapture;
      let res = { opened: false, hint: '' };
      try {
        if (media && typeof media.openSettings === 'function') res = await media.openSettings();
      } catch {
        // the hint below still says where
      }
      if (res.opened) return;
      hint.textContent = res.hint || 'Allow the camera in your settings, then try again.';
      allow.after(hint);
    });
    shell.append(allow);
  }
  render(app, shell, [code.submit], { bar: scanBar(() => renderClaimForm(app)), foot: 'wg-pagefoot' });
  code.sync();
}

function startClaim(app, code) {
  claim(app, code).catch(() =>
    renderClaimForm(app, "Couldn't reach your account. Check your connection and try again."));
}

async function claim(app, { slot, tk }) {
  // Everything secret about this pairing, for the page's life only.
  const flow = { stopped: false, timer: null, keys: null, oPub: null, transcript: null, fields: null, keyPair: null, token: null };
  const accountSub = location.hostname.split('.')[0];
  const platform = currentPlatform();
  const slotPath = `/api/transfer/${encodeURIComponent(slot)}`;

  const stop = () => {
    flow.stopped = true;
    clearInterval(flow.timer);
  };
  const cancel = () => {
    stop();
    renderClaimForm(app);
  };
  renderConnecting(app, cancel);

  // No cookie: a browser that already holds a session for this account would
  // otherwise get the origin's view (no commit). Later polls carry the claim
  // token, which the server reads as the receiver either way.
  const first = await fetch(slotPath, { credentials: 'omit' });
  if (flow.stopped) return;
  if (first.status === 410 || first.status === 404) return renderEnded(app, 'Stopped');
  if (!first.ok) throw new Error('slot fetch failed');
  const view = await first.json();
  const commit = bytes(view.commit);
  const expiresAt = new Date(view.expires_at).getTime();
  if (flow.stopped) return;
  if (!commit || commit.length !== 32 || !Number.isFinite(expiresAt)) return renderUntrusted(app);
  if (view.status !== 'pending') return renderUsed(app);
  if (Date.now() >= expiresAt) return renderEnded(app, 'Expired');

  flow.keyPair = await generateTransferKeyPair();
  flow.fields = { accountId: accountSub, slot, platform, commit, nPub: flow.keyPair.pub };
  const macN = await transferClaimMac(tk, flow.fields);
  // Cancelled while the key was being made: never claim the single-use slot.
  if (flow.stopped) return;
  const res = await fetch(`${slotPath}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ n_pub: toBase64(flow.keyPair.pub), platform, mac_n: toBase64(macN) }),
  });
  if (flow.stopped) return;
  if (res.status === 409) return renderUsed(app);
  if (res.status === 410 || res.status === 404) return renderEnded(app, 'Stopped');
  if (!res.ok) throw new Error('claim failed');
  flow.token = (await res.json()).claim_token;
  if (!flow.token) throw new Error('claim failed');

  let busy = false;
  flow.timer = setInterval(async () => {
    if (busy || flow.stopped) return;
    busy = true;
    try {
      await poll();
    } catch {
      // A malformed answer: the next tick asks again.
    } finally {
      busy = false;
    }
  }, POLL_INTERVAL_MS);

  async function poll() {
    if (Date.now() >= expiresAt) {
      stop();
      renderEnded(app, 'Expired');
      return;
    }
    let r;
    try {
      r = await fetch(slotPath, { headers: { 'X-Transfer-Token': flow.token } });
    } catch {
      return; // transient: the next tick retries
    }
    if (flow.stopped) return;
    if (r.status === 410 || r.status === 404) {
      stop();
      renderEnded(app, Date.now() >= expiresAt ? 'Expired' : 'Stopped');
      return;
    }
    if (!r.ok) return;
    const v = await r.json();
    if (flow.stopped) return;
    if (v.status === 'pending' || v.status === 'claimed') return;
    if (v.status !== 'revealed' && v.status !== 'approved') {
      stop();
      renderEnded(app, 'Stopped');
      return;
    }
    // revealed, or approved after a poll gap: both carry o_pub + mac_o.
    if (!(await acceptReveal(bytes(v.o_pub), bytes(v.mac_o)))) {
      stop();
      renderUntrusted(app);
      return;
    }
    if (flow.stopped || v.status === 'revealed') return;
    const ct = bytes(v.ct);
    if (!ct || !v.enrollment_token || !v.account_id) return; // not ours to open; keep waiting
    stop();
    let dek;
    try {
      dek = await unwrapTransferDek(flow.keys.kWrap, ct, flow.transcript);
    } catch {
      renderUntrusted(app);
      return;
    }
    const confN = await transferConfirmMac(flow.keys.kConf, flow.transcript);
    renderApproved(app, { enrollmentToken: v.enrollment_token, accountId: v.account_id, dek, confN, expiresAt });
  }

  // The origin's key must be the one it committed to, and its MAC must prove
  // it holds TK. Checked once; a later poll naming another key is an attack.
  async function acceptReveal(oPub, macO) {
    if (!oPub || !macO) return false;
    if (flow.oPub) return timingSafeEqual(oPub, flow.oPub);
    if (!timingSafeEqual(await transferCommit(oPub), commit)) return false;
    const transcript = transferTranscript({ ...flow.fields, oPub });
    if (!(await verifyTransferMac(transferRevealMac(tk, transcript), macO))) return false;
    let keys;
    try {
      keys = await deriveTransferKeys(flow.keyPair.privateKey, oPub, transcript);
    } catch {
      return false;
    }
    if (flow.stopped) return true;
    Object.assign(flow, { oPub, transcript, keys });
    renderMatchCode(app, keys.sas, cancel);
    return true;
  }
}

function bytes(value) {
  try {
    return typeof value === 'string' && value ? fromBase64(value) : null;
  } catch {
    return null;
  }
}

function matchCode(sas) {
  const box = el('div', sas ? 'wg-matchcode' : 'wg-matchcode wg-matchcode--wait');
  box.id = 'claim-matchcode';
  box.setAttribute('role', 'img');
  const [a, b] = sas ? [sas.slice(0, 3), sas.slice(3)] : ['···', '···'];
  box.setAttribute('aria-label', sas ? `Matching code ${a.split('').join(' ')}, ${b.split('').join(' ')}` : 'Matching code not ready yet');
  box.append(el('span', '', a), el('span', '', b));
  return box;
}

// AD5 · connecting
function renderConnecting(app, onCancel) {
  const shell = el('div', 'wg-shell wg-shell--center');
  shell.append(
    matchCode(null),
    el('h1', 'wg-shell__title wg-shell__title--md', 'Connecting to your other device…'),
    el('p', 'wg-shell__lede', 'Keep both devices open.'),
  );
  render(app, shell, [button('claim-cancel', 'Cancel', '', onCancel)]);
}

// AD5 · code
function renderMatchCode(app, sas, onCancel) {
  const shell = el('div', 'wg-shell');
  const head = el('div', 'wg-vstack');
  const chip = el('span', 'wg-chip wg-chip--pending');
  chip.append(icon('clock'), 'Waiting for approval');
  head.append(
    chip,
    el('h1', 'wg-shell__title wg-shell__title--md', 'Approve this on your other device'),
    el('p', 'wg-shell__lede', 'Check your other device shows the same 6 digits, then tap Approve there.'),
  );
  const code = el('div', 'wg-vstack');
  code.append(el('span', 'wg-label', 'Matching code'), matchCode(sas));
  const note = el('div', 'wg-note wg-note--info');
  const body = el('div', 'wg-note__body');
  body.append(el('span', '', 'This device gets its own passkey. Your existing passkeys keep working.'));
  note.append(icon('key'), body);
  shell.append(head, code, note);
  render(app, shell, [button('claim-cancel', 'Cancel', '', onCancel)]);
}

// AD6: approved — the passkey sheet needs a tap. A cancelled sheet or a failed
// ceremony returns here; the approval holds until the code expires.
function renderApproved(app, ctx, errorText) {
  const shell = el('div', 'wg-shell');
  const head = el('div', 'wg-vstack');
  const chip = el('span', 'wg-chip wg-chip--ok');
  chip.append(icon('check'), 'Approved on your other device');
  head.append(
    chip,
    el('h1', 'wg-shell__title', 'Now create a passkey for this device'),
    el('p', 'wg-shell__lede', 'It opens the account here. No password, no email.'),
  );
  const facts = el('ul', 'wg-facts');
  for (const [ico, title, line] of [
    ['key', 'A new passkey, just for this device', 'Your other passkeys keep working.'],
    ['shield', 'Saved only after this step', 'Nothing is saved on this device until its passkey exists.'],
  ]) {
    const li = el('li');
    const span = el('span');
    span.append(el('b', '', title), line);
    li.append(icon(ico), span);
    facts.append(li);
  }
  const error = el('p', 'wg-error', errorText || '');
  error.id = 'claim-error';
  shell.append(head, facts, error);
  const create = button('claim-enroll', 'Create a passkey', 'wg-btn--primary wg-btn--lg', async () => {
    create.disabled = true;
    try {
      if (!(await enrollWithToken(app, ctx))) return;
    } catch (err) {
      // The slot expired or was stopped on the origin: retrying the same
      // enrollment token can never succeed.
      if (err.tokenDead) renderEnded(app, Date.now() >= ctx.expiresAt ? 'Expired' : 'Stopped');
      else renderApproved(app, ctx, err.message || "Couldn't set up your passkey. Please try again.");
      return;
    }
    renderOpening(app);
    // This tab enrolled: only that boot may finish a "Join and erase"
    // (cloud-boot.js finishJoinErase, bd med-r1j2.7). A failed join's Close
    // also lands on '/', and an older session there can boot unlocked.
    try { sessionStorage.setItem('wg-join-enrolled', '1'); } catch { /* no storage: nothing is erased */ }
    // Session cookie + LDK are both set now; the unlock flow's normal
    // "already unlocked" render takes it from here.
    location.href = '/';
  }, 'key');
  render(app, shell, [create]);
}

// AD6 · opening
function renderOpening(app) {
  const shell = el('div', 'wg-shell wg-shell--center');
  const mark = el('span', 'wg-mark wg-mark--lg');
  mark.append(icon('pill'));
  shell.append(
    mark,
    el('h1', 'wg-shell__title wg-shell__title--md', 'Opening your account…'),
    el('p', 'wg-shell__lede', 'Keep this page open.'),
  );
  render(app, shell);
}

// AD7 end states share one layout.
function renderEnd(app, { id, iconName, tone, title, lede, chip }) {
  const shell = el('div', 'wg-shell wg-shell--center');
  const ico = el('span', `wg-shell__icon${tone ? ` wg-shell__icon--${tone}` : ''}`);
  ico.append(icon(iconName));
  const h1 = el('h1', 'wg-shell__title wg-shell__title--md', title);
  h1.id = id;
  const chipEl = el('span', `wg-chip wg-chip--${chip.tone}`);
  chipEl.append(icon(iconName), chip.text);
  shell.append(ico, h1, el('p', 'wg-shell__lede', lede), chipEl, el('p', 'wg-hint', NEW_CODE_HINT));
  // The sun reopens the in-app scanner (med-r1j2.10); it offers the typed code.
  render(app, shell, [
    button('claim-new-code', 'Scan a new code', 'wg-btn--primary wg-btn--lg', () => renderScanner(app), 'scan'),
    button('claim-close', 'Close', 'wg-btn--ghost', () => { location.href = '/'; }),
  ]);
}

// AD7 · used (409): most often the user's own second scan, so warn, not danger.
function renderUsed(app) {
  renderEnd(app, {
    id: 'claim-used', iconName: 'alert', tone: 'warn',
    title: 'This code was already used',
    lede: "Another device used it first. If that wasn't you, your other device will warn you.",
    chip: { tone: 'warn', text: 'Already used' },
  });
}

// AD7 · ended (410 or local expiry). The server names no reason, so the chip
// says Expired only when this device knows it expired.
function renderEnded(app, reason) {
  renderEnd(app, {
    id: 'claim-ended', iconName: 'clock',
    title: 'This code no longer works',
    lede: 'It expired, or it was stopped on your other device. Nobody was added.',
    chip: { tone: 'stale', text: reason },
  });
}

// The origin's reveal or ciphertext failed its check: nothing usable arrived.
function renderUntrusted(app) {
  renderEnd(app, {
    id: 'claim-untrusted', iconName: 'alert', tone: 'danger',
    title: "This code couldn't be checked",
    lede: 'What came back did not match your other device, so this device stopped. Nothing was shared.',
    chip: { tone: 'danger', text: 'Stopped' },
  });
}

// Registers a new passkey under an already-obtained DEK, gated by a
// device-transfer or recovery enrollment token — the shared tail of both
// claim.js (device-transfer) and recover.js (Emergency Kit redemption): the
// two flows differ only in how they obtain {enrollmentToken, accountId, dek},
// not in how they turn that into a live passkey + session. ctx.confN (device
// transfer only) is the key confirmation register/begin relays to the origin.
// Returns false (having already rendered the terminal error state) if the
// authenticator lacks PRF support; true once the passkey + session +
// warm-unlock cache are all live. In the Android shell the whole ceremony is
// one passkeyCeremony (passkey-get.js): a steady busy step, then this module's
// own screens.
export function enrollWithToken(app, ctx) {
  return passkeyCeremony(app, ENROLL_CEREMONY_COPY, () => enroll(app, ctx));
}

async function enroll(app, { enrollmentToken, accountId, dek, confN }) {
  const beginBody = { enrollment_token: enrollmentToken };
  if (confN) beginBody.conf_n = toBase64(confN);
  const beginRes = diagHttp('register/begin', await fetch('/api/webauthn/register/begin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(beginBody),
  }));
  if (!beginRes.ok) throw deadTokenError(beginRes.status === 403, 'Could not start passkey registration — the code may be expired.');
  const { publicKey } = await beginRes.json();
  const creationOptions = PublicKeyCredential.parseCreationOptionsFromJSON(publicKey);

  const credential = await createCredential(creationOptions);

  // PRF availability is only reliable from a fresh assertion — see signup.js.
  // Probed before finish so an unsupported authenticator aborts here (finish
  // is never called => no enrollment token is ever redeemed for it).
  const salt = await saltKek();
  const prfAssertion = await prfProbe(credential.rawId, salt);
  const prfOutput = prfAssertion.getClientExtensionResults().prf?.results?.first;
  if (!prfOutput) {
    renderUnsupportedAuthenticator(app);
    return false;
  }

  const credentialId = new Uint8Array(credential.rawId);
  const kek = await deriveKEK(new Uint8Array(prfOutput), accountId, credentialId);
  const kMac = await deriveKMac(dek);
  const envelope = await wrapEnvelope({ kek, dek, kMac, accountId, credentialId });

  const finishBody = credential.toJSON();
  // Never transmit the PRF output — it lives client-side only.
  if (finishBody.clientExtensionResults) delete finishBody.clientExtensionResults.prf;

  const finishRes = diagHttp('register/finish', await fetch('/api/webauthn/register/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      credential: finishBody,
      envelope: {
        v: envelope.v,
        nonce: toBase64(envelope.nonce),
        ct: toBase64(envelope.ct),
        mac: toBase64(envelope.mac),
      },
    }),
  }));
  if (!finishRes.ok) throw deadTokenError(finishRes.status === 409, 'Passkey registration failed. Please try again.');

  try {
    await establishLdkCache(dek, accountId);
  } catch {
    // Warm-cache is an optimization; a storage-blocked browser must still
    // reach the vault after a successful enrollment — see unlock.js.
  }
  return true;
}

// register/begin answers 403 and register/finish 409 when the enrollment
// token is gone (slot expired or stopped). A plain Error (name 'Error') so
// passkeyCeremony passes it through unchanged.
function deadTokenError(dead, message) {
  const err = new Error(message);
  if (dead) err.tokenDead = true;
  return err;
}
