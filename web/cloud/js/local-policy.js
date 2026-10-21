// Local-only mode's side-effect and egress policy (bd med-o7zq.3, epic
// med-o7zq): what local-boot.js injects into installApiShim in place of the
// cloud's server-backed effects. In local mode nothing leaves the device except
// calls to the providers the user configured with their own key (BYOK AI,
// their own food DB) and, only if the user turns it on, the free trial (AI and
// food database). The iOS shell enforces that with its CSP (connect-src
// 'self' + the hosts registered here, ios/App/LocalOrigin.swift); this module
// makes the app stop asking for anything else:
//
//   reminders   computed on the device and handed to the iOS scheduler only,
//               on every write, open and return to the front; no relay
//               upload, no Telegram re-fire calls.
//   RxNav       off (the lookup is the operator's proxy) — installApiShim gets
//               rxnorm: null and a med save simply carries no rxcui.
//   egress      BYOK hosts go to the shell (bridge op setEgressHosts), never
//               to a server.
//   trial AI    off unless the user turns on the anonymous trial (bd
//               med-o7zq.16): then local-trial.js signs each request with App
//               Attest. Our base domain is in the shell's host list whenever
//               the shell names it (localEgressHosts), called only by the
//               trial and the "Request an invite" form. The account trial's meta flag stays
//               out of the bundle (ios/bundle-web.sh).
//   food DB     no food-DB meta in the bundle. The operator's DB rides the
//               same trial switch (bd med-o7zq.20): LOCAL_FOOD_DB below sends
//               fooddb.js's lookups through local-trial.js to the attest
//               routes while it is on; off, it is unavailable and says why.
//   voice       the call trigger only while the same trial switch is on (bd
//               med-o7zq.23): window.CloudVoiceLLM becomes a responder whose
//               start() mints the call through local-trial.js, and
//               api.elevenlabs.io joins the host list with the base domain.
//   UI          features that need our server carry .wg-cloud-only and hide
//               under :root.wg-local-vault (styles.css), which local-boot.js
//               sets before the body parses.
//
// Privacy disclosure: the local-* rows in privacy-manifest.js.
import {
  scheduleReminderRecompute, recomputeAndPush, onLocalScheduleResult,
} from './reminders.js';
import { canAllowlist, hostsFromIntegrations } from './egress-hosts.js';
import { readAllLocalRecords, replaceAllRecords, localRecordsPort } from './sync.js';
import { withMaterializationStopped } from './apishim.js';
import { createSettingsDomain, PROTECTION_RECORD_TYPE } from '../../domain/settings.js';
import { recordsToVault, vaultToRecords, managedTypesForImport, hasUserContent, userContentCount, mergeRecords } from '../../domain/vault.js';
import { startHealthImport, runHealthImport, resetHealthAnchors } from './health-import.js';
import { clearLocalVault } from './account-delete.js';
import { setTrialTransport } from './aiclient.js';
import { createLocalTrial } from './local-trial.js';
import { createVoiceLLMResponder } from './voice-llm-responder.js';

// Settings → Notifications fires this on the document once iOS permission is
// granted, so the schedule lands now instead of on the next open. settings.js
// is a classic script and spells the name out; the integration test pins both.
const RESCHEDULE_EVENT = 'wg:local-reminders-reschedule';
// Fired on the document after every device schedule attempt (detail: the
// result, as lastReminderSchedule returns it); settings.js spells it out too.
const SCHEDULED_EVENT = 'wg:local-reminders-scheduled';
let lastSchedule = null;

// The app shell's bridge foundation (native/index.js) when this document runs
// in the iOS or Android app, else null — an unknown platform is refused too.
function shellNative(win) {
  const native = win && win.LocalNotifications && win.LocalNotifications.__native;
  return native && (native.platform === 'ios' || native.platform === 'android') ? native : null;
}

// The device the copy names, off the capability (native/local-notifications.js:
// 'iPhone' or 'phone'); the fallback is the iOS copy, so fixtures without
// `copy` read as before.
function deviceName(win = globalThis) {
  return win?.LocalNotifications?.copy?.device || 'iPhone';
}

