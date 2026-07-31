// Gamification AI narration layer (Phase 6 of docs/design/2026-07-11-
// gamification-redesign.md §4.3) — the OPT-IN prose seam that sits
// OVER the deterministic engine (web/domain/gamification.js) and never inside
// it. The pure domain module stays authoritative; this browser-layer module
// only turns its ALREADY-COMPUTED read-models into a few warm sentences.
//
// The hard invariants (do not weaken):
//   1. Narrates, never computes. Every function is handed the computed
//      stats-JSON (the same objects the /atlas, /forecast, /experiments,
//      /chapter, /traits, /keystones routes return) and returns PROSE ONLY.
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
//     what it sends ("computed health summaries (weekly and workout stats)"),
//     so a user granting it has been told narration is included. Both callers
//     feed vault-derived health data to the same model, which is what that
//     scope actually authorizes — the name is Telegram-flavoured, the boundary
//     is not (bd med-eas.80; carve-outs in docs/cloud-mode.md → Privacy boundary).
// This module is cloud-only (apishim.js is its sole wiring); bot mode 404s the
// /narrate probe and journey.js keeps its deterministic card.

// The provider is told, in the strongest terms the prompt can carry, that it
// is a narrator and not a calculator. Even so, invariant 2 does not rely on
// the model obeying: any figure it emits lives only inside the attributed
// prose block, never in a field the UI reads as data.
export const NARRATOR_SYSTEM = [
  'You are a warm, concise narrator for a personal health-tracking journal.',
  'You are given a compact JSON of numbers the app has ALREADY computed.',
  'Your only job is to turn it into 2–4 short, encouraging sentences of plain prose.',
  'Absolute rules:',
  '- Do NOT invent, recompute, or state any numeric value. The app shows every number itself; you add colour, not data.',
  '- Do NOT give medical advice or diagnose. Describe patterns and effort, never prescriptions.',
  '- No markdown headings, no bullet lists, no JSON — just a short paragraph.',
  '- Never imply exceeding healthy activity ceilings; celebrate consistency, not intensity.',
].join('\n');

function num(x) {
  return Number.isFinite(x) ? x : null;
}

// --- Payload builders: the ONLY place stats leave for the provider. Each one
// whitelists named, already-computed fields off the domain read-models. Kept
// exported so the unit suite can assert the wire payload carries no raw record
// shapes (invariant 1) without a live provider. ------------------------------

export function weeklyPayload(s) {
  s = s || {};
  const cards = (s.atlas && Array.isArray(s.atlas.cards) ? s.atlas.cards : [])
    .filter((c) => c.state === 'revealed' || c.state === 'no_effect')
    .map((c) => ({ question: c.question, state: c.state, summary: c.text }));
  const ev = s.forecast && s.forecast.evening;
  const active = s.experiments && s.experiments.active;
  const verdict = s.experiments && s.experiments.verdict;
  const chapter = s.chapter && s.chapter.active;
  return {
    discoveries: cards,
    forecast: ev ? { state: ev.state, summary: ev.text } : null,
    active_experiment: active ? { title: active.title, tracker: active.tracker } : null,
    latest_verdict: verdict ? { title: verdict.title, verdict: verdict.verdict } : null,
    active_chapter: chapter
      ? { title: chapter.title, focus: chapter.focus, day: num(chapter.day_number), of: num(chapter.duration) }
      : null,
    traits: (s.traits && Array.isArray(s.traits.traits) ? s.traits.traits : [])
      .map((t) => ({ name: t.title, state: t.state })),
    keystones: (s.keystones && Array.isArray(s.keystones.keystones) ? s.keystones.keystones : [])
      .map((k) => ({ title: k.title })),
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
  weekly: (p) => `Write this week's short recap from the user's computed stats:\n${JSON.stringify(p)}`,
  chapter: (p) => `Narrate this finished four-week chapter warmly from its computed review:\n${JSON.stringify(p)}`,
  experiments: (p) => `From the curated templates and revealed discoveries below, recommend ONE experiment (name its template by id) and explain in prose why it fits the user right now. Only recommend a template whose id appears in the list.\n${JSON.stringify(p)}`,
  workout: (p) => `Write an encouraging insight about the user's last 30 days of workouts from these computed stats:\n${JSON.stringify(p)}`,
};

function extractText(msg) {
  if (msg && typeof msg.content === 'string') return msg.content.trim();
  return '';
}

// createGamificationNarrator builds the narration port. aiClient is the same
// object food AI consumes (createAIClient) — null when no provider is wired.
export function createGamificationNarrator({ aiClient } = {}) {
  async function run(kind, payload) {
    // Invariant 3: absent provider degrades to nothing, never an error.
    if (!aiClient || typeof aiClient.chat !== 'function') {
      return { text: null, source: 'deterministic' };
    }
    try {
      const msg = await aiClient.chat({
        temperature: 0.6,
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
    narrateWeekly: (stats) => run('weekly', weeklyPayload(stats)),
    narrateChapter: (chapter) => run('chapter', chapterPayload(chapter)),
    suggestExperiments: (state) => run('experiments', experimentPayload(state)),
    narrateWorkout: (stats) => run('workout', workoutPayload(stats)),
  };
}
