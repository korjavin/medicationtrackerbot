// Push setup + demo scheduler screen (Task 6). Stands in for the C1 reminder
// engine: a "remind me in N minutes" button encrypts a payload under NK and
// PUT /api/push/schedule with the exact replace-all contract a real reminder
// engine will use. SW registration + the permission prompt are user-gesture
// gated (the "Enable notifications" button); on iOS, push only works inside
// an installed PWA, so the prompt is gated behind installed state per
// docs/cloud-mode.md Onboarding ("install first, then enable push").
import { encryptPushPayload, toBase64 } from './crypto.js';
import { getOrCreateNK, hasRichNotifications, disableRichNotifications } from './sync.js';
import { openDb } from './localdb.js';

const REMINDERS_KEY = 'demoReminders';

// Exported so the signup wizard's install step (web/cloud/js/signup.js) derives
// the same shown/skipped/iOS state from display-mode instead of duplicating the
// platform probe — docs/cloud-mode.md Onboarding ("derive steps from
// display-mode: standalone").
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

export function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent);
}

// The two load-bearing iOS install instructions, shared by the post-onboarding
// Reminders gate (renderInstallFirst) and the signup wizard's install step so
// the Share → "Add to Home Screen" wording can't drift between them. `lastStep`
// closes the list with the context-appropriate "what next" line. Callers only
// ever pass hardcoded copy — never user input — so this is safe to inject.
export function iosInstallStepsHtml(lastStep) {
  return `
      <ol>
        <li>Tap the Share button in Safari.</li>
        <li>Choose "Add to Home Screen".</li>
        <li>${lastStep}</li>
      </ol>`;
}

// Local mirror of this device's not-yet-fired demo reminders — needed because
// PUT /api/push/schedule is replace-all (docs' "Replace-all schedule" note),
// so adding one more means re-sending the whole still-pending batch.
async function readReminders() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('device', 'readonly');
      const req = tx.objectStore('device').get(REMINDERS_KEY);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function writeReminders(list) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('device', 'readwrite');
      tx.objectStore('device').put(list, REMINDERS_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function urlBase64ToUint8Array(base64) {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) throw new Error('Service workers are not supported in this browser.');
  return navigator.serviceWorker.register('/sw.js');
}

export async function getSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

// DOM-free counterpart to subscribe() — Settings' Disable button calls this
// directly, no renderPushScreen involved.
export async function unsubscribe() {
  const sub = await getSubscription();
  if (!sub) return;
  // Drop the server row before the browser subscription — mirrors subscribe()'s
  // res.ok guard. If the server delete fails, keep the browser subscription so
  // the UI still reports enabled rather than leaving a stale server row.
  const res = await fetch('/api/push/subscriptions', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  if (!res.ok) throw new Error('Could not remove this device from push.');
  await sub.unsubscribe();
}

// Safari/WebKit (including iOS) still implement the LEGACY callback form of
// Notification.requestPermission(): it returns undefined and delivers the
// result to a callback instead of resolving a promise. `await`ing it yields
// undefined, so a plain `=== 'granted'` check reports "not granted" even after
// the user taps Allow (med-eas.19). Normalize both forms. The requestPermission
// call happens synchronously inside the Promise executor, so callers that invoke
// this before any other await keep the click's transient activation.
//
// med-1n6: normalizing the two SHAPES was not enough. Resolve with
// `Notification.permission` — read after the request settles — rather than with
// whatever the callback or the promise handed us. WebKit has been observed
// invoking the legacy callback with no argument at all, and that `undefined`
// won the race against the promise, so the app told a user who had just tapped
// Allow that they had denied permission.
//
// And never call requestPermission() when the choice is already made: on that
// path WebKit may settle neither the callback nor a promise, hanging every
// caller forever — which is why the user's second tap on "Enable" did nothing
// at all. A decided permission needs no prompt anyway.
const PERMISSIONS = ['granted', 'denied', 'default'];

// Take the reported value only when it is a real permission string; otherwise
// fall back to Notification.permission, which is authoritative. WebKit's
// no-argument callback lands in the fallback; a spec-compliant browser (whose
// permission property might in principle lag its resolution) lands in the
// first branch. Either way the caller never sees `undefined`.
function normalizePermission(value) {
  if (PERMISSIONS.includes(value)) return value;
  return typeof Notification === 'undefined' ? 'denied' : Notification.permission;
}

export function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return Promise.resolve('denied');
  if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
  return new Promise((resolve) => {
    const settle = (value) => resolve(normalizePermission(value));
    const maybe = Notification.requestPermission(settle);
    // Reject → settle too: the browser refused to ask (no gesture, insecure
    // context). Leaving the promise pending would re-hang the caller.
    if (maybe && typeof maybe.then === 'function') maybe.then(settle, () => settle(undefined));
  });
}

