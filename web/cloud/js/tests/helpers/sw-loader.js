// Shared loader for web/cloud/sw.js unit tests (sw.reminder-actions,
// sw.push-resubscribe, sw.fetch-cache). Evaluates the SW source in a bare
// scope, capturing addEventListener registrations so tests can fire handlers
// directly. Each suite passes only the mock it cares about.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

const SW_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../sw.js');

// Matches self.location.origin inside the evaluated SW.
export const SW_ORIGIN = 'https://acct.medtracker.example';

export function loadCloudSw({ fetch: fetchImpl, caches, indexedDB, pushManager } = {}) {
    const swSrc = fs.readFileSync(SW_PATH, 'utf-8');
    const listeners = new Map();
    const self = {
        addEventListener: vi.fn((type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        }),
        location: { origin: SW_ORIGIN },
        clients: {
            matchAll: vi.fn().mockResolvedValue([]),
            openWindow: vi.fn().mockResolvedValue(undefined),
            claim: vi.fn(),
        },
        registration: {
            showNotification: vi.fn(),
            ...(pushManager ? { pushManager } : {}),
        },
        skipWaiting: vi.fn(),
    };
    const cachesMock = caches || {
        open: vi.fn().mockResolvedValue({ match: vi.fn(), put: vi.fn(), add: vi.fn() }),
        match: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
        delete: vi.fn(),
    };
    const fetchMock = fetchImpl || vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    // eslint-disable-next-line no-new-func
    new Function('self', 'caches', 'fetch', 'indexedDB', swSrc)(self, cachesMock, fetchMock, indexedDB || { open: vi.fn() });
    return { self, listeners, caches: cachesMock, fetchMock };
}