function localNotifications() {
  const local = globalThis.LocalNotifications;
  try {
    return local?.isSupported?.() === true ? local : null;
  } catch {
    return null; // native/ stub: not registered
  }
}

export const LOCAL_EFFECTS = {
  scheduleReminderRecompute(ctx, opts = {}, debounceMs) {
    scheduleReminderRecompute(ctx, { ...opts, relay: false }, debounceMs);
  },
  // The re-fire chains live in the relay; there is none.
  cancelMedRefire() {},
  cancelReminderRefire() {},
  async sendTestPush() {
    const local = localNotifications();
    if (!local) throw new Error('Notifications are not available on this device.');
    await local.test();
  },
};

// The phone holds at most 64 reminders, and their last one ("Open the app to
// keep reminders running") is the only refill, so every open and every return
// to the front reschedules, as cloud-boot.js does. Not the debounced
// scheduler: a quick close would drop its timer (bd med-9y9). Never on the web.
//
// Every outcome — each device schedule (reminders.js), or a recompute that
// failed before reaching it — is kept for Settings → Notifications
// (LOCAL_VAULT.lastReminderSchedule) and announced as SCHEDULED_EVENT, so a
// failure is on screen, not only in the console.
export function keepLocalRemindersFresh({ ctx, records, win }) {
  if (!localNotifications()) return;
  const publish = (result) => {
    lastSchedule = result;
    win.document.dispatchEvent(new win.CustomEvent(SCHEDULED_EVENT, { detail: result }));
  };
  onLocalScheduleResult(publish);
  const run = () => recomputeAndPush(ctx, { records, relay: false })
    .catch((e) => {
      publish({ ok: false, error: (e && e.message) || String(e), at: Date.now() });
      console.error('[local] reminder reschedule failed', e);
    });
  run();
  win.document.addEventListener('visibilitychange', () => {
    if (win.document.visibilityState === 'visible') run();
  });
  // Permission just granted: the outcome from before it no longer says
  // anything, so Settings shows "Scheduling…" until this one lands.
  win.document.addEventListener(RESCHEDULE_EVENT, () => {
    lastSchedule = null;
    run();
  });
}

// Set by startLocalHealthImport. LOCAL_VAULT.eraseDevice awaits the stop;
// importAll stops around its replace and resumes when the replace fails (on
// success the page reloads and a fresh importer starts).
let stopHealthImport = async () => {};
let resumeHealthImport = () => {};

// Apple Health import (bd med-o7zq.9): the cloud's Settings row and run loop,
// writing into the on-device store with nothing to flush, then rescheduling
// the device's reminders. Only inside the iOS shell (window.Health).
export function startLocalHealthImport({ ctx, records, win }) {
  const health = win.Health;
  try {
    if (health?.isSupported?.() !== true) return null;
  } catch {
    return null; // native/ stub: not registered
  }
  let current = null;
  let stopped = false;
  // Erase stops the importer before it wipes: a run still in flight would
  // write records and anchors back after it, and none may start after.
  stopHealthImport = async () => {
    stopped = true;
    await current;
  };
  resumeHealthImport = () => { stopped = false; };
  return startHealthImport(ctx, {
    health,
    storage: win.localStorage,
    doc: win.document,
    run: (opts) => {
      if (stopped) return Promise.resolve(null);
      const pass = runHealthImport(ctx, { ...opts, records, flush: async () => {} });
      current = pass.catch(() => null); // its failure is startHealthImport's to log
      return pass;
    },
    afterImport: async () => {
      if (!stopped) await recomputeAndPush(ctx, { records, relay: false });
    },
  });
}

