// Unit suite for the Phase 6 AI narration seam (web/cloud/js/gamification-
// narrator.js). This layer is a browser-side prose wrapper over the pure
// deterministic engine, driven only by an injected aiClient — so a pure-unit
// test with a stub aiClient is the right shape (it has no integration entry
// point). The cases pin the three hard invariants the design forbids weakening
// (docs/design/2026-07-11-gamification-redesign.md §4.3):
//   1. Narrates, never computes: only whitelisted computed summaries leave for
//      the provider — never a raw vault record.
//   2. LLM numbers can never displace deterministic ones: the function returns
//      { text, source } and nothing the UI would treat as data.
//   3. Deterministic fallback everywhere: no key / provider error / empty reply
//      all resolve to { text: null } WITHOUT throwing.
import { describe, it, expect, vi } from 'vitest';
import {
  createGamificationNarrator,
  weeklyPayload,
  chapterPayload,
  experimentPayload,
  workoutPayload,
  NARRATOR_SYSTEM,
} from '../gamification-narrator.js';

// A stub aiClient shaped like createAIClient's return (only .chat is used).
function stubClient(impl) {
  return { chat: vi.fn(impl) };
}

// Read-model fixtures mirroring the domain outputs the apishim routes pass in.
// The weekly recap's input: getWeeklyReview, carrying fields
// that must NOT reach the wire (absolute weight, ids, dates, ring/score keys).
const WEEKLY_STATS = {
  review: {
    enabled: true, quiet: false,
    week: { id: '2026-W39', start_day: '2026-09-21', end_day: '2026-09-27' },
    week_start: 1790000000,
    rows: {
      weight: {
        feature_on: true, status: 'ok', goal_status: 'on_track', goal_direction: -1, progress_fraction: 0.36,
        trend_weight: 91.4, trend_change_kg: -0.6,
        distance_to_goal: 6.4, weigh_in_days: 4,
        milestones_reached: [{ id: 'gamificationmilestone-weightgoal-1-2', ordinal: 2, title: 'Weight goal milestone 2 of 5' }],
      },
      workouts: { feature_on: true, completed: 3, scheduled: 3 },
      bp: { feature_on: true, status: 'in_range', mean: { systolic: 124, diastolic: 79, days: 5 }, target: { systolic: 130, diastolic: 85 }, days_measured: 5 },
    },
    plan: { week: '2026-W40', intention: { id: 'weigh_before_coffee', text: 'When I wake, I will weigh in before coffee' }, cadence: null, paused: false, picked_at: '2026-09-28T07:00:00Z' },
    levers: [{ key: 'bp', closed_this_week: 5, closed_last_week: 3 }],
    health_score: { now: 71, prior: 68 },
  },
};

const CHAPTER_STATE = {
  enabled: true,
  review: {
    theme_id: 'steady_month', title: 'The Steady Month', focus: 'BP consistency',
    quiet: false, logged_days: 24, lines: ['24 days logged over your four weeks.', '18 nights of 7h+ sleep.'],
    text: 'Your Steady Month focused on BP consistency. 24 days logged over your four weeks. 18 nights of 7h+ sleep.',
  },
};

const EXPERIMENT_STATE = {
  experiments: {
    enabled: true, can_start: true, active: null,
    templates: [
      { id: 'bedtime_window', title: 'A steady bedtime window', measure: 'next-morning systolic', from_probe: 'short_sleep_next_morning_bp' },
      { id: 'move_before_bp', title: 'A walk before your reading', measure: 'systolic on move days', from_probe: 'workout_bp' },
    ],
  },
  atlas: {
    enabled: true,
    cards: [
      { id: 'sleep_bp', question: 'Does a longer night lower tomorrow’s BP?', state: 'revealed', text: 'On 7h+ nights your morning systolic ran 6 lower.', delta: -6, n: 40 },
      { id: 'dev', question: 'developing one', state: 'developing', text: 'Keep logging.' },
    ],
  },
};

const WORKOUT_STATS = {
  total_sessions: 18, completed_sessions: 15, skipped_sessions: 3, completion_rate: 83.33, active_weeks: 4,
  top_exercises: [{ exercise_name: 'Squat', session_count: 9, total_volume_kg: 5400, max_weight_kg: 80 }],
  weekly_activity: [{ week: '2026-06-01', completed: 3, skipped: 0 }],
};

