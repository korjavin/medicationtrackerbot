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
import { ActivitySystemPrompt, activitySchema } from '../../domain/activityai.js';
import { ExerciseTagSystemPrompt, exerciseTagSchema } from '../../domain/exercisetag.js';
import { WorkoutSheetPhotoSystemPrompt, workoutSheetSchema } from '../../domain/workoutsheet.js';

const DEFAULT_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-6-luna';
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
  // Local mode's anonymous trial (bd med-o7zq.16): an install's lifetime
  // allowance (`install`) never comes back; its daily one (`install-day`) does.
  if (scope === 'install' || scope === 'install-day') {
    const err = new Error(scope === 'install'
      ? "You've used all your free trial AI requests — add your own OpenAI key in Settings → AI & integrations to keep going."
      : "You've used today's free trial AI requests — they reset tomorrow, or add your own OpenAI key in Settings → AI & integrations to keep going now.");
    err.code = 'trial_budget_exhausted';
    err.scope = scope;
    return err;
  }
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

// Local mode's anonymous trial: Apple's DeviceCheck says this iPhone already
// had its trial (an earlier install of the app). Reinstalling does not reset it.
function trialAlreadyUsedError() {
  const err = new Error(`This ${globalThis.LocalNotifications?.copy?.device || 'iPhone'} has already used its free trial AI — add your own OpenAI key in Settings → AI & integrations to keep going.`);
  err.code = 'trial_already_used';
  return err;
}

// Skipping key setup is not consent (bd med-yor.2): trial transmission is
// refused until the user explicitly allowed the scope in the trialconsent
// vault record. Interactive UI paths catch this code and run the disclosure
// dialog; the Telegram drain path lets it surface (no user present to ask).
function trialConsentRequiredError(scope) {
  const err = new Error("Using the operator's trial AI needs your consent first — allow it in Settings → Integrations.");
  err.code = 'trial_consent_required';
  err.scope = scope;
  return err;
}

// Local mode's anonymous trial (bd med-o7zq.16): local-policy.js installs a
// transport ({ post(trialPath, init) → Response }, web/cloud/js/local-trial.js)
// when the user turned the trial on; it signs each request with App Attest and
// sends it to our server's base-domain attest route. Unset everywhere else, so
// the cloud path below (meta tag, same-origin fetch) is unchanged.
let trialTransport = null;

export function setTrialTransport(transport) {
  trialTransport = transport || null;
}

// The fetch the trial paths use: the installed transport, else the page's own.
function trialFetch(endpoint, init) {
  return trialTransport ? trialTransport.post(endpoint, init) : fetch(endpoint, init);
}

