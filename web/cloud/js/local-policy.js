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
import { scheduleReminderRecompute, recomputeAndPush } from './reminders.js';
import { hostsFromIntegrations } from './egress-hosts.js';
import { readAllLocalRecords } from './sync.js';
import { recordsToVault } from '../../domain/vault.js';

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
export function keepLocalRemindersFresh({ ctx, records, win }) {
  if (!localNotifications()) return;
  const run = () => recomputeAndPush(ctx, { records, relay: false })
    .catch((e) => console.error('[local] reminder reschedule failed', e));
  run();
  win.document.addEventListener('visibilitychange', () => {
    if (win.document.visibilityState === 'visible') run();
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
};
