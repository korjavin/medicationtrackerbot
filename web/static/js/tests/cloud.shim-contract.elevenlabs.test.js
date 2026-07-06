// Plan 2026-07-06 cloud-voice, Task 1 — shim-mode contract run of the
// browser-direct ElevenLabs signed-URL client (web/cloud/js/elevenlabs-signed-url.js,
// published as window.CloudElevenLabs by apishim.js). Cloud mode has no server
// signed-URL route: the tab mints the URL directly against api.elevenlabs.io
// with the vault's BYO key, so the only thing this suite fakes is that
// endpoint's HTTP response, at the `fetch` boundary. Like aiclient.js, the
// client is a real ES module whose bare `fetch` resolves against this test
// file's realm (vitest node env), so stubGlobal('fetch') intercepts it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApiCache, loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

describe('cloud shim contract — ElevenLabs signed URL (web/cloud/js/elevenlabs-signed-url.js)', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
        env.window.__MEDTRACKER_CLOUD__ = true;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        env.cleanup();
        env = null;
    });

    it('mints browser-direct: xi-api-key header + agent_id query from the vault, returns signed_url', async () => {
        const { window } = env;
        await window.apiCall('/api/settings/integrations', 'PATCH', {
            elevenlabs: { api_key: 'xi-test-key', agent_id: 'agent-123' }
        });

        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true, status: 200,
            async json() { return { signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?token=abc' }; }
        });
        vi.stubGlobal('fetch', fetchSpy);

        const url = await window.CloudElevenLabs.fetchSignedURL();
        expect(url).toBe('wss://api.elevenlabs.io/v1/convai/conversation?token=abc');

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [calledUrl, opts] = fetchSpy.mock.calls[0];
        expect(calledUrl).toBe('https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=agent-123');
        expect(opts.headers['xi-api-key']).toBe('xi-test-key');
    });

    it('missing key or agent_id: throws a Settings/Integrations hint without calling fetch', async () => {
        const { window } = env;
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        // No vault record at all.
        await expect(window.CloudElevenLabs.fetchSignedURL())
            .rejects.toThrow(/Settings.*Integrations/i);

        // agent_id set but key missing.
        await window.apiCall('/api/settings/integrations', 'PATCH', {
            elevenlabs: { agent_id: 'agent-123' }
        });
        await expect(window.CloudElevenLabs.fetchSignedURL())
            .rejects.toThrow(/Settings.*Integrations/i);

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('propagates a non-ok response as an error with .status, never leaking the key', async () => {
        const { window } = env;
        await window.apiCall('/api/settings/integrations', 'PATCH', {
            elevenlabs: { api_key: 'xi-test-key', agent_id: 'agent-123' }
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, async json() { return {}; } }));

        await expect(window.CloudElevenLabs.fetchSignedURL()).rejects.toMatchObject({ status: 401 });

        // Masked-key parity: GET never returns the raw key.
        const integrations = await window.apiCall('/api/settings/integrations', 'GET');
        expect(integrations.elevenlabs.api_key).toBe('***');
        expect(JSON.stringify(integrations)).not.toContain('xi-test-key');
    });
});