function trialAIAvailable() {
  if (trialTransport) return true;
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

// The one-off retry trigger: any API error naming response_format gets one
// fenced retry. Deliberately broad (schema errors, med-gdb4's temperature 400).
function isResponseFormatRejection(err) {
  return !!(err && err.apiError && /response_format/i.test(err.message));
}

// The durable-memory trigger (bd med-kl85), much narrower than the retry one:
// only a message about the response_format TYPE / model capability persists.
// Anything about schema contents ("Invalid schema for response_format:
// unsupported keyword 'minLength'", additionalProperties, required, ...) or
// another parameter (temperature) is ambiguous — retried once, never stored.
// Positive match is a closed grammar: the unsupported thing must BE the
// response_format / json_schema type, optionally "with this model", then the
// phrase ends. Any other intervening text (a keyword, a constraint) is
// ambiguous and stays retry-only.
const FMT = `['"]?(?:response_format|json_schema)['"]?(?: (?:of type |type )?['"]?json_schema['"]?)?(?: type)?`;
const MODEL_TAIL = `(?: (?:with|for|on|by) (?:this|the) model)?\\s*(?:[.,;!)]|$)`;
const UNSUPPORTED_FORMAT_PATTERNS = [
  new RegExp(`(?:does not|doesn't|do not) support (?:the )?${FMT}${MODEL_TAIL}`, 'i'),
  new RegExp(`${FMT} (?:(?:is|are) )?not supported${MODEL_TAIL}`, 'i'),
  new RegExp(`unsupported (?:value: )?${FMT}${MODEL_TAIL}`, 'i'),
];
export function isResponseFormatUnsupported(err) {
  const msg = String((err && err.message) || '');
  return !!(err && err.apiError)
    && UNSUPPORTED_FORMAT_PATTERNS.some((re) => re.test(msg))
    && !/invalid schema|keyword|propert|field|required|constraint|temperature/i.test(msg);
}

// Trial memory is session-only (module-level, shared by every client
// instance): the operator forces the model server-side (trial_proxy.go), so
// the client cannot tell when it changes and a persisted bit would strand
// trial users on the fenced prompt after an operator upgrade.
const trialNoJSONSchema = new Set();

// configIdentity is the stored slot value: SHA-256 of the JSON tuple
// [url, model]. A collision-safe identity, NOT a privacy boundary — the host
// is already in the account's egress allowlist / document CSP, and the device
// store it lands in already holds the NK in plaintext. The API key is not part
// of it: capability is a model property, so key rotation does not reset.
async function configIdentity(provider) {
  const bytes = new TextEncoder().encode(JSON.stringify([provider.url, provider.model]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// isLunaModel — gpt-6-luna (or a dated variant) refuses function tools at
// its default reasoning effort (live-API verified, med-ibvc): tool calls
// must carry reasoning_effort 'none'. Scoped to this id on purpose — other
// providers 400 unknown parameters, so only luna-named models get the knob.
// An optional `provider/` prefix (e.g. `openai/gpt-6-luna` on OpenRouter)
// is stripped before matching.
function isLunaModel(model) {
  if (typeof model !== 'string') return false;
  const id = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return id === 'gpt-6-luna' || id.startsWith('gpt-6-luna-');
}

// ---------------------------------------------------------------------------
// Model-id discovery (bd med-byom) — GET {base}/models against the user's own
// provider, so Settings can suggest model ids instead of asking the user to
// remember them. Suggestions only: nothing here ever validates or rewrites
// what the user typed, and every failure degrades to "no suggestions".
// ---------------------------------------------------------------------------

const MODELS_TIMEOUT_MS = 15000;
const MAX_MODELS = 200;
// A model list is a few KB. Anything past this is not one, so stop before
// JSON.parse spends the main thread on a hostile/misrouted response.
const MAX_MODELS_BYTES = 1 << 20;

function modelsError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// keyFingerprint identifies a key well enough to invalidate a cache entry when
// the user swaps keys, without keeping the key: length plus a cheap hash of the
// last 6 chars. Never reversible, never rendered.
export function keyFingerprint(apiKey) {
  const key = String(apiKey || '');
  const tail = key.slice(-6);
  let h = 0;
  for (let i = 0; i < tail.length; i += 1) h = ((h << 5) - h + tail.charCodeAt(i)) | 0;
  return `${key.length}:${h}`;
}

// parseModelList reads ONLY the standard OpenAI shape — {data: [{id}]}. No
// alternate probing, no vendor-specific fallbacks: an unrecognised body is
// simply "no list", which is the same outcome as no provider support.
export function parseModelList(text) {
  if (typeof text !== 'string' || text.length > MAX_MODELS_BYTES) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || !Array.isArray(parsed.data)) return null;
  const ids = [...new Set(parsed.data
    .map((m) => (m && typeof m.id === 'string' ? m.id.trim() : ''))
    .filter(Boolean))];
  ids.sort();
  return ids.slice(0, MAX_MODELS);
}

async function fetchModelIds(base, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  let res;
  let text;
  try {
    // Authorization header only — never a query param, so the key cannot leak
    // into the provider's access log or a redirect target. no-referrer keeps
    // the account subdomain (a stable pseudonymous identifier) out of the
    // Referer the provider would otherwise see.
    res = await fetch(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    text = await res.text();
  } catch {
    // fetch() rejects identically for a CSP block, a CORS refusal, DNS failure
    // and our own abort — the browser deliberately refuses to say which. One
    // message, pointed at the likeliest cause right after a provider save: the
    // document's connect-src predates the new host until a reload.
    throw modelsError('unreachable', "Couldn't reach the provider. If you just saved this URL, reload the app first.");
  } finally {
    clearTimeout(timer);
  }
  // Status only, never the body: a proxy that echoes request headers back in
  // its error payload would otherwise put the user's key on screen.
  if (!res.ok) throw modelsError('http', `Provider returned ${res.status} for the model list.`);
  const ids = parseModelList(text);
  if (!ids) throw modelsError('parse', "Provider didn't return an OpenAI-style model list.");
  return ids;
}

async function postChatCompletion(endpoint, apiKey, body, send = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  let text;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    res = await send(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
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
async function postChatRaw(endpoint, apiKey, body, send = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  let text;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    res = await send(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
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
  if (code === 'trial_budget_unavailable' || code === 'trial_unavailable') return trialBudgetUnavailableError();
  if (code === 'trial_already_used') return trialAlreadyUsedError();
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
    return await postChatCompletion(`/api/trial/openai/chat/completions${vision ? '?vision=1' : ''}`, '', rest, trialFetch);
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
    return await postChatRaw('/api/trial/openai/chat/completions', '', rest, trialFetch);
  } catch (err) {
    throw mapTrialError(err);
  }
}

const RESPONSE_FORMAT = { type: 'json_schema', json_schema: { name: 'parsed_meal', strict: true, schema: mealSchema } };
const ACTIVITY_RESPONSE_FORMAT = { type: 'json_schema', json_schema: { name: 'activity_data', strict: true, schema: activitySchema } };
const EXERCISE_TAG_RESPONSE_FORMAT = { type: 'json_schema', json_schema: { name: 'exercise_tags', strict: true, schema: exerciseTagSchema } };
const WORKOUT_SHEET_RESPONSE_FORMAT = { type: 'json_schema', json_schema: { name: 'workout_sheet', strict: true, schema: workoutSheetSchema } };

function fenceInstruction(systemPrompt) {
  return `${systemPrompt}
Return only valid JSON with the shape {"items": [{"name": string, "weight_grams": number, "carbs_100g": number, "protein_100g": number, "fat_100g": number, "uncertain": boolean}, ...]}.
Do not wrap the JSON in markdown fences or add explanations.`;
}

function exerciseTagFenceInstruction(systemPrompt) {
  return `${systemPrompt}
Return only valid JSON with the shape {"items": [{"name": string, "body_part": string}, ...]}.
Do not wrap the JSON in markdown fences or add explanations.`;
}

function activityFenceInstruction(systemPrompt) {
  return `${systemPrompt}
Return only valid JSON with the shape {"name": string, "exercises": [{"name": string, "sets": number|null, "reps": number|null, "weight": number|null, "weight_unit": string, "duration_minutes": number|null, "distance": number|null, "distance_unit": string, "notes": string}]}.
Do not wrap the JSON in markdown fences or add explanations.`;
}

function workoutSheetFenceInstruction(systemPrompt) {
  return `${systemPrompt}
Return only valid JSON with the shape {"items": [{"day": string, "exercise": string, "set_index": number, "reps": number, "weight": number|null, "unit": string}]}.
Do not wrap the JSON in markdown fences or add explanations.`;
}

// createAIClient builds the aiClient port — settingsDomain is a
// web/domain/settings.js instance whose readIntegrationsUnmasked() supplies
// the raw provider credentials (never exposed through any /api shim route).
// deviceStore ({ get(key), set(key, value) }, sync.js's deviceValues in
// production) persists the BYO "no json_schema" memory on this device only;
// omitted → no BYO memory, today's strict-then-fenced on every call.
export function createAIClient({ settingsDomain, deviceStore = null }) {
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

  // postStructured is the one strict→fenced path for every structured parse
  // (bd med-kl85). Strict json_schema first; a response_format rejection
  // retries once with the fenced prompt. An explicit "unsupported" rejection
  // is remembered so later calls go straight to fenced:
  //  - BYO: one device-store slot per scope holding configIdentity of the last
  //    config that rejected. A product tradeoff, not a capability guarantee:
  //    the user resets it by changing url or model in Settings (new identity
  //    ≠ slot → strict re-probe); a provider-side upgrade is never noticed.
  //    A→B→A keeps A remembered unless B also rejected in between (no Settings
  //    hook, no generation counter). Key rotation does not reset.
  //  - Trial: session-only, keyed by transport + scope, decided by the proxy's
  //    machine code, never persisted.
  // Callers run the consent / no-key checks before this, so a cached fallback
  // never skips them. Store failures fail open (no memory, today's behavior).
  async function postStructured({ scope, provider, useTrial, post, strictBody, fencedBody }) {
    const slot = `ai.nojsonschema.${scope}`;
    const trialKey = `trial|${trialTransport ? 'local' : 'cloud'}|${scope}`;
    let identity = null;
    if (useTrial) {
      if (trialNoJSONSchema.has(trialKey)) return post(fencedBody);
    } else if (deviceStore) {
      try {
        identity = await configIdentity(provider);
        if ((await deviceStore.get(slot)) === identity) return post(fencedBody);
      } catch { /* fail open: probe strict as if nothing were remembered */ }
    }
    try {
      return await post(strictBody);
    } catch (err) {
      // A capability message naming only json_schema still earns the retry.
      if (!isResponseFormatRejection(err) && !isResponseFormatUnsupported(err)) throw err;
      if (useTrial) {
        if (err.code === 'response_format_unsupported') trialNoJSONSchema.add(trialKey);
      } else if (identity && isResponseFormatUnsupported(err)) {
        await rememberUnsupported(scope, slot, identity);
      }
      return post(fencedBody);
    }
  }

  // Write only if the config this request was sent with is still the saved
  // one: a late rejection from a config the user has since replaced must not
  // overwrite the newer config's slot.
  async function rememberUnsupported(scope, slot, identity) {
    try {
      const creds = await credentials();
      const current = scope === 'vision' ? creds.vision : creds.text;
      if (!current.apiKey || (await configIdentity(current)) !== identity) return;
      await deviceStore.set(slot, identity);
    } catch { /* fail open: the fenced retry still runs */ }
  }

  // In-memory only, for the life of this client. A model list is derived from
  // the user's key, so persisting it (api_cache, IndexedDB, localStorage) would
  // put provider-account facts outside the vault in cleartext. Keyed by base
  // URL + key fingerprint so swapping either invalidates it for free.
  const modelsCache = new Map();

  // listModels backs the Settings model combobox. It reads the SAVED vault
  // credentials — never a DOM field the user is mid-edit on — which is what
  // keeps an existing key from being sent to a half-typed hostname, and what
  // guarantees the host is one the document's connect-src already allows.
  async function listModels({ scope = 'text', refresh = false } = {}) {
    const creds = await credentials();
    const provider = scope === 'vision' ? creds.vision : creds.text;
    if (!provider.apiKey) throw modelsError('no_key', 'Save an API key first, then load the model list.');
    const base = provider.url.replace(/\/$/, '');
    const cacheKey = `${base}|${keyFingerprint(provider.apiKey)}`;
    if (!refresh && modelsCache.has(cacheKey)) return { models: modelsCache.get(cacheKey), cached: true };
    const models = await fetchModelIds(base, provider.apiKey);
    modelsCache.set(cacheKey, models);
    return { models, cached: false };
  }

  // Only a literal `true` passes — null (never asked), false (declined), or a
  // missing record all refuse before any trial transmission. BYO calls never
  // reach this (useTrial is false), so consent is never even read.
  // Local mode's anonymous trial has one switch, the `anon` scope, and it
  // covers every `ai`-scope call (meal and activity text, meal and
  // workout-sheet photos, exercise names): Telegram, the narrator and voice
  // (`tg`, `voice`) are not offered there, so their scopes never pass.
  async function ensureTrialConsent(requested) {
    const scope = trialTransport && requested === 'ai' ? 'anon' : requested;
    const consent = await settingsDomain.getTrialConsent();
    if (!consent || consent[scope] !== true) throw trialConsentRequiredError(scope);
  }

  async function parseMealFromDescription(description) {
    const { text } = await credentials();
    const useTrial = !text.apiKey;
    if (useTrial && !trialAIAvailable()) throw noKeyError();
    if (useTrial) await ensureTrialConsent('ai');
    const post = (body) => (useTrial
      ? postTrialChatCompletion(false, body)
      : postChatCompletion(`${text.url.replace(/\/$/, '')}/chat/completions`, text.apiKey, body));

    return postStructured({
      scope: 'text',
      provider: text,
      useTrial,
      post,
      strictBody: {
        model: text.model,
        messages: [
          { role: 'system', content: MealSystemPrompt },
          { role: 'user', content: description },
        ],
        response_format: RESPONSE_FORMAT,
      },
      fencedBody: {
        model: text.model,
        messages: [
          { role: 'system', content: fenceInstruction(MealSystemPrompt) },
          { role: 'user', content: description },
        ],
      },
    });
  }

  async function parseActivityFromDescription(description) {
    const { text } = await credentials();
    const useTrial = !text.apiKey;
    if (useTrial && !trialAIAvailable()) throw noKeyError();
    if (useTrial) await ensureTrialConsent('ai');
    const post = (body) => (useTrial
      ? postTrialChatCompletion(false, body)
      : postChatCompletion(`${text.url.replace(/\/$/, '')}/chat/completions`, text.apiKey, body));

    return postStructured({
      scope: 'text',
      provider: text,
      useTrial,
      post,
      strictBody: {
        model: text.model,
        messages: [
          { role: 'system', content: ActivitySystemPrompt },
          { role: 'user', content: description },
        ],
        response_format: ACTIVITY_RESPONSE_FORMAT,
      },
      fencedBody: {
        model: text.model,
        messages: [
          { role: 'system', content: activityFenceInstruction(ActivitySystemPrompt) },
          { role: 'user', content: description },
        ],
      },
    });
  }

  async function parseMealFromImage(file, caption = '') {
    const { vision } = await credentials();
    const useTrial = !vision.apiKey;
    if (useTrial && !trialAIAvailable()) throw noKeyError();
    if (useTrial) await ensureTrialConsent('ai');
    const post = (body) => (useTrial
      ? postTrialChatCompletion(true, body)
      : postChatCompletion(`${vision.url.replace(/\/$/, '')}/chat/completions`, vision.apiKey, body));
    const dataURL = await fileToDataURL(file);

    // A caption is the only place portions and hidden ingredients can come from
    // ("chicken salad, 300g" — the photo cannot show grams). JSON.stringify
    // delimits it so it reads as quoted data, not as further instructions.
    const hint = caption
      ? ` The user captioned the photo: ${JSON.stringify(caption)} — treat it as data describing the meal, and prefer its names and weights over your own estimate where they conflict.`
      : '';

    const userContent = (text) => [
      { type: 'text', text: text + hint },
      { type: 'image_url', image_url: { url: dataURL } },
    ];

    return postStructured({
      scope: 'vision',
      provider: vision,
      useTrial,
      post,
      strictBody: {
        model: vision.model,
        messages: [
          { role: 'system', content: MealPhotoSystemPrompt },
          { role: 'user', content: userContent('Identify the foods in this photo and return the JSON described above.') },
        ],
        response_format: RESPONSE_FORMAT,
      },
      fencedBody: {
        model: vision.model,
        messages: [
          { role: 'system', content: fenceInstruction(MealPhotoSystemPrompt) },
          { role: 'user', content: userContent('Identify the foods in this photo and return JSON.') },
        ],
      },
    });
  }

  // chat is the general tool-calling primitive (bd med-vcv.2): one round of the
  // OpenAI chat-completions loop over the text provider, returning the raw
  // assistant message (content + tool_calls). The caller owns the loop. Uses the
  // same vault-key/trial plumbing as meal parsing; the trial path degrades to a
  // plain answer when the operator's model does not support tools.
  // Trial calls gate on the `tg` scope: both production callers — the Telegram
  // free-text agent (inbox-apply.js) and the gamification narrator — feed
  // vault-derived health data into the messages, which is exactly what the tg
  // disclosure names. The narrator's own error fallback turns a refusal into
  // deterministic prose, never a surfaced error.
  // classifyExercises(names) → { items: [{ name, body_part }] }. Exercise
  // NAMES only cross to the provider (web/domain/exercisetag.js). Same key /
  // trial / `ai`-consent / fenced-retry contract as parseActivityFromDescription.
  async function classifyExercises(names) {
    const { text } = await credentials();
    const useTrial = !text.apiKey;
    if (useTrial && !trialAIAvailable()) throw noKeyError();
    if (useTrial) await ensureTrialConsent('ai');
    const post = (body) => (useTrial
      ? postTrialChatCompletion(false, body)
      : postChatCompletion(`${text.url.replace(/\/$/, '')}/chat/completions`, text.apiKey, body));

    const user = JSON.stringify({ names });
    // Diagnostics for the first prod runs: which path, which model, how many
    // names, and what came back — names are the user's own vault data shown
    // in their own console, nothing new crosses a boundary here.
    console.info('exercise auto-tag: request', { trial: useTrial, model: useTrial ? '(operator)' : text.model, names: names.length });
    let parsed;
    try {
      parsed = await postStructured({
        scope: 'text',
        provider: text,
        useTrial,
        post,
        strictBody: {
          model: text.model,
          messages: [
            { role: 'system', content: ExerciseTagSystemPrompt },
            { role: 'user', content: user },
          ],
          response_format: EXERCISE_TAG_RESPONSE_FORMAT,
        },
        fencedBody: {
          model: text.model,
          messages: [
            { role: 'system', content: exerciseTagFenceInstruction(ExerciseTagSystemPrompt) },
            { role: 'user', content: user },
          ],
        },
      });
    } catch (err) {
      console.error('exercise auto-tag: provider call failed', { status: err && err.status, message: err && err.message, body: err && err.body });
      throw err;
    }
    console.info('exercise auto-tag: response', parsed);
    return parsed;
  }

  // parseWorkoutSheetImage(file, planContext) → { items: [{ exercise,
  // set_index, reps, weight, unit }] }. Sheet-photo sibling of
  // parseMealFromImage (bd med-qj4.9): same vision-credential / trial
  // `?vision=1` / `ai`-consent / fenced-retry contract. planContext is the
  // plan the sheet was printed from (group + days with exercise names) —
  // passed as quoted data so the model repeats the printed exercise names
  // exactly instead of guessing them from handwriting-adjacent pixels.
  async function parseWorkoutSheetImage(file, planContext) {
    const { vision } = await credentials();
    const useTrial = !vision.apiKey;
    if (useTrial && !trialAIAvailable()) throw noKeyError();
    if (useTrial) await ensureTrialConsent('ai');
    const post = (body) => (useTrial
      ? postTrialChatCompletion(true, body)
      : postChatCompletion(`${vision.url.replace(/\/$/, '')}/chat/completions`, vision.apiKey, body));
    const dataURL = await fileToDataURL(file);

    const planHint = ` The sheet was printed from this plan, as JSON data: ${JSON.stringify(planContext || {})} — repeat its exercise names exactly; only the handwritten numbers come from the photo.`;

    const userContent = (text) => [
      { type: 'text', text: text + planHint },
      { type: 'image_url', image_url: { url: dataURL } },
    ];

    return postStructured({
      scope: 'vision',
      provider: vision,
      useTrial,
      post,
      strictBody: {
        model: vision.model,
        messages: [
          { role: 'system', content: WorkoutSheetPhotoSystemPrompt },
          { role: 'user', content: userContent('Read the handwritten sets on this workout sheet and return the JSON described above.') },
        ],
        response_format: WORKOUT_SHEET_RESPONSE_FORMAT,
      },
      fencedBody: {
        model: vision.model,
        messages: [
          { role: 'system', content: workoutSheetFenceInstruction(WorkoutSheetPhotoSystemPrompt) },
          { role: 'user', content: userContent('Read the handwritten sets on this workout sheet and return JSON.') },
        ],
      },
    });
  }

  async function chat({ messages, tools }) {
    const { text } = await credentials();
    const useTrial = !text.apiKey;
    if (useTrial && !trialAIAvailable()) throw noKeyError();
    if (useTrial) await ensureTrialConsent('tg');
    const body = { model: text.model, messages };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
      // Trial mode is excluded on purpose: the client cannot know the
      // operator's forced model, so the trial proxy injects this itself
      // (trial_proxy.go) — sending it blindly would 400 operators on
      // models that reject unknown parameters.
      if (!useTrial && isLunaModel(text.model)) body.reasoning_effort = 'none';
    }
    return useTrial
      ? postTrialChatRaw(body)
      : postChatRaw(`${text.url.replace(/\/$/, '')}/chat/completions`, text.apiKey, body);
  }

  // chatStream is the voice-relay primitive (bd med-h849.2): ElevenLabs'
  // custom-LLM request body arrives through the relay, goes to the same
  // provider chat() would use with stream:true, and the provider's raw SSE
  // text is handed to onChunk UNPARSED — the server writes it to ElevenLabs
  // verbatim. Resolves when the stream ends; rejects on non-2xx (trial errors
  // mapped like chat()) or when signal aborts the fetch. Trial calls gate on
  // the `voice` consent scope.
  async function chatStream({ body, signal, onChunk }) {
    const { text } = await credentials();
    const useTrial = !text.apiKey;
    // The attest route answers no stream (stream_unsupported): no voice trial in local mode.
    if (useTrial && (trialTransport || !trialAIAvailable())) throw noKeyError();
    if (useTrial) await ensureTrialConsent('voice');
    // ElevenLabs-only fields an OpenAI-compatible provider may 400 on; the
    // rest of the request goes through untouched.
    const {
      elevenlabs_extra_body: _extra, user: _user, user_id: _userId, model: _model, ...req
    } = body || {};
    req.stream = true;
    const headers = { 'Content-Type': 'application/json' };
    let endpoint = '/api/trial/openai/chat/completions'; // trial: server forces the model
    if (!useTrial) {
      req.model = text.model;
      if (Array.isArray(req.tools) && req.tools.length && isLunaModel(text.model)) req.reasoning_effort = 'none';
      endpoint = `${text.url.replace(/\/$/, '')}/chat/completions`;
      headers.Authorization = `Bearer ${text.apiKey}`;
    }
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(req), signal });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error(extractErrorMessage(errText) || `API returned status code ${res.status}`);
      err.apiError = true;
      err.status = res.status;
      err.body = errText;
      throw useTrial ? mapTrialError(err) : err;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) onChunk(chunk);
    }
    const rest = decoder.decode();
    if (rest) onChunk(rest);
  }

  // usesTrial: true when the voice relay's text turns would use the account
  // trial proxy (no vault key, trial offered) — lets the voice call ask for
  // `voice` consent up front instead of failing the first relayed turn. Local
  // mode's attest transport never serves voice, so it reports false there.
  async function usesTrial() {
    const { text } = await credentials();
    return !text.apiKey && !trialTransport && trialAIAvailable();
  }

  return { parseMealFromDescription, parseActivityFromDescription, parseMealFromImage, parseWorkoutSheetImage, classifyExercises, chat, chatStream, usesTrial, listModels };
}
