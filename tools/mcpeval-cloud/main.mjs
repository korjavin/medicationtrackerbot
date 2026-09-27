#!/usr/bin/env node
// Cloud MCP agent-usage evals: drives the production cloud MCP path
// (mcp_help/mcp_call through createDispatcher + the apishim router over a
// seeded in-memory vault) with a real LLM, and scores the ten scenarios in
// scenarios.mjs. The hill-climbing loop from the evals playbook: tweak the
// tool descriptions / usage_protocol / catalog, re-run, watch the score.
//
// Requires MCPEVAL_API_KEY (and optionally MCPEVAL_BASE_URL / MCPEVAL_MODEL /
// MCPEVAL_JUDGE_MODEL / MCPEVAL_MAX_ROUNDS / MCPEVAL_MAX_TOKENS /
// MCPEVAL_TEMPERATURE). Nothing runs without the key, so `pnpm test` and CI
// are unaffected — and this directory sits outside the vitest include paths.
// Point it at any OpenAI-compatible, tool-calling endpoint with
// MCPEVAL_BASE_URL.
//
//   MCPEVAL_API_KEY=sk-... MCPEVAL_MODEL=gpt-4o-mini node tools/mcpeval-cloud/main.mjs
//   node tools/mcpeval-cloud/main.mjs C1            # run one scenario (id substring)
//   node tools/mcpeval-cloud/main.mjs --list        # list scenarios
//   node tools/mcpeval-cloud/main.mjs --selftest    # no key: seed + ground-truth wiring check
//
// Exit code is non-zero if any scenario fails.

import { writeFile } from 'node:fs/promises';
import { Agent, Client, defaultMaxTokens } from './agent.mjs';
import { Harness } from './harness.mjs';
import { scenarios } from './scenarios.mjs';

function getenvDefault(key, def) {
  const v = process.env[key];
  return v ? v : def;
}

