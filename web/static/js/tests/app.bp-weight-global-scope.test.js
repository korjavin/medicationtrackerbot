/**
 * Regression test for ReferenceError: loadBPReadings / loadWeightLogs is not defined
 *
 * Root cause: features/bp.js and features/weight.js each had
 *   `const tg = window.Telegram.WebApp;`
 * In the browser, all plain <script> tags share the same global lexical environment.
 * Every `const` declaration at top-level goes into that shared environment.
 * So if app.js (or bp.js loaded first) declares `const tg`, any later script
 * that also tries `const tg` throws:
 *   SyntaxError: Identifier 'tg' has already been declared
 * This aborts the feature script entirely, so loadBPReadings / loadWeightLogs
 * are never defined and tab clicks throw ReferenceError.
 *
 * Fix:
 *  - app.js assigns `window.tg = window.Telegram.WebApp` (property, not const)
 *    and uses `window.tg.*` throughout — no const tg binding in global lexical env.
 *  - feature files use `window.tg.*` directly — no top-level const tg at all.
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

    it('app.js exposes window.tg so feature scripts can reference it safely', () => {
        const { window, cleanup } = loadFrontendEnv();
        try {
            expect(window.tg).toBeDefined();
            expect(window.tg).toBe(window.Telegram.WebApp);
        } finally {
            cleanup();
        }
    });

    it('features/bp.js has no top-level const tg declaration (would conflict in browser global scope)', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.resolve(__dirname, '../features/bp.js'), 'utf8');
        // Top-level `const tg = ...` in any <script> tag after app.js would cause
        // "SyntaxError: Identifier 'tg' has already been declared"
        expect(src).not.toMatch(/^\s*const tg\s*=/m);
    });

    it('features/weight.js has no top-level const tg declaration (would conflict in browser global scope)', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.resolve(__dirname, '../features/weight.js'), 'utf8');
        expect(src).not.toMatch(/^\s*const tg\s*=/m);
    });
});