// Raw-record STRUCTURAL field names that must NEVER appear in a wire payload —
// proof that only computed summaries cross the boundary (invariant 1). (Words
// like "systolic" legitimately appear inside human-readable summary prose; the
// leak we guard against is a raw record object, identified by its field keys.)
const RAW_RECORD_MARKERS = ['recordId', 'clientTs', '"deleted"', 'measured_at', 'taken_at', 'completed_at', 'total_volume_kg', 'max_weight_kg', 'heart_rate_avg', 'diastolic'];

function assertNoRawRecords(payload) {
  const json = JSON.stringify(payload);
  for (const marker of RAW_RECORD_MARKERS) {
    expect(json).not.toContain(marker);
  }
}

describe('gamification narrator — payload building (invariant 1: computed summaries only)', () => {
  it('weekly recap payload carries ONLY the whitelisted goal-review fields', () => {
    expect(weeklyPayload(WEEKLY_STATS)).toEqual({
      quiet: false,
      weight: {
        goal_status: 'on_track', goal_direction: 'lose', progress_fraction: 0.36,
        trend_change_kg: -0.6, distance_to_goal_kg: 6.4, weigh_in_days: 4, milestones_reached: 1,
      },
      workouts: { completed: 3, scheduled: 3 },
      bp: { status: 'in_range', days_measured: 5, mean_sys: 124, mean_dia: 79, target_sys: 130, target_dia: 85 },
      next_week: { intention: 'When I wake, I will weigh in before coffee', paused: false },
    });
    const json = JSON.stringify(weeklyPayload(WEEKLY_STATS));
    // No absolute body weight, dates, record/milestone ids or week keys.
    for (const leak of ['91.', '2026', 'gamificationmilestone', 'weightgoal', 'health_score', 'levers']) {
      expect(json).not.toContain(leak);
    }
    assertNoRawRecords(weeklyPayload(WEEKLY_STATS));
  });

  it('weekly recap payload drops feature-off rows and survives an empty review', () => {
    const off = { review: { rows: { weight: { feature_on: false }, workouts: { feature_on: false }, bp: { feature_on: false } }, plan: null } };
    expect(weeklyPayload(off)).toEqual({ quiet: false, weight: null, workouts: null, bp: null, next_week: null });
    expect(weeklyPayload()).toEqual({ quiet: false, weight: null, workouts: null, bp: null, next_week: null });
  });

  it('weekly prompt forbids attribution and asks for one intention reflection', async () => {
    const aiClient = stubClient(async () => ({ content: 'ok' }));
    await createGamificationNarrator({ aiClient }).narrateWeekly(WEEKLY_STATS);
    const user = aiClient.chat.mock.calls[0][0].messages[1].content;
    expect(user).toMatch(/without attribution/);
    expect(user).toMatch(/never that one thing caused/);
    expect(user).toMatch(/exactly one reflective sentence/);
  });

  it('caches one recap per reviewed week; a changed pick re-narrates; failures are not cached', async () => {
    let fail = true;
    const aiClient = stubClient(async () => { if (fail) throw new Error('down'); return { content: 'recap' }; });
    const n = createGamificationNarrator({ aiClient });
    await expect(n.narrateWeekly(WEEKLY_STATS)).resolves.toEqual({ text: null, source: 'deterministic' });
    fail = false;
    await expect(n.narrateWeekly(WEEKLY_STATS)).resolves.toEqual({ text: 'recap', source: 'ai' });
    await n.narrateWeekly(WEEKLY_STATS);
    expect(aiClient.chat).toHaveBeenCalledTimes(2);
    const repicked = { ...WEEKLY_STATS, review: { ...WEEKLY_STATS.review, plan: { ...WEEKLY_STATS.review.plan, paused: true } } };
    await n.narrateWeekly(repicked);
    expect(aiClient.chat).toHaveBeenCalledTimes(3);
  });

  it('chapter/workout payloads carry only computed summaries', () => {
    assertNoRawRecords(chapterPayload(CHAPTER_STATE));
    const wp = workoutPayload(WORKOUT_STATS);
    expect(wp).toMatchObject({ total_sessions_30d: 18, completed_30d: 15, completion_rate_pct: 83 });
    expect(wp.top_exercises).toEqual([{ name: 'Squat', sessions: 9 }]); // volume/max-weight dropped
    assertNoRawRecords(wp);
  });

  it('experiment suggestion payload forwards ONLY curated template ids (guardrail §5)', () => {
    const p = experimentPayload(EXPERIMENT_STATE);
    expect(p.templates.map((t) => t.id)).toEqual(['bedtime_window', 'move_before_bp']);
    // The model is handed template ids but cannot author a new experiment shape;
    // startExperiment (pure domain) still validates the id before anything runs.
    assertNoRawRecords(p);
  });

  it('system prompt forbids inventing numbers and medical advice', () => {
    expect(NARRATOR_SYSTEM).toMatch(/do not invent, recompute, or state any numeric value/i);
    expect(NARRATOR_SYSTEM).toMatch(/medical advice/i);
  });
});

