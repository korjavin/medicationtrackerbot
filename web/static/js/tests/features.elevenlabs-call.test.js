/**
 * features.elevenlabs-call.test.js
 *
 * ElevenLabs voice-call controller — Today screen "Call agent" card,
 * mute toggle, and photo send. Subscribes to and broadcasts the
 * `wg-call-state` window event consumed by features/call-indicator.js.
 *
 * Tests cover the new mute + photo APIs added to window.WGCallAgent
 * (toggleMute, setMute, sendPhoto) and the extended wg-call-state /
 * getState() shape ({ state, message, muted, uploading }).
 *
 * Approach: load the IIFE-style script via window.eval (mirrors the
 * pattern used by features.call-indicator.test.js). To exercise
 * setMute / sendPhoto without a real SDK, we install a fake
 * activeConversation by stubbing the SDK loader and the global
 * fetchSignedURL path, then awaiting startCall().
 */
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

function createEnv() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://example.test/',
        runScripts: 'outside-only',
    });
    const { window } = dom;

    // The script under test calls fetch() unless window.offlineAwareApiCall
    // or window.apiCallDirect is provided. Provide a stubbable apiCallDirect.
    window.apiCallDirect = vi.fn(async (url) => {
        if (url === '/api/elevenlabs/mcp-session-token') {
            return { token: 'mcp_stub', mcp_server_url: 'https://mcp.stub.example', expires_at: Math.floor(Date.now() / 1000) + 900 };
        }
        return { signed_url: 'wss://stub.example/' };
    });

    window.eval(fs.readFileSync(ELEVENLABS_JS, 'utf8'));

    return {
        window,
        document: window.document,
        cleanup: () => dom.window.close(),
    };
}

// Build a fake Conversation object that the SDK loader will return.
// startCall() awaits Conversation.startSession({...}) so we need to
// call onConnect from inside that call to flip state to 'in_call'.
//
// uploadFile is no longer called by the controller — sendPhoto now POSTs
// the file to /api/elevenlabs/upload-file via the global fetch (the server
// proxies it to ElevenLabs with xi-api-key). The fake still keeps a
// uploadFile spy for legacy assertions but it should never be invoked.
function makeFakeConversation(overrides = {}) {
    const conv = {
        setMicMuted: vi.fn(),
        uploadFile: vi.fn(async () => ({ fileId: 'file_abc' })),
        getId: vi.fn(() => 'conv_test'),
        sendMultimodalMessage: vi.fn(),
        endSession: vi.fn(async () => {}),
        ...overrides,
    };
    return conv;
}

// Default fetch stub for the upload-file proxy. Tests can override
// window.fetch after createConversationEnv() to simulate failures.
function makeUploadFetchStub({ fileId = 'file_abc', status = 200 } = {}) {
    return vi.fn(async (url) => {
        if (typeof url === 'string' && url.startsWith('/api/elevenlabs/upload-file')) {
            return {
                ok: status >= 200 && status < 300,
                status,
                async json() { return { file_id: fileId }; },
                async text() { return ''; },
            };
        }
        throw new Error(`Unexpected fetch: ${url}`);
    });
}

// Inject a fake SDK module so loadSDK()'s dynamic import resolves to it.
// elevenlabs-call.js calls `import('https://esm.sh/@elevenlabs/client')`
// which jsdom's `runScripts: 'outside-only'` cannot satisfy. We bypass
// that by replacing window.WGCallAgent.startCall's path: call onConnect
// ourselves and manually drive the controller through a small adapter.
//
// Concretely: we don't use startCall(). Instead we directly populate the
// internal active state by invoking a small "test bridge" we inject into
// the script. Since the script doesn't expose hooks for that, we instead
// drive setState by listening to wg-call-state and using the public API
// after monkey-patching the SDK loader through the `import` call.
//
// Simpler strategy: monkey-patch window.WGCallAgent.startCall to splice
// in our fake conversation before/instead of the real SDK call. We do so
// by re-executing a tiny script that overrides startCall via a wrapper.
//
// Even simpler: we directly call the controller's public API by
// providing a fake `Conversation.startSession` resolution. We do that by
// installing a global window.__TEST_CONVERSATION__ and overriding the
// import via a Proxy on the dynamic import. That's brittle.
//
// Final strategy used here: drive the state machine through public
// surface only. The script exposes startCall(card) but it requires a
// real SDK. Instead, we add a small test helper: we re-eval a wrapper
// that forces activeConversation by calling window.__bootForTest__().

