// Today v2 behaviour (kit screens-today.html, med-xso6.13): the Next up list
// and its single sun action, the Log sheet, the first-run / offline / cold
// start states (T4–T6) and the Goal Line track (docs/gamification.md §0.3.2).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDataStoreEnv } from './helpers/data-store-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const EMPTY_STATE_JS = path.join(REPO_ROOT, 'web/static/js/components/empty-state.js');
const WG_ICONS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const WG_CHIP_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-chip.js');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');
const CACHE_KEYS_JS = path.join(REPO_ROOT, 'web/static/js/core/cache-keys.js');

function loadRenderEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="today-content"></div></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(fs.readFileSync(EMPTY_STATE_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_ICONS_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_CHIP_JS, 'utf8'));
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

// Local wall-clock dates keep "today" independent of the CI zone.
const NOW = new Date(2026, 3, 20, 14, 0);
const at = (h, m, dayOffset = 0) => new Date(2026, 3, 20 + dayOffset, h, m).toISOString();

function baseState() {
    return {
        greeting: { value: 'Good afternoon', deeplink: null, status: 'ok' },
        nextMed: { value: null, deeplink: 'meds', status: 'missing' },
        missedDoses: { value: [], deeplink: 'meds', status: 'ok' },
        bpLatest: { value: { systolic: 122, diastolic: 79, measured_at: at(8, 0) }, deeplink: 'bp', status: 'ok' },
        bpTrend7d: { value: null, deeplink: 'bp', status: 'missing' },
        weightLatest: { value: { weight: 85.8, measured_at: at(7, 0) }, deeplink: 'weight', status: 'ok' },
        weightTrend7d: { value: null, deeplink: 'weight', status: 'missing' },
        caloriesToday: { value: 400, deeplink: 'food', status: 'ok' },
        caloriesTarget: { value: 2000, deeplink: 'food', status: 'ok' },
        macrosToday: { value: { protein: 20, carbs: 40, fat: 10 }, deeplink: 'food', status: 'ok' },
        macrosTarget: { value: { protein: 150, carbs: 250, fat: 70 }, deeplink: 'food', status: 'ok' },
        nextWorkout: { value: null, deeplink: 'workouts', status: 'missing' },
        sleepLastNight: { value: { hours: 7, day: '2026-04-20' }, deeplink: 'health', status: 'ok' },
        stepsLatest: { value: null, deeplink: 'health', status: 'missing' },
        goalLine: { value: null, deeplink: 'journey', status: 'missing' }
    };
}

function disabledState() {
    const s = baseState();
    for (const k of Object.keys(s)) {
        if (k !== 'greeting') s[k] = { value: null, deeplink: s[k].deeplink, status: 'disabled' };
    }
    return s;
}

const MISSED = { scheduledAt: at(8, 20), names: ['Allopurinol'], ids: [3], intakeIds: ['i-31'] };
const LATER = { scheduledAt: at(21, 30), names: ['Candecor', 'Lercanidipin', 'Metformin'], ids: [4, 5, 6] };
const WORKOUT_TODAY = { id: 7, scheduled_date: '2026-04-20', scheduled_time: '16:00', group_name: 'Daily split', status: 'pending', is_today: true };

function busyState() {
    const s = baseState();
    s.missedDoses = { value: [MISSED], deeplink: 'meds', status: 'ok' };
    s.nextMed = { value: LATER, deeplink: 'meds', status: 'ok' };
    s.nextWorkout = { value: { ...WORKOUT_TODAY }, deeplink: 'workouts', status: 'ok' };
    return s;
}

function goalLinePayload(goalOverrides, rest) {
    return {
        enabled: true,
        goal: {
            status: 'ok', target: 78, episode_id: 'g1',
            start_ref: 86, start_ref_source: 'trend_at_set', start_day: '2026-03-01', direction: -1,
            trend_weight: 82.4, latest_reading: { weight: 82.1, measured_at: '2026-04-19T07:00:00Z' },
            distance_to_goal: 4.4, change_7d: -0.4,
            progress: { done_kg: 3.6, total_kg: 8, fraction: 0.45 },
            coverage: { weigh_in_days_28d: 12, last_weigh_in_day: '2026-04-18', min_weigh_in_days: 5 },
            too_fast: false,
            next_milestone: { ordinal: 4, count: 8, weight: 82, distance: 0.4, is_halfway: false, is_goal: false },
            ...goalOverrides
        },
        workouts: { feature_on: true, completed_this_week: 2, next_scheduled: { day: '2026-04-22', time: '18:00', group_title: 'Push' }, scheduled_this_week: null },
        bp: { feature_on: true, recorded_today: true, days_this_week: 3, mean_7d: { systolic: 128.4, diastolic: 82.2, days: 5 }, target: { systolic: 130, diastolic: 85 }, status: 'in_range' },
        weighed_today: false,
        cta: 'weigh_in',
        ...rest
    };
}

const primaries = (root) => Array.from(root.ownerDocument.querySelectorAll('.wg-btn--primary'));
const nextKinds = (root) => Array.from(root.querySelectorAll('[data-section="next-up"] [data-next]')).map((r) => r.getAttribute('data-next'));

