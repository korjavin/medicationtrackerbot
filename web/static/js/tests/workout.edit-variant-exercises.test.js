// Round-2 Task 11 (#14) — Workouts → Edit Variant modal exercise rows.
//
// Pins:
//   • #14: `loadExercisesForVariant` emits the new Wandergeek markup —
//     `.wg-workouts-exercise-row` surface + `__info` / `__title` / `__meta`
//     spans, with the trash button carrying the new `__delete` scoped
//     hover class alongside the existing `.workout-delete-btn-inline`
//     position reset.
//   • Surface parity: the row uses the same elevated-teal-card recipe
//     (`var(--wg-bg-card)` + `1px solid var(--wg-border-hairline)` +
//     `var(--wg-radius-card)`) as `.wg-workouts-next-card` and
//     `.wg-meds-next-intake-card`, so it reads against the dark modal
//     stage instead of the legacy white card.
//   • CSS contract: the restyled row uses tokens only — no
//     `linear-gradient(` and no hex colors in any
//     `.wg-workouts-exercise-row*` rule (the legacy
//     `.workout-exercise-card` / `.workout-exercise-meta` selectors are
//     gone from the stylesheet).
//   • JS contract: `loadExercisesForVariant` no longer references the
//     legacy `workout-exercise-card` / `workout-exercise-meta` classes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');
// loadExercisesForVariant now lives in the split-out exercises.js sub-file.
const WORKOUT_JS_PATH = path.join(REPO_ROOT, 'web/static/js/features/workout/exercises.js');

function exerciseFixture(overrides = {}) {
    return {
        id: 501,
        variant_id: 7,
        order_index: 0,
        exercise_name: "Farmer's Walk",
        target_sets: 3,
        target_reps_min: 1,
        target_reps_max: null,
        target_weight_kg: 16,
        ...overrides
    };
}

describe('Workouts → Edit Variant exercise rows (Round-2 Task 11)', () => {
    let env;

    beforeEach(() => {
        allowConsoleNoise();
        env = loadFrontendEnv({ withWorkout: true });
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('#14: loadExercisesForVariant renders rows on the shared elevated-teal-card surface', async () => {
        const { window, document } = env;

        window.apiCall = vi.fn().mockResolvedValue([
            exerciseFixture(),
            exerciseFixture({
                id: 502,
                order_index: 1,
                exercise_name: 'Dead Bug',
                target_sets: 2,
                target_reps_min: 10,
                target_reps_max: null,
                target_weight_kg: null
            })
        ]);

        await window.loadExercisesForVariant(7);

        const container = document.getElementById('workout-exercises-list');
        const rows = container.querySelectorAll('.wg-workouts-exercise-row');
        expect(rows.length).toBe(2);

        // Legacy surface classes must be gone from the rendered tree.
        expect(container.querySelector('.workout-exercise-card')).toBeNull();
        expect(container.querySelector('.workout-exercise-meta')).toBeNull();

        const [first, second] = rows;

        const firstTitle = first.querySelector('.wg-workouts-exercise-row__title');
        const firstMeta = first.querySelector('.wg-workouts-exercise-row__meta');
        const firstInfo = first.querySelector('.wg-workouts-exercise-row__info');
        expect(firstTitle).not.toBeNull();
        expect(firstMeta).not.toBeNull();
        expect(firstInfo).not.toBeNull();
        expect(firstTitle.textContent).toBe("1. Farmer's Walk");
        expect(firstMeta.textContent).toBe('3 sets × 1 reps @ 16kg');

        const secondMeta = second.querySelector('.wg-workouts-exercise-row__meta');
        expect(secondMeta.textContent).toBe('2 sets × 10 reps');

        // Delete button keeps the shared icon-action base + legacy position
        // reset, plus the new scoped hover class for dark-surface contrast.
        const del = first.querySelector('.wg-workouts-exercise-row__delete');
        expect(del).not.toBeNull();
        expect(del.classList.contains('icon-action-btn')).toBe(true);
        expect(del.classList.contains('delete')).toBe(true);
        expect(del.classList.contains('workout-delete-btn-inline')).toBe(true);
    });

    it('#14: structural .wg-workouts-exercise-row* CSS uses tokens only (no gradient, no hex colors)', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        // Extract every `.wg-workouts-exercise-row*` rule block.
        const blockRe = /\.wg-workouts-exercise-row[^{]*\{([^}]*)\}/g;
        const blocks = [];
        let match;
        while ((match = blockRe.exec(css)) !== null) {
            blocks.push({ head: match[0].slice(0, match[0].indexOf('{')).trim(), body: match[1] });
        }
        // Must have at least the 5 rules we added (row, __info, __title,
        // __meta, __delete:hover).
        expect(blocks.length).toBeGreaterThanOrEqual(5);

        for (const b of blocks) {
            expect(b.body, `linear-gradient found in ${b.head}`).not.toMatch(/linear-gradient\(/i);
            expect(b.body, `hex color found in ${b.head}`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        }

        // Structural (non-hover) rules are strictly token-only: no raw rgba
        // literals in background / border / text tokens.
        for (const b of blocks) {
            if (/:hover\b/.test(b.head)) continue;
            expect(b.body, `raw rgba/rgb literal found in ${b.head}`).not.toMatch(/\brgba?\s*\(/);
        }
    });

    it('#14: the row uses the same elevated-teal-card recipe as .wg-workouts-next-card / .wg-meds-next-intake-card', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        const rowBlock = css.match(/\.wg-workouts-exercise-row\s*\{([^}]*)\}/);
        expect(rowBlock).not.toBeNull();
        const body = rowBlock[1];

        expect(body).toMatch(/background\s*:\s*var\(--wg-bg-card\)/);
        expect(body).toMatch(/border\s*:\s*1px\s+solid\s+var\(--wg-border-hairline\)/);
        expect(body).toMatch(/border-radius\s*:\s*var\(--wg-radius-card\)/);
        expect(body).toMatch(/box-sizing\s*:\s*border-box/);
    });

    it('#14: legacy .workout-exercise-card / .workout-exercise-meta rules are removed from styles.css', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        expect(css).not.toMatch(/^\s*\.workout-exercise-card\s*\{/m);
        expect(css).not.toMatch(/^\s*\.workout-exercise-meta\s*\{/m);
    });

    it('#14: loadExercisesForVariant no longer references the legacy class strings', () => {
        const source = fs.readFileSync(WORKOUT_JS_PATH, 'utf8');
        const fnStart = source.indexOf('async function loadExercisesForVariant(');
        expect(fnStart).toBeGreaterThan(-1);
        // Grab ~3000 chars forward — large enough to span the function body.
        const fnSlice = source.slice(fnStart, fnStart + 3000);

        expect(fnSlice).not.toMatch(/['"]workout-exercise-card['"]/);
        expect(fnSlice).not.toMatch(/['"]workout-exercise-meta['"]/);

        // New classes present.
        expect(fnSlice).toMatch(/['"]wg-workouts-exercise-row['"]/);
        expect(fnSlice).toMatch(/['"]wg-workouts-exercise-row__info['"]/);
        expect(fnSlice).toMatch(/['"]wg-workouts-exercise-row__title['"]/);
        expect(fnSlice).toMatch(/['"]wg-workouts-exercise-row__meta['"]/);
        expect(fnSlice).toMatch(/wg-workouts-exercise-row__delete/);
    });
});
