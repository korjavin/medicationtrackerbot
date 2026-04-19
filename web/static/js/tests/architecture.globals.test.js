/**
 * architecture.globals.test.js
 *
 * Lint guard: asserts that no JS source file introduces an explicit
 * `window.<name> = ` assignment that is not on the approved list below.
 *
 * Intent: prevent uncontrolled proliferation of window globals.
 * Each entry in ALLOWED_GLOBALS must have a brief justification.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const JS_ROOT = path.join(REPO_ROOT, 'web/static/js');

/**
 * Approved window globals. New globals require a PR updating this list.
 *
 * Format: 'window.Name': reason
 */
const ALLOWED_GLOBALS = new Set([
    // Infrastructure — stable, out of scope for frontend refactoring
    'window.MedTrackerDB',              // db.js — IndexedDB facade
    'window.SyncManager',               // sync.js — offline sync manager
    'window.offlineAwareApiCall',       // sync.js — public API entry point
    'window.SyncDebug',                 // sync.js — dev-mode diagnostics
    'window.DataStore',                 // data-store.js — SWR cache layer
    'window.MedTrackerPush',            // push.js — web push manager

    // App shell
    'window.initServiceWorker',         // app-shell.js — SW registration
    'window.showUpdateToast',           // app-shell.js — SW update banner

    // App core (app.js)
    'window.userInitData',              // app.js — Telegram initData for feature files
    'window.tg',                        // app.js — Telegram.WebApp alias; exposed as window.tg
    //   (not const) so feature files can safely alias it
    //   without a const-redeclaration SyntaxError
    'window.onDataStoreUnauthorized',   // app.js — callback consumed by data-store.js
    'window.requestTabRefresh',         // app.js — called by data-store.js on change event
    'window.reloadCurrentTab',          // app.js — called by data-store.js + sync.js
    'window.renderSettingsTimeInfo',    // app.js — renders read-only timezone/server clock info in settings

    // Core modules
    'window.apiCallDirect',             // core/api.js — low-level fetch used by data-store.js
    'window.AppKernel',                 // core/app-kernel.js — module registry
    'window.ChartUtils',               // core/chart-utils.js — shared SVG chart utilities
    'window.ModalManager',              // core/modal-manager.js — modal lifecycle façade
    'window.AppStore',                  // core/store.js — ephemeral UI state

    // Features
    'window.handleDeepLinks',           // features/deeplink-router.js — called by bootstrap.js
    'window.TodayDashboard',            // features/today.js — aggregation contract consumed by the Today view renderer
    'window.SectionHeader',             // components/section-header.js — factory for sticky section headers with back-to-Today affordance
    'window.AppBackButton',             // features/back-button.js — wires Telegram WebApp BackButton to section → Today navigation

    // features/settings.js — feature toggles, food targets, reminder settings
    'window.applyFeatureSettings',      // features/settings.js — applies feature toggles to DOM and state
    'window.featureSettings',           // features/settings.js — ephemeral cache of current feature flags
    'window.saveTabOrder',              // features/settings.js - persists Today card order to DB
    'window.featureSettingsLoaded',     // features/settings.js — flag: settings have been fetched at least once
    'window.switchTab',                 // features/settings.js — re-exported tab switcher used by applyFeatureSettings
    'window.loadFeatureSettings',       // features/settings.js — SWR loader for /api/settings/features
    'window.foodTargets',               // features/settings.js — ephemeral cache of food macro targets
    'window.loadFoodTargets',           // features/settings.js — SWR loader for /api/food/settings/targets
    'window.saveFoodTargets',           // features/settings.js — POSTs updated food targets to backend
    'window.safeAlert',                 // features/settings.js — wrapped alert used after save actions
    'window.loadFoodLogs',              // features/settings.js — triggers food log reload after target save
    'window.toggleFeatureSetting',      // features/settings.js — toggles a single feature flag via API
    'window.loadSettings',              // features/settings.js — loads all settings subsections in parallel
]);

/**
 * Recursively collect *.js files, skipping tests/ and *.min.js
 */
function collectJsFiles(dir, results = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'tests' && entry.name !== 'node_modules') {
                collectJsFiles(full, results);
            }
        } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
            results.push(full);
        }
    }
    return results;
}

/**
 * Regex that matches an explicit window assignment:
 *   window.Foo =   (but NOT window.Foo.bar = or window.Foo?.bar)
 */
const WINDOW_ASSIGN_RE = /window\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g;

describe('Architecture – window globals guard', () => {
    it('no JS file introduces an unapproved explicit window.* assignment', () => {
        const jsFiles = collectJsFiles(JS_ROOT);
        expect(jsFiles.length).toBeGreaterThan(0);

        const violations = [];

        for (const filePath of jsFiles) {
            const source = fs.readFileSync(filePath, 'utf8');
            const rel = path.relative(REPO_ROOT, filePath);
            let match;
            WINDOW_ASSIGN_RE.lastIndex = 0;
            while ((match = WINDOW_ASSIGN_RE.exec(source)) !== null) {
                const name = `window.${match[1]}`;
                // Skip chained property access: window.Foo.bar = or window.Foo?.bar =
                const charAfterMatch = source[match.index + match[0].length];
                const precedingFull = match[0]; // e.g. "window.Foo ="
                // If the char right after 'window.Name' (before ' =') is '.' or '?', skip it
                const nameEnd = match.index + 'window.'.length + match[1].length;
                const charAfterName = source[nameEnd];
                if (charAfterName === '.' || charAfterName === '?') continue;
                if (!ALLOWED_GLOBALS.has(name)) {
                    // Skip == and === comparisons: the match ends at the first '=',
                    // so if the very next character is also '=', this is a comparison
                    // (e.g. window.FOO === value) not an assignment.
                    if (charAfterMatch === '=') continue;
                    violations.push(`${rel}: ${name}`);
                }
            }
        }

        if (violations.length > 0) {
            throw new Error(
                `Unapproved window.* assignments found.\n` +
                `Add to ALLOWED_GLOBALS in architecture.globals.test.js with a justification:\n\n` +
                violations.map(v => `  • ${v}`).join('\n')
            );
        }
    });
});
