// OpenAI-compatible tool-calling agent for the cloud MCP evals.
//
// Port of the deleted internal/mcpeval/agent.go (removed in med-a9n5.2): the
// same lean system prompt, bounded tool loop, reasoning_content round-trip,
// Gemini thought-signature round-trip, and 429 handling — minus the
// mcp_execute tool, which has no cloud path. Judge completions go through
// completeJSON, which requests a strict json_schema verdict and falls back to
// fenced prose only when the provider rejects response_format (the
// web/cloud/js/aiclient.js fallback pattern; supersedes med-95jv).

export const systemPromptUnderTest = 'You are an assistant for a personal health-tracking app. '
  + 'You can read and modify the user\'s health data only through the provided tools. '
  + 'When the user asks you to change data, perform the change with a tool. '
  + 'If a request can\'t be done with the available tools, say so plainly. '
  + 'Reply briefly when you have the answer.';

export const defaultMaxTokens = 4096;

const FETCH_TIMEOUT_MS = 120_000;
const maxRateLimitRetries = 5;

export class ChatAPIError extends Error {
  constructor(status, body) {
    super(`chat API status ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

function truncate(s, n) {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

// isRetryableQuota reports whether a 429 body is worth retrying. A per-minute
// throttle clears on its own; a per-DAY project quota (Google quotaId like
// "GenerateRequestsPerDayPerProjectPerModel-FreeTier") will NOT clear within a
// run, so retrying just hangs each remaining scenario through pointless
// backoff — fail fast instead. Unparseable or non-Google 429s default to
// retryable (the conservative choice).
function isRetryableQuota(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return true;
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const details = (first && first.error && first.error.details) || [];
  for (const d of details) {
    if (!String(d['@type'] || '').includes('QuotaFailure')) continue;
    for (const v of d.violations || []) {
      if (String(v.quotaId || '').toLowerCase().includes('perday')) return false;
    }
  }
  return true;
}

function clampBackoff(ms) {
  return Math.min(Math.max(ms, 1000), 60_000);
}

// retryAfter prefers the Retry-After header, then the Google
// RetryInfo.retryDelay embedded in the error body (e.g. "30s"), else a capped
// exponential backoff keyed on the attempt number.
function retryAfter(headers, bodyText, attempt) {
  const header = headers.get('retry-after');
  if (header) {
    const secs = parseInt(header.trim(), 10);
    if (Number.isFinite(secs) && secs > 0) return clampBackoff(secs * 1000);
  }
  try {
    const parsed = JSON.parse(bodyText);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const details = (first && first.error && first.error.details) || [];
    for (const d of details) {
      if (String(d['@type'] || '').includes('RetryInfo') && d.retryDelay) {
        const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d.retryDelay).trim());
        if (m) return clampBackoff(parseFloat(m[1]) * 1000);
      }
    }
  } catch {
    // fall through to backoff
  }
  return clampBackoff(2000 * 2 ** attempt);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export class Client {
  constructor(apiKey, baseURL, model, maxTokens, temperature) {
    this.apiKey = apiKey;
    this.baseURL = (baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = model || 'gpt-4o-mini';
    this.maxTokens = maxTokens > 0 ? maxTokens : defaultMaxTokens;
    this.temperature = temperature; // undefined omits the field (reasoning models 400 on it)
  }

  async chat(req, signal) {
    const body = JSON.stringify(req);
    let lastBody = '';
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const onAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          throw signal.reason || new Error('aborted');
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      let res;
      try {
        res = await fetch(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body,
          signal: controller.signal,
        });
      } catch (e) {
        if (signal) signal.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        throw new Error(`request failed: ${e.message}`);
      }
      if (signal) signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      const raw = await res.text();

      if (res.status === 429 && attempt < maxRateLimitRetries && isRetryableQuota(raw)) {
        lastBody = raw.trim();
        await sleep(retryAfter(res.headers, raw, attempt));
        continue;
      }
      if (!res.ok) {
        let excerpt = raw.trim() || lastBody;
        excerpt = truncate(excerpt, 400);
        throw new ChatAPIError(res.status, excerpt);
      }
      let out;
      try {
        out = JSON.parse(raw);
      } catch (e) {
        throw new Error(`decode response: ${e.message}`);
      }
      if (out.error && out.error.message) throw new Error(`chat API error: ${out.error.message}`);
      if (!out.choices || out.choices.length === 0) throw new Error('chat API returned no choices');
      return out;
    }
  }

  chatRequest({ messages, tools }) {
    const req = { model: this.model, messages };
    if (tools) {
      req.tools = tools;
      req.tool_choice = 'auto';
    }
    if (this.temperature !== undefined) req.temperature = this.temperature;
    if (this.maxTokens) req.max_tokens = this.maxTokens;
    return req;
  }
}

// Judge verdict schema (strict json_schema — the provider guarantees the
// shape, so no prose parsing on the happy path).
export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['pass', 'reason'],
  additionalProperties: false,
};

export const JUDGE_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'eval_verdict', strict: true, schema: JUDGE_SCHEMA },
};

export const llmJudgeSystem = 'You are a strict evaluator of an AI assistant\'s behavior. '
  + 'Given pass criteria and what the assistant did, decide whether it PASSES.';

// completeJSON issues a single non-tool completion for the LLM judge. It sends
// response_format json_schema first; when the provider rejects it (some judge
// models — deepseek/qwen/gemini compat layers — lack json_schema), it retries
// once without the format and with a fenced-JSON instruction, and the caller
// extracts the object from prose.
export async function completeJSON(client, system, user, signal) {
  const base = client.chatRequest({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  try {
    const out = await client.chat({ ...base, response_format: JUDGE_RESPONSE_FORMAT }, signal);
    return { text: (out.choices[0].message.content || '').trim(), structured: true };
  } catch (e) {
    if (!(e instanceof ChatAPIError) || !/response_format/i.test(e.body || e.message)) throw e;
  }
  const fallback = client.chatRequest({
    messages: [
      {
        role: 'system',
        content: `${system}\nReply with ONLY a compact JSON object and nothing else: {"pass": true|false, "reason": "<short>"}.`,
      },
      { role: 'user', content: user },
    ],
  });
  const out = await client.chat(fallback, signal);
  return { text: (out.choices[0].message.content || '').trim(), structured: false };
}

export class Agent {
  constructor(client, maxRounds) {
    this.client = client;
    this.maxRounds = maxRounds > 0 ? maxRounds : 8;
  }

  // Run executes the bounded tool-calling loop for one task. runner is
  // { runTool(name, args) -> { result, isError } }. tools are OpenAI chat
  // tool specs ({type:'function', function:{name, description, parameters}}).
  async run(task, tools, runner, signal) {
    const messages = [
      { role: 'system', content: systemPromptUnderTest },
      { role: 'user', content: task },
    ];
    const run = {
      task, finalText: '', trajectory: [], rounds: 0,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      truncated: false,
    };

    for (let round = 0; round < this.maxRounds; round++) {
      run.rounds = round + 1;
      const resp = await this.client.chat(this.client.chatRequest({ messages, tools }), signal);
      const u = resp.usage || {};
      run.usage.prompt_tokens += u.prompt_tokens || 0;
      run.usage.completion_tokens += u.completion_tokens || 0;
      run.usage.total_tokens += u.total_tokens || 0;

      const msg = resp.choices[0].message || {};
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        run.finalText = (msg.content || '').trim();
        return run;
      }

      // Echo the assistant turn verbatim (reasoning_content included: with it
      // stripped, qwen3.5-9b returns empty content and stops — it relies on
      // its own prior thinking being in context), then execute each call.
      const echoed = { role: 'assistant', content: msg.content || '' };
      if (msg.reasoning_content) echoed.reasoning_content = msg.reasoning_content;
      echoed.tool_calls = msg.tool_calls;
      messages.push(echoed);

      for (const tc of msg.tool_calls) {
        let args = tc.function && tc.function.arguments ? tc.function.arguments : '{}';
        if (!args) args = '{}';
        const started = Date.now();
        let result;
        let isErr = false;
        try {
          const r = await runner.runTool(tc.function.name, args);
          result = r.result;
          isErr = !!r.isError;
        } catch (e) {
          // Surface dispatch errors to the model rather than aborting, so it
          // can recover; also recorded in the trajectory.
          result = `tool dispatch error: ${e.message}`;
          isErr = true;
        }
        run.trajectory.push({
          name: tc.function.name, args, result, is_error: isErr, duration_ms: Date.now() - started,
        });
        messages.push({
          role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: isErr ? `ERROR: ${result}` : result,
        });
      }
    }

    run.truncated = true;
    return run;
  }
}
