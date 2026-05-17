// Today shortcut tiles are split into two rows: food (Log food, Scan food,
// Photo meal) and vitals (Add BP, Add weight). The single 5-tile row was too
// dense on phones — each tile got squeezed and the labels wrapped awkwardly.
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

function baseState(now) {
    return {
        greeting: { value: 'Good morning', deeplink: null, status: 'ok' },
        nextMed: { value: null, deeplink: 'meds', status: 'missing' },
        bpLatest: {
            value: { systolic: 120, diastolic: 78, measured_at: new Date(now.getTime() - 60 * 60000).toISOString() },
            deeplink: 'bp',
            status: 'ok'
        },
        bpTrend7d: { value: null, deeplink: 'bp', status: 'missing' },
        weightLatest: {
            value: { weight: 75.0, measured_at: new Date(now.getTime() - 24 * 60 * 60000).toISOString() },
            deeplink: 'weight',
            status: 'ok'
        },
        weightTrend7d: { value: null, deeplink: 'weight', status: 'missing' },
        caloriesToday: { value: 800, deeplink: 'food', status: 'ok' },
        caloriesTarget: { value: 2000, deeplink: 'food', status: 'ok' },
        macrosToday: { value: { protein: 40, carbs: 80, fat: 30 }, deeplink: 'food', status: 'ok' },
        macrosTarget: { value: { protein: 120, carbs: 200, fat: 60 }, deeplink: 'food', status: 'ok' },
        nextWorkout: { value: null, deeplink: 'workouts', status: 'missing' },
        sleepLastNight: { value: null, deeplink: 'health', status: 'missing' }
    };
}

function tileLabels(row) {
    return Array.from(row.querySelectorAll('.wg-shortcut-tile'))
        .map((t) => t.querySelector('.wg-shortcut-tile__label').textContent);
}

describe('Today shortcut rows — food + vitals split', () => {
    let env;
    const now = new Date('2026-05-17T12:00:00Z');

    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env?.cleanup(); env = null; });

    it('renders two distinct shortcut rows when food + BP + weight are all enabled', () => {
        const root = env.document.getElementById('today-content');
        env.render(baseState(now), root, { now });
        const rows = root.querySelectorAll('.wg-today-shortcuts');
        expect(rows.length).toBe(2);
        expect(root.querySelector('.wg-today-shortcuts--food')).not.toBeNull();
        expect(root.querySelector('.wg-today-shortcuts--vitals')).not.toBeNull();
    });

    it('food row contains exactly Log food, Scan food, Photo meal in order', () => {
        const root = env.document.getElementById('today-content');
        env.render(baseState(now), root, { now });
        const foodRow = root.querySelector('.wg-today-shortcuts--food');
        expect(tileLabels(foodRow)).toEqual(['Log food', 'Scan food', 'Photo meal']);
    });

    it('vitals row contains exactly Add BP, Add weight in order', () => {
        const root = env.document.getElementById('today-content');
        env.render(baseState(now), root, { now });
        const vitalsRow = root.querySelector('.wg-today-shortcuts--vitals');
        expect(tileLabels(vitalsRow)).toEqual(['Add BP', 'Add weight']);
    });

    it('food row appears before vitals row in DOM order', () => {
        const root = env.document.getElementById('today-content');
        env.render(baseState(now), root, { now });
        const rows = Array.from(root.querySelectorAll('.wg-today-shortcuts'));
        expect(rows[0].classList.contains('wg-today-shortcuts--food')).toBe(true);
        expect(rows[1].classList.contains('wg-today-shortcuts--vitals')).toBe(true);
    });

    it('omits the food row entirely when the food feature is disabled', () => {
        const root = env.document.getElementById('today-content');
        const state = baseState(now);
        state.caloriesTarget.status = 'disabled';
        env.render(state, root, { now });
        expect(root.querySelector('.wg-today-shortcuts--food')).toBeNull();
        expect(root.querySelector('.wg-today-shortcuts--vitals')).not.toBeNull();
    });

    it('omits the vitals row entirely when both BP and weight are disabled', () => {
        const root = env.document.getElementById('today-content');
        const state = baseState(now);
        state.bpLatest.status = 'disabled';
        state.weightLatest.status = 'disabled';
        env.render(state, root, { now });
        expect(root.querySelector('.wg-today-shortcuts--food')).not.toBeNull();
        expect(root.querySelector('.wg-today-shortcuts--vitals')).toBeNull();
    });

    it('vitals row shows only Add weight when BP alone is disabled', () => {
        const root = env.document.getElementById('today-content');
        const state = baseState(now);
        state.bpLatest.status = 'disabled';
        env.render(state, root, { now });
        const vitalsRow = root.querySelector('.wg-today-shortcuts--vitals');
        expect(tileLabels(vitalsRow)).toEqual(['Add weight']);
    });
});