describe('Today v2 — Next up', () => {
    let env;
    let root;
    beforeEach(() => { env = loadRenderEnv(); root = env.document.getElementById('today-content'); });
    afterEach(() => { env.cleanup(); });

    it('missed dose, then the due workout, then later meds — with exactly one sun action', () => {
        const s = busyState();
        s.goalLine = env.aggregate({ features: { gamification: true } }, { gamification_goal_line: goalLinePayload({ status: 'no_goal' }) }, NOW).goalLine;
        env.render(s, root, { now: NOW });

        expect(nextKinds(root)).toEqual(['med-missed', 'workout', 'med']);
        const rows = root.querySelectorAll('[data-section="next-up"] [data-next]');
        // Missed: danger lead, a "Missed HH:MM" danger chip, a plain Log.
        expect(rows[0].querySelector('.wg-row__lead--danger')).not.toBeNull();
        const missed = rows[0].querySelector('.wg-chip--danger');
        expect(missed.textContent).toBe('Missed 08:20');
        expect(rows[0].querySelector('[data-action="log-missed"]').classList.contains('wg-btn--primary')).toBe(false);
        // The soonest scheduled item owns the single sun control.
        expect(rows[1].querySelector('.wg-row__lead--sun')).not.toBeNull();
        expect(rows[1].querySelector('[data-action="start-workout"]').classList.contains('wg-btn--primary')).toBe(true);
        expect(rows[2].querySelector('.wg-row__title').textContent).toBe('3 medications');
        expect(rows[2].querySelector('.wg-row__meta').textContent).toContain('21:30');
        expect(rows[2].querySelector('[data-action="take"]').classList.contains('wg-btn--primary')).toBe(false);

        const sun = primaries(root);
        expect(sun.length).toBe(1);
        expect(sun[0].getAttribute('data-action')).toBe('start-workout');
        // The no-goal card stays a plain button while Next up owns the sun.
        expect(root.querySelector('[data-action="set-goal"]').classList.contains('wg-btn--primary')).toBe(false);
        expect(root.querySelector('[data-section="next-up"] .wg-section__head .wg-meta').textContent).toBe('3 today');
    });

    it('a later scheduled dose sorts ahead of a later workout and takes the sun', () => {
        const s = busyState();
        s.missedDoses = { value: [], deeplink: 'meds', status: 'ok' };
        s.nextMed = { value: { scheduledAt: at(15, 0), names: ['Aspirin'], ids: [1] }, deeplink: 'meds', status: 'ok' };
        env.render(s, root, { now: NOW });
        expect(nextKinds(root)).toEqual(['med', 'workout']);
        expect(primaries(root).map((b) => b.getAttribute('data-action'))).toEqual(['take']);
    });

    it('row actions reuse the existing flows: confirm modal for meds, WorkoutSessions for the session', () => {
        env.window.showMedicationConfirmModal = vi.fn();
        env.window.WorkoutSessions = { start: vi.fn(), open: vi.fn() };
        env.render(busyState(), root, { now: NOW });
        root.querySelector('[data-action="log-missed"]').click();
        root.querySelector('[data-action="take"]').click();
        root.querySelector('[data-action="start-workout"]').click();
        expect(env.window.showMedicationConfirmModal.mock.calls).toEqual([
            [[3], ['Allopurinol'], MISSED.scheduledAt, 'confirm', ['i-31']],
            [[4, 5, 6], LATER.names, LATER.scheduledAt, 'confirm', []]
        ]);
        expect(env.window.WorkoutSessions.start).toHaveBeenCalledWith(7);

        const s = busyState();
        s.nextWorkout.value.status = 'in_progress';
        env.render(s, root, { now: NOW });
        root.querySelector('[data-action="resume-workout"]').click();
        expect(env.window.WorkoutSessions.open).toHaveBeenCalledWith(7);
    });

    it('a session on another day is a plain View to Workouts; the sun moves to the dose', () => {
        const s = busyState();
        s.nextWorkout.value = { ...WORKOUT_TODAY, is_today: false, scheduled_date: '2026-04-22' };
        const onDeeplink = vi.fn();
        env.render(s, root, { now: NOW, onDeeplink });
        expect(nextKinds(root)).toEqual(['med-missed', 'med', 'workout']);
        const view = root.querySelector('[data-action="view-workout"]');
        expect(view.classList.contains('wg-btn--primary')).toBe(false);
        view.click();
        expect(onDeeplink).toHaveBeenCalledWith('workouts');
        expect(primaries(root).map((b) => b.getAttribute('data-action'))).toEqual(['take']);
    });

    it('nothing scheduled → an empty state that names the next step (no sun of its own)', () => {
        const onAddMedication = vi.fn();
        const onCreatePlan = vi.fn();
        env.render(baseState(), root, { now: NOW, onAddMedication, onCreatePlan });
        const nextUp = root.querySelector('[data-section="next-up"]');
        expect(nextUp.querySelector('.wg-empty__title').textContent).toBe('Nothing scheduled');
        const acts = Array.from(nextUp.querySelectorAll('.wg-empty__acts .wg-btn'));
        expect(acts.map((b) => b.textContent)).toEqual(['Add medication', 'Create plan']);
        acts[0].click();
        acts[1].click();
        expect(onAddMedication).toHaveBeenCalledTimes(1);
        expect(onCreatePlan).toHaveBeenCalledTimes(1);
        expect(primaries(root).length).toBe(0);
    });

    it('first run: with nothing scheduled the goal card owns the single primary (T4)', () => {
        const s = baseState();
        s.goalLine = env.aggregate({ features: { gamification: true } }, { gamification_goal_line: goalLinePayload({ status: 'no_goal' }) }, NOW).goalLine;
        const onDeeplink = vi.fn();
        env.render(s, root, { now: NOW, onDeeplink });
        const sun = primaries(root);
        expect(sun.length).toBe(1);
        expect(sun[0].getAttribute('data-action')).toBe('set-goal');
        expect(root.querySelector('[data-section="goal-line"]').classList.contains('wg-card--accent')).toBe(true);
        sun[0].click();
        expect(onDeeplink).toHaveBeenCalledWith('weight');
    });

    // Missed = intake state (PENDING past slot, not snoozed ahead) from the
    // cached 24h history — the Meds badge's rule — never cache timing.
    it('missed rows come from PENDING history; taken, snoozed and future intakes are not missed', () => {
        const bootstrap = {
            features: { medication: true, bp: false, weight: false, food: false, workout: false, health: false, gamification: false },
            medications: [{ id: 'm1', name: 'Allopurinol' }, { id: 'm2', name: 'Candecor' }, { id: 'm3', name: 'Metformin' }],
            next_intake: { scheduled_at: at(21, 30), medication_names: ['Metformin'], medication_ids: ['m3'] },
            intake_history: [
                { id: 'i1', medication_id: 'm1', scheduled_at: at(8, 20), status: 'PENDING' },
                { id: 'i2', medication_id: 'm2', scheduled_at: at(8, 20), status: 'PENDING' },
                { id: 'i3', medication_id: 'm1', scheduled_at: at(12, 0), status: 'TAKEN' },
                { id: 'i4', medication_id: 'm2', scheduled_at: at(13, 0), status: 'PENDING', snoozed_until: at(14, 30) },
                { id: 'i5', medication_id: 'm3', scheduled_at: at(21, 30), status: 'PENDING' }
            ]
        };
        const state = env.aggregate(bootstrap, {}, NOW);
        expect(state.missedDoses.value).toEqual([
            { scheduledAt: at(8, 20), names: ['Allopurinol', 'Candecor'], ids: ['m1', 'm2'], intakeIds: ['i1', 'i2'] }
        ]);
        env.window.showMedicationConfirmModal = vi.fn();
        env.render(state, root, { now: NOW });
        expect(nextKinds(root)).toEqual(['med-missed', 'med']);
        const missedRow = root.querySelector('[data-next="med-missed"]');
        expect(missedRow.querySelector('.wg-row__title').textContent).toBe('2 medications');
        missedRow.querySelector('[data-action="log-missed"]').click();
        expect(env.window.showMedicationConfirmModal).toHaveBeenCalledWith(['m1', 'm2'], ['Allopurinol', 'Candecor'], at(8, 20), 'confirm', ['i1', 'i2']);
    });

    it('a dose that just came due is a Take with the sun, not Missed, and never doubles with next_intake', () => {
        const bootstrap = {
            features: { medication: true, bp: false, weight: false, food: false, workout: false, health: false, gamification: false },
            medications: [{ id: 'm1', name: 'Allopurinol' }, { id: 'm3', name: 'Metformin' }],
            // still the just-passed slot inside its SWR window
            next_intake: { scheduled_at: at(13, 58), medication_names: ['Allopurinol'], medication_ids: ['m1'] },
            intake_history: [{ id: 'i1', medication_id: 'm1', scheduled_at: at(13, 58), status: 'PENDING' }]
        };
        env.render(env.aggregate(bootstrap, {}, NOW), root, { now: NOW });
        expect(nextKinds(root)).toEqual(['med']);
        expect(root.querySelector('.wg-chip--danger')).toBeNull();
        expect(primaries(root).map((b) => b.getAttribute('data-action'))).toEqual(['take']);
    });

    it('with history cached, an out-of-date next_intake behind now is dropped, not called missed', () => {
        const bootstrap = {
            features: { medication: true, bp: false, weight: false, food: false, workout: false, health: false, gamification: false },
            next_intake: { scheduled_at: at(8, 20), medication_names: ['Allopurinol'], medication_ids: ['m1'] },
            intake_history: [{ id: 'i1', medication_id: 'm1', scheduled_at: at(8, 20), status: 'TAKEN' }]
        };
        env.render(env.aggregate(bootstrap, {}, NOW), root, { now: NOW });
        expect(nextKinds(root)).toEqual([]);
        expect(root.querySelector('[data-section="next-up"] .wg-empty__title').textContent).toBe('Nothing scheduled');

        // No history cached (offline cold start): the past next_intake is the
        // only missed signal left, so it shows.
        delete bootstrap.intake_history;
        env.render(env.aggregate(bootstrap, {}, NOW), root, { now: NOW });
        expect(nextKinds(root)).toEqual(['med-missed']);
        expect(root.querySelector('.wg-chip--danger').textContent).toBe('Missed 08:20');
    });

    it('meds and workouts both off → no Next up section', () => {
        const s = baseState();
        s.nextMed = { value: null, deeplink: 'meds', status: 'disabled' };
        s.nextWorkout = { value: null, deeplink: 'workouts', status: 'disabled' };
        env.render(s, root, { now: NOW });
        expect(root.querySelector('[data-section="next-up"]')).toBeNull();
    });
});

