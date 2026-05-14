/**
 * architecture.no-module-state.test.js
 *
 * Lint guard: files under `web/static/js/features/{workout,food}/*.js` may not
 * declare module-level mutable state (top-level `let` or `var`). Each sub-file
 * must wrap its mutable state in a closure (typical pattern: `window.X =
 * (function () { let _state = ...; ... })()`) so the implicit "at most one
 * editing form open" invariants from the original god-files cannot leak back
 * in.
 *
 * Allowed exceptions (the orchestrator escape hatch):
 *   - A single `let _state = ...` declaration is permitted if the same line
 *     also carries the comment `// module-state: <reason>`. This is the
 *     documented form referenced in docs/plans/2026-05-13-split-app-js.md
 *     (Task 7) and 2026-05-13-split-workout-food-features.md (Task 3).
 *
 * Adding a new sub-file:
 *   - Wrap your mutable state in an IIFE that exposes the public API on
 *     `window.X`. See `today.js` for the reference shape.
 *   - If you genuinely need one annotated module-level `_state`, write it as:
 *       let _state = { ... }; // module-state: <one-line reason>
 *   - Anything else fails this test by design.
 *
 * `const` declarations at module scope are fine — those are compile-time
 * constants, not mutable state.
 *
 * See docs/plans/2026-05-13-split-workout-food-features.md → Task 3.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Sub-directories under web/static/js/features/ that the guard scans. Sub-files
// in these directories must not introduce module-level mutable state. The
// app.js split plan (a separate effort) will extend this list to `core/` and
// the top-level `features/` once those splits land.
const SCAN_DIRS = [
    'web/static/js/features/workout',
    'web/static/js/features/food',
];

// Matches a top-level `let foo = ...` or `var foo = ...` line — i.e. column
// zero, no leading whitespace. Anything indented is inside a function / IIFE /
// block and therefore not module-level state.
const TOP_LEVEL_LET_VAR_RE = /^(let|var)\s+/;

// The annotated escape hatch: `let _state = ...; // module-state: <reason>`.
// The comment must appear on the same line as the declaration so a code review
// surfaces both at once.
const ANNOTATED_STATE_RE = /^let\s+_state\s*=.*\/\/\s*module-state:\s*\S+/;

function listJsFiles(absDir) {
    if (!fs.existsSync(absDir)) return [];
    return fs.readdirSync(absDir)
        .filter((name) => name.endsWith('.js') && !name.endsWith('.min.js'))
        .map((name) => path.join(absDir, name))
        .sort();
}

function findModuleStateOffenders(absFile) {
    const source = fs.readFileSync(absFile, 'utf8');
    const lines = source.split('\n');
    const offenders = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!TOP_LEVEL_LET_VAR_RE.test(line)) continue;
        if (ANNOTATED_STATE_RE.test(line)) continue;
        offenders.push({ line: i + 1, text: line });
    }
    return offenders;
}

describe('Architecture – no module-level mutable state in split sub-files', () => {
    it('every features/{workout,food}/*.js has no unannotated top-level let/var', () => {
        const failures = [];
        for (const relDir of SCAN_DIRS) {
            const absDir = path.join(REPO_ROOT, relDir);
            for (const absFile of listJsFiles(absDir)) {
                const offenders = findModuleStateOffenders(absFile);
                if (offenders.length === 0) continue;
                const rel = path.relative(REPO_ROOT, absFile);
                for (const off of offenders) {
                    failures.push(`  • ${rel}:${off.line}  ${off.text.trim()}`);
                }
            }
        }
        if (failures.length > 0) {
            throw new Error(
                'Module-level mutable state (top-level `let` / `var`) is forbidden in the\n' +
                'split sub-files. Wrap state in a closure (typical pattern:\n' +
                '`window.X = (function () { let _state = {...}; ... })()`) and re-run.\n' +
                'If you genuinely need a single module-level reducer, write it as:\n' +
                '  let _state = { ... }; // module-state: <one-line reason>\n\n' +
                'Offenders:\n' +
                failures.join('\n')
            );
        }
    });

    it('the annotated-state escape hatch is parseable', () => {
        expect(ANNOTATED_STATE_RE.test('let _state = { x: 1 }; // module-state: weight-unit reducer')).toBe(true);
        expect(ANNOTATED_STATE_RE.test('let _state = {}; // module-state: x')).toBe(true);
        expect(ANNOTATED_STATE_RE.test('let _state = {}; // module-state:')).toBe(false);
        expect(ANNOTATED_STATE_RE.test('let _state = {};')).toBe(false);
        expect(ANNOTATED_STATE_RE.test('let foo = {}; // module-state: x')).toBe(false);
    });

    it('the top-level let/var matcher rejects indented declarations', () => {
        expect(TOP_LEVEL_LET_VAR_RE.test('let x = 1')).toBe(true);
        expect(TOP_LEVEL_LET_VAR_RE.test('var x = 1')).toBe(true);
        expect(TOP_LEVEL_LET_VAR_RE.test('    let x = 1')).toBe(false);
        expect(TOP_LEVEL_LET_VAR_RE.test('\tlet x = 1')).toBe(false);
        expect(TOP_LEVEL_LET_VAR_RE.test('const x = 1')).toBe(false);
    });

    it('scans at least one file in each target directory', () => {
        // Guard against the test silently passing because we mis-pathed the
        // scan dirs. If either workout/ or food/ are missing, that's a load
        // order bug worth catching here.
        for (const relDir of SCAN_DIRS) {
            const absDir = path.join(REPO_ROOT, relDir);
            const files = listJsFiles(absDir);
            expect(files.length, `expected JS files under ${relDir}`).toBeGreaterThan(0);
        }
    });
});
