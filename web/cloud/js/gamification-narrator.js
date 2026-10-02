// Gamification AI narration layer (Phase 6 of docs/design/2026-07-11-
// gamification-redesign.md §4.3) — the OPT-IN prose seam that sits
// OVER the deterministic engine (web/domain/gamification.js) and never inside
// it. The pure domain module stays authoritative; this browser-layer module
// only turns its ALREADY-COMPUTED read-models into a few warm sentences.
//
// The hard invariants (do not weaken):
//   1. Narrates, never computes. Every function is handed the computed
//      stats-JSON (the same objects the /weekly-review, /goal-line,
//      /experiments, /chapter, /atlas routes and workout stats return) and returns PROSE ONLY.
//      The payload sent to the provider is built here by whitelisting a
//      handful of already-summarised fields — zero raw vault records ever
//      cross this boundary (no recordId / measured_at / systolic-log arrays).
//   2. LLM numbers can never displace deterministic ones. This returns
//      { text, source } and nothing else — it cannot emit a data field the UI
//      would treat as authoritative. journey.js renders the deterministic
//      values from their own read-models and drops this prose into a separate,
//      visually-attributed block.
//   3. Deterministic fallback everywhere. No aiClient, no key, a provider
//      error, or an empty response all resolve to { text: null } WITHOUT
//      throwing — the caller keeps its deterministic card unchanged.
//
// Reuses aiClient.chat (web/cloud/js/aiclient.js) exactly like the tg-agent,
// which means it inherits that call's TWO paths, not one:
//   - BYO key set → device → the user's own OpenAI-compatible endpoint,
//     never through /api.
//   - no key → the operator-proxied trial path (POST /api/trial/openai), gated
//     on the `tg` consent scope (aiclient.js ensureTrialConsent('tg')). The
//     scope is shared deliberately: the tg disclosure names this narrator and
//     what it sends ("computed health summaries (weekly weight-goal progress,
//     workout and blood-pressure stats)"),
//     so a user granting it has been told narration is included. Both callers
//     feed vault-derived health data to the same model, which is what that
//     scope actually authorizes — the name is Telegram-flavoured, the boundary
//     is not (bd med-eas.80; carve-outs in docs/cloud-mode.md → Privacy boundary).
// This module is cloud-only (apishim.js is its sole wiring); bot mode 404s the
// /narrate probe and journey.js keeps its deterministic card.

// The provider is told plainly that it
// is a narrator and not a calculator. Even so, invariant 2 does not rely on
// the model obeying: any figure it emits lives only inside the attributed
// prose block, never in a field the UI reads as data.
export const NARRATOR_SYSTEM = [
  'You are a warm, concise narrator for a personal health-tracking journal.',
  'You are given a compact JSON of numbers the app has ALREADY computed.',
  'Your job is to turn it into a short, encouraging paragraph of plain prose that fits a small card.',
  'The app displays every number next to your text, so do not invent, recompute, or state any numeric value — describe patterns and effort in words.',
  'Do not give medical advice or diagnoses.',
  'Your text is shown as a single plain-text paragraph, so write no headings, lists, or JSON.',
  'Celebrate consistency rather than intensity, and never imply exceeding healthy activity limits.',
].join('\n');

function num(x) {
  return Number.isFinite(x) ? x : null;
}

// --- Payload builders: the ONLY place stats leave for the provider. Each one
// whitelists named, already-computed fields off the domain read-models. Kept
// exported so the unit suite can assert the wire payload carries no raw record
// shapes (invariant 1) without a live provider. ------------------------------

// The weekly recap (med-8tur.8, docs/gamification.md §0.3.4) narrates the
// owner's progress on their goal, not game features: the completed-week review
// (getWeeklyReview — three fact rows + the picked plan) plus the goal's
// direction and progress off the live Goal Line (getGoalLine). Counts, kg
// deltas and BP means only — no absolute body weight, no dates, no ids, no
// free text (the intention is a curated string from WEEK_INTENTIONS).
export function weeklyPayload({ review, goalLine } = {}) {
  const rows = (review && review.rows) || {};
  const w = rows.weight || {};
  const wo = rows.workouts || {};
  const bp = rows.bp || {};
  const goal = (goalLine && goalLine.goal) || {};
  const plan = review && review.plan;
  const dir = goal.direction;
  return {
    quiet: !!(review && review.quiet),
    weight: w.feature_on ? {
      goal_status: w.goal_status || null,
      goal_direction: dir === -1 ? 'lose' : dir === 1 ? 'gain' : dir === 0 ? 'maintain' : null,
      progress_fraction: goal.progress ? num(goal.progress.fraction) : null,
      trend_change_kg: num(w.trend_change_kg),
      distance_to_goal_kg: num(w.distance_to_goal),
      weigh_in_days: num(w.weigh_in_days),
      milestones_reached: Array.isArray(w.milestones_reached) ? w.milestones_reached.length : 0,
    } : null,
    workouts: wo.feature_on ? { completed: num(wo.completed), scheduled: num(wo.scheduled) } : null,
    // mean_sys/mean_dia, not systolic/diastolic: those keys are the raw-record
    // shape the suite's wire guard rejects.
    bp: bp.feature_on ? {
      status: bp.status || null,
      days_measured: num(bp.days_measured),
      mean_sys: bp.mean ? num(bp.mean.systolic) : null,
      mean_dia: bp.mean ? num(bp.mean.diastolic) : null,
      target_sys: bp.target ? num(bp.target.systolic) : null,
      target_dia: bp.target ? num(bp.target.diastolic) : null,
    } : null,
    next_week: plan ? {
      intention: plan.intention ? plan.intention.text : null,
      paused: !!plan.paused,
    } : null,
  };
}

