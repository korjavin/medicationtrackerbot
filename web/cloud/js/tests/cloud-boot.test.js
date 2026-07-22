import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as realVault from '../../../domain/vault.js';

// cloud-boot.js is a self-executing classic script (not an ES module) that
// assigns window.MedTrackerCloudReady and issues dynamic import('/js/*.js')
// against absolute URLs — neither loadable as-is under environment:'node'. So
// we run the REAL file body (no reimplementation) against a fake window/location
// with the dynamic imports rewritten to a test-injected resolver. This pins the
// med-eas.16 fix: only the warm-unlock decision may redirect to /unlock; a
// post-unlock boot failure must NOT (or / <-> /unlock loops forever).
const SRC = readFileSync(
  fileURLToPath(new URL('../cloud-boot.js', import.meta.url)),
  'utf8',
).replace(/\bimport\(/g, '__imp(');

async function runBoot({ hash = '', modules, setupWindow }) {
  const location = { hash, href: '' };
  const window = {};
  if (setupWindow) setupWindow(window);
  const __imp = (spec) => {
    const key = spec.replace('/js/', '');
    if (!(key in modules)) throw new Error(`unexpected import(${spec})`);
    const mod = modules[key];
    return typeof mod === 'function' ? mod() : Promise.resolve(mod);
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'location', 'console', 'URLSearchParams', '__imp', SRC);
  fn(window, location, { error() {}, warn() {} }, URLSearchParams, __imp);
  await window.MedTrackerCloudReady;
  return { location, window };
}

describe('cloud-boot warm-unlock redirect gate (med-eas.16)', () => {
  it('redirects to /unlock when there is no cached LDK record (warmUnlock -> null)', async () => {
    const { location } = await runBoot({
      modules: { 'unlock.js': { warmUnlock: async () => null } },
    });
    expect(location.href).toBe('/unlock');
  });

  it('does NOT redirect to /unlock when the vault is unlocked but a post-unlock boot step throws', async () => {
    // Valid LDK -> ctx resolves; but the downstream sync import fails. Pre-fix,
    // the single catch sent us to /unlock, which bounces straight back to / on
    // the still-valid record -> endless loop. Post-fix: log and boot degraded.
    const { location } = await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', dek: new Uint8Array(1) }) },
        'apishim.js': { installApiShim: () => () => {} },
        'sync.js': () => Promise.reject(new Error('sync module failed to load')),
      },
    });
    expect(location.href).toBe('');
  });

  it('does NOT redirect to /unlock when pullOnOpen rejects after a successful unlock', async () => {
    const { location } = await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', dek: new Uint8Array(1) }) },
        'apishim.js': { installApiShim: () => () => {} },
        'sync.js': { pullOnOpen: async () => { throw new Error('pull failed'); } },
      },
    });
    expect(location.href).toBe('');
  });

  it('resolves MedTrackerCloudReady and mounts even when a sync fetch NEVER resolves (med-gvk.2)', async () => {
    // The headline: on a degraded network (captive portal / hung TCP) pullOnOpen's
    // bare fetch used to hang forever, so — because it was awaited on the boot
    // critical path — MedTrackerCloudReady never resolved and app.js painted cache
    // but never mounted. The pull is now detached: boot resolves once the LOCAL
    // state (unlock + API shim) is ready. runBoot awaits MedTrackerCloudReady, so
    // if this regressed the test would hang and time out.
    let shimInstalled = false;
    const { location } = await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', dek: new Uint8Array(1) }) },
        'apishim.js': { installApiShim: () => { shimInstalled = true; return () => Promise.resolve(null); } },
        // A half-open sync: pullOnOpen never settles. Nothing after it in the
        // background block runs, so no other module import is needed.
        'sync.js': { pullOnOpen: () => new Promise(() => {}) },
      },
    });
    expect(shimInstalled).toBe(true); // local state was installed → the UI can mount
    expect(location.href).toBe('');   // and boot did NOT bounce to /unlock
  });

  it('installs the apiCallDirect shim wrapper when window.apiCallDirect is NON-configurable (med-1iv)', async () => {
    // core/api.js declares `apiCallDirect` as a top-level function, so
    // window.apiCallDirect is a non-configurable (but writable) global. The old
    // accessor form (Object.defineProperty) threw "Cannot redefine property"
    // there, aborting the whole post-unlock boot — so workout reads
    // (groups/next-card/stats/today, which call window.apiCallDirect directly)
    // escaped to the network → 404. Reproduce that exact property shape and pin
    // that boot completes AND the wrapper routes /api/* to the shim.
    const realCalls = [];
    const setupWindow = (window) => {
      // Non-configurable + writable, exactly like a classic-script top-level
      // `function apiCallDirect(){}` global.
      Object.defineProperty(window, 'apiCallDirect', {
        value: (endpoint) => { realCalls.push(endpoint); return Promise.resolve('real'); },
        writable: true,
        configurable: false,
        enumerable: true,
      });
    };
    const shimCalls = [];
    const shimCall = (endpoint) => { shimCalls.push(endpoint); return Promise.resolve([]); };
    // pullOnOpen runs AFTER the wrapper install; if the install threw (the bug),
    // this spy would never be called — so it also guards "boot didn't abort".
    let pullOnOpenCalled = false;
    let autoDrainStarted = false;
    const { window } = await runBoot({
      setupWindow,
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', dek: new Uint8Array(1) }) },
        'apishim.js': { installApiShim: () => shimCall },
        'sync.js': {
          pullOnOpen: async () => { pullOnOpenCalled = true; },
          startReconnectAutoDrain: () => { autoDrainStarted = true; return () => {}; },
          getSyncStatus: async () => ({ authExpired: false }),
        },
        'reminders.js': { scheduleReminderRecompute: () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });

    // Boot ran past the wrapper install (pre-fix it threw here and aborted).
    expect(pullOnOpenCalled).toBe(true);
    // med-deq.2: the reconnect listeners are wired unconditionally on boot.
    expect(autoDrainStarted).toBe(true);
    // A workout read now routes to the shim, not the network...
    await window.apiCallDirect('/api/workout/groups');
    expect(shimCalls).toContain('/api/workout/groups');
    // ...and non-/api/ still falls through to the real fn.
    await window.apiCallDirect('/not-api/thing');
    expect(realCalls).toContain('/not-api/thing');
  });

  it('wires the auth-expired surface into the reconnect auto-drain (med-deq.2 mid-session expiry)', async () => {
    // The boot-time banner check alone misses the common case: a non-sliding
    // 30-day session expiring under a long-lived PWA tab. The same surface
    // function must be handed to startReconnectAutoDrain so a 401'd drain
    // re-runs it (the banner id dedupes repeat mounts).
    let statusChecks = 0;
    let drainOpts;
    await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', dek: new Uint8Array(1) }) },
        'apishim.js': { installApiShim: () => () => Promise.resolve(null) },
        'sync.js': {
          pullOnOpen: async () => {},
          startReconnectAutoDrain: (_ctx, opts) => { drainOpts = opts; return () => {}; },
          getSyncStatus: async () => { statusChecks++; return { authExpired: false }; },
        },
        'reminders.js': { scheduleReminderRecompute: () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });
    expect(typeof drainOpts?.onAuthExpired).toBe('function');
    expect(statusChecks).toBe(1); // the boot-time check still ran
    await drainOpts.onAuthExpired(); // a 401'd drain re-checks status and (if expired) mounts the banner
    expect(statusChecks).toBe(2);
  });

  it('hands a #claim= link to the /unlock shell before touching the warm-unlock cache', async () => {
    const { location } = await runBoot({ hash: '#claim=tok123', modules: {} });
    expect(location.href).toBe('/unlock#claim=tok123');
  });
});

