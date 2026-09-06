// Browser-direct ElevenLabs agent + tool provisioner for cloud mode. The user
// sets only their ElevenLabs API key in Settings → Integrations; on the first
// voice connect this module creates the client tools and a MedTracker agent
// (wired to those tools) entirely from code against api.elevenlabs.io using the
// vault key — the BYO / CORS-open pattern (mirrors elevenlabs-signed-url.js and
// aiclient.js). Nothing ever crosses /api, no ElevenLabs dashboard steps.
//
// Idempotent: the provisioned agent id + tool ids + a TOOLSET_VERSION are
// stored in the vault; reprovisioning happens only when the stored version
// differs (first run, or we bumped the toolset below).

const TOOLS_ENDPOINT = 'https://api.elevenlabs.io/v1/convai/tools';
const AGENTS_ENDPOINT = 'https://api.elevenlabs.io/v1/convai/agents';

// Bump this whenever TOOL_SPECS or the agent config below changes so unlocked
// devices reprovision on their next connect.
export const TOOLSET_VERSION = 4;

// Rachel — a warm ElevenLabs female voice (med-eas.27).
const VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

// Adapted from the owner's "Silas" concierge persona (med-eas.27) — trimmed to
// our actual tools (BP / weight / notes) and kept concise for voice.
const SYSTEM_PROMPT = [
  "You are Silas, the user's personal health concierge in this app, where they",
  'track their own health — blood pressure, weight, workouts, medications,',
  'food, sleep and diary notes. You are grounded, observant, and quietly',
  'encouraging — you offer brief, insightful reflections, not commands, and you',
  'look for the story behind the numbers. Precise, never clinical.',
  '',
  "Answer every question about the user's data by calling a tool — the data lives only behind them:",
  "- Workouts → get_workout to read today's session and its exercises,",
  '  log_exercise to record the actual sets/reps/weight on one of them, and',
  '  set_workout_status to start, finish or skip the session. To change anything',
  '  about a workout you MUST call get_workout first — it returns the session id',
  '  and, per exercise, a log_id and an exercise_id that the write tools need.',
  '  If the session it returns is not for today, start it before logging into it.',
  '- Anything without a dedicated tool — medications, food, sleep, vitals, statistics, settings —',
  '  call mcp_help to find the operation you need, then mcp_call to run it. Do',
  '  that instead of saying you cannot do something, and never file one kind of',
  '  record as a diary note just because add_note was the tool that fit.',
  '',
  'After recording something, confirm it back in one short line. When you read',
  'data, add a brief bit of context if useful — a gentle comparison or observation.',
  '',
  'Be concise: short, warm, spoken-friendly sentences, no filler. Never judge the',
  "user's choices or numbers; if something is off, point to the next small best",
  'step. You give reflections, not medical advice or diagnoses. Do not mention',
  'being an AI.',
].join('\n');

const FIRST_MESSAGE = 'Silas here. Would you like to log a reading, or take a look at your numbers?';

