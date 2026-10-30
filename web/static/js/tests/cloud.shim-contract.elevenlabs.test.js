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
import { installApiShim } from '../../../cloud/js/apishim.js';

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

    // med-ku8r: ElevenLabs refuses uploads for custom-LLM agents; photos ride
    // the AI turn instead, so the BYO upload seam is gone.
    it('exposes no ElevenLabs file upload', () => {
        expect(env.window.CloudElevenLabs.uploadFile).toBeUndefined();
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
    // Agent GET mirrors the managed projection of the official response:
    // top-level conversation_config and optional platform_settings, with
    // unrelated provider metadata ignored by the verification contract.
    // https://elevenlabs.io/docs/api-reference/agents/get (verified 2026-10-30).
    function makeElevenLabsFetch({ existingTools = [], toolPages = null, agentId = 'agent-new', failAgentGet = 0, failAgentPatch = 0 } = {}) {
        const calls = [];
        const agents = new Map();
        const unavailable = () => ({ ok: false, status: 503, async text() { return 'Temporarily unavailable'; } });
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
                agents.set(agentId, JSON.parse(opts.body));
                return okJson({ agent_id: agentId });
            }
            if (url.startsWith('https://api.elevenlabs.io/v1/convai/agents/') && method === 'PATCH') {
                if (failAgentPatch-- > 0) return unavailable();
                agents.set(decodeURIComponent(url.split('/').pop()), JSON.parse(opts.body));
                return okJson({});
            }
            if (url.startsWith('https://api.elevenlabs.io/v1/convai/agents/') && method === 'GET') {
                if (failAgentGet-- > 0) return unavailable();
                return okJson(agents.get(decodeURIComponent(url.split('/').pop())));
            }
            throw new Error(`unexpected fetch ${method} ${url}`);
        });
        return { spy, calls, agents };
    }

    const existingAll = () => TOOL_SPECS.map((s) => ({ id: `tool-${s.name}`, tool_config: { name: s.name } }));

    async function setKey(window, extra = {}) {
        await window.apiCall('/api/settings/integrations', 'PATCH', {
            elevenlabs: { api_key: 'xi-test-key', ...extra },
        });
    }

    function reloadProvisioner(productName) {
        const { window, records } = env;
        let meta = window.document.querySelector('meta[name="medtracker-product-name"]');
        if (!meta) {
            meta = window.document.createElement('meta');
            meta.name = 'medtracker-product-name';
            window.document.head.appendChild(meta);
        }
        meta.content = productName;
        installApiShim({}, { records, win: window });
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
                tool_call_sound: 'typing',
                tool_call_sound_behavior: 'always',
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

    it('ensureAgent creates once with tool_ids, then reuses on matching version', async () => {
        const { window } = env;
        await setKey(window);
        const first = makeElevenLabsFetch({ existingTools: existingAll() });
        vi.stubGlobal('fetch', first.spy);

        const [agentId, concurrentId] = await Promise.all([
            window.CloudElevenLabsAgent.provision(), window.CloudElevenLabsAgent.provision(),
        ]);
        expect(agentId).toBe('agent-new');
        expect(concurrentId).toBe(agentId);
        expect(first.calls.filter((c) => c.url.endsWith('/agents/create'))).toHaveLength(1);

        const createCall = first.calls.find((c) => c.url.endsWith('/agents/create'));
        const agent = createCall.body.conversation_config.agent;
        expect(agent.prompt.tool_ids).toHaveLength(TOOL_SPECS.length);
        expect(agent.prompt.prompt).toMatch(/tool/i);
        expect(agent.first_message).toContain("I'm your MyHealthBot health bot.");
        expect(createCall.body.conversation_config.tts.voice_id).toBeTruthy();
        // The agent's LLM is the voice relay on this account's origin (bd med-h849.3).
        expect(agent.prompt.llm).toBe('custom-llm');
        expect(agent.prompt.custom_llm.url).toBe(`${window.location.origin}/api/voice-llm`);
        expect(createCall.body.platform_settings.overrides.custom_llm_extra_body).toBe(true);

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
        expect(patch.body.conversation_config.tts.voice_id).toBeTruthy();
        expect(patch.body.conversation_config.agent.prompt.custom_llm.url).toBe(`${window.location.origin}/api/voice-llm`);
    });

    it('silently upgrades the existing agent with the instance identity from app metadata', async () => {
        const { window, records } = env;
        const meta = window.document.createElement('meta');
        meta.name = 'medtracker-product-name';
        meta.content = 'Example Health & Care';
        window.document.head.appendChild(meta);
        // Reinstall against the same vault after the server-provided metadata
        // is present, as it is before the shim boots in a served app document.
        installApiShim({}, { records, win: window });
        await setKey(window);
        await records.put('voiceprovisioning', {
            recordId: 'voiceprovisioning', agentId: 'agent-existing',
            toolsetVersion: 10, toolIds: {},
        });
        const { spy, calls } = makeElevenLabsFetch({ existingTools: existingAll() });
        vi.stubGlobal('fetch', spy);

        expect(await window.CloudElevenLabsAgent.provision()).toBe('agent-existing');
        expect(calls.some((c) => c.url.endsWith('/agents/create'))).toBe(false);
        const patch = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/agents/agent-existing'));
        const config = patch.body.conversation_config;
        expect(config.agent.prompt.prompt).toContain("You are the user's Example Health & Care health bot");
        expect(config.agent.first_message).toContain("I'm your Example Health & Care health bot.");
        for (const preset of Object.values(config.language_presets)) {
            expect(preset.overrides.agent.first_message).toContain(meta.content);
        }
        expect((await records.list('voiceprovisioning'))[0].toolsetVersion).toBe(TOOLSET_VERSION);
        const saved = await window.apiCall('/api/settings/integrations');
        expect(saved.elevenlabs.api_key).toBe('***');

        spy.mockClear();
        expect(await window.CloudElevenLabsAgent.provision()).toBe('agent-existing');
        expect(spy).not.toHaveBeenCalled();

        // A server restart with a new instance name changes the app metadata
        // without changing the tool specs. The existing managed agent must
        // still adopt that name on its next call.
        meta.content = 'Renamed Care';
        installApiShim({}, { records, win: window });
        calls.length = 0;
        expect(await window.CloudElevenLabsAgent.provision()).toBe('agent-existing');
        const renamed = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/agents/agent-existing'));
        expect(renamed).toBeDefined();
        expect(renamed.body.conversation_config.agent.first_message).toContain("I'm your Renamed Care health bot.");
        expect(renamed.body.conversation_config.agent.prompt.tool_ids).toEqual(config.agent.prompt.tool_ids);
        expect(calls.filter((c) => c.method === 'GET' && c.url.endsWith('/agents/agent-existing'))).toHaveLength(1);
        expect(calls.some((c) => c.url.includes('/tools'))).toBe(false);
        expect((await records.list('voiceprovisioning'))[0].toolsetVersion).toBe(TOOLSET_VERSION);
        spy.mockClear();
        expect(await window.CloudElevenLabsAgent.provision()).toBe('agent-existing');
        expect(spy).not.toHaveBeenCalled();
    });

    it('verifies a current agent once after reload, coalesces calls, and ignores provider-added fields', async () => {
        const { window, records } = env;
        await setKey(window);
        const { spy, calls, agents } = makeElevenLabsFetch({ existingTools: existingAll() });
        vi.stubGlobal('fetch', spy);
        await window.CloudElevenLabsAgent.provision();
        agents.get('agent-new').conversation_config.agent.prompt.provider_default = 'extra';
        agents.get('agent-new').access_info = { role: 'admin' };
        const saved = await records.list('voiceprovisioning');
        reloadProvisioner('MyHealthBot');
        calls.length = 0;

        expect(await Promise.all([
            window.CloudElevenLabsAgent.provision(), window.CloudElevenLabsAgent.provision(),
        ])).toEqual(['agent-new', 'agent-new']);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ method: 'GET', url: expect.stringContaining('/agents/agent-new') });
        expect(await records.list('voiceprovisioning')).toEqual(saved);
        spy.mockClear();
        await window.CloudElevenLabsAgent.provision();
        expect(spy).not.toHaveBeenCalled();
    });

    it('invalidates the in-memory verification when the saved key or selected agent changes', async () => {
        const { window } = env;
        await setKey(window);
        const { spy, calls, agents } = makeElevenLabsFetch({ existingTools: existingAll() });
        vi.stubGlobal('fetch', spy);
        await window.CloudElevenLabsAgent.provision();
        await setKey(window, { api_key: 'xi-rotated-key' });
        calls.length = 0;
        expect(await window.CloudElevenLabsAgent.provision()).toBe('agent-new');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ method: 'GET', headers: { 'xi-api-key': 'xi-rotated-key' } });

        agents.set('selected-agent', structuredClone(agents.get('agent-new')));
        await setKey(window, { api_key: 'xi-rotated-key', agent_id: 'selected-agent' });
        calls.length = 0;
        expect(await window.CloudElevenLabsAgent.provision()).toBe('selected-agent');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ method: 'GET', url: expect.stringContaining('/agents/selected-agent') });
        spy.mockClear();
        await window.CloudElevenLabsAgent.provision();
        expect(spy).not.toHaveBeenCalled();
    });

    it('keeps newer synced provisioning during an identity repair and verifies that newer agent on the next call', async () => {
        const { window, records } = env;
        await setKey(window);
        const { spy, calls, agents } = makeElevenLabsFetch({ existingTools: existingAll() });
        vi.stubGlobal('fetch', spy);
        await window.CloudElevenLabsAgent.provision();
        reloadProvisioner('Renamed Care');

        let releasePatch;
        let patchStarted;
        const held = new Promise((resolve) => { releasePatch = resolve; });
        const started = new Promise((resolve) => { patchStarted = resolve; });
        const respond = spy.getMockImplementation();
        spy.mockImplementation(async (url, opts = {}) => {
            if (opts.method === 'PATCH' && url.endsWith('/agents/agent-new')) {
                patchStarted();
                await held;
            }
            return respond(url, opts);
        });
        const repairing = window.CloudElevenLabsAgent.provision();
        await started;
        // Another device's provisioning row reaches the local mirror while
        // the identity-only provider PATCH is still in flight.
        await records.put('voiceprovisioning', {
            recordId: 'voiceprovisioning', clientTs: Date.now() + 1000, deleted: false,
            agentId: 'agent-synced', toolsetVersion: TOOLSET_VERSION,
            toolIds: Object.fromEntries(TOOL_SPECS.map((s) => [s.name, `synced-${s.name}`])),
        });
        const newer = await records.list('voiceprovisioning');
        releasePatch();
        expect(await repairing).toBe('agent-new');
        const afterRepair = await records.list('voiceprovisioning');
        const syncedAgent = structuredClone(agents.get('agent-new'));
        syncedAgent.conversation_config.agent.prompt.tool_ids = Object.values(newer[0].toolIds);
        agents.set('agent-synced', syncedAgent);
        calls.length = 0;
        const nextId = await window.CloudElevenLabsAgent.provision();

        expect(afterRepair).toEqual(newer);
        expect(nextId).toBe('agent-synced');
        expect(calls.map((c) => [c.method, c.url.split('/').pop()])).toEqual([['GET', 'agent-synced']]);
        expect(await records.list('voiceprovisioning')).toEqual(newer);
    });

    it.each(['llm', 'url', 'model_id', 'api_type', 'override', 'translated greeting'])('repairs current-name agents with incompatible managed %s without rewriting tools', async (field) => {
        const { window } = env;
        await setKey(window);
        const { spy, calls, agents } = makeElevenLabsFetch({ existingTools: existingAll() });
        vi.stubGlobal('fetch', spy);
        await window.CloudElevenLabsAgent.provision();
        const actual = agents.get('agent-new');
        if (field === 'llm') actual.conversation_config.agent.prompt.llm = 'built-in';
        else if (field === 'override') actual.platform_settings.overrides.custom_llm_extra_body = false;
        else if (field === 'translated greeting') actual.conversation_config.language_presets.de.overrides.agent.first_message = 'Old identity';
        else actual.conversation_config.agent.prompt.custom_llm[field] = 'incompatible';
        reloadProvisioner('MyHealthBot');
        calls.length = 0;

        expect(await window.CloudElevenLabsAgent.provision()).toBe('agent-new');
        expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
        expect(calls.every((c) => c.url.endsWith('/agents/agent-new'))).toBe(true);
        const repaired = agents.get('agent-new');
        expect(repaired.conversation_config.agent.prompt.llm).toBe('custom-llm');
        expect(repaired.conversation_config.agent.prompt.custom_llm).toEqual({
            url: `${window.location.origin}/api/voice-llm`, model_id: 'medtracker', api_type: 'chat_completions',
        });
        expect(repaired.platform_settings.overrides.custom_llm_extra_body).toBe(true);
        expect(repaired.conversation_config.language_presets.de.overrides.agent.first_message).toContain('MyHealthBot');
    });

    it.each(['GET', 'PATCH'])('retries failed %s identity verification/repair without creating a replacement or memoizing failure', async (method) => {
        const { window, records } = env;
        await setKey(window);
        const { spy, calls } = makeElevenLabsFetch({
            existingTools: existingAll(), failAgentGet: method === 'GET' ? 1 : 0, failAgentPatch: method === 'PATCH' ? 1 : 0,
        });
        vi.stubGlobal('fetch', spy);
        await window.CloudElevenLabsAgent.provision();
        const saved = await records.list('voiceprovisioning');
        reloadProvisioner('Renamed Care');
        calls.length = 0;

        const results = await Promise.allSettled([
            window.CloudElevenLabsAgent.provision(), window.CloudElevenLabsAgent.provision(),
        ]);
        expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
        expect(results[0].reason.message).toContain('(503)');
        expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
        expect(await records.list('voiceprovisioning')).toEqual(saved);
        calls.length = 0;
        expect(await window.CloudElevenLabsAgent.provision()).toBe('agent-new');
        expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
        expect(calls.every((c) => c.url.endsWith('/agents/agent-new'))).toBe(true);
        spy.mockClear();
        await window.CloudElevenLabsAgent.provision();
        expect(spy).not.toHaveBeenCalled();
    });

    it('missing key: throws a Settings/Integrations hint without calling fetch', async () => {
        const { window } = env;
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        await expect(window.CloudElevenLabsAgent.provision()).rejects.toThrow(/Settings.*Integrations/i);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

// bd med-h849.2 — window.CloudVoiceLLM: the voice LLM relay's device leg, wired
// by installApiShim to the same aiClient the food AI uses. A relay request
// frame reaches the user's own provider with the vault key + model and
// stream:true, and the provider's raw SSE comes back as chunk frames.
describe('cloud shim contract — voice LLM relay leg (web/cloud/js/voice-llm-responder.js)', () => {
    let env;

    class FakeSocket {
        constructor(url) {
            this.url = url;
            this.readyState = 1;
            this.sent = [];
            FakeSocket.last = this;
        }

        send(data) { this.sent.push(JSON.parse(data)); }

        close() { this.readyState = 3; }

        recv(frame) { this.onmessage({ data: JSON.stringify(frame) }); }
    }
    FakeSocket.OPEN = 1;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
        env.window.__MEDTRACKER_CLOUD__ = true;
        vi.stubGlobal('WebSocket', FakeSocket);
        vi.stubGlobal('location', { protocol: 'https:', host: 'acct.example.test' });
    });

    afterEach(() => {
        env.window.CloudVoiceLLM.stop();
        vi.unstubAllGlobals();
        env.cleanup();
        env = null;
    });

    it('serves a relay request through the vault provider and streams the raw SSE back', async () => {
        const { window } = env;
        await window.apiCall('/api/settings/integrations', 'PATCH', {
            openai: { api_key: 'sk-test-dummy', url: 'https://api.example.test/v1', model: 'my-model' },
        });
        const sse = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
        let reads = 0;
        const fetchSpy = vi.fn(async () => ({
            ok: true,
            status: 200,
            body: {
                getReader: () => ({
                    read: async () => (reads++ === 0
                        ? { done: false, value: new TextEncoder().encode(sse) }
                        : { done: true, value: undefined }),
                }),
            },
        }));
        vi.stubGlobal('fetch', fetchSpy);

        const started = window.CloudVoiceLLM.start();
        const sock = FakeSocket.last;
        expect(sock.url).toBe('wss://acct.example.test/api/voice-llm/device');
        sock.recv({ type: 'hello', call: 'tok' });
        await expect(started).resolves.toBe('tok');

        sock.recv({ id: 1, type: 'request', body: { model: 'medtracker', messages: [{ role: 'user', content: 'hi' }] } });
        await vi.waitFor(() => expect(sock.sent.at(-1)).toEqual({ id: 1, type: 'end' }));

        expect(sock.sent[0]).toEqual({ id: 1, type: 'chunk', data: sse });
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://api.example.test/v1/chat/completions');
        expect(init.headers.Authorization).toBe('Bearer sk-test-dummy');
        expect(JSON.parse(init.body)).toMatchObject({ model: 'my-model', stream: true });
    });
});