async function subscribeWithVapid(reg) {
  const keyRes = await fetch('/api/push/vapid-public-key');
  if (!keyRes.ok) throw new Error('Push is not configured on this server.');
  const { public_key: publicKey } = await keyRes.json();
  try {
    return await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  } catch (e) {
    // Permission was granted and the browser still refused (Safari outside a
    // gesture, a bad applicationServerKey, a push service that is down). Say
    // that, rather than letting the caller report "permission denied" for a
    // permission the user just granted (med-1n6).
    throw new Error(`Subscription failed: ${e.message || e.name || e}`);
  }
}

// POST is an upsert server-side, and it resets `disabled = 0`. So re-uploading
// an endpoint the relay disabled after a 410 is exactly how a subscription
// comes back to life — not a redundant write.
async function uploadSubscription(sub) {
  const json = sub.toJSON();
  const res = await fetch('/api/push/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth }),
  });
  if (!res.ok) throw new Error('Could not register this device for push.');
}

export async function subscribe() {
  // Request permission first, before any await — Safari/iOS drop the click's
  // transient activation across an await (the VAPID fetch / SW activation) and
  // would reject the prompt without showing it.
  const permission = await requestNotificationPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted.');
  await registerServiceWorker();
  // register() resolves once the registration is recorded, not once the worker
  // is active; pushManager.subscribe() on an inactive registration throws
  // InvalidStateError on first enable. serviceWorker.ready waits for an active
  // worker and returns its registration.
  const reg = await navigator.serviceWorker.ready;
  const sub = await subscribeWithVapid(reg);
  await uploadSubscription(sub);
  return sub;
}

// ensurePushSubscription reconciles this device's push subscription on every
// app boot. It is the load-bearing half of med-d5t.3.
//
// Safari evicts the push subscription of a PWA that goes unopened for a few
// days. Before this existed, nothing noticed: the app kept rendering as though
// reminders were armed, the SW's `pushsubscriptionchange` event was unhandled,
// and the documented countermeasure — the server's stale-sync warning — is
// itself a web push, so it could never arrive through the very subscription
// that had just died. Medication reminders simply stopped, forever, silently.
//
// The subscribe() call needs no user gesture once permission is granted, so
// this can run unattended at boot. Returns a state rather than throwing: the
// caller is a best-effort boot step, and Settings renders the state.
export async function ensurePushSubscription() {
  if (!('serviceWorker' in navigator)) return { state: 'unsupported' };
  // Register before any push gate: the SW also serves the offline app shell
  // (med-deq.1), which must exist for users who never granted notification
  // permission. Only the push arming below is permission-gated.
  try {
    await registerServiceWorker();
  } catch (e) {
    console.error('[push] could not register the service worker', e);
    return { state: 'failed', error: e };
  }
  if (typeof PushManager === 'undefined') return { state: 'unsupported' };
  // Permission is the user's standing intent to be reminded. Without it there
  // is nothing to repair — enabling push is a deliberate, gestured act.
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return { state: 'not-granted' };
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      // The browser still has it, but the server may have disabled the row on a
      // 410 from a transient push-service failure. Re-upload to heal that.
      await uploadSubscription(existing);
      return { state: 'ok', subscription: existing };
    }
    const sub = await subscribeWithVapid(reg);
    await uploadSubscription(sub);
    return { state: 'resubscribed', subscription: sub };
  } catch (e) {
    // Offline, or the push service refused. Reminders are NOT armed; say so
    // rather than letting the UI imply otherwise.
    console.error('[push] could not restore the push subscription', e);
    return { state: 'failed', error: e };
  }
}

