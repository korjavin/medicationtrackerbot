import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import * as realVault from '../../../domain/vault.js';
import { loadFrontendEnv } from '../../../static/js/tests/helpers/frontend-harness.js';
import { allowConsoleNoise } from '../../../static/js/tests/helpers/setup.js';
import { reloadProviderDocument } from '../update-check.js';

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
  it('captures exact document origins before async unlock, not later DOM or settings state', async () => {
    const dom = new JSDOM('<head><meta name="medtracker-connect-origins" content=\'["https://a.example"]\'></head>');
    let unlock;
    let captured;
    const replaceState = vi.fn();
    const warming = new Promise((resolve) => { unlock = resolve; });
    const running = runBoot({
      setupWindow(win) {
        win.document = dom.window.document;
        win.location = { origin: 'https://account.example', href: 'https://account.example/?__wg_provider_reload=1&keep=1', search: '?__wg_provider_reload=1&keep=1' };
        win.history = { state: null, replaceState };
      },
      modules: {
        'unlock.js': { warmUnlock: () => warming },
        'apishim.js': { installApiShim: (_ctx, options) => { captured = options.documentPolicy; return () => Promise.resolve(null); } },
        'sync.js': { pullOnOpen: () => new Promise(() => {}) },
      },
    });
    dom.window.document.querySelector('meta').content = '["https://b.example"]';
    unlock({ accountId: 'fixture-account', kData: {}, kMac: {} });
    await running;
    expect(captured).toEqual({ origins: '["https://a.example"]', origin: 'https://account.example' });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, '', 'https://account.example/?keep=1');
    dom.window.close();
  });

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
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
        'apishim.js': { installApiShim: () => () => {} },
        'sync.js': () => Promise.reject(new Error('sync module failed to load')),
      },
    });
    expect(location.href).toBe('');
  });

  it('does NOT redirect to /unlock when pullOnOpen rejects after a successful unlock', async () => {
    const { location } = await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
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
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
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
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
        'apishim.js': { installApiShim: () => shimCall },
        'sync.js': {
          pullOnOpen: async () => { pullOnOpenCalled = true; },
          startReconnectAutoDrain: () => { autoDrainStarted = true; return () => {}; },
          getSyncStatus: async () => ({ authExpired: false }),
        },
        'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
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
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
        'apishim.js': { installApiShim: () => () => Promise.resolve(null) },
        'sync.js': {
          pullOnOpen: async () => {},
          startReconnectAutoDrain: (_ctx, opts) => { drainOpts = opts; return () => {}; },
          getSyncStatus: async () => { statusChecks++; return { authExpired: false }; },
        },
        'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });
    expect(typeof drainOpts?.onAuthExpired).toBe('function');
    // med-wi09.5: the update-required surface is wired the same way.
    expect(typeof drainOpts?.onUpdateRequired).toBe('function');
    expect(statusChecks).toBe(2); // both boot-time checks ran
    await drainOpts.onAuthExpired(); // a 401'd drain re-checks status and (if expired) mounts the banner
    expect(statusChecks).toBe(3);
    await drainOpts.onUpdateRequired(); // a 426'd push re-checks status and (if gated) mounts the banner
    expect(statusChecks).toBe(4);
  });

  // bd med-ejgf: the shim withholds W1 until the mirror has caught up, so the
  // boot re-asks /api/bootstrap after the boot pull and after each drain —
  // once caught up, exactly once.
  it('re-asks first run once the mirror has caught up, on the boot pull or a later drain', async () => {
    for (const caughtAtBoot of [true, false]) {
      let caughtUp = caughtAtBoot;
      let drainOpts;
      const asked = [];
      const mounted = [];
      await runBoot({
        setupWindow: (w) => { w.AuthBootstrap = { mountFirstRun: (needs) => mounted.push(needs) }; },
        modules: {
          'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
          'apishim.js': {
            installApiShim: () => async (endpoint, method) => {
              asked.push(`${method} ${endpoint}`);
              return endpoint === '/api/bootstrap' ? { needs_first_run: true } : null;
            },
          },
          'sync.js': {
            pullOnOpen: async () => {},
            hasCaughtUp: async () => caughtUp,
            startReconnectAutoDrain: (_ctx, opts) => { drainOpts = opts; return () => {}; },
            getSyncStatus: async () => ({ authExpired: false }),
          },
          'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
          'mcp-responder.js': { refreshResponder: () => {} },
        },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(mounted).toEqual(caughtAtBoot ? [true] : []);
      caughtUp = true;
      await drainOpts.onSettled();
      await drainOpts.onSettled();
      await new Promise((r) => setTimeout(r, 0));
      expect(mounted).toEqual([true]);
      expect(asked.filter((a) => a === 'GET /api/bootstrap')).toHaveLength(1);
    }
  });

  // bd med-0xad.4: the legacy sleep/stress conversion writes at now(), so it
  // never runs on a mirror no pull of this page load brought to the tail.
  it('converts legacy sleep only after a pull in this page load reached the tail, once', async () => {
    let pulled = false;
    let drainOpts;
    let runs = 0;
    const shimCall = async () => null;
    shimCall.unifyLegacy = async () => { runs++; };
    await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
        'apishim.js': { installApiShim: () => shimCall },
        'sync.js': {
          pullOnOpen: async () => {}, // offline: returns without reaching the tail
          pulledThisSession: () => pulled,
          hasCaughtUp: async () => true,
          startReconnectAutoDrain: (_ctx, opts) => { drainOpts = opts; return () => {}; },
          getSyncStatus: async () => ({ authExpired: false }),
        },
        'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(0); // offline boot: no writes
    await drainOpts.onSettled();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(0); // a drain that still did not reach the tail
    pulled = true;
    await drainOpts.onSettled();
    await drainOpts.onSettled();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(1);
  });

  // bd med-kk1q.1: the boot eviction of the shim-served tags runs only after a
  // pull in this page load landed; an offline boot keeps the ApiCache rows and
  // evicts after the first drain that lands, once.
  it('evicts the shim-served tags only once a pull lands, on the boot pull or a later drain', async () => {
    for (const pulledAtBoot of [true, false]) {
      let pulled = pulledAtBoot;
      let drainOpts;
      const evicted = [];
      const shimCall = async () => null;
      shimCall.unifyLegacy = async () => {};
      shimCall.floorTimeZone = async () => true;
      await runBoot({
        setupWindow: (w) => { w.DataStore = { invalidateTags: async (tags) => { evicted.push(tags); } }; },
        modules: {
          'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
          'apishim.js': { installApiShim: () => shimCall },
          'sync.js': {
            pullOnOpen: async () => {},
            pulledThisSession: () => pulled,
            hasCaughtUp: async () => false,
            startReconnectAutoDrain: (_ctx, opts) => { drainOpts = opts; return () => {}; },
            getSyncStatus: async () => ({ authExpired: false }),
            readAllLiveRecords: async () => [],
          },
          'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
          'mcp-responder.js': { refreshResponder: () => {} },
        },
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(evicted).toEqual(pulledAtBoot ? [['bp', 'weight', 'medications', 'history', 'workout']] : []);
      await drainOpts.onSettled(); // still offline: nothing to evict
      pulled = true;
      await drainOpts.onSettled();
      await drainOpts.onSettled();
      await new Promise((r) => setTimeout(r, 0));
      expect(evicted).toEqual([['bp', 'weight', 'medications', 'history', 'workout']]);
    }
  });

  // bd med-wi09.19: the account-zone floor runs from the boot, never from a
  // request; tried after the boot pull and each drain until a pull in this
  // page load has let it run, then never again.
  it('tries the account-zone floor after the boot pull and each drain until a pull this session, once', async () => {
    let pulled = false;
    let drainOpts;
    let tries = 0;
    const shimCall = async () => null;
    shimCall.unifyLegacy = async () => {};
    shimCall.floorTimeZone = async () => { tries++; return pulled; };
    await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
        'apishim.js': { installApiShim: () => shimCall },
        'sync.js': {
          pullOnOpen: async () => {},
          pulledThisSession: () => pulled,
          hasCaughtUp: async () => true,
          startReconnectAutoDrain: (_ctx, opts) => { drainOpts = opts; return () => {}; },
          getSyncStatus: async () => ({ authExpired: false }),
        },
        'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(tries).toBe(1); // offline boot: tried, nothing written
    pulled = true;
    await drainOpts.onSettled();
    await new Promise((r) => setTimeout(r, 0));
    await drainOpts.onSettled();
    await new Promise((r) => setTimeout(r, 0));
    expect(tries).toBe(2);
  });

  // Argus r4 item 7: a drain that settles while the move pickup is pending
  // (canFloor says no) must not end the tries for the session.
  it('still floors once after the move pickup settles when a drain settled while it was pending', async () => {
    let settlePickup;
    const probe = new Promise((r) => { settlePickup = r; });
    let pickupDone = false;
    let drainOpts;
    let wrote = 0;
    const shimCall = async () => null;
    shimCall.unifyLegacy = async () => {};
    shimCall.floorTimeZone = async () => { if (!pickupDone) return false; wrote++; return true; };
    await runBoot({
      setupWindow: (w) => {
        w.LocalNotifications = { __native: { platform: 'ios', call: async () => null } };
        w.nativeHas = () => probe; // the pickup's move.take probe, held open
      },
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
        'apishim.js': { installApiShim: () => shimCall },
        'sync.js': {
          pullOnOpen: async () => {},
          pulledThisSession: () => true,
          hasCaughtUp: async () => true,
          startReconnectAutoDrain: (_ctx, opts) => { drainOpts = opts; return () => {}; },
          getSyncStatus: async () => ({ authExpired: false }),
        },
        'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });
    drainOpts.onSettled(); // pulled this session, pickup still pending
    await new Promise((r) => setTimeout(r, 0));
    expect(wrote).toBe(0);
    pickupDone = true;
    settlePickup(false); // no stash: the pickup settles without a reload
    await new Promise((r) => setTimeout(r, 0));
    await drainOpts.onSettled();
    await new Promise((r) => setTimeout(r, 0));
    expect(wrote).toBe(1);
  });

  it('a failed first-run re-ask is retried on the next drain', async () => {
    let drainOpts;
    let calls = 0;
    const mounted = [];
    await runBoot({
      setupWindow: (w) => { w.AuthBootstrap = { mountFirstRun: (needs) => mounted.push(needs) }; },
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
        'apishim.js': {
          installApiShim: () => async (endpoint) => {
            if (endpoint !== '/api/bootstrap') return null;
            calls++;
            if (calls === 1) throw new Error('shim read failed');
            return calls === 2 ? {} : { needs_first_run: true };
          },
        },
        'sync.js': {
          pullOnOpen: async () => {},
          hasCaughtUp: async () => true,
          startReconnectAutoDrain: (_ctx, opts) => { drainOpts = opts; return () => {}; },
          getSyncStatus: async () => ({ authExpired: false }),
        },
        'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mounted).toEqual([]); // boot re-ask threw
    await drainOpts.onSettled(); // no flag in the answer
    expect(mounted).toEqual([]);
    await drainOpts.onSettled();
    await drainOpts.onSettled();
    expect(mounted).toEqual([true]);
    expect(calls).toBe(3);
  });

  it('a 426-gated sync mounts the "Update required" banner whose Reload loads the current build (med-wi09.5)', async () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    vi.stubGlobal('document', dom.window.document);
    let drainOpts;
    let reloads = 0;
    let fetched = 0;
    try {
      await runBoot({
        modules: {
          'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
          'apishim.js': { installApiShim: () => () => Promise.resolve(null) },
          'sync.js': {
            pullOnOpen: async () => {},
            startReconnectAutoDrain: (_ctx, opts) => { drainOpts = opts; return () => {}; },
            getSyncStatus: async () => ({ authExpired: false, updateRequired: true, wedged: false }),
          },
          'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
          'mcp-responder.js': { refreshResponder: () => {} },
          'update-check.js': { reloadToLatest: async () => { reloads++; }, fetchLatest: async () => { fetched++; } },
        },
      });
      await drainOpts.onUpdateRequired();
      await drainOpts.onUpdateRequired(); // the banner id dedupes repeat surfaces
      const banners = dom.window.document.querySelectorAll('#update-required-banner');
      expect(banners).toHaveLength(1);
      // bd med-wi09.12: the SW is asked for the current build (registration.update())
      // as the banner goes up — once, not per surface — before Reload is offered.
      await vi.waitFor(() => expect(fetched).toBe(1));
      expect(banners[0].textContent).toContain('Update required — reload to keep syncing.');
      expect(banners[0].textContent).not.toMatch(/reset/i);
      const btn = banners[0].querySelector('button');
      expect(btn.textContent).toBe('Reload');
      btn.click();
      await vi.waitFor(() => expect(reloads).toBe(1));
    } finally {
      vi.unstubAllGlobals();
    }
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
  beforeEach(() => { priorNavigator = globalThis.navigator; Object.defineProperty(globalThis, 'navigator', {value: {}, configurable: true, writable: true}) });
  afterEach(() => { Object.defineProperty(globalThis, 'navigator', {value: priorNavigator, configurable: true, writable: true}) });

  // Everything imported in the post-unlock try before the feedback block must be
  // provided, or the harness's __imp throws and aborts before we reach it.
  function baseModules(extra) {
    return {
      'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
      'apishim.js': { installApiShim: () => () => Promise.resolve(null) },
      'sync.js': {
        pullOnOpen: async () => {},
        startReconnectAutoDrain: () => () => {},
        getSyncStatus: async () => ({ authExpired: false }),
        readAllLiveRecords: async () => [],
      },
      'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
      'push.js': { ensurePushSubscription: async () => ({}) },
      'mcp-responder.js': { refreshResponder: () => {} },
      'inbox.js': { ensureInboxKey: async () => {}, drainInbox: async () => ({ applied: 0 }), startInboxPolling: () => {}, startInboxEventStream: () => {} },
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

describe('cloud-boot inbox wake (med-5fo)', () => {
  // The server pushes a content-free inbox-wake the instant it seals a Telegram
  // event; the SW relays it to every window. This is the page half: drain NOW
  // rather than at the poller's next tick (throttled to ~1/min in a hidden tab).
  const flush = () => new Promise((r) => setTimeout(r, 0));

  let priorNavigator;
  afterEach(() => { Object.defineProperty(globalThis, 'navigator', { value: priorNavigator, configurable: true, writable: true }); });

  function fakeServiceWorker(handlers) {
    priorNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          controller: null,
          register: () => new Promise(() => {}),
          // Both cloud-boot listeners (reminder-action + inbox-wake) land here,
          // so a dispatch fans out to all of them exactly as the browser would.
          addEventListener: (type, fn) => { if (type === 'message') handlers.push(fn); },
        },
      },
      configurable: true,
      writable: true,
    });
  }

  // Boot far enough to reach the post-unlock inbox block, with a fake SW
  // collecting every `message` listener. `inbox` overrides the inbox.js surface.
  async function bootInbox(inbox = {}, setupWindow) {
    const handlers = [];
    fakeServiceWorker(handlers);
    let pollersStarted = 0;
    let pollerOpts = null;
    let streamsStarted = 0;
    let streamCtx = null;
    let streamOpts = null;
    const syncDrains = [];
    // Reminder-horizon bookkeeping (med-9y9): recomputes counts the UN-debounced
    // recomputeAndPush calls, debounced counts anything still going through the
    // 2s scheduler — which, on the boot + drain paths, must stay at zero.
    let recomputes = 0;
    let debounced = 0;
    let tokenRegisters = 0;
    await runBoot({
      setupWindow,
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
        'apishim.js': { installApiShim: () => () => Promise.resolve(null) },
        'sync.js': {
          pullOnOpen: async () => {},
          startReconnectAutoDrain: () => () => {},
          requestDrain: (c, opts) => { syncDrains.push({ c, opts }); },
          getSyncStatus: async () => ({ authExpired: false }),
          readAllLiveRecords: async () => [],
        },
        'reminders.js': {
          scheduleReminderRecompute: () => { debounced += 1; },
          recomputeAndPush: async () => { recomputes += 1; },
        },
        'push.js': {
          ensurePushSubscription: async () => ({}),
          registerNativePushTokenWithRetry: async () => { tokenRegisters += 1; return true; },
        },
        'mcp-responder.js': { refreshResponder: () => {} },
        'inbox.js': {
          ensureInboxKey: async () => {},
          drainInbox: async () => ({ applied: 0 }),
          startInboxPolling: (_ctx, opts) => { pollersStarted += 1; pollerOpts = opts; },
          startInboxEventStream: (c, opts) => { streamsStarted += 1; streamCtx = c; streamOpts = opts; },
          ...inbox,
        },
        'inbox-apply.js': { createInboxApplier: () => async () => {} },
        'feedback-config.js': { getFeedbackRecipient: () => '' },
      },
    });
    await flush();
    const acks = [];
    const port = { postMessage: (m) => acks.push(m) };
    return {
      acks,
      handlers,
      pollers: () => pollersStarted,
      pollerOpts: () => pollerOpts,
      streams: () => streamsStarted,
      streamCtx: () => streamCtx,
      streamOpts: () => streamOpts,
      syncDrains,
      recomputes: () => recomputes,
      debounced: () => debounced,
      tokenRegisters: () => tokenRegisters,
      dispatch: (data) => handlers.forEach((h) => h({ data, ports: [port] })),
    };
  }

  it('acks on receipt, drains on an inbox-wake message, and ignores every other SW message', async () => {
    let drains = 0;
    // The wake drain hangs from the second call on, so the ack assertion below
    // can only pass if the ack goes out on RECEIPT — acking after the drain
    // resolved would let a slow drain earn the user a duplicate notification.
    let drainHangs = false;

    const { acks, dispatch, handlers } = await bootInbox({
      drainInbox: () => {
        drains += 1;
        return drainHangs ? new Promise(() => {}) : Promise.resolve({ applied: 1 });
      },
    });

    expect(drains).toBe(1); // the boot-time drain
    expect(handlers.length).toBeGreaterThan(0);

    drainHangs = true;
    dispatch({ type: 'inbox-wake' });
    await flush();
    expect(drains).toBe(2);
    expect(acks).toEqual(['ack']); // answered while the drain is still running

    dispatch({ type: 'reminder-action', route: '/api/bp/reminder/snooze' });
    dispatch({ type: 'inbox_wake' });
    await flush();
    expect(drains).toBe(2);
    expect(acks).toEqual(['ack']); // no other SW message may ack or drain
  });

  // bd med-9d1a — a warm notification body tap: the SW hands over the reminder
  // deeplink and the (unlocked) page routes it exactly like a cold-start URL.
  it('routes a reminder-open deeplink through handleDeepLinks, ignoring off-shape urls', async () => {
    const replaced = [];
    let routed = 0;
    const { dispatch } = await bootInbox({}, (window) => {
      window.history = { replaceState: (_s, _t, url) => replaced.push(url) };
      window.handleDeepLinks = () => { routed += 1; };
    });

    dispatch({ type: 'reminder-open', url: 'https://evil.example/?tab=bp' });
    dispatch({ type: 'reminder-open', url: 42 });
    expect(replaced).toEqual([]);
    expect(routed).toBe(0);

    dispatch({ type: 'reminder-open', url: '/?action=medication_confirm&ids=2&scheduled=2026-01-01T09%3A00%3A00.000Z' });
    expect(replaced).toEqual(['/?action=medication_confirm&ids=2&scheduled=2026-01-01T09%3A00%3A00.000Z']);
    expect(routed).toBe(1);
  });

  // med-2yl: both network steps used to be awaited AHEAD of the poller and the
  // wake-listener installs, under one shared catch. So a single throw — a key
  // PUT that 500s, a drain fetch on a radio that just came back — cost the page
  // BOTH for as long as that page lived, and every Telegram command after it sat
  // at "⏳ Queued" until a reload. Neither install may depend on either step.
  it('still installs the poller and the wake listener when ensureInboxKey rejects', async () => {
    let drains = 0;
    const { acks, dispatch, pollers } = await bootInbox({
      ensureInboxKey: async () => { throw new Error('key publish 500'); },
      drainInbox: async () => { drains += 1; return { applied: 0 }; },
    });

    expect(pollers()).toBe(1); // the 5s poller went in before the failing PUT
    expect(drains).toBe(1);    // ...and the initial drain still ran after it

    dispatch({ type: 'inbox-wake' });
    await flush();
    expect(acks).toEqual(['ack']); // the wake listener is live too
    expect(drains).toBe(2);
  });

  // med-9y9 — the horizon is computed HERE and nowhere else, so a recompute the
  // browser drops is reminders stopping forever, silently. The post-drain
  // recompute used to be a fire-and-forget 2s debounce, in a tab the browser is
  // free to freeze or discard mid-timer (this path is normally reached from an
  // inbox-wake push into a BACKGROUNDED tab), and a burst of acks re-armed that
  // timer on every one. It must run immediately and be awaited.
  it('recomputes the reminder horizon immediately after an applied drain, never on a debounce', async () => {
    let applied = 0;
    const boot = await bootInbox({ drainInbox: async () => ({ applied }) });

    // Nothing applied: only the on-unlock self-heal recompute ran.
    expect(boot.recomputes()).toBe(1);

    applied = 1;
    boot.dispatch({ type: 'inbox-wake' });
    await flush();
    expect(boot.recomputes()).toBe(2); // the wake drain extended the horizon...

    // ...and so does the poller's own applied drain (afterApply is its onApplied).
    await boot.pollerOpts().onApplied({ applied: 1 });
    expect(boot.recomputes()).toBe(3);

    // No path here may leave the horizon sitting behind a droppable timer.
    expect(boot.debounced()).toBe(0);
  });

  it('still installs the poller and the wake listener when the initial drain rejects', async () => {
    let drains = 0;
    const { acks, dispatch, pollers } = await bootInbox({
      drainInbox: async () => { drains += 1; throw new Error('radio just came back'); },
    });

    expect(pollers()).toBe(1);
    expect(drains).toBe(1); // the boot drain threw...

    dispatch({ type: 'inbox-wake' });
    await flush();
    expect(acks).toEqual(['ack']); // ...and the page still takes the next wake
    expect(drains).toBe(2);
  });

  // med-j0tc: alongside the poller and the SW wake listener, boot subscribes
  // this tab to the server's content-free SSE wake — the same instant drain,
  // with no permission/subscription prerequisite. Its applied drains extend the
  // reminder horizon through the same afterApply as the other two paths.
  it('subscribes to the SSE wake on boot and recomputes the horizon after its applied drains', async () => {
    const boot = await bootInbox({ drainInbox: async () => ({ applied: 0 }) });

    expect(boot.streams()).toBe(1);
    expect(boot.streamCtx()).toMatchObject({ accountId: 'a' });
    expect(typeof boot.streamOpts().onApplied).toBe('function');

    expect(boot.recomputes()).toBe(1); // only the on-unlock self-heal ran
    await boot.streamOpts().onApplied({ applied: 1 });
    expect(boot.recomputes()).toBe(2); // the SSE path extends the horizon too
    expect(boot.debounced()).toBe(0);
  });

  // bd med-eas.9: the same stream's sync-ready wake routes into sync.js
  // requestDrain (the shared single-slot drain guard) for this vault's ctx.
  it('wires the SSE sync-ready wake to requestDrain', async () => {
    const boot = await bootInbox({ drainInbox: async () => ({ applied: 0 }) });
    expect(boot.syncDrains).toHaveLength(0);
    boot.streamOpts().onSyncReady();
    expect(boot.syncDrains).toHaveLength(1);
    expect(boot.syncDrains[0].c).toBe(boot.streamCtx());
    expect(boot.syncDrains[0].opts).toEqual({ wake: true }); // never retries a stranded import
    expect(boot.recomputes()).toBe(1); // a sync wake is not an inbox drain
  });

  // bd med-erq1.3: the app shells' APNs/FCM wake channel. A shell-like
  // NativePush (registered impl) gets its token registered on unlock, and its
  // wakes take the same paths as the SW's: inbox-wake drains (no ack port),
  // dry-queue refills the horizon, token re-registers.
  function nativePush() {
    const wakes = [];
    return {
      wakes,
      // Whether some listener took the kind: native/push-token.js turns that
      // into the event's preventDefault, the shell's receipt (bd med-erq1.4).
      fire: (kind) => wakes.map((fn) => fn(kind)).includes(true),
      install: (window) => {
        window.NativePush = { isSupported: () => true, token: async () => ({ platform: 'android', token: 't' }), onWake: (fn) => wakes.push(fn) };
      },
    };
  }

  it('native shell: registers the token once on unlock and routes each wake kind', async () => {
    const np = nativePush();
    let drains = 0;
    const boot = await bootInbox({ drainInbox: async () => { drains += 1; return { applied: 1 }; } }, np.install);
    await flush();
    expect(boot.tokenRegisters()).toBe(1);
    expect(drains).toBe(1); // the boot-time drain
    const base = boot.recomputes();

    expect(np.fire('inbox-wake')).toBe(true);
    await flush();
    expect(drains).toBe(2);
    expect(boot.recomputes()).toBe(base + 1); // afterApply, as for the SW wake
    expect(boot.acks).toEqual([]); // no ack port on the native path

    expect(np.fire('dry-queue')).toBe(true);
    await flush();
    expect(drains).toBe(2); // a refill nudge is not a drain
    expect(boot.recomputes()).toBe(base + 2);

    expect(np.fire('token')).toBe(true);
    await flush();
    expect(boot.tokenRegisters()).toBe(2);

    expect(np.fire('something-else')).toBe(false); // not taken: the shell's fallback shows
    await flush();
    expect(drains).toBe(2);
    expect(boot.recomputes()).toBe(base + 2);
    expect(boot.tokenRegisters()).toBe(2);
  });

  // The plain web page: the native/ stub (throws before/without an impl), the
  // web impl (false), or no native/ at all. onWake is absent, so subscribing
  // to it would throw the boot block.
  it.each([
    ['stub', { isSupported: () => { throw new Error('NotImplementedError'); } }],
    ['web impl', { isSupported: () => false }],
    ['absent', undefined],
  ])('web (%s): no token request and no native wake listener', async (_name, np) => {
    let drains = 0;
    const boot = await bootInbox({ drainInbox: async () => { drains += 1; return { applied: 0 }; } }, (window) => { window.NativePush = np; });
    expect(boot.tokenRegisters()).toBe(0);
    expect(drains).toBe(1); // the inbox block still ran to its initial drain
  });

  it('still subscribes to the SSE wake when ensureInboxKey rejects', async () => {
    const { streams } = await bootInbox({
      ensureInboxKey: async () => { throw new Error('key publish 500'); },
    });
    expect(streams()).toBe(1); // the subscribe, like the poller, precedes the network steps
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
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
        'apishim.js': { installApiShim: () => () => Promise.resolve(null) },
        'sync.js': {
          pullOnOpen: async () => {},
          startReconnectAutoDrain: () => () => {},
          getSyncStatus: async () => ({ authExpired: false }),
          resetLocalSync: resetImpl || (async () => { order.push('reset'); }),
        },
        'inbox.js': { clearInbox: async () => { order.push('clear'); return 0; } },
        'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
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
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
        'apishim.js': { installApiShim: () => () => Promise.resolve(null) },
        'sync.js': {
          pullOnOpen: async () => {},
          startReconnectAutoDrain: () => () => {},
          getSyncStatus: async () => ({ authExpired: false }),
          resetLocalSync: async () => { order.push('reset'); },
        },
        'inbox.js': { clearInbox: async () => { throw new Error('network down'); } },
        'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });
    await window.CloudVault.resetLocalSync();
    expect(order).toEqual(['reset']);
  });
});

describe('CloudVault.getInboxUnopenableCount (med-0tp)', () => {
  // Settings surfaces the last drain's un-openable seal count above the reset
  // escape hatch. Pin that CloudVault delegates to inbox.js's getter.
  it('delegates to the inbox module getter', async () => {
    const { window } = await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
        'apishim.js': { installApiShim: () => () => Promise.resolve(null) },
        'sync.js': {
          pullOnOpen: async () => {},
          startReconnectAutoDrain: () => () => {},
          getSyncStatus: async () => ({ authExpired: false }),
        },
        'inbox.js': { clearInbox: async () => 0, getUnopenableCount: () => 3 },
        'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });
    await expect(window.CloudVault.getInboxUnopenableCount()).resolves.toBe(3);
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
    const mod = {
        pullOnOpen: async () => {},
        startReconnectAutoDrain: () => () => {},
        getSyncStatus: async () => ({ authExpired: false }),
        readAllLiveRecords: async () => [],
        readAllRawRecords: async () => [],
        bootstrapIfNeeded: async () => {},
        // A merge passes a function of the current rows (read inside the
        // records lock); readAllRawRecords stands in for those rows here.
        replaceAllRecords: async (input) => {
          calls.replaceAllRecords += 1;
          if (typeof input === 'function') {
            calls.computed = await input(await mod.readAllRawRecords());
            calls.replaced = calls.computed.records;
          } else {
            calls.replaced = input;
          }
          calls.order.push('replace');
        },
        forceSnapshot: async () => { calls.forceSnapshot += 1; calls.order.push('snapshot'); },
        markForceSnapshotPending: async () => { calls.markForceSnapshotPending += 1; calls.order.push('mark'); },
        dropPendingForTypes: async (types) => { calls.dropPendingForTypes.push(types); calls.order.push('drop'); },
        ...overrides,
    };
    return { calls, mod };
  }
  const MANAGED = new Set(['note', 'bp']);
  const VAULT_MOD = { vaultToRecords: () => [], managedTypesForImport: () => MANAGED, mergeRecords: realVault.mergeRecords };
  const VAULT_JSON = '{"format":"medtracker-vault","version":1,"data":{}}';

  async function bootWithSync(sync) {
    const { window } = await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
        'apishim.js': { installApiShim: () => () => Promise.resolve(null), withMaterializationStopped: (fn) => fn() },
        'sync.js': sync.mod,
        '/domain/vault.js': VAULT_MOD,
        'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
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
          'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
          'apishim.js': { installApiShim: () => () => Promise.resolve(null) },
          'sync.js': sync.mod,
          '/domain/vault.js': realVault,
          'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
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
    expect(sync.calls.order).toEqual(['mark', 'drop', 'replace', 'snapshot']);
  });

  // Merge (bd med-o7zq.38): the receiver keeps every row (tombstones too) and
  // gains the file's absent ones; its pending writes stay queued.
  const MINE = [
    { recordType: 'weight', recordId: 'weight-1', clientTs: 5, deleted: false, weight: 80 },
    { recordType: 'intake', recordId: 'intake-7-1', clientTs: 5, deleted: true },
  ];
  const THEIRS = [
    { recordType: 'weight', recordId: 'weight-1', clientTs: 9, deleted: false, weight: 99 },
    { recordType: 'intake', recordId: 'intake-7-1', clientTs: 9, deleted: false },
    { recordType: 'note', recordId: 'n-2', clientTs: 9, deleted: false },
  ];
  const mergeVault = { ...VAULT_MOD, vaultToRecords: () => THEIRS };

  it('merge replaces with the receiver rows plus the absent incoming ones, keeping pending', async () => {
    const sync = syncModule({ isBootstrapped: async () => true, readAllRawRecords: async () => MINE });
    const { window } = await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
        'apishim.js': { installApiShim: () => () => Promise.resolve(null), withMaterializationStopped: (fn) => fn() },
        'sync.js': sync.mod,
        '/domain/vault.js': mergeVault,
        'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });
    await window.CloudVault.importAll(VAULT_JSON, { mode: 'merge' });
    expect(sync.calls.replaced).toEqual([...MINE, THEIRS[2]]);
    expect(sync.calls.computed.dropPendingIds).toEqual(new Set());
    expect(sync.calls.dropPendingForTypes).toHaveLength(0);
    expect(sync.calls.order).toEqual(['mark', 'replace', 'snapshot']);
  });

  it('merge also refuses to touch anything before the account cursor exists', async () => {
    const sync = syncModule({ isBootstrapped: async () => false, readAllRawRecords: async () => MINE });
    const window = await bootWithSync(sync);
    await expect(window.CloudVault.importAll(VAULT_JSON, { mode: 'merge' })).rejects.toThrow(/Sync not ready/);
    expect(sync.calls.order).toEqual([]);
  });

  it('a merge that adds a weight row drops pending weight writes inside the replace, so the overlay keeps the rewalked trend', async () => {
    const pendingWeight = { recordType: 'weight', recordId: 'weight-1', clientTs: 5, deleted: false, weight: 80, measured_at: '2026-07-02T08:00:00Z', weight_trend: 80 };
    const earlier = { recordType: 'weight', recordId: 'weight-0', clientTs: 9, deleted: false, weight: 100, measured_at: '2026-07-01T08:00:00Z', weight_trend: 100 };
    const sync = syncModule({ isBootstrapped: async () => true, readAllRawRecords: async () => [pendingWeight] });
    const { window } = await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', kData: {}, kMac: {} }) },
        'apishim.js': { installApiShim: () => () => Promise.resolve(null), withMaterializationStopped: (fn) => fn() },
        'sync.js': sync.mod,
        '/domain/vault.js': { ...VAULT_MOD, vaultToRecords: () => [earlier] },
        'reminders.js': { scheduleReminderRecompute: () => {}, recomputeAndPush: async () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });
    await window.CloudVault.importAll(VAULT_JSON, { mode: 'merge' });
    // Dropped inside the replace's records lock, not by a separate call.
    expect(sync.calls.computed.dropPendingIds).toEqual(new Set(['weight-1']));
    expect(sync.calls.dropPendingForTypes).toHaveLength(0);
    expect(sync.calls.order).toEqual(['mark', 'replace', 'snapshot']);
    expect(sync.calls.replaced.find((r) => r.recordId === 'weight-1').weight_trend).toBe(98);
  });
});

describe('cloud-boot early service worker registration (med-gvk.1)', () => {
  // The SW warms + serves the offline app shell with zero network on the
  // critical path. Registering it at module top — before the unlock/sync gates
  // and OUTSIDE med-gvk.2's detached background sync — establishes the cache on
  // first paint, not only after a fully successful boot. It must never gate the
  // mount (MedTrackerCloudReady).
  let priorNavigator;
  afterEach(() => { Object.defineProperty(globalThis, 'navigator', {value: priorNavigator, configurable: true, writable: true}) });

  it('registers /sw.js before the unlock gate and does not block MedTrackerCloudReady', async () => {
    priorNavigator = globalThis.navigator;
    const order = [];
    const register = (url) => {
      order.push('register:' + url);
      // A promise that NEVER resolves: if boot awaited it, MedTrackerCloudReady
      // would hang and this test would time out. It resolving here proves the
      // registration is off the critical path.
      return new Promise(() => {});
    };
    Object.defineProperty(globalThis, 'navigator', {value: { serviceWorker: { register, controller: null, addEventListener() {} } }, configurable: true, writable: true})

    const { location } = await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => { order.push('warmUnlock'); return null; } },
      },
    });

    // Fired at module eval, BEFORE the warm-unlock gate ran.
    expect(order[0]).toBe('register:/sw.js');
    expect(order.indexOf('register:/sw.js')).toBeLessThan(order.indexOf('warmUnlock'));
    // Boot completed (redirect resolved) even though register() never settled.
    expect(location.href).toBe('/unlock');
  });

  it('reloads on controllerchange only when an existing controller was replaced (med-7gw)', async () => {
    // First install: no prior controller. activate's clients.claim() fires
    // controllerchange, but the page must NOT reload (it is already showing the
    // fresh version).
    priorNavigator = globalThis.navigator;
    let firstHandler;
    globalThis.navigator = {
      serviceWorker: {
        controller: null, // first-ever install
        register: () => Promise.resolve({ waiting: null }),
        addEventListener: (type, fn) => { if (type === 'controllerchange') firstHandler = fn; },
      },
    };
    const first = await runBoot({ modules: { 'unlock.js': { warmUnlock: async () => null } } });
    first.location.reload = () => { first.location.href = 'RELOADED'; };
    firstHandler();
    expect(first.location.href).toBe('/unlock'); // no reload on first install

    // Update: a controller already ran this page. controllerchange (post
    // SKIP_WAITING) reloads exactly once, even if it fires twice.
    let updateHandler;
    globalThis.navigator = {
      serviceWorker: {
        controller: {}, // an existing SW controls the page
        register: () => Promise.resolve({ waiting: null }),
        addEventListener: (type, fn) => { if (type === 'controllerchange') updateHandler = fn; },
      },
    };
    const upd = await runBoot({ modules: { 'unlock.js': { warmUnlock: async () => null } } });
    let reloads = 0;
    upd.location.reload = () => { reloads++; };
    updateHandler();
    updateHandler();
    expect(reloads).toBe(1); // guarded against a double reload
  });

  it('skips registration when serviceWorker is unavailable, and boot still proceeds', async () => {
    priorNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {value: {}, configurable: true, writable: true}) // no serviceWorker
    const { location } = await runBoot({
      modules: { 'unlock.js': { warmUnlock: async () => null } },
    });
    expect(location.href).toBe('/unlock');
  });

  it('coordinates the REAL boot controllerchange handler with provider handoff before activation', async () => {
    priorNavigator = globalThis.navigator;
    const dom = new JSDOM('<html></html>');
    const sw = new dom.window.EventTarget();
    const old = { postMessage() {} }; // deployed older worker has no capability reply
    sw.controller = old;
    let next;
    next = { state: 'installed', postMessage(message, ports) {
      if (message.type === 'PROVIDER_RELOAD_CAPABILITY') ports[0].postMessage({ type: message.type, version: 1 });
      if (message.type === 'SKIP_WAITING') {
        sw.controller = next;
        sw.dispatchEvent(new dom.window.Event('controllerchange'));
      }
    } };
    const registration = { waiting: null, update: vi.fn(async () => { registration.waiting = next; }) };
    sw.register = async () => registration;
    sw.getRegistration = async () => registration;
    globalThis.navigator = { serviceWorker: sw };
    const replace = vi.fn();
    const booted = await runBoot({
      setupWindow(win) {
        win.document = dom.window.document; win.CustomEvent = dom.window.CustomEvent;
        win.navigator = globalThis.navigator;
        win.location = { origin: 'https://account.example', href: 'https://account.example/', replace };
      },
      modules: { 'unlock.js': { warmUnlock: async () => null } },
    });
    booted.location.reload = vi.fn();
    const commit = vi.fn(() => true);
    expect(await reloadProviderDocument({ win: booted.window, onCommit: commit })).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(sw.controller).toBe(next);
    expect(registration.update).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledExactlyOnceWith('https://account.example/?__wg_provider_reload=1');
    expect(booted.location.reload).not.toHaveBeenCalled();
    dom.window.close();
  });

  it('an edit during real preparation aborts before skip and keeps unrelated update policy', async () => {
    priorNavigator = globalThis.navigator;
    const dom = new JSDOM('<html></html>');
    const sw = new dom.window.EventTarget();
    sw.controller = { postMessage() {} };
    let dirty = false;
    const next = new dom.window.EventTarget(); next.state = 'installed';
    next.postMessage = vi.fn((message, ports) => {
      if (message.type === 'PROVIDER_RELOAD_CAPABILITY') {
        dirty = true;
        ports[0].postMessage({ type: message.type, version: 1 });
      }
    });
    const registration = { waiting: next, update: async () => {} };
    sw.register = async () => registration; sw.getRegistration = async () => registration;
    globalThis.navigator = { serviceWorker: sw };
    const replace = vi.fn();
    const booted = await runBoot({ setupWindow(win) {
      win.document = dom.window.document; win.CustomEvent = dom.window.CustomEvent; win.navigator = globalThis.navigator;
      win.location = { origin: 'https://account.example', href: 'https://account.example/', replace };
    }, modules: { 'unlock.js': { warmUnlock: async () => null } } });
    booted.location.reload = vi.fn();
    const commit = vi.fn(() => true);
    expect(await reloadProviderDocument({ win: booted.window, isCurrent: () => !dirty, onCommit: commit })).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(next.postMessage).not.toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(replace).not.toHaveBeenCalled();
    sw.controller = {}; sw.dispatchEvent(new dom.window.Event('controllerchange'));
    expect(booted.location.reload).toHaveBeenCalledOnce();
    dom.window.close();
  });

  it('keeps late activation committed, coalesces Retry and immediately marks exactly one navigation on claim', async () => {
    priorNavigator = globalThis.navigator;
    const env = loadFrontendEnv();
    const domWindow = env.window;
    const sw = new domWindow.EventTarget();
    const old = new domWindow.EventTarget(); old.state = 'activated'; old.postMessage = () => {};
    const next = new domWindow.EventTarget(); next.state = 'installed';
    const skipWaiting = vi.fn();
    next.postMessage = (message, ports) => {
      if (message.type === 'PROVIDER_RELOAD_CAPABILITY') ports[0].postMessage({ type: message.type, version: 1 });
      if (message.type === 'SKIP_WAITING') skipWaiting(); // activation finishes after the helper times out
    };
    const registration = { waiting: null, update: async () => { registration.waiting = next; } };
    sw.controller = old; sw.register = async () => registration; sw.getRegistration = async () => registration;
    globalThis.navigator = { serviceWorker: sw };
    const replace = vi.fn();
    const flush = vi.fn();
    const booted = await runBoot({
      setupWindow(win) {
        win.document = env.document; win.CustomEvent = domWindow.CustomEvent;
        win.navigator = globalThis.navigator; win.flushPendingDelete = flush;
        win.location = { origin: 'https://account.example', href: 'https://account.example/', replace };
      }, modules: { 'unlock.js': { warmUnlock: async () => null } },
    });
    booted.location.reload = vi.fn();
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => realTimeout(fn, ms === 500 ? 10 : ms === 20000 ? 300 : ms, ...args));
    try {
      const commit = vi.fn(() => true);
      const pending = vi.fn();
      expect(await reloadProviderDocument({ win: booted.window, onCommit: commit, onPending: pending })).toMatchObject({ state: 'committed' });
      expect(skipWaiting).toHaveBeenCalledOnce();
      // The same still-pending actual worker belongs to the first activation;
      // a subsequent explicit retry may join it but must not stack activation.
      expect(await reloadProviderDocument({ win: booted.window })).toMatchObject({ state: 'committed' });
      expect(skipWaiting).toHaveBeenCalledOnce();
      expect(commit).toHaveBeenCalledOnce();
      expect(pending).toHaveBeenCalledTimes(2);
      const probes = next.postMessage;
      const beforeClaim = skipWaiting.mock.calls.length;
      sw.controller = next; next.state = 'activated';
      sw.dispatchEvent(new domWindow.Event('controllerchange'));
      expect(booted.location.reload).not.toHaveBeenCalled();
      // Synchronous assertion: no additional await/probe before replacement.
      expect(replace).toHaveBeenCalledExactlyOnceWith('https://account.example/?__wg_provider_reload=1');
      expect(flush).not.toHaveBeenCalled();
      expect(skipWaiting.mock.calls.length).toBe(beforeClaim);
      expect(next.postMessage).toBe(probes);
      sw.dispatchEvent(new domWindow.Event('controllerchange'));
      expect(replace).toHaveBeenCalledOnce();
      // This page is already leaving. No second ordinary navigation races it.
      sw.controller = {};
      sw.dispatchEvent(new domWindow.Event('controllerchange'));
      expect(flush).not.toHaveBeenCalled();
      expect(booted.location.reload).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); env.cleanup(); }
  });

  it('definitive redundancy wakes the owned wait so the first Retry prepares a real replacement immediately', async () => {
    priorNavigator = globalThis.navigator;
    const dom = new JSDOM('<html></html>');
    const sw = new dom.window.EventTarget();
    sw.controller = { postMessage() {} };
    const skipped = vi.fn(), replacementSkipped = vi.fn();
    const first = new dom.window.EventTarget(); first.state = 'installed';
    const next = new dom.window.EventTarget(); next.state = 'installed';
    first.postMessage = (message, ports) => {
      if (message.type === 'PROVIDER_RELOAD_CAPABILITY') ports[0].postMessage({ type: message.type, version: 1 });
      if (message.type === 'SKIP_WAITING') skipped();
    };
    next.postMessage = (message, ports) => {
      if (message.type === 'PROVIDER_RELOAD_CAPABILITY') ports[0].postMessage({ type: message.type, version: 1 });
      if (message.type === 'SKIP_WAITING') {
        replacementSkipped(); sw.controller = next; next.state = 'activated';
        sw.dispatchEvent(new dom.window.Event('controllerchange'));
      }
    };
    const registration = { waiting: first, update: vi.fn(async () => {
      if (first.state === 'redundant') registration.waiting = next;
    }) };
    sw.register = async () => registration; sw.getRegistration = async () => registration;
    globalThis.navigator = { serviceWorker: sw };
    const replace = vi.fn();
    const booted = await runBoot({ setupWindow(win) {
      win.document = dom.window.document; win.CustomEvent = dom.window.CustomEvent; win.navigator = globalThis.navigator;
      win.location = { origin: 'https://account.example', href: 'https://account.example/', replace };
    }, modules: { 'unlock.js': { warmUnlock: async () => null } } });
    booted.location.reload = vi.fn();
    const commit = vi.fn(() => true), pending = vi.fn();
    let settled = false;
    const running = reloadProviderDocument({ win: booted.window, onCommit: commit, onPending: pending });
    running.then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(skipped).toHaveBeenCalledOnce(), { timeout: 2500 });
      expect(settled).toBe(false);
      first.state = 'redundant'; first.dispatchEvent(new dom.window.Event('statechange'));
      // This is well before the real twenty-second progress deadline.
      await vi.waitFor(() => expect(settled).toBe(true));
      const result = await running;
      expect(result.state).toBe('committed');
      expect(pending).toHaveBeenCalledOnce();
      expect(await result.retry()).toBe(true);
      expect(registration.update).toHaveBeenCalledTimes(2);
      expect(skipped).toHaveBeenCalledOnce();
      expect(replacementSkipped).toHaveBeenCalledOnce();
      expect(commit).toHaveBeenCalledOnce();
      expect(replace).toHaveBeenCalledExactlyOnceWith('https://account.example/?__wg_provider_reload=1');
      expect(booted.location.reload).not.toHaveBeenCalled();
    } finally {
      sw.controller = {}; sw.dispatchEvent(new dom.window.Event('controllerchange'));
      dom.window.close();
    }
  });

  it('retires redundant activation guards and ignores cleanup from an older UI attempt', async () => {
    priorNavigator = globalThis.navigator;
    const dom = new JSDOM('<html></html>');
    const sw = new dom.window.EventTarget();
    sw.controller = {}; sw.register = async () => ({ waiting: null });
    globalThis.navigator = { serviceWorker: sw };
    const booted = await runBoot({ setupWindow(win) { win.document = dom.window.document; }, modules: { 'unlock.js': { warmUnlock: async () => null } } });
    booted.location.reload = vi.fn();
    const first = { claim: vi.fn(), redundant: vi.fn(), supersede: vi.fn() }, second = { claim: vi.fn(), redundant: vi.fn(), supersede: vi.fn() };
    const candidate = new dom.window.EventTarget(); candidate.state = 'installed';
    first.worker = candidate; second.worker = candidate;
    const activation = { operation: first, accepted: false };
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('wg:provider-reload-activation', { detail: activation }));
    const retry = { operation: second, accepted: false };
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('wg:provider-reload-activation', { detail: retry }));
    expect(activation.accepted).toBe(true);
    expect(retry.accepted).toBe(false);
    candidate.state = 'redundant'; candidate.dispatchEvent(new dom.window.Event('statechange'));
    expect(first.redundant).toHaveBeenCalledOnce();
    const retired = { operation: second, accepted: false };
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('wg:provider-reload-activation', { detail: retired }));
    expect(retired.accepted).toBe(true);
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('wg:provider-reload-abort', { detail: { operation: first } }));
    sw.controller = {}; sw.dispatchEvent(new dom.window.Event('controllerchange'));
    expect(booted.location.reload).toHaveBeenCalledOnce();
    expect(second.supersede).toHaveBeenCalledOnce();
    dom.window.close();
  });
});