describe('Today v2 — Log sheet', () => {
    let env;
    let root;
    beforeEach(() => { env = loadRenderEnv(); root = env.document.getElementById('today-content'); });
    afterEach(() => { env.cleanup(); });

    const sheet = () => env.document.getElementById('today-log-sheet');
    const tiles = () => Array.from(sheet().querySelectorAll('[data-log]')).map((t) => t.getAttribute('data-log'));
    const open = () => root.querySelector('[data-action="open-log"]').click();

    it('opens a kit sheet: food fast paths first, then BP / Weight / Note', () => {
        env.render(baseState(), root, { now: NOW });
        open();
        const s = sheet();
        expect(s.classList.contains('wg-sheet')).toBe(true);
        expect(s.classList.contains('hidden')).toBe(false);
        expect(s.querySelector('.wg-sheethead__title').textContent).toBe('Log');
        expect(tiles()).toEqual(['food-search', 'food-photo', 'food-scan', 'food-describe', 'bp', 'weight', 'note']);
        const eyebrows = Array.from(s.querySelectorAll('.wg-sheet__body > .wg-eyebrow')).map((n) => n.textContent);
        expect(eyebrows).toEqual(['Food', 'Measurements & notes']);
        expect(s.querySelector('.wg-actions--3 [data-log="bp"]')).not.toBeNull();
    });

    it('disabled features drop out of the grid', () => {
        const s = baseState();
        s.caloriesToday = { value: null, deeplink: 'food', status: 'disabled' };
        s.weightLatest = { value: null, deeplink: 'weight', status: 'disabled' };
        env.render(s, root, { now: NOW });
        open();
        expect(tiles()).toEqual(['bp', 'note']);
        expect(sheet().querySelector('.wg-sheet__body').textContent).not.toContain('Food');
    });

    it('every feature that can log is off → no Log button', () => {
        env.render(disabledState(), root, { now: NOW });
        expect(root.querySelector('[data-action="open-log"]')).toBeNull();
    });

    it('each tile closes the sheet and runs the same opener as before', () => {
        const h = {
            onLogFood: vi.fn(), onPhotoMeal: vi.fn(), onScanFood: vi.fn(), onDescribeFood: vi.fn(),
            onAddBp: vi.fn(), onAddWeight: vi.fn(), onAddNote: vi.fn()
        };
        env.render(baseState(), root, { now: NOW, ...h });
        const expected = {
            'food-search': h.onLogFood, 'food-photo': h.onPhotoMeal, 'food-scan': h.onScanFood,
            'food-describe': h.onDescribeFood, bp: h.onAddBp, weight: h.onAddWeight, note: h.onAddNote
        };
        for (const [id, fn] of Object.entries(expected)) {
            open();
            sheet().querySelector(`[data-log="${id}"]`).click();
            expect(sheet().classList.contains('hidden')).toBe(true);
            expect(fn).toHaveBeenCalledTimes(1);
        }
    });

    it('opens and closes through ModalManager so Back / Esc reach it', () => {
        const mm = {
            register: vi.fn(),
            open: vi.fn((id) => env.document.getElementById(id).classList.remove('hidden')),
            close: vi.fn((id) => env.document.getElementById(id).classList.add('hidden'))
        };
        env.window.ModalManager = mm;
        env.render(baseState(), root, { now: NOW });
        open();
        expect(mm.register).toHaveBeenCalledWith('today-log-sheet', expect.any(Function));
        expect(mm.open).toHaveBeenCalledWith('today-log-sheet');
        sheet().querySelector('[data-action="close"]').click();
        expect(mm.close).toHaveBeenCalledWith('today-log-sheet');
        expect(sheet().classList.contains('hidden')).toBe(true);
        // Re-opening reuses the one sheet node.
        open();
        expect(env.document.querySelectorAll('#today-log-sheet').length).toBe(1);
    });

    it('default openers: the food modal, its scanner and photo picker, AI describe, BP / weight forms, the notes composer', () => {
        const w = env.window;
        w.showAddFoodModal = vi.fn();
        w.setFoodParseAIMode = vi.fn();
        w.FoodLog = { openAdd: vi.fn() };
        w.FoodScanner = { openFoodScannerModal: vi.fn() };
        w.FoodActions = { triggerPhotoPicker: vi.fn() };
        w.showBPRecordModal = vi.fn();
        w.showWeightModal = vi.fn();
        w.switchTab = vi.fn();
        const notesTab = env.document.createElement('button');
        notesTab.className = 'health-tab';
        notesTab.setAttribute('data-tab', 'notes');
        notesTab.addEventListener('click', w.notesClicked = vi.fn());
        env.document.body.appendChild(notesTab);

        env.render(baseState(), root, { now: NOW });
        const tap = (id) => { open(); sheet().querySelector(`[data-log="${id}"]`).click(); };
        tap('food-search');
        expect(w.showAddFoodModal).toHaveBeenCalledTimes(1);
        tap('food-scan');
        expect(w.FoodLog.openAdd).toHaveBeenCalledTimes(1);
        expect(w.FoodScanner.openFoodScannerModal).toHaveBeenCalledTimes(1);
        tap('food-photo');
        expect(w.FoodActions.triggerPhotoPicker).toHaveBeenCalledTimes(1);
        tap('food-describe');
        expect(w.showAddFoodModal).toHaveBeenCalledTimes(2);
        expect(w.setFoodParseAIMode).toHaveBeenCalledWith(true);
        tap('bp');
        expect(w.showBPRecordModal).toHaveBeenCalledTimes(1);
        tap('weight');
        expect(w.showWeightModal).toHaveBeenCalledTimes(1);
        tap('note');
        expect(w.switchTab).toHaveBeenCalledWith('health');
        expect(w.notesClicked).toHaveBeenCalledTimes(1);
        // None of these is a bare tab switch to the feature tab.
        expect(w.switchTab).not.toHaveBeenCalledWith('food');
        expect(w.switchTab).not.toHaveBeenCalledWith('bp');
    });
});