// sendTestPush sends an immediate, this-device-only test notification: no
// schedule round-trip, no relay ticker wait, and no risk of clobbering the
// real reminder schedule (see docs/cloud-mode.md — replaces the old
// append-to-schedule test path).
export async function sendTestPush(ctx) {
  const sub = await getSubscription();
  if (!sub) throw new Error('Enable push notifications on this device first.');
  const nk = await getOrCreateNK(ctx);
  const plaintext = new TextEncoder().encode(JSON.stringify({ title: 'Med Tracker', body: 'Test notification' }));
  const ct = await encryptPushPayload(nk, plaintext);
  const res = await fetch('/api/push/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint, ct: toBase64(ct) }),
  });
  if (!res.ok) {
    if (res.status === 410 || res.status === 404) {
      throw new Error("This device's subscription expired — re-enable push notifications.");
    }
    throw new Error("Couldn't send the test push — try again in a moment.");
  }
}

// pushSchedule uploads the reminder horizon to the blind relay. pref picks the
// delivery channel and, for Telegram, how much the message says — a Telegram
// entry hands the relay PLAINTEXT (it cannot decrypt the vault), so 'generic'
// verbosity is what keeps medication names out of the relay's reach.
export async function pushSchedule(ctx, reminders, pref = {}) {
  const delivery = ['webpush', 'telegram', 'both'].includes(pref.delivery) ? pref.delivery : 'webpush';
  const verbosity = pref.verbosity === 'generic' ? 'generic' : 'detailed';
  const needsCT = delivery === 'webpush' || delivery === 'both';
  const needsText = delivery === 'telegram' || delivery === 'both';

  // A telegram-only schedule never touches the NK, so don't mint one for it.
  const nk = needsCT ? await getOrCreateNK(ctx) : null;
  const entries = [];
  for (const r of reminders) {
    const entry = { fire_at_unix: r.fireAtUnix, delivery };
    if (needsCT) {
      // `kind` rides inside the NK ciphertext (never on the wire in clear) so
      // the service worker can attach the right Snooze / Don't-bug action
      // buttons without the relay learning what sort of reminder this is.
      const plaintext = new TextEncoder().encode(JSON.stringify({ title: 'Med Tracker', body: r.text, kind: r.kind }));
      entry.ct = toBase64(await encryptPushPayload(nk, plaintext));
    }
    if (needsText) {
      entry.tg_text = verbosity === 'generic' ? (r.genericText || r.text) : r.text;
      // Medication entries carry an "s:<slotUnix>" stem; the relay turns it into
      // Confirm/Snooze buttons. BP/weight reminders have no stem and no buttons.
      // Safe at either verbosity: the slot instant is already fire_at_unix.
      if (r.callback) entry.tg_callback = r.callback;
    }
    entries.push(entry);
  }
  const res = await fetch('/api/push/schedule', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  });
  if (!res.ok) throw new Error('Could not schedule the reminder.');
}

async function addDemoReminder(ctx, minutes, text) {
  const now = Math.floor(Date.now() / 1000);
  const reminders = (await readReminders()).filter((r) => r.fireAtUnix > now);
  reminders.push({ fireAtUnix: now + Math.round(minutes * 60), text });
  await writeReminders(reminders);
  await pushSchedule(ctx, reminders);
  return reminders;
}

