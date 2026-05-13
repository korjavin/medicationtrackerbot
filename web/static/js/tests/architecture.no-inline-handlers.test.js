/**
 * architecture.no-inline-handlers.test.js
 *
 * Lint guard: asserts that no JS source file under `web/static/js/`
 * (excluding `tests/` and `vendor/`) contains an inline HTML event
 * handler attribute (`onclick="…"`, `onchange='…'`, etc.) inside a
 * string or template literal.
 *
 * Why: the deployed CSP in `internal/server/server.go` ships
 * `script-src 'self' https://telegram.org https://esm.sh blob: data:`
 * with no `'unsafe-inline'`. Under that policy, browsers parse but
 * silently DROP inline event handlers — so any template that builds
 * `<button onclick="…">…</button>` is dead UI.
 *
 * Wire events via `addEventListener` after the node is inserted (or
 * built with `document.createElement`). See the fix at
 * `docs/plans/2026-05-13-fix-food-inline-onclick.md` for the canonical
 * replacement pattern.
 */
import { describe, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const JS_ROOT = path.join(REPO_ROOT, 'web/static/js');

const INLINE_HANDLER_RE =
    /on(?:click|change|submit|input|load|error|focus|blur|keydown|keyup)=\s*['"][^'"]/i;

// Directories under JS_ROOT to skip (relative to JS_ROOT).
const SKIP_DIRS = new Set(['tests', 'vendor']);

function collectJsFiles(dir, acc) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const rel = path.relative(JS_ROOT, full);
            const top = rel.split(path.sep)[0];
            if (SKIP_DIRS.has(top)) continue;
            collectJsFiles(full, acc);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            acc.push(full);
        }
    }
    return acc;
}

describe('Architecture – no CSP-blocked inline event handlers', () => {
    it('no JS source file contains inline on*="…" attributes', () => {
        const files = collectJsFiles(JS_ROOT, []);
        const violations = [];

        for (const full of files) {
            const rel = path.relative(REPO_ROOT, full);
            const source = fs.readFileSync(full, 'utf8');
            const lines = source.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (INLINE_HANDLER_RE.test(lines[i])) {
                    violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                }
            }
        }

        if (violations.length > 0) {
            throw new Error(
                `Inline HTML event handler attributes found in JS source.\n` +
                `The deployed CSP (internal/server/server.go) has no 'unsafe-inline' ` +
                `in script-src, so inline on*="…" attributes are silently dropped by ` +
                `the browser.\n\n` +
                `Wire events via addEventListener instead — see ` +
                `docs/plans/2026-05-13-fix-food-inline-onclick.md for the canonical ` +
                `replacement pattern.\n\n` +
                violations.map(v => `  • ${v}`).join('\n')
            );
        }
    });
});
