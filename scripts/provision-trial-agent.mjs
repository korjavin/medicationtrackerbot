#!/usr/bin/env node
// Pushes TOOL_SPECS + the shared agent config onto the OPERATOR'S trial
// ElevenLabs agent (bd med-qgnk).
//
//   pnpm trial:agent            # dry run: prints the payload, calls nothing
//   pnpm trial:agent --apply    # really rewrites the shared trial agent
//
// The BYO path provisions itself from code on the next voice connect
// (web/cloud/js/elevenlabs-agent.js, keyed by TOOLSET_VERSION), but the trial
// agent lives in the operator's own ElevenLabs account and nothing in the
// server touches the management API. Re-run this after every TOOLSET_VERSION
// bump or trial users keep the old tool list — exactly the drift that stranded
// them in #817. It is NOT automatic.
//
// Credentials come from the same envs cmd/cloud reads
// (internal/cloudserver/trial.go): TRIAL_ELEVENLABS_API_KEY and
// TRIAL_ELEVENLABS_AGENT_ID. The key is never printed. TRIAL_VOICE_LLM_URL is
// the agent's custom LLM base — the voice LLM relay on the base domain,
// https://<base-domain>/api/voice-llm (bd med-h849); ElevenLabs POSTs
// <url>/chat/completions with the per-call relay token, plus the
// X-Voice-Relay-Secret header when TRIAL_VOICE_RELAY_SECRET is set (bd med-k80h).
import {
  TOOL_SPECS,
  TOOLSET_VERSION,
  buildAgentConfig,
  ensureTools,
  fetchAgent,
  patchAgent,
  toolBody,
} from '../web/cloud/js/elevenlabs-agent.js';

