// Auth header consolidation — Task 4 of the
// 2026-05-13-auth-header-consolidation plan.
//
// Pins that the two CSV-export direct-fetch call sites
// (`exportBPCSV` in features/bp.js and `exportWeightCSV` in
// features/weight.js) build their auth headers via
// window.makeAuthHeaders() rather than constructing the legacy
// `Authorization: tma <init>` scheme inline. After this task, no
// client-side code uses `Authorization: tma`; the server-side parser
// stays in place as a no-op (see plan §Post-Completion).
//
// Each case asserts the fetch saw exactly the headers the helper
// returns for the configured userInitData, so a regression to inline
// `Authorization` construction would either drop the header or use the
// wrong scheme.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('CSV-export call sites route through makeAuthHeaders()', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ telegramInitData: 'csv-export-token' });
        env.window.downloadBlobAsFile = vi.fn();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('exportBPCSV sends X-Telegram-Init-Data from window.userInitData (no Authorization scheme)', async () => {
        const { window } = env;
        const helperSpy = vi.spyOn(window, 'makeAuthHeaders');
        window.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            async blob() { return new window.Blob(['systolic,diastolic\n']); }
        }));

        await window.exportBPCSV();

        expect(helperSpy).toHaveBeenCalled();
        expect(window.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = window.fetch.mock.calls[0];
        expect(url).toBe('/api/bp/export');
        expect(init.method).toBe('GET');
        expect(init.headers).toEqual({ 'X-Telegram-Init-Data': 'csv-export-token' });
        expect(init.headers.Authorization).toBeUndefined();
    });

    it('exportWeightCSV sends X-Telegram-Init-Data from window.userInitData (no Authorization scheme)', async () => {
        const { window } = env;
        const helperSpy = vi.spyOn(window, 'makeAuthHeaders');
        window.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            async blob() { return new window.Blob(['weight\n']); }
        }));

        await window.exportWeightCSV();

        expect(helperSpy).toHaveBeenCalled();
        expect(window.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = window.fetch.mock.calls[0];
        expect(url).toBe('/api/weight/export');
        expect(init.method).toBe('GET');
        expect(init.headers).toEqual({ 'X-Telegram-Init-Data': 'csv-export-token' });
        expect(init.headers.Authorization).toBeUndefined();
    });

    it('exportBPCSV omits the auth header entirely when init data is empty (helper contract)', async () => {
        env.cleanup();
        env = loadFrontendEnv();
        env.window.downloadBlobAsFile = vi.fn();
        const { window } = env;
        window.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            async blob() { return new window.Blob(['']); }
        }));

        await window.exportBPCSV();

        expect(window.fetch).toHaveBeenCalledTimes(1);
        const [, init] = window.fetch.mock.calls[0];
        expect('X-Telegram-Init-Data' in init.headers).toBe(false);
        expect('Authorization' in init.headers).toBe(false);
    });

    it('exportWeightCSV omits the auth header entirely when init data is empty (helper contract)', async () => {
        env.cleanup();
        env = loadFrontendEnv();
        env.window.downloadBlobAsFile = vi.fn();
        const { window } = env;
        window.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            async blob() { return new window.Blob(['']); }
        }));

        await window.exportWeightCSV();

        expect(window.fetch).toHaveBeenCalledTimes(1);
        const [, init] = window.fetch.mock.calls[0];
        expect('X-Telegram-Init-Data' in init.headers).toBe(false);
        expect('Authorization' in init.headers).toBe(false);
    });
});
