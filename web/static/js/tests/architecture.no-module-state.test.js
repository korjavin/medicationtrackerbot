/**
 * architecture.no-module-state.test.js
 *
 * Lint guard: files under the scanned directories may not declare module-level
 * mutable state (top-level `let` or `var`). Each file must wrap its mutable
 * state in a closure (typical pattern: `window.X = (function () { let _state =
 * ...; ... })()`) so the implicit "at most one editing form open" invariants
 * from the original god-files cannot leak back in.
 *
 * Scanned directories:
 *   - web/static/js/core/                  (every *.js)
 *   - web/static/js/features/              (top-level *.js, not subdirs)
 *   - web/static/js/features/workout/      (every *.js)
 *   - web/static/js/features/food/         (every *.js)
 *
 * Allowed exceptions (the orchestrator escape hatch):
 *   - A single `let _state = ...` declaration is permitted if the same line
 *     also carries the comment `// module-state: <reason>`. This is the
 *     documented form referenced in docs/plans/2026-05-13-split-app-js.md
 *     (Task 7) and 2026-05-13-split-workout-food-features.md (Task 3).
 *
 * Grandfathered files:
 *   - A small set of legacy files still hold top-level `let`/`var` from before
 *     the split. Each entry in `GRANDFATHERED` below documents why the file
 *     is exempt and what extraction is expected to clear it. New entries are
 *     not accepted; the list only shrinks.
 *
 * Adding a new file:
 *   - Wrap your mutable state in an IIFE that exposes the public API on
 *     `window.X`. See `today.js` for the reference shape.
 *   - If you genuinely need one annotated module-level `_state`, write it as:
 *       let _state = { ... }; // module-state: <one-line reason>
 *   - Anything else fails this test by design.
 *
 * `const` declarations at module scope are fine — those are compile-time
 * constants, not mutable state.
 *
 * See docs/plans/2026-05-13-split-app-js.md → Task 7.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Directories scanned by the guard. `recursive: false` means only direct
// children are scanned; the sub-directory entries below scan their own files
// explicitly. This keeps `features/` from double-scanning into
// `features/workout/` and `features/food/`.
const SCAN_DIRS = [
    { rel: 'web/static/js/core', recursive: false },
    { rel: 'web/static/js/features', recursive: false },
    { rel: 'web/static/js/features/workout', recursive: false },
    { rel: 'web/static/js/features/food', recursive: false },
];

// Files that still hold top-level `let`/`var` from before the split. Each
// entry must document the state cluster and the expected follow-up. The list
// only shrinks: new files are not accepted here. PR reviewers should push
// back on any addition with "extract or wrap in a closure" instead.
const GRANDFATHERED = new Set([
    // navCtrl: WGBottomNav controller singleton owned by mountCanonicalBottomNav.
    // Pending extraction into a BottomNavState IIFE that owns the controller
    // handle. Tracked in the post-split follow-ups.
    'web/static/js/features/bootstrap.js',

    // bpSubmitInFlight: single-shot guard on the BP submit handler to defend
    // against double-tap. Pending wrap into the BP feature's own IIFE state.
    'web/static/js/features/bp.js',

    // health.js: diary-notes paging cursor, in-flight flag, generation counter,
    // pending-fresh holder, filter tag, has-more flag, and editing-note handle
    // (eight let-bindings around the notes pager). Pending extraction into a
    // NotesListState IIFE — separate plan from this app.js split.
    'web/static/js/features/health.js',

    // weight.js: cachedWeightLogs (modal seed cache), weightModalUnit (active
    // unit inside the modal), editingWeightLog (the row being edited), and
    // weightModalOpenGen (open-generation counter that cancels stale async
    // seeds). Pending wrap into a WeightModalState IIFE — the broader weight
    // module is on the workout/food follow-up split plan.
    'web/static/js/features/weight.js',
]);

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
    return fs.readdirSync(absDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.min.js'))
        .map((entry) => path.join(absDir, entry.name))
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

describe('Architecture – no module-level mutable state in split files', () => {
    it('every scanned *.js has no unannotated top-level let/var (unless grandfathered)', () => {
        const failures = [];
        for (const { rel } of SCAN_DIRS) {
            const absDir = path.join(REPO_ROOT, rel);
            for (const absFile of listJsFiles(absDir)) {
                const relFile = path.relative(REPO_ROOT, absFile);
                if (GRANDFATHERED.has(relFile)) continue;
                const offenders = findModuleStateOffenders(absFile);
                if (offenders.length === 0) continue;
                for (const off of offenders) {
                    failures.push(`  • ${relFile}:${off.line}  ${off.text.trim()}`);
                }
            }
        }
        if (failures.length > 0) {
            throw new Error(
                'Module-level mutable state (top-level `let` / `var`) is forbidden in the\n' +
                'split files. Wrap state in a closure (typical pattern:\n' +
                '`window.X = (function () { let _state = {...}; ... })()`) and re-run.\n' +
                'If you genuinely need a single module-level reducer, write it as:\n' +
                '  let _state = { ... }; // module-state: <one-line reason>\n\n' +
                'Offenders:\n' +
                failures.join('\n')
            );
        }
    });

    it('every grandfathered file actually exists and still has at least one offender', () => {
        // If a grandfathered entry no longer needs the exemption (offenders all
        // gone), the entry should be removed. This catches stale entries so the
        // list only shrinks over time.
        for (const relFile of GRANDFATHERED) {
            const absFile = path.join(REPO_ROOT, relFile);
            expect(fs.existsSync(absFile), `grandfathered file missing: ${relFile}`).toBe(true);
            const offenders = findModuleStateOffenders(absFile);
            expect(offenders.length, `grandfathered file no longer has top-level let/var — remove from GRANDFATHERED: ${relFile}`).toBeGreaterThan(0);
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
        // scan dirs.
        for (const { rel } of SCAN_DIRS) {
            const absDir = path.join(REPO_ROOT, rel);
            const files = listJsFiles(absDir);
            expect(files.length, `expected JS files under ${rel}`).toBeGreaterThan(0);
        }
    });
});
