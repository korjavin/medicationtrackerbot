import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

  it('hands a #claim= link to the /unlock shell before touching the warm-unlock cache', async () => {
    const { location } = await runBoot({ hash: '#claim=tok123', modules: {} });
    expect(location.href).toBe('/unlock#claim=tok123');
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
