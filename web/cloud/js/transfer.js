// "Add a device" flow on the origin (old, unlocked) device: docs/cloud-crypto.md
// "Path B", protocol v2 (epic med-r1j2; screens AD1–AD4 in
// docs/design/claude-design/ui_kits/app-v2/screens-add-device.html).
//
// A fresh passkey assertion yields the DEK; the device makes a one-time
// transfer key TK and an ephemeral ECDH key, opens a slot with only
// commit = SHA-256(o_pub), and shows TK as a QR/link and a typed code. When a
// device claims, its MAC under TK is checked, its key and platform are frozen
// here, o_pub is revealed, and both screens show the same 6-digit match code.
// Only the owner's Approve tap wraps the DEK — for that receiver only, bound
// to the transcript — and posts it. Nothing secret is ever logged or stored.
//
// Mounted into the app's "Add a device" page (med-xso6.25; features/settings.js
// openAddDevicePage). The module renders into the mount it is given and owns no
// page chrome: onExit leaves the flow, and the returned controller lets the
// host's Back go through the same server-side cancel as the Cancel button.
import {
  toBase64,
  fromBase64,
  toBase64Url,
  generateTransferKey,
  transferSlotId,
  encodeTransferCode,
  generateTransferKeyPair,
  transferCommit,
  transferTranscript,
  transferClaimMac,
  transferRevealMac,
  verifyTransferMac,
  deriveTransferKeys,
  wrapTransferDek,
  transferConfirmMac,
} from './crypto.js';

// How often the origin asks what the new device did. The ceremony is a human
// scanning a QR, so 2s is well inside "feels instant" while costing at most
// ~300 requests over the slot's whole 10-minute life.
const POLL_INTERVAL_MS = 2000;

// The only names the origin can give the new device (server enum). Fixed
// strings: nothing server-controlled reaches innerHTML.
const PLATFORMS = {
  android: { asking: 'An Android phone', app: 'Android app', added: 'Your Android phone is added' },
  ios: { asking: 'An iPhone or iPad', app: 'iPhone or iPad app', added: 'Your iPhone or iPad is added' },
  web: { asking: 'A browser', app: 'Web browser', added: 'The browser is added' },
};

