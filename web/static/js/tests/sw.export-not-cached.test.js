// GET /api/export returns the full vault, which by default (include_secrets=1)
// carries unmasked provider API keys and every api_tokens hash. The SW's
// network-first /api/ branch would otherwise cache.put it into DYNAMIC_CACHE,
// persisting those secrets to disk in the clear — and later serve a stale
// backup offline. Pin that it is never cached, while a sibling /api/ GET is.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { allowConsoleNoise } from './helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_SOURCE = fs.readFileSync(
    path.resolve(__dirname, '../../../../web/static/sw.js'), 'utf-8',
);

function apiRequest(url) {
    const req = { url, method: 'GET', mode: 'cors' };
    req.clone = () => req;
    return req;
}

function loadServiceWorker(fetchImpl) {
    const mockCacheInstance = {
        match: vi.fn(),
        put: vi.fn().mockResolvedValue(undefined),
        addAll: vi.fn().mockResolvedValue(undefined),
    };
    const mockCaches = {
        open: vi.fn().mockResolvedValue(mockCacheInstance),
        match: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(true),
    };
    const swSelf = {
        addEventListener: vi.fn(),
        clients: { matchAll: vi.fn().mockResolvedValue([]), claim: vi.fn() },
        registration: { showNotification: vi.fn() },
        location: { origin: 'https://test.com' },
        skipWaiting: vi.fn(),
    };
    // eslint-disable-next-line no-new-func
    new Function('self', 'caches', 'fetch', 'importScripts', SW_SOURCE)(
        swSelf, mockCaches, fetchImpl, () => {},
    );
    const fetchListener = swSelf.addEventListener.mock.calls.find((c) => c[0] === 'fetch')[1];
    return { mockCacheInstance, fetchListener };
}

async function serve(url) {
    const response = new Response('{}', { status: 200 });
    Object.defineProperty(response, 'ok', { value: true });
    const { mockCacheInstance, fetchListener } = loadServiceWorker(vi.fn().mockResolvedValue(response));
    const event = { request: apiRequest(url), respondWith: vi.fn(), waitUntil: vi.fn() };
    fetchListener(event);
    await event.respondWith.mock.calls[0][0];
    // cache.put lands in a detached .then() chain; let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 0));
    return mockCacheInstance;
}

describe('sw.js — /api/export is never written to CacheStorage', () => {
    beforeEach(() => allowConsoleNoise());

    it('does not cache the secret-bearing vault export', async () => {
        const cache = await serve('https://test.com/api/export?include_secrets=1');
        expect(cache.put).not.toHaveBeenCalled();
    });

    it('still caches an ordinary /api/ GET', async () => {
        const cache = await serve('https://test.com/api/medications');
        expect(cache.put).toHaveBeenCalled();
    });
});
