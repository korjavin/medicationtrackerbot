// Local-only mode's side-effect and egress policy (bd med-o7zq.3, epic
// med-o7zq): what local-boot.js injects into installApiShim in place of the
// cloud's server-backed effects. In local mode nothing leaves the device except
// calls to the providers the user configured with their own key (BYOK AI,
// their own food DB). The iOS shell enforces that with its CSP (connect-src
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
//   trial AI, operator food DB: already off, since the bundled index.html
//               carries no trial / food-DB meta (ios/bundle-web.sh).
//   UI          features that need our server carry .wg-cloud-only and hide
//               under :root.wg-local-vault (styles.css), which local-boot.js
//               sets before the body parses.
//
// Privacy disclosure: the local-* rows in privacy-manifest.js.
import {
  scheduleReminderRecompute, recomputeAndPush, onLocalScheduleResult,
} from './reminders.js';
import { hostsFromIntegrations } from './egress-hosts.js';
import { readAllLocalRecords } from './sync.js';
import { recordsToVault } from '../../domain/vault.js';
import { startHealthImport, runHealthImport } from './health-import.js';
import { clearLocalVault } from './account-delete.js';

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

// Set by startLocalHealthImport; LOCAL_VAULT.eraseDevice awaits it.
let stopHealthImport = async () => {};

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
    afterImport: () => (stopped ? null : recomputeAndPush(ctx, { records, relay: false })),
  });
}

// registerLocalEgress is installApiShim's registerEgress in local mode: the
// same BYOK hostnames the cloud PUTs to /api/egress-hosts, handed to the iOS
// shell instead. The shell's reply says whether the stored list changed; the
// new CSP applies on the next document load (local-boot.js reloads). Resolves
// to { hosts, changed },
// or null where there is no shell to tell (the web, tests).
export async function registerLocalEgress({ settings, win }) {
  const native = win.LocalNotifications && win.LocalNotifications.__native;
  if (!native || native.platform !== 'ios') return null;
  const hosts = hostsFromIntegrations(await settings.readIntegrationsUnmasked());
  const reply = await native.call('setEgressHosts', { hosts });
  return { hosts, changed: !!(reply && reply.changed) };
}

// The Settings → Backup export (importexport.js reads window.CloudVault): the
// same recordsToVault conversion as cloud-boot.js, over the on-device store.
// Import and move-to-cloud are bd med-o7zq.6.
export const LOCAL_VAULT = {
  async exportAll({ includeSecrets = true } = {}) {
    const records = await readAllLocalRecords();
    return JSON.stringify(recordsToVault(records, { now: Date.now(), includeSecrets }), null, 2);
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
