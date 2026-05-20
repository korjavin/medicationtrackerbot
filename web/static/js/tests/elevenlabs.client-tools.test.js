// Dynamic MCP client tools — Task 4 of
// 2026-05-18-elevenlabs-dynamic-mcp-client-tools.
//
// Asserts that the ElevenLabs voice-call controller, before calling
// startSession, mints a short-lived MCP session token via
// /api/elevenlabs/mcp-session-token, builds a `clientTools` object with
// `mcp_help` + `mcp_execute` definitions, and routes each invocation as a
// JSON-RPC tools/call POST to the MCP server. Also pins the 401-refresh-
// retry path and the JSON-RPC error propagation.
//
// Mirrors features.elevenlabs-call.test.js's harness: patches the
// dynamic SDK import to a resolved fake, stubs apiCallDirect for the
// signed-URL + mint endpoints, and captures the options passed to
// Conversation.startSession.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ELEVENLABS_JS = path.join(REPO_ROOT, 'web/static/js/features/elevenlabs-call.js');

const TEST_TOKEN = 'mcp_test_token_abc';
const TEST_MCP_URL = 'https://mcp.example.test';

function makeApiCallStub({ token = TEST_TOKEN, mcpUrl = TEST_MCP_URL, expiresAt } = {}) {
    const calls = [];
    const stub = vi.fn(async (url, method) => {
        calls.push({ url, method });
        if (url === '/api/elevenlabs/mcp-session-token') {
            return {
                token,
                mcp_server_url: mcpUrl,
                expires_at: typeof expiresAt === 'number'
                    ? expiresAt
                    : Math.floor(Date.now() / 1000) + 900,
            };
        }
        if (url === '/api/elevenlabs/signed-url') {
            return { signed_url: 'wss://stub.example/signed' };
        }
        throw new Error(`Unexpected apiCall: ${url}`);
    });
    return { stub, calls };
}

function makeMCPFetchStub({ result = { content: [{ type: 'text', text: '{"ok":true}' }] }, status = 200, error = null } = {}) {
    const calls = [];
    const stub = vi.fn(async (url, init) => {
        calls.push({ url, init });
        const body = {
            jsonrpc: '2.0',
            id: 1,
        };
        if (error) body.error = error;
        else body.result = result;
        return {
            ok: status >= 200 && status < 300,
            status,
            async text() { return JSON.stringify(body); },
            async json() { return body; },
        };
    });
    return { stub, calls };
}

function bootEnv({ apiStub, fetchStub } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://example.test/',
        runScripts: 'outside-only',
    });
    const { window } = dom;

    window.apiCallDirect = (apiStub || makeApiCallStub().stub);
    window.fetch = fetchStub || makeMCPFetchStub().stub;

    const raw = fs.readFileSync(ELEVENLABS_JS, 'utf8');
    // Keep MCP_VOICE_ENABLE_EXECUTE at its production-default value (false)
    // during the help-only spike — tests exercise only mcp_help. When the
    // flag flips back on, the harness will pick up the new value and the
    // gated-off assertion in the "plain handler function" test will need
    // updating. See docs/plans/2026-05-18-elevenlabs-mcp-help-only-spike.md.
    const patched = raw
        .replace(
            /sdkPromise = import\(SDK_URL\)\.catch\(\(err\) => \{[\s\S]*?\}\);/,
            `sdkPromise = Promise.resolve({
            Conversation: {
                startSession: async (opts) => {
                    window.__TEST_CONVERSATION_OPTS__ = opts;
                    return {
                        setMicMuted: () => {},
                        endSession: async () => {},
                        getId: () => 'conv_test',
                        sendMultimodalMessage: () => {},
                    };
                },
            },
        });`
        );
    window.eval(patched);

    return {
        window,
        document: window.document,
        cleanup: () => dom.window.close(),
    };
}

async function startCall(window) {
    const card = window.document.createElement('section');
    window.document.body.appendChild(card);
    await window.WGCallAgent.startCall(card);
    return window.__TEST_CONVERSATION_OPTS__;
}

