import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');

function loadTodayEnv() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://example.test/',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  const { window } = dom;
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

  it('renders cached medication name when bootstrap fetch fails (cache populated)', () => {
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
    state.__offline = true;

    expect(state.nextMed.status).toBe('ok');
    expect(state.nextMed.value.names).toEqual(['Aspirin', 'Metformin']);
    expect(state.nextMed.meta).toEqual({ fetchedAt, isStale: false });

    const root = env.window.document.createElement('div');
    env.render(state, root, { now });

    expect(root.querySelector('.today-offline-banner')).not.toBeNull();
    const medsCard = root.querySelector('.wg-today-meds');
    expect(medsCard).not.toBeNull();
    const names = Array.from(medsCard.querySelectorAll('.wg-today-meds__name')).map((n) => n.textContent);
    expect(names).toEqual(['Aspirin', 'Metformin']);
    // Kicker should not be the offline-fallback string when value is present.
    const kicker = medsCard.querySelector('.wg-next-action-card__kicker');
    expect(kicker.textContent).not.toContain('Next dose data unavailable offline');
  });

  it('shows the offline fallback string when no next_intake is cached but the user has data offline', () => {
    const now = new Date('2026-05-09T09:00:00Z');
    // Bootstrap landed with no next_intake (e.g. backend errored) — but we
    // know the user has at least feature enabled and is offline.
    const bootstrap = {
      features: { medication: true, bp: false, weight: false, food: false, workout: false, health: false },
      next_intake: null
    };

    const state = env.aggregate(bootstrap, null, now);
    state.__offline = true;

    expect(state.nextMed.status).toBe('missing');

    const root = env.window.document.createElement('div');
    env.render(state, root, { now });

    const medsCard = root.querySelector('.wg-today-meds');
    expect(medsCard).not.toBeNull();
    const kicker = medsCard.querySelector('.wg-next-action-card__kicker');
    expect(kicker.textContent).toBe('Next dose data unavailable offline');
  });

  it('renders the explicit empty state without throwing when no caches exist at all', () => {
    const now = new Date('2026-05-09T09:00:00Z');
    const bootstrap = {
      features: { medication: true, bp: false, weight: false, food: false, workout: false, health: false }
    };

    const state = env.aggregate(bootstrap, null, now);
    // Both flags set when latestCacheTimestamp is null AND we're offline.
    state.__firstRun = true;
    state.__offline = true;

    const root = env.window.document.createElement('div');
    expect(() => env.render(state, root, { now })).not.toThrow();

    // Firstrun short-circuits the render — empty placeholder appears, no meds
    // card and no JS error in the process.
    const empty = root.querySelector('.today-empty-firstrun');
    expect(empty).not.toBeNull();
    expect(empty.textContent).toBe('Offline — reconnect to load your day');
    expect(root.querySelector('.wg-today-meds')).toBeNull();
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
