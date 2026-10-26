/**
 * @vitest-environment jsdom
 *
 * bd med-h849.2 — aiClient.chatStream, the voice LLM relay's provider call.
 * The ElevenLabs request body goes to the same provider chat() uses with
 * stream:true, and the provider's raw SSE text is forwarded unparsed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAIClient } from '../aiclient.js';

function settingsWith(openai, consent = {}) {
  return {
    readIntegrationsUnmasked: vi.fn().mockResolvedValue({ openai }),
    getTrialConsent: vi.fn().mockResolvedValue(consent),
  };
}

// A streaming Response stand-in: each string is one network read.
function streamResponse(parts, { signal } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => {
          if (signal && signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
          if (i < parts.length) return Promise.resolve({ done: false, value: enc.encode(parts[i++]) });
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    },
  };
}

const ELEVEN_BODY = {
  model: 'medtracker',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ type: 'function', function: { name: 'mcp_call' } }],
  stream: true,
  user_id: 'el-user',
  elevenlabs_extra_body: { call: 'tok' },
  temperature: 0.4,
};

const SSE = [
  'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
];

describe('aiClient.chatStream (bd med-h849.2)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    document.querySelector('meta[name="medtracker-trial-ai"]')?.remove();
  });

  it('BYO: forwards raw SSE chunks in order and forces the vault model', async () => {
    const client = createAIClient({ settingsDomain: settingsWith({ api_key: 'k', url: 'https://p.example.com/v1/', model: 'gpt-6-luna' }) });
    global.fetch.mockResolvedValueOnce(streamResponse(SSE));
    const chunks = [];
    await client.chatStream({ body: ELEVEN_BODY, onChunk: (c) => chunks.push(c) });

    expect(chunks).toEqual(SSE);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://p.example.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer k');
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe('gpt-6-luna');
    expect(sent.stream).toBe(true);
    expect(sent.reasoning_effort).toBe('none');
    expect(sent.temperature).toBe(0.4);
    expect(sent.messages).toEqual(ELEVEN_BODY.messages);
    expect(sent.tools).toEqual(ELEVEN_BODY.tools);
    expect(sent).not.toHaveProperty('elevenlabs_extra_body');
    expect(sent).not.toHaveProperty('user_id');
  });

  it('BYO: aborts the fetch on signal', async () => {
    const client = createAIClient({ settingsDomain: settingsWith({ api_key: 'k', url: 'https://p.example.com/v1', model: 'm' }) });
    const ctrl = new AbortController();
    global.fetch.mockImplementationOnce(async (_url, init) => streamResponse(SSE, { signal: init.signal }));
    const chunks = [];
    const p = client.chatStream({
      body: ELEVEN_BODY,
      signal: ctrl.signal,
      onChunk: (c) => { chunks.push(c); ctrl.abort(); },
    });
    await expect(p).rejects.toThrow(/aborted/);
    expect(global.fetch.mock.calls[0][1].signal).toBe(ctrl.signal);
    expect(chunks).toHaveLength(1);
  });

  it('BYO: non-2xx rejects with the provider message', async () => {
    const client = createAIClient({ settingsDomain: settingsWith({ api_key: 'k', url: 'https://p.example.com/v1', model: 'm' }) });
    global.fetch.mockResolvedValueOnce({ ok: false, status: 401, text: () => Promise.resolve('{"error":{"message":"bad key"}}') });
    await expect(client.chatStream({ body: ELEVEN_BODY, onChunk: () => {} })).rejects.toMatchObject({ message: 'bad key', status: 401 });
  });

  it('trial: hits the trial proxy with stream:true, no Authorization, no model', async () => {
    const meta = document.createElement('meta');
    meta.name = 'medtracker-trial-ai';
    meta.content = '1';
    document.head.appendChild(meta);
    const client = createAIClient({ settingsDomain: settingsWith({}, { voice: true }) });
    global.fetch.mockResolvedValueOnce(streamResponse(SSE));
    const chunks = [];
    await client.chatStream({ body: ELEVEN_BODY, onChunk: (c) => chunks.push(c) });

    expect(chunks.join('')).toBe(SSE.join(''));
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/trial/openai/chat/completions');
    expect(init.headers).not.toHaveProperty('Authorization');
    const sent = JSON.parse(init.body);
    expect(sent.stream).toBe(true);
    expect(sent).not.toHaveProperty('model');
    expect(sent).not.toHaveProperty('reasoning_effort');
  });

  // bd med-ku8r: an in-call photo arrives as an image_url part (data: or
  // https:) and must reach a vision-capable model untouched.
  const IMAGE_BODY = {
    ...ELEVEN_BODY,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/AA==' } },
      ],
    }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://files.example/x.jpg' } }] }],
  };

  it('BYO: an image turn goes to the vision triple with the image parts intact', async () => {
    const client = createAIClient({ settingsDomain: settingsWith({
      api_key: 'k', url: 'https://p.example.com/v1', model: 'text-m',
      vision_api_key: 'vk', vision_url: 'https://v.example.com/v1', vision_model: 'vision-m',
    }) });
    global.fetch.mockResolvedValueOnce(streamResponse(SSE));
    await client.chatStream({ body: IMAGE_BODY, onChunk: () => {} });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://v.example.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer vk');
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe('vision-m');
    expect(sent.messages).toEqual(IMAGE_BODY.messages);
  });

  it('BYO: the next text turn, photo still in history, goes back to the text triple', async () => {
    const client = createAIClient({ settingsDomain: settingsWith({
      api_key: 'k', url: 'https://p.example.com/v1', model: 'text-m',
      vision_api_key: 'vk', vision_url: 'https://v.example.com/v1', vision_model: 'vision-m',
    }) });
    global.fetch.mockResolvedValueOnce(streamResponse(SSE));
    const body = {
      ...IMAGE_BODY,
      messages: [...IMAGE_BODY.messages, { role: 'assistant', content: 'A cat.' }, { role: 'user', content: 'thanks' }],
    };
    await client.chatStream({ body, onChunk: () => {} });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://p.example.com/v1/chat/completions');
    expect(JSON.parse(init.body).model).toBe('text-m');
    // A text-only model never sees the photo: it is a text placeholder now.
    expect(init.body).not.toContain('image_url');
    expect(init.body).toContain('[photo shared earlier]');
  });

  it('trial: an image turn asks the proxy for the vision model', async () => {
    const meta = document.createElement('meta');
    meta.name = 'medtracker-trial-ai';
    meta.content = '1';
    document.head.appendChild(meta);
    const client = createAIClient({ settingsDomain: settingsWith({}, { voice: true }) });
    global.fetch.mockResolvedValueOnce(streamResponse(SSE));
    await client.chatStream({ body: IMAGE_BODY, onChunk: () => {} });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/trial/openai/chat/completions?vision=1');
    expect(JSON.parse(init.body).messages).toEqual(IMAGE_BODY.messages);
  });

  it('trial: refuses without voice consent, before any fetch', async () => {
    const meta = document.createElement('meta');
    meta.name = 'medtracker-trial-ai';
    meta.content = '1';
    document.head.appendChild(meta);
    const client = createAIClient({ settingsDomain: settingsWith({}, { tg: true }) });
    await expect(client.chatStream({ body: ELEVEN_BODY, onChunk: () => {} })).rejects.toMatchObject({ code: 'trial_consent_required', scope: 'voice' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('trial: maps the proxy error body', async () => {
    const meta = document.createElement('meta');
    meta.name = 'medtracker-trial-ai';
    meta.content = '1';
    document.head.appendChild(meta);
    const client = createAIClient({ settingsDomain: settingsWith({}, { voice: true }) });
    global.fetch.mockResolvedValueOnce({ ok: false, status: 429, text: () => Promise.resolve('{"error":"trial_rate_limit"}') });
    await expect(client.chatStream({ body: ELEVEN_BODY, onChunk: () => {} })).rejects.toMatchObject({ code: 'trial_rate_limit' });
  });
});
