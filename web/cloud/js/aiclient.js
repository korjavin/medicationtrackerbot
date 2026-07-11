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

// Distinct from trial_rate_limit on purpose (bd med-d5t.5): "wait a minute" and
// "the shared budget is gone until tomorrow" ask different things of the user.
// `scope` says whose budget ran out — the account's own share, or the operator's
// pool across everyone.
function trialBudgetError(scope) {
  const whose = scope === 'global'
    ? "The shared AI budget for this server is used up for today"
    : "You've used your AI allowance for today";
  const err = new Error(`${whose} — it resets tomorrow, or add your own OpenAI key in Settings → Integrations to keep going now.`);
  err.code = 'trial_budget_exhausted';
  err.scope = scope;
  return err;
}

// A budget check that could not run refuses the call rather than spending the
// operator's key blind, so the client says so plainly instead of "try again".
function trialBudgetUnavailableError() {
  const err = new Error('Trial AI is unavailable right now — add your own OpenAI key in Settings → Integrations, or try later.');
  err.code = 'trial_budget_unavailable';
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

// postChatRaw is the tool-calling sibling of postChatCompletion: it returns the
// assistant message OBJECT (content + tool_calls) verbatim instead of
// JSON-parsing the content, because a tool-calling turn may carry tool_calls and
// no content at all (bd med-vcv.2). Same fetch + error contract.
async function postChatRaw(endpoint, apiKey, body) {
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
  const msg = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message;
  if (!msg) throw new Error('API returned no message');
  return msg;
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

// trialErrorInfo extracts the trial proxy's machine-readable error code
// ({"error":"trial_not_configured"} etc.) and the real upstream status it
// relays ({"upstream_status":401}) from a failed response body. Both fall back
// to empty for non-JSON bodies (e.g. a reverse-proxy error page).
function trialErrorInfo(bodyText) {
  try {
    const obj = JSON.parse(bodyText);
    return {
      code: typeof obj?.error === 'string' ? obj.error : '',
      upstreamStatus: typeof obj?.upstream_status === 'number' ? obj.upstream_status : 0,
      scope: typeof obj?.scope === 'string' ? obj.scope : '',
    };
  } catch {
    return { code: '', upstreamStatus: 0, scope: '' };
  }
}

// The proxy sanitizes the upstream's own response_format complaint into a
// machine code, so synthesize an error shaped for isResponseFormatRejection()
// and let the existing fenced-prompt retry take over — same fallback the BYO
// path gets from the provider's raw 400.
function responseFormatUnsupportedError() {
  const err = new Error('Trial model rejected response_format');
  err.apiError = true;
  err.code = 'response_format_unsupported';
  return err;
}

// The proxy always answers 502, so the upstream status is the only thing that
// separates "the operator's key is bad" from "try again in a bit".
function trialFailureMessage(upstreamStatus) {
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return 'Trial AI is temporarily unavailable — contact the operator, or add your own OpenAI key in Settings → Integrations.';
  }
  if (upstreamStatus === 429) {
    return 'Trial AI quota is exhausted — try later, or add your own OpenAI key in Settings → Integrations.';
  }
  return 'Trial AI request failed — try again or add your own OpenAI key in Settings → Integrations.';
}

// Trial proxy path: strip model (server forces the operator's model, the
// client must not choose it), rely on the same-origin session cookie instead
// of Authorization, and map the proxy's error contract onto client errors by
// the machine-readable body, not status code — behind Traefik a 503/429 can
// come from the reverse proxy itself (backend restarting, proxy throttle),
// and those must not degrade to the misleading "add your own key" message.
// trial_not_configured degrades to the plain no-key error, trial_rate_limit
// becomes the trial-limit error, response_format_unsupported re-enters the
// fenced-prompt retry (the proxy cannot relay the upstream's own 400 text, so
// it names the case instead — bot mode's internal/ai/openai.go sniffs that
// text directly), and anything else with a status gets a friendly message
// worded by the relayed upstream_status instead of raw JSON in an alert.
// mapTrialError turns a raw proxy failure into the right typed client error by
// the machine-readable body (not status). Shared by the JSON meal path and the
// raw tool-calling path so both map the proxy contract identically. Always
// returns an Error to throw.
function mapTrialError(err) {
  const { code, upstreamStatus, scope } = trialErrorInfo(err.body);
  if (code === 'trial_not_configured') return noKeyError();
  if (code === 'trial_rate_limit') return trialLimitError();
  if (code === 'trial_budget_exhausted') return trialBudgetError(scope);
  if (code === 'trial_budget_unavailable') return trialBudgetUnavailableError();
  if (err.status) {
    // response_format_unsupported is a handled case — the caller retries
    // without response_format and usually recovers, so don't surface a red
    // console.error on a path that ultimately succeeds. If that retry also
    // fails, its own mapTrialError call logs the real failure.
    if (code === 'response_format_unsupported') return responseFormatUnsupportedError();
    // The proxy sanitizes the upstream body, so this is the only place a
    // browser can observe what actually failed.
    console.error('trial AI request failed', { status: err.status, code, upstream_status: upstreamStatus, body: err.body });
    const friendly = new Error(trialFailureMessage(upstreamStatus));
    friendly.status = err.status;
    friendly.upstreamStatus = upstreamStatus;
    return friendly;
  }
  return err;
}

async function postTrialChatCompletion(vision, body) {
  const { model: _serverForced, ...rest } = body;
  try {
    return await postChatCompletion(`/api/trial/openai/chat/completions${vision ? '?vision=1' : ''}`, '', rest);
  } catch (err) {
    throw mapTrialError(err);
  }
}

// postTrialChatRaw is the tool-calling sibling for the trial proxy: same
// model-stripping and error mapping as postTrialChatCompletion, but returns the
// raw assistant message. Whether the operator's model honours `tools` is up to
// that model; if it does not, it simply answers in content and the loop ends.
async function postTrialChatRaw(body) {
  const { model: _serverForced, ...rest } = body;
  try {
    return await postChatRaw('/api/trial/openai/chat/completions', '', rest);
  } catch (err) {
    throw mapTrialError(err);
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

  // chat is the general tool-calling primitive (bd med-vcv.2): one round of the
  // OpenAI chat-completions loop over the text provider, returning the raw
  // assistant message (content + tool_calls). The caller owns the loop. Uses the
  // same vault-key/trial plumbing as meal parsing; the trial path degrades to a
  // plain answer when the operator's model does not support tools.
  async function chat({ messages, tools, temperature = 0.2 }) {
    const { text } = await credentials();
    const useTrial = !text.apiKey;
    if (useTrial && !trialAIAvailable()) throw noKeyError();
    const body = { model: text.model, temperature, messages };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    return useTrial
      ? postTrialChatRaw(body)
      : postChatRaw(`${text.url.replace(/\/$/, '')}/chat/completions`, text.apiKey, body);
  }

  return { parseMealFromDescription, parseMealFromImage, chat };
}