// Fixed tool spec list. Each name matches a clientTools callback registered in
// web/static/js/features/elevenlabs-call.js buildClientTools(), which maps it
// 1:1 to a CloudMCPDispatcher catalog op. Params are flat typed values —
// ElevenLabs client tools do not support nested objects, and voice LLMs drive
// concrete tools more reliably than a generic mcp_call.
export const TOOL_SPECS = [
  {
    name: 'get_blood_pressure',
    description: "Get the user's recent blood pressure readings, newest first.",
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'lookback window in days (default 30)' },
      },
      required: [],
    },
  },
  {
    name: 'log_blood_pressure',
    description: 'Record a new blood pressure reading (now).',
    parameters: {
      type: 'object',
      properties: {
        systolic: { type: 'integer', description: 'systolic (top) number, e.g. 120' },
        diastolic: { type: 'integer', description: 'diastolic (bottom) number, e.g. 80' },
        pulse: { type: 'integer', description: 'optional pulse in bpm' },
      },
      required: ['systolic', 'diastolic'],
    },
  },
  {
    name: 'get_weight',
    description: "Get the user's recent weight entries, newest first.",
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'lookback window in days (default 30)' },
      },
      required: [],
    },
  },
  {
    name: 'log_weight',
    description: 'Record a new weight entry (now).',
    parameters: {
      type: 'object',
      properties: {
        kg: { type: 'number', description: 'weight in kilograms' },
      },
      required: ['kg'],
    },
  },
  {
    name: 'get_notes',
    description: "Get the user's recent diary notes, newest first.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'add_note',
    description: 'Add a diary note.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'note content' },
        tag: { type: 'string', enum: ['SLEEP', 'STRESS', 'HR', 'SPO2', 'STEPS', 'NOTE'], description: 'optional note category' },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_workout',
    description: "Get the user's current or next workout session together with its planned "
      + 'exercises. Returns the session id, its status, and one row per exercise with its log '
      + 'id, name, planned targets and what has been logged so far. Call this before any other '
      + 'workout tool — log_exercise and set_workout_status need the ids it returns.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'log_exercise',
    description: 'Record what the user actually did on one exercise of the current workout: '
      + 'sets, reps, weight, notes, or mark it skipped. Identify the exercise with the log_id '
      + 'from its get_workout row, or with its exercise_id when that row shows log_id 0 '
      + '(a planned exercise nothing has been logged against yet).',
    parameters: {
      type: 'object',
      properties: {
        log_id: { type: 'integer', description: "the exercise's log id from get_workout; 0 if it has none yet" },
        exercise_id: { type: 'integer', description: 'exercise id from get_workout; use this when log_id is 0' },
        sets: { type: 'integer', description: 'sets actually completed' },
        reps: { type: 'integer', description: 'reps actually completed per set' },
        weight_kg: { type: 'number', description: 'weight used, in kilograms' },
        notes: { type: 'string', description: 'optional short note about this exercise' },
        status: { type: 'string', enum: ['completed', 'skipped'], description: 'optional: mark the exercise done or deliberately skipped' },
      },
      required: [],
    },
  },
  {
    name: 'set_workout_status',
    description: 'Start, finish or skip a whole workout session. Use the session id from get_workout.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'integer', description: 'workout session id, from get_workout' },
        status: { type: 'string', enum: ['in_progress', 'completed', 'skipped'], description: 'new session status' },
      },
      required: ['session_id', 'status'],
    },
  },
  // Parity surface (med-eas.82, widened scope): the concrete tools above cover
  // the high-frequency paths, these two reach the rest of the MCP catalog — the
  // same operations the Claude connector gets. ElevenLabs client tools take flat
  // scalars only, so the nested `params` / `path_params` objects travel as JSON
  // strings the callback parses (buildClientTools in elevenlabs-call.js).
  {
    name: 'mcp_help',
    description: 'Discover the operations this app exposes. Call it with query to keyword-search '
      + '("blood pressure"), or topic to browse one area, then call it again with operation_id to '
      + "get that operation's exact parameters before running it with mcp_call. With no arguments "
      + 'it returns the whole catalog in terse form, which is long — prefer query or topic.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keyword search over the catalog, e.g. "sleep"' },
        topic: { type: 'string', description: 'browse one area, e.g. "workouts", "food", "meds"' },
        operation_id: {
          type: 'string',
          description: 'full schema for one operation, e.g. "food.log.create" — do this before any mcp_call you are unsure about',
        },
      },
      required: [],
    },
  },
  {
    name: 'mcp_call',
    description: "Run any operation from mcp_help against the user's health data — medications, "
      + 'food, sleep, vitals, statistics, settings, and everything else the concrete tools do '
      + 'not cover.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'operation id from mcp_help, e.g. "food.log.list"' },
        params_json: {
          type: 'string',
          description: 'the operation\'s parameters as a JSON object encoded in a string, e.g. {"days": 7}. Omit or "{}" when it takes none.',
        },
        mode: { type: 'string', enum: ['read_only', 'write'], description: '"write" for any operation that changes data; omit for reads' },
        intent: { type: 'string', description: 'required with mode "write": one short line on why, e.g. "user asked during a voice call"' },
        path_params_json: {
          type: 'string',
          description: 'only for operations whose path contains a {slot}: a JSON object encoded in a string, e.g. {"id": 42}',
        },
      },
      required: ['op'],
    },
  },
];

function headers(apiKey) {
  return { 'xi-api-key': apiKey, 'content-type': 'application/json' };
}