// Test helper that re-evals the source with a hook appended that
// installs a bootForTest function exposing internal setters.
function bootEnv() {
    const env = createEnv();
    // Drive in_call state by emitting events directly is not enough —
    // we need an actual activeConversation reference inside the IIFE.
    // The IIFE never exposes that reference, so we fake it by replacing
    // window.WGCallAgent with a wrapper after script eval that records
    // calls to the underlying methods.
    return env;
}

// Helper: drive the controller into in_call with a fake conversation.
// We monkey-patch loadSDK by replacing fetchSignedURL + the dynamic
// import path. Easiest: we call WGCallAgent.startCall but stub
// `fetch` + `import` so the SDK provides a Conversation whose
// startSession resolves to our fake.
//
// jsdom can't intercept dynamic imports, so the cleanest path is to
// rewrite the script source on load: replace the `import(SDK_URL)` line
// with a synchronous resolution to a fake module. We do that here.
function loadScriptWithFakeSDK(window, fakeSDKExpression) {
    const raw = fs.readFileSync(ELEVENLABS_JS, 'utf8');
    const patched = raw.replace(
        "sdkPromise = import(SDK_URL).catch((err) => {",
        `sdkPromise = Promise.resolve(${fakeSDKExpression}).catch((err) => {`
    );
    window.eval(patched);
}

function createConversationEnv({ conv } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://example.test/',
        runScripts: 'outside-only',
    });
    const { window } = dom;
    const conversation = conv || makeFakeConversation();

    window.__TEST_CONVERSATION__ = conversation;
    // Default to a successful upload-file proxy response. Tests that need
    // failure modes can reassign window.fetch after createConversationEnv().
    window.fetch = makeUploadFetchStub();
    window.userInitData = 'init=stub';

    // Load the real makeAuthHeaders helper into this DOM so the
    // controller's upload-file fetch reaches the same auth-header
    // construction path used in production. core/api.js also assigns
    // window.apiCallDirect; we override it below with the signed-URL
    // stub so the signed-URL fetch in startCall() does not hit the
    // upload-only fetch stub.
    window.eval(fs.readFileSync(CORE_API_JS, 'utf8'));
    window.apiCallDirect = vi.fn(async (url) => {
        if (url === '/api/elevenlabs/mcp-session-token') {
            return { token: 'mcp_stub', mcp_server_url: 'https://mcp.stub.example', expires_at: Math.floor(Date.now() / 1000) + 900 };
        }
        return { signed_url: 'wss://stub.example/' };
    });

    // Replace import(SDK_URL) with a resolved promise to a fake SDK whose
    // Conversation.startSession returns our injected conversation and
    // captures the lifecycle callbacks for the test to drive.
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
        events: collectEvents(window),
    };
}

function collectEvents(window) {
    const log = [];
    window.addEventListener('wg-call-state', (ev) => {
        log.push(ev.detail);
    });
    return log;
}

async function startCall(window) {
    const card = window.document.createElement('section');
    window.document.body.appendChild(card);
    const startPromise = window.WGCallAgent.startCall(card);
    await startPromise;
    const opts = window.__TEST_CONVERSATION_OPTS__;
    if (opts && typeof opts.onConnect === 'function') opts.onConnect();
    return { card, opts };
}