// Settings → App lock (bd med-nt9p.32.9, iOS med-o7zq.39): the shell's optional
// lock (android/.../LocalLock.kt, ios/App/LocalLock.swift; iOS also keeps its
// iPhone Settings toggle, same key). The web has none, so only a phone shell is
// asked; an older iOS shell rejects the op and gets no row. The row mounts when it
// answers lock.status { on, available } and the phone has a screen lock (or
// the lock is already on, so it can be turned off). lock.set { on } shows the
// phone's own check and resolves true once the choice applied.
export async function mountLocalLockRow({ win }) {
  const native = shellNative(win);
  if (!native) return null;
  let status = null;
  try { status = await native.call('lock.status'); } catch { return null; }
  if (!status || (!status.on && !status.available)) return null;
  const doc = win.document;
  const home = doc.querySelector('#settings-view .wg-settings-home');
  if (!home || doc.getElementById('settings-local-lock')) return null;

  const group = doc.createElement('div');
  group.className = 'wg-list wg-local-only';
  const row = doc.createElement('div');
  row.id = 'settings-local-lock';
  row.className = 'wg-setting';
  const lead = doc.createElement('span');
  lead.className = 'wg-row__lead';
  const ico = doc.createElement('i');
  ico.className = 'wg-ico';
  ico.dataset.icon = 'lock';
  lead.appendChild(ico);
  const body = doc.createElement('span');
  body.className = 'wg-setting__body';
  const title = doc.createElement('span');
  title.className = 'wg-setting__title';
  title.textContent = 'App lock';
  const desc = doc.createElement('span');
  desc.className = 'wg-setting__desc';
  const check = native.platform === 'ios' ? 'Face ID, Touch ID or passcode' : 'fingerprint, face or screen lock';
  desc.textContent = `Asks for your ${check} each time you open Med Tracker. It hides the app; it does not encrypt your records, and reminders on the lock screen still show.`;
  body.append(title, desc);
  const toggle = doc.createElement('label');
  toggle.className = 'wg-toggle';
  const input = doc.createElement('input');
  input.type = 'checkbox';
  input.id = 'settings-local-lock-toggle';
  input.className = 'wg-toggle__input';
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', 'App lock');
  input.checked = status.on === true;
  input.addEventListener('change', async () => {
    const want = input.checked;
    input.disabled = true;
    try {
      if ((await native.call('lock.set', { on: want }).catch(() => false)) !== true) input.checked = !want;
    } finally {
      input.disabled = false;
    }
  });
  // The lock can change outside the page (iPhone Settings → Lock, applied on
  // return): re-read it whenever the page comes back, which is after any unlock.
  doc.addEventListener('visibilitychange', async () => {
    if (doc.visibilityState !== 'visible' || input.disabled) return;
    try {
      const now = await native.call('lock.status');
      if (now && !input.disabled) input.checked = now.on === true;
    } catch { /* locked again or gone: keep what it shows */ }
  });
  toggle.appendChild(input);
  row.append(lead, body, toggle);
  group.appendChild(row);
  // Kit S6 slot ② (bd med-ckm5.6), right under the mode card.
  (home.querySelector('[data-settings-slot="mode-actions"]') || home).prepend(group);
  if (win.WGIcons && typeof win.WGIcons.hydrate === 'function') win.WGIcons.hydrate(group);
  return group;
}

// The shell's App Attest support (window.Attest, ios/App/Attest.swift):
// { supported, base, attested }, or null where there is none (the web, the
// Simulator, a stub, a locked shell).
// The shell's Attest.status() as is (its base even where App Attest itself is
// unsupported — what invite.js's shellBase() reads), or null.
async function shellStatus(win) {
  try {
    if (win.Attest?.isSupported?.() !== true) return null;
    return (await win.Attest.status()) || null;
  } catch {
    return null;
  }
}

async function attestStatus(win) {
  const status = await shellStatus(win);
  return status && status.supported === true && status.base ? status : null;
}

// The anonymous trial (bd med-o7zq.16: AI; med-o7zq.20: food) this document's
// CSP admits: the local-trial.js transport while it is on, else null. Set by
// registerLocalEgress, read by LOCAL_VAULT.trial and LOCAL_FOOD_DB.
let localTrial = null;
let lastEgress = null;
// apishim's window.CloudVoiceLLM (the account relay, whose device leg is this
// origin's /api/voice-llm/device — nothing answers it here), put back when the
// trial goes off.
let defaultVoice = null;

// The operator's ElevenLabs host: the voice SDK talks to it phone-direct
// (https + wss) once our server minted the call's signed URL.
const ELEVENLABS_HOST = 'api.elevenlabs.io';
// elevenlabs-call.js (a classic script) spells the name out.
const VOICE_CHANGED_EVENT = 'wg:voice-llm-changed';

