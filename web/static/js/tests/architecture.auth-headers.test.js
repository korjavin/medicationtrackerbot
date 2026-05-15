// architecture.auth-headers.test.js
//
// Lint guard for the auth-header consolidation (2026-05-13 plan).
//
// Every Telegram-authenticated request from the frontend must construct
// its headers through `window.makeAuthHeaders()` (defined in
// `web/static/js/core/api.js`). Raw `X-Telegram-Init-Data` string
// literals or `Authorization: tma ...` header forms anywhere else in
// `web/static/js/` indicate a new direct-fetch call site that bypassed
// the helper.
//
// Excluded from the scan:
//   - `core/api.js` — canonical home of `makeAuthHeaders`.
//   - `sw-api-helper.js` — Service Worker auth path covered by the
//     separate SW handler unification plan
//     (docs/plans/2026-05-13-sw-handler-unification.md).
//   - `tests/` — test files legitimately assert on the header name.
//   - `vendor/` — third-party code, not ours to refactor.
//
// On failure, the message points at the helper so the fix is mechanical:
// replace the inline header literal with `window.makeAuthHeaders()` (or
// `makeAuthHeaders({ 'Content-Type': 'application/json' })` for bodies).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const JS_ROOT = path.join(REPO_ROOT, 'web/static/js');

const EXCLUDED_RELATIVE = new Set([
    'web/static/js/core/api.js',
    'web/static/js/sw-api-helper.js',
]);

const EXCLUDED_DIRS = new Set(['tests', 'vendor', 'node_modules']);

// Literals that mean "constructing a Telegram auth header inline".
// Each entry: [regex, hint]. Patterns cover all three string-literal
// quote styles (single, double, backtick) because the pre-consolidation
// CSV-export code used a backtick template literal — the exact form a
// regression is most likely to take. The Authorization-key regex also
// matches the unquoted-key shorthand (`{ Authorization: \`tma ${...}\` }`)
// since ES object literals permit bare identifiers as keys and that is a
// plausible regression shape.
const FORBIDDEN_PATTERNS = [
    [/["'`]X-Telegram-Init-Data["'`]/g, 'X-Telegram-Init-Data header literal'],
    [/(?:["'`]Authorization["'`]|\bAuthorization\b)\s*:\s*["'`]tma\s/g, "Authorization: 'tma ...' literal"],
    [/headers\s*\[\s*["'`]Authorization["'`]\s*\]\s*=\s*["'`]tma\s/g, "headers['Authorization'] = 'tma ...' assignment"],
];

function collectJsFiles(dir, results = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!EXCLUDED_DIRS.has(entry.name)) {
                collectJsFiles(full, results);
            }
        } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
            results.push(full);
        }
    }
    return results;
}

describe('Architecture – auth-header helper guard', () => {
    it('no raw X-Telegram-Init-Data / Authorization: tma literals outside the helper', () => {
        const jsFiles = collectJsFiles(JS_ROOT);
        expect(jsFiles.length).toBeGreaterThan(0);

        const violations = [];

        for (const filePath of jsFiles) {
            const rel = path.relative(REPO_ROOT, filePath);
            if (EXCLUDED_RELATIVE.has(rel)) continue;

            const source = fs.readFileSync(filePath, 'utf8');
            const lines = source.split('\n');

            for (const [pattern, hint] of FORBIDDEN_PATTERNS) {
                pattern.lastIndex = 0;
                let match;
                while ((match = pattern.exec(source)) !== null) {
                    const upTo = source.slice(0, match.index);
                    const lineNo = upTo.split('\n').length;
                    const lineText = (lines[lineNo - 1] || '').trim();
                    violations.push(`${rel}:${lineNo}: ${hint} — ${lineText}`);
                }
            }
        }

        if (violations.length > 0) {
            throw new Error(
                `Raw Telegram auth-header literal(s) found outside the helper.\n` +
                `Use \`window.makeAuthHeaders()\` from web/static/js/core/api.js ` +
                `instead of constructing { 'X-Telegram-Init-Data': ... } or ` +
                `{ 'Authorization': 'tma ...' } inline. Pass extras (e.g. ` +
                `{ 'Content-Type': 'application/json' }) as the optional argument:\n\n` +
                violations.map(v => `  • ${v}`).join('\n')
            );
        }
    });
});