describe('cloud-boot share-plan fragment across unlock (med-uo64.3)', () => {
  it('forwards #share-plan= to /unlock when there is no cached LDK record', async () => {
    const { location } = await runBoot({
      hash: '#share-plan=p1.abc',
      modules: { 'unlock.js': { warmUnlock: async () => null } },
    });
    expect(location.href).toBe('/unlock#share-plan=p1.abc');
  });

  it('forwards a shared-gym #share-gym= fragment the same way (med-8j5w.3)', async () => {
    const { location } = await runBoot({
      hash: '#share-gym=g1.abc',
      modules: { 'unlock.js': { warmUnlock: async () => null } },
    });
    expect(location.href).toBe('/unlock#share-gym=g1.abc');
  });

  it('forwards #share-plan= to /unlock when the warm-unlock read itself throws', async () => {
    const { location } = await runBoot({
      hash: '#share-plan=p1.abc',
      modules: { 'unlock.js': () => Promise.reject(new Error('idb broken')) },
    });
    expect(location.href).toBe('/unlock#share-plan=p1.abc');
  });

  it('plain /unlock redirect carries no fragment when none was present', async () => {
    const { location } = await runBoot({
      hash: '',
      modules: { 'unlock.js': { warmUnlock: async () => null } },
    });
    expect(location.href).toBe('/unlock');
  });

  it('never forwards an arbitrary fragment via the share branch', async () => {
    const { location } = await runBoot({
      hash: '#other=x',
      modules: { 'unlock.js': { warmUnlock: async () => null } },
    });
    expect(location.href).toBe('/unlock');
  });
});