describe('cloud-boot feedback launcher mount gate (med-dni.2 Task 3)', () => {
  // The launcher mounts only when the operator configured a recipient
  // (getFeedbackRecipient() non-empty). No recipient → feedback-ui.js is never
  // imported and mountFeedbackLauncher never runs (feature fully absent).
  const flush = () => new Promise((r) => setTimeout(r, 0));

  // These tests are the first to boot past installReminderActionHandler (existing
  // tests abort earlier on an unprovided push.js import). That handler reads
  // navigator.serviceWorker — always present in a browser, absent in this node
  // env — so provide a stub navigator or boot throws before the feedback block.
  let priorNavigator;
  beforeEach(() => { priorNavigator = globalThis.navigator; globalThis.navigator = {}; });
  afterEach(() => { globalThis.navigator = priorNavigator; });

  // Everything imported in the post-unlock try before the feedback block must be
  // provided, or the harness's __imp throws and aborts before we reach it.
  function baseModules(extra) {
    return {
      'unlock.js': { warmUnlock: async () => ({ accountId: 'a', dek: new Uint8Array(1) }) },
      'apishim.js': { installApiShim: () => () => Promise.resolve(null) },
      'sync.js': {
        pullOnOpen: async () => {},
        startReconnectAutoDrain: () => () => {},
        getSyncStatus: async () => ({ authExpired: false }),
        readAllLiveRecords: async () => [],
      },
      'reminders.js': { scheduleReminderRecompute: () => {} },
      'push.js': { ensurePushSubscription: async () => ({}) },
      'mcp-responder.js': { refreshResponder: () => {} },
      'inbox.js': { ensureInboxKey: async () => {}, drainInbox: async () => ({ applied: 0 }), startInboxPolling: () => {} },
      ...extra,
    };
  }

  it('imports feedback-ui and mounts the launcher when a recipient is configured', async () => {
    let mounted = 0;
    let uiImported = false;
    let autoDrainStarted = 0;
    let drained = 0;
    await runBoot({
      modules: baseModules({
        'feedback-config.js': { getFeedbackRecipient: () => 'age1recipient' },
        'feedback-ui.js': () => { uiImported = true; return Promise.resolve({ mountFeedbackLauncher: async () => { mounted += 1; } }); },
        'feedback-submit.js': {
          startFeedbackAutoDrain: () => { autoDrainStarted += 1; return () => {}; },
          drainFeedbackOutbox: () => { drained += 1; return Promise.resolve(0); },
        },
      }),
    });
    await flush();
    expect(uiImported).toBe(true);
    expect(mounted).toBe(1);
    // med-dni.3: the launcher mount also installs the autodrain and kicks one
    // drain so a queued-offline item from a prior session delivers on open.
    expect(autoDrainStarted).toBe(1);
    expect(drained).toBe(1);
  });

  it('never imports feedback-ui when no recipient is configured', async () => {
    let uiImported = false;
    await runBoot({
      modules: baseModules({
        'feedback-config.js': { getFeedbackRecipient: () => '' },
        'feedback-ui.js': () => { uiImported = true; return Promise.resolve({ mountFeedbackLauncher: async () => {} }); },
      }),
    });
    await flush();
    expect(uiImported).toBe(false);
  });
});