export function renderPush(app, ctx, onExit) {
  if (isIOS() && !isStandalone()) {
    renderInstallFirst(app, onExit);
    return;
  }
  renderPushScreen(app, ctx, onExit);
}

function renderInstallFirst(app, onExit) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Reminders</h1>
      <p>Install this app to your Home Screen before enabling notifications —
         iOS only delivers push to an installed app.</p>
      ${iosInstallStepsHtml('Open Med Tracker from your Home Screen and come back here.')}
      <button id="push-back">Back</button>
    </section>`;
  app.querySelector('#push-back').addEventListener('click', onExit);
}

function renderPushScreen(app, ctx, onExit) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Reminders <small>(sync demo)</small></h1>
      <p class="wizard-error" id="push-error"></p>
      <p id="push-status" class="sync-status">Checking subscription&hellip;</p>
      <button id="push-enable">Enable notifications</button>
      <form id="reminder-form" class="note-form" hidden>
        <input id="reminder-text" placeholder="Reminder text" autocomplete="off" />
        <input id="reminder-minutes" type="number" min="1" value="1" />
        <button type="submit">Remind me</button>
      </form>
      <label id="rich-toggle-row" hidden>
        <input type="checkbox" id="rich-toggle" /> Rich notifications
      </label>
      <ul id="reminder-list" class="note-list"></ul>
      <button id="push-back">Back</button>
    </section>`;

  app.querySelector('#push-back').addEventListener('click', onExit);
  app.querySelector('#push-enable').addEventListener('click', () => {
    subscribe()
      .then(() => refresh(app, ctx))
      .catch((err) => showError(app, err));
  });
  app.querySelector('#reminder-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const textInput = app.querySelector('#reminder-text');
    const text = textInput.value.trim();
    const minutes = Number(app.querySelector('#reminder-minutes').value) || 1;
    if (!text) return;
    textInput.value = '';
    addDemoReminder(ctx, minutes, text)
      .then((reminders) => renderReminderList(app, reminders))
      .catch((err) => showError(app, err));
  });
  app.querySelector('#rich-toggle').addEventListener('change', (ev) => {
    (ev.target.checked ? getOrCreateNK(ctx) : disableRichNotifications()).catch((err) => showError(app, err));
  });

  refresh(app, ctx).catch((err) => showError(app, err));
}

async function refresh(app, ctx) {
  const [sub, rich, reminders] = await Promise.all([getSubscription(), hasRichNotifications(), readReminders()]);
  const statusEl = app.querySelector('#push-status');
  const enableBtn = app.querySelector('#push-enable');
  const form = app.querySelector('#reminder-form');
  const toggleRow = app.querySelector('#rich-toggle-row');
  const toggle = app.querySelector('#rich-toggle');
  if (!statusEl) return;
  if (sub) {
    statusEl.textContent = 'Notifications enabled on this device.';
    enableBtn.hidden = true;
    form.hidden = false;
    toggleRow.hidden = false;
    toggle.checked = rich;
  } else {
    statusEl.textContent = 'Notifications are off on this device.';
    enableBtn.hidden = false;
    form.hidden = true;
    toggleRow.hidden = true;
  }
  const now = Math.floor(Date.now() / 1000);
  renderReminderList(app, reminders.filter((r) => r.fireAtUnix > now));
}

function renderReminderList(app, reminders) {
  const list = app.querySelector('#reminder-list');
  if (!list) return;
  list.replaceChildren();
  for (const r of reminders) {
    const li = document.createElement('li');
    li.className = 'note-row';
    const span = document.createElement('span');
    // r.text is this account's own plaintext demo reminder — still textContent
    // as a matter of course on this DEK-holding page.
    span.textContent = `${r.text} — ${new Date(r.fireAtUnix * 1000).toLocaleTimeString()}`;
    li.appendChild(span);
    list.appendChild(li);
  }
}

function showError(app, err) {
  const el = app.querySelector('#push-error');
  if (el) el.textContent = err.message || String(err);
}
