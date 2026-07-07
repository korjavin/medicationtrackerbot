// Browser implementation of the aiClient port consumed by
// createFoodAIDomain (C2c Task 3) — chat-completions calls go straight from
// this device to the user's own OpenAI(-compatible) endpoint, keyed from the
// vault's unmasked `integrations.openai` record. Never routed through any
// /api shim surface. Mirrors internal/ai/openai.go's request/response shapes,
// the response_format-rejection fallback, and fence stripping.
//
// Trial fallback: when the vault has no key and the served page carries
// <meta name="medtracker-trial-ai" content="1"> (injected by cmd/cloud when
// TRIAL_OPENAI_* is configured), the same request body is POSTed to the
// same-origin proxy /api/trial/openai/chat/completions — no Authorization
// header, no model field (the server forces the operator's model). Vault
// key always wins; no key and no trial flag keeps today's no_api_key error.
import { MealSystemPrompt, MealPhotoSystemPrompt, mealSchema } from '../../domain/foodai.js';

const DEFAULT_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
// 90s matches internal/ai/openai.go's http.Client{Timeout: 90s} (covers slow
// base64 photo uploads plus vision-model latency).
const FETCH_TIMEOUT_MS = 90000;
// matches maxFoodPhotoBytes (food_handlers.go).
const MAX_PHOTO_BYTES = 8 << 20;

function noKeyError() {
  const err = new Error('Add an OpenAI key in Settings → Integrations to use AI food logging.');
  err.code = 'no_api_key';
  return err;
}

function trialLimitError() {
  const err = new Error('Trial limit reached — try again in a minute or add your own OpenAI key in Settings → Integrations.');
  err.code = 'trial_rate_limit';
  return err;
}

function trialAIAvailable() {
  if (typeof document === 'undefined') return false;
  return document.querySelector('meta[name="medtracker-trial-ai"]')?.content === '1';
}

function extractJSONContent(content) {
  return content.trim().replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
}

function extractErrorMessage(text) {
  try {
    const obj = JSON.parse(text);
    if (obj && obj.error && obj.error.message) return obj.error.message;
    if (Array.isArray(obj)) {
      for (const item of obj) if (item && item.error && item.error.message) return item.error.message;
    }
  } catch { /* not JSON — fall through to the raw excerpt */ }
  return text ? text.slice(0, 300) : '';
}

function isResponseFormatRejection(err) {
  return !!(err && err.apiError && /response_format/i.test(err.message));
}

async function postChatCompletion(endpoint, apiKey, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  let text;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const err = new Error(extractErrorMessage(text) || `API returned status code ${res.status}`);
    err.apiError = true;
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const parsed = JSON.parse(text);
  const content = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  if (!content) throw new Error('API returned empty content');
  return JSON.parse(extractJSONContent(content));
}