describe('CloudVault.resetLocalSync inbox-clear ordering (med-eas.51)', () => {
  // A wedged account pauses the inbox poller's drain (drainInbox's wedge guard).
  // resetLocalSync clears syncWedged, which un-pauses the drain, so the server
  // inbox MUST be cleared while sync is still wedged — otherwise a live poll tick
  // between un-wedge and clear re-fetches the poison event and re-wedges the
  // account. Pin that clearInbox runs BEFORE sync.resetLocalSync.
  async function bootWithReset(resetImpl) {
    const order = [];
    const { window } = await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', dek: new Uint8Array(1) }) },
        'apishim.js': { installApiShim: () => () => Promise.resolve(null) },
        'sync.js': {
          pullOnOpen: async () => {},
          startReconnectAutoDrain: () => () => {},
          getSyncStatus: async () => ({ authExpired: false }),
          resetLocalSync: resetImpl || (async () => { order.push('reset'); }),
        },
        'inbox.js': { clearInbox: async () => { order.push('clear'); return 0; } },
        'reminders.js': { scheduleReminderRecompute: () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });
    return { window, order };
  }

  it('clears the server inbox before un-wedging local sync', async () => {
    const { window, order } = await bootWithReset();
    await window.CloudVault.resetLocalSync();
    expect(order).toEqual(['clear', 'reset']);
  });

  it('still resets locally when the server inbox clear fails', async () => {
    const order = [];
    const { window } = await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', dek: new Uint8Array(1) }) },
        'apishim.js': { installApiShim: () => () => Promise.resolve(null) },
        'sync.js': {
          pullOnOpen: async () => {},
          startReconnectAutoDrain: () => () => {},
          getSyncStatus: async () => ({ authExpired: false }),
          resetLocalSync: async () => { order.push('reset'); },
        },
        'inbox.js': { clearInbox: async () => { throw new Error('network down'); } },
        'reminders.js': { scheduleReminderRecompute: () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });
    await window.CloudVault.resetLocalSync();
    expect(order).toEqual(['reset']);
  });
});

