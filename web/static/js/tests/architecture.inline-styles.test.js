/**
 * architecture.inline-styles.test.js
 *
 * Lint guard: asserts that the Phase 4 Food + Phase 5 Meds files do not
 * introduce inline style= attributes or direct .style.<prop> assignments
 * beyond the explicit allowlist below. Each allowed entry must carry a
 * one-line justification explaining why CSS classes + tokens alone
 * cannot express the same visual value.
 *
 * Scope: narrowly targets the files called out in the Phase 4 + Phase 5
 * acceptance criteria (docs/plans/2026-04-XX-wandergeek-phase4-food.md
 * Task 8, docs/plans/2026-04-XX-wandergeek-phase5-meds.md Task 9). Other
 * files retain pre-reskin inline styles and are covered by their own
 * phase rewrites.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const SCOPED_FILES = [
    'web/static/js/features/food.js',
    'web/static/js/features/meds.js',
    'web/static/js/components/wg-macro-bar.js',
];

/**
 * Allowlist format: `${relativePath}:${lineNumber}` → justification.
 *
 * Only exact file+line matches are whitelisted — any move requires a
 * refreshed entry, which forces a code-review checkpoint when an inline
 * style migrates or a new one appears.
 */
const ALLOWED = new Map([
    [
        'web/static/js/components/wg-macro-bar.js:85',
        "style.setProperty on a neutral CSS custom property (--fill-pct) — CSS class reads it via width: var(--fill-pct, 0%); no hardcoded visual value lives in JS",
    ],
    [
        'web/static/js/features/food.js:2123',
        "legacy renderFoodTargetProgress (week/2-week aggregation view) — paper-era path not targeted by Phase 4 (daily-total rewrite); slated for a follow-up phase alongside the remaining .food-target-* CSS",
    ],
    [
        'web/static/js/features/food.js:2124',
        "legacy renderFoodTargetProgress (week/2-week aggregation view) — paper-era path not targeted by Phase 4 (daily-total rewrite); slated for a follow-up phase alongside the remaining .food-target-* CSS",
    ],
    [
        'web/static/js/features/meds.js:78',
        "pre-Phase-5 show/hide toggle for the RxNorm display row — preserved as-is during the Task 1 extraction from app.js (no-behavior-change extraction); CSS-class migration tracked separately",
    ],
    [
        'web/static/js/features/meds.js:80',
        "pre-Phase-5 show/hide toggle for the RxNorm display row — preserved as-is during the Task 1 extraction from app.js (no-behavior-change extraction); CSS-class migration tracked separately",
    ],
    [
        'web/static/js/features/meds.js:93',
        "pre-Phase-5 show/hide toggle for the restock-section modal block — preserved as-is during the Task 1 extraction from app.js; inventory-fields sibling already uses .hidden class, this row slated for the same migration",
    ],
    [
        'web/static/js/features/meds.js:97',
        "pre-Phase-5 show/hide toggle for the restock-section modal block — preserved as-is during the Task 1 extraction from app.js; inventory-fields sibling already uses .hidden class, this row slated for the same migration",
    ],
    [
        'web/static/js/features/meds.js:1128',
        "pre-Phase-5 show/hide toggle in showMedicationConfirmModal (edit/log_past branch) — preserved as-is during the Task 1 extraction; modal is a paper-era structure not rewritten in Phase 5",
    ],
    [
        'web/static/js/features/meds.js:1139',
        "pre-Phase-5 show/hide toggle for the snooze button in edit/log_past mode — preserved as-is during the Task 1 extraction; modal is a paper-era structure not rewritten in Phase 5",
    ],
    [
        'web/static/js/features/meds.js:1145',
        "pre-Phase-5 show/hide toggle in showMedicationConfirmModal (confirm branch) — preserved as-is during the Task 1 extraction; modal is a paper-era structure not rewritten in Phase 5",
    ],
    [
        'web/static/js/features/meds.js:1157',
        "pre-Phase-5 show/hide toggle for the snooze button in confirm mode — preserved as-is during the Task 1 extraction; modal is a paper-era structure not rewritten in Phase 5",
    ],
    [
        'web/static/js/features/meds.js:1162',
        "pre-Phase-5 show/hide toggle for the skip button in confirm mode — preserved as-is during the Task 1 extraction; modal is a paper-era structure not rewritten in Phase 5",
    ],
    [
        'web/static/js/features/meds.js:1170',
        "pre-Phase-5 show/hide toggle for the skip button in non-confirm mode — preserved as-is during the Task 1 extraction; modal is a paper-era structure not rewritten in Phase 5",
    ],
]);

const INLINE_STYLE_RE = /style="|\.style\./;

describe('Architecture – Food inline-styles guard', () => {
    it('Phase 4 Food files contain no un-allowlisted inline styles', () => {
        const violations = [];

        for (const rel of SCOPED_FILES) {
            const full = path.join(REPO_ROOT, rel);
            const source = fs.readFileSync(full, 'utf8');
            const lines = source.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (INLINE_STYLE_RE.test(lines[i])) {
                    const key = `${rel}:${i + 1}`;
                    if (!ALLOWED.has(key)) {
                        violations.push(`${key}: ${lines[i].trim()}`);
                    }
                }
            }
        }

        if (violations.length > 0) {
            throw new Error(
                `Un-allowlisted inline styles found in Phase 4 Food files.\n` +
                `Either remove the inline style or add to ALLOWED in ` +
                `architecture.inline-styles.test.js with a one-line justification:\n\n` +
                violations.map(v => `  • ${v}`).join('\n')
            );
        }

        // Sanity: allowlist entries must still reference live lines —
        // if a file shrinks or a line moves, force a re-review.
        for (const [key] of ALLOWED) {
            const [rel, lineStr] = key.split(':');
            const lineNum = Number(lineStr);
            const full = path.join(REPO_ROOT, rel);
            const source = fs.readFileSync(full, 'utf8');
            const lines = source.split('\n');
            const line = lines[lineNum - 1] || '';
            expect(
                INLINE_STYLE_RE.test(line),
                `Stale allowlist entry ${key} — no inline style on that line; ` +
                `remove it from ALLOWED in architecture.inline-styles.test.js.`
            ).toBe(true);
        }
    });
});