// Anonymous calls' turns are answered by our server (voice_llm_relay.go
// anonTurn), so no request frame should reach this leg; one that does fails
// like a missing key.
const NO_AI = {
  chatStream: () => Promise.reject(Object.assign(new Error('no AI key in on-device mode'), { code: 'no_api_key' })),
  usesTrial: () => true,
};

function useLocalTrial(base, attest, win) {
  if (!win.CloudVoiceLLM?.localTrial) defaultVoice = win.CloudVoiceLLM;
  // styles.css shows the call trigger under :root.wg-local-trial.
  win.document.documentElement.classList.toggle('wg-local-trial', !!base);
  if (!base) {
    localTrial = null;
    foodParked = null;
    setTrialTransport(null);
    if (win.CloudVoiceLLM?.localTrial) {
      win.CloudVoiceLLM.stop();
      win.CloudVoiceLLM = defaultVoice;
    }
    return;
  }
  if (localTrial && localTrial.base === base) return;
  foodParked = null;
  const trial = createLocalTrial({
    attest, base, fetchImpl: win.fetch.bind(win), storage: win.localStorage,
  });
  localTrial = trial;
  setTrialTransport(trial);
  win.CloudVoiceLLM?.stop?.();
  // elevenlabs-call.js takes the signed URL from start() when localTrial is set.
  win.CloudVoiceLLM = Object.assign(createVoiceLLMResponder({
    aiClient: NO_AI,
    url: `wss://${base}/api/attest/voice/device`,
    mint: () => trial.voiceStart(),
  }), { localTrial: true });
  // The call bar may have mounted (and read "Set up voice agent") before this
  // ran: elevenlabs-call.js re-reads its readiness on this event.
  win.document.dispatchEvent(new win.CustomEvent(VOICE_CHANGED_EVENT));
}

// The operator food-DB port (fooddb.js) for local mode: the trial transport
// while it is on, else unavailable — no request at all — with the reason as
// hint(). Answers that say "not now" park it in memory: today's lookups spent
// (429 install-day) until resets_at, the operator having no food DB or no
// trial at all (503 food_not_configured / trial_not_configured) for an hour.
export const FOOD_OFF_COPY = 'No food database in device-only mode. Turn on the free trial in Settings → AI & integrations, or add your own food DB.';
export const FOOD_PAUSED_COPY = 'Food lookups paused until tomorrow.';
const foodUsedCopy = () => `The free trial was already used on this ${deviceName()}. Add your own food DB in Settings → AI & integrations.`;
let foodParked = null; // { hint, until }

export const LOCAL_FOOD_DB = {
  hint() {
    if (!localTrial) return FOOD_OFF_COPY;
    if (localTrial.state()?.used) return foodUsedCopy();
    if (foodParked && Date.now() < foodParked.until) return foodParked.hint;
    return '';
  },
  available() {
    return LOCAL_FOOD_DB.hint() === '';
  },
  async get(pathAndQuery, signal) {
    if (!LOCAL_FOOD_DB.available()) return null;
    const res = await localTrial.foodGet(pathAndQuery, signal);
    if (res.status === 429 || res.status === 503) {
      const body = await res.clone().json().catch(() => ({}));
      const now = Date.now();
      if (body.error === 'trial_budget_exhausted' && body.scope === 'install-day') {
        foodParked = { hint: FOOD_PAUSED_COPY, until: Date.parse(body.resets_at) || now + 24 * 3600e3 };
      } else if (body.error === 'food_not_configured' || body.error === 'trial_not_configured') {
        foodParked = { hint: FOOD_OFF_COPY, until: now + 3600e3 };
      }
    }
    return res;
  },
};

