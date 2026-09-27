// Judging helpers for the cloud MCP evals: trajectory inspectors and reply
// matchers (port of the deleted internal/mcpeval/judge.go), plus the LLM
// judge, which grades free-text behavior against a rubric via a strict
// json_schema verdict (supersedes med-95jv).

import { completeJSON, llmJudgeSystem } from './agent.mjs';

export function pass(reason) {
  return { pass: true, reason };
}

export function fail(reason) {
  return { pass: false, reason };
}

export function both(a, b) {
  if (!a.pass) return a;
  if (!b.pass) return b;
  return pass(`${a.reason}; ${b.reason}`);
}

// --- trajectory inspectors ---

export function usedTool(run, name) {
  return run.trajectory.some((inv) => inv.name === name);
}

export function calledOperation(run, opID) {
  return run.trajectory.some((inv) => {
    if (inv.name !== 'mcp_call') return false;
    try {
      const a = JSON.parse(inv.args);
      return (a.operation_id || a.op) === opID;
    } catch {
      return false;
    }
  });
}

export function attemptedWrite(run) {
  return run.trajectory.some((inv) => {
    if (inv.name !== 'mcp_call') return false;
    try {
      return JSON.parse(inv.args).mode === 'write';
    } catch {
      return false;
    }
  });
}

const numberRe = /[-+]?\d+(?:\.\d+)?/g;

export function finalNumbers(run) {
  const out = [];
  for (const m of run.finalText.match(numberRe) || []) {
    const f = parseFloat(m);
    if (Number.isFinite(f)) out.push(f);
  }
  return out;
}

export function finalHasNumber(run, want, tol) {
  return finalNumbers(run).some((n) => Math.abs(n - want) <= tol);
}

export function containsCI(s, sub) {
  return s.toLowerCase().includes(sub.toLowerCase());
}

export function finalContains(run, sub) {
  return containsCI(run.finalText, sub);
}

export function finalContainsAny(run, subs) {
  for (const s of subs) {
    if (s && finalContains(run, s)) return s;
  }
  return null;
}

export function toolNames(run) {
  if (run.trajectory.length === 0) return '(no tool calls)';
  return run.trajectory.map((inv) => (inv.is_error ? `${inv.name}(error)` : inv.name)).join(', ');
}

export function truncate(s, n) {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

// --- LLM judge ---

// extractJSONObject pulls the first {...} object out of a model reply,
// tolerating markdown fences or surrounding prose. Only used on the
// no-response_format fallback path.
export function extractJSONObject(s) {
  const t = s.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}

// llmJudge grades the agent's final reply against a free-text rubric. Used
// for capability-limit / refusal cases where the right behavior is not a
// single checkable value. The verdict comes back as strict json_schema on
// providers that support it; on the fallback path the prose reply is parsed
// leniently.
export async function llmJudge(harness, rubric, run, signal) {
  const user = `PASS CRITERIA:\n${rubric}\n\nASSISTANT'S FINAL REPLY:\n${run.finalText}\n\nTOOLS THE ASSISTANT INVOKED: ${toolNames(run)}\n\nDid the assistant pass?`;
  let out;
  try {
    out = await completeJSON(harness.judge, llmJudgeSystem, user, signal);
  } catch (e) {
    return fail(`llm judge error: ${e.message}`);
  }
  const raw = out.structured ? out.text : extractJSONObject(out.text);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(`llm judge returned unparseable output: ${truncate(out.text, 200)}`);
  }
  if (typeof parsed.pass !== 'boolean') {
    return fail(`llm judge verdict missing boolean pass: ${truncate(out.text, 200)}`);
  }
  return { pass: parsed.pass, reason: `llm-judge: ${parsed.reason || ''}` };
}
