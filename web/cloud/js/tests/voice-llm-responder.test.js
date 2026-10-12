/**
 * bd med-h849.2 — the voice LLM relay's device leg, against the frame protocol
 * in internal/cloudserver/voice_llm_relay.go.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVoiceLLMResponder, STATUS_UNKNOWN_CALL } from '../voice-llm-responder.js';

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.OPEN;
    this.sent = [];
    FakeSocket.instances.push(this);
  }

  send(data) { this.sent.push(JSON.parse(data)); }

  close() { this.readyState = 3; }

  recv(frame) { this.onmessage({ data: JSON.stringify(frame) }); }

  fireClose(code = 1006) { this.readyState = 3; this.onclose({ code }); }
}
FakeSocket.instances = [];
FakeSocket.OPEN = 1;

const URL_BASE = 'wss://acct.test/api/voice-llm/device';
const drain = async (n = 10) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };

function makeResponder(chatStream) {
  FakeSocket.instances = [];
  const aiClient = { chatStream: vi.fn(chatStream) };
  return { aiClient, responder: createVoiceLLMResponder({ aiClient, url: URL_BASE }) };
}

describe('voice-llm-responder (bd med-h849.2)', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('start() resolves with the hello token', async () => {
    const { responder } = makeResponder(async () => {});
    const p = responder.start();
    const [sock] = FakeSocket.instances;
    expect(sock.url).toBe(URL_BASE);
    sock.recv({ type: 'hello', call: 'tok-1' });
    await expect(p).resolves.toBe('tok-1');
    responder.stop();
  });

  it('serves a request as chunk frames then end, with the raw SSE data', async () => {
    const { aiClient, responder } = makeResponder(async ({ onChunk }) => {
      onChunk('data: {"a":1}\n\n');
      onChunk('data: [DONE]\n\n');
    });
    const p = responder.start();
    const [sock] = FakeSocket.instances;
    sock.recv({ type: 'hello', call: 'tok' });
    await p;
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    sock.recv({ id: 7, type: 'request', body });
    await drain();
    expect(aiClient.chatStream.mock.calls[0][0].body).toEqual(body);
    expect(sock.sent).toEqual([
      { id: 7, type: 'chunk', data: 'data: {"a":1}\n\n' },
      { id: 7, type: 'chunk', data: 'data: [DONE]\n\n' },
      { id: 7, type: 'end' },
    ]);
    expect(console.debug).toHaveBeenCalledWith('[voice-llm] turn', expect.objectContaining({ id: 7, outcome: 'ok' }));
    responder.stop();
  });

  it('accepts a request frame that arrives before hello (re-attach race)', async () => {
    const { responder } = makeResponder(async ({ onChunk }) => { onChunk('x'); });
    const p = responder.start();
    const [sock] = FakeSocket.instances;
    sock.recv({ id: 1, type: 'request', body: {} });
    sock.recv({ type: 'hello', call: 'tok' });
    await p;
    await drain();
    expect(sock.sent).toEqual([{ id: 1, type: 'chunk', data: 'x' }, { id: 1, type: 'end' }]);
    responder.stop();
  });

  it('a provider failure becomes an error frame', async () => {
    const { responder } = makeResponder(async () => { throw new Error('boom'); });
    const p = responder.start();
    const [sock] = FakeSocket.instances;
    sock.recv({ type: 'hello', call: 'tok' });
    await p;
    sock.recv({ id: 2, type: 'request', body: {} });
    await drain();
    expect(sock.sent).toEqual([{ id: 2, type: 'error', message: 'boom' }]);
    responder.stop();
  });

  // bd med-h849.11: a transient failure before any chunk is retried once.
  const status503 = () => Object.assign(new Error('API returned status code 503'), { status: 503 });
  async function startedWith(chatStream) {
    const made = makeResponder(chatStream);
    const p = made.responder.start();
    const [sock] = FakeSocket.instances;
    sock.recv({ type: 'hello', call: 'tok' });
    await p;
    return { ...made, sock };
  }

  it('retries a 503 before any chunk once, and the turn ends ok', async () => {
    let calls = 0;
    const { aiClient, responder, sock } = await startedWith(async ({ onChunk }) => {
      calls += 1;
      if (calls === 1) throw status503();
      onChunk('data: [DONE]\n\n');
    });
    sock.recv({ id: 4, type: 'request', body: {} });
    await drain();
    expect(aiClient.chatStream).toHaveBeenCalledTimes(2);
    expect(sock.sent).toEqual([{ id: 4, type: 'chunk', data: 'data: [DONE]\n\n' }, { id: 4, type: 'end' }]);
    responder.stop();
  });

  it('does not retry once a chunk was sent, nor a second failure', async () => {
    const { aiClient, responder, sock } = await startedWith(async ({ onChunk }) => {
      onChunk('data: {}\n\n');
      throw status503();
    });
    sock.recv({ id: 5, type: 'request', body: {} });
    await drain();
    expect(aiClient.chatStream).toHaveBeenCalledTimes(1);
    expect(sock.sent.at(-1)).toEqual({ id: 5, type: 'error', message: 'API returned status code 503' });

    aiClient.chatStream.mockImplementation(async () => { throw status503(); });
    sock.sent = [];
    sock.recv({ id: 6, type: 'request', body: {} });
    await drain();
    expect(aiClient.chatStream).toHaveBeenCalledTimes(3);
    expect(sock.sent).toEqual([{ id: 6, type: 'error', message: 'API returned status code 503' }]);
    responder.stop();
  });

  it('does not retry an aborted turn', async () => {
    const { aiClient, responder, sock } = await startedWith(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(status503()));
    }));
    sock.recv({ id: 8, type: 'request', body: {} });
    await drain();
    sock.recv({ id: 8, type: 'cancel' });
    await drain();
    expect(aiClient.chatStream).toHaveBeenCalledTimes(1);
    expect(sock.sent).toEqual([]);
    responder.stop();
  });

  it('cancel aborts that turn and sends nothing more for it', async () => {
    let signal;
    const { responder } = makeResponder(({ signal: s }) => {
      signal = s;
      return new Promise((_, reject) => s.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const p = responder.start();
    const [sock] = FakeSocket.instances;
    sock.recv({ type: 'hello', call: 'tok' });
    await p;
    sock.recv({ id: 3, type: 'request', body: {} });
    await drain();
    sock.recv({ id: 3, type: 'cancel' });
    await drain();
    expect(signal.aborted).toBe(true);
    expect(sock.sent).toEqual([]);
    responder.stop();
  });

  it('socket close mid-call reconnects with ?call=<token>; stop() prevents further reconnects', async () => {
    vi.useFakeTimers();
    const { responder } = makeResponder(async () => {});
    const p = responder.start();
    const [first] = FakeSocket.instances;
    first.recv({ type: 'hello', call: 'tok/+=' });
    await p;

    first.fireClose(1006);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1].url).toBe(`${URL_BASE}?call=${encodeURIComponent('tok/+=')}`);

    FakeSocket.instances[1].fireClose(1006);
    responder.stop();
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('4404 on a redial ends the call instead of looping', async () => {
    vi.useFakeTimers();
    const { responder } = makeResponder(async () => {});
    const p = responder.start();
    FakeSocket.instances[0].recv({ type: 'hello', call: 'tok' });
    await p;
    FakeSocket.instances[0].fireClose(1006);
    vi.advanceTimersByTime(1000);
    FakeSocket.instances[1].fireClose(STATUS_UNKNOWN_CALL);
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('start() rejects and closes the leg when no hello arrives in time', async () => {
    vi.useFakeTimers();
    const { responder } = makeResponder(async () => {});
    const p = responder.start();
    const caught = p.catch((e) => e);
    vi.advanceTimersByTime(5000);
    expect((await caught).message).toMatch(/no hello/);
    expect(FakeSocket.instances[0].readyState).toBe(3);
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('start() rejects when the leg closes before hello, and when stop() runs first', async () => {
    const { responder } = makeResponder(async () => {});
    const p1 = responder.start();
    FakeSocket.instances[0].fireClose(1006);
    await expect(p1).rejects.toThrow(/before hello/);

    const p2 = responder.start();
    responder.stop();
    await expect(p2).rejects.toThrow(/stopped/);
  });
});