describe('elevenlabs dynamic MCP client tools — registration', () => {
    let env;
    beforeEach(() => { env = null; });
    afterEach(() => { if (env) { try { env.cleanup(); } catch (_) { /* ignore */ } env = null; } });

    it('mints a session token via apiCall before startSession', async () => {
        const { stub: apiStub, calls: apiCalls } = makeApiCallStub();
        env = bootEnv({ apiStub });
        await startCall(env.window);
        const mintCall = apiCalls.find((c) => c.url === '/api/elevenlabs/mcp-session-token');
        expect(mintCall).toBeDefined();
        expect(mintCall.method).toBe('POST');
    });

    it('passes clientTools with mcp_help as a plain handler function (mcp_execute gated off)', async () => {
        // ElevenLabs SDK ClientToolsConfig is Record<string, (args) => result>.
        // Tool metadata (description, parameter schema, sound effect) lives in
        // the agent dashboard, not in this code. mcp_execute is gated behind
        // MCP_VOICE_ENABLE_EXECUTE; default-off for the spike.
        env = bootEnv();
        const opts = await startCall(env.window);
        expect(opts).toBeDefined();
        expect(opts.clientTools).toBeDefined();
        expect(typeof opts.clientTools.mcp_help).toBe('function');
        expect(opts.clientTools.mcp_execute).toBeUndefined();
    });

    it('startSession still proceeds with clientTools omitted when mint fails', async () => {
        // apiCallDirect returns the wrong shape → fetchMCPSessionToken throws
        // → caught → no clientTools registered. The caught failure is logged
        // via console.warn so users can diagnose a misconfigured MCP server;
        // opt out of the global no-noise guard for this case.
        allowConsoleNoise();
        const apiStub = vi.fn(async (url) => {
            if (url === '/api/elevenlabs/signed-url') return { signed_url: 'wss://stub/' };
            return { token: '', mcp_server_url: '' };
        });
        env = bootEnv({ apiStub });
        const opts = await startCall(env.window);
        expect(opts).toBeDefined();
        expect(opts.signedUrl).toBe('wss://stub/');
        expect(opts.clientTools).toBeUndefined();
    });
});