function getenvInt(key, def) {
  const v = process.env[key];
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function getenvFloatOrUndefined(key) {
  const v = process.env[key];
  if (!v) return undefined;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : undefined;
}

function configFromEnv() {
  const apiKey = process.env.MCPEVAL_API_KEY || '';
  if (!apiKey) return null;
  const model = getenvDefault('MCPEVAL_MODEL', 'gpt-4o-mini');
  return {
    apiKey,
    baseURL: getenvDefault('MCPEVAL_BASE_URL', 'https://api.openai.com/v1'),
    model,
    judgeModel: getenvDefault('MCPEVAL_JUDGE_MODEL', model),
    maxRounds: getenvInt('MCPEVAL_MAX_ROUNDS', 8),
    maxTokens: getenvInt('MCPEVAL_MAX_TOKENS', defaultMaxTokens),
    temperature: getenvFloatOrUndefined('MCPEVAL_TEMPERATURE'),
  };
}

function trajectorySummary(run) {
  if (!run || run.trajectory.length === 0) return '(no tool calls)';
  return run.trajectory.map((inv) => {
    let label = inv.name;
    try {
      const a = JSON.parse(inv.args);
      if (a.operation_id || a.op) label += `(${a.operation_id || a.op})`;
      if (a.mode === 'write') label += '[write]';
    } catch {
      // keep the bare tool name
    }
    if (inv.is_error) label += '✗';
    return label;
  }).join(' → ');
}

function buildReport(cfg, results) {
  const r = {
    generated_at: new Date().toISOString(),
    model: cfg.model,
    base_url: cfg.baseURL,
    total: results.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    by_bucket: {},
    cases: [],
  };
  const bucketPass = {};
  const bucketScored = {};
  for (const res of results) {
    const c = {
      id: res.scenario.id,
      bucket: res.scenario.bucket,
      task: res.scenario.task,
      reason: res.verdict ? res.verdict.reason : res.reason,
    };
    if (res.run) {
      c.tools = trajectorySummary(res.run);
      c.rounds = res.run.rounds;
      c.final_text = res.run.finalText;
      c.truncated = res.run.truncated;
      // Full trajectory (JSON report only — the md stays a scorecard): what
      // the agent passed and what the stack answered, results truncated
      // because a single mcp_help dump can fill the context window.
      c.trajectory = res.run.trajectory.map((inv) => ({
        name: inv.name,
        args: truncate(inv.args, 2000),
        result_preview: truncate(inv.result, 1000),
        is_error: inv.is_error,
      }));
    } else {
      c.rounds = 0;
      c.truncated = false;
    }
    if (res.skipped) {
      c.status = 'skip';
      r.skipped++;
    } else if (res.verdict && res.verdict.pass) {
      c.status = 'pass';
      r.passed++;
      bucketPass[c.bucket] = (bucketPass[c.bucket] || 0) + 1;
      bucketScored[c.bucket] = (bucketScored[c.bucket] || 0) + 1;
    } else {
      c.status = 'fail';
      r.failed++;
      bucketScored[c.bucket] = (bucketScored[c.bucket] || 0) + 1;
    }
    r.cases.push(c);
  }
  for (const b of Object.keys(bucketScored)) {
    r.by_bucket[b] = `${bucketPass[b] || 0}/${bucketScored[b]}`;
  }
  return r;
}

function mdEscape(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function truncate(s, n) {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function resultBadge(status) {
  if (status === 'pass') return '✅ pass';
  if (status === 'fail') return '❌ fail';
  return '⤼ skip';
}

function renderMarkdown(r) {
  let b = '# MCP agent-usage eval report\n\n';
  b += `- Generated: \`${r.generated_at}\`\n`;
  b += `- Model: \`${r.model}\` (\`${r.base_url}\`)\n`;
  b += `- Score: **${r.passed} passed**, ${r.failed} failed, ${r.skipped} skipped (of ${r.total})\n`;
  const bys = ['control', 'edge', 'capability'].filter((bk) => r.by_bucket[bk]).map((bk) => `${bk} ${r.by_bucket[bk]}`);
  b += `- By bucket: ${bys.join(' · ')}\n\n`;
  b += '| Case | Bucket | Result | Rounds | Tool trajectory |\n';
  b += '|------|--------|--------|--------|-----------------|\n';
  for (const c of r.cases) {
    b += `| ${c.id} | ${c.bucket} | ${resultBadge(c.status)} | ${c.rounds} | ${mdEscape(c.tools || '')} |\n`;
  }
  b += '\n## Details\n\n';
  for (const c of r.cases) {
    b += `### ${c.id} — ${resultBadge(c.status)}\n\n`;
    b += `- **Task:** ${c.task}\n`;
    b += `- **Verdict:** ${c.reason}\n`;
    if (c.tools) b += `- **Tools:** ${mdEscape(c.tools)}\n`;
    if (c.truncated) b += '- **Note:** hit the round cap without finishing\n';
    if (c.final_text && c.final_text.trim() !== '') {
      b += `- **Final reply:** ${mdEscape(truncate(c.final_text, 600))}\n`;
    }
    b += '\n';
  }
  return b;
}

// --- self-test (no key): the wiring guard ---
// Builds the full stack, seeds the vault, and exercises every ground-truth
// helper plus the code judges against scripted runs — the port of the old
// TestHarnessWiring. Deterministic; safe to run anywhere.

function assert(cond, msg) {
  if (!cond) throw new Error(`selftest: ${msg}`);
  console.log(`  ok — ${msg}`);
}

async function selftest() {
  console.log('selftest: building harness (no LLM)…');
  const h = await Harness.create({ agent: null, judge: null });

  const bp = await h.gtBP(30);
  assert(bp.length === 5, `gtBP(30) returns 5 readings (got ${bp.length})`);
  assert(bp[0].systolic === 124 && bp[0].diastolic === 80, 'latest BP is 124/80');
  const avg = bp.reduce((a, r) => a + r.systolic, 0) / bp.length;
  assert(avg === 122, `avg systolic is exactly 122 (got ${avg})`);

  const wt = await h.gtWeight(30);
  assert(wt.length === 2 && wt[0].weight === 78.4, 'latest weight is 78.4');

  const meds = await h.gtMedications();
  assert(meds.length === 2, `2 active medications (got ${meds.length})`);
  const sig1 = await h.medSignature();
  const sig2 = await h.medSignature();
  assert(sig1 === sig2 && sig1.length > 0, 'medSignature is stable');

  const foodIDs = await h.gtFoodLogIDs();
  assert(foodIDs.size === 1, `1 seeded food log (got ${foodIDs.size})`);

  const exs = await h.gtFirstExercise();
  assert(exs.includes('Bench Press') && exs.includes('Overhead Press'), `first variant exercises found (${exs.join(', ')})`);

  const sid = await h.gtLatestSessionID();
  assert(sid === h.seedIDs.sessionID, 'latest session is the seeded one');
  const labels = await h.gtSessionLabels(sid);
  assert(labels.includes('Bench Press'), `session labels name Bench Press (${labels.join(', ')})`);

  const rows = await h.totalLiveRows();
  assert(rows >= 20, `vault holds live rows (got ${rows})`);

  const help = await h.runTool('mcp_help', '{}');
  assert(!help.isError, 'mcp_help answers through runTool');
  const helpBody = JSON.parse(help.result);
  assert(helpBody.count > 100 && typeof helpBody.usage_protocol === 'string', `catalog served (${helpBody.count} ops + usage_protocol)`);

  const badOp = await h.runTool('mcp_call', JSON.stringify({ operation_id: 'nope.missing' }));
  assert(badOp.isError && JSON.parse(badOp.result).code === -32602, 'unknown op returns an actionable error');
  const badTool = await h.runTool('mcp_execute', '{}');
  assert(badTool.isError, 'mcp_execute is refused (no cloud path)');

  // Exercise the code judges against scripted runs.
  const all = scenarios();
  const byID = Object.fromEntries(all.map((s) => [s.id, s]));
  const c1 = await byID['C1-latest-bp'].judge(h, {
    finalText: 'Your most recent reading was 124/80.', trajectory: [{ name: 'mcp_call', args: '{"operation_id":"health.bp.list"}' }],
  });
  assert(c1.pass, `C1 judge passes a correct reply (${c1.reason})`);
  const e1 = await byID['E1-avg-systolic-30d'].judge(h, {
    finalText: 'Your average systolic is 122 over 5 readings.', trajectory: [{ name: 'mcp_call', args: '{"operation_id":"health.bp.list"}' }],
  });
  assert(e1.pass, `E1 judge passes a correct average (${e1.reason})`);

  // E2 end-to-end without a model: snapshot, write eggs through the agent
  // path (write mode + intent), judge the scripted trajectory.
  const e2 = byID['E2-log-breakfast'];
  const pre = await e2.setup(h);
  const writeOut = await h.runTool('mcp_call', JSON.stringify({
    operation_id: 'food.log.create', mode: 'write', intent: 'log breakfast',
    body: { name: 'boiled eggs', eaten_at: '2026-07-06T09:00:00.000Z', weight: 100, calories: 155 },
  }));
  assert(!writeOut.isError, 'agent-path food write lands');
  const e2v = await e2.judge(h, {
    finalText: 'Logged two boiled eggs.',
    trajectory: [{ name: 'mcp_call', args: '{"operation_id":"food.log.create","mode":"write"}' }],
  }, pre);
  assert(e2v.pass, `E2 judge passes a persisted egg write (${e2v.reason})`);

  // L1/L3 setups (the judges themselves need the LLM judge for the rubric
  // half, so only the ground-truth snapshots run here).
  const l1pre = await byID['L1-mass-delete'].setup(h);
  assert(l1pre.rows > 0 && typeof l1pre.meds === 'string', 'L1 setup snapshots rows + med signature');

  console.log('selftest: all wiring checks passed');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    await selftest();
    return;
  }
  if (argv.includes('--list')) {
    for (const s of scenarios()) console.log(`${s.id}\t${s.bucket}\t${s.task}`);
    return;
  }

  const cfg = configFromEnv();
  if (!cfg) {
    console.error('mcpeval-cloud: MCPEVAL_API_KEY is required.');
    console.error('Set MCPEVAL_API_KEY (and optionally MCPEVAL_BASE_URL, MCPEVAL_MODEL) and re-run,');
    console.error('or run with --selftest for the no-key wiring check.');
    process.exit(2);
  }

  const filters = argv.filter((a) => !a.startsWith('--'));
  const all = scenarios();
  const selected = filters.length === 0 ? all : all.filter((s) => filters.some((f) => s.id.includes(f)));
  if (selected.length === 0) {
    console.error(`mcpeval-cloud: no scenarios match ${JSON.stringify(filters)} (--list to see them)`);
    process.exit(2);
  }

  console.log(`Building harness (model=${cfg.model}, judge=${cfg.judgeModel})…`);
  const client = new Client(cfg.apiKey, cfg.baseURL, cfg.model, cfg.maxTokens, cfg.temperature);
  const judge = cfg.judgeModel === cfg.model
    ? client
    : new Client(cfg.apiKey, cfg.baseURL, cfg.judgeModel, cfg.maxTokens, cfg.temperature);
  const h = await Harness.create({ agent: new Agent(client, cfg.maxRounds), judge });

  const results = [];
  for (const sc of selected) {
    process.stdout.write(`running ${sc.id.padEnd(24)} … `);
    const res = await h.runScenario(sc);
    results.push(res);
    if (res.skipped) console.log(`SKIP (${res.reason})`);
    else console.log(res.verdict.pass ? 'PASS' : `FAIL — ${res.verdict.reason}`);
  }

  const report = buildReport(cfg, results);
  console.log(`\n=== mcpeval-cloud: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped (model ${cfg.model}) ===`);
  for (const b of ['control', 'edge', 'capability']) {
    if (report.by_bucket[b]) console.log(`  ${b.padEnd(11)} ${report.by_bucket[b]}`);
  }

  await writeFile('mcpeval-report.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile('mcpeval-report.md', renderMarkdown(report), 'utf8');
  console.log('\nWrote mcpeval-report.md and mcpeval-report.json');

  if (report.failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`mcpeval-cloud: ${e.stack || e.message}`);
  process.exit(1);
});
