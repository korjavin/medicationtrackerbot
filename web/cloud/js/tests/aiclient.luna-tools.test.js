/**
 * @vitest-environment jsdom
 *
 * bd med-ibvc — aiClient.chat pins the luna tool-calling wire shape.
 * gpt-6-luna answers 400 to function tools at its default reasoning effort
 * (live-API verified), so BYO tool calls against a luna model carry
 * reasoning_effort 'none'. Non-luna models and tool-less calls never get
 * the knob (other providers 400 unknown parameters), and trial-mode calls
 * leave it to the proxy, which alone knows the forced model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAIClient } from '../aiclient.js';

function settingsWith(openai, consent = {}) {
  return {
    readIntegrationsUnmasked: vi.fn().mockResolvedValue({ openai }),
    getTrialConsent: vi.fn().mockResolvedValue(consent),
  };
}

function rawResponse(message) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ choices: [{ message }] })),
  };
}

const TOOLS = [{ type: 'function', function: { name: 'calc' } }];
const MESSAGES = [{ role: 'user', content: 'hi' }];

describe('aiClient.chat luna tool-calling (bd med-ibvc)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    document.querySelector('meta[name="medtracker-trial-ai"]')?.remove();
  });

  async function chatBody(openai, args) {
    const client = createAIClient({ settingsDomain: settingsWith(openai) });
    global.fetch.mockResolvedValueOnce(rawResponse({ content: 'hi' }));
    await client.chat({ messages: MESSAGES, ...args });
    return JSON.parse(global.fetch.mock.calls[0][1].body);
  }

  it('sets reasoning_effort none for BYO tool calls on gpt-6-luna', async () => {
    const body = await chatBody(
      { api_key: 'k', url: 'https://p.example.com/v1', model: 'gpt-6-luna' },
      { tools: TOOLS },
    );
    expect(body.tools).toEqual(TOOLS);
    expect(body.tool_choice).toBe('auto');
    expect(body.reasoning_effort).toBe('none');
  });

  it('covers dated luna variants', async () => {
    const body = await chatBody(
      { api_key: 'k', url: 'https://p.example.com/v1', model: 'gpt-6-luna-2026-01-01' },
      { tools: TOOLS },
    );
    expect(body.reasoning_effort).toBe('none');
  });

  it('uses the new default model when none is saved', async () => {
    const body = await chatBody(
      { api_key: 'k', url: 'https://p.example.com/v1' },
      { tools: TOOLS },
    );
    expect(body.model).toBe('gpt-6-luna');
    expect(body.reasoning_effort).toBe('none');
  });

  it('leaves non-luna tool calls untouched', async () => {
    const body = await chatBody(
      { api_key: 'k', url: 'https://p.example.com/v1', model: 'gpt-4o-mini' },
      { tools: TOOLS },
    );
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('leaves tool-less luna calls untouched', async () => {
    const body = await chatBody(
      { api_key: 'k', url: 'https://p.example.com/v1', model: 'gpt-6-luna' },
      {},
    );
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('leaves trial-mode tool calls to the proxy', async () => {
    const meta = document.createElement('meta');
    meta.name = 'medtracker-trial-ai';
    meta.content = '1';
    document.head.appendChild(meta);
    const client = createAIClient({
      settingsDomain: settingsWith({}, { tg: true }),
    });
    global.fetch.mockResolvedValueOnce(rawResponse({ content: 'hi' }));
    await client.chat({ messages: MESSAGES, tools: TOOLS });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/trial/openai/chat/completions');
    const body = JSON.parse(opts.body);
    expect(body.model).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });
});
