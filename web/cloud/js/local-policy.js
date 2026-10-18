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
//               med-o7zq.16): then, and only then, our server's base domain
//               joins the shell's host list and local-trial.js signs each
//               request with App Attest. The account trial's meta flag stays
//               out of the bundle (ios/bundle-web.sh).
//   food DB     no food-DB meta in the bundle. The operator's DB rides the
//               same trial switch (bd med-o7zq.20): LOCAL_FOOD_DB below sends
//               fooddb.js's lookups through local-trial.js to the attest
//               routes while it is on; off, it is unavailable and says why.
//   UI          features that need our server carry .wg-cloud-only and hide
//               under :root.wg-local-vault (styles.css), which local-boot.js
//               sets before the body parses.
//
// Privacy disclosure: the local-* rows in privacy-manifest.js.
import {
  scheduleReminderRecompute, recomputeAndPush, onLocalScheduleResult,
} from './reminders.js';
import { hostsFromIntegrations } from './egress-hosts.js';
import { readAllLocalRecords, replaceAllRecords } from './sync.js';
import { recordsToVault, vaultToRecords, managedTypesForImport } from '../../domain/vault.js';
import { startHealthImport, runHealthImport, resetHealthAnchors } from './health-import.js';
import { clearLocalVault } from './account-delete.js';
import { setTrialTransport } from './aiclient.js';
import { createLocalTrial } from './local-trial.js';

// Settings → Notifications fires this on the document once iOS permission is
// granted, so the schedule lands now instead of on the next open. settings.js
// is a classic script and spells the name out; the integration test pins both.
const RESCHEDULE_EVENT = 'wg:local-reminders-reschedule';
// Fired on the document after every device schedule attempt (detail: the
// result, as lastReminderSchedule returns it); settings.js spells it out too.
const SCHEDULED_EVENT = 'wg:local-reminders-scheduled';
let lastSchedule = null;

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

// The shell's App Attest support (window.Attest, ios/App/Attest.swift):
// { supported, base, attested }, or null where there is none (the web, the
// Simulator, a stub, a locked shell).
async function attestStatus(win) {
  try {
    if (win.Attest?.isSupported?.() !== true) return null;
    const status = await win.Attest.status();
    return status && status.supported === true && status.base ? status : null;
  } catch {
    return null;
  }
}

// The anonymous trial (bd med-o7zq.16: AI; med-o7zq.20: food) this document's
// CSP admits: the local-trial.js transport while it is on, else null. Set by
// registerLocalEgress, read by LOCAL_VAULT.trial and LOCAL_FOOD_DB.
let localTrial = null;
let lastEgress = null;

function useLocalTrial(base, attest, win) {
  if (!base) {
    localTrial = null;
    foodParked = null;
    setTrialTransport(null);
    return;
  }
  if (localTrial && localTrial.base === base) return;
  foodParked = null;
  localTrial = createLocalTrial({
    attest, base, fetchImpl: win.fetch.bind(win), storage: win.localStorage,
  });
  setTrialTransport(localTrial);
}

// The operator food-DB port (fooddb.js) for local mode: the trial transport
// while it is on, else unavailable — no request at all — with the reason as
// hint(). Answers that say "not now" park it in memory: today's lookups spent
// (429 install-day) until resets_at, the operator having no food DB or no
// trial at all (503 food_not_configured / trial_not_configured) for an hour.
export const FOOD_OFF_COPY = 'No food database in device-only mode. Turn on the free trial in Settings → AI & integrations, or add your own food DB.';
export const FOOD_PAUSED_COPY = 'Food lookups paused until tomorrow.';
const FOOD_USED_COPY = 'The free trial was already used on this iPhone. Add your own food DB in Settings → AI & integrations.';
let foodParked = null; // { hint, until }

