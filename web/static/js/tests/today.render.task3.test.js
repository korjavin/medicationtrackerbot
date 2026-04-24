// Task 3 explicit assertions: shortcut row has 3 buttons with correct icons,
// metric grid has exactly BP + Weight (no SpO2/HR), meds card renders at the
// bottom.
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
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="today-content"></div></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(fs.readFileSync(EMPTY_STATE_JS, 'utf8') + '\nwindow.createEmptyState = createEmptyState;');
    window.eval(fs.readFileSync(WG_ICONS_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_SPARKLINE_JS, 'utf8'));
    window.eval(fs.readFileSync(TODAY_JS, 'utf8'));
    return {
        window,
        document: window.document,
        render: window.TodayDashboard.renderToday,
        cleanup: () => dom.window.close()
    };
}

function state(now) {
    return {
        greeting: { value: 'Good morning', deeplink: null, status: 'ok' },
        nextMed: {
            value: { scheduledAt: new Date(now.getTime() + 90 * 60000).toISOString(), names: ['Aspirin', 'Metformin'] },
            deeplink: 'meds',
            status: 'ok'
        },
        bpLatest: {
            value: { systolic: 118, diastolic: 76, measured_at: new Date(now.getTime() - 30 * 60000).toISOString() },
            deeplink: 'bp',
            status: 'ok'
        },
        bpTrend7d: { value: { systolicDirection: 'flat', systolicDelta: 0, diastolicDirection: 'flat', diastolicDelta: 0, systolicPoints: [118, 119, 118] }, deeplink: 'bp', status: 'ok' },
        weightLatest: {
            value: { weight: 80.2, measured_at: new Date(now.getTime() - 20 * 60 * 60000).toISOString() },
            deeplink: 'weight',
            status: 'ok'
        },
        weightTrend7d: { value: { direction: 'flat', delta: 0, points: [80.1, 80.2, 80.2] }, deeplink: 'weight', status: 'ok' },
        caloriesToday: { value: 1400, deeplink: 'food', status: 'ok' },
        caloriesTarget: { value: 2000, deeplink: 'food', status: 'ok' },
        macrosToday: { value: { protein: 90, carbs: 160, fat: 50 }, deeplink: 'food', status: 'ok' },
        macrosTarget: { value: { protein: 150, carbs: 220, fat: 65 }, deeplink: 'food', status: 'ok' },
        nextWorkout: {
            value: { scheduled_date: '2026-04-19', scheduled_time: '18:00', group_name: 'Pull day', is_today: true },
            deeplink: 'workouts',
            status: 'ok'
        },
        sleepLastNight: { value: { hours: 7.4, day: '2026-04-18' }, deeplink: 'health', status: 'ok' }
    };
}

describe('Today DOM — Task 3 mockup alignment', () => {
    let env;
    const now = new Date('2026-04-19T09:00:00Z');

    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env?.cleanup(); env = null; });

    it('shortcut row has exactly 3 buttons labelled Log food / Add BP / Add weight', () => {
        const root = env.document.getElementById('today-content');
        env.render(state(now), root, { now });

        const row = root.querySelector('.wg-today-shortcuts');
        expect(row).not.toBeNull();
        const tiles = row.querySelectorAll('.wg-shortcut-tile');
        expect(tiles.length).toBe(3);
        const labels = Array.from(tiles).map((t) => t.querySelector('.wg-shortcut-tile__label').textContent);
        expect(labels).toEqual(['Log food', 'Add BP', 'Add weight']);
    });

    it('shortcut tiles render SVG icons inside the icon slot', () => {
        const root = env.document.getElementById('today-content');
        env.render(state(now), root, { now });
        const tiles = root.querySelectorAll('.wg-shortcut-tile');
        for (const tile of tiles) {
            const icon = tile.querySelector('.wg-shortcut-tile__icon svg');
            expect(icon).not.toBeNull();
        }
    });

    it('metric grid contains exactly BP and Weight tiles (no SpO2 / HR)', () => {
        const root = env.document.getElementById('today-content');
        env.render(state(now), root, { now });

        const grid = root.querySelector('.wg-vitals-grid.wg-today-metrics');
        expect(grid).not.toBeNull();
        const tiles = grid.querySelectorAll('.wg-metric-tile');
        expect(tiles.length).toBe(2);
        const deeplinks = Array.from(tiles).map((t) => t.getAttribute('data-deeplink'));
        expect(deeplinks.sort()).toEqual(['bp', 'weight']);
        expect(grid.querySelector('[data-deeplink="spo2"]')).toBeNull();
        expect(grid.querySelector('[data-deeplink="hr"]')).toBeNull();
    });

    it('meds card renders as the final element of the Today stack', () => {
        const root = env.document.getElementById('today-content');
        env.render(state(now), root, { now });

        const meds = root.querySelector('.wg-today-meds');
        expect(meds).not.toBeNull();
        // Meds card is the last child.
        expect(root.lastElementChild).toBe(meds);
        // Meds card has the list of scheduled meds underneath the head.
        const rows = meds.querySelectorAll('.wg-today-meds__row');
        expect(rows.length).toBe(2);
        expect(rows[0].querySelector('.wg-today-meds__name').textContent).toBe('Aspirin');
        expect(rows[1].querySelector('.wg-today-meds__name').textContent).toBe('Metformin');
    });
});
