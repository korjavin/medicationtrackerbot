// Task 6: Today screen exposes a "Photo meal" shortcut tile that opens the
// food-photo picker via window.FoodActions.triggerPhotoPicker without first
// navigating to the Food section.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('Today shortcut row — Photo meal tile', () => {
    let env;
    const now = new Date('2026-05-09T09:00:00Z');

    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env?.cleanup(); env = null; });

    it('renders a Photo meal tile when food is enabled', () => {
        const root = env.document.getElementById('today-content');
        env.render(baseState(now), root, { now });
        const tiles = root.querySelectorAll('.wg-shortcut-tile');
        const labels = Array.from(tiles).map((t) => t.querySelector('.wg-shortcut-tile__label').textContent);
        expect(labels).toContain('Photo meal');
    });

    it('Photo meal tile sits immediately after Log food', () => {
        const root = env.document.getElementById('today-content');
        env.render(baseState(now), root, { now });
        const tiles = Array.from(root.querySelectorAll('.wg-shortcut-tile'));
        const labels = tiles.map((t) => t.querySelector('.wg-shortcut-tile__label').textContent);
        const logFoodIdx = labels.indexOf('Log food');
        const photoIdx = labels.indexOf('Photo meal');
        expect(logFoodIdx).toBeGreaterThanOrEqual(0);
        expect(photoIdx).toBe(logFoodIdx + 1);
    });

    it('Photo meal tile renders the camera icon', () => {
        const root = env.document.getElementById('today-content');
        env.render(baseState(now), root, { now });
        const photoTile = Array.from(root.querySelectorAll('.wg-shortcut-tile'))
            .find((t) => t.querySelector('.wg-shortcut-tile__label').textContent === 'Photo meal');
        expect(photoTile).toBeDefined();
        const icon = photoTile.querySelector('.wg-shortcut-tile__icon svg');
        expect(icon).not.toBeNull();
        expect(icon.getAttribute('data-wg-icon')).toBe('camera');
    });

    it('clicking Photo meal invokes the onPhotoMeal handler when provided', () => {
        const root = env.document.getElementById('today-content');
        const onPhotoMeal = vi.fn();
        env.render(baseState(now), root, { now, onPhotoMeal });
        const photoTile = Array.from(root.querySelectorAll('.wg-shortcut-tile'))
            .find((t) => t.querySelector('.wg-shortcut-tile__label').textContent === 'Photo meal');
        photoTile.click();
        expect(onPhotoMeal).toHaveBeenCalledTimes(1);
    });

    it('clicking Photo meal falls back to window.FoodActions.triggerPhotoPicker when no handler given', () => {
        const root = env.document.getElementById('today-content');
        env.window.FoodActions = { triggerPhotoPicker: vi.fn() };
        env.render(baseState(now), root, { now });
        const photoTile = Array.from(root.querySelectorAll('.wg-shortcut-tile'))
            .find((t) => t.querySelector('.wg-shortcut-tile__label').textContent === 'Photo meal');
        photoTile.click();
        expect(env.window.FoodActions.triggerPhotoPicker).toHaveBeenCalledTimes(1);
    });

    it('omits both Log food and Photo meal when the food feature is disabled', () => {
        const root = env.document.getElementById('today-content');
        const state = baseState(now);
        state.caloriesTarget.status = 'disabled';
        env.render(state, root, { now });
        const labels = Array.from(root.querySelectorAll('.wg-shortcut-tile'))
            .map((t) => t.querySelector('.wg-shortcut-tile__label').textContent);
        expect(labels).not.toContain('Log food');
        expect(labels).not.toContain('Photo meal');
    });
});
