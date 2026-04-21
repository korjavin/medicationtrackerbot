/**
 * architecture.inline-styles.test.js
 *
 * Lint guard: asserts that the Phase 4 Food files do not introduce
 * inline style= attributes or direct .style.<prop> assignments beyond
 * the explicit allowlist below. Each allowed entry must carry a
 * one-line justification explaining why CSS classes + tokens alone
 * cannot express the same visual value.
 *
 * Scope: narrowly targets the two files called out in the Phase 4
 * acceptance criterion (docs/plans/2026-04-XX-wandergeek-phase4-food.md,
 * Task 8). Other files retain pre-Phase-4 inline styles and are covered
 * by their own phase rewrites.
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
        'web/static/js/features/food.js:2097',
        "legacy renderFoodTargetProgress (week/2-week aggregation view) — paper-era path not targeted by Phase 4 (daily-total rewrite); slated for a follow-up phase alongside the remaining .food-target-* CSS",
    ],
    [
        'web/static/js/features/food.js:2098',
        "legacy renderFoodTargetProgress (week/2-week aggregation view) — paper-era path not targeted by Phase 4 (daily-total rewrite); slated for a follow-up phase alongside the remaining .food-target-* CSS",
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
