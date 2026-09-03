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
import { TOOL_SPECS, TOOLSET_VERSION } from '../../../cloud/js/elevenlabs-agent.js';

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

    // Browser-direct "Send photo" upload — same BYO fetch boundary as the
    // signed-URL path. Bot mode proxies this through the server; cloud POSTs
    // multipart straight to api.elevenlabs.io with the vault key.
    it('uploadFile: POSTs multipart to the conversation files endpoint with the vault key, returns file_id', async () => {
        const { window } = env;
        await window.apiCall('/api/settings/integrations', 'PATCH', {
            elevenlabs: { api_key: 'xi-test-key', agent_id: 'agent-123' }
        });

        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true, status: 200,
            async json() { return { file_id: 'file-abc' }; }
        });
        vi.stubGlobal('fetch', fetchSpy);

        const file = new File(['bytes'], 'meal.jpg', { type: 'image/jpeg' });
        const id = await window.CloudElevenLabs.uploadFile('conv_test', file);
        expect(id).toBe('file-abc');

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [calledUrl, opts] = fetchSpy.mock.calls[0];
        expect(calledUrl).toBe('https://api.elevenlabs.io/v1/convai/conversations/conv_test/files');
        expect(opts.method).toBe('POST');
        expect(opts.headers['xi-api-key']).toBe('xi-test-key');
        expect(opts.body).toBeInstanceOf(FormData);
        expect(opts.body.get('file')).toBeInstanceOf(File);
        expect(opts.body.get('file').name).toBe('meal.jpg');
    });

    it('uploadFile: missing key throws a Settings/Integrations hint without calling fetch', async () => {
        const { window } = env;
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        const file = new File(['bytes'], 'meal.jpg', { type: 'image/jpeg' });
        await expect(window.CloudElevenLabs.uploadFile('conv_test', file))
            .rejects.toThrow(/Settings.*Integrations/i);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('uploadFile: rejects a path-unsafe conversation id without calling fetch', async () => {
        const { window } = env;
        await window.apiCall('/api/settings/integrations', 'PATCH', {
            elevenlabs: { api_key: 'xi-test-key' }
        });
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        const file = new File(['bytes'], 'meal.jpg', { type: 'image/jpeg' });
        await expect(window.CloudElevenLabs.uploadFile('conv/../evil', file))
            .rejects.toThrow(/Invalid conversation id/i);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('uploadFile: propagates a non-ok response as an error with .status', async () => {
        const { window } = env;
        await window.apiCall('/api/settings/integrations', 'PATCH', {
            elevenlabs: { api_key: 'xi-test-key' }
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 413, async json() { return {}; } }));

        const file = new File(['bytes'], 'meal.jpg', { type: 'image/jpeg' });
        await expect(window.CloudElevenLabs.uploadFile('conv_test', file))
            .rejects.toMatchObject({ status: 413 });
    });

    it('uploadFile: throws when the response is missing file_id', async () => {
        const { window } = env;
        await window.apiCall('/api/settings/integrations', 'PATCH', {
            elevenlabs: { api_key: 'xi-test-key' }
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, async json() { return {}; } }));

        const file = new File(['bytes'], 'meal.jpg', { type: 'image/jpeg' });
        await expect(window.CloudElevenLabs.uploadFile('conv_test', file))
            .rejects.toThrow(/missing file_id/i);
    });
});