// Turn an ElevenLabs error response into a clear, user-facing message.
async function toError(resp, action) {
  let detail = '';
  try {
    const body = await resp.text();
    detail = body ? ` — ${body.slice(0, 300)}` : '';
  } catch { /* ignore */ }
  let msg;
  if (resp.status === 401) msg = 'Invalid ElevenLabs API key — check Settings → Integrations';
  else if (resp.status === 429) msg = 'ElevenLabs quota or rate limit reached — try again later';
  else msg = `ElevenLabs ${action} failed (${resp.status})`;
  const err = new Error(msg + detail);
  err.status = resp.status;
  return err;
}

export function toolBody(spec) {
  return {
    tool_config: {
      type: 'client',
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      // Blocking: the agent waits for and reads the callback's return value.
      // ElevenLabs client tools default to fire-and-forget, so without this
      // the get_* reads would return data the agent never consumes. (The
      // prior hand-configured tools set this via the dashboard's "blocking"
      // toggle.) Verify the field name against the live API during
      // acceptance, like tool_call_sound.
      expects_response: true,
    },
  };
}

// ensureTools returns a { name → id } map for every TOOL_SPECS entry, resolved
// by tool NAME against the account's own tool list — tool ids are per-ElevenLabs
// account, so nothing may assume a stored id. On the BYO path it only runs
// during a (re)provision (provision() short-circuits when the stored version
// matches), so it PATCHes tools that already exist by name — otherwise a
// TOOLSET_VERSION bump that edits a spec (params/description) would never reach
// accounts that already created the tool. Missing tools are created.
//
// Module-scope and exported because the trial agent is provisioned by an
// operator script with no vault (scripts/provision-trial-agent.mjs); onEvent is
// its progress seam ('created' | 'updated', tool name).
export async function ensureTools(key, onEvent) {
  const report = typeof onEvent === 'function' ? onEvent : () => {};
  const byName = new Map();
  // GET /tools returns 30 per page by default and includes tools SHARED with
  // the account. Both defaults are traps here: an unseen later page makes an
  // existing tool look missing (so we mint a duplicate on every run, and wire
  // the agent to the copy), and a shared tool with a colliding name would be
  // PATCHed even though we do not own it. Page through everything, own tools
  // only (`@me` supersedes the deprecated show_only_owned_documents).
  let cursor = '';
  for (;;) {
    const q = new URLSearchParams({ page_size: '100', created_by_user_id: '@me' });
    if (cursor) q.set('cursor', cursor);
    const listResp = await fetch(`${TOOLS_ENDPOINT}?${q.toString()}`, { method: 'GET', headers: headers(key) });
    if (!listResp.ok) throw await toError(listResp, 'tool list');
    const listData = await listResp.json();
    const page = Array.isArray(listData) ? listData : (listData.tools || []);
    for (const t of page) {
      const name = t && t.tool_config && t.tool_config.name;
      if (name && !byName.has(name)) byName.set(name, t.id);
    }
    const next = (!Array.isArray(listData) && listData.has_more && listData.next_cursor) || '';
    if (!next || next === cursor) break;
    cursor = next;
  }

  const map = {};
  for (const spec of TOOL_SPECS) {
    const existingId = byName.get(spec.name);
    if (existingId) {
      // Update the existing tool in place so edited specs propagate. PATCH
      // endpoint shape verified against the live API during acceptance.
      const resp = await fetch(`${TOOLS_ENDPOINT}/${encodeURIComponent(existingId)}`, {
        method: 'PATCH', headers: headers(key), body: JSON.stringify(toolBody(spec)),
      });
      if (!resp.ok) throw await toError(resp, `update tool ${spec.name}`);
      map[spec.name] = existingId;
      report('updated', spec.name);
      continue;
    }
    const resp = await fetch(TOOLS_ENDPOINT, { method: 'POST', headers: headers(key), body: JSON.stringify(toolBody(spec)) });
    if (!resp.ok) throw await toError(resp, `create tool ${spec.name}`);
    const created = await resp.json();
    // Guard the id like ensureAgent guards agent_id: a missing id would
    // otherwise be silently dropped by ensureAgent's filter(Boolean), leaving
    // the agent wired to fewer tools with no diagnostic.
    if (!created.id) throw new Error(`ElevenLabs create tool ${spec.name} response missing id`);
    map[spec.name] = created.id;
    report('created', spec.name);
  }
  return map;
}