describe('CloudVault.importAll data-loss guard (null cursor)', () => {
  // A full-vault import wipes the local store then re-inserts. If bootstrap
  // never reached the server (localLastSeq null), forceSnapshot no-ops (no
  // propagation, no retry marker) and the next open re-bootstraps the stale
  // server snapshot over the import. importAll must refuse to wipe until the
  // account cursor exists — throwing so importexport.js skips the reload.
  function syncModule(overrides) {
    const calls = { replaceAllRecords: 0, forceSnapshot: 0, markForceSnapshotPending: 0, dropPendingForTypes: [], order: [] };
    return {
      calls,
      mod: {
        pullOnOpen: async () => {},
        startReconnectAutoDrain: () => () => {},
        getSyncStatus: async () => ({ authExpired: false }),
        readAllLiveRecords: async () => [],
        replaceAllRecords: async () => { calls.replaceAllRecords += 1; calls.order.push('replace'); },
        forceSnapshot: async () => { calls.forceSnapshot += 1; },
        markForceSnapshotPending: async () => { calls.markForceSnapshotPending += 1; calls.order.push('mark'); },
        dropPendingForTypes: async (types) => { calls.dropPendingForTypes.push(types); calls.order.push('drop'); },
        ...overrides,
      },
    };
  }
  const MANAGED = new Set(['note', 'bp']);
  const VAULT_MOD = { vaultToRecords: () => [], managedTypesForImport: () => MANAGED };
  const VAULT_JSON = '{"format":"medtracker-vault","version":1,"data":{}}';

  async function bootWithSync(sync) {
    const { window } = await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', dek: new Uint8Array(1) }) },
        'apishim.js': { installApiShim: () => () => Promise.resolve(null) },
        'sync.js': sync.mod,
        '/domain/vault.js': VAULT_MOD,
        'reminders.js': { scheduleReminderRecompute: () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });
    return window;
  }

  it('throws and never wipes when the device is not bootstrapped', async () => {
    const sync = syncModule({ isBootstrapped: async () => false });
    const window = await bootWithSync(sync);
    await expect(window.CloudVault.importAll(VAULT_JSON)).rejects.toThrow(/Sync not ready/);
    expect(sync.calls.replaceAllRecords).toBe(0);
    expect(sync.calls.forceSnapshot).toBe(0);
    expect(sync.calls.markForceSnapshotPending).toBe(0);
    expect(sync.calls.dropPendingForTypes).toHaveLength(0);
  });

  it('wipes and forces a snapshot once bootstrapped', async () => {
    const sync = syncModule({ isBootstrapped: async () => true });
    const window = await bootWithSync(sync);
    await window.CloudVault.importAll(VAULT_JSON);
    expect(sync.calls.replaceAllRecords).toBe(1);
    expect(sync.calls.forceSnapshot).toBe(1);
    // The durable retry marker must land BEFORE the destructive replace: a crash
    // in between would otherwise let the next open re-bootstrap the stale server
    // snapshot over the freshly imported records.
    expect(sync.calls.order.indexOf('mark')).toBeLessThan(sync.calls.order.indexOf('replace'));
  });

  it('a corrupt backup aborts inside the real vaultToRecords, wiping nothing (med-deq.3)', async () => {
    // No-destruction invariant with the REAL vault module: importAll calls
    // vaultToRecords BEFORE any destructive op, so a corrupt-natural-key vault
    // (unparseable sleep start_time / missing miband source_start_ms) must throw
    // there and leave every existing record untouched — no replace, no marker,
    // no pending-drop, no snapshot.
    const corrupt = [
      '{"format":"medtracker-vault","version":1,"data":{"vitals":{"sleep":[{"start_time":"not-a-date","duration_min":400}]}}}',
      '{"format":"medtracker-vault","version":1,"data":{"workouts":{"miband":[{"steps":100}]}}}',
    ];
    for (const json of corrupt) {
      const sync = syncModule({ isBootstrapped: async () => true });
      const { window } = await runBoot({
        modules: {
          'unlock.js': { warmUnlock: async () => ({ accountId: 'a', dek: new Uint8Array(1) }) },
          'apishim.js': { installApiShim: () => () => Promise.resolve(null) },
          'sync.js': sync.mod,
          '/domain/vault.js': realVault,
          'reminders.js': { scheduleReminderRecompute: () => {} },
          'mcp-responder.js': { refreshResponder: () => {} },
        },
      });
      await expect(window.CloudVault.importAll(json)).rejects.toThrow(/Corrupt backup/);
      expect(sync.calls.replaceAllRecords).toBe(0);
      expect(sync.calls.markForceSnapshotPending).toBe(0);
      expect(sync.calls.dropPendingForTypes).toHaveLength(0);
      expect(sync.calls.forceSnapshot).toBe(0);
    }
  });

  it('drops pending managed writes before the replace so they cannot survive the backup', async () => {
    // Replace-only: a not-yet-flushed managed write (create/update/delete) must
    // be discarded before replaceAllRecords, or its pending overlay resurrects
    // it over the imported backup and later flushes over it.
    const sync = syncModule({ isBootstrapped: async () => true });
    const window = await bootWithSync(sync);
    await window.CloudVault.importAll(VAULT_JSON);
    expect(sync.calls.dropPendingForTypes).toHaveLength(1);
    expect(sync.calls.dropPendingForTypes[0]).toBe(MANAGED);
    // Drop must run before the replace, else the overlay re-adds the stale rows.
    expect(sync.calls.order).toEqual(['mark', 'drop', 'replace']);
  });
});