describe('elevenlabs dynamic MCP client tools — handler POST shape', () => {
    let env;
    beforeEach(() => { env = null; });
    afterEach(() => { if (env) { try { env.cleanup(); } catch (_) { /* ignore */ } env = null; } });

    it('mcp_help handler POSTs JSON-RPC tools/call with Bearer token to {mcp_url}/mcp', async () => {
        const { stub: fetchStub, calls: fetchCalls } = makeMCPFetchStub();
        env = bootEnv({ fetchStub });
        const opts = await startCall(env.window);
        const result = await opts.clientTools.mcp_help({ topic: 'workouts' });

        // Exactly one MCP POST.
        expect(fetchCalls.length).toBe(1);
        const { url, init } = fetchCalls[0];
        expect(url).toBe(`${TEST_MCP_URL}/mcp`);
        expect(init.method).toBe('POST');
        expect(init.headers['Authorization']).toBe(`Bearer ${TEST_TOKEN}`);
        expect(init.headers['Content-Type']).toBe('application/json');
        expect(init.headers['Accept']).toContain('application/json');

        const body = JSON.parse(init.body);
        expect(body.jsonrpc).toBe('2.0');
        expect(typeof body.id).toBe('number');
        expect(body.method).toBe('tools/call');
        expect(body.params.name).toBe('mcp_help');
        expect(body.params.arguments).toEqual({ topic: 'workouts' });

        // Default fixture returns content[0].text — handler returns that string.
        expect(result).toBe('{"ok":true}');
    });

    // mcp_execute is gated off (MCP_VOICE_ENABLE_EXECUTE=false) for the spike.
    // When the flag flips back on, restore an arguments-verbatim handler test
    // using the same shape as the mcp_help test above.

    it('increments JSON-RPC id across successive calls', async () => {
        const { stub: fetchStub, calls: fetchCalls } = makeMCPFetchStub();
        env = bootEnv({ fetchStub });
        const opts = await startCall(env.window);
        await opts.clientTools.mcp_help({});
        await opts.clientTools.mcp_help({});
        const ids = fetchCalls.map((c) => JSON.parse(c.init.body).id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('parses SSE-framed JSON-RPC responses from the MCP server', async () => {
        const sseBody = [
            'event: message',
            'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"sse-ok"}]}}',
            '',
        ].join('\n');
        const fetchStub = vi.fn(async () => ({
            ok: true,
            status: 200,
            async text() { return sseBody; },
        }));
        env = bootEnv({ fetchStub });
        const opts = await startCall(env.window);
        const result = await opts.clientTools.mcp_help({});
        expect(result).toBe('sse-ok');
    });
});

describe('elevenlabs dynamic MCP client tools — 401 refresh-and-retry', () => {
    let env;
    beforeEach(() => { env = null; });
    afterEach(() => { if (env) { try { env.cleanup(); } catch (_) { /* ignore */ } env = null; } });

    it('refreshes the token and retries once on 401, then succeeds', async () => {
        // apiCallDirect: first mint returns initial token, second mint returns refreshed.
        let mintCount = 0;
        const apiStub = vi.fn(async (url) => {
            if (url === '/api/elevenlabs/signed-url') return { signed_url: 'wss://stub/' };
            if (url === '/api/elevenlabs/mcp-session-token') {
                mintCount += 1;
                return {
                    token: mintCount === 1 ? 'tok_initial' : 'tok_refreshed',
                    mcp_server_url: TEST_MCP_URL,
                    expires_at: Math.floor(Date.now() / 1000) + 900,
                };
            }
            throw new Error(`Unexpected: ${url}`);
        });

        // fetch: first POST → 401, second POST → 200.
        let postCount = 0;
        const fetchStub = vi.fn(async (url, init) => {
            postCount += 1;
            if (postCount === 1) {
                return {
                    ok: false,
                    status: 401,
                    async text() { return 'unauthorized'; },
                };
            }
            // Echo the Authorization header used on the retry into the body.
            const auth = init.headers['Authorization'];
            return {
                ok: true,
                status: 200,
                async text() {
                    return JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        result: { content: [{ type: 'text', text: auth }] },
                    });
                },
            };
        });

        env = bootEnv({ apiStub, fetchStub });
        const opts = await startCall(env.window);
        const result = await opts.clientTools.mcp_help({});
        // First mint at startCall, second mint after the 401.
        expect(mintCount).toBe(2);
        expect(postCount).toBe(2);
        // Retry MUST have used the refreshed token, not the initial one.
        expect(result).toBe('Bearer tok_refreshed');
    });

    it('rejects when refresh succeeds but the retry also 401s', async () => {
        const apiStub = vi.fn(async (url) => {
            if (url === '/api/elevenlabs/signed-url') return { signed_url: 'wss://stub/' };
            return { token: 'tok', mcp_server_url: TEST_MCP_URL, expires_at: 1 };
        });
        const fetchStub = vi.fn(async () => ({
            ok: false,
            status: 401,
            async text() { return 'still unauthorized'; },
        }));
        env = bootEnv({ apiStub, fetchStub });
        const opts = await startCall(env.window);
        await expect(opts.clientTools.mcp_help({})).rejects.toThrow();
        // Initial mint + one refresh; one initial POST + one retry POST.
        expect(fetchStub).toHaveBeenCalledTimes(2);
    });
});

describe('elevenlabs dynamic MCP client tools — error propagation', () => {
    let env;
    beforeEach(() => { env = null; });
    afterEach(() => { if (env) { try { env.cleanup(); } catch (_) { /* ignore */ } env = null; } });

    it('rejects when the MCP server returns a JSON-RPC error envelope', async () => {
        const { stub: fetchStub } = makeMCPFetchStub({
            error: { code: -32000, message: 'execution blocked' },
        });
        env = bootEnv({ fetchStub });
        const opts = await startCall(env.window);
        await expect(opts.clientTools.mcp_help({})).rejects.toThrow(/execution blocked/);
    });

    it('rejects on non-2xx HTTP responses that are not 401', async () => {
        const fetchStub = vi.fn(async () => ({
            ok: false,
            status: 500,
            async text() { return 'server boom'; },
        }));
        env = bootEnv({ fetchStub });
        const opts = await startCall(env.window);
        await expect(opts.clientTools.mcp_help({})).rejects.toThrow(/500/);
    });
});