// Plan 2026-07-06 cloud-voice, Task 5 — the browser-direct agent + tool
// provisioner (web/cloud/js/elevenlabs-agent.js, published as
// window.CloudElevenLabsAgent). Same fetch-boundary fake as above: the tab
// calls api.elevenlabs.io directly with the vault key. We route the mock by
// URL + method so we can assert idempotency (GET-then-conditional-POST) and the
// exact request shapes.
describe('cloud shim contract — ElevenLabs provisioner (web/cloud/js/elevenlabs-agent.js)', () => {
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

    function okJson(data) {
        return { ok: true, status: 200, async json() { return data; }, async text() { return JSON.stringify(data); } };
    }

    // Route fetch by URL + method. `existingTools` is what GET /tools returns;
    // POST /tools mints `tool-<name>`; POST /agents/create returns `agentId`;
    // PATCH echoes the id. Records every call for assertions.
    // `existingTools` is the single-page case; `toolPages` (keyed by the cursor
    // the request carried, '' for the first) drives the multi-page case.
    function makeElevenLabsFetch({ existingTools = [], toolPages = null, agentId = 'agent-new' } = {}) {
        const calls = [];
        toolPages = toolPages || { '': { tools: existingTools, has_more: false } };
        const spy = vi.fn(async (url, opts = {}) => {
            const method = (opts.method || 'GET').toUpperCase();
            calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : undefined, headers: opts.headers || {} });
            // The list call carries query params (own tools only, paged) —
            // match on the path, not on an exact URL.
            if (url.startsWith('https://api.elevenlabs.io/v1/convai/tools?') && method === 'GET') {
                const cursor = new URL(url).searchParams.get('cursor') || '';
                const page = toolPages[cursor];
                if (!page) throw new Error(`unexpected tool-list cursor ${JSON.stringify(cursor)}`);
                return okJson(page);
            }
            if (url === 'https://api.elevenlabs.io/v1/convai/tools' && method === 'POST') {
                return okJson({ id: `tool-${JSON.parse(opts.body).tool_config.name}` });
            }
            if (url.startsWith('https://api.elevenlabs.io/v1/convai/tools/') && method === 'PATCH') {
                return okJson({});
            }
            if (url === 'https://api.elevenlabs.io/v1/convai/agents/create' && method === 'POST') {
                return okJson({ agent_id: agentId });
            }
            if (url.startsWith('https://api.elevenlabs.io/v1/convai/agents/') && method === 'PATCH') {
                return okJson({});
            }
            throw new Error(`unexpected fetch ${method} ${url}`);
        });
        return { spy, calls };
    }

    const existingAll = () => TOOL_SPECS.map((s) => ({ id: `tool-${s.name}`, tool_config: { name: s.name } }));

    async function setKey(window, extra = {}) {
        await window.apiCall('/api/settings/integrations', 'PATCH', {
            elevenlabs: { api_key: 'xi-test-key', ...extra },
        });
    }

    it('ensureTools: all tools present → no duplicate create POST, PATCHes each in place', async () => {
        const { window } = env;
        await setKey(window);
        const { spy, calls } = makeElevenLabsFetch({ existingTools: existingAll() });
        vi.stubGlobal('fetch', spy);

        await window.CloudElevenLabsAgent.provision();

        // No duplicate tools minted (POST /tools creates a fresh tool each time).
        const toolPosts = calls.filter((c) => c.url.endsWith('/tools') && c.method === 'POST');
        expect(toolPosts).toHaveLength(0);
        // But each existing tool is PATCHed so a spec edit under a version bump
        // actually propagates.
        const toolPatches = calls.filter((c) => c.url.includes('/tools/') && c.method === 'PATCH');
        expect(toolPatches).toHaveLength(TOOL_SPECS.length);
        expect(toolPatches[0].body.tool_config).toMatchObject({ type: 'client', expects_response: true });
        // xi-api-key on the tool list call.
        const listCall = calls.find((c) => c.url.includes('/convai/tools?') && c.method === 'GET');
        expect(listCall.headers['xi-api-key']).toBe('xi-test-key');
        // Own tools only: a tool merely SHARED with the account must not be
        // PATCHed (we don't own it) nor block creating ours.
        expect(new URL(listCall.url).searchParams.get('created_by_user_id')).toBe('@me');
    });

    it('ensureTools creates missing tools with the exact client tool_config shape', async () => {
        const { window } = env;
        await setKey(window);
        const { spy, calls } = makeElevenLabsFetch({ existingTools: [] });
        vi.stubGlobal('fetch', spy);

        await window.CloudElevenLabsAgent.provision();

        const toolPosts = calls.filter((c) => c.url.endsWith('/tools') && c.method === 'POST');
        expect(toolPosts).toHaveLength(TOOL_SPECS.length);
        const bp = toolPosts.find((c) => c.body.tool_config.name === 'log_blood_pressure');
        expect(bp.body).toEqual({
            tool_config: {
                type: 'client',
                name: 'log_blood_pressure',
                description: expect.any(String),
                parameters: expect.objectContaining({ type: 'object', required: ['systolic', 'diastolic'] }),
                expects_response: true,
            },
        });
    });

    it('ensureTools pages through the tool list instead of re-minting tools past page 1', async () => {
        // GET /tools returns 30 per page. Stopping at page 1 makes an existing
        // tool look missing, so every run mints a duplicate and wires the agent
        // to the copy — the opposite of idempotent (bd med-qgnk).
        const { window } = env;
        await setKey(window);
        const all = existingAll();
        const { spy, calls } = makeElevenLabsFetch({
            toolPages: {
                '': { tools: all.slice(0, 2), has_more: true, next_cursor: 'page-2' },
                'page-2': { tools: all.slice(2), has_more: false, next_cursor: null },
            },
        });
        vi.stubGlobal('fetch', spy);

        await window.CloudElevenLabsAgent.provision();

        expect(calls.filter((c) => c.url.includes('/convai/tools?') && c.method === 'GET')).toHaveLength(2);
        expect(calls.filter((c) => c.url.endsWith('/tools') && c.method === 'POST')).toHaveLength(0);
        expect(calls.filter((c) => c.url.includes('/tools/') && c.method === 'PATCH')).toHaveLength(TOOL_SPECS.length);
    });

    it('ensureAgent creates once with tool_ids + tool_call_sound, then reuses on matching version', async () => {
        const { window } = env;
        await setKey(window);
        const first = makeElevenLabsFetch({ existingTools: existingAll() });
        vi.stubGlobal('fetch', first.spy);

        const agentId = await window.CloudElevenLabsAgent.provision();
        expect(agentId).toBe('agent-new');

        const createCall = first.calls.find((c) => c.url.endsWith('/agents/create'));
        const agent = createCall.body.conversation_config.agent;
        expect(agent.prompt.tool_ids).toHaveLength(TOOL_SPECS.length);
        expect(agent.prompt.prompt).toMatch(/tool/i);
        expect(agent.tool_call_sound).toBe('typing');
        expect(agent.tool_call_sound_behavior).toBe('always');
        expect(createCall.body.conversation_config.tts.voice_id).toBeTruthy();

        // Second provision on the same (stored) TOOLSET_VERSION reuses the agent.
        const second = makeElevenLabsFetch({ existingTools: existingAll() });
        vi.stubGlobal('fetch', second.spy);
        const again = await window.CloudElevenLabsAgent.provision();
        expect(again).toBe('agent-new');
        // Reuse touches no ElevenLabs API at all (the invariant — not merely
        // "skips /agents/create").
        expect(second.spy).not.toHaveBeenCalled();
        // Sanity: the version we stored is the module's current one.
        expect(TOOLSET_VERSION).toBeGreaterThan(0);
    });

    it('reuses a user-preset agent_id via PATCH instead of creating a new agent', async () => {
        const { window } = env;
        await setKey(window, { agent_id: 'preset-1' });
        const { spy, calls } = makeElevenLabsFetch({ existingTools: existingAll() });
        vi.stubGlobal('fetch', spy);

        const id = await window.CloudElevenLabsAgent.provision();
        expect(id).toBe('preset-1');
        expect(calls.some((c) => c.url.endsWith('/agents/create'))).toBe(false);
        const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/agents/'));
        expect(patch.url).toContain('preset-1');
        expect(patch.body.conversation_config.agent.tool_call_sound).toBe('typing');
    });

    it('missing key: throws a Settings/Integrations hint without calling fetch', async () => {
        const { window } = env;
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        await expect(window.CloudElevenLabsAgent.provision()).rejects.toThrow(/Settings.*Integrations/i);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