describe('features/elevenlabs-call.js — exposed API surface', () => {
    it('exposes window.WGCallAgent with mute + photo methods', () => {
        const { window, cleanup } = createEnv();
        try {
            expect(window.WGCallAgent).toBeDefined();
            expect(typeof window.WGCallAgent.toggleMute).toBe('function');
            expect(typeof window.WGCallAgent.setMute).toBe('function');
            expect(typeof window.WGCallAgent.sendPhoto).toBe('function');
            expect(typeof window.WGCallAgent.getState).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('getState() returns the muted/uploading fields (initially false)', () => {
        const { window, cleanup } = createEnv();
        try {
            const state = window.WGCallAgent.getState();
            expect(state).toMatchObject({
                state: 'idle',
                message: '',
                muted: false,
                uploading: false,
            });
        } finally {
            cleanup();
        }
    });
});

describe('features/elevenlabs-call.js — setMute / toggleMute', () => {
    it('setMute(true) calls conversation.setMicMuted(true) and broadcasts muted: true', async () => {
        const { window, conversation, events, cleanup } = createConversationEnv();
        try {
            await startCall(window);
            const beforeLen = events.length;
            window.WGCallAgent.setMute(true);
            expect(conversation.setMicMuted).toHaveBeenCalledWith(true);
            const last = events[events.length - 1];
            expect(last.muted).toBe(true);
            expect(last.state).toBe('in_call');
            expect(events.length).toBeGreaterThan(beforeLen);
        } finally {
            cleanup();
        }
    });

    it('toggleMute flips state across calls', async () => {
        const { window, conversation, cleanup } = createConversationEnv();
        try {
            await startCall(window);
            expect(window.WGCallAgent.getState().muted).toBe(false);
            window.WGCallAgent.toggleMute();
            expect(window.WGCallAgent.getState().muted).toBe(true);
            expect(conversation.setMicMuted).toHaveBeenLastCalledWith(true);
            window.WGCallAgent.toggleMute();
            expect(window.WGCallAgent.getState().muted).toBe(false);
            expect(conversation.setMicMuted).toHaveBeenLastCalledWith(false);
        } finally {
            cleanup();
        }
    });

    it('setMute is a no-op when there is no active conversation', () => {
        const { window, cleanup } = createEnv();
        try {
            // No call has started — setMute should not throw.
            expect(() => window.WGCallAgent.setMute(true)).not.toThrow();
            expect(window.WGCallAgent.getState().muted).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('rolls back muted state when setMicMuted throws (mic state cannot be trusted)', async () => {
        const conv = makeFakeConversation({
            setMicMuted: vi.fn(() => { throw new Error('webrtc fail'); }),
        });
        const { window, events, cleanup } = createConversationEnv({ conv });
        try {
            await startCall(window);
            expect(() => window.WGCallAgent.setMute(true)).not.toThrow();
            // SDK failed — UI must not lie that the mic is muted.
            const state = window.WGCallAgent.getState();
            expect(state.muted).toBe(false);
            // A "Mute failed" status should have been broadcast.
            const last = events[events.length - 1];
            expect(last.message).toBe('Mute failed');
        } finally {
            cleanup();
        }
    });

    it('rejects setMute when SDK is missing setMicMuted (mic state cannot be trusted)', async () => {
        const conv = makeFakeConversation();
        // Drop setMicMuted entirely to simulate older SDK / partial mock.
        delete conv.setMicMuted;
        const { window, events, cleanup } = createConversationEnv({ conv });
        try {
            await startCall(window);
            expect(() => window.WGCallAgent.setMute(true)).not.toThrow();
            // Must not lie that the mic is muted.
            const state = window.WGCallAgent.getState();
            expect(state.muted).toBe(false);
            const last = events[events.length - 1];
            expect(last.message).toBe('Mute unsupported');
        } finally {
            cleanup();
        }
    });

    it('successful setMute clears a stale "Mute failed" message', async () => {
        let shouldThrow = true;
        const conv = makeFakeConversation({
            setMicMuted: vi.fn(() => {
                if (shouldThrow) {
                    shouldThrow = false;
                    throw new Error('first attempt fails');
                }
            }),
        });
        const { window, events, cleanup } = createConversationEnv({ conv });
        try {
            await startCall(window);
            // First attempt fails → message becomes 'Mute failed'.
            window.WGCallAgent.setMute(true);
            expect(events[events.length - 1].message).toBe('Mute failed');
            // Second attempt succeeds → must not re-broadcast the stale failure.
            window.WGCallAgent.setMute(true);
            const last = events[events.length - 1];
            expect(last.muted).toBe(true);
            expect(last.message).toBe('');
        } finally {
            cleanup();
        }
    });

    it('idle transition resets muted to false', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            const { opts } = await startCall(window);
            window.WGCallAgent.setMute(true);
            expect(window.WGCallAgent.getState().muted).toBe(true);
            // Drive a disconnect — the controller resets activeMuted on idle.
            opts.onDisconnect();
            const state = window.WGCallAgent.getState();
            expect(state.state).toBe('idle');
            expect(state.muted).toBe(false);
        } finally {
            cleanup();
        }
    });
});

describe('features/elevenlabs-call.js — sendPhoto', () => {
    function makeImageBlob(window) {
        // Use the jsdom Blob with an image MIME type. Real bytes are
        // irrelevant — sendPhoto only checks instanceof Blob + type.
        return new window.Blob(['fake-bytes'], { type: 'image/jpeg' });
    }

    it('rejects when called outside in_call state', async () => {
        const { window, cleanup } = createEnv();
        try {
            const blob = makeImageBlob(window);
            await expect(window.WGCallAgent.sendPhoto(blob)).rejects.toThrow();
        } finally {
            cleanup();
        }
    });

    it('rejects non-image blobs and surfaces a status message', async () => {
        const { window, events, cleanup } = createConversationEnv();
        try {
            await startCall(window);
            const txt = new window.Blob(['hello'], { type: 'text/plain' });
            await expect(window.WGCallAgent.sendPhoto(txt)).rejects.toThrow();
            // The UI must tell the user why the file was rejected.
            const last = events[events.length - 1];
            expect(last.state).toBe('in_call');
            expect(last.message).toBe('Image required');
        } finally {
            cleanup();
        }
    });

    it('happy path: posts to /api/elevenlabs/upload-file then sends multimodal message and toggles uploading', async () => {
        const { window, conversation, events, cleanup } = createConversationEnv();
        try {
            await startCall(window);
            const blob = makeImageBlob(window);
            const before = events.length;
            await window.WGCallAgent.sendPhoto(blob);
            // The proxy fetch — not the SDK's uploadFile — handled the upload.
            expect(conversation.uploadFile).not.toHaveBeenCalled();
            expect(window.fetch).toHaveBeenCalledTimes(1);
            const [url, init] = window.fetch.mock.calls[0];
            expect(url).toBe('/api/elevenlabs/upload-file?conversation_id=conv_test');
            expect(init.method).toBe('POST');
            expect(init.body).toBeInstanceOf(window.FormData);
            // FormData.append(blob, filename) wraps the Blob as a File; the
            // bytes/type should round-trip through the wrapper.
            const sentFile = init.body.get('file');
            expect(sentFile instanceof window.Blob || sentFile instanceof window.File).toBe(true);
            expect(sentFile.type).toBe('image/jpeg');
            expect(sentFile.size).toBe(blob.size);
            expect(init.headers['X-Telegram-Init-Data']).toBe('init=stub');
            expect(conversation.sendMultimodalMessage).toHaveBeenCalledWith({ fileId: 'file_abc' });
            // Expect at least two new events: uploading: true, then false.
            const after = events.slice(before);
            const uploadingTrue = after.find((d) => d.uploading === true);
            const uploadingFalseAtEnd = after[after.length - 1];
            expect(uploadingTrue).toBeDefined();
            expect(uploadingFalseAtEnd.uploading).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('preserves a live mode-change status across the upload (does not blank "Listening…")', async () => {
        const { window, events, cleanup } = createConversationEnv();
        let resolveUpload;
        window.fetch = vi.fn(() => new Promise((resolve) => {
            resolveUpload = () => resolve({
                ok: true,
                status: 200,
                async json() { return { file_id: 'f' }; },
                async text() { return ''; },
            });
        }));
        try {
            const { opts } = await startCall(window);
            // Drive a mode-change so activeMessage = 'Listening…' before upload starts.
            opts.onModeChange({ mode: 'listening' });
            expect(events[events.length - 1].message).toBe('Listening…');
            const blob = new window.Blob(['x'], { type: 'image/jpeg' });
            const sendPromise = window.WGCallAgent.sendPhoto(blob);
            // Upload-start broadcast must NOT have wiped the listening status.
            expect(events[events.length - 1].message).toBe('Listening…');
            expect(events[events.length - 1].uploading).toBe(true);
            resolveUpload();
            await sendPromise;
            // Final broadcast: still preserves the live message.
            const last = events[events.length - 1];
            expect(last.uploading).toBe(false);
            expect(last.message).toBe('Listening…');
        } finally {
            cleanup();
        }
    });

    it('hang-up during in-flight upload does not clobber idle state back to in_call', async () => {
        const { window, conversation, events, cleanup } = createConversationEnv();
        let resolveUpload;
        window.fetch = vi.fn(() => new Promise((resolve) => {
            resolveUpload = () => resolve({
                ok: true,
                status: 200,
                async json() { return { file_id: 'late_file' }; },
                async text() { return ''; },
            });
        }));
        try {
            await startCall(window);
            const blob = new window.Blob(['x'], { type: 'image/jpeg' });
            const sendPromise = window.WGCallAgent.sendPhoto(blob);
            // User hangs up while the upload fetch is still pending.
            await window.WGCallAgent.endCall();
            expect(window.WGCallAgent.getState().state).toBe('idle');
            // Upload now resolves — must not flip UI back to in_call.
            resolveUpload();
            await sendPromise;
            const finalState = window.WGCallAgent.getState();
            expect(finalState.state).toBe('idle');
            // sendMultimodalMessage must NOT fire after hang-up.
            expect(conversation.sendMultimodalMessage).not.toHaveBeenCalled();
            // Last broadcast must be the idle one — not 'in_call'.
            const last = events[events.length - 1];
            expect(last.state).toBe('idle');
        } finally {
            cleanup();
        }
    });

    it('upload failure after hang-up leaves UI idle (no in_call clobber)', async () => {
        const { window, events, cleanup } = createConversationEnv();
        let rejectUpload;
        window.fetch = vi.fn(() => new Promise((_, reject) => { rejectUpload = reject; }));
        try {
            await startCall(window);
            const blob = new window.Blob(['x'], { type: 'image/jpeg' });
            const sendPromise = window.WGCallAgent.sendPhoto(blob);
            await window.WGCallAgent.endCall();
            rejectUpload(new Error('network'));
            await expect(sendPromise).rejects.toThrow();
            expect(window.WGCallAgent.getState().state).toBe('idle');
            const last = events[events.length - 1];
            expect(last.state).toBe('idle');
        } finally {
            cleanup();
        }
    });

    it('successful retry after a prior failure clears the failure status', async () => {
        const { window, events, cleanup } = createConversationEnv();
        let firstAttempt = true;
        window.fetch = vi.fn(async () => {
            if (firstAttempt) {
                firstAttempt = false;
                return { ok: false, status: 500, async json() { return {}; }, async text() { return 'boom'; } };
            }
            return { ok: true, status: 200, async json() { return { file_id: 'file_xyz' }; }, async text() { return ''; } };
        });
        try {
            await startCall(window);
            const blob = new window.Blob(['x'], { type: 'image/jpeg' });
            await expect(window.WGCallAgent.sendPhoto(blob)).rejects.toThrow();
            // First attempt set 'Photo upload failed'.
            await window.WGCallAgent.sendPhoto(blob);
            // After a successful retry, the failure message must be cleared.
            const last = events[events.length - 1];
            expect(last.state).toBe('in_call');
            expect(last.message).toBe('');
            expect(last.uploading).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('upload failure: keeps call alive, sets status, clears uploading', async () => {
        const { window, conversation, events, cleanup } = createConversationEnv();
        window.fetch = vi.fn(async () => { throw new Error('network'); });
        try {
            await startCall(window);
            const blob = makeImageBlob(window);
            await expect(window.WGCallAgent.sendPhoto(blob)).rejects.toThrow();
            const last = events[events.length - 1];
            expect(last.state).toBe('in_call');
            expect(last.message).toBe('Photo upload failed');
            expect(last.uploading).toBe(false);
            // sendMultimodalMessage must NOT have been called.
            expect(conversation.sendMultimodalMessage).not.toHaveBeenCalled();
            // Active state should still be in_call (call is alive).
            expect(window.WGCallAgent.getState().state).toBe('in_call');
        } finally {
            cleanup();
        }
    });

    it('non-2xx upload-file proxy response surfaces "Photo upload failed"', async () => {
        const { window, conversation, events, cleanup } = createConversationEnv();
        window.fetch = vi.fn(async () => ({
            ok: false,
            status: 401,
            async json() { return {}; },
            async text() { return 'sign_in_required'; },
        }));
        try {
            await startCall(window);
            const blob = new window.Blob(['x'], { type: 'image/jpeg' });
            await expect(window.WGCallAgent.sendPhoto(blob)).rejects.toThrow();
            const last = events[events.length - 1];
            expect(last.state).toBe('in_call');
            expect(last.message).toBe('Photo upload failed');
            expect(conversation.sendMultimodalMessage).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });
});

describe('features/elevenlabs-call.js — wg-call-state event detail', () => {
    it('emits muted and uploading fields on every state broadcast', async () => {
        const { window, events, cleanup } = createConversationEnv();
        try {
            await startCall(window);
            // After startCall + onConnect we should have at least one event
            // with state: 'in_call' and the new fields present.
            const inCallEvent = events.find((d) => d.state === 'in_call');
            expect(inCallEvent).toBeDefined();
            expect(inCallEvent).toHaveProperty('muted');
            expect(inCallEvent).toHaveProperty('uploading');
            expect(inCallEvent.muted).toBe(false);
            expect(inCallEvent.uploading).toBe(false);
        } finally {
            cleanup();
        }
    });
});

describe('features/elevenlabs-call.js — Today card markup', () => {
    it('mountCard() renders mute, photo, and hidden file input', () => {
        const { window, document, cleanup } = createEnv();
        try {
            const container = document.createElement('div');
            document.body.appendChild(container);
            window.WGCallAgent.mountCard(container);
            expect(container.querySelector('.wg-call-card__mute')).not.toBeNull();
            expect(container.querySelector('.wg-call-card__photo')).not.toBeNull();
            const input = container.querySelector('.wg-call-card__photo-input');
            expect(input).not.toBeNull();
            expect(input.getAttribute('type')).toBe('file');
            expect(input.getAttribute('accept')).toBe('image/*');
        } finally {
            cleanup();
        }
    });

    it('does not assign inline styles on the call card or its children after a state cycle', async () => {
        const { window, document, conversation, cleanup } = createConversationEnv();
        try {
            const container = document.createElement('div');
            document.body.appendChild(container);
            // Mount the card first, then drive startCall against that very
            // card so applyState exercises the mounted DOM (not a bare
            // throwaway <section>).
            const card = window.WGCallAgent.mountCard(container);
            const startPromise = window.WGCallAgent.startCall(card);
            await startPromise;
            const opts = window.__TEST_CONVERSATION_OPTS__;
            if (opts && typeof opts.onConnect === 'function') opts.onConnect();
            window.WGCallAgent.setMute(true);
            window.WGCallAgent.setMute(false);
            await window.WGCallAgent.endCall();
            expect(card).not.toBeNull();
            expect(card.getAttribute('style')).toBeNull();
            for (const child of card.querySelectorAll('*')) {
                expect(child.getAttribute('style')).toBeNull();
            }
            // Conversation methods were exercised by setMute.
            expect(conversation.setMicMuted).toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });
});
