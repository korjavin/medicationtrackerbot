// Tests for core/demo-banner.js — the dismissible "Demo version" banner
// mounted from /api/bootstrap when DEMO_MODE=1, and the 429
// `demo_rate_limit` popup helper invoked by core/api.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DEMO_BANNER_JS = path.join(REPO_ROOT, 'web/static/js/core/demo-banner.js');

function loadEnv() {
    const dom = new JSDOM(
        '<!doctype html><html><body>'
        + '<div id="demo-banner" class="wg-demo-banner hidden" hidden></div>'
        + '</body></html>',
        { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true }
    );
    dom.window.eval(fs.readFileSync(DEMO_BANNER_JS, 'utf8'));
    return {
        window: dom.window,
        document: dom.window.document,
        api: dom.window.DemoBanner,
        cleanup: () => dom.window.close(),
    };
}

const DEFAULT_LIMITS = {
    agent_calls_per_day: 1,
    food_logs_per_hour: 1,
    food_photos_per_hour: 1,
    food_descriptions_per_hour: 1,
};

describe('DemoBanner.mount', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('exposes window.DemoBanner with mount + showDemoLimitAlert', () => {
        expect(typeof env.api).toBe('object');
        expect(typeof env.api.mount).toBe('function');
        expect(typeof env.api.showDemoLimitAlert).toBe('function');
        expect(typeof env.api.formatLimitMessage).toBe('function');
        expect(typeof env.api.limitsHash).toBe('function');
    });

    it('renders the banner when demo.enabled=true with the canonical copy', () => {
        const ok = env.api.mount({ enabled: true, limits: DEFAULT_LIMITS });
        expect(ok).toBe(true);
        const slot = env.document.getElementById('demo-banner');
        expect(slot.classList.contains('hidden')).toBe(false);
        expect(slot.hasAttribute('hidden')).toBe(false);
        const text = slot.querySelector('.wg-demo-banner__text');
        expect(text).not.toBeNull();
        expect(text.textContent).toContain('Demo version');
        expect(text.textContent).toContain('shared');
        expect(text.textContent).toContain('rate-limited');
        const dismiss = slot.querySelector('.wg-demo-banner__dismiss');
        expect(dismiss).not.toBeNull();
        expect(dismiss.getAttribute('aria-label')).toBe('Dismiss demo banner');
    });

    it('does nothing when demo is missing or .enabled is false', () => {
        const slot = env.document.getElementById('demo-banner');
        // missing
        expect(env.api.mount(undefined)).toBe(false);
        expect(slot.classList.contains('hidden')).toBe(true);
        expect(slot.hasAttribute('hidden')).toBe(true);
        // explicit false
        expect(env.api.mount({ enabled: false })).toBe(false);
        expect(slot.classList.contains('hidden')).toBe(true);
        expect(slot.hasAttribute('hidden')).toBe(true);
        expect(slot.querySelector('.wg-demo-banner__text')).toBeNull();
    });

    it('dismiss button hides the banner and persists the limits hash', () => {
        env.api.mount({ enabled: true, limits: DEFAULT_LIMITS });
        const slot = env.document.getElementById('demo-banner');
        const dismiss = slot.querySelector('.wg-demo-banner__dismiss');
        dismiss.click();
        expect(slot.classList.contains('hidden')).toBe(true);
        expect(slot.hasAttribute('hidden')).toBe(true);
        expect(slot.querySelector('.wg-demo-banner__text')).toBeNull();
        const stored = env.window.localStorage.getItem('demoBannerDismissed');
        expect(stored).toBe(env.api.limitsHash(DEFAULT_LIMITS));
    });

    it('stays hidden on a remount when the dismissed hash matches current limits', () => {
        env.api.mount({ enabled: true, limits: DEFAULT_LIMITS });
        env.document.getElementById('demo-banner').querySelector('.wg-demo-banner__dismiss').click();
        const ok = env.api.mount({ enabled: true, limits: DEFAULT_LIMITS });
        expect(ok).toBe(false);
        const slot = env.document.getElementById('demo-banner');
        expect(slot.classList.contains('hidden')).toBe(true);
    });

    it('re-surfaces the banner when the limits change after a previous dismiss', () => {
        env.api.mount({ enabled: true, limits: DEFAULT_LIMITS });
        env.document.getElementById('demo-banner').querySelector('.wg-demo-banner__dismiss').click();
        const changed = { ...DEFAULT_LIMITS, food_logs_per_hour: 3 };
        const ok = env.api.mount({ enabled: true, limits: changed });
        expect(ok).toBe(true);
        const slot = env.document.getElementById('demo-banner');
        expect(slot.classList.contains('hidden')).toBe(false);
        expect(slot.querySelector('.wg-demo-banner__text')).not.toBeNull();
    });

    it('returns false (no-op) when #demo-banner slot is missing from the DOM', () => {
        env.document.getElementById('demo-banner').remove();
        const ok = env.api.mount({ enabled: true, limits: DEFAULT_LIMITS });
        expect(ok).toBe(false);
    });
});

