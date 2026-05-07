// Round-2 Task 10 (#13a + #13b) — Workouts "Next workout" card.
//
// Pins:
//   • #13a: `_renderNextWorkout` emits the new Wandergeek markup —
//     `.wg-workouts-next-card` surface + kicker/date/title/subtitle
//     tokens + an actions row where primary actions carry
//     `.wg-toolbar-btn.wg-toolbar-btn--primary` and secondary actions
//     carry `.wg-toolbar-btn.wg-toolbar-btn--secondary`.
//   • No emoji prefixes on action labels (dumbbell / bell / calendar /
//     rewind arrows / stop sign were all stripped).
//   • CSS contract: the restyled pane uses tokens only — no
//     `linear-gradient(` and no raw hex colors in any
//     `.wg-workouts-next-card*` rule (the legacy `.next-workout-*`
//     selectors are gone from the stylesheet).
//   • #13b: `#start-adhoc-workout-btn` DOM-level adoption of
//     `.wg-toolbar-btn .wg-toolbar-btn--primary` is asserted in
//     `workout.design-parity.test.js` — this file covers the
//     "Next workout" card the Start button is sibling to.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');
const WORKOUT_JS_PATH = path.join(REPO_ROOT, 'web/static/js/features/workout.js');

function baseData(overrides = {}) {
    return {
        session: {
            id: 42,
            status: 'notified',
            scheduled_date: '2026-04-24',
            scheduled_time: '09:00',
            is_today: true,
            ...(overrides.session || {})
        },
        group_name: 'Morning 2',
        variant_name: 'Carry & Core',
        exercises_count: 2,
        variant_id: 7,
        group_id: 3,
        is_rotating: true,
        ...overrides
    };
}

