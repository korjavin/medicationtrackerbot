/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAIClient, setTrialTransport } from '../aiclient.js';

// Real Response streams mirror the nonstreamed ChatCompletion envelope:
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
// Null content with finish_reason:length is valid at the eight-token budget.
const completion = (content = 'OK', finish_reason = 'stop') => ({
  id: 'fixture-completion', object: 'chat.completion', created: 1, model: 'fixture-model',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason }],
});
const response = (body = completion(), status = 200) => new Response(JSON.stringify(body), { status });
// Actual sanitized relay contract: trial_proxy.go:421 strips model, and
// trial_anthropic.go:fromAnthropicResponse also omits created. Neither field
// may be demanded from this trusted transport just to Check the trial key.
const trialCompletion = () => ({ id: 'fixture-trial', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
  usage: { prompt_tokens: 1, completion_tokens: 8, total_tokens: 9 } });
const policy = (origins = ['https://a.example', 'https://vision.example']) => ({
  origins: JSON.stringify(origins), origin: 'https://account.example',
});
const draft = (extra = {}) => ({ url: 'https://a.example/v1', model: 'model-a', api_key: 'fixture-draft-key', ...extra });

function clientWith(saved = {}, documentPolicy = policy(), consent = true) {
  const settingsDomain = {
    readIntegrationsUnmasked: vi.fn(async () => ({ openai: saved })),
    getTrialConsent: vi.fn(async () => ({ ai: consent, anon: consent })),
  };
  return { client: createAIClient({ settingsDomain, documentPolicy }), settingsDomain };
}