describe('DemoBanner.formatLimitMessage', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('quotes count + unit + window for the agent bucket', () => {
        env.api.mount({ enabled: true, limits: DEFAULT_LIMITS });
        const msg = env.api.formatLimitMessage({
            error: 'demo_rate_limit',
            limit: 'agent_calls',
            retry_after_seconds: 86400,
        });
        expect(msg).toBe('Demo restriction: only 1 voice agent call per day. Try again later.');
    });

    it('uses minute/hour/second windows depending on retry_after_seconds', () => {
        env.api.mount({ enabled: true, limits: DEFAULT_LIMITS });
        expect(env.api.formatLimitMessage({ limit: 'food_log', retry_after_seconds: 3600 }))
            .toBe('Demo restriction: only 1 manual food log per hour. Try again later.');
        expect(env.api.formatLimitMessage({ limit: 'food_log_from_photo', retry_after_seconds: 60 }))
            .toBe('Demo restriction: only 1 food-from-photo entry per minute. Try again later.');
        expect(env.api.formatLimitMessage({ limit: 'food_log_from_description', retry_after_seconds: 30 }))
            .toBe('Demo restriction: only 1 food-from-text entry per second. Try again later.');
    });

    it('falls back to count=1 when no limits have been mounted yet', () => {
        // mount never called, so cachedLimits is null
        const msg = env.api.formatLimitMessage({
            error: 'demo_rate_limit',
            limit: 'food_log',
            retry_after_seconds: 3600,
        });
        expect(msg).toBe('Demo restriction: only 1 manual food log per hour. Try again later.');
    });

    it('pluralizes the unit phrase when the configured count is >1', () => {
        env.api.mount({ enabled: true, limits: { ...DEFAULT_LIMITS, food_logs_per_hour: 5 } });
        expect(env.api.formatLimitMessage({ limit: 'food_log', retry_after_seconds: 3600 }))
            .toBe('Demo restriction: only 5 manual food logs per hour. Try again later.');
    });
});

describe('DemoBanner.showDemoLimitAlert', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('routes the formatted message through window.safeAlert when present', () => {
        env.api.mount({ enabled: true, limits: DEFAULT_LIMITS });
        const spy = vi.fn();
        env.window.safeAlert = spy;
        env.api.showDemoLimitAlert({
            error: 'demo_rate_limit',
            limit: 'food_log',
            retry_after_seconds: 3600,
        });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toBe('Demo restriction: only 1 manual food log per hour. Try again later.');
    });

    it('falls back to window.alert when safeAlert is not available', () => {
        env.api.mount({ enabled: true, limits: DEFAULT_LIMITS });
        const spy = vi.fn();
        env.window.alert = spy;
        env.window.safeAlert = undefined;
        env.api.showDemoLimitAlert({
            error: 'demo_rate_limit',
            limit: 'agent_calls',
            retry_after_seconds: 86400,
        });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toContain('voice agent call');
    });
});
