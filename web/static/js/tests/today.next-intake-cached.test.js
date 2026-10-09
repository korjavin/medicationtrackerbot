import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const EMPTY_STATE_JS = path.join(REPO_ROOT, 'web/static/js/components/empty-state.js');
const WG_CHIP_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-chip.js');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');

function loadTodayEnv() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://example.test/',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  const { window } = dom;
  window.eval(fs.readFileSync(EMPTY_STATE_JS, 'utf8'));
  window.eval(fs.readFileSync(WG_CHIP_JS, 'utf8'));
  const src = fs.readFileSync(TODAY_JS, 'utf8');
  window.eval(`${src}\n//# sourceURL=file://${TODAY_JS}`);
  return {
    window,
    aggregate: window.TodayDashboard.aggregateToday,
    render: window.TodayDashboard.renderToday,
    cleanup: () => dom.window.close()
  };
}

describe('Today next_intake offline read', () => {
  let env;
  beforeEach(() => { env = loadTodayEnv(); });
  afterEach(() => { env.cleanup(); });

  it('renders the cached dose as a Next up row when bootstrap fetch fails (cache populated)', () => {
    const now = new Date('2026-05-09T09:00:00Z');
    const fetchedAt = now.getTime() - 30 * 60 * 1000; // cached 30 min ago
    // Bootstrap.next_intake comes from api_cache.next_intake when /api/bootstrap
    // never landed; aggregator must surface it identically to the online path.
    const bootstrap = {
      features: { medication: true, bp: false, weight: false, food: false, workout: false, health: false },
      next_intake: {
        scheduled_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        medication_names: ['Aspirin', 'Metformin'],
        medication_ids: [11, 22]
      },
      __next_intake_meta: { fetchedAt, isStale: false }
    };

    const state = env.aggregate(bootstrap, null, now);

    expect(state.nextMed.status).toBe('ok');
    expect(state.nextMed.value.names).toEqual(['Aspirin', 'Metformin']);
    expect(state.nextMed.meta).toEqual({ fetchedAt, isStale: false });

    const root = env.window.document.createElement('div');
    env.render(state, root, { now });

    const row = root.querySelector('[data-section="next-up"] [data-next="med"]');
    expect(row).not.toBeNull();
    expect(row.querySelector('.wg-row__title').textContent).toBe('2 medications');
    // Meta carries the slot time and the names.
    expect(row.querySelector('.wg-row__meta').textContent).toContain('Aspirin, Metformin');
  });

  it('shows the "Nothing scheduled" empty state when no next_intake is cached', () => {
    const now = new Date('2026-05-09T09:00:00Z');
    // Bootstrap landed with no next_intake (e.g. backend errored) — but we
    // know the user has at least feature enabled and is offline.
    const bootstrap = {
      features: { medication: true, bp: false, weight: false, food: false, workout: false, health: false },
      next_intake: null
    };

    const state = env.aggregate(bootstrap, null, now);

    expect(state.nextMed.status).toBe('missing');

    const root = env.window.document.createElement('div');
    env.render(state, root, { now });

    const nextUp = root.querySelector('[data-section="next-up"]');
    expect(nextUp).not.toBeNull();
    expect(nextUp.querySelector('[data-next]')).toBeNull();
    expect(nextUp.querySelector('.wg-empty__title').textContent).toBe('Nothing scheduled');
  });

  it('renders the offline first-run state without throwing when no caches exist at all', () => {
    const now = new Date('2026-05-09T09:00:00Z');
    const bootstrap = {
      features: { medication: true, bp: false, weight: false, food: false, workout: false, health: false }
    };

    const state = env.aggregate(bootstrap, null, now);
    // Set when latestCacheTimestamp is null (no cache entry of any kind).
    state.__firstRun = true;

    const root = env.window.document.createElement('div');
    expect(() => env.render(state, root, { now, offline: true })).not.toThrow();

    // First run short-circuits the render — the shared offline state, no
    // Next up and no JS error in the process.
    expect(root.querySelector('.wg-empty__title').textContent).toBe('No cached data yet');
    expect(root.querySelector('[data-section="next-up"]')).toBeNull();
  });

  it('online path: aggregator preserves overdue + meta when cache hit reports stale', () => {
    const now = new Date('2026-05-09T09:00:00Z');
    const fetchedAt = now.getTime() - 13 * 60 * 60 * 1000; // older than 12h staleAfterMs
    const bootstrap = {
      features: { medication: true, bp: false, weight: false, food: false, workout: false, health: false },
      next_intake: {
        scheduled_at: new Date(now.getTime() - 30 * 60 * 1000).toISOString(), // overdue
        medication_names: ['Aspirin'],
        medication_ids: [1]
      },
      __next_intake_meta: { fetchedAt, isStale: true }
    };

    const state = env.aggregate(bootstrap, null, now);
    expect(state.nextMed.status).toBe('overdue');
    expect(state.nextMed.meta).toEqual({ fetchedAt, isStale: true });
  });
});
