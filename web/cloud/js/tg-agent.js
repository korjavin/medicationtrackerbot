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
- Discover what you can do with the mcp_help tool. Call it with no arguments for the catalog, or with a short "query" to search (e.g. "blood pressure", "log food").
- Run exactly one operation per mcp_call. Put the operation's arguments in "params". For a WRITE (logging/creating/updating/deleting) you MUST pass mode:"write" and a short "intent".
- To LOG FOOD from a free-text description, prefer the food description/AI operation if one exists; do not invent macros.
- Only act on what the user actually said. If they just chat or greet, reply briefly without calling tools. Never fabricate data you did not read.
- Keep your final reply short and plain (a sentence or two, no markdown) — it is shown as a Telegram message.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'mcp_help',
      description: 'Discover available health-data operations. No arguments returns the full catalog; pass a "query" to search it.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'optional search terms' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_call',
      description: 'Run ONE health-data operation discovered via mcp_help.',
      parameters: {
        type: 'object',
        properties: {
          operation_id: { type: 'string', description: 'the operation id from mcp_help' },
          params: { type: 'object', description: 'the operation arguments (query + body fields)' },
          path_params: { type: 'object', description: 'values for {slot} path segments, e.g. {"id": 42}' },
          mode: { type: 'string', enum: ['read_only', 'write'], description: 'use "write" for any create/update/delete' },
          intent: { type: 'string', description: 'one short line stating why, required for writes' },
        },
        required: ['operation_id'],
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

export function createTGAgent({ chat, dispatcher, prefs = NOOP_PREFS, maxRounds = DEFAULT_MAX_ROUNDS }) {
  async function execTool(call) {
    const name = call.function && call.function.name;
    const args = parseArgs(call.function && call.function.arguments);
    try {
      if (name === 'mcp_help') {
        return await dispatcher.handle('mcp_help', args.query ? { query: args.query } : {});
      }
      if (name === 'mcp_call') {
        return await dispatcher.handle('mcp_call', {
          operation_id: args.operation_id,
          params: args.params || {},
          path_params: args.path_params || {},
          mode: args.mode,
          intent: args.intent,
        });
      }
      return { error: `unknown tool "${name}"` };
    } catch (e) {
      // Surface the error to the model, don't throw — self-correction beats abort.
      return { error: e && e.message ? e.message : String(e) };
    }
  }

  // run drives the conversation and returns the model's final plain-text answer
  // (may be empty if the model chose to stay silent).
  async function run(userText) {
    const note = (await prefs.get()) || '';
    const systemContent = note
      ? `${SYSTEM_PROMPT}\n\nWhat you already know about how THIS user talks (apply it when interpreting them):\n${note}`
      : SYSTEM_PROMPT;
    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: userText },
    ];

    for (let round = 0; round < maxRounds; round++) {
      const msg = await chat({ messages, tools: TOOLS });
      messages.push(msg);
      const calls = (msg && msg.tool_calls) || [];
      if (!calls.length) return (msg && msg.content ? String(msg.content) : '').trim();
      for (const call of calls) {
        const result = await execTool(call);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }

    // Ran the round budget out mid-tool-use. Force a final plain answer with no
    // tools so the user gets a reply instead of a dangling "Queued".
    const final = await chat({
      messages: [...messages, { role: 'user', content: 'Now answer me in one or two plain sentences based on what you did.' }],
    });
    return (final && final.content ? String(final.content) : '').trim();
  }

  return { run };
}
