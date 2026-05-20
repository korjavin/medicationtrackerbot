// Tests for the 429 + demo_rate_limit branch in core/api.js apiCallDirect.
// When the server returns 429 with a body shaped
// {error:'demo_rate_limit', limit, retry_after_seconds}, apiCallDirect must:
//   1. invoke window.DemoBanner.showDemoLimitAlert(parsed) so the user sees
//      a popup quoting the demo restriction instead of a generic error
//   2. throw an Error with .status === 429 and .demoLimit === parsed so
//      callers can branch on the typed flag
// All other 429 responses (no JSON body, or different `error` value) fall
// through to the generic Too Many Requests error path with no popup.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CORE_API_JS = path.join(REPO_ROOT, 'web/static/js/core/api.js');
const DEMO_BANNER_JS = path.join(REPO_ROOT, 'web/static/js/core/demo-banner.js');

function loadEnv() {
    const dom = new JSDOM(
        '<!doctype html><html><body>'
        + '<div id="demo-banner" class="wg-demo-banner hidden" hidden></div>'
        + '</body></html>',
        { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true }
    );
    dom.window.eval(fs.readFileSync(DEMO_BANNER_JS, 'utf8'));
    dom.window.eval(fs.readFileSync(CORE_API_JS, 'utf8'));
    return { window: dom.window, cleanup: () => dom.window.close() };
}

function rateLimitedResponse(body) {
    return {
        status: 429,
        ok: false,
        async text() { return JSON.stringify(body); },
    };
}

function plainErrorResponse(status, text) {
    return {
        status,
        ok: false,
        async text() { return text; },
    };
}

describe('apiCallDirect — 429 + demo_rate_limit', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('invokes DemoBanner.showDemoLimitAlert and throws with typed metadata', async () => {
        const body = { error: 'demo_rate_limit', limit: 'food_log', retry_after_seconds: 3600 };
        env.window.fetch = vi.fn(async () => rateLimitedResponse(body));
        const spy = vi.fn();
        env.window.DemoBanner.showDemoLimitAlert = spy;

        const err = await env.window.apiCallDirect('/api/food/log', 'POST', { foo: 1 }).catch((e) => e);
        expect(err).toBeInstanceOf(env.window.Error);
        expect(err.status).toBe(429);
        expect(err.demoLimit).toEqual(body);
        expect(err.message).toBe('Demo rate limit reached');
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toEqual(body);
    });

    it('surfaces the formatted popup message through safeAlert end-to-end', async () => {
        // Mount the banner first so cached limits drive the formatted count
        env.window.DemoBanner.mount({
            enabled: true,
            limits: {
                agent_calls_per_day: 1,
                food_logs_per_hour: 1,
                food_photos_per_hour: 1,
                food_descriptions_per_hour: 1,
            },
        });
        const alertSpy = vi.fn();
        env.window.safeAlert = alertSpy;
        env.window.fetch = vi.fn(async () => rateLimitedResponse({
            error: 'demo_rate_limit',
            limit: 'agent_calls',
            retry_after_seconds: 86400,
        }));

        await env.window.apiCallDirect('/api/elevenlabs/signed-url').catch(() => { });
        expect(alertSpy).toHaveBeenCalledTimes(1);
        expect(alertSpy.mock.calls[0][0])
            .toBe('Demo restriction: only 1 voice agent call per day. Try again later.');
    });

    it('falls back to a generic Too Many Requests error when the 429 body is not the demo shape', async () => {
        env.window.fetch = vi.fn(async () => plainErrorResponse(429, 'rate limited'));
        const spy = vi.fn();
        env.window.DemoBanner.showDemoLimitAlert = spy;

        const err = await env.window.apiCallDirect('/api/something').catch((e) => e);
        expect(err).toBeInstanceOf(env.window.Error);
        expect(err.status).toBe(429);
        expect(err.demoLimit).toBeUndefined();
        expect(err.message).toBe('rate limited');
        expect(spy).not.toHaveBeenCalled();
    });

    it('does not throw when DemoBanner is missing — popup is best-effort', async () => {
        env.window.fetch = vi.fn(async () => rateLimitedResponse({
            error: 'demo_rate_limit',
            limit: 'food_log',
            retry_after_seconds: 3600,
        }));
        env.window.DemoBanner = undefined;

        const err = await env.window.apiCallDirect('/api/food/log', 'POST', { foo: 1 }).catch((e) => e);
        expect(err).toBeInstanceOf(env.window.Error);
        expect(err.status).toBe(429);
        expect(err.demoLimit).toEqual({
            error: 'demo_rate_limit',
            limit: 'food_log',
            retry_after_seconds: 3600,
        });
    });

    it('passes through non-429 responses unchanged (no demoLimit on the error)', async () => {
        env.window.fetch = vi.fn(async () => plainErrorResponse(500, 'boom'));
        const err = await env.window.apiCallDirect('/api/test').catch((e) => e);
        expect(err).toBeInstanceOf(env.window.Error);
        expect(err.status).toBe(500);
        expect(err.demoLimit).toBeUndefined();
    });
});