// registerLocalEgress is installApiShim's registerEgress in local mode: the
// same BYOK hostnames the cloud PUTs to /api/egress-hosts, handed to the app
// shell (iOS or Android) instead. The shell's reply says whether the stored
// list changed; the new CSP applies on the next document load (local-boot.js
// reloads). Resolves to { hosts, changed },
// or null where there is no shell to tell (the web, tests).
//
// The list is localEgressHosts below. The trial (the `anon` trial consent:
// one switch in Settings → AI & integrations for the AI and the food database,
// bd med-o7zq.20) needs the shell's App Attest; off, nothing here talks to our
// server, though its base stays listed. The transport is installed
// only once this document's CSP carries the host (no change pending a
// reload), and a first enrollment runs then, so Settings can show the count.
// Settled by the first registerLocalEgress, whatever its outcome: until then
// LOCAL_VAULT.trial cannot tell "no App Attest" from "not told yet", so its
// readers wait for it (the first-run screen renders right after boot).
// localEgressHosts is the shell's host list (bd med-ta2n.14). Both shells take
// it whole or not at all — at most SHELL_MAX_HOSTS bare [a-z0-9.-] names, else
// "invalid hosts" — and reload when the ordered array changes, so the order is
// fixed: [BYOK in hostsFromIntegrations order, base, api.elevenlabs.io].
// - base (Attest.status().base): listed whenever it normalizes (trim,
//   lowercase, canAllowlist), trial or not — the "Request an invite" POST
//   needs it and a CSP change only lands on the next load. One that doesn't
//   (a QA base with a port) is skipped, never sent raw.
// - elevenlabs: only while the trial is on.
// - over the cap: with the trial on, base + elevenlabs win and BYOK is cut
//   from the end; off, BYOK wins and the base is skipped. (BYOK is at most
//   three hosts today, so the cap does not bind.)
const SHELL_MAX_HOSTS = 8; // ios/App/LocalOrigin.swift maxHosts, Android MainActivity
export function localEgressHosts(byok, base, trialOn) {
  const b = typeof base === 'string' ? base.trim().toLowerCase() : '';
  const tail = canAllowlist(b) ? [b] : [];
  if (trialOn) tail.push(ELEVENLABS_HOST);
  const head = [];
  for (const h of byok || []) if (canAllowlist(h) && !tail.includes(h) && !head.includes(h)) head.push(h);
  if (trialOn) return [...head.slice(0, SHELL_MAX_HOSTS - tail.length), ...tail];
  return head.length + tail.length <= SHELL_MAX_HOSTS ? [...head, ...tail] : head.slice(0, SHELL_MAX_HOSTS);
}

let firstEgressSettled;
const firstEgress = new Promise((resolve) => { firstEgressSettled = resolve; });

export async function registerLocalEgress(args) {
  try {
    return await registerLocalEgressNow(args);
  } finally {
    firstEgressSettled();
  }
}

async function registerLocalEgressNow({ settings, win }) {
  const native = shellNative(win);
  if (!native) return null;
  lastEgress = { settings, win };
  const byok = hostsFromIntegrations(await settings.readIntegrationsUnmasked());
  const status = await shellStatus(win);
  const attest = status && status.supported === true && status.base ? status : null;
  const trialOn = !!attest && (await settings.getTrialConsent())?.anon === true;
  const hosts = localEgressHosts(byok, status && status.base, trialOn);
  const reply = await native.call('setEgressHosts', { hosts });
  const changed = !!(reply && reply.changed);
  if (!changed) {
    // The call bar's "turn on the free trial" hint, where the trial exists.
    win.document.documentElement.classList.toggle('wg-local-trial-off', !!attest && !trialOn);
    useLocalTrial(trialOn ? attest.base : null, win.Attest, win);
    if (trialOn && !attest.attested && !localTrial.state()) {
      localTrial.enroll().catch((e) => console.warn('[local] trial enrollment failed', e));
    }
  }
  return { hosts, changed };
}

// The account → local move, local side (bd med-o7zq.36.4; contract in
// docs/ios.md and docs/android.md "leave stash"). Settings → Account "Use this
// <device> without an account" stashed the account's vault (leave.stash);
// this boot picks it up through the same restoreVault as Settings → Restore,
// so Merge / Replace / Cancel guards records already here. The shells keep
// the page from loading while a local app lock is up (a 'locked' rejection is
// just "no stash"), so the pickup only runs after an unlock.
// - Inert on the web and on shells whose shell.ops lacks leave.take; every
//   bridge call is time-boxed (same 5 s as cloud-boot.js's move pickup).
// - A rejected or empty leave.take clears nothing: the next boot asks again.
// - Once a vault was taken, leave.clear runs whatever restoreVault answers;
//   on a Cancel with {back: true}, so the shell reopens the account.
const LEAVE_NOTICE_KEY = 'wg-leave-picked-up';
const LEAVE_PROBE_MS = 5000;
function withinMs(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => { setTimeout(() => resolve(null), ms); })]);
}

