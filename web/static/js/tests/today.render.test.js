import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const EMPTY_STATE_JS = path.join(REPO_ROOT, 'web/static/js/components/empty-state.js');
const SECTION_HEADER_JS = path.join(REPO_ROOT, 'web/static/js/components/section-header.js');
const WG_ICONS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');

function loadRenderEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="today-content"></div></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(fs.readFileSync(EMPTY_STATE_JS, 'utf8') + '\nwindow.createEmptyState = createEmptyState;');
    window.eval(fs.readFileSync(SECTION_HEADER_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_ICONS_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_SPARKLINE_JS, 'utf8'));
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
            value: {
                systolicDirection: 'down', systolicDelta: -10,
                diastolicDirection: 'down', diastolicDelta: -4,
                systolicPoints: [132, 128, 125, 122]
            },
            deeplink: 'bp',
            status: 'ok'
        },
        weightLatest: {
            value: { weight: 81.6, measured_at: new Date(now.getTime() - 24 * 60 * 60000).toISOString() },
            deeplink: 'weight',
            status: 'ok'
        },
        weightTrend7d: {
            value: { direction: 'down', delta: -0.8, points: [82.4, 82.0, 81.8, 81.6] },
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

    afterEach(() => {
        env?.cleanup();
        env = null;
    });

    it('renders every canonical Wandergeek section when all data is present', () => {
        const root = env.document.getElementById('today-content');
        env.render(allPresentState(now), root, { now });

        expect(root.classList.contains('wg-today')).toBe(true);

        const title = root.querySelector('.section-header .section-title');
        expect(title).not.toBeNull();
        expect(title.textContent).toBe('Good morning');

        expect(root.querySelector('.wg-next-action-card')).not.toBeNull();
        expect(root.querySelector('.wg-vitals-grid')).not.toBeNull();
        expect(root.querySelectorAll('.wg-metric-tile').length).toBe(2);
        expect(root.querySelector('.wg-fuel-card')).not.toBeNull();
        expect(root.querySelectorAll('.wg-mini-bar').length).toBe(1);
        expect(root.querySelector('.wg-plan-grid')).not.toBeNull();
        expect(root.querySelectorAll('.wg-plan-tile').length).toBe(2);
        expect(root.querySelector('.wg-streak-card')).not.toBeNull();

        const bpTile = root.querySelector('.wg-metric-tile[data-deeplink="bp"]');
        expect(bpTile.textContent).toMatch(/122/);
        expect(bpTile.textContent).toMatch(/80/);

        const weightTile = root.querySelector('.wg-metric-tile[data-deeplink="weight"]');
        expect(weightTile.textContent).toMatch(/81\.6/);
    });

    it('omits the next-action card and still renders vitals when meds are missing', () => {
        const root = env.document.getElementById('today-content');
        env.render(allMissingState(), root, { now });

        const nextAction = root.querySelector('.wg-next-action-card');
        expect(nextAction).not.toBeNull();
        // Missing state surfaces a clear placeholder rather than hiding the card.
        expect(nextAction.textContent).toMatch(/No scheduled doses/i);
        // Vitals + fuel + plan + streak still render.
        expect(root.querySelector('.wg-vitals-grid')).not.toBeNull();
        expect(root.querySelector('.wg-fuel-card')).not.toBeNull();
        expect(root.querySelector('.wg-plan-grid')).not.toBeNull();
        expect(root.querySelector('.wg-streak-card')).not.toBeNull();
    });

    it('shows the disabled empty state when every feature is off', () => {
        const root = env.document.getElementById('today-content');
        env.render(allDisabledState(), root, { now });

        expect(root.querySelector('.wg-next-action-card')).toBeNull();
        expect(root.querySelector('.wg-vitals-grid')).toBeNull();
        expect(root.querySelector('.wg-fuel-card')).toBeNull();
        expect(root.querySelector('.wg-plan-grid')).toBeNull();
        expect(root.querySelector('.wg-streak-card')).toBeNull();

        const empty = root.querySelector('.today-empty');
        expect(empty).not.toBeNull();
        expect(empty.classList.contains('today-empty-disabled')).toBe(true);
    });

    it('renders partial state: BP present but meds disabled, weight/food/workout missing', () => {
        const root = env.document.getElementById('today-content');
        const state = allMissingState();
        state.bpLatest = {
            value: { systolic: 130, diastolic: 85, measured_at: new Date(now.getTime() - 2 * 60 * 60000).toISOString() },
            deeplink: 'bp',
            status: 'ok'
        };
        state.nextMed = { value: null, deeplink: 'meds', status: 'disabled' };
        env.render(state, root, { now });

        expect(root.querySelector('.wg-next-action-card')).toBeNull();
        const bpTile = root.querySelector('.wg-metric-tile[data-deeplink="bp"]');
        expect(bpTile).not.toBeNull();
        expect(bpTile.textContent).toMatch(/130/);
        expect(bpTile.textContent).toMatch(/85/);
    });

    it('surfaces an Overdue kicker on the next-action card when medication is overdue', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.nextMed.status = 'overdue';
        env.render(state, root, { now });

        const card = root.querySelector('.wg-next-action-card');
        expect(card).not.toBeNull();
        const kicker = card.querySelector('.wg-next-action-card__kicker');
        expect(kicker.textContent).toMatch(/Overdue/);
    });

    it('marks a stale BP latest reading by appending "stale" to the tag text', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.bpLatest.status = 'stale';
        env.render(state, root, { now });

        const bpTile = root.querySelector('.wg-metric-tile[data-deeplink="bp"]');
        const tag = bpTile.querySelector('.wg-tag');
        expect(tag).not.toBeNull();
        expect(tag.textContent.toLowerCase()).toMatch(/stale/);
    });

    it('calls onDeeplink handler when a metric tile is clicked', () => {
        const root = env.document.getElementById('today-content');
        const onDeeplink = vi.fn();
        env.render(allPresentState(now), root, { now, onDeeplink });

        root.querySelector('.wg-metric-tile[data-deeplink="bp"]').click();
        expect(onDeeplink).toHaveBeenCalledWith('bp');
    });

    it('falls back to window.switchTab when no onDeeplink handler is provided', () => {
        const root = env.document.getElementById('today-content');
        env.window.switchTab = vi.fn();
        env.render(allPresentState(now), root, {});

        root.querySelector('.wg-metric-tile[data-deeplink="weight"]').click();
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
        const firstCount = root.querySelectorAll('.wg-metric-tile').length;
        env.render(allPresentState(now), root, { now });
        const secondCount = root.querySelectorAll('.wg-metric-tile').length;
        expect(firstCount).toBe(secondCount);
    });

    it('first-run offline: render shows connect empty state with no cards when __firstRun is set', () => {
        const root = env.document.getElementById('today-content');
        const state = env.aggregate(null, null, now);
        state.__firstRun = true;
        env.render(state, root, { now });

        expect(root.querySelector('.wg-next-action-card')).toBeNull();
        expect(root.querySelector('.wg-vitals-grid')).toBeNull();
        const empty = root.querySelector('.today-empty');
        expect(empty).not.toBeNull();
        expect(empty.classList.contains('today-empty-firstrun')).toBe(true);
        expect(empty.textContent).toMatch(/Connect to load your day/i);
    });

    it('empty bootstrap without caches is NOT auto-flagged first-run by aggregate', () => {
        const state = env.aggregate({ features: {} }, {}, now);
        expect(state.__firstRun).toBeUndefined();
    });

    it('bootstrap with real data is not treated as first-run', () => {
        const bootstrap = {
            features: {},
            bp: { readings: [{ systolic: 118, diastolic: 76, measured_at: new Date(now - 60000).toISOString() }] }
        };
        const state = env.aggregate(bootstrap, {}, now);
        expect(state.__firstRun).toBeUndefined();
    });

    it('omits only disabled sections, keeps enabled ones', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.nextMed = { value: null, deeplink: 'meds', status: 'disabled' };
        state.caloriesToday = { value: null, deeplink: 'food', status: 'disabled' };
        state.caloriesTarget = { value: null, deeplink: 'food', status: 'disabled' };
        env.render(state, root, { now });

        expect(root.querySelector('.wg-next-action-card')).toBeNull();
        expect(root.querySelector('.wg-fuel-card')).toBeNull();
        expect(root.querySelector('.wg-vitals-grid')).not.toBeNull();
        expect(root.querySelector('.wg-plan-grid')).not.toBeNull();
    });

    it('renders workout scheduled_date as a human-readable label when not today', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.nextWorkout.value = {
            scheduled_date: '2026-04-20T00:00:00Z',
            scheduled_time: '18:30',
            group_name: 'Push day',
            status: 'pending',
            is_today: false
        };
        env.render(state, root, { now });

        const workoutTile = root.querySelector('.wg-plan-tile[data-deeplink="workouts"]');
        const detail = workoutTile.querySelector('.wg-plan-tile__detail');
        expect(detail.textContent).not.toContain('T00:00:00Z');
        expect(detail.textContent).toMatch(/18:30/);
    });

    it('prepends a section header with the greeting as title and a gear button', () => {
        const root = env.document.getElementById('today-content');
        env.render(allPresentState(now), root, { now });

        const header = root.querySelector('.section-header');
        expect(header).not.toBeNull();
        expect(root.firstChild).toBe(header);
        expect(header.classList.contains('no-back')).toBe(true);

        const title = header.querySelector('.section-title');
        expect(title).not.toBeNull();
        expect(title.textContent).toBe('Good morning');

        const gear = header.querySelector('.today-settings-gear');
        expect(gear).not.toBeNull();
        expect(gear.getAttribute('aria-label')).toBe('Settings');
    });

    it('uses "Today" as the header title when the greeting value is empty', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.greeting = { value: '', deeplink: null, status: 'ok' };
        env.render(state, root, { now });

        const title = root.querySelector('.section-header .section-title');
        expect(title.textContent).toBe('Today');
    });

    it('invokes onSettings when the gear is clicked', () => {
        const root = env.document.getElementById('today-content');
        const onSettings = vi.fn();
        env.render(allPresentState(now), root, { now, onSettings });

        root.querySelector('.today-settings-gear').click();
        expect(onSettings).toHaveBeenCalledTimes(1);
    });

    it('falls back to window.switchTab("settings") when no onSettings handler is provided', () => {
        const root = env.document.getElementById('today-content');
        env.window.switchTab = vi.fn();
        env.render(allPresentState(now), root, { now });

        root.querySelector('.today-settings-gear').click();
        expect(env.window.switchTab).toHaveBeenCalledWith('settings');
    });

    it('renders exactly one section header on Today (no back button)', () => {
        const root = env.document.getElementById('today-content');
        env.render(allPresentState(now), root, { now });
        env.render(allPresentState(now), root, { now });

        expect(root.querySelectorAll('.section-header').length).toBe(1);
        const header = root.querySelector('.section-header');
        expect(header.classList.contains('no-back')).toBe(true);
    });

    it('renders offline banner when state.__offline is set and not first-run', () => {
        const root = env.document.getElementById('today-content');
        const state = allPresentState(now);
        state.__offline = true;
        env.render(state, root, { now });

        const banner = root.querySelector('.today-offline-banner');
        expect(banner).not.toBeNull();
        expect(banner.textContent).toMatch(/offline/i);
    });

    it('first-run while offline shows a single combined message, no separate banner', () => {
        const root = env.document.getElementById('today-content');
        const state = env.aggregate(null, null, now);
        state.__firstRun = true;
        state.__offline = true;
        env.render(state, root, { now });

        expect(root.querySelector('.today-offline-banner')).toBeNull();
        const empty = root.querySelector('.today-empty-firstrun');
        expect(empty).not.toBeNull();
        expect(empty.textContent.toLowerCase()).toMatch(/offline|reconnect/);
    });
});
