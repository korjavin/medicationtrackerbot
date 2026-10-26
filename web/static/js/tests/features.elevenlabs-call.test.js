/**
 * features.elevenlabs-call.test.js
 *
 * ElevenLabs voice-call controller — Today screen "Call agent" card,
 * mute toggle, and photo send. Subscribes to and broadcasts the
 * `wg-call-state` window event (the Today call bar is the one call surface).
 *
 * Tests cover the new mute + photo APIs added to window.WGCallAgent
 * (toggleMute, setMute, sendPhoto) and the extended wg-call-state /
 * getState() shape ({ state, message, muted, uploading }).
 *
 * Approach: load the IIFE-style script via window.eval (mirrors the
 * pattern used across the feature suites). To exercise
 * setMute / sendPhoto without a real SDK, we install a fake
 * activeConversation by stubbing the SDK loader and the global
 * fetchSignedURL path, then awaiting startCall().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { allowConsoleNoise } from './helpers/setup.js';
import { createVoiceLLMResponder } from '../../../cloud/js/voice-llm-responder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ELEVENLABS_JS = path.join(REPO_ROOT, 'web/static/js/features/elevenlabs-call.js');

function createEnv() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://example.test/',
        runScripts: 'outside-only',
    });
    const { window } = dom;

    // Default BYO seam: vault key present, signed URL resolves. Tests
    // override per-case (trial, consent, failures).
    window.CloudElevenLabs = {
        hasKey: vi.fn(async () => true),
        fetchSignedURL: vi.fn(async () => 'wss://stub.example/'),
    };

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
// sendUserMessage carries the in-call photo marker (sendPhoto, bd med-ku8r).
function makeFakeConversation(overrides = {}) {
    const conv = {
        setMicMuted: vi.fn(),
        getId: vi.fn(() => 'conv_test'),
        sendUserMessage: vi.fn(),
        endSession: vi.fn(async () => {}),
        ...overrides,
    };
    return conv;
}

// Default fetch stub: the controller only fetches the same-origin trial
// route (/api/trial/elevenlabs/signed-url), which trial tests stub
// per-case — any other URL here is a leak and throws.
function makeThrowingFetchStub() {
    return vi.fn(async (url) => {
        throw new Error(`Unexpected fetch: ${url}`);
    });
}

// Inject a fake SDK module so loadSDK()'s dynamic import resolves to it.
// elevenlabs-call.js calls `import('/static/vendor/elevenlabs-client.min.js')`
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

function createConversationEnv({ conv, setup } = {}) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        url: 'https://example.test/',
        runScripts: 'outside-only',
    });
    const { window } = dom;
    const conversation = conv || makeFakeConversation();

    window.__TEST_CONVERSATION__ = conversation;
    // A fetch that throws on any URL: a fetch here is a leak. Trial tests
    // reassign window.fetch per-case.
    window.fetch = makeThrowingFetchStub();

    // Default BYO seam: vault key present, signed URL resolves.
    // Tests override per-case (trial, consent, failures).
    window.CloudElevenLabs = {
        hasKey: vi.fn(async () => true),
        fetchSignedURL: vi.fn(async () => 'wss://stub.example/'),
    };

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
                    window.__TEST_START_SESSION_CALLS__ = (window.__TEST_START_SESSION_CALLS__ || 0) + 1;
                    return window.__TEST_CONVERSATION__;
                },
            },
        });`
    );
    // Globals the script reads at load time (AppStore, page markup).
    if (setup) setup(window);
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

    // bd med-yor.8: without explicit paths the SDK builds each AudioWorklet
    // from a blob: URL (data: fallback), and since no engine ships worklet-src
    // those loads hit script-src — which is what forced the cloud app document
    // to serve `script-src 'self' blob: data:` on the page holding the DEK.
    // Self-hosted paths are what let that shrink back to 'self'.
    it('hands the SDK same-origin worklet paths so script-src can stay self-only', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            const { opts } = await startCall(window);
            expect(opts.workletPaths).toEqual({
                rawAudioProcessor: '/static/vendor/worklets/raw-audio-processor.js',
                audioConcatProcessor: '/static/vendor/worklets/audio-concat-processor.js',
            });
            expect(opts.libsampleratePath).toBe('/static/vendor/worklets/libsamplerate.worklet.js');
        } finally {
            cleanup();
        }
    });

    // bd med-yor.17. The SDK resamples on any engine that cannot pin the
    // AudioContext sample rate (Firefox, Safari) and fetches libsamplerate from
    // jsdelivr to do it — blocked by script-src 'self' on both origins, and
    // fatal, since the output controller rethrows. `libsampleratePath` alone is
    // not enough: through 1.17.0 the SDK forwards it to the input controller
    // only, so the output half still reaches for the CDN.
    it('redirects the SDK\'s hardcoded libsamplerate CDN URL to the self-hosted copy', async () => {
        const CDN = 'https://cdn.jsdelivr.net/npm/@alexanderolsen/libsamplerate-js@2.1.2/dist/libsamplerate.worklet.js';
        const { window, cleanup } = createConversationEnv();
        try {
            const addModule = vi.fn(async () => {});
            window.AudioWorklet = function AudioWorklet() {};
            window.AudioWorklet.prototype.addModule = addModule;

            await startCall(window);

            const worklet = new window.AudioWorklet();
            await worklet.addModule(CDN);
            expect(addModule).toHaveBeenCalledWith('/static/vendor/worklets/libsamplerate.worklet.js', undefined);

            // Everything else — including the same-origin worklet paths — is
            // passed straight through.
            await worklet.addModule('/static/vendor/worklets/raw-audio-processor.js');
            expect(addModule).toHaveBeenLastCalledWith('/static/vendor/worklets/raw-audio-processor.js', undefined);
        } finally {
            cleanup();
        }
    });
});

// bd med-ku8r: ElevenLabs refuses uploads for custom-LLM agents, so a photo
// never goes to ElevenLabs. It is queued in the tab's voice LLM responder
// (window.CloudVoiceLLM.setPendingImage), the agent hears the marker via
// sendUserMessage, and the next AI turn carries the image.
describe('features/elevenlabs-call.js — sendPhoto', () => {
    beforeEach(() => allowConsoleNoise());
    afterEach(() => vi.unstubAllGlobals());

    const makeImageBlob = (window) => new window.Blob(['fake-bytes'], { type: 'image/jpeg' });

    // A stub responder: each queued photo waits until the test settles it.
    function installRelay(window) {
        const relay = {
            start: vi.fn(async () => 'call_tok'),
            stop: vi.fn(() => {
                relay.pending.splice(0).forEach((p) => p.reject(new Error('the call ended')));
            }),
            usesTrialAI: vi.fn(async () => false),
            pending: [],
            setPendingImage: vi.fn((url) => new Promise((resolve, reject) => {
                relay.pending.push({ url, resolve, reject });
            })),
        };
        window.CloudVoiceLLM = relay;
        return relay;
    }

    // A mounted call bar in a live call, so the status line can be read.
    async function liveCall({ relay = true } = {}) {
        const env = createConversationEnv();
        const { window } = env;
        const stub = relay ? installRelay(window) : null;
        const card = window.document.createElement('div');
        card.className = 'wg-callbar';
        window.document.body.appendChild(card);
        window.WGCallAgent.mountCard(card);
        await window.WGCallAgent.startCall(card);
        const opts = window.__TEST_CONVERSATION_OPTS__;
        opts.onConnect();
        const status = () => card.querySelector('.wg-callbar__status').textContent;
        return { ...env, relay: stub, card, opts, status };
    }

    it('rejects when called outside in_call state', async () => {
        const { window, cleanup } = createEnv();
        try {
            await expect(window.WGCallAgent.sendPhoto(makeImageBlob(window))).rejects.toThrow();
        } finally {
            cleanup();
        }
    });

    it('rejects non-image blobs and surfaces a status message', async () => {
        const { window, events, cleanup } = await liveCall();
        try {
            await expect(window.WGCallAgent.sendPhoto(new window.Blob(['hello'], { type: 'text/plain' }))).rejects.toThrow();
            const last = events[events.length - 1];
            expect(last.state).toBe('in_call');
            expect(last.message).toBe('Image required');
        } finally {
            cleanup();
        }
    });

    it('queues the photo as a data: URL, tells the agent, never calls ElevenLabs, and waits for the turn', async () => {
        const { window, conversation, relay, events, cleanup } = await liveCall();
        try {
            const send = window.WGCallAgent.sendPhoto(makeImageBlob(window));
            expect(events[events.length - 1].uploading).toBe(true);
            await vi.waitFor(() => expect(conversation.sendUserMessage).toHaveBeenCalledWith('[User sent a photo]'));
            expect(relay.setPendingImage).toHaveBeenCalledTimes(1);
            expect(relay.pending[0].url).toMatch(/^data:image\/jpeg;base64,/);
            // The photo is queued before the agent is told.
            expect(relay.setPendingImage.mock.invocationCallOrder[0])
                .toBeLessThan(conversation.sendUserMessage.mock.invocationCallOrder[0]);
            expect(window.fetch).not.toHaveBeenCalled();
            expect(window.WGCallAgent.getState().uploading).toBe(true);
            relay.pending[0].resolve();
            await send;
            const last = events[events.length - 1];
            expect(last.uploading).toBe(false);
            expect(last.photoError).toBe('');
        } finally {
            cleanup();
        }
    });

    it('a failed vision turn shows "Couldn\'t send the photo: <reason>" that survives mode changes until the next action', async () => {
        const { window, relay, opts, status, cleanup } = await liveCall();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const send = window.WGCallAgent.sendPhoto(makeImageBlob(window));
            await vi.waitFor(() => expect(relay.pending).toHaveLength(1));
            relay.pending[0].reject(new Error('vision model refused'));
            await expect(send).rejects.toThrow('vision model refused');
            const want = "Couldn't send the photo: vision model refused";
            expect(status()).toBe(want);
            expect(window.WGCallAgent.getState()).toMatchObject({ state: 'in_call', uploading: false, photoError: want });
            expect(warn).toHaveBeenCalledWith('[call] photo send failed:', expect.any(Error));
            // The agent starts listening/speaking: the error stays.
            opts.onModeChange({ mode: 'listening' });
            opts.onModeChange({ mode: 'speaking' });
            expect(status()).toBe(want);
            // The user's next action (mute) clears it; the live status returns.
            window.WGCallAgent.toggleMute();
            expect(window.WGCallAgent.getState().photoError).toBe('');
            expect(status()).toBe('Agent speaking…');
        } finally {
            warn.mockRestore();
            cleanup();
        }
    });

    it('a new send clears the previous failure', async () => {
        const { window, relay, status, cleanup } = await liveCall();
        try {
            const first = window.WGCallAgent.sendPhoto(makeImageBlob(window));
            await vi.waitFor(() => expect(relay.pending).toHaveLength(1));
            relay.pending[0].reject(new Error('boom'));
            await expect(first).rejects.toThrow();
            expect(status()).toBe("Couldn't send the photo: boom");
            const second = window.WGCallAgent.sendPhoto(makeImageBlob(window));
            expect(window.WGCallAgent.getState().photoError).toBe('');
            await vi.waitFor(() => expect(relay.pending).toHaveLength(2));
            relay.pending[1].resolve();
            await second;
            expect(status()).toBe('Connected');
        } finally {
            cleanup();
        }
    });

    it('hang-up while the photo waits drops it (relay stopped) and leaves the bar idle', async () => {
        const { window, relay, events, cleanup } = await liveCall();
        try {
            const send = window.WGCallAgent.sendPhoto(makeImageBlob(window));
            await vi.waitFor(() => expect(relay.pending).toHaveLength(1));
            await window.WGCallAgent.endCall();
            expect(relay.stop).toHaveBeenCalled();
            await expect(send).rejects.toThrow(/call ended/);
            expect(window.WGCallAgent.getState()).toMatchObject({ state: 'idle', photoError: '' });
            expect(events[events.length - 1].state).toBe('idle');
        } finally {
            cleanup();
        }
    });

    it('a photo too large to shrink is refused with the limit; nothing queued, the agent not told', async () => {
        const { window, conversation, relay, status, cleanup } = await liveCall();
        try {
            const big = new window.Blob([new Uint8Array(800 * 1024)], { type: 'image/jpeg' });
            await expect(window.WGCallAgent.sendPhoto(big)).rejects.toMatchObject({ code: 'photo_too_large' });
            expect(relay.setPendingImage).not.toHaveBeenCalled();
            expect(conversation.sendUserMessage).not.toHaveBeenCalled();
            expect(status()).toBe("Couldn't send the photo: Photo is too large to send — the limit is 768 KB.");
        } finally {
            cleanup();
        }
    });

    it('a call without the AI relay says so and does not tell the agent', async () => {
        const { window, conversation, status, cleanup } = await liveCall({ relay: false });
        try {
            await expect(window.WGCallAgent.sendPhoto(makeImageBlob(window))).rejects.toThrow();
            expect(conversation.sendUserMessage).not.toHaveBeenCalled();
            expect(status()).toBe("Couldn't send the photo: this call has no AI relay");
        } finally {
            cleanup();
        }
    });

    it('downscales first: the re-encoded JPEG is what gets queued', async () => {
        const { window, relay, cleanup } = await liveCall();
        const close = vi.fn();
        window.createImageBitmap = vi.fn(async () => ({ width: 4000, height: 3000, close }));
        const drawn = [];
        window.HTMLCanvasElement.prototype.getContext = function () {
            return { drawImage: (_b, _x, _y, w, h) => drawn.push([w, h]) };
        };
        window.HTMLCanvasElement.prototype.toBlob = function (cb, type) {
            expect(type).toBe('image/jpeg');
            cb(new window.Blob(['small-jpeg'], { type: 'image/jpeg' }));
        };
        try {
            const send = window.WGCallAgent.sendPhoto(makeImageBlob(window));
            await vi.waitFor(() => expect(relay.pending).toHaveLength(1));
            expect(drawn[0]).toEqual([1600, 1200]);
            expect(close).toHaveBeenCalled();
            expect(atob(relay.pending[0].url.split(',')[1])).toBe('small-jpeg');
            relay.pending[0].resolve();
            await send;
        } finally {
            cleanup();
        }
    });

    it('end to end with the real responder: the next AI turn carries the photo on the marker, a later turn does not', async () => {
        class FakeSocket {
            constructor() { this.readyState = 1; this.sent = []; FakeSocket.last = this; }

            send(d) { this.sent.push(JSON.parse(d)); }

            close() { this.readyState = 3; }

            recv(f) { this.onmessage({ data: JSON.stringify(f) }); }
        }
        FakeSocket.OPEN = 1;
        vi.stubGlobal('WebSocket', FakeSocket);
        vi.spyOn(console, 'debug').mockImplementation(() => {});
        const env = createConversationEnv();
        const { window, conversation, cleanup } = env;
        const bodies = [];
        const aiClient = {
            usesTrial: async () => false,
            chatStream: vi.fn(async ({ body, onChunk }) => { bodies.push(body); onChunk('data: [DONE]\n\n'); }),
        };
        window.CloudVoiceLLM = createVoiceLLMResponder({ aiClient, url: 'wss://acct.test/api/voice-llm/device' });
        try {
            const card = window.document.createElement('section');
            window.document.body.appendChild(card);
            const starting = window.WGCallAgent.startCall(card);
            await vi.waitFor(() => expect(FakeSocket.last).toBeDefined());
            const sock = FakeSocket.last;
            sock.recv({ type: 'hello', call: 'tok' });
            await starting;
            window.__TEST_CONVERSATION_OPTS__.onConnect();
            expect(window.__TEST_CONVERSATION_OPTS__.customLlmExtraBody).toEqual({ call: 'tok' });

            const send = window.WGCallAgent.sendPhoto(makeImageBlob(window));
            await vi.waitFor(() => expect(conversation.sendUserMessage).toHaveBeenCalled());
            // ElevenLabs answers the marker with a relay turn.
            const marker = { role: 'user', content: '[User sent a photo]' };
            sock.recv({ id: 1, type: 'request', body: { messages: [marker] } });
            await send;
            const parts = bodies[0].messages[0].content;
            expect(parts[0]).toEqual({ type: 'text', text: '[User sent a photo]' });
            expect(parts[1].type).toBe('image_url');
            expect(parts[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
            // Nothing photo-shaped went back over the relay socket.
            expect(JSON.stringify(sock.sent)).not.toContain('image_url');

            sock.recv({
                id: 2,
                type: 'request',
                body: { messages: [marker, { role: 'assistant', content: 'A salad.' }, { role: 'user', content: 'ok' }] },
            });
            await vi.waitFor(() => expect(bodies).toHaveLength(2));
            expect(JSON.stringify(bodies[1])).not.toContain('image_url');
            await window.WGCallAgent.endCall();
        } finally {
            cleanup();
        }
    });

    it('anonymous local-trial calls hide Send photo (their turns never reach this tab)', () => {
        const { window, cleanup } = createConversationEnv();
        try {
            window.CloudVoiceLLM = { localTrial: true, start: vi.fn(), stop: vi.fn() };
            const card = window.document.createElement('div');
            window.document.body.appendChild(card);
            window.WGCallAgent.mountCard(card);
            expect(card.querySelector('.wg-callbar__photo').hidden).toBe(true);
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

describe('features/elevenlabs-call.js — cloud dynamic MCP client-tools', () => {
    it('cloud mode registers mcp_help + mcp_call that round-trip into the dispatcher', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            window.CloudMCPDispatcher = {
                handle: vi.fn(async (method, params) => {
                    if (method === 'mcp_help') return { catalog: ['bp.list'] };
                    if (method === 'mcp_call') return { op: params.op, rows: [{ sys: 120 }] };
                    return {};
                }),
            };
            const { opts } = await startCall(window);
            expect(opts.clientTools).toBeDefined();
            expect(typeof opts.clientTools.mcp_help).toBe('function');
            expect(typeof opts.clientTools.mcp_call).toBe('function');

            const helpJSON = await opts.clientTools.mcp_help();
            expect(JSON.parse(helpJSON)).toEqual({ catalog: ['bp.list'] });
            expect(window.CloudMCPDispatcher.handle).toHaveBeenCalledWith('mcp_help', {});

            const callJSON = await opts.clientTools.mcp_call({ op: 'bp.list' });
            expect(JSON.parse(callJSON)).toEqual({ op: 'bp.list', rows: [{ sys: 120 }] });
            expect(window.CloudMCPDispatcher.handle).toHaveBeenCalledWith('mcp_call', { op: 'bp.list', params: {} });
        } finally {
            cleanup();
        }
    });

    it('surfaces dispatcher errors as a short JSON string instead of throwing into the SDK', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            window.CloudMCPDispatcher = {
                handle: vi.fn(async () => { throw new Error('unknown operation "nope"'); }),
            };
            const { opts } = await startCall(window);
            const out = await opts.clientTools.mcp_call({ op: 'nope' });
            expect(JSON.parse(out)).toEqual({ error: 'unknown operation "nope"' });
        } finally {
            cleanup();
        }
    });

    it('concrete tools map 1:1 to catalog ops, stamping measured_at on writes', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            const handle = vi.fn(async () => ({ ok: true }));
            window.CloudMCPDispatcher = { handle };
            const { opts } = await startCall(window);
            const t = opts.clientTools;

            await t.get_blood_pressure({ days: 7 });
            expect(handle).toHaveBeenCalledWith('mcp_call', { op: 'health.bp.list', params: { days: 7 } });

            // Writes must carry mode/intent or the dispatcher's write gate
            // rejects them before the domain call.
            await t.log_blood_pressure({ systolic: 120, diastolic: 80, pulse: 60 });
            const bpCreate = handle.mock.calls.find((c) => c[0] === 'mcp_call' && c[1].op === 'health.bp.create');
            expect(bpCreate[1].params).toMatchObject({ systolic: 120, diastolic: 80, pulse: 60 });
            expect(bpCreate[1].params.measured_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
            expect(bpCreate[1].mode).toBe('write');
            expect(bpCreate[1].intent).toBeTruthy();

            await t.get_weight({ days: 30 });
            expect(handle).toHaveBeenCalledWith('mcp_call', { op: 'health.weight.list', params: { days: 30 } });

            await t.log_weight({ kg: 70.5 });
            const wCreate = handle.mock.calls.find((c) => c[0] === 'mcp_call' && c[1].op === 'health.weight.create');
            expect(wCreate[1].params).toMatchObject({ weight: 70.5 });
            expect(wCreate[1].params.measured_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
            expect(wCreate[1].mode).toBe('write');

            await t.get_notes();
            expect(handle).toHaveBeenCalledWith('mcp_call', { op: 'health.notes.list', params: {} });

            await t.add_note({ text: 'slept well', tag: 'SLEEP' });
            const nCreate = handle.mock.calls.find((c) => c[0] === 'mcp_call' && c[1].op === 'health.notes.create');
            expect(nCreate[1].params).toEqual({ content: 'slept well', tag: 'SLEEP' });
            expect(nCreate[1].mode).toBe('write');
            expect(nCreate[1].intent).toBeTruthy();
        } finally {
            cleanup();
        }
    });

    // med-eas.82: asked to change a workout the agent used to reach for
    // add_note (the only free-text write it had), writing a Vitals note.
    const workoutDispatcher = (logs) => vi.fn(async (method, params) => {
        if (params.op === 'workouts.sessions.next') {
            return {
                status: 'ok',
                result: { session: { id: 43, status: 'pending' }, variant_id: 6, variant_name: 'Push Day' },
            };
        }
        if (params.op === 'workouts.sessions.details') return { status: 'ok', result: { logs } };
        if (params.op === 'workouts.exercises.list') {
            return {
                status: 'ok',
                result: [
                    { id: 7, exercise_name: 'Bench Press', target_sets: 4, target_reps_min: 8 },
                    { id: 8, exercise_name: 'Rows', target_sets: 3, target_reps_min: 10 },
                ],
            };
        }
        return { status: 'ok', result: null };
    });

    it('get_workout merges logged and still-planned exercises into one flat list', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            // Only Bench Press has a log row; Rows is planned and untouched —
            // sessions.details never returns it, so without the plan merge the
            // agent sees an exercise it cannot write to (or none at all).
            const handle = workoutDispatcher([
                { id: 99, exercise_id: 7, exercise_name: 'Bench Press', sets_completed: 4, status: 'completed' },
            ]);
            window.CloudMCPDispatcher = { handle };
            const { opts } = await startCall(window);

            const read = JSON.parse(await opts.clientTools.get_workout());
            expect(handle).toHaveBeenCalledWith('mcp_call', { op: 'workouts.sessions.next', params: {} });
            expect(handle).toHaveBeenCalledWith('mcp_call', { op: 'workouts.sessions.details', params: { id: 43 } });
            expect(handle).toHaveBeenCalledWith('mcp_call', { op: 'workouts.exercises.list', params: { variant_id: 6 } });
            expect(read.result.session_id).toBe(43);
            expect(read.result.variant_name).toBe('Push Day');
            expect(read.result.exercises).toEqual([
                {
                    log_id: 99, exercise_id: 7, exercise_name: 'Bench Press',
                    sets_completed: 4, reps_completed: undefined, weight_kg: undefined, status: 'completed',
                },
                {
                    log_id: 0, exercise_id: 8, exercise_name: 'Rows',
                    target_sets: 3, target_reps_min: 10, target_weight_kg: undefined, status: '',
                },
            ]);
        } finally {
            cleanup();
        }
    });

    it('workout write tools pick update vs create and answer with the fresh workout', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            const handle = workoutDispatcher([
                { id: 99, exercise_id: 7, exercise_name: 'Bench Press' },
            ]);
            window.CloudMCPDispatcher = { handle };
            const { opts } = await startCall(window);
            const t = opts.clientTools;
            const opCall = (op) => handle.mock.calls.find((c) => c[1].op === op);

            const logged = JSON.parse(await t.log_exercise({ log_id: 99, sets: 3, reps: 12, weight_kg: 60 }));
            const upd = opCall('workouts.sessions.logs.update');
            expect(upd[1].params).toEqual({ id: 99, sets_completed: 3, reps_completed: 12, weight_kg: 60 });
            expect(upd[1].mode).toBe('write');
            expect(upd[1].intent).toBeTruthy();
            // The op returns an empty body, so the tool hands the agent the
            // re-read workout instead — its only way to confirm anything.
            expect(logged.workout.result.session_id).toBe(43);

            await t.log_exercise({ log_id: 0, session_id: 43, exercise_id: 8, exercise_name: 'Rows', sets: 3, reps: 10 });
            const crt = opCall('workouts.sessions.logs.create');
            expect(crt[1].params).toEqual({
                session_id: 43, exercise_id: 8, exercise_name: 'Rows',
                target_sets: 3, target_reps_min: 10, status: 'completed',
            });
            expect(crt[1].mode).toBe('write');

            const closed = JSON.parse(await t.set_workout_status({ session_id: 43, status: 'completed' }));
            const st = opCall('workouts.sessions.status');
            expect(st[1].params).toEqual({ id: 43, status: 'completed' });
            expect(st[1].mode).toBe('write');
            expect(st[1].intent).toBeTruthy();
            // sessions.next excludes terminal sessions, so re-reading would hand
            // back an unrelated future workout — confirm the write itself.
            expect(closed).toEqual({ status: 'ok', session_id: 43, session_status: 'completed' });

            await t.set_workout_status({ session_id: 43, status: 'in_progress' });
            const start = opCall('workouts.sessions.start');
            expect(start[1].path_params).toEqual({ id: 43 });
            expect(start[1].mode).toBe('write');
        } finally {
            cleanup();
        }
    });

    it('log_exercise fills a skipped planned exercise from its targets and refuses a future session', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            let isToday = true;
            const handle = vi.fn(async (method, params) => {
                if (params.op === 'workouts.sessions.next') {
                    return { status: 'ok', result: { session: { id: 43, is_today: isToday }, variant_id: 6 } };
                }
                if (params.op === 'workouts.sessions.details') return { status: 'ok', result: { logs: [] } };
                if (params.op === 'workouts.exercises.list') {
                    return {
                        status: 'ok',
                        result: [{ id: 8, exercise_name: 'Rows', target_sets: 3, target_reps_min: 10 }],
                    };
                }
                return { status: 'ok', result: null };
            });
            window.CloudMCPDispatcher = { handle };
            const { opts } = await startCall(window);

            // "skip the rows" states no sets or reps, but logs.create requires
            // target_sets/target_reps_min — fall back to the planned targets
            // rather than bouncing off the write gate or inventing actuals.
            await opts.clientTools.log_exercise({ exercise_id: 8, status: 'skipped' });
            const crt = handle.mock.calls.find((c) => c[1].op === 'workouts.sessions.logs.create');
            expect(crt[1].params).toEqual({
                session_id: 43, exercise_id: 8, exercise_name: 'Rows',
                target_sets: 3, target_reps_min: 10, status: 'skipped',
            });

            // sessions.next also surfaces sessions scheduled for a later day;
            // logging into one records the workout on the wrong date and pushes
            // the numbers into that day's plan.
            isToday = false;
            const refused = JSON.parse(await opts.clientTools.log_exercise({ exercise_id: 8, sets: 3, reps: 10 }));
            expect(refused.error).toMatch(/later day/);
            expect(handle.mock.calls.filter((c) => c[1].op === 'workouts.sessions.logs.create')).toHaveLength(1);
        } finally {
            cleanup();
        }
    });

    it('get_workout prefers the session snapshot and ignores library-sourced logs when merging the plan', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            const handle = vi.fn(async (method, params) => {
                if (params.op === 'workouts.sessions.next') {
                    return { status: 'ok', result: { session: { id: 43 }, variant_id: 6 } };
                }
                if (params.op === 'workouts.sessions.details') {
                    return {
                        status: 'ok',
                        result: {
                            // The user dropped "Rows" from today only, so the
                            // snapshot — not the live variant — is the plan.
                            session: {
                                id: 43,
                                exercise_snapshot: [
                                    { exercise_id: 7, exercise_name: 'Bench Press', target_sets: 4, target_reps_min: 8 },
                                ],
                            },
                            // A library-sourced log whose exercise_id happens to
                            // equal a planned workout_exercises id: different id
                            // spaces, so it must not hide the planned row.
                            logs: [{ id: 100, exercise_id: 7, exercise_name: 'Curls', source: 'library' }],
                        },
                    };
                }
                return { status: 'ok', result: [] };
            });
            window.CloudMCPDispatcher = { handle };
            const { opts } = await startCall(window);

            const read = JSON.parse(await opts.clientTools.get_workout());
            expect(handle.mock.calls.some((c) => c[1].op === 'workouts.exercises.list')).toBe(false);
            expect(read.result.exercises).toEqual([
                {
                    log_id: 100, exercise_id: 7, exercise_name: 'Curls',
                    sets_completed: undefined, reps_completed: undefined, weight_kg: undefined, status: undefined,
                },
                {
                    log_id: 0, exercise_id: 7, exercise_name: 'Bench Press',
                    target_sets: 4, target_reps_min: 8, target_weight_kg: undefined, status: '',
                },
            ]);
        } finally {
            cleanup();
        }
    });

    it('get_workout returns the bare next-session response when nothing is scheduled', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            const handle = vi.fn(async () => ({ status: 'ok', result: null }));
            window.CloudMCPDispatcher = { handle };
            const { opts } = await startCall(window);

            const out = JSON.parse(await opts.clientTools.get_workout());
            expect(out).toEqual({ status: 'ok', result: null });
            // No session id -> no second dispatch with an undefined id.
            expect(handle).toHaveBeenCalledTimes(1);
        } finally {
            cleanup();
        }
    });

    // Scope widened (med-eas.82): the generic pair is provisioned now, so the
    // agent can reach every catalog op the Claude connector can. ElevenLabs
    // client tools are flat, so the nested params arrive as a JSON string.
    it('mcp_call parses params_json / path_params_json into the dispatcher envelope', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            const handle = vi.fn(async () => ({ status: 'ok', result: [] }));
            window.CloudMCPDispatcher = { handle };
            const { opts } = await startCall(window);

            // mcp_help's drill-down is the only way the agent learns an op's
            // required fields, so the filters have to be declared and forwarded.
            await opts.clientTools.mcp_help({ operation_id: 'food.log.create' });
            expect(handle).toHaveBeenCalledWith('mcp_help', { operation_id: 'food.log.create' });
            await opts.clientTools.mcp_help({ query: 'sleep' });
            expect(handle).toHaveBeenCalledWith('mcp_help', { query: 'sleep' });

            await opts.clientTools.mcp_call({ op: 'food.log.list', params_json: '{"days": 7}' });
            expect(handle).toHaveBeenCalledWith('mcp_call', { op: 'food.log.list', params: { days: 7 } });

            await opts.clientTools.mcp_call({
                op: 'meds.intake.confirm',
                params_json: '{"note": "taken"}',
                path_params_json: '{"id": 42}',
                mode: 'write',
                intent: 'user confirmed it out loud',
            });
            expect(handle).toHaveBeenCalledWith('mcp_call', {
                op: 'meds.intake.confirm',
                params: { note: 'taken' },
                path_params: { id: 42 },
                mode: 'write',
                intent: 'user confirmed it out loud',
            });

            // Malformed JSON must come back as a correctable message, not a
            // throw into the SDK and not a silent empty-params call.
            const bad = JSON.parse(await opts.clientTools.mcp_call({ op: 'food.log.list', params_json: '{days: 7' }));
            expect(bad.error).toMatch(/params_json/);
            expect(handle).toHaveBeenCalledTimes(4);
        } finally {
            cleanup();
        }
    });

    // The tests above mock CloudMCPDispatcher, so they cannot see the real
    // dispatcher's write gate (risk:"write" ops are refused without
    // mode:"write" + intent). Drive the real one: this is the only test that
    // fails if the voice tools stop stating their write intent.
    it('write tools reach the real dispatcher through its write gate', async () => {
        const { createDispatcher } = await import('../../../cloud/js/mcp-responder.js');
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            // The dispatcher routes every op through apishim's router, so a
            // stub router records the (endpoint, method, body) each voice tool
            // produces. The route table itself is covered by the cloud suite.
            const router = vi.fn(async (endpoint, method, body) => {
                // Enough of a workout for the write tools to resolve a row:
                // one logged exercise and one still-planned one.
                if (endpoint.startsWith('/api/workout/sessions/next')) {
                    return { session: { id: 43, is_today: true }, variant_id: 6 };
                }
                if (endpoint.startsWith('/api/workout/sessions/details')) {
                    return { session: { id: 43 }, logs: [{ id: 99, exercise_id: 7, exercise_name: 'Bench Press' }] };
                }
                if (endpoint.startsWith('/api/workout/exercises?')) {
                    return [{ id: 8, exercise_name: 'Rows', target_sets: 3, target_reps_min: 10 }];
                }
                return method === 'GET' ? [] : { id: 1, ...body };
            });
            window.CloudMCPDispatcher = createDispatcher({ router });

            const { opts } = await startCall(window);
            const t = opts.clientTools;
            const routed = () => router.mock.calls.map(([endpoint, method, body]) => [endpoint, method, body]);

            // Each write must actually land in the domain, and the tool must
            // not swallow a gate rejection into an {error} string.
            const bpOut = JSON.parse(await t.log_blood_pressure({ systolic: 120, diastolic: 80 }));
            expect(bpOut.error).toBeUndefined();
            expect(routed()[0][0]).toBe('/api/bp');
            expect(routed()[0][1]).toBe('POST');
            expect(routed()[0][2]).toMatchObject({ systolic: 120, diastolic: 80 });

            const wOut = JSON.parse(await t.log_weight({ kg: 70.5 }));
            expect(wOut.error).toBeUndefined();
            expect(routed()[1].slice(0, 2)).toEqual(['/api/weight', 'POST']);

            const nOut = JSON.parse(await t.add_note({ text: 'slept well' }));
            expect(nOut.error).toBeUndefined();
            expect(routed()[2][0]).toBe('/api/notes');
            expect(routed()[2][2]).toMatchObject({ content: 'slept well' });

            // Reads still work without mode/intent.
            expect(JSON.parse(await t.get_blood_pressure({ days: 7 })).error).toBeUndefined();
            expect(routed()[3].slice(0, 2)).toEqual(['/api/bp?days=7', 'GET']);

            // Workout writes: the gate blocks a missing required field, so
            // these prove the callbacks send every field the catalog declares.
            const at = (endpoint) => routed().find((r) => r[0] === endpoint);

            const lOut = JSON.parse(await t.log_exercise({ log_id: 99, sets: 3, reps: 12, weight_kg: 60 }));
            expect(lOut.error).toBeUndefined();
            const upd = at('/api/workout/sessions/logs/update');
            expect(upd[1]).toBe('POST');
            expect(upd[2]).toEqual({ id: 99, sets_completed: 3, reps_completed: 12, weight_kg: 60 });

            // No log row yet (log_id 0): the same tool creates one, carrying the
            // actuals in the target_* fields logs.create declares required.
            const cOut = JSON.parse(await t.log_exercise({ exercise_id: 8, sets: 3, reps: 12, weight_kg: 60 }));
            expect(cOut.error).toBeUndefined();
            const crt = at('/api/workout/sessions/logs/create');
            expect(crt[1]).toBe('POST');
            expect(crt[2]).toMatchObject({
                session_id: 43, exercise_id: 8, exercise_name: 'Rows',
                target_sets: 3, target_reps_min: 12, target_weight_kg: 60, status: 'completed',
            });

            // With no usable id the tool refuses instead of issuing an update
            // against an unknown log, which the domain answers 200/no-op.
            const bad = JSON.parse(await t.log_exercise({ sets: 3 }));
            expect(bad.error).toMatch(/get_workout/);

            const sOut = JSON.parse(await t.set_workout_status({ session_id: 43, status: 'completed' }));
            expect(sOut.error).toBeUndefined();
            // id rides the query string (params_schema), status the body.
            const st = at('/api/workout/sessions/status?id=43');
            expect(st[1]).toBe('PUT');
            expect(st[2]).toEqual({ status: 'completed' });

            // "in_progress" is not a plain status flip — it must go through the
            // start op, which also stamps started_at and clears a snooze.
            const stOut = JSON.parse(await t.set_workout_status({ session_id: 43, status: 'in_progress' }));
            expect(stOut.error).toBeUndefined();
            expect(at('/api/workout/sessions/43/start')[1]).toBe('POST');
            // ...and does not also flip the status directly.
            expect(routed().filter((r) => r[0].startsWith('/api/workout/sessions/status'))).toHaveLength(1);
        } finally {
            cleanup();
        }
    });

    it('generic mcp_call forwards the agent-stated mode/intent to the real dispatcher', async () => {
        const { createDispatcher } = await import('../../../cloud/js/mcp-responder.js');
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            // The dispatcher routes through apishim's router; stub it here so
            // this suite tests the voice tool's envelope, not the route table.
            const router = vi.fn(async (endpoint, method, body) => ({ id: 3, ...body }));
            window.CloudMCPDispatcher = createDispatcher({ router });
            const { opts } = await startCall(window);

            const ok = JSON.parse(await opts.clientTools.mcp_call({
                op: 'health.notes.create', params: { content: 'hi' }, mode: 'write', intent: 'user asked',
            }));
            expect(ok.error).toBeUndefined();
            expect(router).toHaveBeenCalledWith('/api/notes', 'POST', { content: 'hi' });

            // Without mode, the same write is gated — not silently dropped.
            const gated = JSON.parse(await opts.clientTools.mcp_call({
                op: 'health.notes.create', params: { content: 'hi' },
            }));
            expect(gated.error).toMatch(/is a write/);
            expect(router).toHaveBeenCalledTimes(1);
        } finally {
            cleanup();
        }
    });

    it('cloud mode awaits provision() and forwards its agent id into fetchSignedURL', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            const provision = vi.fn(async () => 'agent-provisioned-42');
            const fetchSignedURL = vi.fn(async () => 'wss://api.elevenlabs.io/v1/convai/conversation?token=xyz');
            window.CloudElevenLabsAgent = { provision };
            window.CloudElevenLabs = { fetchSignedURL, hasKey: async () => true };

            const { opts } = await startCall(window);

            expect(provision).toHaveBeenCalledTimes(1);
            expect(fetchSignedURL).toHaveBeenCalledWith('agent-provisioned-42');
            expect(opts.signedUrl).toBe('wss://api.elevenlabs.io/v1/convai/conversation?token=xyz');
        } finally {
            cleanup();
        }
    });

    it('parses stringified tool args (SDK may hand JSON strings)', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            const handle = vi.fn(async () => ({ ok: true }));
            window.CloudMCPDispatcher = { handle };
            const { opts } = await startCall(window);

            await opts.clientTools.log_blood_pressure(JSON.stringify({ systolic: 130, diastolic: 85 }));
            const bpCreate = handle.mock.calls.find((c) => c[0] === 'mcp_call' && c[1].op === 'health.bp.create');
            expect(bpCreate[1].params).toMatchObject({ systolic: 130, diastolic: 85 });
        } finally {
            cleanup();
        }
    });

    it('caps oversized tool results to the 14 KB voice budget and leaves small ones byte-identical', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            const notes = Array.from({ length: 400 }, (_, i) => ({ id: i, text: 'n'.repeat(250) }));
            const small = { rows: [{ sys: 120 }] };
            window.CloudMCPDispatcher = {
                handle: vi.fn(async (method, params) => {
                    if (params.op === 'health.notes.list') return { status: 'ok', result: { notes }, api_calls: 1 };
                    if (params.op === 'bare.list') return notes;
                    if (params.op === 'ru.list') return { status: 'ok', result: { notes: notes.map((x) => ({ ...x, text: 'п'.repeat(250) })) } };
                    if (params.op === 'blob') return { blob: 'x'.repeat(100000) };
                    return small;
                }),
            };
            const { opts } = await startCall(window);

            const nested = await opts.clientTools.mcp_call({ op: 'health.notes.list' });
            expect(nested.length).toBeLessThanOrEqual(14 * 1024);
            const n = JSON.parse(nested);
            expect(n.truncated).toBe(true);
            expect(n.result.notes.length + n.omitted).toBe(400);
            expect(n.result.notes[0].id).toBe(0);
            expect(typeof n.hint).toBe('string');

            const bare = await opts.clientTools.mcp_call({ op: 'bare.list' });
            expect(bare.length).toBeLessThanOrEqual(14 * 1024);
            const b = JSON.parse(bare);
            expect(b[b.length - 1]).toMatchObject({ truncated: true });

            const ru = await opts.clientTools.mcp_call({ op: 'ru.list' });
            expect(Buffer.byteLength(ru)).toBeLessThanOrEqual(14 * 1024);
            expect(JSON.parse(ru).truncated).toBe(true);

            const blob = await opts.clientTools.mcp_call({ op: 'blob' });
            expect(blob.length).toBeLessThanOrEqual(14 * 1024);
            expect(JSON.parse(blob).truncated).toBe(true);

            expect(await opts.clientTools.mcp_call({ op: 'small' })).toBe(JSON.stringify(small));
        } finally {
            cleanup();
        }
    });

    it('registers no clientTools without a dispatcher', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            // No CloudMCPDispatcher in this env → no tools.
            const { opts } = await startCall(window);
            expect(opts.clientTools).toBeUndefined();
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
            expect(container.querySelector('.wg-callbar__mute')).not.toBeNull();
            expect(container.querySelector('.wg-callbar__photo')).not.toBeNull();
            const input = container.querySelector('.wg-callbar__photo-input');
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

describe('features/elevenlabs-call.js — Today call bar (kit T2/T4/T5)', () => {
    async function flush(window) {
        for (let i = 0; i < 5; i += 1) await new Promise((r) => window.setTimeout(r, 0));
    }

    // Today's markup: the call bar row inside the active Today view, plus a
    // second view to switch to. Log stands in for Today's own row buttons.
    function todayPage(window) {
        window.document.body.innerHTML = '<div id="today-view" class="view active"><div id="today-content"></div></div>'
            + '<div id="food-view" class="view"></div>';
    }

    function mountBar(window) {
        const { document } = window;
        const bar = document.createElement('div');
        bar.className = 'wg-callbar wg-today-callbar';
        window.WGCallAgent.mountCard(bar);
        const log = document.createElement('button');
        log.className = 'wg-btn';
        log.setAttribute('data-action', 'open-log');
        bar.appendChild(log);
        document.getElementById('today-content').appendChild(bar);
        return bar;
    }

    async function connect(window, bar) {
        await window.WGCallAgent.startCall(bar);
        window.__TEST_CONVERSATION_OPTS__.onConnect();
    }

    it('no vault key and no trial → "Set up voice agent" opens Settings → AI & integrations instead of calling', async () => {
        const { window, cleanup } = createConversationEnv({ setup: todayPage });
        try {
            window.CloudElevenLabs.hasKey = vi.fn(async () => false);
            window.switchTab = vi.fn();
            window.SettingsView = { openSettingsPage: vi.fn() };
            const bar = mountBar(window);
            await flush(window);
            const trigger = bar.querySelector('.wg-callbar__call');
            expect(trigger.querySelector('.wg-callbar__label').textContent).toBe('Set up voice agent');
            expect(trigger.disabled).toBe(false);
            trigger.click();
            expect(window.switchTab).toHaveBeenCalledWith('settings');
            expect(window.SettingsView.openSettingsPage).toHaveBeenCalledWith('integrations');
            expect(window.__TEST_START_SESSION_CALLS__).toBeUndefined();
            expect(window.WGCallAgent.getState().state).toBe('idle');
        } finally {
            cleanup();
        }
    });

    it('a configured key reads "Call agent" and a tap starts the call', async () => {
        const { window, cleanup } = createConversationEnv({ setup: todayPage });
        try {
            const bar = mountBar(window);
            await flush(window);
            const trigger = bar.querySelector('.wg-callbar__call');
            expect(trigger.querySelector('.wg-callbar__label').textContent).toBe('Call agent');
            trigger.click();
            await flush(window);
            expect(window.__TEST_START_SESSION_CALLS__).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('offline → the call is disabled and says why; back online it is callable again', async () => {
        const { window, cleanup } = createConversationEnv({ setup: todayPage });
        try {
            let online = false;
            Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
            const bar = mountBar(window);
            await flush(window);
            const trigger = bar.querySelector('.wg-callbar__call');
            expect(trigger.disabled).toBe(true);
            expect(trigger.querySelector('.wg-callbar__label').textContent).toBe('Call needs a connection');
            expect(trigger.querySelector('.wg-ico').getAttribute('data-icon')).toBe('phone-off');

            online = true;
            window.dispatchEvent(new window.Event('online'));
            expect(trigger.disabled).toBe(false);
            expect(trigger.querySelector('.wg-callbar__label').textContent).toBe('Call agent');
        } finally {
            cleanup();
        }
    });

    it('a live call turns the bar --live with Mute / Send photo / End call; the row\'s own buttons are not live controls', async () => {
        const { window, conversation, cleanup } = createConversationEnv({ setup: todayPage });
        try {
            const bar = mountBar(window);
            await connect(window, bar);
            expect(bar.classList.contains('wg-callbar--live')).toBe(true);
            const live = [...bar.querySelectorAll('[data-call-live]')].map((n) => n.className);
            expect(live).toEqual([
                'wg-pulse',
                'wg-callbar__status',
                'wg-btn wg-btn--icon wg-btn--sm wg-callbar__mute',
                'wg-btn wg-btn--icon wg-btn--sm wg-callbar__photo',
                'wg-btn wg-btn--icon wg-btn--sm wg-callbar__end wg-btn--danger',
            ]);
            expect(bar.querySelector('[data-action="open-log"]').hasAttribute('data-call-live')).toBe(false);
            expect(bar.querySelector('.wg-callbar__status').textContent).toBe('Connected');

            bar.querySelector('.wg-callbar__mute').click();
            expect(conversation.setMicMuted).toHaveBeenCalledWith(true);
            expect(bar.querySelector('.wg-callbar__mute').getAttribute('aria-pressed')).toBe('true');
            expect(bar.querySelector('.wg-callbar__mute .wg-ico').getAttribute('data-icon')).toBe('mic-off');

            bar.querySelector('.wg-callbar__end').click();
            await flush(window);
            expect(conversation.endSession).toHaveBeenCalled();
            expect(bar.classList.contains('wg-callbar--live')).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('docks above the tab bar on another tab (one surface), and returns to Today', async () => {
        let onTab = null;
        const { window, document, cleanup } = createConversationEnv({
            setup: (w) => {
                todayPage(w);
                w.AppStore = { subscribe: (key, fn) => { if (key === 'currentTab') onTab = fn; } };
            },
        });
        try {
            const content = document.getElementById('today-content');
            const bar = mountBar(window);
            await connect(window, bar);
            expect(bar.classList.contains('wg-callbar--dock')).toBe(false);

            document.getElementById('today-view').classList.remove('active');
            document.getElementById('food-view').classList.add('active');
            onTab('food');
            expect(bar.parentNode).toBe(document.body);
            expect(bar.classList.contains('wg-callbar--dock')).toBe(true);
            expect(content.querySelector('.wg-callbar-slot')).not.toBeNull();
            expect(document.querySelectorAll('.wg-callbar')).toHaveLength(1);
            expect(window.WGCallIndicator).toBeUndefined();

            document.getElementById('food-view').classList.remove('active');
            document.getElementById('today-view').classList.add('active');
            onTab('today');
            expect(bar.parentNode).toBe(content);
            expect(bar.classList.contains('wg-callbar--dock')).toBe(false);
            expect(content.querySelector('.wg-callbar-slot')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('docks once scrolled past, and ending the call puts it back in its Today slot', async () => {
        const { window, document, cleanup } = createConversationEnv({ setup: todayPage });
        try {
            const content = document.getElementById('today-content');
            const bar = mountBar(window);
            await connect(window, bar);
            bar.getBoundingClientRect = () => ({ top: -70, bottom: -14, height: 56 });
            window.dispatchEvent(new window.Event('scroll'));
            expect(bar.classList.contains('wg-callbar--dock')).toBe(true);
            expect(bar.parentNode).toBe(document.body);

            bar.querySelector('.wg-callbar__end').click();
            await flush(window);
            expect(bar.classList.contains('wg-callbar--dock')).toBe(false);
            expect(bar.parentNode).toBe(content);
        } finally {
            cleanup();
        }
    });

    it('an idle bar never docks', async () => {
        const { window, document, cleanup } = createConversationEnv({ setup: todayPage });
        try {
            const bar = mountBar(window);
            await flush(window);
            document.getElementById('today-view').classList.remove('active');
            window.dispatchEvent(new window.Event('scroll'));
            expect(bar.classList.contains('wg-callbar--dock')).toBe(false);
            expect(bar.parentNode).toBe(document.getElementById('today-content'));
        } finally {
            cleanup();
        }
    });

    it('a Today re-render while docked retires the old bar and docks the new one', async () => {
        const { window, document, cleanup } = createConversationEnv({ setup: todayPage });
        try {
            const content = document.getElementById('today-content');
            const first = mountBar(window);
            await connect(window, first);
            document.getElementById('today-view').classList.remove('active');
            window.dispatchEvent(new window.Event('scroll'));
            expect(first.parentNode).toBe(document.body);

            // today.js rebuilds the row, mounts into it, then swaps the content.
            const second = document.createElement('div');
            second.className = 'wg-callbar wg-today-callbar';
            window.WGCallAgent.mountCard(second);
            content.replaceChildren(second);
            await flush(window);
            expect(first.isConnected).toBe(false);
            expect(second.parentNode).toBe(document.body);
            expect(second.classList.contains('wg-callbar--dock')).toBe(true);
            expect(second.dataset.state).toBe('in_call');
            expect(document.querySelectorAll('.wg-callbar')).toHaveLength(1);
        } finally {
            cleanup();
        }
    });
});

describe('features/elevenlabs-call.js — mount during connecting', () => {
    // A Today re-render (sync poll, tab switch, repaint tick) landing in the
    // 'connecting' window used to rebuild the card as an idle trigger, because
    // mountCard only reattached live state once activeConversation existed —
    // and a second tap then started an untracked concurrent session (med-k8m6).
    // A never-settling startSession holds the controller in 'connecting'.
    function createConnectingEnv() {
        return createConversationEnv({ conv: { then() { /* never settles */ } } });
    }

    // startCall() awaits the signed URL + SDK before calling startSession;
    // drain microtasks until it has (never resolves, so we can't await it).
    async function waitForSessionStart(window) {
        for (let i = 0; i < 50 && !window.__TEST_START_SESSION_CALLS__; i += 1) {
            await new Promise((r) => setTimeout(r, 0));
        }
    }

    it('mounts the connecting card, and a tap starts no second session', async () => {
        const { window, document, cleanup } = createConnectingEnv();
        try {
            const first = document.createElement('div');
            document.body.appendChild(first);
            const card = window.WGCallAgent.mountCard(first);
            window.WGCallAgent.startCall(card); // stays pending in 'connecting'
            await waitForSessionStart(window);
            expect(window.WGCallAgent.getState().state).toBe('connecting');
            expect(window.__TEST_START_SESSION_CALLS__).toBe(1);

            // Re-render: fresh container, previous card node dropped.
            const second = document.createElement('div');
            document.body.appendChild(second);
            const remounted = window.WGCallAgent.mountCard(second);
            expect(remounted.dataset.state).toBe('connecting');
            const label = remounted.querySelector('.wg-callbar__label');
            const btn = remounted.querySelector('.wg-callbar__call');
            expect(label.textContent).toBe('Connecting…');
            expect(btn.disabled).toBe(true);

            // Even if the tap gets through (disabled is a DOM-level guard
            // only), startCall must refuse while a call is in flight.
            await window.WGCallAgent.startCall(remounted);
            expect(window.__TEST_START_SESSION_CALLS__).toBe(1);

            // The remounted card is the one live state now paints onto.
            window.__TEST_CONVERSATION_OPTS__.onConnect();
            expect(remounted.dataset.state).toBe('in_call');
            expect(remounted.querySelector('.wg-callbar__label').textContent).toBe('End call');
        } finally {
            cleanup();
        }
    });

    it('reattaches connecting state to an existing card node', async () => {
        const { window, document, cleanup } = createConnectingEnv();
        try {
            const container = document.createElement('div');
            document.body.appendChild(container);
            const card = window.WGCallAgent.mountCard(container);
            window.WGCallAgent.startCall(card);
            await waitForSessionStart(window);
            // Same node re-queried: applyState must still run over it.
            card.dataset.state = 'idle';
            expect(window.WGCallAgent.mountCard(container)).toBe(card);
            expect(card.dataset.state).toBe('connecting');
        } finally {
            cleanup();
        }
    });
});