function sameBytes(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function bytesField(value) {
  try {
    return typeof value === 'string' && value ? fromBase64(value) : null;
  } catch {
    return null;
  }
}

// Where a scan lands. The server stamps <meta medtracker-handoff-app> on the
// app document only with HANDOFF_APP_LINKS=1 (shipped apps take /d/ links).
// On: https://<base>/d/<sub> for this host <sub>.<base> (http in dev). Off:
// the pre-#1336 <sub>.<base>/claim, the only form shipped app scanners
// (InviteSheet.parse) accept (med-r1j2.13). /d/ links already out there keep
// working: the landing is served regardless of the flag.
function handoffPath() {
  const on = document.querySelector('meta[name="medtracker-handoff-app"]')?.content === '1';
  if (!on) return `${location.origin}/claim`;
  const [sub, ...base] = location.host.split('.');
  return `${location.protocol}//${base.join('.')}/d/${sub}`;
}

function hhmm(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// The one add-device flow this window is running (its page is open), so the
// "Approve the new device?" notification tap (med-r1j2.9) can bring it back.
// module-state: a single page-lifetime handle; renderAddDevice sets it and
// stop() clears it.
let currentFlow = null;

// Called on the notification tap: true when this window holds a live code —
// it polls now, so a claim lands on Approve (AD3) with the match code without
// waiting out a throttled interval. False: nothing to resume here.
export function resumeLiveTransfer() {
  if (!currentFlow || !currentFlow.live) return false;
  currentFlow.pollNow();
  return true;
}

// sw.js asks every window which one holds the live code before routing the
// tap (another tab of the account may be the first window). Ack on the
// transferred port only while live; the probe and the ack carry nothing.
let probeBound = false; // module-state: one SW listener per page
function bindLiveProbe() {
  const sw = globalThis.navigator && globalThis.navigator.serviceWorker;
  if (probeBound || !sw) return;
  probeBound = true;
  sw.addEventListener('message', (event) => {
    const port = event.ports && event.ports[0];
    if (!port || !event.data || event.data.type !== 'transfer-live-probe') return;
    if (currentFlow && currentFlow.live) port.postMessage('live');
  });
}

// Returns { cancel(): Promise<boolean>, stop() }. cancel() resolves true once
// nothing claimable is left (the live slot was deleted server-side, or there
// never was one) and false when the DELETE failed — the host must then stay put,
// since leaving would imply a still-live code is dead. stop() only clears the
// timers (the host calls it after its page is gone, however it closed).
// opts.notHere: open on the AD4 "not open here" end state instead of starting —
// the notification tap found no live flow in this window.
export function renderAddDevice(mount, ctx, onExit, opts = {}) {
  // s holds this pairing's secrets (TK, ECDH key, DEK) for the page's life only.
  const flow = { slotId: null, live: false, closed: false, timer: null, poller: null, busy: false, s: null };
  flow.pollNow = () => { pollSlot(); };
  currentFlow = flow;
  bindLiveProbe();
  // The account subdomain names the account in the transcript: it is the one
  // name the new device knows before approval.
  const accountSub = location.hostname.split('.')[0];

  const stop = () => {
    clearInterval(flow.timer);
    clearInterval(flow.poller);
    flow.live = false;
  };
  // A terminal screen: no timers, no secrets.
  const finish = () => {
    stop();
    flow.s = null;
  };
  // keepalive: a delete sent as the page goes away still reaches the server.
  const deleteSlot = (slotId) =>
    fetch(`/api/transfer/${encodeURIComponent(slotId)}`, { method: 'DELETE', keepalive: true });
  // AD4 (med-e92o): the tab closing, reloading or navigating away must not
  // leave a live slot — after Approve it holds the wrapped DEK until expiry.
  // Best effort; an enrolled or ended flow is no longer live and sends nothing.
  const onPageHide = () => {
    if (flow.live) deleteSlot(flow.slotId).catch(() => {});
  };
  const win = document.defaultView;
  if (win) win.addEventListener('pagehide', onPageHide);

  // med-5h1t.3: the warm ctx carries no raw DEK, and an unlocked tab left open
  // must not be enough to hand the vault to a new device. Every code starts
  // with a fresh passkey assertion; its DEK lives only in this ceremony.
  // Accepted tradeoff: a device whose passkey is gone or lacks PRF cannot
  // originate a transfer — the Emergency Kit still enrolls a new device.
  function start() {
    finish();
    flow.closed = false;
    mount.innerHTML = `
      <div class="wg-vstack">
        <h2 class="wg-shell__title wg-shell__title--md">Add a phone, tablet or browser</h2>
        <p class="wg-shell__lede">It gets its own passkey and opens the same records. Your passkeys here keep working.</p>
      </div>
      <ol class="wg-olist">
        <li>Unlock with your passkey on this device</li>
        <li>Scan the code with the new device</li>
        <li>Check both show the same 6 digits, then approve here</li>
      </ol>
      <p class="wg-shell__fine">Unlocking creates a one-time code; it does not create a new passkey.
         Have the new device in your hand: the code lasts 10 minutes.</p>
      <button type="button" id="transfer-confirm" class="wg-btn wg-btn--primary wg-btn--lg wg-btn--block"><i class="wg-ico" data-icon="key"></i>Unlock with passkey</button>`;
    const confirmButton = mount.querySelector('#transfer-confirm');
    confirmButton.addEventListener('click', () => {
      confirmButton.disabled = true;
      confirmButton.textContent = 'Waiting for your passkey…';
      confirmAndStart().catch((err) => renderError(err.message || String(err)));
    });
  }

  async function confirmAndStart() {
    const { assertPasskey } = await import('./unlock.js');
    const { accountId, dek, credentialId } = await assertPasskey();
    // Checked before anything is generated or posted (same as devices.js
    // rotateEmergencyKit): a passkey for another account must not mint a code.
    if (accountId !== ctx.accountId) throw new Error('That passkey belongs to a different account.');
    if (flow.closed) return;
    mount.innerHTML = '<p class="wg-hint">Making a one-time code&hellip;</p>';
    await startTransfer(dek, credentialId);
  }

  async function startTransfer(dek, credentialId) {
    const tk = generateTransferKey();
    const keyPair = await generateTransferKeyPair();
    const commit = await transferCommit(keyPair.pub);
    const slotId = await transferSlotId(tk);

    const res = await fetch('/api/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot_id: slotId, commit: toBase64(commit) }),
    });
    if (!res.ok) throw new Error('Could not make a code. Check your connection and try again.');
    const { expires_at: expiresAt } = await res.json();
    if (flow.closed) {
      // The host left while the slot was being opened. Don't leave a live
      // slot behind.
      deleteSlot(slotId).catch(() => {});
      return;
    }
    flow.slotId = slotId;
    flow.live = true;
    flow.approving = false;
    flow.expiresAt = new Date(expiresAt).getTime();
    flow.s = { tk, keyPair, commit, dek, credentialId, claim: null, transcript: null, keys: null, approved: false };

    // The base-domain hand-off (med-r1j2.4): App Links / universal links
    // cover https://<base>/d/*, so a camera scan reaches the installed app;
    // its landing forwards a browser to /claim on this host.
    const link = `${handoffPath()}#${slotId}.${toBase64Url(tk)}`;
    await renderWaiting({ link, code: encodeTransferCode(tk), expiresAt: flow.expiresAt });
  }

  function copy(text, what) {
    const toast = (msg, kind) => globalThis.safeToast && globalThis.safeToast(msg, kind);
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(() => toast(`${what} copied`, 'success'))
      .catch(() => toast('Could not copy — select the text instead.', 'error'));
  }

  // AD2: QR, link and the typed code; a countdown and Cancel.
  async function renderWaiting({ link, code, expiresAt }) {
    const { qrcode } = await import('../vendor/qrcode.mjs');
    // Back during the import already deleted the slot; don't restart timers
    // on a detached mount.
    if (flow.closed) return;
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();

    mount.innerHTML = `
      <h2 class="wg-shell__title wg-shell__title--md">Scan this with your new device</h2>
      <div class="wg-card wg-vstack wg-shell--center">
        <span class="wg-qr wg-qr--lg">${qr.createSvgTag(4)}</span>
        <button type="button" id="transfer-copy-link" class="wg-btn wg-btn--sm"><i class="wg-ico wg-ico--sm" data-icon="copy"></i>Copy link</button>
      </div>
      <div class="wg-vstack">
        <span class="wg-label">Code for a computer</span>
        <div class="wg-code wg-code--wrap"><span id="transfer-fallback"></span><button type="button" id="transfer-copy-code" class="wg-btn wg-btn--ghost wg-btn--icon wg-btn--sm" aria-label="Copy code"><i class="wg-ico wg-ico--sm" data-icon="copy"></i></button></div>
        <p class="wg-hint">On the computer, open <span id="transfer-claim-host"></span> and type it there.</p>
      </div>
      <div class="wg-hstack"><span class="wg-chip wg-chip--pending wg-chip--sm"><i class="wg-ico" data-icon="clock"></i><span id="transfer-countdown"></span>&nbsp;left</span><span class="wg-spacer"></span><span class="wg-meta">single use</span></div>
      <p class="wg-shell__fine">Works once · expires in 10 min · you approve the new device here</p>
      <p class="wg-error" id="transfer-error"></p>
      <button type="button" id="transfer-cancel" class="wg-btn wg-btn--block">Cancel</button>`;
    // The code is the secret itself — textContent, never innerHTML.
    mount.querySelector('#transfer-fallback').textContent = code;
    mount.querySelector('#transfer-claim-host').textContent = handoffPath().replace(/^https?:\/\//, '');
    mount.querySelector('#transfer-copy-link').addEventListener('click', () => copy(link, 'Link'));
    mount.querySelector('#transfer-copy-code').addEventListener('click', () => copy(code, 'Code'));
    bindCancel();

    flow.timer = setInterval(tick, 1000);
    function tick() {
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        // The server expires the slot itself; deleting it is belt and braces.
        if (flow.live) deleteSlot(flow.slotId).catch(() => {});
        endWithoutResult(true);
        return;
      }
      // ponytail: no time meter — the cloud JS bans .style writes, and the
      // chip already says how long is left.
      const countdownEl = mount.querySelector('#transfer-countdown');
      const totalSeconds = Math.floor(remainingMs / 1000);
      if (countdownEl) countdownEl.textContent = `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
    }
    tick();

    flow.poller = setInterval(() => { pollSlot(); }, POLL_INTERVAL_MS);
  }

  function bindCancel() {
    const cancelButton = mount.querySelector('#transfer-cancel');
    if (!cancelButton) return;
    cancelButton.addEventListener('click', async () => {
      cancelButton.disabled = true;
      if (await cancel()) onExit();
      else cancelButton.disabled = false;
    });
  }

  // One poll answers every state. The receiver binding lives here, not in the
  // server: once a claim is accepted, any later poll that names a different
  // key or platform, or a state this device didn't move the slot to, aborts.
  async function pollSlot() {
    if (!flow.live || flow.busy || flow.approving) return;
    flow.busy = true;
    try {
      await handlePoll();
    } finally {
      flow.busy = false;
    }
  }

  async function handlePoll() {
    let res;
    try {
      res = await fetch(`/api/transfer/${encodeURIComponent(flow.slotId)}`);
    } catch {
      return; // transient: the next tick retries
    }
    if (!flow.live) return;
    if (res.status === 404) {
      // Gone server-side: expired, swept, or its approving passkey revoked.
      endWithoutResult(Date.now() >= flow.expiresAt);
      return;
    }
    if (!res.ok) return;
    const view = await res.json();
    // An approve in flight owns the next transition; a poll that left before
    // it must not read `approved` as a state we didn't cause.
    if (!flow.live || flow.approving) return;
    const s = flow.s;
    const nPub = bytesField(view.n_pub);
    const macN = bytesField(view.mac_n);

    if (view.status === 'pending') {
      if (s.claim) await abort();
      return;
    }
    if (!nPub || !macN || !PLATFORMS[view.platform]) {
      // A claimed slot always carries its claim fields to the origin session;
      // a view without them is not one we can act on (e.g. no session).
      return;
    }
    if (!s.claim) {
      if (view.status !== 'claimed') { await abort(); return; }
      await acceptClaim({ nPub, macN, platform: view.platform });
      return;
    }
    if (!sameBytes(nPub, s.claim.nPub) || !sameBytes(macN, s.claim.macN) || view.platform !== s.claim.platform) {
      await abort();
      return;
    }
    if (view.status === 'claimed' || view.status === 'revealed') return; // waiting on the owner
    // approveSent: an approve whose response was lost still counts as ours.
    if (view.status === 'approved' && s.approveSent) { markApproved(); return; } // waiting on the new device
    if (view.status === 'enrolled' && s.approveSent) {
      const confN = bytesField(view.conf_n);
      const ok = confN && (await verifyTransferMac(transferConfirmMac(s.keys.kConf, s.transcript), confN));
      const platform = s.claim.platform;
      finish();
      if (ok) renderDone(platform);
      else renderUnconfirmed();
      return;
    }
    await abort();
  }

  // The new device claimed: check its proof of the scan, freeze it, derive the
  // match code and reveal o_pub (no ciphertext). Approve appears only after
  // the reveal succeeded.
  async function acceptClaim(claim) {
    const s = flow.s;
    const fields = { accountId: accountSub, slot: flow.slotId, platform: claim.platform, commit: s.commit, nPub: claim.nPub };
    if (!(await verifyTransferMac(transferClaimMac(s.tk, fields), claim.macN))) {
      await abort();
      return;
    }
    s.claim = claim;
    s.transcript = transferTranscript({ ...fields, oPub: s.keyPair.pub });
    try {
      s.keys = await deriveTransferKeys(s.keyPair.privateKey, claim.nPub, s.transcript);
    } catch {
      await abort(); // not a valid P-256 key
      return;
    }
    const macO = await transferRevealMac(s.tk, s.transcript);
    let res;
    try {
      res = await fetch(`/api/transfer/${encodeURIComponent(flow.slotId)}/reveal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ o_pub: toBase64(s.keyPair.pub), mac_o: toBase64(macO) }),
      });
    } catch {
      res = null;
    }
    if (!flow.live) return;
    if (!res || !res.ok) {
      // Never re-reveal on this slot: end it and start over.
      deleteSlot(flow.slotId).catch(() => {});
      finish();
      renderError('Could not reach the new device. Make a new code and try again.');
      return;
    }
    renderApprove(new Date());
  }

  // AD3: who is asking and the match code; Approve / Deny.
  function renderApprove(requestedAt) {
    const s = flow.s;
    const p = PLATFORMS[s.claim.platform];
    const [a, b] = [s.keys.sas.slice(0, 3), s.keys.sas.slice(3)];
    mount.innerHTML = `
      <div class="wg-vstack">
        <span class="wg-chip wg-chip--pending"><i class="wg-ico" data-icon="device"></i>Request · ${hhmm(requestedAt)}</span>
        <h2 class="wg-shell__title wg-shell__title--md">${p.asking} wants to open your account</h2>
      </div>
      <div class="wg-vstack">
        <span class="wg-row__title">Does your new device show this code?</span>
        <div class="wg-matchcode" id="transfer-matchcode" role="img" aria-label="Matching code ${a.split('').join(' ')}, ${b.split('').join(' ')}"><span>${a}</span><span>${b}</span></div>
      </div>
      <ul class="wg-facts wg-facts--sm">
        <li><i class="wg-ico" data-icon="device"></i><span><b>${p.app}</b>Scanned your code just now</span></li>
        <li class="is-warn"><i class="wg-ico" data-icon="eye"></i><span><b>It can open all your records</b>Deny if the digits differ, or if you didn't start this.</span></li>
      </ul>
      <p class="wg-error" id="transfer-error"></p>
      <button type="button" id="transfer-approve" class="wg-btn wg-btn--primary wg-btn--lg wg-btn--block">Approve</button>
      <button type="button" id="transfer-deny" class="wg-btn wg-btn--block">Deny</button>`;
    const approveButton = mount.querySelector('#transfer-approve');
    const denyButton = mount.querySelector('#transfer-deny');
    approveButton.addEventListener('click', async () => {
      approveButton.disabled = true;
      denyButton.disabled = true;
      if (!(await approve())) {
        approveButton.disabled = false;
        denyButton.disabled = false;
      }
    });
    denyButton.addEventListener('click', async () => {
      approveButton.disabled = true;
      denyButton.disabled = true;
      if (await cancel()) renderStopped('denied');
      else {
        approveButton.disabled = false;
        denyButton.disabled = false;
      }
    });
  }

  // The owner compared the codes: wrap the DEK for the frozen receiver only.
  async function approve() {
    const s = flow.s;
    if (!s || !s.keys || flow.approving) return false;
    flow.approving = true;
    try {
      const ct = await wrapTransferDek(s.keys.kWrap, s.dek, s.transcript);
      const body = { ct: toBase64(ct) };
      if (s.credentialId) body.approving_credential_id = toBase64Url(new Uint8Array(s.credentialId));
      // An earlier attempt may have landed with its response lost: then
      // `approved` (or a 409 on the retry) is our own doing, not a stranger's.
      const retry = s.approveSent;
      s.approveSent = true;
      let res;
      try {
        res = await fetch(`/api/transfer/${encodeURIComponent(flow.slotId)}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        res = null;
      }
      if (!flow.live) return true;
      if (res && res.status === 409) {
        // The slot left `revealed`: our lost first approve, or not the pairing
        // the owner saw. The next poll still checks the frozen receiver.
        if (retry) markApproved();
        else await abort();
        return true;
      }
      if (!res || !res.ok) {
        const errorEl = mount.querySelector('#transfer-error');
        if (errorEl) errorEl.textContent = 'Could not approve. Check your connection and try again.';
        return false;
      }
      markApproved();
      return true;
    } finally {
      flow.approving = false;
    }
  }

  function markApproved() {
    const s = flow.s;
    if (s.approved) return;
    s.approved = true;
    s.dek = null;
    const errorEl = mount.querySelector('#transfer-error');
    if (errorEl) errorEl.textContent = '';
    const actions = mount.querySelectorAll('#transfer-approve, #transfer-deny');
    actions.forEach((el) => el.remove());
    const hint = document.createElement('p');
    hint.className = 'wg-hint';
    hint.id = 'transfer-approved';
    hint.textContent = 'Approved. Finishing on your new device…';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.id = 'transfer-cancel';
    cancelButton.className = 'wg-btn wg-btn--block';
    cancelButton.textContent = 'Cancel';
    mount.append(hint, cancelButton);
    bindCancel();
  }

  // The slot ended without us seeing `enrolled`. Before an approve nobody can
  // have joined; after one, a device may have enrolled just before the end,
  // so never say "nobody joined" then.
  function endWithoutResult(expired) {
    const approveSent = Boolean(flow.s && flow.s.approveSent);
    finish();
    if (approveSent) renderUnconfirmed(true);
    else if (expired) renderExpired();
    else renderStopped('ended');
  }

  // Bad proof, a changed receiver, or a state we didn't cause: end the slot
  // and say so. Nothing has been released before approval.
  async function abort() {
    const slotId = flow.slotId;
    finish();
    deleteSlot(slotId).catch(() => {});
    renderMisuse();
  }

  // Cancel must mean cancelled (med-tuv): the slot is deleted server-side
  // before the screen may leave, and a failed DELETE keeps the user here.
  async function cancel() {
    if (!flow.live) {
      flow.closed = true;
      finish();
      return true;
    }
    try {
      const res = await deleteSlot(flow.slotId);
      if (!res.ok) throw new Error('cancel failed');
    } catch {
      const errorEl = mount.querySelector('#transfer-error');
      if (errorEl) {
        errorEl.textContent =
          'Could not cancel the code — it may still work. Check your connection and try again.';
      }
      return false;
    }
    flow.closed = true;
    finish();
    return true;
  }

  // AD4 end states share one layout.
  function renderEnd({ icon, tone = '', title, lede, chip, actions, hint }) {
    mount.innerHTML = `
      <div class="wg-vstack wg-shell--center">
        <span class="wg-shell__icon${tone ? ` wg-shell__icon--${tone}` : ''}"><i class="wg-ico" data-icon="${icon}"></i></span>
        <h2 class="wg-shell__title wg-shell__title--md" id="transfer-end-title"></h2>
        <p class="wg-shell__lede" id="transfer-end-lede"></p>
        <span class="wg-chip wg-chip--${chip.tone}"><i class="wg-ico" data-icon="${chip.icon}"></i>${chip.text}</span>
      </div>
      <div class="wg-vstack" id="transfer-end-actions"></div>`;
    mount.querySelector('#transfer-end-title').textContent = title;
    mount.querySelector('#transfer-end-lede').textContent = lede;
    const box = mount.querySelector('#transfer-end-actions');
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = a.id;
      btn.className = `wg-btn wg-btn--block${a.primary ? ' wg-btn--primary wg-btn--lg' : ''}${a.ghost ? ' wg-btn--ghost' : ''}`;
      btn.textContent = a.label;
      btn.addEventListener('click', a.onClick);
      box.append(btn);
    }
    if (hint) {
      const p = document.createElement('p');
      p.className = 'wg-hint';
      p.textContent = hint;
      box.append(p);
    }
  }

  const doneAction = (primary) => ({ id: 'transfer-done', label: 'Done', primary, ghost: !primary, onClick: () => onExit() });
  const retryAction = (primary) => ({ id: 'transfer-retry', label: 'Make a new code', primary, onClick: start });

  function renderDone(platform) {
    const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    renderEnd({
      icon: 'check', tone: 'ok',
      title: PLATFORMS[platform].added,
      lede: 'It opens your account with its own passkey.',
      chip: { tone: 'ok', icon: 'check', text: `Added · ${date}` },
      actions: [doneAction(true)],
      hint: 'Remove it any time in Devices & connectors.',
    });
  }

  function renderExpired() {
    renderEnd({
      icon: 'clock',
      title: 'The code expired',
      lede: 'Nobody joined. Codes last 10 minutes, so have the new device ready first.',
      chip: { tone: 'stale', icon: 'clock', text: 'Expired' },
      actions: [retryAction(true), doneAction(false)],
    });
  }

  function renderStopped(why) {
    const denied = why === 'denied';
    renderEnd({
      icon: 'x',
      title: 'Nobody was added',
      lede: denied
        ? "You denied the request, so the other device can't open your account."
        : 'The code stopped working before the new device finished.',
      chip: { tone: 'stale', icon: 'x', text: denied ? 'Denied' : 'Stopped' },
      actions: [doneAction(true), retryAction(false)],
    });
  }

  function renderMisuse() {
    renderEnd({
      icon: 'alert', tone: 'danger',
      title: 'Someone else tried to use this code',
      lede: "We stopped it and nothing was shared. Make a new code only when the new device is in your hand, and don't send it to anyone.",
      chip: { tone: 'danger', icon: 'alert', text: 'Code stopped' },
      actions: [{ id: 'transfer-cancel', label: 'Cancel', onClick: onExit }],
    });
  }

  // Enrolled, but the device didn't prove it holds the approved key.
  // unknown: the code ended after Approve before we saw the device finish.
  function renderUnconfirmed(unknown) {
    renderEnd({
      icon: 'alert', tone: unknown ? 'warn' : 'danger',
      title: unknown ? "We couldn't tell if the new device joined" : "We couldn't confirm the new device",
      lede: unknown
        ? "The code ended after you approved it. Check Devices & connectors and remove any device you don't recognise."
        : "A device joined with this code but didn't prove it is the one you approved. Remove any device you don't recognise in Devices & connectors.",
      chip: { tone: unknown ? 'warn' : 'danger', icon: 'alert', text: 'Check your devices' },
      actions: [{ id: 'transfer-done', label: 'Back to devices', primary: true, onClick: onExit }],
    });
  }

  function renderError(errorText) {
    finish();
    mount.innerHTML = `
      <p class="wg-error"></p>
      <button type="button" id="transfer-retry" class="wg-btn wg-btn--primary wg-btn--block">Try again</button>`;
    mount.querySelector('.wg-error').textContent = errorText;
    mount.querySelector('#transfer-retry').addEventListener('click', start);
  }

  // AD4 for a tap with no live flow here. Honest either way: another device
  // may hold the request, or this page closed and its code was deleted.
  function renderNotHere() {
    renderEnd({
      icon: 'device',
      title: "This request isn't open here",
      lede: 'Approve a new device on the screen that shows its code. If that screen was closed, the code stopped working — make a new one.',
      chip: { tone: 'stale', icon: 'x', text: 'Stopped' },
      actions: [doneAction(true), retryAction(false)],
    });
  }

  if (opts && opts.notHere) renderNotHere();
  else start();
  return {
    cancel,
    // The host's page is gone. A close that bypassed cancel() (anything but
    // Back / Cancel) still must not leave a claimable slot behind: best-effort
    // delete it.
    stop() {
      if (win) win.removeEventListener('pagehide', onPageHide);
      if (currentFlow === flow) currentFlow = null;
      if (flow.live) deleteSlot(flow.slotId).catch(() => {});
      flow.closed = true;
      finish();
    },
  };
}