const argv = process.argv.slice(2);
const unknown = argv.filter((a) => a !== '--apply' && a !== '--dry-run');
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(' ')}\nUsage: pnpm trial:agent [--apply|--dry-run]`);
  process.exit(2);
}
if (argv.includes('--apply') && argv.includes('--dry-run')) {
  console.error('--apply and --dry-run are alternatives. Refusing rather than guessing which you meant.');
  process.exit(2);
}
const apply = argv.includes('--apply');

const agentId = process.env.TRIAL_ELEVENLABS_AGENT_ID || '';
const apiKey = process.env.TRIAL_ELEVENLABS_API_KEY || '';
const llmURL = process.env.TRIAL_VOICE_LLM_URL || '';
// Same instance name used by cmd/cloud for the privacy page and app metadata.
const productName = process.env.PRIVACY_NAME || undefined;
// TRIAL_VOICE_RELAY_SECRET (bd med-k80h): the same value cmd/cloud reads. The
// agent sends it as X-Voice-Relay-Secret on every custom-LLM POST and the relay
// requires it on anonymous calls once the server has it set. Never printed.
const relaySecret = process.env.TRIAL_VOICE_RELAY_SECRET || '';
const llmHeaders = (secret) => (secret ? { 'X-Voice-Relay-Secret': secret } : undefined);
// ElevenLabs-side per-call cap on the SHARED trial agent (bd med-o7zq.22): the
// hard backstop under the server's anonymous voice budget, which charges each
// call its whole grant — keep it at or below TRIAL_ANON_VOICE_CALL_MAX_SECONDS
// (default 120) so one anonymous session never outlasts what it paid for. It
// also caps account trial calls. BYO agents never get it.
const maxCallRaw = process.env.TRIAL_VOICE_MAX_CALL_SECONDS || '120';
const maxDurationSeconds = Number(maxCallRaw);
if (!/^[1-9][0-9]*$/.test(maxCallRaw)) {
  console.error('TRIAL_VOICE_MAX_CALL_SECONDS must be a positive integer (seconds). Refusing.');
  process.exit(2);
}
// An abandoned trial session (app gone, phone in a pocket) ends after this
// much user silence instead of running to the cap: turn.silence_end_call_timeout
// (ElevenLabs default -1 = never; https://elevenlabs.io/docs/api-reference/agents/update).
const SILENCE_END_CALL_SECONDS = 30;

if (!apply) {
  // Dry run is a payload preview, so it deliberately needs no credentials and
  // makes no network call — the whole point is being able to read what an apply
  // WOULD write to a live shared production agent.
  console.log(`TOOLSET_VERSION ${TOOLSET_VERSION} — ${TOOL_SPECS.length} tools`);
  console.log(`target agent: ${agentId || '(TRIAL_ELEVENLABS_AGENT_ID unset — --apply would refuse)'}`);
  console.log(`TRIAL_VOICE_LLM_URL: ${llmURL || '(unset — --apply would refuse)'}`);
  console.log(`TRIAL_VOICE_MAX_CALL_SECONDS: ${maxDurationSeconds}`);
  console.log(`TRIAL_VOICE_RELAY_SECRET: ${relaySecret ? '(set)' : '(unset — the agent would send no X-Voice-Relay-Secret)'}`);
  console.log('\n--- tools (one PATCH-or-POST per tool, matched by name) ---');
  for (const spec of TOOL_SPECS) console.log(JSON.stringify(toolBody(spec)));
  console.log('\n--- agent PATCH body (tool ids resolved at apply time) ---');
  const previewURL = llmURL || '<TRIAL_VOICE_LLM_URL>';
  const previewHeaders = llmHeaders(relaySecret && '<TRIAL_VOICE_RELAY_SECRET>');
  console.log(JSON.stringify(buildAgentConfig(TOOL_SPECS.map((s) => `<id:${s.name}>`), { productName, llmURL: previewURL, llmHeaders: previewHeaders, maxDurationSeconds, silenceEndCallSeconds: SILENCE_END_CALL_SECONDS }), null, 2));
  console.log('\nDry run — nothing was sent. Re-run with --apply to push this.');
  process.exit(0);
}

if (!agentId) {
  console.error('TRIAL_ELEVENLABS_AGENT_ID is not set. It is the shared agent id baked into the '
    + "deployed server's config; this script only ever PATCHes it and never creates one. Refusing.");
  process.exit(1);
}
if (!apiKey) {
  console.error('TRIAL_ELEVENLABS_API_KEY is not set. Refusing.');
  process.exit(1);
}
if (!llmURL) {
  console.error('TRIAL_VOICE_LLM_URL is not set (https://<base-domain>/api/voice-llm). Without it the '
    + "trial agent would keep ElevenLabs' built-in LLM. Refusing.");
  process.exit(1);
}
if (!relaySecret) {
  // Not a refusal: unset is the pre-med-k80h setup. But a server that HAS the
  // secret hangs up every anonymous call of an agent patched without it.
  console.error('WARNING: TRIAL_VOICE_RELAY_SECRET is not set — the agent will send no X-Voice-Relay-Secret, '
    + 'and anonymous trial calls will hang up on a server that has it set.');
}

try {
  // Preflight: confirm the agent exists under THIS key before mutating any
  // tool. A 404/401 here means the id or the key is wrong, and stopping now
  // leaves the account's tools untouched.
  const agent = await fetchAgent(apiKey, agentId);
  // A workspace can share an agent read-only. Catching that here matters
  // because the PATCH is the LAST step: without it a viewer key would rewrite
  // every tool in the account and only then discover it cannot save the agent.
  // is_creator false is fine (service-account keys), a non-writing role is not.
  const role = agent && agent.access_info && agent.access_info.role;
  if (role && role !== 'admin' && role !== 'editor') {
    console.error(`This key has role "${role}" on agent ${agentId} and cannot write to it. Refusing.`);
    process.exit(1);
  }
  console.log(`agent ${agentId} found (role ${role || 'unknown'}) — provisioning ${TOOL_SPECS.length} tools`);
  const toolMap = await ensureTools(apiKey, (action, name) => console.log(`  tool ${action}: ${name}`));
  const toolIds = TOOL_SPECS.map((s) => toolMap[s.name]).filter(Boolean);
  if (toolIds.length !== TOOL_SPECS.length) {
    console.error(`Resolved only ${toolIds.length}/${TOOL_SPECS.length} tool ids — refusing to wire a partial agent.`);
    process.exit(1);
  }
  const config = buildAgentConfig(toolIds, { productName, llmURL, llmHeaders: llmHeaders(relaySecret), maxDurationSeconds, silenceEndCallSeconds: SILENCE_END_CALL_SECONDS });
  try {
    await patchAgent(apiKey, agentId, config);
  } catch (err) {
    // This PATCH body carries the relay secret, and toError copies up to 300
    // bytes of ElevenLabs' answer into the message — a validation error may
    // echo request_headers (possibly cut mid-value, so redaction would leak a
    // prefix). With a secret set, drop the upstream detail entirely.
    if (relaySecret) throw new Error(`ElevenLabs update agent failed (${err && err.status}); upstream detail suppressed because the request carried TRIAL_VOICE_RELAY_SECRET`);
    throw err;
  }
  console.log(`\nAgent ${agentId} updated: ${toolIds.length} tools, TOOLSET_VERSION ${TOOLSET_VERSION}.`);
} catch (err) {
  // A 404 here means TRIAL_ELEVENLABS_AGENT_ID does not exist under this key —
  // loud, not a silent create. err.message carries ElevenLabs' status + body;
  // neither ever contains the request's api key.
  console.error(`FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
