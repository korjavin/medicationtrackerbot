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
// TRIAL_ELEVENLABS_AGENT_ID. The key is never printed.
import {
  TOOL_SPECS,
  TOOLSET_VERSION,
  buildAgentConfig,
  ensureTools,
  patchAgent,
  toolBody,
} from '../web/cloud/js/elevenlabs-agent.js';

const apply = process.argv.includes('--apply');
const unknown = process.argv.slice(2).filter((a) => a !== '--apply' && a !== '--dry-run');
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(' ')}\nUsage: pnpm trial:agent [--apply|--dry-run]`);
  process.exit(2);
}

const agentId = process.env.TRIAL_ELEVENLABS_AGENT_ID || '';
const apiKey = process.env.TRIAL_ELEVENLABS_API_KEY || '';

if (!apply) {
  // Dry run is a payload preview, so it deliberately needs no credentials and
  // makes no network call — the whole point is being able to read what an apply
  // WOULD write to a live shared production agent.
  console.log(`TOOLSET_VERSION ${TOOLSET_VERSION} — ${TOOL_SPECS.length} tools`);
  console.log(`target agent: ${agentId || '(TRIAL_ELEVENLABS_AGENT_ID unset — --apply would refuse)'}`);
  console.log('\n--- tools (one PATCH-or-POST per tool, matched by name) ---');
  for (const spec of TOOL_SPECS) console.log(JSON.stringify(toolBody(spec)));
  console.log('\n--- agent PATCH body (tool ids resolved at apply time) ---');
  console.log(JSON.stringify(buildAgentConfig(TOOL_SPECS.map((s) => `<id:${s.name}>`)), null, 2));
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

try {
  const toolMap = await ensureTools(apiKey, (action, name) => console.log(`  tool ${action}: ${name}`));
  const toolIds = TOOL_SPECS.map((s) => toolMap[s.name]).filter(Boolean);
  if (toolIds.length !== TOOL_SPECS.length) {
    console.error(`Resolved only ${toolIds.length}/${TOOL_SPECS.length} tool ids — refusing to wire a partial agent.`);
    process.exit(1);
  }
  await patchAgent(apiKey, agentId, buildAgentConfig(toolIds));
  console.log(`\nAgent ${agentId} updated: ${toolIds.length} tools, TOOLSET_VERSION ${TOOLSET_VERSION}.`);
} catch (err) {
  // A 404 here means TRIAL_ELEVENLABS_AGENT_ID does not exist under this key —
  // loud, not a silent create. err.message carries ElevenLabs' status + body;
  // neither ever contains the request's api key.
  console.error(`FAILED: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
