// Task 5 of local-first read-resilience — Today must mount the
// wg-stale-badge chip in its section header, fed by the worst-case
// fetchedAt across the caches that feed the screen. The chip is
// suppressed during the firstRun empty-state.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const EMPTY_STATE_JS = path.join(REPO_ROOT, 'web/static/js/components/empty-state.js');
const WG_ICONS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');
const WG_STALE_BADGE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-stale-badge.js');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(fs.readFileSync(EMPTY_STATE_JS, 'utf8') + '\nwindow.createEmptyState = createEmptyState;');
    window.eval(fs.readFileSync(WG_ICONS_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_SPARKLINE_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_STALE_BADGE_JS, 'utf8'));
    window.eval(fs.readFileSync(TODAY_JS, 'utf8'));
    return {
        window,
        document: window.document,
        aggregate: window.TodayDashboard.aggregateToday,
        render: window.TodayDashboard.renderToday,
        cleanup: () => dom.window.close()
    };
}

describe('Today section-header stale badge', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('renders Updated Nm ago using the oldest fetchedAt across caches (online)', () => {
        const now = new Date('2026-05-09T12:00:00Z');
        const fetchedAt = now.getTime() - 5 * 60 * 1000; // 5 min old (oldest cache ts)
        const bootstrap = {
            features: { medication: true, bp: false, weight: false, food: false, workout: false, health: false },
            next_intake: {
                scheduled_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
                medication_names: ['Aspirin'],
                medication_ids: [11]
            },
            __next_intake_meta: { fetchedAt, isStale: false }
        };
        const state = env.aggregate(bootstrap, null, now);
        state.__fetchedAt = fetchedAt; // app.js wires this from oldestCacheTimestamp

        const root = env.document.createElement('div');
        env.render(state, root, { now });

        const row = root.querySelector('.today-stale-badge-row');
        expect(row).not.toBeNull();
        const badge = row.querySelector('.wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('Updated 5m ago');
        expect(badge.classList.contains('wg-stale-badge--neutral')).toBe(true);
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(false);
        // The Today header chip must come before the offline banner so it is
        // visible above the rest of the dashboard.
        const banner = root.querySelector('.today-offline-banner');
        expect(banner).toBeNull(); // online path → no banner
    });

    it('renders Offline · Nh old in warning tone when offline with a stale cache', () => {
        const now = new Date('2026-05-09T12:00:00Z');
        const fetchedAt = now.getTime() - 3 * 60 * 60 * 1000; // 3h old
        const bootstrap = {
            features: { medication: true, bp: false, weight: false, food: false, workout: false, health: false },
            next_intake: {
                scheduled_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
                medication_names: ['Aspirin'],
                medication_ids: [11]
            },
            __next_intake_meta: { fetchedAt, isStale: true }
        };
        const state = env.aggregate(bootstrap, null, now);
        state.__fetchedAt = fetchedAt;
        state.__offline = true;

        const root = env.document.createElement('div');
        env.render(state, root, { now });

        const badge = root.querySelector('.today-stale-badge-row .wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('Offline · 3h old');
        expect(badge.classList.contains('wg-stale-badge--warning')).toBe(true);
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
        // Existing offline banner is preserved alongside the new chip.
        expect(root.querySelector('.today-offline-banner')).not.toBeNull();
    });

    it('omits the chip on the firstRun empty-state', () => {
        const now = new Date('2026-05-09T12:00:00Z');
        const bootstrap = {
            features: { medication: true, bp: false, weight: false, food: false, workout: false, health: false }
        };
        const state = env.aggregate(bootstrap, null, now);
        state.__firstRun = true;
        state.__offline = true;

        const root = env.document.createElement('div');
        env.render(state, root, { now });

        expect(root.querySelector('.today-stale-badge-row')).toBeNull();
        // FirstRun placeholder still rendered.
        expect(root.querySelector('.today-empty-firstrun')).not.toBeNull();
    });

    it('shows Offline · Nm old when offline with a fresh (sub-stale-threshold) cache', () => {
        // Regression: the badge tone used to gate on state.__offline (offline+stale)
        // so an offline session with a fresh cache rendered the neutral "Updated 5m ago"
        // instead of the documented "Offline · 5m old". The Today badge must surface
        // the raw navigator-offline signal independently of the offline-stale banner.
        const now = new Date('2026-05-09T12:00:00Z');
        const fetchedAt = now.getTime() - 5 * 60 * 1000; // 5 min old, well within the 1h stale threshold
        const bootstrap = {
            features: { medication: true, bp: false, weight: false, food: false, workout: false, health: false },
            next_intake: {
                scheduled_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
                medication_names: ['Aspirin'],
                medication_ids: [11]
            }
        };
        const state = env.aggregate(bootstrap, null, now);
        state.__fetchedAt = fetchedAt;
        state.__navigatorOffline = true; // raw offline flag without offline-stale gating

        const root = env.document.createElement('div');
        env.render(state, root, { now });

        const badge = root.querySelector('.today-stale-badge-row .wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('Offline · 5m old');
        expect(badge.classList.contains('wg-stale-badge--warning')).toBe(true);
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
    });

    it('falls back to "Offline · no cache" when offline and no fetchedAt was tracked', () => {
        const now = new Date('2026-05-09T12:00:00Z');
        const bootstrap = {
            features: { medication: true, bp: false, weight: false, food: false, workout: false, health: false }
        };
        const state = env.aggregate(bootstrap, null, now);
        state.__offline = true; // offline but no caches → __fetchedAt absent

        const root = env.document.createElement('div');
        env.render(state, root, { now });

        const badge = root.querySelector('.today-stale-badge-row .wg-stale-badge');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('Offline · no cache');
        expect(badge.classList.contains('wg-stale-badge--offline')).toBe(true);
    });
});
