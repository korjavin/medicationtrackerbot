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
    'window.isServerError',             // sync.js — canonical 5xx-as-offline detector exposed so cached-fetch.js can keep the policy defined in one place
    'window.SyncDebug',                 // sync.js — dev-mode diagnostics
    'window.defineOfflineEntity',       // sync.js — factory shared by BP/weight/intake offline-write pipelines; exposed for tests and future entity additions
    'window.DataStore',                 // data-store.js — SWR cache layer
    'window.cachedFetch',               // cached-fetch.js — local-first read-through helper used by feature modules to render stale cache offline + power the freshness badge
    'window.OfflineNoCacheError',       // cached-fetch.js — typed error thrown when no cache exists and the network is unavailable; sections catch it to render an explicit empty state
    'window.MedTrackerPush',            // push.js — web push manager

    // App shell
    'window.initServiceWorker',         // app-shell.js — SW registration
    'window.showUpdateToast',           // app-shell.js — SW update banner
    'window.sendSwAuthToken',           // app-shell.js — posts the Telegram init-data blob to the active SW controller so its notification-action handlers can attach X-Telegram-Init-Data; called after SW registration, on controllerchange, and (inline) from app.js for the hot-cache reload case

    // App core (app.js)
    'window.userInitData',              // app.js — messenger identity token mirrored for feature files; sourced via window.MessengerAdapter.identityToken() (null in BrowserAdapter)
    'window.onDataStoreUnauthorized',   // app.js — callback consumed by data-store.js
    'window.requestTabRefresh',         // app.js — called by data-store.js on change event
    'window.reloadCurrentTab',          // app.js — called by data-store.js + sync.js
    'window.renderSettingsTimeInfo',    // app.js — renders read-only timezone/server clock info in settings
    'window.initOIDCSetupBanner',       // features/settings.js — renders the OIDC setup banner inside the Settings card; exposed for test coverage of the enabled path (Plan 2026-06-10 finish-app-js-split, Task 2)
    'window.healthOverviewCacheKey',    // features/today-loader.js — timezone-qualified IndexedDB key for health overview; shared with health.js to avoid formula divergence (Plan 2026-06-10 finish-app-js-split, Task 3)

    // Core modules
    'window.DemoBanner',                // core/demo-banner.js — demo-mode banner mount + 429 `demo_rate_limit` popup helper; mounted by auth-bootstrap.js when /api/bootstrap returns demo.enabled=true, invoked by core/api.js on 429 responses with a {error:'demo_rate_limit'} body
    'window.apiCallDirect',             // core/api.js — low-level fetch used by data-store.js
    'window.makeAuthHeaders',           // core/api.js — auth header construction shared by direct-fetch callers (streaming food product search, multipart food-photo upload, ElevenLabs URL fetch, BP/weight CSV exports) that cannot route through apiCallDirect
    'window.makeWriteHeaders',          // core/api.js — makeAuthHeaders + X-Client-ID for direct-fetch *write* sites (food photo POST, food description POST, food log DELETE) so the backend's notifyOnWriteMiddleware can echo the originating clientId back via source_client_id on the SSE payload — preventing self-origin banner regressions on long-running AI flows that exceed the 5s timing-window fallback
    'window.resolveApiUrl',             // core/api.js — prefixes endpoint paths with window.__MEDTRACKER_BOOTSTRAP__.apiBase when injected by the Capacitor shell (Phase 2a, Task 5); falls back to same-origin in browser PWA + server-mode builds
    'window.AppKernel',                 // core/app-kernel.js — module registry
    'window.ChartUtils',               // core/chart-utils.js — shared SVG chart utilities
    'window.escapeHtml',               // core/utils.js — canonical HTML entity escaper; consumed by sync.js debug panel + app.js medication schedule renderer
    'window.TimeFormat',               // core/time-format.js — Settings timezone/server-clock row helpers; exposes render(bundle), ensureTimer(), formatSettingsDateTime, parseRFC3339OffsetMinutes, formatFixedOffsetDateTime
    'window.ModalManager',              // core/modal-manager.js — modal lifecycle façade
    'window.AppStore',                  // core/store.js — ephemeral UI state
    'window.CacheKeys',                 // core/cache-keys.js — centralized registry of api_cache keys, tags, and freshness windows; registerAll() is invoked at boot so tag-based invalidation works regardless of which feature loader has executed
    'window.MessengerAdapter',          // core/messenger-adapter.js — the only file allowed to reach into window.Telegram.WebApp; exposes a thin interface (init, identityToken, authHeaderName, alert, confirm, showPopup, startParam, onBack/showBack/hideBack, isPresent) selected to TelegramAdapter or BrowserAdapter at boot so the same client code can serve a Telegram Mini App or a non-Telegram browser PWA
    'window.MessengerAdapterReady',     // core/messenger-adapter.js — Promise that resolves once loadTelegramSdk() finishes and the adapter has been (re-)picked; consumers that need the upgraded TelegramAdapter (rather than the sync BrowserAdapter default) can await this on the web build

    // Features
    'window.handleDeepLinks',           // features/deeplink-router.js — called by bootstrap.js
    'window.TodayDashboard',            // features/today.js — aggregation contract consumed by the Today view renderer
    'window.TodayLoader',               // features/today-loader.js — namespace mirroring the Today view loading orchestration (loadToday, _todayRender, _todayReadCaches, fetchSettingsBundle, todayFetchSpecs, fetchNextIntakePayload, loadNextIntakeCached, todayFoodKey, healthOverviewCacheKey) extracted from app.js (Plan 2026-06-10 finish-app-js-split, Task 3). The bare function names remain the live call path (app.js switchTab/reloadCurrentTab → loadToday; food/*.js + auth-bootstrap.js → todayFoodKey/loadToday; meds-history.js → fetchNextIntakePayload); this object documents the public surface and feeds the pure features/today.js (window.TodayDashboard) renderer.
    'window.WGCallAgent',               // features/elevenlabs-call.js — ElevenLabs conversational agent card on the Today screen; lazy-loads the convai-widget-embed script and mounts <elevenlabs-convai> after fetching a server-signed URL
    'window.WGCallIndicator',           // features/call-indicator.js — persistent floating pill above the bottom nav that surfaces ElevenLabs call state (connecting/in_call/error) across tab switches; subscribes to the wg-call-state window event
    'window.WGPhoneChrome',             // components/wg-phone-chrome.js — Wandergeek decorative iPhone-frame wrapper (status bar, dynamic island, home indicator) around the SPA on desktop; collapses on mobile/PWA
    'window.WGIcons',                   // components/wg-icons.js — Wandergeek stroke-icon registry (iconSvg(name) returns an <svg>); consumed by wg-bottom-nav.js and later screens
    'window.WGBottomNav',               // components/wg-bottom-nav.js — canonical multi-row bottom nav; one slot per real section, no aggregator
    'window.rebuildCanonicalBottomNav', // features/bootstrap.js — re-mounts the canonical bottom nav with the current feature flags; called from toggleFeatureSetting() in app.js after a feature toggle
    'window.WGSparkline',               // components/wg-sparkline.js — Wandergeek SVG sparkline for Today metric tiles; stroke colour is driven by CSS variant class, not a JS colour
    'window.WGRing',                    // components/wg-ring.js — Wandergeek SVG "closing ring" gauge (Plan 5); arc fill driven by the neutral --ring-progress custom property, colour resolves via .wg-ring__progress / .wg-ring--closed CSS classes
    'window.WGRingStack',               // components/wg-ring-stack.js — Wandergeek concentric ring stack (Plan 7 "concentric rings"); up to 5 wg-ring-style arcs sharing one SVG in canonical ring order, replacing the old per-ring row list; colour resolves via .wg-ring-stack__arc--<key> CSS classes, closed/sync-pending states are CSS-only
    'window.WGBpChart',                 // components/wg-bp-chart.js — Wandergeek BP sys/dia chart (band + lines + dotted guides + last-point markers); colours resolve via CSS classes on SVG children, never inline
    'window.WGWeightChart',             // components/wg-weight-chart.js — Wandergeek single-series weight chart with optional goal-line overlay; colours resolve via CSS classes on SVG children, never inline
    'window.WGWorkoutChart',            // components/wg-workout-chart.js — Wandergeek single-series workout activity chart for the Stats sub-tab (sessions-per-week or volume); colours resolve via CSS classes on SVG children, never inline
    'window.WGSleepChart',              // components/wg-sleep-chart.js — Wandergeek sleep stacked-bar (deep/light/rem/awake) + HR overlay chart for the Health Overview sub-tab; sleep-stage fills + HR line/dot/label resolve via CSS classes on SVG children, never inline
    'window.WGStepsChart',              // components/wg-steps-chart.js — Wandergeek single-series steps bar chart for the Health Overview sub-tab; bar fill + rotated in-bar count label colour resolve via CSS classes on SVG children, never inline
    'window.WGVitalsChart',             // components/wg-vitals-chart.js — Wandergeek area+line vitals chart (HR / SpO2 / Stress) for the Health Overview sub-tab; parameterised by vital, line + area fill colour resolve via --wg-health-vitals-{vital}-* tokens on CSS classes, never inline
    'window.WGMacroBar',                // components/wg-macro-bar.js — Wandergeek Food-screen macro row (label + inset track + mono value/target); fill colour comes from .wg-macro-bar__fill--<variant> classes, fill width from a neutral --fill-pct custom property
    'window.WGStaleBadge',              // components/wg-stale-badge.js — Wandergeek freshness badge mounted in section headers; renders "Updated Nm ago" / "Offline · Nh old" with neutral|warning tone classes for cachedFetch-driven local-first reads (Task 4 of the local-first read-resilience plan)
    'window.WGToggle',                  // components/wg-toggle.js — Wandergeek toggle primitive for the Settings screen (Phase 9); renders a pill + knob driven by a hidden <input type="checkbox"> so the existing id-based change-event wiring in app.js keeps binding unchanged
    'window.WGSettings',                // components/wg-settings.js — Wandergeek Settings-screen render helpers (Phase 9, Task 2): section() + row() + infoRow() DOM factories consumed by the Settings reskin to build sectioned cards, canonical left-title/right-control rows, and read-only timezone info rows
    'window.AppBackButton',             // features/back-button.js — wires Telegram WebApp BackButton to section → Today navigation
    'window.TZPlanBanner',              // features/tz-plan-banner.js — fetches GET /api/tz-plan/current and renders an actionable banner only when an active timezone-transition plan exists; bootstrap.js calls .refresh() once after auth
    'window.Gamification',              // features/journey.js — gamification Journey screen (Plan 3): load() reads GET /api/gamification/journey via cachedFetch + mounts the freshness chip; render(journey) paints level/HP/streak, the five rings, and the insight ladder. Gated on features.gamification (nav slot filtered before mount in bootstrap.js)
    'window.editNote',                  // features/health.js — called from dynamically-built edit buttons in notes rows

    // Settings / Food — feature toggles, food targets, reminder settings
    // (formerly produced by features/settings.js, deleted 2026-05-13;
    //  the live owners are app.js, features/food.js, and core/utils.js)
    'window.featureSettings',           // app.js — ephemeral cache of current feature flags
    'window.saveTabOrder',              // app.js — persists Today card order to DB
    'window.featureSettingsLoaded',     // app.js — flag: settings have been fetched at least once
    'window.switchTab',                 // app.js — top-level tab switcher (becomes window.switchTab via global scope)
    'window.FoodActions',               // features/food/photo.js — namespace exposing the food-photo picker (triggerPhotoPicker) so the Today shortcut tile can open it without first navigating to the Food section
    'window.foodTargets',               // features/food/log.js — ephemeral cache of food macro targets (defineProperty getter/setter into the log.js closure)
    'window.loadFoodTargets',           // features/food/log.js — SWR loader for /api/food/settings/targets
    'window.saveFoodTargets',           // features/food/log.js — POSTs updated food targets to backend
    'window.safeAlert',                 // core/utils.js — wrapped alert used after save actions
    'window.loadFoodLogs',              // features/food/log.js — triggers food log reload after target save
    'window.toggleFeatureSetting',      // features/settings.js — toggles a single feature flag via API (Plan 2026-06-10 finish-app-js-split, Task 2)
    'window.loadSettings',              // features/settings.js — loads all settings subsections in parallel (Plan 2026-06-10 finish-app-js-split, Task 2)
    'window.weightUnitPreference',      // app.js / features/weight.js — user's preferred weight display unit ('kg' or 'lb'); hydrated from /api/bootstrap, read synchronously by the weight modal on open, written back via PATCH /api/settings/weight-unit when the user submits in a different unit
    'window.WeightUnitState',           // features/weight-unit-state.js — kg/lb preference state machine extracted from app.js (Plan 2026-05-13, Task 2). Owns the closure-private serial PATCH queue, intent counter, rollback baseline, pending-PATCH count, and locally-mutated flag. Public: commitAuthoritative, applySegmentedState, applyAuthoritative, reconcile, setPreference.
    'window.commitAuthoritativeWeightUnit', // features/weight-unit-state.js — backwards-compat shim around WeightUnitState.commitAuthoritative; called by features/weight.js after an out-of-band modal-side PATCH succeeds so a later Settings PATCH failure doesn't revert UI to a stale unit
    'window.setWeightUnitPreference',   // features/weight-unit-state.js — backwards-compat shim around WeightUnitState.setPreference; features/weight.js modal-submit routes through it (with reload:false) so a concurrent Settings click and modal inference cannot land at the server in arrival order opposite to the user's click order

    // Auth + bootstrap hydration — extracted from app.js (Plan 2026-05-13, Task 3).
    'window.AuthBootstrap',                 // features/auth-bootstrap.js — namespace exposing applyBootstrapPayload, verifyAuthInBackground, clearSwBootstrapCache, bootstrapURL, hydrateFeatureSettingsFromBundle, hydrateMedicationsFromDexie, hydrateSectionsFromDexie, cacheApiSnapshot, normalizeSettingsBundle. checkAuth() in app.js orchestrates these.
    'window.medications',                   // features/auth-bootstrap.js — explicit mirror of the `var medications = []` global declared by app.js (line 612). applyBootstrapPayload and hydrateMedicationsFromDexie write here so features/meds.js (and any feature that reads the bare `medications` identifier) sees the new list before the cross-script var binding is observed.
    'window.initialAuthLoad',               // features/auth-bootstrap.js — explicit mirror of the `var initialAuthLoad = false` global declared by app.js (line 14). applyBootstrapPayload + hydrateMedicationsFromDexie flip this to `true` so features/meds.js's "first-paint after auth" guard fires once and only once.
    'window.SettingsState',                 // features/auth-bootstrap.js — closure-private reducer that owns featureSettings + featureSettingsLoaded; collapses the three-writer race (bootstrap, /api/init, Dexie hydration) behind applyBootstrapFeatures (fresh-data wins, marks loaded=true), applyDexieFeatures (skipped once loaded=true so stale-cache cannot stomp), setFeature (per-toggle update), getFeatureSettings, isLoaded.
    'window.applyBootstrapPayload',         // features/auth-bootstrap.js — backwards-compat shim for tests + features/bootstrap.js that call it by name.
    'window.verifyAuthInBackground',        // features/auth-bootstrap.js — backwards-compat shim for tests that call it by name.
    'window.clearSwBootstrapCache',         // features/auth-bootstrap.js — backwards-compat shim; app.js's checkAuth orchestrator calls it during hard auth rejection.
    'window.bootstrapURL',                  // features/auth-bootstrap.js — backwards-compat shim; checkAuth uses it via bare lookup.
    'window.hydrateFeatureSettingsFromBundle', // features/auth-bootstrap.js — backwards-compat shim; checkAuth's no-bootstrap fallback path uses it.
    'window.hydrateMedicationsFromDexie',   // features/auth-bootstrap.js — backwards-compat shim for tests that call it by name + checkAuth preflight.
    'window.hydrateSectionsFromDexie',      // features/auth-bootstrap.js — backwards-compat shim for tests that call it by name + checkAuth preflight.
    'window.cacheApiSnapshot',              // features/auth-bootstrap.js — backwards-compat shim consumed by cached-fetch.js (looks it up at call time) so the bootstrap-cache plumbing keeps working after the extraction.
    'window.normalizeSettingsBundle',       // features/auth-bootstrap.js — backwards-compat shim consumed by tests (app.unit.test.js asserts shape) and loadSettings() in app.js.

    // Push-modal coordination — extracted from app.js (Plan 2026-05-13, Task 4).
    'window.PushModalState',                // features/push-modal.js — collapses the five module-level vars (pendingMedConfirmIds, pendingMedConfirmScheduled, pendingWorkoutSessionId, pendingMedConfirmMode, pendingMedConfirmIntakeIds) into closure-private fields behind openMedConfirm({ids, scheduled, mode, intakeIds}), openWorkoutStart({sessionId}), clear, and getters. Opening one modal clears the other so a stale snooze/skip click after switching cannot fire against the previous modal's data.

    // Tab binding + activation — extracted from app.js (Plan 2026-05-13, Task 6).
    'window.TabController',                 // features/tab-controller.js — namespace exposing activateTabGroup, bindTabGroup, and bindOnce. bindOnce collapses the three module-level *ControlsBound flags previously declared in app.js (medication / measurement / notification) into a single shared closure-private registry, so reentrant bind* calls stay idempotent.

    // Medication scheduling utilities — extracted from app.js (Plan 2026-05-13, Task 5).
    'window.MedicationUtils',               // features/medication-utils.js — namespace exposing parseMedicationSchedule, getNextScheduledDate, getMedicationScheduleText, getLastTakenTimeMs. Consumed by features/meds.js (row renderer + bucket sort) and app.js's _todayRender helper-hand-off so today.js can compute a fallback next-dose from bootstrap.medications.
    'window.MedsHistory',                   // features/meds-history.js — namespace mirroring the medication add modal + form helpers, the Meds → History load + next-intake card, and the medication-confirm modal flow (confirm/skip/edit/log-past) extracted from app.js (Plan 2026-06-10 finish-app-js-split, Task 1). The bare function names remain the live call path (app.js bindMedicationControls/bindNotificationControls arrow wrappers, features/meds.js typeof-guarded optimistic helpers); this object documents the public surface.
    'window.parseMedicationSchedule',       // features/medication-utils.js — backwards-compat shim; today.js helper fallback path (features/today.js:163) looks it up by name when the aggregator opts arg omits helpers.
    'window.getNextScheduledDate',          // features/medication-utils.js — backwards-compat shim; today.js helper fallback path (features/today.js:165) looks it up by name when the aggregator opts arg omits helpers.
    'window.getMedicationScheduleText',     // features/medication-utils.js — backwards-compat shim; not currently called by name elsewhere but preserved alongside its siblings so external consumers (push deeplink, future feature files) keep resolving.
    'window.getLastTakenTimeMs',            // features/medication-utils.js — backwards-compat shim; not currently called by name elsewhere but preserved alongside its siblings.

    // Workout split (2026-05-13: features/workout.js → features/workout/*.js).
    // Each split file exposes a single public-API namespace on window; the
    // shared editing-form state for the legacy 6 "currently editing" globals
    // is consolidated on window.WorkoutEdit (each owner file defines its
    // closure-private getters/setters there).
    'window.WorkoutEdit',               // features/workout/{groups,variants,exercises,library}.js — closure-private editing-form state exposed via getter/setter accessors; eliminates the original 6 module-level `let current*` globals
    'window.WorkoutGroups',             // features/workout/groups.js — workout-groups CRUD public API
    'window.WorkoutVariants',           // features/workout/variants.js — variants CRUD public API
    'window.WorkoutExercises',          // features/workout/exercises.js — exercises (within variant) CRUD public API
    'window.WorkoutLibrary',            // features/workout/library.js — exercise library CRUD public API
    'window.WorkoutHistory',            // features/workout/history.js — history sub-tab loader public API
    'window.WorkoutMiBand',             // features/workout/miband.js — Mi-Band entry edit/delete modal public API
    'window.WorkoutMiBandState',        // features/workout/miband.js — closure-private "currently displayed Mi Band entry" reference exposed via getter/setter
    'window.WorkoutSessions',           // features/workout/sessions.js — session-detail modal + lifecycle public API
    'window.WorkoutSessionsState',      // features/workout/sessions.js — closure-private session-modal state (logs / data / originalStatus) exposed via getter/setter
    'window.WorkoutStats',              // features/workout/stats.js — stats sub-tab public API
    'window.WorkoutNextCard',           // features/workout/next-card.js — next-workout card public API
    'window.WorkoutModals',             // features/workout/modals.js — namespace mirroring the workout-start push-notification modal flow (showWorkoutStartModal, closeWorkoutStartModal, startWorkoutFromModal, snoozeWorkout, skipWorkout, skipWorkoutFromModal) extracted from app.js (Plan 2026-06-10 finish-app-js-split, Task 4). The bare function names remain the live call path (app.js bindNotificationControls arrow wrappers + handlePushAction); this object documents the public surface.

    // Food split (2026-05-13: features/food.js → features/food/*.js).
    // Each split file exposes a single public-API namespace on window; the
    // closure-private state from the original food.js (foodProductsCache,
    // foodScannerStream, currentFoodLogs, foodTargets, foodDBPage, etc.) is
    // consolidated on these namespaces via getter/setter accessors.
    'window.FoodLog',                   // features/food/log.js — daily food log + edit modal + targets public API
    'window.FoodProducts',              // features/food/products.js — product search + cache + autocomplete public API
    'window.FoodScanner',               // features/food/scanner.js — barcode/QR scanner modal public API
    'window.FoodPhoto',                 // features/food/photo.js — food photo capture + EXIF + undo public API
    'window.FoodMeals',                 // features/food/meals.js — My Meals list + save-as-meal flow public API
    'window.FoodDB',                    // features/food/db.js — Food DB browse + paginate public API

    // Settings view — extracted from app.js (Plan 2026-06-10 finish-app-js-split, Task 2).
    'window.SettingsView',              // features/settings.js — namespace mirroring the Settings tab view (loadSettings, renderSettingsStaleBadge, updateFeatureToggles, updateFoodTargetsVisibility, toggleFeatureSetting, updateFeatureTabVisibility, initOIDCSetupBanner). The bare function names remain the live call path (app.js switchTab/reloadCurrentTab → loadSettings; feature-toggle change handlers → toggleFeatureSetting; loadInitData/auth-bootstrap.js → updateFeatureTabVisibility); this object documents the public surface.

    // Settings → Integrations section (local-only mode foundation, Task 3).
    'window.SettingsIntegrations',      // features/settings/integrations.js — load + save handlers for the Integrations card (OpenAI / Food / ElevenLabs credentials); routes the save through DataStore.applyOptimistic so the masked GET view repaints immediately on commit and rolls back on failure.

    // Backend logs diagnostics — embedded-Go shell (mobile Phase 2a, Task 5).
    'window.BackendLogs',               // features/backend-logs.js — Settings → About → "Backend logs" debug screen. Detects window.MedtrackerNative (Capacitor shell's addJavascriptInterface bridge); reveals a "View logs" row that opens a modal showing the last 200 stdout+stderr lines from the embedded Go binary. No-op in browser PWA + server-mode where MedtrackerNative is absent.

    // Capacitor shell bootstrap — embedded-Go shell (mobile Phase 2a, Task 5).
    'window.__MEDTRACKER_BOOTSTRAP__',  // index.html inline shim — Capacitor shell injects { apiBase: "http://127.0.0.1:<port>" } before WebView load by mirroring window.MedtrackerNative.apiBase(). core/api.js's resolveApiUrl() reads it to prefix relative endpoints. Reserved as the carrier for future shell-injected feature flags. The assignment lives in index.html (not a JS file) so the regex below does not flag it; the allowlist entry exists for documentation and to prevent a future JS-side writer from being silently rejected.

    // Cloud-mode boot shim (C1) — web/cloud/js/cloud-boot.js, injected by
    // internal/cloudserver/router.go ahead of every other script on account
    // subdomains. Both assignments live outside web/static/js (JS_ROOT below
    // does not scan web/cloud/) so the regex guard never sees them; the
    // entries exist for documentation, mirroring __MEDTRACKER_BOOTSTRAP__.
    'window.__MEDTRACKER_CLOUD__',      // cloud-boot.js — set synchronously before any other script; checkAuth() (app.js), loadTelegramSdk() (messenger-adapter.js), initServiceWorker() (app-shell.js), and startChangePolling() (data-store.js) all branch on it to skip Telegram/bot-mode-only behavior on the E2EE cloud origin
    'window.MedTrackerCloudReady',      // cloud-boot.js — Promise that resolves once the async warm-unlock + installApiShim(ctx) + pullOnOpen(ctx) sequence finishes (or rejects/redirects to /unlock on failure); checkAuth() awaits this before calling apiCall(bootstrapURL()), the same shape as window.MessengerAdapterReady gating the Telegram SDK upgrade
    'window.CloudFoodAI',               // apishim.js (installApiShim) — createFoodAIDomain instance wired to the browser aiclient.js; photo.js/log.js call parseMealFromPhoto/parseMealFromDescription directly in cloud mode instead of POSTing /api/food/log/from-{photo,description} (C2c Task 4)
    'window.CloudFoodSearch',           // apishim.js (installApiShim) — { search(q, opts) } over the same food domain instance the shim uses; products.js's cloud branch replaces the NDJSON stream with two local/remote calls into this (C2c Task 4)
    'window.CloudElevenLabs',           // apishim.js (installApiShim) — { fetchSignedURL() } minting the ElevenLabs WebSocket signed URL browser-direct from the vault's BYO key; elevenlabs-call.js's fetchSignedURL() branches here in cloud mode instead of hitting the (nonexistent) /api/elevenlabs/signed-url route (voice PoC Task 1)
    'window.MedTrackerCloud',           // cloud-boot.js — published once warmUnlock() resolves a non-null ctx ({ accountId, dek }); features/settings.js's cloud Notifications branch reads window.MedTrackerCloud.ctx to call the DOM-free subscribe()/sendTestPush(ctx) helpers without re-deriving the vault key

    // Native platform abstractions — mobile Phase 2b, Task 1 (foundation).
    // The four globals below are the seam between feature code and platform
    // APIs (web/* impls for the PWA, capacitor/* impls for the Android shell).
    // native/index.js installs stubs that throw NotImplementedError; Tasks
    // 2–5 of the Phase 2b plan replace each stub with a real web vs Capacitor
    // selector.
    // First-run guided setup overlay — mobile Phase 2c, Task 3.
    'window.WGFirstRun',                // features/firstrun/index.js exposes the mount/dismiss/isActive surface for the first-run overlay; state.js attaches the sessionStorage step tracker under `.state`. Mounted once at bootstrap when /api/bootstrap returns needs_first_run: true.

    'window.MediaCapture',              // native/index.js — camera + photo picker abstraction (takePhoto, pickPhoto); web impl wraps getUserMedia + <input type=file>, Capacitor impl wraps @capacitor/camera
    'window.Geolocation',               // native/index.js — device geolocation abstraction (getCurrentPosition); web impl wraps navigator.geolocation, Capacitor impl wraps @capacitor/geolocation with a 1h in-memory last-known-position cache
    'window.Barcode',                   // native/index.js — barcode scanner abstraction (scan); web impl uses window.BarcodeDetector with a ZXing fallback, Capacitor impl wraps @capacitor-mlkit/barcode-scanning
    'window.Reminders',                 // native/index.js — local-notification reminders abstraction (schedule, cancelAll); web impl is a no-op (Web Push owns the browser path via push.js), Capacitor impl wraps @capacitor/local-notifications with replace-all semantics on every appResume
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