describe('features/elevenlabs-call.js — connect watchdog + cancel token', () => {
    // The connect chain (signed URL → SDK → startSession, which awaits
    // getUserMedia) is unbounded. An unanswered mic prompt used to pin
    // activeState at 'connecting' until reload: card button disabled,
    // indicator hang-up disabled, callInFlight() refusing a retry (med-i5wi).

    // The controller's setTimeout resolves off the inner JSDOM window, which
    // vi's fake timers (installed on globalThis) never see. Bridge it so
    // vi.advanceTimersByTime drives the watchdog.
    function bridgeTimers(window) {
        window.setTimeout = (...args) => globalThis.setTimeout(...args);
        window.clearTimeout = (...args) => globalThis.clearTimeout(...args);
    }

    // The connect chain is microtask-only under these stubs (CloudElevenLabs +
    // a pre-resolved SDK), so draining microtasks is enough to reach
    // startSession — and unlike a setTimeout(0) drain it works with fake
    // timers installed.
    async function drain(n = 30) {
        for (let i = 0; i < n; i += 1) await Promise.resolve();
    }

    // A startSession whose resolution the test controls: settle() hands the
    // controller a live conversation, however late.
    function pendingSession() {
        const conversation = makeFakeConversation();
        let deliver = null;
        const thenable = { then(resolve) { deliver = () => resolve(conversation); } };
        return { thenable, conversation, settle: () => deliver && deliver() };
    }

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('times out a never-settling connect, and a retry is allowed after', async () => {
        const { window, document, cleanup } = createConversationEnv({ conv: { then() { /* never settles */ } } });
        try {
            bridgeTimers(window);
            const container = document.createElement('div');
            document.body.appendChild(container);
            const card = window.WGCallAgent.mountCard(container);
            window.WGCallAgent.startCall(card);
            await drain();
            expect(window.WGCallAgent.getState().state).toBe('connecting');

            vi.advanceTimersByTime(29000);
            expect(window.WGCallAgent.getState().state).toBe('connecting');

            vi.advanceTimersByTime(1000);
            const state = window.WGCallAgent.getState();
            expect(state.state).toBe('error');
            expect(state.message).toMatch(/microphone/i);
            expect(card.querySelector('.wg-callbar__call').disabled).toBe(false);
            expect(card.querySelector('.wg-callbar__label').textContent).toBe('Try again');

            // No longer in flight: the user can try again without a reload.
            window.WGCallAgent.startCall(card);
            await drain();
            expect(window.__TEST_START_SESSION_CALLS__).toBe(2);
        } finally {
            cleanup();
        }
    });

    it('ends a session that resolves after the watchdog fired, instead of adopting it', async () => {
        const pending = pendingSession();
        const { window, document, cleanup } = createConversationEnv({ conv: pending.thenable });
        try {
            bridgeTimers(window);
            const card = window.WGCallAgent.mountCard(document.body);
            window.WGCallAgent.startCall(card);
            await drain();
            vi.advanceTimersByTime(30000);
            expect(window.WGCallAgent.getState().state).toBe('error');

            // The mic prompt is finally answered and the SDK hands us a live
            // session. Nothing tracks it, so it must be hung up, not adopted.
            pending.settle();
            await drain();
            expect(pending.conversation.endSession).toHaveBeenCalledTimes(1);
            expect(window.WGCallAgent.getState().state).toBe('error');
        } finally {
            cleanup();
        }
    });

    it('hang-up during connecting returns to idle and disowns the late session', async () => {
        const pending = pendingSession();
        const { window, document, cleanup } = createConversationEnv({ conv: pending.thenable });
        try {
            bridgeTimers(window);
            const card = window.WGCallAgent.mountCard(document.body);
            window.WGCallAgent.startCall(card);
            await drain();
            expect(window.WGCallAgent.getState().state).toBe('connecting');

            await window.WGCallAgent.endCall();
            expect(window.WGCallAgent.getState().state).toBe('idle');

            pending.settle();
            await drain();
            expect(pending.conversation.endSession).toHaveBeenCalledTimes(1);
            expect(window.WGCallAgent.getState().state).toBe('idle');

            // …and the disowned session's SDK callbacks must not repaint state.
            window.__TEST_CONVERSATION_OPTS__.onConnect();
            window.__TEST_CONVERSATION_OPTS__.onError(new Error('late boom'));
            expect(window.WGCallAgent.getState().state).toBe('idle');
        } finally {
            cleanup();
        }
    });

    it('clears the watchdog once startSession resolves (no late timeout mid-call)', async () => {
        const { window, document, cleanup } = createConversationEnv();
        try {
            bridgeTimers(window);
            const card = window.WGCallAgent.mountCard(document.body);
            await window.WGCallAgent.startCall(card);
            window.__TEST_CONVERSATION_OPTS__.onConnect();
            expect(window.WGCallAgent.getState().state).toBe('in_call');

            vi.advanceTimersByTime(60000);
            expect(window.WGCallAgent.getState().state).toBe('in_call');
        } finally {
            cleanup();
        }
    });
});