describe('Workouts → Next workout card (Round-2 Task 10)', () => {
    let env;

    beforeEach(() => {
        allowConsoleNoise();
        env = loadFrontendEnv({ withWorkout: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('#13a: notified status renders the Wandergeek card shell with kicker, date, title, subtitle', () => {
        const { window, document } = env;
        const container = document.getElementById('next-workout-card');
        window._renderNextWorkout(container, baseData());

        const card = container.querySelector('.wg-workouts-next-card');
        expect(card).not.toBeNull();

        // Legacy gradient-card surface + marker classes must be gone.
        expect(container.querySelector('.next-workout-card')).toBeNull();
        expect(container.querySelector('.next-workout-header')).toBeNull();
        expect(container.querySelector('.next-workout-status')).toBeNull();
        expect(container.querySelector('.next-workout-info')).toBeNull();
        expect(container.querySelector('.btn-pill')).toBeNull();
        expect(container.querySelector('.workout-btn-row')).toBeNull();

        // New structural children.
        const kicker = card.querySelector('.wg-workouts-next-card__kicker');
        const date = card.querySelector('.wg-workouts-next-card__date');
        const title = card.querySelector('.wg-workouts-next-card__title');
        const subtitle = card.querySelector('.wg-workouts-next-card__subtitle');
        const actions = card.querySelector('.wg-workouts-next-card__actions');
        expect(kicker).not.toBeNull();
        expect(date).not.toBeNull();
        expect(title).not.toBeNull();
        expect(subtitle).not.toBeNull();
        expect(actions).not.toBeNull();

        expect(kicker.textContent).toBe('Ready to Start');
        expect(date.textContent).toContain('09:00');
        expect(title.textContent).toBe('Morning 2');
        expect(subtitle.textContent).toBe('Carry & Core · 2 exercises');
    });

    it('#13a: notified status emits primary Start Workout + secondary Skip + secondary Next Variant (no emoji)', () => {
        const { window, document } = env;
        const container = document.getElementById('next-workout-card');
        window._renderNextWorkout(container, baseData());

        const actions = container.querySelectorAll('.wg-workouts-next-card__actions > .wg-toolbar-btn');
        expect(actions.length).toBe(3);

        const [startBtn, skipBtn, variantBtn] = actions;
        expect(startBtn.classList.contains('wg-toolbar-btn--primary')).toBe(true);
        expect(skipBtn.classList.contains('wg-toolbar-btn--secondary')).toBe(true);
        expect(variantBtn.classList.contains('wg-toolbar-btn--secondary')).toBe(true);

        const labels = [startBtn, skipBtn, variantBtn].map((btn) => {
            const span = btn.querySelector('.wg-toolbar-btn__label');
            expect(span).not.toBeNull();
            return span.textContent;
        });
        expect(labels).toEqual(['Start Workout', 'Skip', 'Next Variant']);

        // No emoji prefix escaped into any rendered label.
        // Sweep a representative set of the dropped glyphs.
        const emojiRe = /[\u{1F3CB}\u{1F514}\u{1F6D1}\u{1F4C5}⏪⏮⏭⏰↻↩✏]/u;
        for (const label of labels) {
            expect(label).not.toMatch(emojiRe);
        }

        // Preserves the workout-action-btn marker class for sync.js offline
        // handler (which scans `.workout-action-btn` on connectivity change).
        for (const btn of actions) {
            expect(btn.classList.contains('workout-action-btn')).toBe(true);
        }
    });

    it('#13a: in_progress status emits View (primary) + Finish (secondary)', () => {
        const { window, document } = env;
        const container = document.getElementById('next-workout-card');
        window._renderNextWorkout(container, baseData({
            session: {
                id: 101, status: 'in_progress', scheduled_date: '2026-04-24',
                scheduled_time: '09:00', is_today: true
            }
        }));

        const actions = container.querySelectorAll('.wg-workouts-next-card__actions > .wg-toolbar-btn');
        expect(actions.length).toBe(2);

        const labels = Array.from(actions).map((btn) => btn.querySelector('.wg-toolbar-btn__label').textContent);
        expect(labels).toEqual(['View', 'Finish']);

        expect(actions[0].classList.contains('wg-toolbar-btn--primary')).toBe(true);
        expect(actions[1].classList.contains('wg-toolbar-btn--secondary')).toBe(true);

        // Kicker text reflects the in-progress status.
        expect(container.querySelector('.wg-workouts-next-card__kicker').textContent).toBe('In Progress');
    });

    it('#13a: pre_skipped status emits Cancel Skip (primary) + optional Next Variant (secondary)', () => {
        const { window, document } = env;
        const container = document.getElementById('next-workout-card');
        window._renderNextWorkout(container, baseData({
            session: {
                id: 202, status: 'pre_skipped', scheduled_date: '2026-04-24',
                scheduled_time: '09:00', is_today: true
            },
            is_rotating: true
        }));

        const actions = container.querySelectorAll('.wg-workouts-next-card__actions > .wg-toolbar-btn');
        const labels = Array.from(actions).map((btn) => btn.querySelector('.wg-toolbar-btn__label').textContent);
        expect(labels).toEqual(['Cancel Skip', 'Next Variant']);

        expect(actions[0].classList.contains('wg-toolbar-btn--primary')).toBe(true);
        expect(actions[1].classList.contains('wg-toolbar-btn--secondary')).toBe(true);

        expect(container.querySelector('.wg-workouts-next-card__kicker').textContent).toBe('To Be Skipped');
    });

    it('#13a: non-rotating variants suppress the Next Variant button', () => {
        const { window, document } = env;
        const container = document.getElementById('next-workout-card');
        window._renderNextWorkout(container, baseData({
            is_rotating: false
        }));
        const labels = Array.from(
            container.querySelectorAll('.wg-workouts-next-card__actions > .wg-toolbar-btn')
        ).map((btn) => btn.querySelector('.wg-toolbar-btn__label').textContent);
        expect(labels).toEqual(['Start Workout', 'Skip']);
    });

    it('#13a: .wg-workouts-next-card* CSS uses tokens only (no gradient, no hex, no raw rgba literals)', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        // Extract every `.wg-workouts-next-card*` rule block.
        const blockRe = /\.wg-workouts-next-card[^{]*\{([^}]*)\}/g;
        const blocks = [];
        let match;
        while ((match = blockRe.exec(css)) !== null) {
            blocks.push({ head: match[0].slice(0, match[0].indexOf('{')).trim(), body: match[1] });
        }
        // Must have at least the 8 rules we added (card, header, kicker,
        // date, info, title, subtitle, actions + actions>btn child).
        expect(blocks.length).toBeGreaterThanOrEqual(8);

        for (const b of blocks) {
            expect(b.body, `linear-gradient found in ${b.head}`).not.toMatch(/linear-gradient\(/i);
            expect(b.body, `hex color found in ${b.head}`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
            expect(b.body, `raw rgba/rgb literal found in ${b.head}`).not.toMatch(/\brgba?\s*\(/);
        }
    });

    it('legacy .next-workout-* CSS rules are removed from styles.css', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        expect(css).not.toMatch(/^\s*\.next-workout-card\s*\{/m);
        expect(css).not.toMatch(/^\s*\.next-workout-card\./m);
        expect(css).not.toMatch(/^\s*\.next-workout-header\s*\{/m);
        expect(css).not.toMatch(/^\s*\.next-workout-status\s*\{/m);
        expect(css).not.toMatch(/^\s*\.next-workout-date\s*\{/m);
        expect(css).not.toMatch(/^\s*\.next-workout-info\s+/m);
    });

    it('legacy .next-workout-* / emoji-prefixed class assignments are gone from _renderNextWorkout', () => {
        const source = fs.readFileSync(WORKOUT_JS_PATH, 'utf8');
        const fnStart = source.indexOf('function _renderNextWorkout(');
        expect(fnStart).toBeGreaterThan(-1);
        // Grab ~4500 chars forward — large enough to span the full function
        // (~130 lines).
        const fnSlice = source.slice(fnStart, fnStart + 4500);

        // No legacy markup classes on the new render path.
        expect(fnSlice).not.toMatch(/['"]next-workout-card['"]/);
        expect(fnSlice).not.toMatch(/['"]next-workout-header['"]/);
        expect(fnSlice).not.toMatch(/['"]next-workout-status['"]/);
        expect(fnSlice).not.toMatch(/['"]next-workout-info['"]/);
        expect(fnSlice).not.toMatch(/['"]next-workout-date['"]/);
        expect(fnSlice).not.toMatch(/['"]btn btn-pill['"]/);
        expect(fnSlice).not.toMatch(/workout-btn-stop/);
        expect(fnSlice).not.toMatch(/workout-btn-skip/);
        expect(fnSlice).not.toMatch(/workout-btn-full-secondary/);

        // No emoji prefixes on action labels or kicker.
        expect(fnSlice).not.toMatch(/🏋️/);
        expect(fnSlice).not.toMatch(/📅/);
        expect(fnSlice).not.toMatch(/🔔/);
        expect(fnSlice).not.toMatch(/⏰/);
        expect(fnSlice).not.toMatch(/⏭/);
        expect(fnSlice).not.toMatch(/↻/);
        expect(fnSlice).not.toMatch(/↩/);
        expect(fnSlice).not.toMatch(/🛑/);
        expect(fnSlice).not.toMatch(/✏️/);

        // New classes present.
        expect(fnSlice).toMatch(/['"]wg-workouts-next-card['"]/);
        expect(fnSlice).toMatch(/wg-toolbar-btn--primary/);
        expect(fnSlice).toMatch(/wg-toolbar-btn--secondary/);
    });
});
