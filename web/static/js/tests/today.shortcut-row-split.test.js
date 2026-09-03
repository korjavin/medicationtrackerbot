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
const ELEVENLABS_JS = path.join(REPO_ROOT, 'web/static/js/features/elevenlabs-call.js');

// callAgent: also load the real voice-call controller so window.WGCallAgent
// exists and renderToday mounts the Call agent card (med-z8ic layout). Off by
// default — the other suites assert the shortcut rows without it.
function loadEnv({ callAgent = false } = {}) {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="today-content"></div></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.eval(fs.readFileSync(EMPTY_STATE_JS, 'utf8') + '\nwindow.createEmptyState = createEmptyState;');
    window.eval(fs.readFileSync(WG_ICONS_JS, 'utf8'));
    window.eval(fs.readFileSync(WG_SPARKLINE_JS, 'utf8'));
    if (callAgent) {
        // The controller only needs an apiCallDirect seam at load time.
        window.apiCallDirect = async () => ({ signed_url: 'wss://stub.example/' });
        window.eval(fs.readFileSync(ELEVENLABS_JS, 'utf8'));
    }
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

    // med-5k6t.2 — the Doctor brief entry point. A normal Today element, not a
    // bottom-nav slot and not a section-header banner (CLAUDE.md rule 6).
    describe('Doctor brief shortcut', () => {
        const brief = () => ({ now, onDoctorBrief: () => {} });

        it('renders last, alone in its own row', () => {
            const root = env.document.getElementById('today-content');
            env.render(baseState(now), root, brief());
            const rows = Array.from(root.querySelectorAll('.wg-today-shortcuts'));
            expect(rows.length).toBe(3);
            expect(rows[2].classList.contains('wg-today-shortcuts--brief')).toBe(true);
            expect(tileLabels(rows[2])).toEqual(['Doctor brief']);
        });

        it('calls the handler on click', () => {
            const root = env.document.getElementById('today-content');
            let opened = 0;
            env.render(baseState(now), root, { now, onDoctorBrief: () => { opened += 1; } });
            root.querySelector('.wg-today-shortcuts--brief .wg-shortcut-tile')
                .dispatchEvent(new env.window.Event('click', { bubbles: true }));
            expect(opened).toBe(1);
        });

        it('still appears for a meds-only vault with no quick-log rows', () => {
            const root = env.document.getElementById('today-content');
            const state = baseState(now);
            state.caloriesTarget.status = 'disabled';
            state.bpLatest.status = 'disabled';
            state.weightLatest.status = 'disabled';
            env.render(state, root, brief());
            expect(root.querySelector('.wg-today-shortcuts--brief')).not.toBeNull();
        });

        it('disappears when every feature is off — there is nothing to brief', () => {
            const root = env.document.getElementById('today-content');
            const state = baseState(now);
            Object.keys(state).forEach((k) => {
                if (state[k] && typeof state[k] === 'object' && 'status' in state[k]) state[k].status = 'disabled';
            });
            env.render(state, root, brief());
            expect(root.querySelector('.wg-today-shortcuts')).toBeNull();
        });

        // Bot mode has no GET /api/brief and does not serve /js/print-doc.js,
        // so the tile must not be offered there at all.
        it('is absent outside cloud mode even with window.DoctorBrief present', () => {
            const root = env.document.getElementById('today-content');
            env.window.DoctorBrief = { open() {} };
            env.window.__MEDTRACKER_CLOUD__ = false;
            env.render(baseState(now), root, { now });
            expect(root.querySelector('.wg-today-shortcuts--brief')).toBeNull();
        });

        it('uses window.DoctorBrief.open as the default handler in cloud mode', () => {
            const root = env.document.getElementById('today-content');
            let opened = 0;
            env.window.__MEDTRACKER_CLOUD__ = true;
            env.window.DoctorBrief = { open() { opened += 1; } };
            env.render(baseState(now), root, { now });
            const tile = root.querySelector('.wg-today-shortcuts--brief .wg-shortcut-tile');
            expect(tile).not.toBeNull();
            tile.dispatchEvent(new env.window.Event('click', { bubbles: true }));
            expect(opened).toBe(1);
        });
    });
});

