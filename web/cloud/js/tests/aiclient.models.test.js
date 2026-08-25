/**
 * @vitest-environment jsdom
 *
 * bd med-byom — aiClient.listModels is the BYO model-id discovery call behind
 * the Settings model combobox. It is a fetch-boundary unit (the sibling of
 * fooddb.test.js): the things worth pinning are the wire shape and the
 * failure behaviour, both of which are security properties here —
 *
 *   - the key travels in the Authorization header and NOWHERE else (not the
 *     URL, not an error message the UI renders),
 *   - referrerPolicy: 'no-referrer' keeps the account subdomain out of the
 *     provider's Referer log,
 *   - only the standard OpenAI {data:[{id}]} shape is read; anything else is
 *     "no list", so the field degrades to plain free text,
 *   - the cache is in memory, keyed so a changed URL or key invalidates it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAIClient, parseModelList, keyFingerprint } from '../aiclient.js';

function settingsWith(openai) {
  return { readIntegrationsUnmasked: vi.fn().mockResolvedValue({ openai }) };
}

function modelsResponse(body, ok = true, status = 200) {
  return { ok, status, text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)) };
}

describe('aiClient.listModels (bd med-byom)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('GETs {base}/models with the key in the Authorization header only, and no referrer', async () => {
    const client = createAIClient({
      settingsDomain: settingsWith({ api_key: 'sk-secret-key-123', url: 'https://proxy.example.com/v1', model: 'x' }),
    });
    global.fetch.mockResolvedValueOnce(modelsResponse({ data: [{ id: 'gpt-4o' }] }));

    const { models } = await client.listModels({ scope: 'text' });

    expect(models).toEqual(['gpt-4o']);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://proxy.example.com/v1/models');
    expect(url).not.toContain('sk-secret-key-123');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer sk-secret-key-123');
    expect(opts.referrerPolicy).toBe('no-referrer');
    expect(opts.signal).toBeTruthy();
  });

  it('dedupes, sorts and caps the ids, ignoring non-string entries', async () => {
    const client = createAIClient({
      settingsDomain: settingsWith({ api_key: 'k', url: 'https://p.example.com/v1' }),
    });
    const data = [{ id: 'zeta' }, { id: 'alpha' }, { id: 'alpha' }, { id: 42 }, {}, null, { id: '  beta  ' }];
    global.fetch.mockResolvedValueOnce(modelsResponse({ data }));

    const { models } = await client.listModels({});
    expect(models).toEqual(['alpha', 'beta', 'zeta']);

    // The 200-id cap keeps a pathological provider from stuffing the datalist.
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `m${String(i).padStart(4, '0')}` }));
    expect(parseModelList(JSON.stringify({ data: many }))).toHaveLength(200);
  });

  it('reads only the OpenAI data[].id shape — anything else is no list', () => {
    expect(parseModelList('not json')).toBeNull();
    expect(parseModelList(JSON.stringify({ models: ['a'] }))).toBeNull();
    expect(parseModelList(JSON.stringify({ data: 'nope' }))).toBeNull();
    expect(parseModelList(JSON.stringify({ data: [] }))).toEqual([]);
    // Oversized bodies are rejected before JSON.parse touches them.
    expect(parseModelList(`{"data":[{"id":"${'x'.repeat(2 << 20)}"}]}`)).toBeNull();
  });

  it('reports a rejected fetch (CSP block / CORS / offline) as an unreachable-provider hint, not a raw error', async () => {
    const client = createAIClient({
      settingsDomain: settingsWith({ api_key: 'sk-secret-key-123', url: 'https://blocked.example.com/v1' }),
    });
    global.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(client.listModels({})).rejects.toMatchObject({ code: 'unreachable' });
    // The CSP case is the common one right after a provider save, so the copy
    // must point at the reload rather than read as a provider fault.
    await expect(client.listModels({})).rejects.toThrow(/reload the app/i);
  });

  it('never puts the key or the response body into the error the user sees', async () => {
    const client = createAIClient({
      settingsDomain: settingsWith({ api_key: 'sk-secret-key-123', url: 'https://p.example.com/v1' }),
    });
    // A proxy that echoes the request headers back in its error payload is
    // exactly why the body is not read into the message.
    global.fetch.mockResolvedValue(
      modelsResponse({ error: { message: 'bad key Bearer sk-secret-key-123' } }, false, 401)
    );

    await expect(client.listModels({})).rejects.toMatchObject({ code: 'http' });
    const err = await client.listModels({}).catch((e) => e);
    expect(err.message).not.toContain('sk-secret-key-123');
  });

  it('refuses without a saved key instead of fetching', async () => {
    const client = createAIClient({ settingsDomain: settingsWith({ api_key: '', url: 'https://p.example.com/v1' }) });
    await expect(client.listModels({})).rejects.toMatchObject({ code: 'no_key' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('serves the second call from the in-memory cache; refresh bypasses it', async () => {
    const client = createAIClient({ settingsDomain: settingsWith({ api_key: 'k', url: 'https://p.example.com/v1' }) });
    global.fetch.mockResolvedValue(modelsResponse({ data: [{ id: 'a' }] }));

    const first = await client.listModels({});
    expect(first.cached).toBe(false);
    const second = await client.listModels({});
    expect(second.cached).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const refreshed = await client.listModels({ refresh: true });
    expect(refreshed.cached).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cache when the saved key changes under the same URL', async () => {
    const openai = { api_key: 'key-one', url: 'https://p.example.com/v1' };
    const settingsDomain = { readIntegrationsUnmasked: vi.fn(async () => ({ openai })) };
    const client = createAIClient({ settingsDomain });
    global.fetch.mockResolvedValue(modelsResponse({ data: [{ id: 'a' }] }));

    await client.listModels({});
    openai.api_key = 'key-two';
    const after = await client.listModels({});

    expect(after.cached).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    // The fingerprint is what does it — and it keeps no key material.
    expect(keyFingerprint('key-one')).not.toBe(keyFingerprint('key-two'));
    expect(keyFingerprint('key-one')).not.toContain('key-one');
  });

  it('uses the vision overrides for the vision list, falling back to the text creds', async () => {
    const client = createAIClient({
      settingsDomain: settingsWith({
        api_key: 'text-key',
        url: 'https://text.example.com/v1',
        vision_api_key: 'vision-key',
        vision_url: 'https://vision.example.com/v1',
      }),
    });
    global.fetch.mockResolvedValue(modelsResponse({ data: [{ id: 'a' }] }));

    await client.listModels({ scope: 'vision' });
    expect(global.fetch.mock.calls[0][0]).toBe('https://vision.example.com/v1/models');
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer vision-key');

    // Independent cache entries: the text list is a separate fetch, not the
    // vision one replayed.
    await client.listModels({ scope: 'text' });
    expect(global.fetch.mock.calls[1][0]).toBe('https://text.example.com/v1/models');
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer text-key');
  });

  it('falls back to the text creds for vision when no override is set', async () => {
    const client = createAIClient({
      settingsDomain: settingsWith({ api_key: 'text-key', url: 'https://text.example.com/v1' }),
    });
    global.fetch.mockResolvedValue(modelsResponse({ data: [{ id: 'a' }] }));

    await client.listModels({ scope: 'vision' });
    expect(global.fetch.mock.calls[0][0]).toBe('https://text.example.com/v1/models');
  });
});
