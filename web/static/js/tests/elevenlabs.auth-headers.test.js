// Auth header consolidation — Task 3 of the
// 2026-05-13-auth-header-consolidation plan.
//
// Pins that the /api/elevenlabs/upload-file direct-fetch call inside
// features/elevenlabs-call.js routes its X-Telegram-Init-Data through
// window.makeAuthHeaders() rather than building the header inline. The
// SDK-driven happy-path test in features.elevenlabs-call.test.js already
// asserts the value present on the request; this file adds the helper-
// indirection invariant + the "no token → no header key" case so a
// regression to inline construction is caught regardless of the
// surrounding setMute / sendPhoto behaviour.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ELEVENLABS_JS = path.join(REPO_ROOT, 'web/static/js/features/elevenlabs-call.js');
const CORE_API_JS = path.join(REPO_ROOT, 'web/static/js/core/api.js');

function makeFakeConversation(overrides = {}) {
    return {
        setMicMuted: vi.fn(),
        uploadFile: vi.fn(async () => ({ fileId: 'file_abc' })),
        getId: vi.fn(() => 'conv_test'),
        sendMultimodalMessage: vi.fn(),
        endSession: vi.fn(async () => {}),
        ...overrides,
    };
}

function makeUploadFetchStub() {
    return vi.fn(async (url) => {
        if (typeof url === 'string' && url.startsWith('/api/elevenlabs/upload-file')) {
            return {
                ok: true,
                status: 200,
                async json() { return { file_id: 'file_abc' }; },
                async text() { return ''; },
            };
        }
        throw new Error(`Unexpected fetch: ${url}`);
    });
}

function bootConversationEnv({ initData = 'init=stub' } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://example.test/',
        runScripts: 'outside-only',
    });
    const { window } = dom;
    const conversation = makeFakeConversation();

    window.__TEST_CONVERSATION__ = conversation;
    window.fetch = makeUploadFetchStub();
    if (initData !== null) {
        window.userInitData = initData;
    }

    // Load the real makeAuthHeaders helper into this DOM so the
    // controller's call site reaches the same function used in
    // production. core/api.js also assigns window.apiCallDirect; we
    // overwrite that with a stub afterwards so the signed-URL fetch in
    // startCall() does not try to reach an upload-only fetch stub.
    window.eval(fs.readFileSync(CORE_API_JS, 'utf8'));
    window.apiCallDirect = vi.fn(async () => ({ signed_url: 'wss://stub.example/' }));

    // Replace the dynamic SDK import with a resolved fake (same trick the
    // surrounding features.elevenlabs-call test uses) so startCall()
    // resolves without an outbound network.
    const raw = fs.readFileSync(ELEVENLABS_JS, 'utf8');
    const patched = raw.replace(
        /sdkPromise = import\(SDK_URL\)\.catch\(\(err\) => \{[\s\S]*?\}\);/,
        `sdkPromise = Promise.resolve({
            Conversation: {
                startSession: async (opts) => {
                    window.__TEST_CONVERSATION_OPTS__ = opts;
                    return window.__TEST_CONVERSATION__;
                },
            },
        });`
    );
    window.eval(patched);

    return {
        window,
        document: window.document,
        conversation,
        cleanup: () => dom.window.close(),
    };
}

async function startCall(window) {
    const card = window.document.createElement('section');
    window.document.body.appendChild(card);
    await window.WGCallAgent.startCall(card);
    const opts = window.__TEST_CONVERSATION_OPTS__;
    if (opts && typeof opts.onConnect === 'function') opts.onConnect();
    return { card, opts };
}

function makeImageBlob(window) {
    return new window.Blob(['fake-bytes'], { type: 'image/jpeg' });
}

describe('elevenlabs upload-file fetch routes through window.makeAuthHeaders', () => {
    let env;

    beforeEach(() => {
        env = null;
    });

    afterEach(() => {
        if (env) {
            try { env.cleanup(); } catch (_) { /* ignore */ }
            env = null;
        }
    });

    it('sendPhoto calls window.makeAuthHeaders() and uses its return value as the fetch headers', async () => {
        env = bootConversationEnv({ initData: 'init=stub' });
        const { window } = env;
        const helperSpy = vi.spyOn(window, 'makeAuthHeaders');

        await startCall(window);
        await window.WGCallAgent.sendPhoto(makeImageBlob(window));

        expect(helperSpy).toHaveBeenCalled();
        expect(window.fetch).toHaveBeenCalledTimes(1);
        const [, init] = window.fetch.mock.calls[0];
        expect(init.headers).toEqual({ 'X-Telegram-Init-Data': 'init=stub' });
        // FormData bodies carry their own boundary-bearing Content-Type;
        // the helper must not have been asked to add one.
        expect(init.headers['Content-Type']).toBeUndefined();
    });

    it('omits the X-Telegram-Init-Data header when window.userInitData is absent', async () => {
        env = bootConversationEnv({ initData: null });
        const { window } = env;

        await startCall(window);
        await window.WGCallAgent.sendPhoto(makeImageBlob(window));

        expect(window.fetch).toHaveBeenCalledTimes(1);
        const [, init] = window.fetch.mock.calls[0];
        // No token → headers object exists but must not carry the key
        // (the helper returns {} in this case rather than an inline
        // `'X-Telegram-Init-Data': undefined`).
        expect('X-Telegram-Init-Data' in init.headers).toBe(false);
    });
});
