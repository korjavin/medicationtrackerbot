// architecture.no-direct-telegram.test.js
//
// Lint guard for the messenger-adapter decoupling (2026-05-13 plan).
//
// After Tasks 1–3, every reach into the Telegram WebApp SDK lives in
// `web/static/js/core/messenger-adapter.js`. Frontend feature code reads
// `window.MessengerAdapter` instead of `window.Telegram` / `Telegram.WebApp`
// so the same client serves a Telegram Mini App or a plain-browser PWA.
//
// This test scans every JS file under `web/static/js/` for the literal
// strings `window.Telegram` and `Telegram.WebApp` (case-sensitive) and
// asserts zero matches outside the allowed locations.
//
// Excluded from the scan:
//   - `core/messenger-adapter.js` — the one file allowed to reach in.
//   - `tests/` — test files legitimately mock or assert on the SDK.
//   - `vendor/` — third-party code, not ours to refactor.
//
// On failure, the message points at MessengerAdapter so the fix is
// mechanical: route the read through `window.MessengerAdapter.<method>()`.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const JS_ROOT = path.join(REPO_ROOT, 'web/static/js');

const EXCLUDED_RELATIVE = new Set([
    'web/static/js/core/messenger-adapter.js',
]);

const EXCLUDED_DIRS = new Set(['tests', 'vendor', 'node_modules']);

const FORBIDDEN_PATTERNS = [
    [/window\.Telegram/g, 'direct window.Telegram reach-in'],
    [/Telegram\.WebApp/g, 'direct Telegram.WebApp reach-in'],
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

describe('Architecture – no direct Telegram WebApp reach-ins', () => {
    it('no window.Telegram / Telegram.WebApp literals outside MessengerAdapter', () => {
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
                `Direct Telegram WebApp reach-in(s) found outside the adapter.\n` +
                `Route the read through \`window.MessengerAdapter\` (see ` +
                `web/static/js/core/messenger-adapter.js) instead of touching ` +
                `\`window.Telegram\` / \`Telegram.WebApp\` directly. The adapter ` +
                `surface (init, identityToken, authHeaderName, alert, confirm, ` +
                `showPopup, startParam, onBack/showBack/hideBack, isPresent) is ` +
                `the only allowed entry point so the same client serves a ` +
                `Telegram Mini App or a plain-browser PWA:\n\n` +
                violations.map(v => `  • ${v}`).join('\n')
            );
        }
    });
});
