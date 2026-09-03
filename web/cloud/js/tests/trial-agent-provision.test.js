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

import { TOOL_SPECS, TOOLSET_VERSION, buildAgentConfig } from '../elevenlabs-agent.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/provision-trial-agent.mjs');
const FAKE_KEY = 'sk_trial_fake_key_do_not_use';

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
    const shared = buildAgentConfig([]).conversation_config.agent;
    expect(r.stdout).toContain(shared.first_message);
    expect(r.stdout).toContain(shared.prompt.prompt.split('\n')[0]);
    // No prompt text may be re-declared in the script itself — a second copy is
    // the drift this bead exists to prevent.
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(src).not.toContain(shared.first_message);
    expect(src).not.toContain('You are Silas');
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
