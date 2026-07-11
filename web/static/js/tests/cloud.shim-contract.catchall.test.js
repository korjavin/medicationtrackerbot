// bd med-9b8.1 — the cloud shim's fallback branch (web/cloud/js/apishim.js).
// Unmapped writes used to resolve null, so every unshimmed write silently
// looked like it succeeded. They now throw like unmapped reads. Also covers
// the cloud-mode /api/changes suppression in data-store.js, which was the
// source of the console warn spam. (POST /api/firstrun/complete used to be a
// hardcoded ack here; med-4pz.5 made it a real vault write, covered by
// cloud.shim-contract.settings.test.js.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

describe('cloud shim contract — unmapped-route fallback', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        env.cleanup();
        env = null;
    });

    it('rejects an unmapped write instead of resolving null', async () => {
        // /api/bp/reminder/test lived here (med-9b8.3), then
        // /api/gamification/targets (med-eyb mapped it). Use a plainly-unmapped route.
        await expect(env.window.offlineAwareApiCall('/api/unmapped-write', 'PUT'))
            .rejects.toMatchObject({ status: 404 });
    });

    it('rejects an unmapped read', async () => {
        await expect(env.window.offlineAwareApiCall('/api/nope', 'GET'))
            .rejects.toMatchObject({ status: 404 });
    });

    it('still warns once about the unmapped route (C2 discovery aid)', async () => {
        await env.window.offlineAwareApiCall('/api/unmapped-write', 'PUT').catch(() => {});
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining('unmapped route (C2 discovery): PUT /api/unmapped-write'),
        );
    });
});

describe('cloud shim contract — DataStore never polls /api/changes in cloud mode', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        env.window.__MEDTRACKER_CLOUD__ = true;
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('advanceCursorSilently and verifyAuthSession are no-ops', async () => {
        const direct = vi.fn();
        env.window.apiCallDirect = direct;

        await env.window.DataStore.advanceCursorSilently();
        await env.window.DataStore.verifyAuthSession();

        expect(direct).not.toHaveBeenCalled();
    });

    it('advanceCursorSilently still hits /api/changes in bot mode', async () => {
        delete env.window.__MEDTRACKER_CLOUD__;
        const direct = vi.fn().mockResolvedValue({ cursor: 7 });
        env.window.apiCallDirect = direct;

        await env.window.DataStore.advanceCursorSilently();

        expect(direct).toHaveBeenCalledWith(expect.stringContaining('/api/changes?since='), 'GET');
    });
});
