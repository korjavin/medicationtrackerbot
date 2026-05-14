// Unit tests for sw-api-helper.js — the swApiCall wrapper that SW
// notification-action handlers will use. The file is intended to be
// loaded into the SW via importScripts, so it attaches its API to
// `self`. We load it under a fresh sandbox per test to keep the
// helper's authToken state isolated.
//
// See docs/plans/2026-05-13-sw-handler-unification.md, Task 1.

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const HELPER_PATH = path.join(REPO_ROOT, 'web/static/js/sw-api-helper.js');
const HELPER_SOURCE = fs.readFileSync(HELPER_PATH, 'utf-8');

function loadHelper({ fetchImpl } = {}) {
    const selfObj = {};
    const sandbox = {
        self: selfObj,
        fetch: fetchImpl ?? (() => { throw new Error('fetch not stubbed'); }),
        Error,
        JSON,
        Promise,
        TypeError,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(HELPER_SOURCE, sandbox, { filename: HELPER_PATH });
    return { self: selfObj, sandbox };
}

function jsonResponse(body, { status = 200 } = {}) {
    const txt = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        async text() { return txt; },
    };
}

describe('sw-api-helper — swApiCall', () => {
    it('attaches SwApi and swApiCall to self', () => {
        const { self } = loadHelper({ fetchImpl: vi.fn() });
        expect(typeof self.SwApi).toBe('object');
        expect(typeof self.SwApi.call).toBe('function');
        expect(typeof self.swApiCall).toBe('function');
        expect(self.SwApi.authToken).toBe(null);
    });

    it('sends X-Telegram-Init-Data header when authToken is set', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
        const { self } = loadHelper({ fetchImpl: fetchMock });
        self.SwApi.authToken = 'init-data-blob';

        await self.swApiCall('/api/medications/skip', 'POST', { intake_id: 7 });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/medications/skip');
        expect(opts.method).toBe('POST');
        expect(opts.headers['X-Telegram-Init-Data']).toBe('init-data-blob');
        expect(opts.headers['Content-Type']).toBe('application/json');
    });

    it('omits X-Telegram-Init-Data header when authToken is unset', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(''));
        const { self } = loadHelper({ fetchImpl: fetchMock });

        await self.swApiCall('/api/bp/reminder/snooze', 'POST');

        const [, opts] = fetchMock.mock.calls[0];
        expect(opts.headers['X-Telegram-Init-Data']).toBeUndefined();
    });

    it('always attaches credentials: "include" so cookie auth keeps working', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(''));
        const { self } = loadHelper({ fetchImpl: fetchMock });

        await self.swApiCall('/api/bp/reminder/snooze', 'POST');

        const [, opts] = fetchMock.mock.calls[0];
        expect(opts.credentials).toBe('include');
    });

    it('returns parsed JSON body on 2xx', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ confirmed: 3 }));
        const { self } = loadHelper({ fetchImpl: fetchMock });

        const result = await self.swApiCall('/api/medications/confirm-schedule', 'POST', {
            scheduled_at: '2026-05-13T10:00:00Z',
            medication_ids: [1, 2],
            intake_ids: [10, 11],
        });

        expect(result).toEqual({ confirmed: 3 });
    });

    it('returns true on empty 2xx body', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(''));
        const { self } = loadHelper({ fetchImpl: fetchMock });

        const result = await self.swApiCall('/api/bp/reminder/snooze', 'POST');

        expect(result).toBe(true);
    });

    it('returns true on 204 No Content', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 204,
            statusText: 'No Content',
            async text() { return ''; },
        });
        const { self } = loadHelper({ fetchImpl: fetchMock });

        const result = await self.swApiCall('/api/workout/sessions/5/skip', 'POST');

        expect(result).toBe(true);
    });

    it('throws Error with .status set on non-2xx response', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            async text() { return 'token expired'; },
        });
        const { self } = loadHelper({ fetchImpl: fetchMock });

        await expect(self.swApiCall('/api/medications/skip', 'POST', { intake_id: 1 }))
            .rejects.toMatchObject({ message: 'token expired', status: 401 });
    });

    it('throws Error with statusText fallback when body is empty', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            async text() { return ''; },
        });
        const { self } = loadHelper({ fetchImpl: fetchMock });

        await expect(self.swApiCall('/api/bp/reminder/snooze', 'POST'))
            .rejects.toMatchObject({ message: 'Internal Server Error', status: 500 });
    });

    it('does not attach a request body when none is passed', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(''));
        const { self } = loadHelper({ fetchImpl: fetchMock });

        await self.swApiCall('/api/bp/reminder/snooze', 'POST');

        const [, opts] = fetchMock.mock.calls[0];
        expect(opts.body).toBe(null);
        expect(opts.headers['Content-Type']).toBeUndefined();
    });
});