// bd med-nt9p.32.18: the local → cloud move pickup. The REAL cloud-boot.js body
// runs in the frontend harness window, so the pickup goes through the real
// settings.js nativeHas probe and the real importexport.js restoreVault; only
// the bridge, the dialogs and CloudVault's probe/import are stubbed.
describe('cloud-boot local → cloud move pickup (med-nt9p.32.18)', () => {
  // The golden vault (docs/vault-format.md): a stash that carries records.
  const VAULT = readFileSync(fileURLToPath(new URL('../../../../tests/fixtures/vault-v1.json', import.meta.url)), 'utf8');
  const MOVED = realVault.userContentCount(realVault.vaultToRecords(JSON.parse(VAULT), { now: Date.now() }));
  // What moveToCloud {url} stashes from a device with nothing logged (bd med-ta2n.7).
  const EMPTY_VAULT = JSON.stringify(realVault.recordsToVault([], { now: Date.now() }));
  const UNLOCKED = async () => ({ accountId: 'a', kData: {}, kMac: {} });
  let env;

  beforeEach(() => {
    allowConsoleNoise(); // location.reload is a jsdom "not implemented" error
    env = loadFrontendEnv();
  });
  afterEach(() => env.cleanup());

  async function boot({
    platform = 'android', ops = ['shell.ops', 'move.take', 'move.clear'], stash = { vault: VAULT },
    content = false, choice = 'replace', confirm = true, importAll, warmUnlock = UNLOCKED, live, pull, erase,
  } = {}) {
    const { window } = env;
    const log = [];
    const call = vi.fn(async (op) => {
      log.push(op);
      if (op === 'shell.ops') { if (!ops) throw new Error('unsupported: shell.ops'); return ops; }
      if (op === 'move.take') return stash;
      if (op === 'local.erase' && erase) return erase();
      return true;
    });
    if (platform) window.LocalNotifications = { ...window.LocalNotifications, __native: { platform, call }, copy: { device: 'phone' } };
    window.safeChoose = vi.fn(async () => { log.push('choose'); return choice; });
    window.safeConfirm = vi.fn(async () => { log.push('confirm'); return confirm; });
    window.safeAlert = vi.fn(async () => { log.push('alert'); });
    window.safeToast = vi.fn();
    let release;
    const pulled = new Promise((r) => { release = r; });
    const modules = {
      'unlock.js': { warmUnlock },
      'apishim.js': { installApiShim: () => async () => null },
      'sync.js': {
        pullOnOpen: pull || (() => pulled),
        startReconnectAutoDrain() {},
        getSyncStatus: async () => ({}),
        readAllLiveRecords: async () => live || [],
      },
      '/domain/vault.js': realVault,
    };
    const __imp = (spec) => {
      const key = spec.replace('/js/', '');
      return key in modules ? Promise.resolve(modules[key]) : Promise.reject(new Error(`unexpected import(${spec})`));
    };
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'location', 'navigator', '__imp', SRC)(
      window, window.document, window.location, window.navigator, __imp,
    );
    await window.MedTrackerCloudReady;
    // CloudVault is cloud-boot's own; swap the two calls restoreVault makes.
    if (window.CloudVault) {
      // `live` set: the real probe over those account records instead.
      if (!live) window.CloudVault.hasUserContent = vi.fn(async () => {
        log.push('probe');
        if (content instanceof Error) throw content;
        return content;
      });
      window.CloudVault.importAll = vi.fn(async (json) => {
        log.push('importAll');
        return importAll ? importAll(json) : { upload: 'synced' };
      });
    }
    release();
    return { window, call, log };
  }
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('stash + empty account: imports with no dialog, then move.clear, then reload with a one-time toast', async () => {
    const { window, log } = await boot();
    await vi.waitFor(() => expect(log).toContain('move.clear'));
    expect(log).toEqual(['shell.ops', 'move.take', 'probe', 'importAll', 'move.clear']);
    expect(window.CloudVault.importAll).toHaveBeenCalledWith(VAULT);
    expect(window.safeConfirm).not.toHaveBeenCalled();
    expect(MOVED).toBeGreaterThan(1);
    expect(window.sessionStorage.getItem('wg-move-picked-up')).toBe(String(MOVED));
    const at = Number(window.sessionStorage.getItem('wg-move-picked-at'));
    expect(Date.now() - at).toBeGreaterThanOrEqual(0);
    expect(Date.now() - at).toBeLessThan(60_000);
  });

  // bd med-ta2n.23 (twin of #1264's leave fix): the pickup's move.clear lost to
  // the 5 s box on a slow bridge, so the reloaded page found the stash again
  // and asked Merge / Replace over the records it had just imported.
  it('the reload right after a pickup clears a stash still there instead of taking it again', async () => {
    env.window.sessionStorage.setItem('wg-move-picked-up', String(MOVED));
    env.window.sessionStorage.setItem('wg-move-picked-at', String(Date.now()));
    const { window, log } = await boot({ content: true });
    await vi.waitFor(() => expect(log).toContain('move.clear'));
    await settle();
    expect(log).toEqual(['shell.ops', 'move.clear']);
    expect(window.safeChoose).not.toHaveBeenCalled();
    expect(window.safeConfirm).not.toHaveBeenCalled();
    expect(window.safeToast).toHaveBeenCalledWith(`Sync is on · ${MOVED} records are on your account`, 'success');
    expect(window.sessionStorage.getItem('wg-move-picked-up')).toBeNull();
    expect(window.sessionStorage.getItem('wg-move-picked-at')).toBeNull();
  });

  it('a notice flag without a fresh pickup stamp still takes the stash (asks, never drops it)', async () => {
    for (const at of [null, String(Date.now() - 10 * 60 * 1000)]) {
      env.cleanup();
      env = loadFrontendEnv();
      env.window.sessionStorage.setItem('wg-move-picked-up', '3');
      if (at !== null) env.window.sessionStorage.setItem('wg-move-picked-at', at);
      const { window, log } = await boot({ content: true, choice: 'merge' });
      await vi.waitFor(() => expect(log).toContain('move.clear'));
      expect(log).toEqual(['shell.ops', 'move.take', 'probe', 'choose', 'importAll', 'move.clear']);
      expect(window.safeChoose).toHaveBeenCalledTimes(1);
    }
  });

  // P3 · done (bd med-ta2n.7): the count the pickup moved.
  it('after the reload: "Sync is on · N records" shows once and nothing is imported again', async () => {
    env.window.sessionStorage.setItem('wg-move-picked-up', '43');
    const { window, log } = await boot({ stash: null });
    await vi.waitFor(() => expect(log).toContain('move.take'));
    await settle();
    expect(window.safeToast).toHaveBeenCalledWith('Sync is on · 43 records are on your account', 'success');
    expect(window.sessionStorage.getItem('wg-move-picked-up')).toBeNull();
    expect(log).not.toContain('importAll');
    expect(log).not.toContain('move.clear');
  });

  it('the toast says "record is" for one', async () => {
    env.window.sessionStorage.setItem('wg-move-picked-up', '1');
    const { window, log } = await boot({ stash: null });
    await vi.waitFor(() => expect(log).toContain('move.take'));
    await settle();
    expect(window.safeToast).toHaveBeenCalledWith('Sync is on · 1 record is on your account', 'success');
  });

  // #1244 breakage review: moveToCloud {url} always stashes, so a device with
  // nothing logged stashes an empty vault. It moves nothing: dropped, never
  // offered as a Merge/Replace to an account with records.
  it('a stash with no user content + an account with records: move.clear, no dialog, no import', async () => {
    const { window, log } = await boot({ stash: { vault: EMPTY_VAULT }, content: true });
    await vi.waitFor(() => expect(log).toContain('move.clear'));
    await settle();
    expect(log).toEqual(['shell.ops', 'move.take', 'probe', 'move.clear']);
    expect(window.safeChoose).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('wg-move-picked-up')).toBeNull();
  });

  // #1248 breakage review: an unknown account (offline / failed pull →
  // undefined, or a throw) must not drop the stash's settings and keys.
  it.each([
    // null: boot()'s default would turn undefined into false; the pickup
    // treats both the same (only true / false act).
    ['an unknown answer (offline)', null],
    ['a throwing probe', new Error('pull failed')],
  ])('a stash with no user content + %s: the stash is kept, nothing imported', async (_, content) => {
    const { window, log } = await boot({ stash: { vault: EMPTY_VAULT }, content });
    await vi.waitFor(() => expect(log).toContain('probe'));
    await settle();
    expect(log).toEqual(['shell.ops', 'move.take', 'probe']);
    expect(window.safeChoose).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('wg-move-picked-up')).toBeNull();
  });

  // Settings, features and keys still move into an empty account, silently.
  it('a stash with no user content + an empty account: imported with no dialog, then "Sync is on"', async () => {
    const { window, log } = await boot({ stash: { vault: EMPTY_VAULT } });
    await vi.waitFor(() => expect(log).toContain('move.clear'));
    expect(log).toEqual(['shell.ops', 'move.take', 'probe', 'probe', 'importAll', 'move.clear']);
    expect(window.safeChoose).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('wg-move-picked-up')).toBe('0');
  });

  it('after the reload of a records-free move: the toast says "Sync is on"', async () => {
    env.window.sessionStorage.setItem('wg-move-picked-up', '0');
    const { window, log } = await boot({ stash: null });
    await vi.waitFor(() => expect(log).toContain('move.take'));
    await settle();
    expect(window.safeToast).toHaveBeenCalledWith('Sync is on', 'success');
  });

  // A fresh account holds only what signup and the first run wrote (bd
  // med-o7zq.37): the real probe finds nothing at stake, so no confirm.
  it('stash + fresh account with only settings and onboarding records: no dialog', async () => {
    const rec = (recordType) => ({ recordType, recordId: recordType, clientTs: 1, deleted: false });
    const live = ['settings', 'features', 'integrations', 'taborder', 'firstrun'].map(rec);
    const { window, log } = await boot({ live });
    await vi.waitFor(() => expect(log).toContain('move.clear'));
    expect(log).toEqual(['shell.ops', 'move.take', 'importAll', 'move.clear']);
    expect(window.safeConfirm).not.toHaveBeenCalled();
  });

  it('works the same on an iOS shell that lists move.take', async () => {
    const { log } = await boot({ platform: 'ios' });
    await vi.waitFor(() => expect(log).toContain('move.clear'));
  });

  // bd med-o7zq.38: an account with content offers Merge / Replace / Cancel.
  it('stash + account with content: Replace, confirmed with typed REPLACE, replaces the account', async () => {
    const { window, log } = await boot({ content: true });
    await vi.waitFor(() => expect(log).toContain('move.clear'));
    expect(log).toEqual(['shell.ops', 'move.take', 'probe', 'choose', 'confirm', 'importAll', 'move.clear']);
    expect(window.safeChoose.mock.calls[0][2]).toMatchObject({ title: 'Records already in your account', confirmLabel: 'Continue', selected: 'merge' });
    expect(window.safeConfirm.mock.calls[0][2]).toMatchObject({ destructive: true, confirmLabel: 'Replace', typedConfirm: 'REPLACE' });
    expect(window.CloudVault.importAll).toHaveBeenCalledWith(VAULT, { mode: 'replace' });
  });

  it('stash + account with content: Merge imports with no confirm', async () => {
    const { window, log } = await boot({ content: true, choice: 'merge' });
    await vi.waitFor(() => expect(log).toContain('move.clear'));
    expect(log).toEqual(['shell.ops', 'move.take', 'probe', 'choose', 'importAll', 'move.clear']);
    expect(window.CloudVault.importAll).toHaveBeenCalledWith(VAULT, { mode: 'merge' });
  });

  it.each([
    ['choice cancelled', { choice: null }],
    ['Replace declined', { confirm: false }],
  ])('%s: nothing imported, stash kept, no dialog after it (med-o7zq.42)', async (_, opts) => {
    const { window, log } = await boot({ content: true, ...opts });
    await vi.waitFor(() => expect(log).toContain(opts.confirm === false ? 'confirm' : 'choose'));
    await settle();
    expect(log).not.toContain('importAll');
    expect(log).not.toContain('move.clear');
    expect(window.safeAlert).not.toHaveBeenCalled();
  });

  it('importAll rejects: never move.clear, the error is shown', async () => {
    const { window, log } = await boot({ importAll: async () => { throw new Error('Sync not ready.'); } });
    await vi.waitFor(() => expect(log).toContain('alert'));
    await settle();
    expect(log).not.toContain('move.clear');
    expect(window.safeAlert.mock.calls[0][0]).toMatch(/Sync not ready\..*tries again/);
    expect(window.sessionStorage.getItem('wg-move-picked-up')).toBeNull();
  });

  it('no stash: nothing else happens', async () => {
    const { log } = await boot({ stash: null });
    await vi.waitFor(() => expect(log).toContain('move.take'));
    await settle();
    expect(log).toEqual(['shell.ops', 'move.take']);
  });

  it('no shell (the web): no bridge call, no probe', async () => {
    const { window, call } = await boot({ platform: null });
    await settle();
    expect(call).not.toHaveBeenCalled();
    expect(window.CloudVault.hasUserContent).not.toHaveBeenCalled();
  });

  it('a shell without move.take, or one that rejects shell.ops: never asks for the stash', async () => {
    for (const ops of [['shell.ops', 'account.leave'], null]) {
      env.cleanup();
      env = loadFrontendEnv();
      const { log } = await boot({ ops });
      await vi.waitFor(() => expect(log).toContain('shell.ops'));
      await settle();
      expect(log).toEqual(['shell.ops']);
    }
  });

  // Owner invariant: only a passkey-unlocked account may take the stash.
  it('locked vault or a failed unlock: move.take is never called', async () => {
    for (const warmUnlock of [async () => null, async () => { throw new Error('ldk read failed'); }]) {
      env.cleanup();
      env = loadFrontendEnv();
      const { call, log } = await boot({ warmUnlock, ops: ['shell.ops', 'move.take', 'move.clear', 'local.erase'] });
      await settle();
      expect(call).not.toHaveBeenCalledWith('move.take');
      expect(call).not.toHaveBeenCalledWith('move.clear');
      expect(log).not.toContain('local.erase'); // AD9: no erase before the account is unlocked
    }
  });

  // bd med-r1j2.4 (AD9 "Join and erase"): the local page erased nothing; the
  // joined account's unlocked boot tells the shell to finish, once.
  it('join and erase: an unlocked boot on a shell with local.erase asks it once; no move import', async () => {
    env.window.sessionStorage.setItem('wg-join-enrolled', '1'); // claim.js, right after this tab enrolled
    const { window, call, log } = await boot({ ops: ['shell.ops', 'local.erase'], stash: null });
    await vi.waitFor(() => expect(log).toContain('local.erase'));
    await settle();
    // {enrolled: true}: the shell ignores a bare local.erase (an older cached cloud-boot.js).
    expect(call.mock.calls.filter(([op]) => op === 'local.erase')).toEqual([['local.erase', { enrolled: true }]]);
    expect(window.safeConfirm).not.toHaveBeenCalled();
    expect(log).not.toContain('move.take');
    expect(window.sessionStorage.getItem('wg-join-enrolled')).toBeNull(); // one-shot
  });

  // bd med-r1j2.7: a failed join's Close lands on '/', where an older session
  // can boot unlocked — without this tab's enrollment marker nothing is erased.
  it('join and erase: an unlocked boot without the enrollment marker never asks', async () => {
    const { log } = await boot({ ops: ['shell.ops', 'local.erase'], stash: null });
    await vi.waitFor(() => expect(log).toContain('shell.ops'));
    await settle();
    expect(log).not.toContain('local.erase');
  });

  // The marker belongs to the boot right after the enroll: one that fails
  // before finishJoinErase (pullOnOpen rejects) still drops it, so a later
  // unrelated boot erases nothing.
  it('join and erase: a boot whose pull fails consumes the marker and erases nothing', async () => {
    env.window.sessionStorage.setItem('wg-join-enrolled', '1');
    const { window, log } = await boot({ ops: ['shell.ops', 'local.erase'], stash: null, pull: async () => { throw new Error('pull failed'); } });
    await settle();
    expect(window.sessionStorage.getItem('wg-join-enrolled')).toBeNull();
    expect(log).not.toContain('local.erase');
  });

  // Argus #1: a wipe that did not finish keeps the shell's intent and says so;
  // Try again asks once more, Not now stops.
  it('join and erase: a failed wipe is reported and Try again retries it', async () => {
    env.window.sessionStorage.setItem('wg-join-enrolled', '1');
    let fails = 1;
    const erase = async () => { if (fails-- > 0) throw new Error('erase failed'); return true; };
    const { window, call } = await boot({ ops: ['shell.ops', 'local.erase'], stash: null, erase });
    await vi.waitFor(() => expect(call.mock.calls.filter(([op]) => op === 'local.erase')).toHaveLength(2));
    await settle();
    expect(window.safeConfirm).toHaveBeenCalledTimes(1);
    expect(window.safeConfirm.mock.calls[0][0]).toBe('The records that were on this phone before could not be erased.');
    expect(window.safeConfirm.mock.calls[0][2]).toMatchObject({ title: "Erase didn't finish", confirmLabel: 'Try again' });
  });

  // A wipe that never answers (hung WebKit) is reported too, never silent.
  it('join and erase: no answer within the time box is reported as not finished', async () => {
    // The 60 s time box (JOIN_ERASE_MS) runs out at once here.
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...rest) => real(fn, ms === 60000 ? 0 : ms, ...rest));
    try {
      env.window.sessionStorage.setItem('wg-join-enrolled', '1');
      const erase = () => new Promise(() => {});
      const { window, log } = await boot({ ops: ['shell.ops', 'local.erase'], stash: null, erase, confirm: false });
      await vi.waitFor(() => expect(window.safeConfirm).toHaveBeenCalledTimes(1));
      expect(log.filter((op) => op === 'local.erase')).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('join and erase: Not now after a failed wipe stops asking', async () => {
    env.window.sessionStorage.setItem('wg-join-enrolled', '1');
    const erase = async () => { throw new Error('erase failed'); };
    const { window, call } = await boot({ ops: ['shell.ops', 'local.erase'], stash: null, erase, confirm: false });
    await vi.waitFor(() => expect(window.safeConfirm).toHaveBeenCalledTimes(1));
    await settle();
    expect(call.mock.calls.filter(([op]) => op === 'local.erase')).toHaveLength(1);
  });
});
