// Tests for the X-Client-ID header propagation in core/api.js apiCallDirect.
// Non-GET requests must carry X-Client-ID: <window.DataStore.getClientId()>
// so the backend can echo the id back on the SSE payload (source_client_id)
// and the frontend can classify self-echoes deterministically. GET requests
// must not carry the header. Failure to obtain a client id (DataStore not
// loaded, getClientId throws, or returns an empty value) must not block the
// request — apiCallDirect simply omits the header.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CORE_API_JS = path.join(REPO_ROOT, 'web/static/js/core/api.js');

function loadEnv({ clientId, getClientIdImpl } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    if (typeof getClientIdImpl === 'function') {
        window.DataStore = { getClientId: getClientIdImpl };
    } else if (typeof clientId !== 'undefined') {
        window.DataStore = { getClientId: () => clientId };
    }
    window.eval(`${fs.readFileSync(CORE_API_JS, 'utf8')}\n//# sourceURL=file://${CORE_API_JS}`);
    return { window, cleanup: () => dom.window.close() };
}

function okResponse() {
    return {
        status: 200,
        ok: true,
        async text() { return JSON.stringify({ ok: true }); },
    };
}

describe('apiCallDirect X-Client-ID header', () => {
    it('attaches X-Client-ID on POST requests', async () => {
        const { window, cleanup } = loadEnv({ clientId: 'aaaa-bbbb-cccc-dddd' });
        try {
            let seenHeaders = null;
            window.fetch = async (_url, opts) => {
                seenHeaders = opts.headers;
                return okResponse();
            };
            await window.apiCallDirect('/api/foo', 'POST', { a: 1 });
            expect(seenHeaders['X-Client-ID']).toBe('aaaa-bbbb-cccc-dddd');
        } finally {
            cleanup();
        }
    });

    it('attaches X-Client-ID on PUT requests', async () => {
        const { window, cleanup } = loadEnv({ clientId: 'id-put' });
        try {
            let seenHeaders = null;
            window.fetch = async (_url, opts) => {
                seenHeaders = opts.headers;
                return okResponse();
            };
            await window.apiCallDirect('/api/foo/1', 'PUT', { a: 2 });
            expect(seenHeaders['X-Client-ID']).toBe('id-put');
        } finally {
            cleanup();
        }
    });

    it('attaches X-Client-ID on DELETE requests', async () => {
        const { window, cleanup } = loadEnv({ clientId: 'id-delete' });
        try {
            let seenHeaders = null;
            window.fetch = async (_url, opts) => {
                seenHeaders = opts.headers;
                return { status: 204, ok: true, async text() { return ''; } };
            };
            await window.apiCallDirect('/api/foo/1', 'DELETE');
            expect(seenHeaders['X-Client-ID']).toBe('id-delete');
        } finally {
            cleanup();
        }
    });

    it('does NOT attach X-Client-ID on GET requests', async () => {
        const { window, cleanup } = loadEnv({ clientId: 'id-get' });
        try {
            let seenHeaders = null;
            window.fetch = async (_url, opts) => {
                seenHeaders = opts.headers;
                return okResponse();
            };
            await window.apiCallDirect('/api/foo');
            expect('X-Client-ID' in seenHeaders).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('uses the exact value returned by DataStore.getClientId() (stable across calls)', async () => {
        const { window, cleanup } = loadEnv({ clientId: 'stable-uuid-1234' });
        try {
            const seen = [];
            window.fetch = async (_url, opts) => {
                seen.push(opts.headers['X-Client-ID']);
                return okResponse();
            };
            await window.apiCallDirect('/api/a', 'POST', { x: 1 });
            await window.apiCallDirect('/api/b', 'POST', { x: 2 });
            await window.apiCallDirect('/api/c', 'POST', { x: 3 });
            expect(seen).toEqual(['stable-uuid-1234', 'stable-uuid-1234', 'stable-uuid-1234']);
        } finally {
            cleanup();
        }
    });

    it('omits the header when window.DataStore is not loaded', async () => {
        // No DataStore on window at all — apiCallDirect must still send the
        // request without throwing. This is the legacy/test-isolation path.
        const { window, cleanup } = loadEnv();
        try {
            let seenHeaders = null;
            window.fetch = async (_url, opts) => {
                seenHeaders = opts.headers;
                return okResponse();
            };
            await window.apiCallDirect('/api/foo', 'POST', { a: 1 });
            expect('X-Client-ID' in seenHeaders).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('omits the header when getClientId() throws', async () => {
        const { window, cleanup } = loadEnv({
            getClientIdImpl: () => { throw new Error('boom'); },
        });
        try {
            let seenHeaders = null;
            window.fetch = async (_url, opts) => {
                seenHeaders = opts.headers;
                return okResponse();
            };
            await window.apiCallDirect('/api/foo', 'POST', { a: 1 });
            expect('X-Client-ID' in seenHeaders).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('omits the header when getClientId() returns an empty string', async () => {
        const { window, cleanup } = loadEnv({ clientId: '' });
        try {
            let seenHeaders = null;
            window.fetch = async (_url, opts) => {
                seenHeaders = opts.headers;
                return okResponse();
            };
            await window.apiCallDirect('/api/foo', 'POST', { a: 1 });
            expect('X-Client-ID' in seenHeaders).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('keeps both X-Telegram-Init-Data and X-Client-ID on the same write', async () => {
        const { window, cleanup } = loadEnv({ clientId: 'id-merge' });
        try {
            window.userInitData = 'telegram-init';
            let seenHeaders = null;
            window.fetch = async (_url, opts) => {
                seenHeaders = opts.headers;
                return okResponse();
            };
            await window.apiCallDirect('/api/foo', 'POST', { a: 1 });
            expect(seenHeaders['X-Telegram-Init-Data']).toBe('telegram-init');
            expect(seenHeaders['X-Client-ID']).toBe('id-merge');
            expect(seenHeaders['Content-Type']).toBe('application/json');
        } finally {
            cleanup();
        }
    });
});