// ponytail: image/* sniff relies on the browser-supplied File.type rather
// than a magic-number byte sniff — this is a UX gate (fail fast before an
// upload), not a security boundary, since the request goes straight to the
// user's own provider. Add a byte sniff if a provider ever mis-parses a
// mislabeled file.
async function fileToDataURL(file) {
  if (!file.type || !file.type.startsWith('image/')) {
    const err = new Error('Uploaded file is not an image');
    err.code = 'invalid_image';
    throw err;
  }
  if (file.size > MAX_PHOTO_BYTES) {
    const err = new Error('Photo exceeds the 8 MB limit');
    err.code = 'photo_too_large';
    throw err;
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
}

// trialErrorCode extracts the trial proxy's machine-readable error code
// ({"error":"trial_not_configured"} etc.) from a failed response body.
// Returns '' for non-JSON bodies (e.g. a reverse-proxy error page).
function trialErrorCode(bodyText) {
  try {
    const obj = JSON.parse(bodyText);
    return typeof obj?.error === 'string' ? obj.error : '';
  } catch {
    return '';
  }
}

// Trial proxy path: strip model (server forces the operator's model, the
// client must not choose it), rely on the same-origin session cookie instead
// of Authorization, and map the proxy's error contract onto client errors by
// the machine-readable body, not status code — behind Traefik a 503/429 can
// come from the reverse proxy itself (backend restarting, proxy throttle),
// and those must not degrade to the misleading "add your own key" message.
// trial_not_configured degrades to the plain no-key error, trial_rate_limit
// becomes the trial-limit error, and anything else with a status (including
// the server's sanitized {"error":"upstream_error"}) gets a friendly retry
// message instead of raw JSON in an alert. That sanitizing also means
// isResponseFormatRejection never matches here (no fenced retry on trial).
async function postTrialChatCompletion(vision, body) {
  const { model: _serverForced, ...rest } = body;
  try {
    return await postChatCompletion(`/api/trial/openai/chat/completions${vision ? '?vision=1' : ''}`, '', rest);
  } catch (err) {
    const code = trialErrorCode(err.body);
    if (code === 'trial_not_configured') throw noKeyError();
    if (code === 'trial_rate_limit') throw trialLimitError();
    if (err.status) {
      const friendly = new Error('Trial AI request failed — try again or add your own OpenAI key in Settings → Integrations.');
      friendly.status = err.status;
      throw friendly;
    }
    throw err;
  }
}

const RESPONSE_FORMAT = { type: 'json_schema', json_schema: { name: 'parsed_meal', strict: true, schema: mealSchema } };

function fenceInstruction(systemPrompt) {
  return `${systemPrompt}
Return only valid JSON with the shape {"items": [{"name": string, "weight_grams": number, "carbs_100g": number, "protein_100g": number, "fat_100g": number}, ...]}.
Do not wrap the JSON in markdown fences or add explanations.`;
}

// createAIClient builds the aiClient port — settingsDomain is a
// web/domain/settings.js instance whose readIntegrationsUnmasked() supplies
// the raw provider credentials (never exposed through any /api shim route).
export function createAIClient({ settingsDomain }) {
  async function credentials() {
    const { openai } = await settingsDomain.readIntegrationsUnmasked();
    return {
      text: { apiKey: openai.api_key, url: openai.url || DEFAULT_URL, model: openai.model || DEFAULT_MODEL },
      vision: {
        apiKey: openai.vision_api_key || openai.api_key,
        url: openai.vision_url || openai.url || DEFAULT_URL,
        model: openai.vision_model || openai.model || DEFAULT_MODEL,
      },
    };
  }

  async function parseMealFromDescription(description) {
    const { text } = await credentials();
    const useTrial = !text.apiKey;
    if (useTrial && !trialAIAvailable()) throw noKeyError();
    const post = (body) => (useTrial
      ? postTrialChatCompletion(false, body)
      : postChatCompletion(`${text.url.replace(/\/$/, '')}/chat/completions`, text.apiKey, body));

    const body = {
      model: text.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: MealSystemPrompt },
        { role: 'user', content: description },
      ],
      response_format: RESPONSE_FORMAT,
    };
    try {
      return await post(body);
    } catch (err) {
      if (!isResponseFormatRejection(err)) throw err;
      return post({
        model: text.model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: fenceInstruction(MealSystemPrompt) },
          { role: 'user', content: description },
        ],
      });
    }
  }

  async function parseMealFromImage(file) {
    const { vision } = await credentials();
    const useTrial = !vision.apiKey;
    if (useTrial && !trialAIAvailable()) throw noKeyError();
    const post = (body) => (useTrial
      ? postTrialChatCompletion(true, body)
      : postChatCompletion(`${vision.url.replace(/\/$/, '')}/chat/completions`, vision.apiKey, body));
    const dataURL = await fileToDataURL(file);

    const userContent = (text) => [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: dataURL } },
    ];

    const body = {
      model: vision.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: MealPhotoSystemPrompt },
        { role: 'user', content: userContent('Identify the foods in this photo and return the JSON described above.') },
      ],
      response_format: RESPONSE_FORMAT,
    };
    try {
      return await post(body);
    } catch (err) {
      if (!isResponseFormatRejection(err)) throw err;
      return post({
        model: vision.model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: fenceInstruction(MealPhotoSystemPrompt) },
          { role: 'user', content: userContent('Identify the foods in this photo and return JSON.') },
        ],
      });
    }
  }

  return { parseMealFromDescription, parseMealFromImage };
}
