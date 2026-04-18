import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const EMPTY_STATE_JS = path.join(REPO_ROOT, 'web/static/js/components/empty-state.js');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');

function loadRenderEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="today-content"></div></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(fs.readFileSync(EMPTY_STATE_JS, 'utf8') + '\nwindow.createEmptyState = createEmptyState;');
    window.eval(fs.readFileSync(TODAY_JS, 'utf8'));
    return {
        window,
        document: window.document,
        aggregate: window.TodayDashboard.aggregateToday,
        render: window.TodayDashboard.renderToday,
        cleanup: () => dom.window.close()
    };
}

function allPresentState(now) {
    return {
        greeting: { value: 'Good morning', deeplink: null, status: 'ok' },
        nextMed: {
            value: { scheduledAt: new Date(now.getTime() + 30 * 60000).toISOString(), names: ['Aspirin'] },
            deeplink: 'meds',
            status: 'ok'
        },
        bpLatest: {
            value: { systolic: 122, diastolic: 80, measured_at: new Date(now.getTime() - 3 * 60 * 60000).toISOString() },
            deeplink: 'bp',
            status: 'ok'
        },
        bpTrend7d: {
            value: { systolicDirection: 'down', systolicDelta: -10, diastolicDirection: 'down', diastolicDelta: -4 },
            deeplink: 'bp',
            status: 'ok'
        },
        weightLatest: {
            value: { weight: 81.6, measured_at: new Date(now.getTime() - 24 * 60 * 60000).toISOString() },
            deeplink: 'weight',
            status: 'ok'
        },
        weightTrend7d: {
            value: { direction: 'down', delta: -0.8 },
            deeplink: 'weight',
            status: 'ok'
        },
        caloriesToday: { value: 1200, deeplink: 'food', status: 'ok' },
        caloriesTarget: { value: 2200, deeplink: 'food', status: 'ok' },
        nextWorkout: {
            value: { scheduled_date: '2026-04-20', scheduled_time: '18:30', group_name: 'Push day', status: 'pending', is_today: false },
            deeplink: 'workouts',
            status: 'ok'
        },
        sleepLastNight: { value: { hours: 7.8, day: '2026-04-19' }, deeplink: 'health', status: 'ok' }
    };
}

function allMissingState() {
    return {
        greeting: { value: 'Good morning', deeplink: null, status: 'ok' },
        nextMed: { value: null, deeplink: 'meds', status: 'missing' },
        bpLatest: { value: null, deeplink: 'bp', status: 'missing' },
        bpTrend7d: { value: null, deeplink: 'bp', status: 'missing' },
        weightLatest: { value: null, deeplink: 'weight', status: 'missing' },
        weightTrend7d: { value: null, deeplink: 'weight', status: 'missing' },
        caloriesToday: { value: 0, deeplink: 'food', status: 'missing' },
        caloriesTarget: { value: null, deeplink: 'food', status: 'missing' },
        nextWorkout: { value: null, deeplink: 'workouts', status: 'missing' },
        sleepLastNight: { value: null, deeplink: 'health', status: 'missing' }
    };
}

function allDisabledState() {
    return {
        greeting: { value: 'Good evening', deeplink: null, status: 'ok' },
        nextMed: { value: null, deeplink: 'meds', status: 'disabled' },
        bpLatest: { value: null, deeplink: 'bp', status: 'disabled' },
        bpTrend7d: { value: null, deeplink: 'bp', status: 'disabled' },
        weightLatest: { value: null, deeplink: 'weight', status: 'disabled' },
        weightTrend7d: { value: null, deeplink: 'weight', status: 'disabled' },
        caloriesToday: { value: null, deeplink: 'food', status: 'disabled' },
        caloriesTarget: { value: null, deeplink: 'food', status: 'disabled' },
        nextWorkout: { value: null, deeplink: 'workouts', status: 'disabled' },
        sleepLastNight: { value: null, deeplink: 'health', status: 'disabled' }
    };
}

