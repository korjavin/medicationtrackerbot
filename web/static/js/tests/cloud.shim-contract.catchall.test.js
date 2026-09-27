// bd med-9b8.1 — the cloud shim's fallback branch (web/cloud/js/apishim.js).
// Unmapped writes used to resolve null, so every unshimmed write silently
// looked like it succeeded. They now throw like unmapped reads. (POST
// /api/firstrun/complete used to be a hardcoded ack here; med-4pz.5 made it
// a real vault write, covered by cloud.shim-contract.settings.test.js.)
// Also pins the med-a9n5.6 deletion: DataStore exposes no change-feed
// surface and core/api.js carries no per-client write header — cloud
// refresh flows through sync.js invalidateTags + requestTabRefresh instead.
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

describe('cloud shim contract — DataStore exposes no change-feed surface', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        env.window.__MEDTRACKER_CLOUD__ = true;
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('the change feed is gone: no polling, cursor, client-id or auth-probe methods', () => {
        // med-a9n5.6 deleted the bot-mode changes cursor + SSE feed, the
        // client-id echo suppression and the cursor helpers. Pin the
        // deletion so the feed cannot be reintroduced without updating this
        // contract.
        const gone = [
            'startChangePolling',
            'stopChangePolling',
            'startChangeStream',
            'startChangePollInterval',
            'stopChangePollInterval',
            'buildChangesStreamURL',
            'pollChangesOnce',
            'advanceCursorSilently',
            'applyChangesPayload',
            'getChangeCursor',
            'setChangeCursor',
            'getClientId',
            'recordOwnWrite',
            'recordOwnWriteWithRollback',
            'verifyAuthSession',
            'handleUnauthorized',
            'pruneStaleClientCache',
            'getCacheMaxAgeMsByKey',
        ];
        for (const method of gone) {
            expect(env.window.DataStore[method]).toBeUndefined();
        }
        // The cloud refresh path stays: sync.js calls requestTabRefresh.
        expect(typeof env.window.DataStore.requestTabRefresh).toBe('function');
    });

    it('core/api.js exposes no makeWriteHeaders helper', () => {
        expect(env.window.makeWriteHeaders).toBeUndefined();
    });
});
