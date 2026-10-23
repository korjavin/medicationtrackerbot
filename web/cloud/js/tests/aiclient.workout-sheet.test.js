/**
 * @vitest-environment jsdom
 *
 * bd med-qj4.9 — aiClient.parseWorkoutSheetImage is the sheet-photo sibling
 * of parseMealFromImage: a fetch-boundary unit (same pattern as
 * aiclient.models.test.js). The provider HTTP call never touches the shim —
 * it goes straight from the browser to the user's own OpenAI(-compatible)
 * endpoint — so this suite fakes the provider at the `fetch` boundary and
 * pins the wire shape: vision URL, key in the Authorization header only,
 * the sheet prompt + JSON schema, the plan hint, and the fenced retry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAIClient, isResponseFormatUnsupported } from '../aiclient.js';

function settingsWith(openai) {
  return {
    readIntegrationsUnmasked: vi.fn().mockResolvedValue({ openai }),
    getTrialConsent: vi.fn().mockResolvedValue({}),
  };
}

function chatResponse(payload) {
  const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content } }] })),
  };
}

function photoFile() {
  return new File([new Blob([new Uint8Array([1, 2, 3, 4])])], 'sheet.jpg', { type: 'image/jpeg' });
}

const PLAN = { groupId: 5, unit: 'kg', days: [{ variant: { id: 21, name: 'Push day' }, exercises: [{ id: 1, exercise_name: 'Bench press' }] }] };

describe('aiClient.parseWorkoutSheetImage (bd med-qj4.9)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POSTs the vision endpoint with the sheet schema, plan hint, and image', async () => {
    const client = createAIClient({
      settingsDomain: settingsWith({ vision_api_key: '[REDACTED]', vision_url: 'https://vision.example.test/v1', vision_model: 'sheet-reader' }),
    });
    global.fetch.mockResolvedValueOnce(chatResponse({ items: [{ exercise: 'Bench press', set_index: 1, reps: 8 }] }));

    const parsed = await client.parseWorkoutSheetImage(photoFile(), PLAN);

    expect(parsed).toEqual({ items: [{ exercise: 'Bench press', set_index: 1, reps: 8 }] });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://vision.example.test/v1/chat/completions');
    expect(url).not.toContain('[REDACTED]');
    expect(opts.headers.Authorization).toBe('Bearer [REDACTED]');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('sheet-reader');
    expect(body.response_format.json_schema.name).toBe('workout_sheet');
    expect(body.messages[0].content).toContain('hand-filled workout sheet');
    const userText = body.messages[1].content[0].text;
    expect(userText).toContain('Bench press');
    expect(body.messages[1].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('a response_format rejection retries once with the fenced prompt', async () => {
    const client = createAIClient({
      settingsDomain: settingsWith({ vision_api_key: 'k', vision_url: 'https://p.example.com/v1' }),
    });
    global.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({ error: { message: 'unsupported response_format' } })),
      })
      .mockResolvedValueOnce(chatResponse({ items: [] }));

    const parsed = await client.parseWorkoutSheetImage(photoFile(), PLAN);

    expect(parsed).toEqual({ items: [] });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(retryBody.response_format).toBeUndefined();
    expect(retryBody.messages[0].content).toContain('Return only valid JSON');
  });

  it('rejects non-images before any fetch', async () => {
    const client = createAIClient({
      settingsDomain: settingsWith({ vision_api_key: 'k', vision_url: 'https://p.example.com/v1' }),
    });
    const bad = new File([new Blob(['x'])], 'sheet.txt', { type: 'text/plain' });
    await expect(client.parseWorkoutSheetImage(bad, PLAN)).rejects.toMatchObject({ code: 'invalid_image' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws no_api_key when no vision key and no trial is available', async () => {
    const client = createAIClient({
      settingsDomain: settingsWith({}),
    });
    await expect(client.parseWorkoutSheetImage(photoFile(), PLAN)).rejects.toMatchObject({ code: 'no_api_key' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// bd med-kl85 — the shared strict→fenced helper remembers an explicit
// "unsupported" rejection per scope in the injected device store.
describe('aiClient json_schema memory (bd med-kl85)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    document.querySelectorAll('meta[name="medtracker-trial-ai"]').forEach((m) => m.remove());
  });

  function rejection(message, status = 400) {
    return { ok: false, status, text: () => Promise.resolve(JSON.stringify({ error: { message } })) };
  }

  function memStore() {
    const m = new Map();
    return {
      m,
      get: vi.fn(async (k) => (m.has(k) ? m.get(k) : null)),
      set: vi.fn(async (k, v) => { m.set(k, v); }),
    };
  }

  // Mutable saved settings, so a test can "save" a new provider mid-flight.
  function liveSettings(openai) {
    const saved = { openai };
    return {
      saved,
      readIntegrationsUnmasked: vi.fn(async () => ({ openai: { ...saved.openai } })),
      getTrialConsent: vi.fn(async () => ({ ai: true })),
    };
  }

  const A = { vision_api_key: 'k', vision_url: 'https://a.example.test/v1', vision_model: 'model-a' };
  const B = { vision_api_key: 'k', vision_url: 'https://a.example.test/v1', vision_model: 'model-b' };
  const sentBody = (i) => JSON.parse(global.fetch.mock.calls[i][1].body);

  it('pins the persist predicate: capability messages only, never schema contents', () => {
    const asErr = (message) => Object.assign(new Error(message), { apiError: true });
    for (const msg of [
      'This model does not support response_format',
      'response_format json_schema is not supported',
      'unsupported response_format type',
      'model does not support response_format',
      'json_schema not supported',
      "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.",
    ]) expect(isResponseFormatUnsupported(asErr(msg)), msg).toBe(true);
    for (const msg of [
      "Invalid schema for response_format: unsupported keyword 'minLength'",
      "Invalid schema for response_format 'parsed_meal': In context=(), 'additionalProperties' is required to be supplied and to be false",
      "Unsupported value: 'temperature' does not support 0.2 with this model when response_format is set",
      'Trial model rejected response_format',
      'response_format json_schema: unsupported constraint minLength',
      'response_format json_schema minLength is not supported',
      'response_format is not supported for minLength',
      'This model does not support json_schema minLength',
      'unsupported response_format pattern',
    ]) expect(isResponseFormatUnsupported(asErr(msg)), msg).toBe(false);
  });

  it('an unsupported rejection is remembered across a cold start: next parse goes straight to fenced', async () => {
    const store = memStore();
    global.fetch
      .mockResolvedValueOnce(rejection('This model does not support response_format'))
      .mockResolvedValueOnce(chatResponse({ items: [] }));
    await createAIClient({ settingsDomain: liveSettings(A), deviceStore: store }).parseWorkoutSheetImage(photoFile(), PLAN);
    expect(store.set).toHaveBeenCalledTimes(1);
    const [slot, value] = store.set.mock.calls[0];
    expect(slot).toBe('ai.nojsonschema.vision');
    // A SHA-256 hex identity, nothing provider-readable on disk.
    expect(value).toMatch(/^[0-9a-f]{64}$/);

    // Fresh client (page reload) over the same device store.
    global.fetch.mockReset().mockResolvedValueOnce(chatResponse({ items: [] }));
    await createAIClient({ settingsDomain: liveSettings(A), deviceStore: store }).parseWorkoutSheetImage(photoFile(), PLAN);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(sentBody(0).response_format).toBeUndefined();
    expect(sentBody(0).messages[0].content).toContain('Return only valid JSON');

    // Key rotation at the same url/model keeps the memory.
    global.fetch.mockReset().mockResolvedValueOnce(chatResponse({ items: [] }));
    await createAIClient({ settingsDomain: liveSettings({ ...A, vision_api_key: 'rotated' }), deviceStore: store }).parseWorkoutSheetImage(photoFile(), PLAN);
    expect(sentBody(0).response_format).toBeUndefined();

    // A different model re-probes strict.
    global.fetch.mockReset().mockResolvedValueOnce(chatResponse({ items: [] }));
    await createAIClient({ settingsDomain: liveSettings(B), deviceStore: store }).parseWorkoutSheetImage(photoFile(), PLAN);
    expect(sentBody(0).response_format.json_schema.name).toBe('workout_sheet');
  });

  it.each([
    "Invalid schema for response_format: unsupported keyword 'minLength'",
    'response_format json_schema: unsupported constraint minLength',
    'response_format json_schema minLength is not supported',
  ])('a schema-contents error retries fenced once but is never remembered: %s', async (message) => {
    const store = memStore();
    global.fetch
      .mockResolvedValueOnce(rejection(message))
      .mockResolvedValueOnce(chatResponse({ items: [] }));
    await createAIClient({ settingsDomain: liveSettings(A), deviceStore: store }).parseWorkoutSheetImage(photoFile(), PLAN);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(sentBody(1).response_format).toBeUndefined();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('a capability error naming only json_schema still retries fenced and is remembered', async () => {
    const store = memStore();
    global.fetch
      .mockResolvedValueOnce(rejection('json_schema not supported'))
      .mockResolvedValueOnce(chatResponse({ items: [] }));
    await createAIClient({ settingsDomain: liveSettings(A), deviceStore: store }).parseWorkoutSheetImage(photoFile(), PLAN);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(sentBody(1).response_format).toBeUndefined();
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it('a late rejection from a replaced config never overwrites the newer slot', async () => {
    const store = memStore();
    const settings = liveSettings(A);
    const client = createAIClient({ settingsDomain: settings, deviceStore: store });
    let releaseA;
    global.fetch
      .mockImplementationOnce(() => new Promise((resolve) => { releaseA = resolve; }))
      .mockResolvedValueOnce(rejection('This model does not support response_format'))
      .mockResolvedValue(chatResponse({ items: [] }));

    const inFlightA = client.parseWorkoutSheetImage(photoFile(), PLAN);
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    settings.saved.openai = B;
    await client.parseWorkoutSheetImage(photoFile(), PLAN);
    expect(store.set).toHaveBeenCalledTimes(1);
    const slotB = store.m.get('ai.nojsonschema.vision');

    releaseA(rejection('This model does not support response_format'));
    await inFlightA;
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(store.m.get('ai.nojsonschema.vision')).toBe(slotB);
  });

  it('fails open: a throwing device store never fails the parse', async () => {
    const store = {
      get: vi.fn().mockRejectedValue(new Error('idb gone')),
      set: vi.fn().mockRejectedValue(new Error('idb gone')),
    };
    global.fetch
      .mockResolvedValueOnce(rejection('This model does not support response_format'))
      .mockResolvedValueOnce(chatResponse({ items: [{ exercise: 'Bench press', set_index: 1, reps: 8 }] }));
    const parsed = await createAIClient({ settingsDomain: liveSettings(A), deviceStore: store }).parseWorkoutSheetImage(photoFile(), PLAN);
    expect(parsed.items).toHaveLength(1);
    expect(sentBody(0).response_format).toBeDefined();
    expect(sentBody(1).response_format).toBeUndefined();
  });

  it('trial: remembered for the session by machine code, never written to the device store', async () => {
    const meta = document.createElement('meta');
    meta.name = 'medtracker-trial-ai';
    meta.content = '1';
    document.head.appendChild(meta);
    const store = memStore();
    const settings = liveSettings({});
    global.fetch
      .mockResolvedValueOnce({ ok: false, status: 502, text: () => Promise.resolve(JSON.stringify({ error: 'response_format_unsupported', upstream_status: 400 })) })
      .mockResolvedValue(chatResponse({ items: [] }));

    await createAIClient({ settingsDomain: settings, deviceStore: store }).parseWorkoutSheetImage(photoFile(), PLAN);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    await createAIClient({ settingsDomain: settings, deviceStore: store }).parseWorkoutSheetImage(photoFile(), PLAN);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(global.fetch.mock.calls[2][0]).toBe('/api/trial/openai/chat/completions?vision=1');
    expect(sentBody(2).response_format).toBeUndefined();
    expect(store.set).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    // Consent still ran before the cached fallback.
    expect(settings.getTrialConsent).toHaveBeenCalledTimes(2);
  });
});