export function chapterPayload(s) {
  const r = s && s.review;
  if (!r) return { review: null };
  return {
    review: {
      title: r.title,
      focus: r.focus,
      quiet: !!r.quiet,
      lines: Array.isArray(r.lines) ? r.lines.slice(0, 8) : [],
      summary: r.text,
    },
  };
}

export function experimentPayload(s) {
  const exp = (s && s.experiments) || {};
  const atlas = (s && s.atlas) || {};
  return {
    can_start: !!exp.can_start,
    active: exp.active ? { title: exp.active.title } : null,
    // The curated template library is the ONLY set that can actually start a
    // trial (web/domain/gamification.js startExperiment validates the id). The
    // model may recommend one and personalise the why; it can never author a
    // new experiment shape (guardrail §5).
    templates: (Array.isArray(exp.templates) ? exp.templates : [])
      .map((t) => ({ id: t.id, title: t.title, measure: t.measure, from_probe: t.from_probe })),
    revealed_discoveries: (Array.isArray(atlas.cards) ? atlas.cards : [])
      .filter((c) => c.state === 'revealed')
      .map((c) => ({ question: c.question, summary: c.text })),
  };
}

export function workoutPayload(s) {
  s = s || {};
  return {
    total_sessions_30d: num(s.total_sessions),
    completed_30d: num(s.completed_sessions),
    completion_rate_pct: Number.isFinite(s.completion_rate) ? Math.round(s.completion_rate) : null,
    active_weeks: num(s.active_weeks),
    top_exercises: (Array.isArray(s.top_exercises) ? s.top_exercises : [])
      .slice(0, 5)
      .map((e) => ({ name: e.exercise_name, sessions: num(e.session_count) })),
  };
}

const PROMPTS = {
  weekly: (p) => [
    "Write a short recap of the user's completed week from the computed facts below: their weight goal, workouts, and blood pressure.",
    'Describe each fact side by side without attribution — say "your weight stayed steady while you completed your plan", never that one thing caused, drove, or helped another.',
    'Never grade the pace of weight change and never suggest a target pace. A null field means unknown: say nothing about it.',
    'If next_week has an intention, end with exactly one reflective sentence about it; if the week is paused, acknowledge the pause kindly instead.',
    JSON.stringify(p),
  ].join('\n'),
  chapter: (p) => `Narrate this finished four-week chapter warmly from its computed review:\n${JSON.stringify(p)}`,
  experiments: (p) => `From the curated templates and revealed discoveries below, recommend one experiment from the templates below, named by its title, and explain in prose why it fits the user right now. Recommend only a template from this list.\n${JSON.stringify(p)}`,
  workout: (p) => `Write an encouraging insight about the user's last 30 days of workouts from these computed stats:\n${JSON.stringify(p)}`,
};

function extractText(msg) {
  if (msg && typeof msg.content === 'string') return msg.content.trim();
  return '';
}

// createGamificationNarrator builds the narration port. aiClient is the same
// object food AI consumes (createAIClient) — null when no provider is wired.
export function createGamificationNarrator({ aiClient } = {}) {
  let weeklyCache = null;
  async function run(kind, payload) {
    // Invariant 3: absent provider degrades to nothing, never an error.
    if (!aiClient || typeof aiClient.chat !== 'function') {
      return { text: null, source: 'deterministic' };
    }
    try {
      const msg = await aiClient.chat({
        messages: [
          { role: 'system', content: NARRATOR_SYSTEM },
          { role: 'user', content: PROMPTS[kind](payload) },
        ],
      });
      const text = extractText(msg);
      return text ? { text, source: 'ai' } : { text: null, source: 'deterministic' };
    } catch (_) {
      // No key, provider 4xx/5xx, timeout — all collapse to the deterministic
      // fallback so the deterministic card the caller already renders stands.
      return { text: null, source: 'deterministic' };
    }
  }

  return {
    narrateWeekly: async (stats) => {
      const payload = weeklyPayload(stats);
      // One recap per reviewed week: a re-tap with the same facts reuses it
      // instead of paying the provider again. A changed pick re-narrates.
      // ponytail: single in-memory slot, lost on reload; persist in the vault if re-asks matter.
      const key = `${stats && stats.review && stats.review.week && stats.review.week.id}:${JSON.stringify(payload)}`;
      if (weeklyCache && weeklyCache.key === key) return weeklyCache.res;
      const res = await run('weekly', payload);
      if (res.text) weeklyCache = { key, res };
      return res;
    },
    narrateChapter: (chapter) => run('chapter', chapterPayload(chapter)),
    suggestExperiments: (state) => run('experiments', experimentPayload(state)),
    narrateWorkout: (stats) => run('workout', workoutPayload(stats)),
  };
}
