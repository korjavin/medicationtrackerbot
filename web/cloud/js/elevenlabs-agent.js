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
export const TOOLSET_VERSION = 1;

const VOICE_ID = 'cjVigY5qzO86Huf0OWal';

const SYSTEM_PROMPT = [
  'You are the MedTracker voice assistant. The user tracks their own health data',
  '(blood pressure, weight, diary notes) in this app.',
  '',
  'You have tools that read and write that data. ALWAYS call a tool for any',
  'question about the data — never say you cannot access it, never guess.',
  '- Blood pressure questions → call get_blood_pressure; to record one → log_blood_pressure.',
  '- Weight questions → call get_weight; to record one → log_weight.',
  '- Diary/notes questions → call get_notes; to add one → add_note.',
  '',
  'Confirm what you recorded back to the user. Keep replies short and spoken-friendly.',
].join('\n');

const FIRST_MESSAGE = "Hi, I'm your MedTracker assistant. Ask me about your blood pressure, weight, or notes.";

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
        tag: { type: 'string', description: 'optional: one of SLEEP, STRESS, HR, SPO2, STEPS, NOTE' },
      },
      required: ['text'],
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

export function createElevenLabsAgentProvisioner({ settingsDomain }) {
  async function apiKey() {
    const { elevenlabs } = await settingsDomain.readIntegrationsUnmasked();
    if (!elevenlabs || !elevenlabs.api_key) {
      throw new Error('Set your ElevenLabs API key in Settings → Integrations');
    }
    return elevenlabs.api_key;
  }

  function toolBody(spec) {
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

  // ensureTools returns a { name → id } map for every TOOL_SPECS entry. It only
  // runs during a (re)provision (provision() short-circuits when the stored
  // version matches), so it PATCHes tools that already exist by name — otherwise
  // a TOOLSET_VERSION bump that edits a spec (params/description) would never
  // reach accounts that already created the tool. Missing tools are created.
  async function ensureTools(key) {
    const listResp = await fetch(TOOLS_ENDPOINT, { method: 'GET', headers: headers(key) });
    if (!listResp.ok) throw await toError(listResp, 'tool list');
    const listData = await listResp.json();
    const existing = Array.isArray(listData) ? listData : (listData.tools || []);
    const byName = new Map();
    for (const t of existing) {
      const name = t && t.tool_config && t.tool_config.name;
      if (name) byName.set(name, t.id);
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
    }
    return map;
  }

  function agentConfig(toolIds) {
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

  // ensureAgent reuses the stored agent when its toolset version matches; else
  // it PATCHes a user-preset agent id, or creates a fresh one. Persists the
  // provisioned state to the vault and returns the agent id.
  async function ensureAgent(key, toolMap) {
    const toolIds = TOOL_SPECS.map((s) => toolMap[s.name]).filter(Boolean);
    const stored = await settingsDomain.getVoiceProvisioning();
    const { elevenlabs } = await settingsDomain.readIntegrationsUnmasked();
    const presetId = (elevenlabs && elevenlabs.agent_id) || stored.agentId || '';
    const config = agentConfig(toolIds);

    let agentId;
    if (presetId) {
      const resp = await fetch(`${AGENTS_ENDPOINT}/${encodeURIComponent(presetId)}`, {
        method: 'PATCH', headers: headers(key), body: JSON.stringify(config),
      });
      if (!resp.ok) throw await toError(resp, 'update agent');
      agentId = presetId;
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