// The reload after a pickup lands here once more: say where the records went.
// Returns whether it did (pickupLeaveStash's `justPicked`).
export function showLeaveToastOnce({ win }) {
  let picked = false;
  try {
    picked = win.sessionStorage.getItem(LEAVE_NOTICE_KEY) === '1';
    if (picked) win.sessionStorage.removeItem(LEAVE_NOTICE_KEY);
  } catch { /* storage blocked */ }
  if (picked) win.safeToast(`Your records from your account are on this ${deviceName(win)}.`, 'success');
  return picked;
}

export async function pickupLeaveStash({ win, justPicked = false }) {
  const native = shellNative(win);
  // nativeHas: features/settings.js, the one memoised shell.ops probe per page.
  if (!native || typeof win.nativeHas !== 'function') return;
  if ((await withinMs(win.nativeHas('leave.take').catch(() => false), LEAVE_PROBE_MS)) !== true) return;
  const clear = () => withinMs(native.call('leave.clear').catch(() => null), LEAVE_PROBE_MS);
  // The reload right after a pickup: a stash still here is the one just
  // imported, its leave.clear lost to the time box on a slow bridge. Taking
  // it again would ask Merge / Replace over its own records (iOS flow QA,
  // bd med-w6gx.23.8).
  if (justPicked) { await clear(); return; }
  const stash = await withinMs(native.call('leave.take').catch(() => null), LEAVE_PROBE_MS);
  const vault = stash && stash.vault;
  const restore = win.SettingsImportExport && win.SettingsImportExport.restoreVault;
  if (typeof vault !== 'string' || !vault || typeof restore !== 'function') return;
  const r = await restore(vault, {
    source: 'leave',
    beforeReload: async () => {
      try { win.sessionStorage.setItem(LEAVE_NOTICE_KEY, '1'); } catch { /* storage blocked */ }
      await clear();
    },
  });
  if (r && r.imported) return;
  if (r && r.cancelled) {
    // Cancel = nothing happened (bd med-o7zq.42): no dialog, back to the
    // account this leave came from. A shell that does not know it (older
    // builds ignore `back`) only clears: local mode stays, records untouched.
    await withinMs(native.call('leave.clear', { back: true }).catch(() => null), LEAVE_PROBE_MS);
    return;
  }
  // ponytail: one-shot pickup; the account copy is the retry. restoreVault's
  // busy answer lands here too, so a pickup racing a manual restore is
  // dropped — add a busy flag to restoreVault if that ever matters.
  await clear();
  const device = deviceName(win);
  await win.safeAlert(
    `Your account's records were not copied to this ${device}. Your account is unchanged: open it again and choose Use this ${device} without an account to retry, or restore a backup file.`,
    { title: 'Records not copied' },
  );
}

// backupAt: the file is a backup and says so (vault.js data.protection), so a
// restore remembers it. Nothing is written here: the record is marked when the
// file confirmably leaves the device (LOCAL_VAULT.markBackup). withProtection
// false: no data.protection block at all (the move stash, below).
async function exportJSON(includeSecrets, backupAt, { withProtection = true } = {}) {
  let records = await readAllLocalRecords();
  if (!withProtection) records = records.filter((r) => r.recordType !== PROTECTION_RECORD_TYPE);
  return JSON.stringify(recordsToVault(records, { now: Date.now(), includeSecrets, backupAt }), null, 2);
}