describe('features/elevenlabs-call.js — trial-voice fallback precedence (cloud)', () => {
    // Wire a cloud env around fetchSignedURL(): vault-key presence via
    // CloudElevenLabs.hasKey, trial availability via the injected meta flag,
    // and the trial proxy route via a fetch stub.
    // `consent` is the trialconsent record the shim route returns; default
    // grants the voice scope so the pre-gate trial-path tests keep pinning
    // the same fetch behavior. Pass null for a never-asked record.
    function cloudEnv({ hasKey, trialFlag, trialStatus = 200, trialBody, consent = { voice: true } } = {}) {
        const env = createEnv();
        const { window } = env;
        window.__MEDTRACKER_CLOUD__ = true;
        const consentGet = vi.fn(async (url, method) => {
            if (url === '/api/settings/trial-consent' && method === 'GET') {
                return consent === null ? { ai: null, voice: null, tg: null } : consent;
            }
            throw new Error(`Unexpected apiCall: ${url}`);
        });
        window.apiCall = consentGet;
        if (trialFlag) {
            const meta = window.document.createElement('meta');
            meta.setAttribute('name', 'medtracker-trial-voice');
            meta.setAttribute('content', '1');
            window.document.head.appendChild(meta);
        }
        // Default bodies mirror the trial proxy's error contract; pass
        // trialBody explicitly to simulate a reverse-proxy error (non-JSON).
        if (trialBody === undefined) {
            if (trialStatus === 429) trialBody = { error: 'trial_rate_limit', retry_after_seconds: 60 };
            else if (trialStatus === 503) trialBody = { error: 'trial_not_configured' };
            else trialBody = { signed_url: 'wss://trial.example/signed' };
        }
        const trialFetch = vi.fn(async (url) => {
            if (typeof url === 'string' && url.startsWith('/api/trial/elevenlabs/signed-url')) {
                return {
                    ok: trialStatus >= 200 && trialStatus < 300,
                    status: trialStatus,
                    async json() {
                        if (typeof trialBody === 'string') throw new SyntaxError('not JSON');
                        return trialBody;
                    },
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        window.fetch = trialFetch;
        const byoFetchSignedURL = vi.fn(async () => 'wss://byo.example/signed');
        const provision = vi.fn(async () => {
            // Mirrors elevenlabs-agent.js: provisioning needs the user's key.
            if (!hasKey) throw new Error('Set your ElevenLabs API key in Settings → Integrations');
            return 'agent-byo-1';
        });
        window.CloudElevenLabs = {
            fetchSignedURL: byoFetchSignedURL,
            hasKey: vi.fn(async () => Boolean(hasKey)),
        };
        window.CloudElevenLabsAgent = { provision };
        return { ...env, trialFetch, byoFetchSignedURL, provision, consentGet };
    }

    it('vault key present → provision + browser-direct path, trial route never hit, consent never read (even with flag set)', async () => {
        const { window, trialFetch, byoFetchSignedURL, provision, consentGet, cleanup } = cloudEnv({ hasKey: true, trialFlag: true });
        try {
            const url = await window.WGCallAgent.fetchSignedURL();
            expect(url).toBe('wss://byo.example/signed');
            expect(provision).toHaveBeenCalledTimes(1);
            expect(byoFetchSignedURL).toHaveBeenCalledWith('agent-byo-1');
            expect(trialFetch).not.toHaveBeenCalled();
            expect(consentGet).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('no vault key + trial flag + voice consent → GET /api/trial/elevenlabs/signed-url, provisioning skipped', async () => {
        const { window, trialFetch, byoFetchSignedURL, provision, consentGet, cleanup } = cloudEnv({ hasKey: false, trialFlag: true });
        try {
            const url = await window.WGCallAgent.fetchSignedURL();
            expect(url).toBe('wss://trial.example/signed');
            expect(consentGet).toHaveBeenCalledWith('/api/settings/trial-consent', 'GET');
            expect(trialFetch).toHaveBeenCalledWith('/api/trial/elevenlabs/signed-url', { method: 'GET' });
            expect(provision).not.toHaveBeenCalled();
            expect(byoFetchSignedURL).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('no vault key + no trial flag → existing set-your-key error', async () => {
        const { window, trialFetch, cleanup } = cloudEnv({ hasKey: false, trialFlag: false });
        try {
            await expect(window.WGCallAgent.fetchSignedURL())
                .rejects.toThrow('Set your ElevenLabs API key in Settings → Integrations');
            expect(trialFetch).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('trial route 429 → distinct trial-limit message', async () => {
        const { window, cleanup } = cloudEnv({ hasKey: false, trialFlag: true, trialStatus: 429 });
        try {
            await expect(window.WGCallAgent.fetchSignedURL())
                .rejects.toThrow(/Trial limit reached/);
        } finally {
            cleanup();
        }
    });

    it('trial route 503 (flag/route mismatch) → degrades to the set-your-key error', async () => {
        const { window, cleanup } = cloudEnv({ hasKey: false, trialFlag: true, trialStatus: 503 });
        try {
            await expect(window.WGCallAgent.fetchSignedURL())
                .rejects.toThrow('Set your ElevenLabs API key in Settings → Integrations');
        } finally {
            cleanup();
        }
    });

    it('reverse-proxy 503 (non-JSON body) → generic error, not the set-your-key message', async () => {
        const { window, cleanup } = cloudEnv({ hasKey: false, trialFlag: true, trialStatus: 503, trialBody: '503 Service Unavailable' });
        try {
            await expect(window.WGCallAgent.fetchSignedURL())
                .rejects.toThrow('Failed to get signed URL (503)');
        } finally {
            cleanup();
        }
    });

    it('reverse-proxy 503 error carries no .status — startCall must not map it to "not configured"', async () => {
        // startCall() renders err.status === 503 as "Voice agent is not
        // configured on this server."; the trial generic-error path must not
        // feed that mapping during a backend restart behind Traefik.
        const { window, cleanup } = cloudEnv({ hasKey: false, trialFlag: true, trialStatus: 503, trialBody: '503 Service Unavailable' });
        try {
            const err = await window.WGCallAgent.fetchSignedURL().catch((e) => e);
            expect(err.message).toBe('Failed to get signed URL (503)');
            expect(err.status).toBeUndefined();
        } finally {
            cleanup();
        }
    });

    it('reverse-proxy 429 (non-JSON body) → generic error, not the trial-limit message', async () => {
        const { window, cleanup } = cloudEnv({ hasKey: false, trialFlag: true, trialStatus: 429, trialBody: '429 Too Many Requests' });
        try {
            await expect(window.WGCallAgent.fetchSignedURL())
                .rejects.toThrow('Failed to get signed URL (429)');
        } finally {
            cleanup();
        }
    });

    it('never-asked consent (all null) → trial_consent_required, trial route never hit', async () => {
        const { window, trialFetch, cleanup } = cloudEnv({ hasKey: false, trialFlag: true, consent: null });
        try {
            const err = await window.WGCallAgent.fetchSignedURL().catch((e) => e);
            expect(err.code).toBe('trial_consent_required');
            expect(err.scope).toBe('voice');
            expect(err.message).toMatch(/needs your consent/);
            expect(trialFetch).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('revoked consent (voice: false) → refused, trial route never hit', async () => {
        const { window, trialFetch, cleanup } = cloudEnv({ hasKey: false, trialFlag: true, consent: { ai: true, voice: false, tg: true } });
        try {
            await expect(window.WGCallAgent.fetchSignedURL())
                .rejects.toMatchObject({ code: 'trial_consent_required', scope: 'voice' });
            expect(trialFetch).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('ai consent alone does not permit trial voice (scope separation)', async () => {
        const { window, trialFetch, cleanup } = cloudEnv({ hasKey: false, trialFlag: true, consent: { ai: true, voice: null, tg: null } });
        try {
            await expect(window.WGCallAgent.fetchSignedURL())
                .rejects.toMatchObject({ code: 'trial_consent_required', scope: 'voice' });
            expect(trialFetch).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('no consent + prompt seam declines → no trial fetch, refusal error', async () => {
        const { window, trialFetch, cleanup } = cloudEnv({ hasKey: false, trialFlag: true, consent: null });
        try {
            const request = vi.fn(async () => false);
            window.TrialConsent = { request };
            await expect(window.WGCallAgent.fetchSignedURL())
                .rejects.toMatchObject({ code: 'trial_consent_required', scope: 'voice' });
            expect(request).toHaveBeenCalledWith('voice');
            expect(trialFetch).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('no consent + prompt seam allows → trial signed URL fetched', async () => {
        const { window, trialFetch, cleanup } = cloudEnv({ hasKey: false, trialFlag: true, consent: null });
        try {
            const request = vi.fn(async () => true);
            window.TrialConsent = { request };
            const url = await window.WGCallAgent.fetchSignedURL();
            expect(url).toBe('wss://trial.example/signed');
            expect(request).toHaveBeenCalledWith('voice');
            expect(trialFetch).toHaveBeenCalledWith('/api/trial/elevenlabs/signed-url', { method: 'GET' });
        } finally {
            cleanup();
        }
    });

    it('window.apiCall absent → gate refuses (consent unreadable is not consent)', async () => {
        const { window, trialFetch, cleanup } = cloudEnv({ hasKey: false, trialFlag: true });
        try {
            delete window.apiCall;
            await expect(window.WGCallAgent.fetchSignedURL())
                .rejects.toMatchObject({ code: 'trial_consent_required', scope: 'voice' });
            expect(trialFetch).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('startCall without consent surfaces the error state, no trial transmission', async () => {
        // createConversationEnv patches the SDK loader, so the rejection
        // reaching startCall's catch is deterministically the consent gate's.
        const { window, cleanup } = createConversationEnv();
        try {
            window.__MEDTRACKER_CLOUD__ = true;
            const meta = window.document.createElement('meta');
            meta.setAttribute('name', 'medtracker-trial-voice');
            meta.setAttribute('content', '1');
            window.document.head.appendChild(meta);
            window.CloudElevenLabs = { hasKey: vi.fn(async () => false), fetchSignedURL: vi.fn() };
            window.apiCall = vi.fn(async () => ({ ai: null, voice: null, tg: null }));
            // The default fetch stub throws on any URL, so a leaked trial
            // fetch would surface as a different error message here.
            const { card } = await startCall(window);
            expect(card.dataset.state).toBe('error');
            expect(window.WGCallAgent.getState().message).toMatch(/needs your consent/);
        } finally {
            cleanup();
        }
    });
});

describe('features/elevenlabs-call.js — voice LLM relay leg (cloud, bd med-h849.2)', () => {
    // window.CloudVoiceLLM is the apishim-published device leg: start() resolves
    // with the call token the agent's custom-LLM hop carries back to the relay.
    function relayEnv({ conv } = {}) {
        const order = [];
        const env = createConversationEnv({
            conv,
            setup: (window) => {
                window.CloudVoiceLLM = {
                    start: vi.fn(async () => { order.push('start'); return 'call-tok'; }),
                    stop: vi.fn(),
                    usesTrialAI: vi.fn(async () => false),
                };
                const mint = window.CloudElevenLabs.fetchSignedURL;
                window.CloudElevenLabs.fetchSignedURL = vi.fn(async (...a) => { order.push('mint'); return mint(...a); });
            },
        });
        return { ...env, order };
    }

    function bridgeTimers(window) {
        window.setTimeout = (...args) => globalThis.setTimeout(...args);
        window.clearTimeout = (...args) => globalThis.clearTimeout(...args);
    }

    it('opens the leg before minting the signed URL and passes the token as customLlmExtraBody.call', async () => {
        const { window, order, cleanup } = relayEnv();
        try {
            const { opts } = await startCall(window);
            expect(order).toEqual(['start', 'mint']);
            expect(opts.customLlmExtraBody).toEqual({ call: 'call-tok' });
            expect(window.CloudVoiceLLM.stop).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('stops the leg on hang-up', async () => {
        const { window, cleanup } = relayEnv();
        try {
            await startCall(window);
            await window.WGCallAgent.endCall();
            expect(window.CloudVoiceLLM.stop).toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('stops the leg on onDisconnect and on onError', async () => {
        const first = relayEnv();
        try {
            const { opts } = await startCall(first.window);
            opts.onDisconnect();
            expect(first.window.CloudVoiceLLM.stop).toHaveBeenCalledTimes(1);
        } finally {
            first.cleanup();
        }
        const second = relayEnv();
        try {
            const { opts } = await startCall(second.window);
            opts.onError(new Error('boom'));
            expect(second.window.CloudVoiceLLM.stop).toHaveBeenCalledTimes(1);
        } finally {
            second.cleanup();
        }
    });

    it('stops the leg on the connect timeout', async () => {
        vi.useFakeTimers();
        const { window, document, cleanup } = relayEnv({ conv: { then() { /* never settles */ } } });
        try {
            bridgeTimers(window);
            const card = window.WGCallAgent.mountCard(document.body);
            window.WGCallAgent.startCall(card);
            for (let i = 0; i < 30; i += 1) await Promise.resolve();
            expect(window.CloudVoiceLLM.stop).not.toHaveBeenCalled();
            vi.advanceTimersByTime(30000);
            expect(window.WGCallAgent.getState().state).toBe('error');
            expect(window.CloudVoiceLLM.stop).toHaveBeenCalledTimes(1);
        } finally {
            cleanup();
            vi.useRealTimers();
        }
    });

    // Until the agent is switched to the custom LLM (med-h849.3) it never uses
    // the leg, so a broken leg must not cost the user the call.
    it('a failed leg still starts the call, without customLlmExtraBody', async () => {
        const { window, cleanup } = relayEnv();
        try {
            window.console.warn = vi.fn();
            window.CloudVoiceLLM.start = vi.fn(async () => { throw new Error('voice relay sent no hello'); });
            const { opts } = await startCall(window);
            expect(window.WGCallAgent.getState().state).toBe('in_call');
            expect(window.CloudElevenLabs.fetchSignedURL).toHaveBeenCalled();
            expect(opts).not.toHaveProperty('customLlmExtraBody');
            expect(window.CloudVoiceLLM.stop).toHaveBeenCalledTimes(1);

            await window.WGCallAgent.endCall();
            expect(window.CloudVoiceLLM.stop).toHaveBeenCalledTimes(2);
        } finally {
            cleanup();
        }
    });

    it('trial AI behind a BYO ElevenLabs key asks for voice consent before opening the leg', async () => {
        const granted = relayEnv();
        try {
            granted.window.CloudVoiceLLM.usesTrialAI = vi.fn(async () => true);
            granted.window.apiCall = vi.fn(async () => ({ ai: null, voice: true, tg: null }));
            const { opts } = await startCall(granted.window);
            expect(granted.window.apiCall).toHaveBeenCalledWith('/api/settings/trial-consent', 'GET');
            expect(granted.window.CloudVoiceLLM.start).toHaveBeenCalledTimes(1);
            expect(opts.customLlmExtraBody).toEqual({ call: 'call-tok' });
        } finally {
            granted.cleanup();
        }

        // Declined: no leg, but the call itself still goes ahead.
        const declined = relayEnv();
        try {
            declined.window.console.warn = vi.fn();
            declined.window.CloudVoiceLLM.usesTrialAI = vi.fn(async () => true);
            declined.window.apiCall = vi.fn(async () => ({ ai: true, voice: null, tg: null }));
            const { opts } = await startCall(declined.window);
            expect(declined.window.CloudVoiceLLM.start).not.toHaveBeenCalled();
            expect(declined.window.WGCallAgent.getState().state).toBe('in_call');
            expect(opts).not.toHaveProperty('customLlmExtraBody');
        } finally {
            declined.cleanup();
        }
    });

    it('without the relay (bot mode) startSession gets no customLlmExtraBody', async () => {
        const { window, cleanup } = createConversationEnv();
        try {
            const { opts } = await startCall(window);
            expect(opts).not.toHaveProperty('customLlmExtraBody');
        } finally {
            cleanup();
        }
    });
});
