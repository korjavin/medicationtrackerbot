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

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent);
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

async function getSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

async function subscribe() {
  // Request permission first, before any await — Safari/iOS drop the click's
  // transient activation across an await (the VAPID fetch / SW activation) and
  // would reject the prompt without showing it.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted.');
  await registerServiceWorker();
  // register() resolves once the registration is recorded, not once the worker
  // is active; pushManager.subscribe() on an inactive registration throws
  // InvalidStateError on first enable. serviceWorker.ready waits for an active
  // worker and returns its registration.
  const reg = await navigator.serviceWorker.ready;
  const keyRes = await fetch('/api/push/vapid-public-key');
  if (!keyRes.ok) throw new Error('Push is not configured on this server.');
  const { public_key: publicKey } = await keyRes.json();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  const json = sub.toJSON();
  const res = await fetch('/api/push/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth }),
  });
  if (!res.ok) throw new Error('Could not register this device for push.');
  return sub;
}

async function pushSchedule(ctx, reminders) {
  const nk = await getOrCreateNK(ctx);
  const entries = [];
  for (const r of reminders) {
    const plaintext = new TextEncoder().encode(JSON.stringify({ title: 'Med Tracker', body: r.text }));
    const ct = await encryptPushPayload(nk, plaintext);
    entries.push({ fire_at_unix: r.fireAtUnix, ct: toBase64(ct) });
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
      <ol>
        <li>Tap the Share button in Safari.</li>
        <li>Choose "Add to Home Screen".</li>
        <li>Open Med Tracker from your Home Screen and come back here.</li>
      </ol>
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
