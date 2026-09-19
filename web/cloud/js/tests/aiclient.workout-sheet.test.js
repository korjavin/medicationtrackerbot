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
import { createAIClient } from '../aiclient.js';

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