export const LOCAL_FOOD_DB = {
  hint() {
    if (!localTrial) return FOOD_OFF_COPY;
    if (localTrial.state()?.used) return FOOD_USED_COPY;
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
// same BYOK hostnames the cloud PUTs to /api/egress-hosts, handed to the iOS
// shell instead. The shell's reply says whether the stored list changed; the
// new CSP applies on the next document load (local-boot.js reloads). Resolves
// to { hosts, changed },
// or null where there is no shell to tell (the web, tests).
//
// The trial AI's host — our server's base domain — joins the list only while
// the user has it on (the `anon` trial consent: one switch in Settings → AI &
// integrations for the AI and the food database, bd med-o7zq.20) and
// the shell supports App Attest. Off, the CSP admits no server of ours and
// nothing here talks to one. The transport is installed
// only once this document's CSP carries the host (no change pending a
// reload), and a first enrollment runs then, so Settings can show the count.
export async function registerLocalEgress({ settings, win }) {
  const native = win.LocalNotifications && win.LocalNotifications.__native;
  if (!native || native.platform !== 'ios') return null;
  lastEgress = { settings, win };
  const hosts = hostsFromIntegrations(await settings.readIntegrationsUnmasked());
  const attest = await attestStatus(win);
  const trialOn = !!attest && (await settings.getTrialConsent())?.anon === true;
  if (trialOn && !hosts.includes(attest.base)) hosts.push(attest.base);
  const reply = await native.call('setEgressHosts', { hosts });
  const changed = !!(reply && reply.changed);
  if (!changed) {
    useLocalTrial(trialOn ? attest.base : null, win.Attest, win);
    if (trialOn && !attest.attested && !localTrial.state()) {
      localTrial.enroll().catch((e) => console.warn('[local] trial enrollment failed', e));
    }
  }
  return { hosts, changed };
}

// Export reminder (bd med-o7zq.5): the on-device store is the user's only
// copy outside the iPhone's own backup, so at most once a week — counted from
// the first open, the last reminder or the last export — a toast suggests
// exporting a backup file. Checked at boot and on every return to the front.
// The timestamp is per-viewer localStorage on purpose: losing it only makes
// the next reminder come a week later.
const BACKUP_NUDGE_KEY = 'wg:local-backup-nudge-at';
export const BACKUP_NUDGE_MS = 7 * 24 * 60 * 60 * 1000;

function markBackupNudge(win, now) {
  try { win.localStorage.setItem(BACKUP_NUDGE_KEY, String(now)); } catch { /* storage blocked */ }
}

// Resolves true when it showed the reminder.
export async function nudgeLocalBackup({ win, now = Date.now() }) {
  let since;
  try { since = Number(win.localStorage.getItem(BACKUP_NUDGE_KEY)); } catch { return false; }
  if (!since) {
    markBackupNudge(win, now);
    return false;
  }
  if (now - since < BACKUP_NUDGE_MS) return false;
  if (!(await readAllLocalRecords()).some((r) => !r.deleted)) return false; // nothing to lose yet
  markBackupNudge(win, now);
  win.safeToast('Your records are stored only on this iPhone. Export a backup file to keep a copy somewhere else.', 'info', {
    action: {
      label: 'Back up',
      onClick: () => {
        if (typeof win.switchTab === 'function') win.switchTab('settings');
        win.SettingsView?.openSettingsPage?.('backup');
      },
    },
  });
  return true;
}

// Settings → Backup (importexport.js reads window.CloudVault): the same
// recordsToVault / vaultToRecords conversion as cloud-boot.js, over the
// on-device store. Moving to a cloud account (bd med-o7zq.6) is this export,
// then the account's own Restore of the file: openCloudAccount only hands the
// user to the shell's invite screen, and this origin keeps its data.
export const LOCAL_VAULT = {
  async exportAll({ includeSecrets = true, win = globalThis.window } = {}) {
    const records = await readAllLocalRecords();
    const json = JSON.stringify(recordsToVault(records, { now: Date.now(), includeSecrets }), null, 2);
    markBackupNudge(win, Date.now()); // an export restarts the reminder's week
    return json;
  },
  // Replace-only, like the cloud's importAll: everything the file manages is
  // replaced, records it does not (the secrets of a secrets-free file) stay.
  // No account cursor, pending queue or snapshot here. vaultToRecords throws on
  // a foreign or unknown-version file before anything is touched. The Health
  // import stops right before the replace (the page reloads after) so none of
  // its writes or anchors land around it — and resumes if the replace fails;
  // the anchors are then reset, since they describe the replaced records.
  async importAll(json, { win = globalThis.window } = {}) {
    const vault = typeof json === 'string' ? JSON.parse(json) : json;
    const records = vaultToRecords(vault, { now: Date.now() });
    const managed = managedTypesForImport(vault);
    await stopHealthImport();
    try {
      const survive = (await readAllLocalRecords())
        .filter((r) => !r.deleted && !managed.has(r.recordType));
      await replaceAllRecords([...records, ...survive]);
    } catch (e) {
      resumeHealthImport();
      throw e;
    }
    resetHealthAnchors(win.localStorage);
  },
  // Settings → Backup → Move to a cloud account: the shell leaves local mode
  // for its invite screen. Nothing here is erased; choosing "Only on this
  // device" again reopens it.
  async openCloudAccount({ win = globalThis.window } = {}) {
    const native = win.LocalNotifications && win.LocalNotifications.__native;
    if (!native || native.platform !== 'ios') throw new Error('Open the app on your iPhone to use an invite.');
    await native.call('local.leave');
  },
  // Settings → AI & integrations → the free trial row (bd med-o7zq.16).
  trial: {
    // null where there is no App Attest (the web, the Simulator, old
    // devices) or before the shell was told anything: the row stays hidden.
    // Else { on, remaining?, daily?, used? }. The window is the one
    // registerLocalEgress ran for.
    async status() {
      if (!lastEgress || !(await attestStatus(lastEgress.win))) return null;
      return { on: !!localTrial, ...(localTrial ? localTrial.state() : {}) };
    },
    // After Settings changed the `anon` trial consent: hand the shell the new
    // host list, and reload when the CSP has to change with it.
    async apply() {
      const res = lastEgress ? await registerLocalEgress(lastEgress) : null;
      if (res && res.changed) lastEgress.win.location.reload();
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
    await clearLocalVault();
    try { win.localStorage.clear(); } catch { /* storage blocked: nothing kept there */ }
    try { win.sessionStorage.clear(); } catch { /* same */ }
    const native = win.LocalNotifications && win.LocalNotifications.__native;
    if (native && native.platform === 'ios') await native.call('local.reset').catch(() => {});
    win.location.replace('/');
  },
};
