// scripts/provision-trial-agent.mjs rewrites a LIVE shared production agent, so
// the safety properties are the ones worth pinning: dry run by default with no
// network call, a loud refusal instead of creating an agent when the id is
// missing, no API key on stdout/stderr, and no second copy of the prompt (bd
// med-qgnk). Driven as a subprocess because that is exactly how an operator
// runs it.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_SPECS, TOOLSET_VERSION, buildAgentConfig, toolBody } from '../elevenlabs-agent.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/provision-trial-agent.mjs');
const FAKE_KEY = 'sk_trial_fake_key_do_not_use';
const LLM_URL = 'https://app.example.com/api/voice-llm';

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // A bare env keeps a real operator key out of the assertions below.
    env: { PATH: process.env.PATH, ...env },
  });
}

describe('scripts/provision-trial-agent.mjs', () => {
  it('is wired as pnpm trial:agent', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['trial:agent']).toBe('node scripts/provision-trial-agent.mjs');
  });

  it('dry-runs by default: prints the payload, calls nothing, exits 0', () => {
    // The fake key would 401 against api.elevenlabs.io, so a zero exit here is
    // also the assertion that no request was made.
    const r = run([], { TRIAL_ELEVENLABS_API_KEY: FAKE_KEY, TRIAL_ELEVENLABS_AGENT_ID: 'agent_fake' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`TOOLSET_VERSION ${TOOLSET_VERSION}`);
    expect(r.stdout).toContain('Dry run — nothing was sent.');
    for (const spec of TOOL_SPECS) expect(r.stdout).toContain(spec.name);
  });

  it('prints the shared agent body rather than its own copy of the prompt', () => {
    const r = run(['--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    const shared = buildAgentConfig([], { llmURL: LLM_URL }).conversation_config.agent;
    expect(r.stdout).toContain(shared.first_message);
    expect(r.stdout).toContain(shared.prompt.prompt.split('\n')[0]);
    // No prompt text may be re-declared in the script itself — a second copy is
    // the drift this bead exists to prevent.
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(src).not.toContain(shared.first_message);
    expect(src).not.toContain('You are Silas');
  });

  it('ships a multilingual agent: v4_turbo TTS, language detection, ru preset, mirror-language prompt (bd med-qxdv)', () => {
    const cc = buildAgentConfig([], { llmURL: LLM_URL }).conversation_config;
    expect(cc.agent.language).toBe('en');
    expect(cc.tts.model_id).toBe('eleven_v4_turbo');
    expect(cc.agent.prompt.built_in_tools.language_detection.params.system_tool_type).toBe('language_detection');
    expect(cc.language_presets.ru.overrides.agent.first_message).toBeTruthy();
    expect(cc.agent.prompt.prompt).toContain('reply in the language the user is speaking');
    expect(TOOLSET_VERSION).toBeGreaterThanOrEqual(6);
  });

  it('points the agent at the voice LLM relay, never ElevenLabs\' built-in LLM (bd med-h849.3)', () => {
    const cfg = buildAgentConfig([], { llmURL: LLM_URL });
    expect(cfg.conversation_config.agent.prompt.llm).toBe('custom-llm');
    expect(cfg.conversation_config.agent.prompt.custom_llm).toEqual({
      url: LLM_URL, model_id: 'medtracker', api_type: 'chat_completions',
    });
    // Owner decision: no AI key / secret ever goes into ElevenLabs.
    expect(cfg.conversation_config.agent.prompt.custom_llm).not.toHaveProperty('api_key');
    expect(cfg.platform_settings.overrides.custom_llm_extra_body).toBe(true);
    expect(TOOLSET_VERSION).toBeGreaterThanOrEqual(8);
    // No silent fallback to the built-in LLM.
    expect(() => buildAgentConfig([])).toThrow(/llmURL/);
  });

  it('sets the turn-timeout knobs so slow relay turns are not aborted at ~8 s (bd med-h849.13)', () => {
    const cc = buildAgentConfig([], { llmURL: LLM_URL }).conversation_config;
    expect(cc.agent.prompt.cascade_timeout_seconds).toBe(15);
    expect(cc.turn.soft_timeout_config).toEqual({
      timeout_seconds: 2.5, message: 'One moment…', disable_until_first_user_message: true,
    });
    expect(TOOLSET_VERSION).toBeGreaterThanOrEqual(9);
    // Every preset language gets its own filler, so the caller never hears English.
    for (const [lang, preset] of Object.entries(cc.language_presets)) {
      const msg = preset.overrides.turn.soft_timeout_config.message;
      expect(msg, lang).toBeTruthy();
      expect(msg, lang).not.toBe('One moment…');
    }
    const r = run([], { TRIAL_VOICE_LLM_URL: LLM_URL });
    expect(r.stdout).toContain('"cascade_timeout_seconds": 15');
    expect(r.stdout).toContain('"soft_timeout_config"');
  });

  it('dry run prints TRIAL_VOICE_LLM_URL and the custom_llm block', () => {
    const r = run([], { TRIAL_VOICE_LLM_URL: LLM_URL });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`TRIAL_VOICE_LLM_URL: ${LLM_URL}`);
    expect(r.stdout).toContain('"custom-llm"');
    const unset = run([]);
    expect(unset.status, unset.stderr).toBe(0);
    expect(unset.stdout).toContain('TRIAL_VOICE_LLM_URL: (unset');
  });

  it('caps the shared trial agent per call; BYO configs stay uncapped (bd med-o7zq.22)', () => {
    const byo = buildAgentConfig([], { llmURL: LLM_URL }).conversation_config;
    // file_input (bd med-ku8r) is on for both; only the cap differs.
    const FILE_INPUT = { enabled: true, max_files_in_memory: 1 };
    expect(byo.conversation).toEqual({ file_input: FILE_INPUT });
    expect(byo.turn).not.toHaveProperty('silence_end_call_timeout');
    const capped = buildAgentConfig([], { llmURL: LLM_URL, maxDurationSeconds: 300, silenceEndCallSeconds: 30 }).conversation_config;
    expect(capped.conversation).toEqual({ file_input: FILE_INPUT, max_duration_seconds: 300 });
    expect(capped.turn.silence_end_call_timeout).toBe(30);
    const dflt = run([], { TRIAL_VOICE_LLM_URL: LLM_URL });
    expect(dflt.status, dflt.stderr).toBe(0);
    expect(dflt.stdout).toContain('"max_duration_seconds": 120');
    expect(dflt.stdout).toContain('"silence_end_call_timeout": 30');
    const set = run([], { TRIAL_VOICE_LLM_URL: LLM_URL, TRIAL_VOICE_MAX_CALL_SECONDS: '120' });
    expect(set.stdout).toContain('"max_duration_seconds": 120');
    const bad = run([], { TRIAL_VOICE_MAX_CALL_SECONDS: '0' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('TRIAL_VOICE_MAX_CALL_SECONDS');
  });

  it('sends the relay hop secret header from the trial agent only, never printing it (bd med-k80h)', () => {
    const SECRET = 'hop-secret-do-not-print';
    expect(buildAgentConfig([], { llmURL: LLM_URL }).conversation_config.agent.prompt.custom_llm)
      .not.toHaveProperty('request_headers');
    expect(buildAgentConfig([], { llmURL: LLM_URL, llmHeaders: { 'X-Voice-Relay-Secret': SECRET } })
      .conversation_config.agent.prompt.custom_llm.request_headers).toEqual({ 'X-Voice-Relay-Secret': SECRET });
    const set = run([], { TRIAL_VOICE_LLM_URL: LLM_URL, TRIAL_VOICE_RELAY_SECRET: SECRET });
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain('"X-Voice-Relay-Secret": "<TRIAL_VOICE_RELAY_SECRET>"');
    expect(set.stdout + set.stderr).not.toContain(SECRET);
    const unset = run([], { TRIAL_VOICE_LLM_URL: LLM_URL });
    expect(unset.stdout).not.toContain('request_headers');
  });

  it('refuses --apply without TRIAL_VOICE_LLM_URL', () => {
    const r = run(['--apply'], { TRIAL_ELEVENLABS_API_KEY: FAKE_KEY, TRIAL_ELEVENLABS_AGENT_ID: 'agent_fake' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TRIAL_VOICE_LLM_URL is not set');
    expect(r.stdout).toBe('');
  });

  it('sets the typing tool-call sound per tool — ElevenLabs ignores the agent-level field', () => {
    for (const spec of TOOL_SPECS) {
      expect(toolBody(spec).tool_config).toMatchObject({ tool_call_sound: 'typing', tool_call_sound_behavior: 'always' });
    }
  });

  it('refuses to apply — never creates an agent — when the agent id is unset', () => {
    const r = run(['--apply'], { TRIAL_ELEVENLABS_API_KEY: FAKE_KEY });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TRIAL_ELEVENLABS_AGENT_ID is not set');
    expect(r.stdout).toBe('');
  });

  it('refuses --apply --dry-run rather than silently applying', () => {
    const r = run(['--apply', '--dry-run'], { TRIAL_ELEVENLABS_API_KEY: FAKE_KEY, TRIAL_ELEVENLABS_AGENT_ID: 'agent_fake' });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });

  it('never prints the API key', () => {
    for (const args of [[], ['--apply']]) {
      const r = run(args, { TRIAL_ELEVENLABS_API_KEY: FAKE_KEY, TRIAL_ELEVENLABS_AGENT_ID: '' });
      expect(r.stdout + r.stderr).not.toContain(FAKE_KEY);
    }
  });
});
