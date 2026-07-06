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

async function runBoot({ hash = '', modules }) {
  const location = { hash, href: '' };
  const window = {};
  const __imp = (spec) => {
    const key = spec.replace('/js/', '');
    if (!(key in modules)) throw new Error(`unexpected import(${spec})`);
    const mod = modules[key];
    return typeof mod === 'function' ? mod() : Promise.resolve(mod);
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'location', 'console', 'URLSearchParams', '__imp', SRC);
  fn(window, location, { error() {} }, URLSearchParams, __imp);
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

  it('routes window.apiCallDirect("/api/*") through the shim, surviving a later core/api.js reassignment (med-1iv)', async () => {
    // Workout reads (groups.js/next-card.js/stats.js/today-loader.js) call
    // window.apiCallDirect directly. In cloud mode the ONLY thing that keeps
    // those from hitting the network (a guaranteed 404 — the cloud server has no
    // /api/workout/* routes) is the accessor cloud-boot installs. Pin that it
    // (a) routes /api/* to shimCall and (b) still does so after core/api.js runs
    // its `window.apiCallDirect = apiCallDirect` assignment (the historical
    // clobber that caused the med-1iv 404).
    const shimCalls = [];
    const shimCall = (endpoint) => { shimCalls.push(endpoint); return Promise.resolve([]); };
    const { window } = await runBoot({
      modules: {
        'unlock.js': { warmUnlock: async () => ({ accountId: 'a', dek: new Uint8Array(1) }) },
        'apishim.js': { installApiShim: () => shimCall },
        'sync.js': { pullOnOpen: async () => {} },
        'reminders.js': { scheduleReminderRecompute: () => {} },
        'mcp-responder.js': { refreshResponder: () => {} },
      },
    });

    // A workout read routes to the shim, not the network.
    await window.apiCallDirect('/api/workout/groups');
    expect(shimCalls).toContain('/api/workout/groups');

    // core/api.js runs after the shim's <head> injection and reassigns
    // window.apiCallDirect — the accessor must absorb it as the fallback, not be
    // replaced. /api/* still hits the shim; non-/api/ falls to the real fn.
    const realCalls = [];
    window.apiCallDirect = (endpoint) => { realCalls.push(endpoint); return Promise.resolve('real'); };
    await window.apiCallDirect('/api/workout/groups');
    expect(shimCalls.filter((e) => e === '/api/workout/groups')).toHaveLength(2);
    await window.apiCallDirect('/not-api/thing');
    expect(realCalls).toEqual(['/not-api/thing']);
  });

  it('hands a #claim= link to the /unlock shell before touching the warm-unlock cache', async () => {
    const { location } = await runBoot({ hash: '#claim=tok123', modules: {} });
    expect(location.href).toBe('/unlock#claim=tok123');
  });
});
