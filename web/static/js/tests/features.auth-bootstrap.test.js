// Integration tests for features/auth-bootstrap.js (Plan 2026-05-13-split-app-js.md, Task 3).
//
// The module extracts the previously-scattered bootstrap/hydration helpers
// from app.js (applyBootstrapPayload, hydrateMedicationsFromDexie,
// hydrateSectionsFromDexie, cacheApiSnapshot, normalizeSettingsBundle,
// hydrateFeatureSettingsFromBundle)
// plus a new closure-private SettingsState reducer that owns featureSettings +
// featureSettingsLoaded and collapses the three-writer race documented in the
// plan.
//
// These tests assert the invariants the extraction is meant to preserve and
// the new race-prevention invariant the reducer is meant to enforce:
//
//   1. Bootstrap-then-Dexie hydration is idempotent. Calling applyBootstrap
//      followed by applyDexieFeatures with stale flags does not stomp the
//      bootstrap-confirmed values.
//   2. Dexie hydration before bootstrap warms the in-memory state; a later
//      applyBootstrapFeatures replaces those values without merge surprises.
//   3. The legacy window.X shims (applyBootstrapPayload, cacheApiSnapshot,
//      normalizeSettingsBundle, etc.) are still callable by name so tests
//      and consumers that pre-date the extraction keep working.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/auth-bootstrap.js — SettingsState reducer', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        env.window.SettingsState._resetForTesting();
    });

    afterEach(() => {
        env.cleanup();
    });

    it('applyBootstrapFeatures marks loaded=true and mirrors to window.featureSettings + AppStore', () => {
        const { window } = env;
        const appStoreSpy = vi.spyOn(window.AppStore, 'set');

        window.SettingsState.applyBootstrapFeatures({ bp: false, weight: true, food: true });

        expect(window.SettingsState.isLoaded()).toBe(true);
        expect(window.featureSettingsLoaded).toBe(true);
        expect(window.featureSettings).toMatchObject({ bp: false, weight: true, food: true });
        expect(appStoreSpy).toHaveBeenCalledWith('featureSettings', expect.objectContaining({ bp: false }));
    });

    it('applyDexieFeatures is a no-op once loaded=true (bootstrap fresh data wins over stale cache)', () => {
        const { window } = env;
        window.SettingsState.applyBootstrapFeatures({ bp: true, food: true });
        const after = window.SettingsState.getFeatureSettings();

        // Stale cached flags: claim BP is off and food is off. With loaded=true,
        // applyDexieFeatures must skip — bootstrap's fresh value wins.
        window.SettingsState.applyDexieFeatures({ bp: false, food: false });

        expect(window.featureSettings.bp).toBe(true);
        expect(window.featureSettings.food).toBe(true);
        // Reference equality unchanged — no merge happened.
        expect(window.SettingsState.getFeatureSettings()).toBe(after);
    });

    it('applyDexieFeatures sets loaded=true when nothing fresh has landed yet', () => {
        const { window } = env;
        expect(window.SettingsState.isLoaded()).toBe(false);

        window.SettingsState.applyDexieFeatures({ workout: false, health: false });

        expect(window.SettingsState.isLoaded()).toBe(true);
        expect(window.featureSettings.workout).toBe(false);
        expect(window.featureSettings.health).toBe(false);
    });

    it('applyBootstrapFeatures after applyDexieFeatures replaces the cached values with fresh ones', () => {
        const { window } = env;
        window.SettingsState.applyDexieFeatures({ bp: false, food: false });
        // The server's fresh data says BP and food are back on.
        window.SettingsState.applyBootstrapFeatures({ bp: true, food: true });

        expect(window.featureSettings.bp).toBe(true);
        expect(window.featureSettings.food).toBe(true);
    });

    it('setFeature updates a single flag and mirrors to window + AppStore', () => {
        const { window } = env;
        const appStoreSpy = vi.spyOn(window.AppStore, 'set');
        window.SettingsState.applyBootstrapFeatures({ bp: true });

        window.SettingsState.setFeature('bp', false);

        expect(window.featureSettings.bp).toBe(false);
        expect(appStoreSpy).toHaveBeenLastCalledWith('featureSettings', expect.objectContaining({ bp: false }));
    });
});

describe('features/auth-bootstrap.js — bootstrap-then-Dexie idempotency', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        env.window.SettingsState._resetForTesting();
    });

    afterEach(() => {
        env.cleanup();
    });

    it('applyBootstrapPayload then hydrateFeatureSettingsFromBundle with stale cache does not stomp fresh features', async () => {
        const { window } = env;

        await window.applyBootstrapPayload({
            cursor: 1,
            features: { bp: true, food: true, weight: true },
            settings: {},
        });

        expect(window.featureSettings).toMatchObject({ bp: true, food: true, weight: true });
        expect(window.featureSettingsLoaded).toBe(true);

        // Simulate a slow Dexie read landing AFTER bootstrap with stale cached
        // flags (bp: false). The Dexie writer must skip because loaded=true.
        window.hydrateFeatureSettingsFromBundle({
            featureSettings: { bp: false, food: false, weight: false },
            weightUnitPreference: 'kg',
        });

        expect(window.featureSettings.bp).toBe(true);
        expect(window.featureSettings.food).toBe(true);
        expect(window.featureSettings.weight).toBe(true);
    });

    it('hydrateFeatureSettingsFromBundle before bootstrap warms the in-memory state', () => {
        const { window } = env;

        window.hydrateFeatureSettingsFromBundle({
            featureSettings: { bp: false, food: true },
            weightUnitPreference: 'lb',
        });

        expect(window.featureSettings.bp).toBe(false);
        expect(window.featureSettings.food).toBe(true);
        expect(window.featureSettingsLoaded).toBe(true);
        expect(window.weightUnitPreference).toBe('lb');
    });
});

