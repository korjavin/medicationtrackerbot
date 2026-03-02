/**
 * Regression test for ReferenceError: loadBPReadings / loadWeightLogs is not defined
 *
 * Root cause: features/bp.js and features/weight.js each originally declared
 *   `const tg = window.Telegram.WebApp;`
 * In the browser all plain <script> tags share the same global lexical environment.
 * When app.js declares `const tg = ...` and then bp.js/weight.js also try to declare
 * `const tg = ...`, the browser throws:
 *   SyntaxError: Identifier 'tg' has already been declared
 * This aborts the entire feature script so loadBPReadings / loadWeightLogs are never
 * defined, and clicking the bp/weight tab throws ReferenceError.
 *
 * Fix: app.js assigns `window.tg = window.Telegram.WebApp` (not const, so no binding
 * in the global lexical environment). Feature files then `const tg = window.tg` which
 * is always safe regardless of what other scripts ran first.
 */
import { describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('bp/weight feature globals are available after full env load', () => {
    it('window.loadBPReadings is a function after loading all scripts', () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            expect(typeof window.loadBPReadings).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('window.loadWeightLogs is a function after loading all scripts', () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            expect(typeof window.loadWeightLogs).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('features/bp.js uses window.tg alias (not window.Telegram.WebApp directly) to avoid SyntaxError', () => {
        // app.js must NOT use `const tg = window.Telegram.WebApp` because that would
        // create a const binding in the global lexical environment. feature files then
        // can safely `const tg = window.tg` without collision.
        const fs = require('fs');
        const path = require('path');
        const bpJs = fs.readFileSync(
            path.resolve(__dirname, '../features/bp.js'),
            'utf8'
        );
        // Must NOT directly reference window.Telegram.WebApp as a const at top level
        expect(bpJs).not.toMatch(/^\s*const tg\s*=\s*window\.Telegram/m);
        // Must use the window.tg alias set by app.js
        expect(bpJs).toMatch(/const tg\s*=\s*window\.tg/);
    });

    it('features/weight.js uses window.tg alias (not window.Telegram.WebApp directly) to avoid SyntaxError', () => {
        const fs = require('fs');
        const path = require('path');
        const weightJs = fs.readFileSync(
            path.resolve(__dirname, '../features/weight.js'),
            'utf8'
        );
        expect(weightJs).not.toMatch(/^\s*const tg\s*=\s*window\.Telegram/m);
        expect(weightJs).toMatch(/const tg\s*=\s*window\.tg/);
    });

    it('app.js exposes window.tg so feature scripts can reference it safely', () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            expect(window.tg).toBeDefined();
            expect(window.tg).toBe(window.Telegram.WebApp);
        } finally {
            cleanup();
        }
    });
});