describe('TodayDashboard.renderToday', () => {
    let env;
    const now = new Date('2026-04-19T09:00:00Z');

    beforeEach(() => {
        env = loadRenderEnv();
    });

    it('renders a card for each populated metric in all-present state', () => {
        const root = env.document.getElementById('today-content');
        env.render(allPresentState(now), root, { now });

        const greeting = root.querySelector('.today-greeting');
        expect(greeting).not.toBeNull();
        expect(greeting.textContent).toBe('Good morning');

        const cards = root.querySelectorAll('.today-card');
        expect(cards.length).toBe(6);

        const deeplinks = Array.from(cards).map((c) => c.getAttribute('data-deeplink'));
        expect(deeplinks).toEqual(['meds', 'bp', 'weight', 'food', 'workouts', 'health']);

        const bpCard = root.querySelector('.today-card[data-deeplink="bp"]');
        expect(bpCard.textContent).toMatch(/122\/80/);
        expect(bpCard.querySelector('.today-trend-arrow')).not.toBeNull();

        const weightCard = root.querySelector('.today-card[data-deeplink="weight"]');
        expect(weightCard.textContent).toMatch(/81\.6 kg/);
        expect(weightCard.querySelector('.today-trend-down')).not.toBeNull();
    });

    it('renders empty-state messages for all missing cards', () => {
        const root = env.document.getElementById('today-content');
        env.render(allMissingState(), root, { now });

        const cards = root.querySelectorAll('.today-card');
        expect(cards.length).toBe(6);

        for (const card of cards) {
            expect(card.classList.contains('today-card-missing')).toBe(true);
        }

        // Cards with no partial data should use the empty-state primitive.
        // Calories has its own zero-state ("0 kcal — no entries yet") which
        // is more informative than a generic empty state.
        const nonCaloriesCards = root.querySelectorAll(
            '.today-card:not([data-deeplink="food"])'
        );
        for (const card of nonCaloriesCards) {
            expect(card.querySelector('.today-card-empty')).not.toBeNull();
        }
    });

    it('omits all cards when every feature is disabled, showing the connect empty state', () => {
        const root = env.document.getElementById('today-content');
        env.render(allDisabledState(), root, { now });

        expect(root.querySelectorAll('.today-card').length).toBe(0);
        expect(root.querySelector('.today-card-grid')).toBeNull();
        expect(root.querySelector('.today-empty')).not.toBeNull();
    });

    it('renders partial state: BP present but weight/food/workout missing, meds disabled', () => {
        const root = env.document.getElementById('today-content');
        const state = allMissingState();
        state.bpLatest = {
            value: { systolic: 130, diastolic: 85, measured_at: new Date(now.getTime() - 2 * 60 * 60000).toISOString() },
            deeplink: 'bp',
            status: 'ok'
        };
        state.nextMed = { value: null, deeplink: 'meds', status: 'disabled' };
        env.render(state, root, { now });

        const cards = root.querySelectorAll('.today-card');
        const deeplinks = Array.from(cards).map((c) => c.getAttribute('data-deeplink'));
        expect(deeplinks).not.toContain('meds');
        expect(deeplinks).toContain('bp');

        const bpCard = root.querySelector('.today-card[data-deeplink="bp"]');
        expect(bpCard.classList.contains('today-card-ok')).toBe(true);
        expect(bpCard.textContent).toMatch(/130\/85/);
    });

    it('marks overdue medication with a warning badge and warning class', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.nextMed.status = 'overdue';
        env.render(state, root, { now });

        const medCard = root.querySelector('.today-card[data-deeplink="meds"]');
        expect(medCard.classList.contains('today-card-warning')).toBe(true);
        expect(medCard.querySelector('.today-card-badge-warning')).not.toBeNull();
    });

    it('marks stale BP latest reading with a stale badge', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.bpLatest.status = 'stale';
        env.render(state, root, { now });

        const bpCard = root.querySelector('.today-card[data-deeplink="bp"]');
        expect(bpCard.classList.contains('today-card-stale')).toBe(true);
        expect(bpCard.querySelector('.today-card-badge-stale')).not.toBeNull();
    });

    it('calls onDeeplink handler when a card is clicked', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        env.render(allPresentState(now), root, { now, onDeeplink });

        root.querySelector('.today-card[data-deeplink="bp"]').click();
        expect(onDeeplink).toHaveBeenCalledWith('bp');
    });

    it('falls back to window.switchTab when no onDeeplink handler is provided', () => {
        const root = env.document.getElementById('today-content');
        env.window.switchTab = vi.fn();
        env.render(allPresentState(now), root, {});

        root.querySelector('.today-card[data-deeplink="weight"]').click();
        expect(env.window.switchTab).toHaveBeenCalledWith('weight');
    });

    it('never sets inline style attributes on rendered elements', () => {
        const root = env.document.getElementById('today-content');
        env.render(allPresentState(now), root, { now });

        const withStyle = root.querySelectorAll('[style]');
        expect(withStyle.length).toBe(0);
    });

    it('clears previous content on re-render to avoid duplicates', () => {
        const root = env.document.getElementById('today-content');
        env.render(allPresentState(now), root, { now });
        const firstCount = root.querySelectorAll('.today-card').length;
        env.render(allPresentState(now), root, { now });
        const secondCount = root.querySelectorAll('.today-card').length;
        expect(firstCount).toBe(secondCount);
    });

    it('first-run offline: aggregate flags __firstRun and render shows connect empty state with no cards', () => {
        const root = env.document.getElementById('today-content');
        const state = env.aggregate(null, null, now);
        expect(state.__firstRun).toBe(true);
        env.render(state, root, { now });

        expect(root.querySelectorAll('.today-card').length).toBe(0);
        expect(root.querySelector('.today-card-grid')).toBeNull();
        const empty = root.querySelector('.today-empty');
        expect(empty).not.toBeNull();
        expect(empty.classList.contains('today-empty-firstrun')).toBe(true);
        expect(empty.textContent).toMatch(/Connect to load your day/i);
    });

    it('first-run offline: treats empty bootstrap with no caches as first-run', () => {
        const root = env.document.getElementById('today-content');
        const state = env.aggregate({ features: {} }, {}, now);
        expect(state.__firstRun).toBe(true);
        env.render(state, root, { now });

        expect(root.querySelectorAll('.today-card').length).toBe(0);
        expect(root.querySelector('.today-empty-firstrun')).not.toBeNull();
    });

    it('first-run offline: bootstrap with any data section (e.g. settings) is NOT treated as first-run', () => {
        const state = env.aggregate({ features: {}, settings: { food_targets: null } }, {}, now);
        expect(state.__firstRun).toBeUndefined();
    });

    it('disabled-features: omits only disabled cards, keeps enabled ones', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.nextMed = { value: null, deeplink: 'meds', status: 'disabled' };
        state.caloriesToday = { value: null, deeplink: 'food', status: 'disabled' };
        state.caloriesTarget = { value: null, deeplink: 'food', status: 'disabled' };
        env.render(state, root, { now });

        const deeplinks = Array.from(root.querySelectorAll('.today-card'))
            .map((c) => c.getAttribute('data-deeplink'));
        expect(deeplinks).not.toContain('meds');
        expect(deeplinks).not.toContain('food');
        expect(deeplinks).toContain('bp');
        expect(deeplinks).toContain('weight');
        expect(deeplinks).toContain('workouts');
        expect(deeplinks).toContain('health');
    });

    it('disabled-features: when every feature disabled, shows a friendly empty state and no cards', () => {
        const root = env.document.getElementById('today-content');
        env.render(allDisabledState(), root, { now });

        expect(root.querySelectorAll('.today-card').length).toBe(0);
        const empty = root.querySelector('.today-empty');
        expect(empty).not.toBeNull();
        expect(empty.classList.contains('today-empty-disabled')).toBe(true);
    });

    it('overdue-med: applies --color-warning border via today-card-warning class and shows overdue label', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.nextMed.status = 'overdue';
        env.render(state, root, { now });

        const medCard = root.querySelector('.today-card[data-deeplink="meds"]');
        expect(medCard.classList.contains('today-card-warning')).toBe(true);
        const badge = medCard.querySelector('.today-card-badge-warning');
        expect(badge).not.toBeNull();
        expect(badge.textContent.toLowerCase()).toMatch(/overdue/);
    });
});
