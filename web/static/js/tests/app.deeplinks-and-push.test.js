/**
 * PR1 – Stabilization + Guardrails
 *
 * Tests for handleDeepLinks() covering:
 *   - Path deep links:  /bp_add, /weight_add
 *   - Query deep links: ?tab=bp&action=add, ?tab=weight&action=add
 *   - Push actions:     ?action=medication_confirm, ?action=workout_start
 *   - URL cleanup after every deep-link or push-action flow
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('handleDeepLinks – path deep links', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('/bp_add switches to bp tab and opens BP modal after 100 ms', async () => {
    const { window, cleanup } = loadFrontendEnv({ url: 'https://example.test/bp_add' });

    try {
      // Mock switchTab to prevent real data-loader calls (loadBPReadings etc.)
      // which would fire against the default {} fetch mock and produce noisy errors.
      const switchTabSpy = vi.spyOn(window, 'switchTab').mockImplementation(() => {});
      const showBPSpy = vi.spyOn(window, 'showBPRecordModal').mockImplementation(() => {});
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      window.handleDeepLinks();

      // switchTab happens synchronously
      expect(switchTabSpy).toHaveBeenCalledWith('bp');
      expect(showBPSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(110);

      expect(showBPSpy).toHaveBeenCalledTimes(1);
      expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/');
    } finally {
      cleanup();
    }
  });

  it('/weight_add switches to weight tab and opens weight modal after 100 ms', async () => {
    const { window, cleanup } = loadFrontendEnv({ url: 'https://example.test/weight_add' });

    try {
      const switchTabSpy = vi.spyOn(window, 'switchTab').mockImplementation(() => {});
      const showWeightSpy = vi.spyOn(window, 'showWeightModal').mockImplementation(() => {});
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      window.handleDeepLinks();

      expect(switchTabSpy).toHaveBeenCalledWith('weight');
      expect(showWeightSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(110);

      expect(showWeightSpy).toHaveBeenCalledTimes(1);
      expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/');
    } finally {
      cleanup();
    }
  });

  it('/bp_add does not also invoke the push-action path', async () => {
    const { window, cleanup } = loadFrontendEnv({ url: 'https://example.test/bp_add' });

    try {
      const pushActionSpy = vi.spyOn(window, 'handlePushAction').mockImplementation(() => {});
      vi.spyOn(window, 'switchTab').mockImplementation(() => {});
      vi.spyOn(window, 'showBPRecordModal').mockImplementation(() => {});

      window.handleDeepLinks();
      await vi.advanceTimersByTimeAsync(200);

      expect(pushActionSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});

describe('handleDeepLinks – query-param deep links (?tab=…&action=add)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('?tab=bp&action=add switches to bp tab and opens BP modal after 100 ms', async () => {
    const { window, cleanup } = loadFrontendEnv({
      url: 'https://example.test/?tab=bp&action=add'
    });

    try {
      const switchTabSpy = vi.spyOn(window, 'switchTab').mockImplementation(() => {});
      const showBPSpy = vi.spyOn(window, 'showBPRecordModal').mockImplementation(() => {});
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      window.handleDeepLinks();

      expect(switchTabSpy).toHaveBeenCalledWith('bp');
      expect(showBPSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(110);

      expect(showBPSpy).toHaveBeenCalledTimes(1);
      expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/');
    } finally {
      cleanup();
    }
  });

  it('?tab=weight&action=add switches to weight tab and opens weight modal after 100 ms', async () => {
    const { window, cleanup } = loadFrontendEnv({
      url: 'https://example.test/?tab=weight&action=add'
    });

    try {
      const switchTabSpy = vi.spyOn(window, 'switchTab').mockImplementation(() => {});
      const showWeightSpy = vi.spyOn(window, 'showWeightModal').mockImplementation(() => {});
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      window.handleDeepLinks();

      expect(switchTabSpy).toHaveBeenCalledWith('weight');
      expect(showWeightSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(110);

      expect(showWeightSpy).toHaveBeenCalledTimes(1);
      expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/');
    } finally {
      cleanup();
    }
  });

  it('?tab=bp&action=add with BP feature disabled redirects to Today and does NOT open the BP modal', async () => {
    const { window, cleanup } = loadFrontendEnv({ url: 'https://example.test/?tab=bp&action=add' });

    try {
      window.featureSettings = { ...(window.featureSettings || {}), bp: false };
      window.featureSettingsLoaded = true;
      const switchTabSpy = vi.spyOn(window, 'switchTab').mockImplementation(() => {});
      const showBPSpy = vi.spyOn(window, 'showBPRecordModal').mockImplementation(() => {});
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      window.handleDeepLinks();
      await vi.advanceTimersByTimeAsync(200);

      expect(switchTabSpy).toHaveBeenCalledWith('today');
      expect(switchTabSpy).not.toHaveBeenCalledWith('bp');
      expect(showBPSpy).not.toHaveBeenCalled();
      expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/');
    } finally {
      cleanup();
    }
  });

  it('/weight_add with weight feature disabled redirects to Today and does NOT open the weight modal', async () => {
    const { window, cleanup } = loadFrontendEnv({ url: 'https://example.test/weight_add' });

    try {
      window.featureSettings = { ...(window.featureSettings || {}), weight: false };
      window.featureSettingsLoaded = true;
      const switchTabSpy = vi.spyOn(window, 'switchTab').mockImplementation(() => {});
      const showWeightSpy = vi.spyOn(window, 'showWeightModal').mockImplementation(() => {});
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      window.handleDeepLinks();
      await vi.advanceTimersByTimeAsync(200);

      expect(switchTabSpy).toHaveBeenCalledWith('today');
      expect(switchTabSpy).not.toHaveBeenCalledWith('weight');
      expect(showWeightSpy).not.toHaveBeenCalled();
      expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/');
    } finally {
      cleanup();
    }
  });

  it('?tab=unknown&action=add does NOT call switchTab and still cleans the URL', async () => {
    // Unknown tabs have no registered modal, so deeplink-router must skip switchTab
    // entirely to prevent activateTabGroup from blanking the page by deactivating all
    // views before discovering the target tab does not exist.
    const { window, document, cleanup } = loadFrontendEnv({
      url: 'https://example.test/?tab=unknown&action=add'
    });

    try {
      const switchTabSpy = vi.spyOn(window, 'switchTab');
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      // Record which view is active before the deep-link runs (there is no
      // persistent tab strip post-Today-as-primary-nav; views carry .active).
      const activeBefore = document.querySelector('.view.active')?.id;

      window.handleDeepLinks();

      // switchTab must NOT be called for an unrecognised tab value
      expect(switchTabSpy).not.toHaveBeenCalled();
      // URL must still be cleaned up
      expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/');
      // The previously-active view must remain active (no blank-page regression)
      expect(document.querySelector('.view.active')?.id).toBe(activeBefore);
    } finally {
      cleanup();
    }
  });
});

describe('handleDeepLinks – feature flag visibility in production', () => {
  // app.js owns featureSettings/featureSettingsLoaded and must mirror them
  // onto window so deeplink-router's isDeepLinkFeatureEnabled() can read them.
  // Regression: if app.js stops writing window.featureSettings,
  // the disabled-feature guard silently becomes a no-op.
  it('loading app.js initialises window.featureSettings and window.featureSettingsLoaded', () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      expect(window.featureSettings).toBeDefined();
      // The default object declared in app.js includes bp/weight/medication etc.
      expect(window.featureSettings.bp).toBeDefined();
      expect(window.featureSettings.weight).toBeDefined();
      // The flag starts false until bootstrap/loadSettings resolves, but the
      // property itself must be present so deeplink-router doesn't see
      // `undefined` and fall through to its default-on branch.
      expect('featureSettingsLoaded' in window).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('handleDeepLinks – push-action query params', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('?action=medication_confirm routes to handlePushAction and cleans URL', async () => {
    const { window, cleanup } = loadFrontendEnv({
      url: 'https://example.test/?action=medication_confirm&ids=1,2&names=Aspirin,Mag&scheduled=2026-03-01T08:00:00Z'
    });

    try {
      const pushActionSpy = vi.spyOn(window, 'handlePushAction').mockImplementation(() => {});
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      window.handleDeepLinks();

      expect(pushActionSpy).toHaveBeenCalledTimes(1);
      expect(pushActionSpy.mock.calls[0][0]).toBe('medication_confirm');
      expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/');
    } finally {
      cleanup();
    }
  });

  it('?action=workout_start routes to handlePushAction and cleans URL', async () => {
    const { window, cleanup } = loadFrontendEnv({
      url: 'https://example.test/?action=workout_start&session_id=42'
    });

    try {
      const pushActionSpy = vi.spyOn(window, 'handlePushAction').mockImplementation(() => {});
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      window.handleDeepLinks();

      expect(pushActionSpy).toHaveBeenCalledTimes(1);
      expect(pushActionSpy.mock.calls[0][0]).toBe('workout_start');
      expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/');
    } finally {
      cleanup();
    }
  });

  it('no action params → no modal opened, URL unchanged', () => {
    const { window, cleanup } = loadFrontendEnv({ url: 'https://example.test/' });

    try {
      const pushActionSpy = vi.spyOn(window, 'handlePushAction').mockImplementation(() => {});
      const showBPSpy = vi.spyOn(window, 'showBPRecordModal').mockImplementation(() => {});
      const showWeightSpy = vi.spyOn(window, 'showWeightModal').mockImplementation(() => {});
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      window.handleDeepLinks();

      expect(pushActionSpy).not.toHaveBeenCalled();
      expect(showBPSpy).not.toHaveBeenCalled();
      expect(showWeightSpy).not.toHaveBeenCalled();
      expect(replaceStateSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