describe('features/auth-bootstrap.js — first-run overlay wiring', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
    });

    it('mirrors needs_first_run onto window.__MEDTRACKER_BOOTSTRAP__ and calls WGFirstRun.mount when present', async () => {
        const { window } = env;
        const mount = vi.fn();
        window.WGFirstRun = { mount };

        await window.applyBootstrapPayload({
            cursor: 1,
            features: {},
            settings: {},
            needs_first_run: true,
        });

        expect(window.__MEDTRACKER_BOOTSTRAP__).toBeTruthy();
        expect(window.__MEDTRACKER_BOOTSTRAP__.needs_first_run).toBe(true);
        expect(mount).toHaveBeenCalledTimes(1);
        expect(mount.mock.calls[0][0]).toEqual({ needs_first_run: true });
    });

    it('passes needs_first_run=false through to mount so a same-payload re-apply does not surface the overlay', async () => {
        const { window } = env;
        const mount = vi.fn();
        window.WGFirstRun = { mount };

        await window.applyBootstrapPayload({
            cursor: 1,
            features: {},
            settings: {},
            needs_first_run: false,
        });

        expect(window.__MEDTRACKER_BOOTSTRAP__.needs_first_run).toBe(false);
        expect(mount).toHaveBeenCalledTimes(1);
        expect(mount.mock.calls[0][0]).toEqual({ needs_first_run: false });
    });

    it('does not touch the bootstrap mirror or call mount when needs_first_run is absent from the payload', async () => {
        const { window } = env;
        const mount = vi.fn();
        window.WGFirstRun = { mount };

        await window.applyBootstrapPayload({
            cursor: 1,
            features: {},
            settings: {},
        });

        // No mirror write — applyBootstrapPayload only touches the field
        // when the server actually emits it.
        const mirror = window.__MEDTRACKER_BOOTSTRAP__ || {};
        expect(mirror.needs_first_run).toBeUndefined();
        expect(mount).not.toHaveBeenCalled();
    });

    it('survives a missing WGFirstRun global (production order may load auth-bootstrap before the firstrun module)', async () => {
        const { window } = env;
        // No window.WGFirstRun assigned — applyBootstrapPayload must not throw.
        delete window.WGFirstRun;

        await expect(window.applyBootstrapPayload({
            cursor: 1,
            features: {},
            settings: {},
            needs_first_run: true,
        })).resolves.toBe(true);

        // The mirror still gets the value so a late-loading orchestrator
        // can read it once it boots.
        expect(window.__MEDTRACKER_BOOTSTRAP__.needs_first_run).toBe(true);
    });
});

describe('features/auth-bootstrap.js — namespace + backwards-compat shims', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
    });

    it('exposes AuthBootstrap namespace with the extracted helpers', () => {
        const { window } = env;
        expect(typeof window.AuthBootstrap).toBe('object');
        expect(typeof window.AuthBootstrap.applyBootstrapPayload).toBe('function');
        expect(typeof window.AuthBootstrap.hydrateFeatureSettingsFromBundle).toBe('function');
        expect(typeof window.AuthBootstrap.hydrateMedicationsFromDexie).toBe('function');
        expect(typeof window.AuthBootstrap.hydrateSectionsFromDexie).toBe('function');
        expect(typeof window.AuthBootstrap.cacheApiSnapshot).toBe('function');
        expect(typeof window.AuthBootstrap.normalizeSettingsBundle).toBe('function');
    });

    it('legacy window.X shims call into the AuthBootstrap namespace', () => {
        const { window } = env;
        expect(window.applyBootstrapPayload).toBe(window.AuthBootstrap.applyBootstrapPayload);
        expect(window.normalizeSettingsBundle).toBe(window.AuthBootstrap.normalizeSettingsBundle);
        expect(window.cacheApiSnapshot).toBe(window.AuthBootstrap.cacheApiSnapshot);
        expect(window.hydrateFeatureSettingsFromBundle).toBe(window.AuthBootstrap.hydrateFeatureSettingsFromBundle);
        expect(window.hydrateMedicationsFromDexie).toBe(window.AuthBootstrap.hydrateMedicationsFromDexie);
        expect(window.hydrateSectionsFromDexie).toBe(window.AuthBootstrap.hydrateSectionsFromDexie);
    });

    it('normalizeSettingsBundle coerces weight-unit and food-target numbers (canonical pass-through)', () => {
        const { window } = env;
        const bundle = window.normalizeSettingsBundle({
            features: { bp: true, weight: false },
            settings: {
                timezone: 'Europe/Berlin',
                food_targets: { calories: '2000', carbs: '200', protein: '120', fat: '60' },
                bp_reminder_status: { enabled: 1, time: '08:00' },
                weight_reminder_status: { enabled: 0 },
                weight_unit_preference: 'lb',
            },
        });
        expect(bundle.featureSettings).toEqual({ bp: true, weight: false });
        expect(bundle.weightUnitPreference).toBe('lb');
        expect(bundle.foodTargets.calories).toBe(2000);
        expect(bundle.foodTargets.protein).toBe(120);
        expect(bundle.bpReminderStatus.enabled).toBe(true);
        expect(bundle.bpReminderStatus.time).toBe('08:00');
        expect(bundle.weightReminderStatus.enabled).toBe(false);
        expect(bundle.timezone).toBe('Europe/Berlin');
    });
});