describe('Today v2 — states (T4–T6) and offline', () => {
    let env;
    let root;
    beforeEach(() => { env = loadRenderEnv(); root = env.document.getElementById('today-content'); });
    afterEach(() => { env.cleanup(); });

    it('cold start with no cache: a skeleton shaped like the layout, nothing else', () => {
        const s = baseState();
        s.__firstRun = true;
        env.render(s, root, { now: NOW });
        const skel = root.querySelector('[data-section="skeleton"]');
        expect(skel.getAttribute('aria-busy')).toBe('true');
        const kinds = Array.from(skel.querySelectorAll('.wg-skel')).map((n) => n.className.replace('wg-skel wg-skel--', ''));
        expect(kinds).toEqual(['line', 'card', 'tile', 'tile', 'tile', 'card']);
        expect(skel.querySelector('.wg-grid3 .wg-skel--tile')).not.toBeNull();
        expect(root.querySelector('[data-section="next-up"]')).toBeNull();
    });

    it('a cached start never shows the skeleton', () => {
        env.render(baseState(), root, { now: NOW });
        expect(root.querySelector('.wg-skel')).toBeNull();
    });

    it('cold start offline → the shared offline state; settled with nothing → error + Retry', () => {
        const s = baseState();
        s.__firstRun = true;
        env.render(s, root, { now: NOW, offline: true });
        expect(root.querySelector('.wg-empty__title').textContent).toBe('No cached data yet');
        expect(root.querySelector('.wg-skel')).toBeNull();

        const onRetry = vi.fn();
        env.render(s, root, { now: NOW, settled: true, onRetry });
        const err = root.querySelector('.wg-error');
        expect(err.textContent).toContain('Couldn’t load your day.');
        err.querySelector('.wg-btn').click();
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('offline: cached values carry a stale "cached" chip', () => {
        const s = baseState();
        s.goalLine = env.aggregate({ features: { gamification: true } }, { gamification_goal_line: goalLinePayload() }, NOW).goalLine;
        env.render(s, root, { now: NOW, offline: true });
        for (const sel of ['[data-section="bp"]', '[data-section="weight"]', '[data-section="goal-line"]']) {
            const c = root.querySelector(`${sel} .wg-chip--stale`);
            expect(c, sel).not.toBeNull();
            expect(c.textContent).toBe('cached');
        }
        // Online, the same values show their age instead.
        env.render(s, root, { now: NOW });
        expect(root.querySelector('[data-section="bp"] .wg-chip--stale')).toBeNull();
    });

    it('a device-saved log still queued reads Pending on its tile', () => {
        const bootstrap = {
            features: { bp: true, weight: true, medication: false, food: false, workout: false, health: false, gamification: false },
            bp: { readings: [
                { id: 1, systolic: 130, diastolic: 82, measured_at: at(7, 0) },
                { id: 'local_optimistic_1', systolic: 121, diastolic: 78, measured_at: at(13, 50), _optimistic: true }
            ] },
            weight: { logs: [{ id: 2, weight: 85.8, measured_at: at(7, 0), isLocal: true }] }
        };
        const state = env.aggregate(bootstrap, {}, NOW);
        env.render(state, root, { now: NOW, offline: true });
        const bpPending = root.querySelector('[data-section="bp"] .wg-chip--pending');
        expect(bpPending.textContent).toBe('Pending');
        expect(root.querySelector('[data-section="bp"] .wg-stat__value').textContent).toBe('121/78');
        expect(root.querySelector('[data-section="weight"] .wg-chip--pending')).not.toBeNull();
    });

    it('every feature off → one empty state pointing at Settings', () => {
        const onDeeplink = vi.fn();
        env.render(disabledState(), root, { now: NOW, onDeeplink });
        const empty = root.querySelector('[data-section="all-off"]');
        expect(empty.querySelector('.wg-empty__title').textContent).toBe('All features are off');
        empty.querySelector('.wg-btn').click();
        expect(onDeeplink).toHaveBeenCalledWith('settings');
        expect(root.querySelector('[data-section="vitals"]')).toBeNull();
    });

    it('clears previous content on re-render', () => {
        env.render(busyState(), root, { now: NOW });
        env.render(busyState(), root, { now: NOW });
        expect(root.querySelectorAll('[data-section="next-up"]').length).toBe(1);
        expect(root.querySelectorAll('[data-section="callbar"]').length).toBe(1);
    });

    it('a mounted call card rides the call row next to Log', () => {
        env.window.WGCallAgent = {
            mountCard: vi.fn((container) => {
                const card = env.document.createElement('section');
                card.className = 'wg-card wg-call-card';
                card.setAttribute('data-section', 'call-agent');
                container.appendChild(card);
                return card;
            })
        };
        env.render(baseState(), root, { now: NOW });
        const row = root.querySelector('[data-section="callbar"]');
        expect(env.window.WGCallAgent.mountCard).toHaveBeenCalledWith(row);
        expect(Array.from(row.children).map((n) => n.getAttribute('data-section') || n.getAttribute('data-action')))
            .toEqual(['call-agent', 'open-log']);
    });
});

describe('Today v2 — Goal Line', () => {
    let env;
    let root;
    beforeEach(() => { env = loadRenderEnv(); root = env.document.getElementById('today-content'); });
    afterEach(() => { env.cleanup(); });

    function goalLineState(payload) {
        const state = baseState();
        state.goalLine = env.aggregate({ features: { gamification: true } }, { gamification_goal_line: payload }, NOW).goalLine;
        return state;
    }
    const card = () => root.querySelector('[data-section="goal-line"]');

    it('ok: current → target, a marker track with a pin, three numbers; tap opens Journey', () => {
        const onAddWeight = vi.fn();
        const onDeeplink = vi.fn();
        env.render(goalLineState(goalLinePayload()), root, { now: NOW, onAddWeight, onDeeplink });

        const c = card();
        expect(c.getAttribute('data-status')).toBe('ok');
        const values = c.querySelectorAll('.wg-stat__value');
        expect(values[0].textContent).toBe('82.4');
        expect(values[1].classList.contains('wg-sun')).toBe(true);
        expect(values[1].textContent).toBe('78.0kg');
        const track = c.querySelector('.wg-track');
        expect(track.style.getPropertyValue('--p')).toBe('45.0%');
        expect(track.style.getPropertyValue('--n')).toBe('8');
        expect(track.querySelector('.wg-track__fill')).not.toBeNull();
        expect(track.querySelector('.wg-track__pin').style.getPropertyValue('--p')).toBe('50.0%');
        const ends = Array.from(c.querySelectorAll('.wg-track__ends > span')).map((n) => n.textContent);
        expect(ends).toEqual(['start 86.0', 'next 82.0', '3 / 8']);
        const weekChip = c.querySelector('.wg-hstack .wg-chip');
        expect(weekChip.textContent).toBe('−0.4 kg · 7d');
        expect(weekChip.classList.contains('wg-chip--warn')).toBe(false);
        // No HP, level, Health Score or rings, and no Bootstrap buttons.
        expect(c.textContent).not.toMatch(/\bHP\b|Lvl|Health Score|rings/i);
        expect(root.querySelector('.btn')).toBeNull();

        c.querySelector('[data-action="weigh-in"]').click();
        expect(onAddWeight).toHaveBeenCalledTimes(1);
        expect(onDeeplink).not.toHaveBeenCalled();
        c.click();
        expect(onDeeplink).toHaveBeenCalledWith('journey');
        onDeeplink.mockClear();
        c.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(onDeeplink).toHaveBeenCalledWith('journey');
    });

    it('moving away from the target this week → a warn chip, never praise the other way', () => {
        env.render(goalLineState(goalLinePayload({ change_7d: 1.1 })), root, { now: NOW });
        const chip = card().querySelector('.wg-hstack .wg-chip');
        expect(chip.textContent).toBe('+1.1 kg · 7d');
        expect(chip.classList.contains('wg-chip--warn')).toBe(true);
    });

    it('shows the chosen intention + cadence, or "Paused this week"', () => {
        env.render(goalLineState(goalLinePayload({}, {
            plan: { paused: false, intention: { text: 'Stop eating after dinner' }, cadence: { weigh_in: 'daily', bp_days: 3 } }
        })), root, { now: NOW });
        expect(card().querySelector('[data-fact="plan"]').textContent)
            .toBe('This week · Stop eating after dinner · weigh-in daily · BP 3 days');
        env.render(goalLineState(goalLinePayload({}, { plan: { paused: true } })), root, { now: NOW });
        expect(card().querySelector('[data-fact="plan"]').textContent).toBe('Paused this week');
    });

    it('no_goal with the Weight feature off: no dead "Set a weight goal" card', () => {
        const state = baseState();
        state.goalLine = env.aggregate({ features: { gamification: true, weight: false } },
            { gamification_goal_line: goalLinePayload({ status: 'no_goal' }) }, NOW).goalLine;
        env.render(state, root, { now: NOW });
        expect(card()).toBeNull();
    });

    it('missed-dose safety net: an active adherence alert renders one link to Meds; inactive renders nothing', () => {
        const onDeeplink = vi.fn();
        env.render(goalLineState(goalLinePayload({}, { adherence_alert: { active: true, pdc: 0.72, missed_doses: 2 } })), root, { now: NOW, onDeeplink });
        const nudge = root.querySelector('.wg-today-goal__adherence');
        expect(nudge.textContent).toBe('2 missed doses recently — worth a look');
        nudge.click();
        expect(onDeeplink).toHaveBeenCalledWith('meds');
        expect(onDeeplink).not.toHaveBeenCalledWith('journey');

        env.render(goalLineState(goalLinePayload({}, { adherence_alert: { active: false, pdc: 0.95, missed_doses: 1 } })), root, { now: NOW });
        expect(root.querySelector('.wg-today-goal__adherence')).toBeNull();
    });

    const MILESTONE = {
        id: 'gamificationmilestone-weightgoal-1-4', ordinal: 4, count: 8, is_halfway: true, is_goal: false,
        earned_at: '2026-06-10', title: 'Halfway to your weight goal',
    };

    it('milestone: one line with "Got it" that acks without opening Journey; none without a milestone', () => {
        const onDeeplink = vi.fn();
        const onAckMilestone = vi.fn();
        env.render(goalLineState(goalLinePayload({}, { milestone: MILESTONE })), root, { now: NOW, onDeeplink, onAckMilestone });
        const row = root.querySelector(`[data-milestone-id="${MILESTONE.id}"]`);
        expect(row.textContent).toContain('Halfway to your weight goal');
        const ack = row.querySelector('[data-action="ack-milestone"]');
        expect(ack.classList.contains('wg-btn')).toBe(true);
        ack.click();
        expect(onAckMilestone).toHaveBeenCalledWith(MILESTONE.id);
        expect(onDeeplink).not.toHaveBeenCalled();

        env.render(goalLineState(goalLinePayload({}, { milestone: null })), root, { now: NOW, onAckMilestone });
        expect(root.querySelector('[data-milestone-id]')).toBeNull();
    });

    it('milestone default ack: optimistic milestone:null on the Goal Line cache, POST ack, commit (rollback on failure)', async () => {
        const handle = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
        let projected = null;
        env.window.DataStore = {
            applyOptimistic: vi.fn(async (key, mutator) => { projected = mutator({ goal: {}, milestone: MILESTONE }); return handle; }),
        };
        env.window.offlineAwareApiCall = vi.fn(async () => ({ ok: true }));
        const click = async () => {
            env.render(goalLineState(goalLinePayload({}, { milestone: MILESTONE })), root, { now: NOW });
            root.querySelector('[data-action="ack-milestone"]').click();
            await vi.waitFor(() => expect(handle.commit.mock.calls.length + handle.rollback.mock.calls.length).toBeGreaterThan(0));
        };

        await click();
        expect(env.window.DataStore.applyOptimistic).toHaveBeenCalledWith('gamification_goal_line', expect.any(Function), ['gamification']);
        expect(projected).toEqual({ goal: {}, milestone: null });
        expect(env.window.offlineAwareApiCall).toHaveBeenCalledWith(`/api/gamification/milestones/${encodeURIComponent(MILESTONE.id)}/ack`, 'POST');
        expect(handle.commit).toHaveBeenCalledWith(null);
        expect(handle.rollback).not.toHaveBeenCalled();

        handle.commit.mockClear();
        env.window.offlineAwareApiCall = vi.fn(async () => ({ ok: false, error: 'not_found' }));
        await click();
        expect(handle.rollback).toHaveBeenCalled();
        expect(handle.commit).not.toHaveBeenCalled();
    });

    it('preliminary: the latest reading, how many weigh-ins until a trend, no track', () => {
        const payload = goalLinePayload({
            status: 'preliminary', trend_weight: null, change_7d: null, next_milestone: null, start_ref_source: 'first_reading',
            latest_reading: { weight: 82.9, measured_at: '2026-04-19T07:00:00Z' },
            coverage: { weigh_in_days_28d: 3, last_weigh_in_day: '2026-04-19', min_weigh_in_days: 5 }
        });
        env.render(goalLineState(payload), root, { now: NOW });
        expect(card().textContent).toContain('Latest 82.9 kg · trend forms after 2 more weigh-ins');
        expect(card().querySelector('.wg-track')).toBeNull();
        expect(card().textContent).not.toContain('7d');
    });

    it('at_goal and maintaining get explicit copy, no track', () => {
        env.render(goalLineState(goalLinePayload({ status: 'at_goal', trend_weight: 78.2, next_milestone: null })), root, { now: NOW });
        expect(card().textContent).toContain('At your goal — trend has reached 78.0 kg');
        expect(card().querySelector('.wg-track')).toBeNull();

        env.render(goalLineState(goalLinePayload({ status: 'maintaining', trend_weight: 77.9, next_milestone: null })), root, { now: NOW });
        expect(card().textContent).toContain('Maintaining your goal — trend holding at 78.0 kg');
    });

    it('too_fast: one calm safety line, never praise', () => {
        env.render(goalLineState(goalLinePayload({ too_fast: true })), root, { now: NOW });
        const c = card();
        const lines = Array.from(c.querySelectorAll('.wg-hint')).filter((n) => n.textContent.includes('1% a week'));
        expect(lines.length).toBe(1);
        expect(lines[0].textContent).toBe('Faster than 1% a week — worth checking with your doctor.');
        expect(c.textContent).not.toMatch(/great|nice|well done|on pace|ahead/i);
    });

    it('start_session lives in Next up now: the goal card renders no session button; cta none → no button', () => {
        env.render(goalLineState(goalLinePayload({}, { cta: 'start_session', weighed_today: true })), root, { now: NOW });
        expect(card().querySelector('[data-action="start-session"]')).toBeNull();
        expect(card().querySelector('.wg-btn')).toBeNull();
        env.render(goalLineState(goalLinePayload({}, { cta: 'none', weighed_today: true })), root, { now: NOW });
        expect(card().querySelector('.wg-btn')).toBeNull();
    });

    it('gamification off (flag or payload) → no card at all', () => {
        const off = baseState();
        off.goalLine = env.aggregate({ features: { gamification: false } }, { gamification_goal_line: goalLinePayload() }, NOW).goalLine;
        env.render(off, root, { now: NOW });
        expect(card()).toBeNull();

        env.render(goalLineState({ enabled: false }), root, { now: NOW });
        expect(card()).toBeNull();
    });

    // med-8tur.12: ED-safe rides the Goal Line payload — no Goal Line card and
    // no weight numbers on Today (the weight metric cells go 'disabled').
    it('ED-safe payload → no Goal Line card and no weight metric on Today', () => {
        const bootstrap = {
            features: { gamification: true, weight: true },
            weight: { logs: [{ measured_at: NOW.toISOString(), weight: 82.4 }] },
        };
        const safe = env.aggregate(bootstrap, { gamification_goal_line: { enabled: false, ed_safe: true } }, NOW);
        expect(safe.goalLine.status).toBe('disabled');
        expect(safe.weightLatest.status).toBe('disabled');
        expect(safe.weightTrend7d.status).toBe('disabled');

        const normal = env.aggregate(bootstrap, { gamification_goal_line: goalLinePayload() }, NOW);
        expect(normal.weightLatest.status).toBe('ok');
    });

    it('ED-safe + active adherence alert → the alert line alone, no weight numbers', () => {
        const bootstrap = {
            features: { gamification: true, weight: true, bp: false, food: false, medication: true, workout: false, health: false },
            weight: { logs: [{ measured_at: NOW.toISOString(), weight: 82.4 }] },
        };
        const payload = { enabled: false, ed_safe: true, adherence_alert: { active: true, pdc: 0.6, missed_doses: 3 } };
        const state = env.aggregate(bootstrap, { gamification_goal_line: payload }, NOW);
        const onDeeplink = vi.fn();
        env.render(state, root, { now: NOW, onDeeplink });

        const alert = root.querySelector('[data-section="adherence-alert"] .wg-today-goal__adherence');
        expect(alert.textContent).toBe('3 missed doses recently — worth a look');
        alert.click();
        expect(onDeeplink).toHaveBeenCalledWith('meds');
        expect(card()).toBeNull();
        expect(root.textContent).not.toMatch(/82\.4|kg/);
    });
});

// The card's cache entry must evict on its SOURCE tags: only goal milestones
// sync under 'gamification' (sync.js RECORD_TAGS), so a weigh-in, session, BP
// reading, synced goal edit or feature flip would otherwise repaint a stale
// card. Eviction → Today's loader sees it missing and refetches.
describe('Goal Line cache tags', () => {
    beforeEach(() => { allowConsoleNoise(); });

    it.each(['gamification', 'weight', 'workout', 'bp', 'settings', 'medications', 'history'])('invalidating %s evicts gamification_goal_line', async (tag) => {
        const { window, cacheMap, cleanup } = loadDataStoreEnv({
            initialCache: { gamification_goal_line: { enabled: true }, food_products_cache: { keep: true } }
        });
        try {
            window.eval(fs.readFileSync(CACHE_KEYS_JS, 'utf8'));
            window.CacheKeys.registerAll(window.DataStore);
            await window.DataStore.invalidateTags([tag]);
            expect(cacheMap.has('gamification_goal_line')).toBe(false);
            expect(cacheMap.has('food_products_cache')).toBe(true);
        } finally {
            cleanup();
        }
    });
});
