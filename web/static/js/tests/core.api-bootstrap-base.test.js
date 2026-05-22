import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CORE_API_JS = path.join(REPO_ROOT, 'web/static/js/core/api.js');

// Pins the Phase 2a Task 5 contract: when the Capacitor Android shell
// injects window.__MEDTRACKER_BOOTSTRAP__ = { apiBase: "http://127.0.0.1:..." },
// every apiCallDirect fetch goes to that origin. Without the global, paths
// stay relative — preserving browser PWA + server-mode behaviour byte-for-
// byte (no surprise prefix, no broken cookies, no proxy bypass).
function loadApiEnv({ bootstrap = null } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'http://app.example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    window.userInitData = 'test-init';
    if (bootstrap) {
        window.__MEDTRACKER_BOOTSTRAP__ = bootstrap;
    }
    const source = fs.readFileSync(CORE_API_JS, 'utf8');
    window.eval(`${source}\n//# sourceURL=file://${CORE_API_JS}`);
    return { window, cleanup: () => dom.window.close() };
}

function jsonResponse(body) {
    return {
        status: 200,
        ok: true,
        async text() { return JSON.stringify(body); },
    };
}

describe('resolveApiUrl — bootstrap-injected apiBase', () => {
    it('returns the endpoint unchanged when no bootstrap is set', () => {
        const { window, cleanup } = loadApiEnv();
        try {
            expect(window.resolveApiUrl('/api/init')).toBe('/api/init');
            expect(window.resolveApiUrl('/api/bootstrap')).toBe('/api/bootstrap');
        } finally { cleanup(); }
    });

    it('prefixes relative endpoints with bootstrap.apiBase when set', () => {
        const { window, cleanup } = loadApiEnv({
            bootstrap: { apiBase: 'http://127.0.0.1:54321' },
        });
        try {
            expect(window.resolveApiUrl('/api/init')).toBe('http://127.0.0.1:54321/api/init');
        } finally { cleanup(); }
    });

    it('trims a single trailing slash from apiBase to avoid double slashes', () => {
        const { window, cleanup } = loadApiEnv({
            bootstrap: { apiBase: 'http://127.0.0.1:54321/' },
        });
        try {
            expect(window.resolveApiUrl('/api/init')).toBe('http://127.0.0.1:54321/api/init');
        } finally { cleanup(); }
    });

    it('passes absolute URLs through unchanged even when bootstrap is set', () => {
        const { window, cleanup } = loadApiEnv({
            bootstrap: { apiBase: 'http://127.0.0.1:54321' },
        });
        try {
            expect(window.resolveApiUrl('https://other.example/data')).toBe('https://other.example/data');
        } finally { cleanup(); }
    });

    it('ignores empty / malformed bootstrap values', () => {
        const cases = [
            { apiBase: '' },
            { apiBase: null },
            { apiBase: 42 },
            null,
            'http://wrong-shape',
        ];
        for (const bootstrap of cases) {
            const { window, cleanup } = loadApiEnv({ bootstrap });
            try {
                expect(window.resolveApiUrl('/api/init')).toBe('/api/init');
            } finally { cleanup(); }
        }
    });
});

describe('apiCallDirect — honors bootstrap apiBase', () => {
    it('fetches the embedded-shell origin when bootstrap.apiBase is set', async () => {
        const { window, cleanup } = loadApiEnv({
            bootstrap: { apiBase: 'http://127.0.0.1:54321' },
        });
        try {
            const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
            window.fetch = fetchSpy;
            await window.apiCallDirect('/api/init');
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(fetchSpy.mock.calls[0][0]).toBe('http://127.0.0.1:54321/api/init');
        } finally { cleanup(); }
    });

    it('fetches the relative path unchanged in browser PWA + server mode', async () => {
        const { window, cleanup } = loadApiEnv();
        try {
            const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
            window.fetch = fetchSpy;
            await window.apiCallDirect('/api/init');
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(fetchSpy.mock.calls[0][0]).toBe('/api/init');
        } finally { cleanup(); }
    });

    it('routes POST writes through the embedded-shell origin', async () => {
        // Mirrors the optimistic-write plumbing: after a DataStore.applyOptimistic
        // handle is in flight, the underlying POST to /api/<endpoint> must go to
        // the embedded backend, not the WebView's own origin (when the two
        // differ in a future Capacitor build). apiCallDirect is the canonical
        // entry point for those writes; this test pins the URL resolution.
        const { window, cleanup } = loadApiEnv({
            bootstrap: { apiBase: 'http://127.0.0.1:54321' },
        });
        try {
            const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ created: true }));
            window.fetch = fetchSpy;
            await window.apiCallDirect('/api/bp', 'POST', { sys: 120, dia: 80 });
            expect(fetchSpy.mock.calls[0][0]).toBe('http://127.0.0.1:54321/api/bp');
            const initArg = fetchSpy.mock.calls[0][1];
            expect(initArg.method).toBe('POST');
            expect(initArg.body).toBe(JSON.stringify({ sys: 120, dia: 80 }));
        } finally { cleanup(); }
    });
});
