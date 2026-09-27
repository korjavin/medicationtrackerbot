// Drain-time AI agent for free-text Telegram messages (bd med-vcv.2). A message
// like "I ate two eggs" or "what was my BP this week?" is sealed by the relay
// (which parses nothing) and, at drain, handed here: an OpenAI tool-calling loop
// runs ON THIS unlocked tab with the user's own key, using the cloud MCP catalog
// as dynamic tools, so the model decides whether to log something, read data to
// answer, or just reply. The relay never sees the parse — same zero-knowledge
// posture as /food (docs/cloud-mode.md → "Inbound plaintext").
//
// Two tools by design (the cloud MCP surface is discover-then-call, med-csu.4):
// mcp_help to discover the 97 catalogued ops, mcp_call to run one. That scales
// to the whole catalog with two tool definitions instead of 97.
//
// Ports are injected so this is runtime-agnostic and testable:
//   chat({ messages, tools })  -> the raw assistant message (content+tool_calls)
//   dispatcher.handle(method, params) -> the cloud MCP responder
// No browser globals here.

const DEFAULT_MAX_ROUNDS = 5;

const SYSTEM_PROMPT = `You are a health-tracking assistant reachable over Telegram chat. The user texts you in natural language to log health data (food, blood pressure, weight, medications, workouts, notes) or to ask about their own data.

How to work:
- Use mcp_help to find operations and mcp_call to run them.
- To log food from a free-text description, call food.log.from_description — it estimates the macros, so don't compute them yourself.
- Only act on what the user actually said. If they just chat or greet, reply briefly without calling tools. Never fabricate data you did not read.
- When the user reveals a durable shorthand or term mapping worth applying next time (e.g. "by 'my usual' I mean 2 eggs and toast"), call remember_preference once with a single concise line. Only durable phrasing — not per-message content, not health-data values.
- Your final reply is sent as a plain-text Telegram message: keep it short, no markdown.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'mcp_help',
      description: 'Search the catalog of health-data operations this app supports. No arguments returns a terse catalog grouped by topic; "query" keyword-searches it; "topic" filters to one area; "operation_id"/"operation_ids" return full params/body schemas. Returns operations, not data — run one with mcp_call. Every response includes current_time; use it for relative dates.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'optional search terms' },
          topic: { type: 'string', description: 'optional topic filter, e.g. "food"' },
          operation_id: { type: 'string', description: 'return the full schema of this operation' },
          operation_ids: { type: 'array', items: { type: 'string' }, description: 'return full schemas of several operations' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_call',
      description: 'Run exactly one operation from mcp_help and return its JSON result. Reads use mode "read_only" (the default). Any create/update/delete needs mode "write" and a one-line intent, otherwise the call is rejected with an error explaining what is missing. Errors come back as {error} so you can correct the arguments and retry.',
      parameters: {
        type: 'object',
        properties: {
          operation_id: { type: 'string', description: 'the operation id from mcp_help' },
          params: { type: 'object', description: 'the operation arguments (query + body fields)' },
          path_params: { type: 'object', description: 'values for {slot} path segments, e.g. {"id": 42}' },
          body: { type: 'object', description: 'request body fields (merged with params)' },
          mode: { type: 'string', enum: ['read_only', 'write'], description: 'use "write" for any create/update/delete' },
          intent: { type: 'string', description: 'one short line stating why, required for writes' },
        },
        required: ['operation_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_preference',
      description: 'Record ONE short durable phrasing or term mapping about how this user talks (e.g. \'"my usual" = 2 eggs + toast\'). Not per-message content or health-data values. Returns {ok:true}; the note is shown to future conversations with this user.',
      parameters: {
        type: 'object',
        properties: { note: { type: 'string', description: 'one concise line' } },
        required: ['note'],
      },
    },
  },
];

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

// createTGAgent wires the loop over injected ports. dispatcher.handle throws
// MCPError on a bad op/arg; we hand the error text back to the model as the tool
// result so it can self-correct rather than aborting the whole turn.
const NOOP_PREFS = { get: async () => '', append: async () => {} };
// history carries the recent conversation so a follow-up ("and last week?") has
// something to refer to (bd med-48x). Plain text only — see run().
const NOOP_HISTORY = { get: async () => [], append: async () => {} };

export function createTGAgent({ chat, dispatcher, prefs = NOOP_PREFS, history = NOOP_HISTORY, maxRounds = DEFAULT_MAX_ROUNDS }) {
  async function execTool(call) {
    const name = call.function && call.function.name;
    const args = parseArgs(call.function && call.function.arguments);
    try {
      if (name === 'mcp_help') {
        return await dispatcher.handle('mcp_help', args || {});
      }
      if (name === 'mcp_call') {
        return await dispatcher.handle('mcp_call', {
          operation_id: args.operation_id,
          params: args.params || {},
          path_params: args.path_params || {},
          body: args.body || {},
          mode: args.mode,
          intent: args.intent,
        });
      }
      if (name === 'remember_preference') {
        const line = args.note ? String(args.note).trim() : '';
        if (!line) return { error: 'note is required' };
        await prefs.append(line);
        return { ok: true };
      }
      return { error: `unknown tool "${name}"` };
    } catch (e) {
      // Surface the error to the model, don't throw — self-correction beats abort.
      return { error: e && e.message ? e.message : String(e) };
    }
  }

  // run drives the conversation and returns the model's final plain-text answer
  // (may be empty if the model chose to stay silent). atMs is when the user
  // SENT the message, not when this drain runs — a backlog drained after the tab
  // was closed applies days of messages within one second, and aging the history
  // by the drain clock would make all of them look like one live conversation.
  // Same convention as every other inbound MESSAGE kind: at_unix is the
  // message's own Telegram date (tgclient.Message.AtUnix), not the drain's and
  // not the webhook's. Callback-query taps are the exception — they hang off the
  // bot's OWN reminder, so they keep the relay's tap clock.
  async function run(userText, atMs) {
    const note = (await prefs.get()) || '';
    const systemContent = note
      ? `${SYSTEM_PROMPT}\n\nWhat you already know about how THIS user talks (apply it when interpreting them):\n${note}`
      : SYSTEM_PROMPT;
    // Prior turns go in as plain alternating user/assistant messages. Never the
    // tool rounds: an assistant message with tool_calls and no matching
    // role:'tool' replies is a 400 from the provider, i.e. chat breaks outright.
    const past = (await history.get(atMs)) || [];
    const messages = [
      { role: 'system', content: systemContent },
      ...past.flatMap((t) => [
        { role: 'user', content: String(t.user || '') },
        { role: 'assistant', content: String(t.assistant || '') },
      ]),
      { role: 'user', content: userText },
    ];

    // A blank answer carries nothing forward, so it is not worth a turn.
    const finish = async (answer) => {
      if (answer) await history.append(userText, answer, atMs);
      return answer;
    };

    for (let round = 0; round < maxRounds; round++) {
      const msg = await chat({ messages, tools: TOOLS });
      messages.push(msg);
      const calls = (msg && msg.tool_calls) || [];
      if (!calls.length) return finish((msg && msg.content ? String(msg.content) : '').trim());
      for (const call of calls) {
        const result = await execTool(call);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }

    // Ran the round budget out mid-tool-use. Force a final plain answer with no
    // tools so the user gets a reply instead of a dangling "Queued".
    const final = await chat({
      messages: [...messages, { role: 'user', content: 'Now reply to me in plain text, briefly, with what you did.' }],
    });
    return finish((final && final.content ? String(final.content) : '').trim());
  }

  return { run };
}