// med-z8ic — the Doctor brief no longer burns a whole row: when the Call
// agent card is mounted, the brief row rides inside it as the narrow (1fr of
// 2fr+1fr) cell. Both entry points are independently gated, so all four
// combinations have to render sensibly.
describe('Today — Doctor brief folded into the Call agent row (med-z8ic)', () => {
    let env;
    const now = new Date('2026-05-17T12:00:00Z');
    const brief = () => ({ now, onDoctorBrief: () => {} });

    beforeEach(() => { env = loadEnv({ callAgent: true }); });
    afterEach(() => { env?.cleanup(); env = null; });

    function callCard(root) {
        return root.querySelector('[data-section="call-agent"]');
    }

    it('moves the brief row inside the call card and marks the split', () => {
        const root = env.document.getElementById('today-content');
        env.render(baseState(now), root, brief());
        const card = callCard(root);
        expect(card).not.toBeNull();
        expect(card.classList.contains('wg-call-card--with-brief')).toBe(true);
        const briefRow = card.querySelector('[data-section="shortcuts-brief"]');
        expect(briefRow).not.toBeNull();
        expect(briefRow.classList.contains('wg-call-card__brief')).toBe(true);
        expect(tileLabels(briefRow)).toEqual(['Doctor brief']);
        // Exactly one brief row on the whole screen, none left at root level.
        expect(root.querySelectorAll('[data-section="shortcuts-brief"]').length).toBe(1);
        // In-call controls and the status line stay in the card — CSS spans
        // them across both columns so they keep their own lines underneath.
        expect(card.querySelector('.wg-call-card__controls')).not.toBeNull();
        expect(card.querySelector('.wg-call-card__status')).not.toBeNull();
    });

    it('the brief still opens after the move', () => {
        const root = env.document.getElementById('today-content');
        let opened = 0;
        env.render(baseState(now), root, { now, onDoctorBrief: () => { opened += 1; } });
        callCard(root).querySelector('[data-section="shortcuts-brief"] .wg-shortcut-tile')
            .dispatchEvent(new env.window.Event('click', { bubbles: true }));
        expect(opened).toBe(1);
    });

    it('call only — the card carries no brief and no split class', () => {
        const root = env.document.getElementById('today-content');
        env.render(baseState(now), root, { now });   // no onDoctorBrief handler
        const card = callCard(root);
        expect(card).not.toBeNull();
        expect(card.classList.contains('wg-call-card--with-brief')).toBe(false);
        expect(root.querySelector('[data-section="shortcuts-brief"]')).toBeNull();
    });

    it('brief only — keeps its own full-width row when no call agent is loaded', () => {
        const plain = loadEnv();
        try {
            const root = plain.document.getElementById('today-content');
            plain.render(baseState(now), root, brief());
            expect(callCard(root)).toBeNull();
            const briefRow = root.querySelector('[data-section="shortcuts-brief"]');
            expect(briefRow).not.toBeNull();
            expect(briefRow.parentElement).toBe(root);
            expect(briefRow.classList.contains('wg-call-card__brief')).toBe(false);
        } finally {
            plain.cleanup();
        }
    });

    it('neither — every feature off leaves no call-row artefacts', () => {
        const root = env.document.getElementById('today-content');
        const state = baseState(now);
        Object.keys(state).forEach((k) => {
            if (state[k] && typeof state[k] === 'object' && 'status' in state[k]) state[k].status = 'disabled';
        });
        env.render(state, root, brief());
        expect(root.querySelector('[data-section="shortcuts-brief"]')).toBeNull();
        expect(callCard(root).classList.contains('wg-call-card--with-brief')).toBe(false);
    });

    it('a Today re-render rebuilds the shared row exactly once', () => {
        const root = env.document.getElementById('today-content');
        env.render(baseState(now), root, brief());
        env.render(baseState(now), root, brief());
        expect(root.querySelectorAll('[data-section="call-agent"]').length).toBe(1);
        expect(root.querySelectorAll('[data-section="shortcuts-brief"]').length).toBe(1);
        expect(callCard(root).querySelector('[data-section="shortcuts-brief"]')).not.toBeNull();
    });
});
