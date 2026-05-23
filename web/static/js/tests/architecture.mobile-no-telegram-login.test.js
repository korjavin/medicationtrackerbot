// architecture.mobile-no-telegram-login.test.js
//
// Lint guard for the APK-strip-Telegram-login plan (2026-05-23).
//
// On the Capacitor APK, the embedded shell sets
// `window.__MEDTRACKER_BOOTSTRAP__.apiBase` before app.js runs (see
// core/native-bootstrap.js). The `checkAuth()` function in app.js branches on
// that signal and must return BEFORE any code path that builds the Telegram
// login UI — otherwise a server-side regression in the mobile auth contract
// (Task 1 of the plan) would let the Telegram login screen leak into the APK.
//
// This test is purely structural: it grep-locates the embedded-shell branch in
// app.js and asserts the Telegram-shaped strings only appear AFTER the branch
// returns. It does not exercise behaviour — it documents the invariant so a
// future refactor that reorders the function trips CI rather than the user's
// emulator.
//
// Forbidden strings (any of these reachable before the embedded-shell return
// would fail the test):
//   - "Login to Med Tracker"     — the login screen title
//   - "telegram-widget.js"        — the Telegram Login Widget script URL
//   - "login-tg-container"        — the login container CSS class
//   - "BOT_USERNAME"              — the global gating the Telegram widget
//
// Companion to: web/static/js/tests/architecture.no-telegram-in-html.test.js
// (which enforces the same guarantee for the served HTML).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APP_JS = path.join(REPO_ROOT, 'web/static/js/app.js');

const FORBIDDEN_STRINGS = [
    'Login to Med Tracker',
    'telegram-widget.js',
    'login-tg-container',
    'BOT_USERNAME',
];

// The embedded-shell branch is the `if (window.__MEDTRACKER_BOOTSTRAP__ ...)`
// inside `checkAuth()` that returns true before any login UI can render. We
// match the branch opener loosely so reformatting (line breaks, additional
// guards) doesn't trip the test — what matters is that the branch exists and
// returns before the forbidden strings.
const BRANCH_OPENER_RE = /if\s*\(\s*window\.__MEDTRACKER_BOOTSTRAP__\s*&&\s*window\.__MEDTRACKER_BOOTSTRAP__\.apiBase\s*\)/;

describe('Architecture — embedded-shell branch in checkAuth() returns before Telegram login UI', () => {
    it('app.js embedded-shell branch precedes any Telegram-login-flavoured string', () => {
        const source = fs.readFileSync(APP_JS, 'utf8');
        const lines = source.split('\n');

        // Locate the embedded-shell branch opener.
        let branchOpenerLine = -1;
        for (let i = 0; i < lines.length; i++) {
            if (BRANCH_OPENER_RE.test(lines[i])) {
                branchOpenerLine = i;
                break;
            }
        }
        expect(branchOpenerLine).toBeGreaterThanOrEqual(0);

        // Find the matching `return true;` that closes the branch. We scan
        // forward from the opener for the first `return true` line — the
        // branch in checkAuth() is a small block (~20 lines) that fetches
        // bootstrap and returns. A `return true` on a much later line would
        // still satisfy this test, which is fine: the only invariant we care
        // about is "the function exits before reaching the Telegram strings."
        let branchReturnLine = -1;
        for (let i = branchOpenerLine; i < lines.length; i++) {
            if (/^\s*return\s+true\s*;\s*$/.test(lines[i])) {
                branchReturnLine = i;
                break;
            }
        }
        expect(branchReturnLine).toBeGreaterThan(branchOpenerLine);

        // Every forbidden string must appear AFTER the branch's `return true;`.
        // If a forbidden string appears before the return, the embedded-shell
        // launch could hit the Telegram login flow before exiting — that's the
        // regression we're guarding against.
        const violations = [];
        for (const needle of FORBIDDEN_STRINGS) {
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(needle) && i <= branchReturnLine) {
                    violations.push(
                        `  • web/static/js/app.js:${i + 1}: "${needle}" appears at or before the embedded-shell branch return (line ${branchReturnLine + 1})`
                    );
                }
            }
        }

        if (violations.length > 0) {
            throw new Error(
                'The embedded-shell branch in checkAuth() must return BEFORE any ' +
                'Telegram-login UI code is reachable. A regression would let the ' +
                'Telegram login screen render inside the Capacitor APK. Move the ' +
                'embedded-shell branch earlier in checkAuth(), or move the ' +
                'Telegram-login code later. Violations:\n' + violations.join('\n')
            );
        }

        // Sanity: the forbidden strings ARE present in app.js (otherwise this
        // test would be trivially passing after a cleanup that removed the
        // login screen entirely — at which point this guard can be deleted).
        const allPresent = FORBIDDEN_STRINGS.every((needle) => source.includes(needle));
        expect(allPresent).toBe(true);
    });
});
