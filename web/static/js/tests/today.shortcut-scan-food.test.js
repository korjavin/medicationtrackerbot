// Today screen exposes a "Scan food" shortcut tile that opens the Add Food
// modal and immediately launches the barcode scanner overlay, collapsing the
// 3-tap food-by-barcode flow to a single tap.
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

function findTile(root, label) {
    return Array.from(root.querySelectorAll('.wg-shortcut-tile'))
        .find((t) => t.querySelector('.wg-shortcut-tile__label').textContent === label);
}

describe('Today shortcut row — Scan food tile', () => {
    let env;
    const now = new Date('2026-05-17T09:00:00Z');

    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env?.cleanup(); env = null; });

    it('renders a Scan food tile when food is enabled', () => {
        const root = env.document.getElementById('today-content');
        env.render(baseState(now), root, { now });
        const labels = Array.from(root.querySelectorAll('.wg-shortcut-tile'))
            .map((t) => t.querySelector('.wg-shortcut-tile__label').textContent);
        expect(labels).toContain('Scan food');
    });

    it('Scan food tile sits between Log food and Photo meal', () => {
        const root = env.document.getElementById('today-content');
        env.render(baseState(now), root, { now });
        const labels = Array.from(root.querySelectorAll('.wg-shortcut-tile'))
            .map((t) => t.querySelector('.wg-shortcut-tile__label').textContent);
        const logFoodIdx = labels.indexOf('Log food');
        const scanIdx = labels.indexOf('Scan food');
        const photoIdx = labels.indexOf('Photo meal');
        expect(logFoodIdx).toBeGreaterThanOrEqual(0);
        expect(scanIdx).toBe(logFoodIdx + 1);
        expect(photoIdx).toBe(scanIdx + 1);
    });

    it('Scan food tile renders the barcode icon', () => {
        const root = env.document.getElementById('today-content');
        env.render(baseState(now), root, { now });
        const tile = findTile(root, 'Scan food');
        expect(tile).toBeDefined();
        const icon = tile.querySelector('.wg-shortcut-tile__icon svg');
        expect(icon).not.toBeNull();
        expect(icon.getAttribute('data-wg-icon')).toBe('barcode');
    });

    it('clicking Scan food invokes the onScanFood handler when provided', () => {
        const root = env.document.getElementById('today-content');
        const onScanFood = vi.fn();
        env.render(baseState(now), root, { now, onScanFood });
        findTile(root, 'Scan food').click();
        expect(onScanFood).toHaveBeenCalledTimes(1);
    });

    it('default handler opens Add Food modal then launches FoodScanner', () => {
        const root = env.document.getElementById('today-content');
        env.window.FoodLog = { openAdd: vi.fn() };
        env.window.FoodScanner = { openFoodScannerModal: vi.fn() };
        env.render(baseState(now), root, { now });
        findTile(root, 'Scan food').click();
        expect(env.window.FoodLog.openAdd).toHaveBeenCalledTimes(1);
        expect(env.window.FoodScanner.openFoodScannerModal).toHaveBeenCalledTimes(1);
    });

    it('default handler falls back to ModalManager.foodScanner.open when FoodScanner is missing', () => {
        const root = env.document.getElementById('today-content');
        env.window.FoodLog = { openAdd: vi.fn() };
        env.window.ModalManager = { foodScanner: { open: vi.fn() } };
        env.render(baseState(now), root, { now });
        findTile(root, 'Scan food').click();
        expect(env.window.FoodLog.openAdd).toHaveBeenCalledTimes(1);
        expect(env.window.ModalManager.foodScanner.open).toHaveBeenCalledTimes(1);
    });

    it('default handler is a safe no-op when food globals are not loaded', () => {
        const root = env.document.getElementById('today-content');
        env.render(baseState(now), root, { now });
        expect(() => findTile(root, 'Scan food').click()).not.toThrow();
    });

    it('omits Scan food when the food feature is disabled', () => {
        const root = env.document.getElementById('today-content');
        const state = baseState(now);
        state.caloriesTarget.status = 'disabled';
        env.render(state, root, { now });
        const labels = Array.from(root.querySelectorAll('.wg-shortcut-tile'))
            .map((t) => t.querySelector('.wg-shortcut-tile__label').textContent);
        expect(labels).not.toContain('Scan food');
    });
});