// buildAgentConfig is the single source of truth for the agent body — persona,
// first message, voice, tool wiring. BOTH the BYO path (ensureAgent below) and
// the operator's trial-agent script consume it, so a prompt change reaches the
// shared trial agent on the next `pnpm trial:agent` instead of quietly diverging
// (bd med-qgnk).
export function buildAgentConfig(toolIds) {
  return {
    conversation_config: {
      agent: {
        prompt: { prompt: SYSTEM_PROMPT, tool_ids: toolIds },
        first_message: FIRST_MESSAGE,
        language: 'en',
        // Audible cue when the agent calls a tool (owner UX request). Nesting
        // verified against the live API during acceptance.
        tool_call_sound: 'typing',
        tool_call_sound_behavior: 'always',
      },
      tts: { voice_id: VOICE_ID },
    },
  };
}

// GET an agent by id. The trial script preflights with this so a mistyped or
// foreign TRIAL_ELEVENLABS_AGENT_ID fails BEFORE any tool is created or
// PATCHed, rather than after the account's tools have already been rewritten.
export async function fetchAgent(key, agentId) {
  const resp = await fetch(`${AGENTS_ENDPOINT}/${encodeURIComponent(agentId)}`, {
    method: 'GET', headers: headers(key),
  });
  if (!resp.ok) throw await toError(resp, 'read agent');
  return resp.json();
}

// PATCH an existing agent in place. Shared with the trial script, which must
// never create an agent: TRIAL_ELEVENLABS_AGENT_ID is baked into the deployed
// server's config, so a fresh id would silently strand every trial user.
export async function patchAgent(key, agentId, config) {
  const resp = await fetch(`${AGENTS_ENDPOINT}/${encodeURIComponent(agentId)}`, {
    method: 'PATCH', headers: headers(key), body: JSON.stringify(config),
  });
  if (!resp.ok) throw await toError(resp, 'update agent');
  return agentId;
}

export function createElevenLabsAgentProvisioner({ settingsDomain }) {
  async function apiKey() {
    const { elevenlabs } = await settingsDomain.readIntegrationsUnmasked();
    if (!elevenlabs || !elevenlabs.api_key) {
      throw new Error('Set your ElevenLabs API key in Settings → Integrations');
    }
    return elevenlabs.api_key;
  }

  // ensureAgent reuses the stored agent when its toolset version matches; else
  // it PATCHes a user-preset agent id, or creates a fresh one. Persists the
  // provisioned state to the vault and returns the agent id.
  async function ensureAgent(key, toolMap) {
    const toolIds = TOOL_SPECS.map((s) => toolMap[s.name]).filter(Boolean);
    const stored = await settingsDomain.getVoiceProvisioning();
    const { elevenlabs } = await settingsDomain.readIntegrationsUnmasked();
    const presetId = (elevenlabs && elevenlabs.agent_id) || stored.agentId || '';
    const config = buildAgentConfig(toolIds);

    let agentId;
    if (presetId) {
      agentId = await patchAgent(key, presetId, config);
    } else {
      const resp = await fetch(`${AGENTS_ENDPOINT}/create`, {
        method: 'POST', headers: headers(key), body: JSON.stringify(config),
      });
      if (!resp.ok) throw await toError(resp, 'create agent');
      const created = await resp.json();
      agentId = created.agent_id;
      if (!agentId) throw new Error('ElevenLabs create agent response missing agent_id');
    }

    await settingsDomain.setVoiceProvisioning({ agentId, toolsetVersion: TOOLSET_VERSION, toolIds: toolMap });
    return agentId;
  }

  // provision orchestrates ensureTools → ensureAgent and returns the agent id
  // the signed-URL client should use.
  async function provision() {
    // Already provisioned at this toolset version → reuse without touching the
    // ElevenLabs API (the key is validated later when minting the signed URL).
    const stored = await settingsDomain.getVoiceProvisioning();
    if (stored.agentId && stored.toolsetVersion === TOOLSET_VERSION) {
      return stored.agentId;
    }
    const key = await apiKey();
    const toolMap = await ensureTools(key);
    return ensureAgent(key, toolMap);
  }

  return { provision, ensureTools, ensureAgent };
}
