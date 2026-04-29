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
    'window.initOIDCSetupBanner',       // app.js — renders the OIDC setup banner inside the Settings card; exposed for test coverage of the enabled path
    'window.healthOverviewCacheKey',    // app.js — timezone-qualified IndexedDB key for health overview; shared with health.js to avoid formula divergence

    // Core modules
    'window.apiCallDirect',             // core/api.js — low-level fetch used by data-store.js
    'window.AppKernel',                 // core/app-kernel.js — module registry
    'window.ChartUtils',               // core/chart-utils.js — shared SVG chart utilities
    'window.ModalManager',              // core/modal-manager.js — modal lifecycle façade
    'window.AppStore',                  // core/store.js — ephemeral UI state

    // Features
    'window.handleDeepLinks',           // features/deeplink-router.js — called by bootstrap.js
    'window.TodayDashboard',            // features/today.js — aggregation contract consumed by the Today view renderer
    'window.WGCallAgent',               // features/elevenlabs-call.js — ElevenLabs conversational agent card on the Today screen; lazy-loads the convai-widget-embed script and mounts <elevenlabs-convai> after fetching a server-signed URL
    'window.WGPhoneChrome',             // components/wg-phone-chrome.js — Wandergeek decorative iPhone-frame wrapper (status bar, dynamic island, home indicator) around the SPA on desktop; collapses on mobile/PWA
    'window.WGIcons',                   // components/wg-icons.js — Wandergeek stroke-icon registry (iconSvg(name) returns an <svg>); consumed by wg-bottom-nav.js and later screens
    'window.WGBottomNav',               // components/wg-bottom-nav.js — canonical multi-row bottom nav; one slot per real section, no aggregator
    'window.rebuildCanonicalBottomNav', // features/bootstrap.js — re-mounts the canonical bottom nav with the current feature flags; called from settings.js after a feature toggle
    'window.WGSparkline',               // components/wg-sparkline.js — Wandergeek SVG sparkline for Today metric tiles; stroke colour is driven by CSS variant class, not a JS colour
    'window.WGBpChart',                 // components/wg-bp-chart.js — Wandergeek BP sys/dia chart (band + lines + dotted guides + last-point markers); colours resolve via CSS classes on SVG children, never inline
    'window.WGWeightChart',             // components/wg-weight-chart.js — Wandergeek single-series weight chart with optional goal-line overlay; colours resolve via CSS classes on SVG children, never inline
    'window.WGWorkoutChart',            // components/wg-workout-chart.js — Wandergeek single-series workout activity chart for the Stats sub-tab (sessions-per-week or volume); colours resolve via CSS classes on SVG children, never inline
    'window.WGSleepChart',              // components/wg-sleep-chart.js — Wandergeek sleep stacked-bar (deep/light/rem/awake) + HR overlay chart for the Health Overview sub-tab; sleep-stage fills + HR line/dot/label resolve via CSS classes on SVG children, never inline
    'window.WGStepsChart',              // components/wg-steps-chart.js — Wandergeek single-series steps bar chart for the Health Overview sub-tab; bar fill + rotated in-bar count label colour resolve via CSS classes on SVG children, never inline
    'window.WGVitalsChart',             // components/wg-vitals-chart.js — Wandergeek area+line vitals chart (HR / SpO2 / Stress) for the Health Overview sub-tab; parameterised by vital, line + area fill colour resolve via --wg-health-vitals-{vital}-* tokens on CSS classes, never inline
    'window.WGMacroBar',                // components/wg-macro-bar.js — Wandergeek Food-screen macro row (label + inset track + mono value/target); fill colour comes from .wg-macro-bar__fill--<variant> classes, fill width from a neutral --fill-pct custom property
    'window.WGToggle',                  // components/wg-toggle.js — Wandergeek toggle primitive for the Settings screen (Phase 9); renders a pill + knob driven by a hidden <input type="checkbox"> so the existing id-based change-event wiring in features/settings.js keeps binding unchanged
    'window.WGSettings',                // components/wg-settings.js — Wandergeek Settings-screen render helpers (Phase 9, Task 2): section() + row() + infoRow() DOM factories consumed by the Settings reskin to build sectioned cards, canonical left-title/right-control rows, and read-only timezone info rows
    'window.AppBackButton',             // features/back-button.js — wires Telegram WebApp BackButton to section → Today navigation
    'window.editNote',                  // features/health.js — called from dynamically-built edit buttons in notes rows

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
    'window.weightUnitPreference',      // app.js / features/weight.js — user's preferred weight display unit ('kg' or 'lb'); hydrated from /api/bootstrap, read synchronously by the weight modal on open, written back via PATCH /api/settings/weight-unit when the user submits in a different unit
    'window.commitAuthoritativeWeightUnit', // app.js — keeps window.weightUnitPreference and the Settings PATCH failure-revert target in sync; called by features/weight.js after an out-of-band modal-side PATCH succeeds so a later Settings PATCH failure doesn't revert UI to a stale unit
    'window.setWeightUnitPreference',   // app.js — serial-queued PATCH /api/settings/weight-unit helper; features/weight.js modal-submit routes through it (with reload:false) so a concurrent Settings click and modal inference cannot land at the server in arrival order opposite to the user's click order
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