describe('Check key: loaded-document permission and scoped credential intent', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => response()));
    document.head.innerHTML = '';
  });
  afterEach(() => { setTrialTransport(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('makes one tiny direct completion, with only the chosen key in Authorization', async () => {
    const { client } = clientWith();
    expect(await client.checkKey({ intent: 'draft', draft: draft() })).toMatchObject({ state: 'success', message: 'Key works' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://a.example/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer fixture-draft-key');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body)).toEqual({ model: 'model-a', messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 8 });
    expect(init.body + url).not.toContain('fixture-draft-key');
  });

  it.each([null, { origins: 'bad' }, { origins: '{}' }, policy(['wss://a.example']), policy(['https://*.example'])])(
    'fails closed for unknown/malformed capability without reading or transmitting a saved key: %j', async (capability) => {
      const { client, settingsDomain } = clientWith({ api_key: 'fixture-saved' }, capability);
      const result = await client.checkKey({ intent: 'saved', draft: draft({ api_key: '***' }) });
      expect(result).toMatchObject({ state: 'unsupported', code: 'capability' });
      expect(settingsDomain.readIntegrationsUnmasked).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each(['http://a.example/v1', 'https://name:password@a.example/v1', 'https://a.example:8443/v1',
    'https://[::1]/v1', 'https://bad_host.example/v1', 'https://a.example./v1', '/v1'])('refuses unsupported URL %s before a request', async (url) => {
    const { client } = clientWith();
    expect(await client.checkKey({ intent: 'draft', draft: draft({ url }) })).toMatchObject({ state: 'unsupported', code: 'url' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses THIS document snapshot, not saved B, another tab, or mutation of the supplied policy', async () => {
    const cap = policy(['https://a.example']);
    const saved = { url: 'https://b.example/v1', api_key: 'fixture-saved-b' };
    const { client: tabA } = clientWith(saved, cap);
    const { client: tabB } = clientWith(saved, policy(['https://b.example']));
    cap.origins = JSON.stringify(['https://b.example']);
    const args = { intent: 'saved', draft: draft({ url: saved.url, api_key: '***' }) };
    expect(await tabA.checkKey(args)).toMatchObject({ state: 'needs_reload' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await tabB.checkKey(args)).toMatchObject({ state: 'success' });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-saved-b');
  });

  it('resolves self and fixed HTTPS origins, never converts a WebSocket policy into HTTPS reach', async () => {
    const { client } = clientWith({}, policy(['https://api.elevenlabs.io']));
    await client.checkKey({ intent: 'draft', draft: draft({ url: 'https://account.example/provider' }) });
    await client.checkKey({ intent: 'draft', draft: draft({ url: 'https://api.elevenlabs.io/v1' }) });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(client.keyCheckPermission({ draft: draft(), intent: 'draft' })).toMatchObject({ state: 'needs_reload' });
  });

  it('uses a rotated raw draft key instead of the saved key; typed own key never uses Trial', async () => {
    document.head.innerHTML = '<meta name="medtracker-trial-ai" content="1">';
    const { client, settingsDomain } = clientWith({ api_key: 'fixture-old', url: 'https://a.example/v1' });
    expect(await client.checkKey({ intent: 'trial', draft: draft() })).toMatchObject({ message: 'Key works' });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-draft-key');
    expect(settingsDomain.readIntegrationsUnmasked).not.toHaveBeenCalled();
    expect(settingsDomain.getTrialConsent).not.toHaveBeenCalled();
  });

  it('only preserves a real saved mask at the same normalized BASE, not another path on its origin', async () => {
    const { client } = clientWith({ api_key: 'fixture-saved', url: ' https://a.example/v1/ ' });
    expect(await client.checkKey({ intent: 'saved', draft: draft({ api_key: '***', url: 'https://a.example/v1//' }) })).toMatchObject({ state: 'success' });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-saved');
    expect(await client.checkKey({ intent: 'saved', draft: draft({ api_key: '***', url: 'https://a.example/another' }) })).toMatchObject({ code: 'key' });
    expect(await client.checkKey({ intent: 'draft', draft: draft({ api_key: '***' }) })).toMatchObject({ code: 'key' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('empty is not implicit saved-key reuse and fabricated masks do not establish presence', async () => {
    const { client } = clientWith({ api_key: 'fixture-saved', url: 'https://a.example/v1' });
    expect(await client.checkKey({ intent: 'saved', draft: draft({ api_key: '' }) })).toMatchObject({ code: 'key' });
    const empty = clientWith({ url: 'https://a.example/v1' }).client;
    expect(await empty.checkKey({ intent: 'saved', draft: draft({ api_key: '***' }) })).toMatchObject({ code: 'key' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('matches independent vision URL/model/key inheritance without borrowing the wrong secret slot', async () => {
    const saved = { api_key: 'fixture-main', url: 'https://a.example/v1', model: 'main-model',
      vision_api_key: 'fixture-photo', vision_url: 'https://vision.example/custom', vision_model: 'photo-model' };
    const { client } = clientWith(saved);
    const photoDraft = { ...saved, api_key: '***', vision_api_key: '***' };
    await client.checkKey({ scope: 'vision', intent: 'saved', draft: photoDraft });
    expect(fetch.mock.calls[0][0]).toBe('https://vision.example/custom/chat/completions');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-photo');
    expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe('photo-model');
    // A mask in the main field cannot stand in for a different saved photo key.
    expect(await client.checkKey({ scope: 'vision', intent: 'saved', draft: { ...photoDraft, vision_api_key: '' } })).toMatchObject({ code: 'key' });
    const inherited = clientWith({ ...saved, vision_api_key: '', vision_url: '', vision_model: '' }).client;
    await inherited.checkKey({ scope: 'vision', intent: 'saved', draft: draft({ api_key: '***' }) });
    expect(fetch.mock.calls[1][0]).toBe('https://a.example/v1/chat/completions');
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer fixture-main');
  });

  it('only explicit available/consented Trial sends the existing trial request', async () => {
    document.head.innerHTML = '<meta name="medtracker-trial-ai" content="1">';
    const { client } = clientWith({}, policy([]));
    const args = { intent: 'trial', draft: draft({ api_key: '' }) };
    fetch.mockResolvedValueOnce(response(trialCompletion()));
    expect(await client.checkKey(args)).toMatchObject({ state: 'success', message: 'Trial key works' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/trial/openai/chat/completions');
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).not.toHaveProperty('model');
    const denied = clientWith({}, policy([]), false).client;
    expect(await denied.checkKey(args)).toMatchObject({ code: 'trial_consent_required' });
    document.head.innerHTML = '';
    expect(await client.checkKey(args)).toMatchObject({ code: 'trial_unavailable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses existing native trial transport and anon consent only on explicit Trial', async () => {
    const post = vi.fn(async () => response(trialCompletion()));
    setTrialTransport({ post });
    const { client, settingsDomain } = clientWith({}, policy([]));
    expect(await client.checkKey({ scope: 'vision', intent: 'trial', draft: { api_key: '' } })).toMatchObject({ message: 'Trial key works' });
    expect(post.mock.calls[0][0]).toBe('/api/trial/openai/chat/completions?vision=1');
    expect(settingsDomain.getTrialConsent).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[401, 'rejected'], [403, 'rejected'], [404, 'model'], [429, 'rate_limit'], [400, 'request'], [500, 'provider']])(
    'maps HTTP %i without reading or echoing a hostile body', async (status, code) => {
      const text = vi.fn(async () => 'Bearer fixture-draft-key');
      fetch.mockResolvedValue({ status, text });
      const { client } = clientWith();
      const result = await client.checkKey({ intent: 'draft', draft: draft() });
      expect(result).toMatchObject({ state: 'error', code });
      expect(JSON.stringify(result)).not.toContain('fixture-draft-key');
      expect(text).not.toHaveBeenCalled();
    }
  );

  it('accepts a valid length-limited empty completion, but not arbitrary 200 JSON/HTML or oversized data', async () => {
    const { client } = clientWith();
    fetch.mockResolvedValueOnce(response(completion(null, 'length')));
    expect(await client.checkKey({ intent: 'draft', draft: draft() })).toMatchObject({ state: 'success' });
    for (const body of [{ error: { message: 'fixture-draft-key' } }, { choices: [] },
      { choices: [{ message: { content: null }, finish_reason: 'length' }] },
      trialCompletion(),
      { ...completion(), object: 'not-a-completion' }, { ...completion(), created: 'yesterday' },
      { ...completion(), choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] },
      { ...completion(), choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'anything' }] },
      { ...completion(), choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'length' }] },
      'not a completion', { padding: 'x'.repeat(70 << 10) }]) {
      fetch.mockResolvedValueOnce(response(body));
      const result = await client.checkKey({ intent: 'draft', draft: draft() });
      expect(result).toMatchObject({ state: 'error', code: 'response' });
      expect(JSON.stringify(result)).not.toContain('fixture-draft-key');
    }
  });

  it('sanitizes an actual fetch rejection and leaves old AI/listModels working without new metadata', async () => {
    const { client } = clientWith();
    fetch.mockRejectedValueOnce(new Error('Bearer fixture-draft-key'));
    expect(await client.checkKey({ intent: 'draft', draft: draft() })).toMatchObject({ code: 'unreachable' });
    const old = clientWith({ api_key: 'fixture-saved', url: 'https://a.example/v1', model: 'model-a' }, null).client;
    fetch.mockResolvedValueOnce(response(completion()));
    expect(await old.chat({ messages: [{ role: 'user', content: 'hello' }], tools: [] })).toMatchObject({ content: 'OK' });
    fetch.mockResolvedValueOnce(response({ data: [{ id: 'model-a' }] }));
    expect(await old.listModels()).toMatchObject({ models: ['model-a'] });
  });
});