describe('gamification narrator — invariant 3: deterministic fallback, never throws', () => {
  it('null aiClient → { text: null } (no key, bot mode)', async () => {
    const n = createGamificationNarrator({ aiClient: null });
    await expect(n.narrateWeekly(WEEKLY_STATS)).resolves.toEqual({ text: null, source: 'deterministic' });
    await expect(n.narrateWorkout(WORKOUT_STATS)).resolves.toEqual({ text: null, source: 'deterministic' });
  });

  it('provider error → { text: null } and does not throw', async () => {
    const aiClient = stubClient(async () => { throw new Error('402 provider payment required'); });
    const n = createGamificationNarrator({ aiClient });
    await expect(n.narrateChapter(CHAPTER_STATE)).resolves.toEqual({ text: null, source: 'deterministic' });
    await expect(n.suggestExperiments(EXPERIMENT_STATE)).resolves.toEqual({ text: null, source: 'deterministic' });
  });

  it('empty model reply → { text: null } (nothing additive to show)', async () => {
    const aiClient = stubClient(async () => ({ content: '   ' }));
    const n = createGamificationNarrator({ aiClient });
    await expect(n.narrateWeekly(WEEKLY_STATS)).resolves.toEqual({ text: null, source: 'deterministic' });
  });
});

describe('gamification narrator — invariants 1 & 2 on the wire', () => {
  it('sends the whitelisted stats-JSON (no raw records) and returns prose only', async () => {
    let sentUserMsg = '';
    const aiClient = stubClient(async ({ messages }) => {
      sentUserMsg = messages.find((m) => m.role === 'user').content;
      return { content: 'A calm, steady week — your bedtime held and it showed.' };
    });
    const n = createGamificationNarrator({ aiClient });
    const res = await n.narrateWeekly(WEEKLY_STATS);

    expect(res.source).toBe('ai');
    expect(res.text).toContain('calm, steady week');
    // Return shape carries ONLY text + source — no data field the UI could
    // mistake for an authoritative value (invariant 2).
    expect(Object.keys(res).sort()).toEqual(['source', 'text']);
    // The payload on the wire is computed summaries, never raw vault records.
    for (const marker of RAW_RECORD_MARKERS) expect(sentUserMsg).not.toContain(marker);
    // System prompt is always sent.
    expect(aiClient.chat.mock.calls[0][0].messages[0].content).toBe(NARRATOR_SYSTEM);
  });

  it('a model reply full of numbers is returned as PROSE only — it never becomes a data field', async () => {
    // The model hallucinates figures; the narrator hands them back verbatim as
    // TEXT inside a { text } field. It cannot and does not write any structured
    // stat — the deterministic read-models the UI renders are untouched.
    const aiClient = stubClient(async () => ({ content: 'Your BP is 999/500 and you slept 40 hours!' }));
    const n = createGamificationNarrator({ aiClient });
    const res = await n.narrateWeekly(WEEKLY_STATS);
    expect(res).toEqual({ text: 'Your BP is 999/500 and you slept 40 hours!', source: 'ai' });
    // The deterministic stats object passed in is unmodified — narration is
    // strictly downstream of computation.
    expect(WEEKLY_STATS.review.rows.weight.trend_change_kg).toBe(-0.6);
    expect(WEEKLY_STATS.review.rows.weight.progress_fraction).toBe(0.36);
  });
});