// The W4 nudge's local half (bd med-ta2n.4), injected into the router as
// `protection` (apishim GET /api/protection/status): only local mode nudges.
// The weekly toast's stamp (bd med-o7zq.5, retired) is read as a free 14-day
// snooze for existing users (owner decision), never written, and removed
// once the protection record is. wg.backup.last (importexport.js, every Save
// or Share, med-ckm5.7) is read the same way — a 14-day snooze, since a Save
// cannot tell a cancelled picker — and never written or removed here (the
// Backup page's "last N days ago" owns it).
const LEGACY_BACKUP_NUDGE_KEY = 'wg:local-backup-nudge-at';
const LAST_SAVE_KEY = 'wg.backup.last';
const readStamp = (win, key) => {
  try { return Number(win.localStorage.getItem(key)) || null; } catch { return null; }
};
export const LOCAL_PROTECTION = {
  legacyDismissedAt(win) { return readStamp(win, LEGACY_BACKUP_NUDGE_KEY); },
  savedAt(win) { return readStamp(win, LAST_SAVE_KEY); },
  recordWritten(win) {
    try { win.localStorage.removeItem(LEGACY_BACKUP_NUDGE_KEY); } catch { /* storage blocked */ }
  },
};

// Settings → Backup (importexport.js reads window.CloudVault): the same
// recordsToVault / vaultToRecords conversion as cloud-boot.js, over the
// on-device store. Moving to a cloud account is moveToCloud: this export,
// handed to the shell, which the new account picks up. This origin keeps
// its data.
export const LOCAL_VAULT = {
  async hasUserContent() {
    return hasUserContent(await readAllLocalRecords());
  },
  // The P3 "Turn on sync?" sheet's "Your N records" (features/invite.js).
  async userContentCount() {
    return userContentCount(await readAllLocalRecords());
  },
  async exportAll({ includeSecrets = true } = {}) {
    return exportJSON(includeSecrets, Date.now());
  },
  // The backup file confirmably left the device (Backup ready's Share
  // resolved, importexport.js): the W4 nudge retires (bd med-ta2n.4). Save,
  // a cancelled Share, a dismissed Backup ready or a failed export never
  // gets here.
  async markBackup({ win = globalThis.window } = {}) {
    await createSettingsDomain({ records: localRecordsPort(), now: Date.now, timeZone: 'UTC' }).markBackup();
    LOCAL_PROTECTION.recordWritten(win);
  },
  // Replace-only, like the cloud's importAll: everything the file manages is
  // replaced, records it does not (the secrets of a secrets-free file) stay.
  // No account cursor, pending queue or snapshot here. vaultToRecords throws on
  // a foreign or unknown-version file before anything is touched. The Health
  // import stops right before the replace (the page reloads after) so none of
  // its writes or anchors land around it — and resumes if the replace fails;
  // the anchors are then reset, since they describe the replaced records.
  // mode 'merge' (bd med-o7zq.38) keeps every record here and adds the file's
  // absent ones (vault.js mergeRecords, receiver wins).
  async importAll(json, { win = globalThis.window, mode } = {}) {
    const vault = typeof json === 'string' ? JSON.parse(json) : json;
    const records = vaultToRecords(vault, { now: Date.now() });
    const managed = managedTypesForImport(vault);
    await stopHealthImport();
    try {
      // Computed inside replaceAllRecords' records lock: a write (the
      // background Health import) cannot land between the read and the clear.
      // runs inside withRecordsLock (non-reentrant): no record reads/writes through the locked ports here.
      await withMaterializationStopped(() => replaceAllRecords((here) => ({
        records: mode === 'merge'
          ? mergeRecords(here, records)
          : [...records, ...here.filter((r) => !r.deleted && !managed.has(r.recordType))],
      })));
    } catch (e) {
      resumeHealthImport();
      throw e;
    }
    resetHealthAnchors(win.localStorage);
  },
  // The move to an account (bd med-nt9p.32.16; since med-ta2n.5 only the P3
  // sheets call it — "Turn on sync" and "Your invite is here" → Sign in —
  // always with a url): the shell
  // carries the vault across origins (move.stash, docs/android.md "move
  // stash"); the new account picks it up with move.take. A rejected stash
  // ('invalid vault', 'too large', an old shell) throws before the leave.
  // url (bd med-ta2n.6, contract med-ta2n.7 §7): the claim URL the shell opens
  // directly (local.leave {url}); it rejects "invalid url" with nothing
  // changed. Only a v3 shell (invite.pending listed) honours it — callers gate.
  // Always stashes, records or not (bd med-ta2n.7): local.leave {url} KEEPS the
  // move stash (contract A1), so skipping it would leave an older, abandoned
  // stash for the new account to import. An account with records drops a
  // stash with no user content (cloud-boot.js pickUpMovedVault), so it is
  // never offered an empty vault to replace its own.
  async moveToCloud({ win = globalThis.window, url } = {}) {
    const native = shellNative(win);
    if (!native) throw new Error(`Open the app on your ${deviceName(win)} to use an invite.`);
    // The W4 nudge is local-only (an account is synced and never reads it):
    // the stash carries no data.protection, so the account keeps none.
    const vault = await exportJSON(true, undefined, { withProtection: false });
    await native.call('move.stash', { vault });
    if (url === undefined) await native.call('local.leave');
    else await native.call('local.leave', { url });
  },
  // Settings → AI & integrations → the free trial row (bd med-o7zq.16).
  trial: {
    // null where there is no App Attest (the web, the Simulator, old
    // devices) or before the shell was told anything: the row stays hidden.
    // Else { on, remaining?, daily?, used? }. The window is the one
    // registerLocalEgress ran for.
    async status() {
      await firstEgress;
      if (!lastEgress || !(await attestStatus(lastEgress.win))) return null;
      return { on: !!localTrial, ...(localTrial ? localTrial.state() : {}) };
    },
    // After Settings changed the `anon` trial consent: hand the shell the new
    // host list, and reload when the CSP has to change with it. Resolves true
    // when it reloads.
    async apply() {
      const res = lastEgress ? await registerLocalEgress(lastEgress) : null;
      if (res && res.changed) lastEgress.win.location.reload();
      return !!(res && res.changed);
    },
    // First run W2's "Try it free" (bd med-o7zq.29, med-ta2n.2), once the
    // trial is on: the grant or rejoin this device needs — the boot-time
    // enrollment's, joined while in flight (local-trial.js single-flight), or
    // one more when that one failed. Resolves { ok: true }, or { ok: false,
    // code } with the server's error (trial_already_used,
    // trial_not_configured, …), 'network', or 'trial_off'.
    async enroll() {
      await firstEgress;
      const attest = lastEgress && await attestStatus(lastEgress.win);
      if (!localTrial || !attest) return { ok: false, code: 'trial_off' };
      // The memo is the proof of a grant: the shell's `attested` turns true
      // before the server answers, so it says nothing about one. With no memo
      // the enroll runs (the shell's pass rejoins a bucket granted before).
      if (!localTrial.state()) {
        let res;
        try {
          res = await localTrial.enroll();
        } catch {
          return { ok: false, code: 'network' };
        }
        if (!res.ok) {
          const body = await res.clone().json().catch(() => null);
          return { ok: false, code: (typeof body?.error === 'string' && body.error) || 'network' };
        }
      }
      const st = localTrial.state();
      return st?.used || st?.remaining === 0 ? { ok: false, code: 'trial_already_used' } : { ok: true };
    },
  },
  // The last device schedule outcome (keepLocalRemindersFresh), null before
  // the first: Settings → Notifications reads it with the iOS permission.
  lastReminderSchedule() {
    return lastSchedule;
  },
  // Settings → Backup → Erase data on this device (bd med-o7zq.9). Everything
  // here is this origin's own storage — the records, the frontend caches,
  // localStorage (Health anchors, UI state) — so no other origin, and no cloud
  // account on this phone, is touched. Then the shell drops this vault's
  // pending and delivered reminders and the BYOK host mirror, and the app
  // starts over empty. Throws, before anything is reported done, when the
  // records could not be erased.
  async eraseDevice({ win = globalThis.window } = {}) {
    await stopHealthImport();
    await clearLocalVault(); // holds the dose writers off itself
    try { win.localStorage.clear(); } catch { /* storage blocked: nothing kept there */ }
    try { win.sessionStorage.clear(); } catch { /* same */ }
    const native = shellNative(win);
    if (native) await native.call('local.reset').catch(() => {});
    win.location.replace('/');
  },
};
