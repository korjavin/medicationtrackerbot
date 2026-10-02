// gamification.goal-line.test.js
//
// Fixture-vault suite for the Goal Line read-model (web/domain/gamification.js
// getGoalLine, docs/gamification.md §0.3.1, bd med-8tur.1). Same shape as the
// Atlas/forecast suites: the domain layer is driven only by injected ports, so
// a seeded in-memory vault is its integration entry point. The shim route's
// flag gating is covered in cloud.shim-contract.settings.test.js.
import { describe, it, expect, vi } from 'vitest';
import { createGamificationDomain, projectedShift } from '../../../../web/domain/gamification.js';
import { recordsToVault, vaultToRecords } from '../../../../web/domain/vault.js';
import { createInMemoryRecordsPort, applyIncomingReplica } from './helpers/cloud-shim-harness.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 17, 12, 0, 0); // Wed 2026-06-17 noon; ISO week Mon 06-15 … Sun 06-21
const TZ = 'UTC';

function domainOver(seed) {
  const records = createInMemoryRecordsPort(seed);
  // The read path must never write (no derived rows, no memo records).
  records.put = vi.fn(records.put);
  records.putIfAbsent = vi.fn(records.putIfAbsent);
  if (records.del) records.del = vi.fn(records.del);
  const gam = createGamificationDomain({ records, now: () => NOW, timeZone: TZ });
  return { records, gam };
}

function expectNoWrites(records) {
  expect(records.put).not.toHaveBeenCalled();
  expect(records.putIfAbsent).not.toHaveBeenCalled();
  if (records.del) expect(records.del).not.toHaveBeenCalled();
}

// Readings at 07:00 `offset` days before today; goals set at 09:00.
const isoAt = (offset, hour = 7) => new Date(NOW - offset * DAY_MS - (12 - hour) * 3600000).toISOString();
const weightRec = (offset, weight) => ({ recordId: `w-${offset}`, deleted: false, measured_at: isoAt(offset), weight });
const goalRec = (offset, target, startWeight) => ({
  recordId: 'weightgoal-episode-1', deleted: false, set_at: isoAt(offset, 9), target_weight: target, start_weight: startWeight,
});
const series = (days, fn) => Array.from({ length: days }, (_, offset) => weightRec(offset, fn(offset)));

const GROUP = {
  recordId: 'workoutgroup-7', id: 7, deleted: false, name: 'Push', active: true,
  days_of_week: '[1,3,5]', scheduled_time: '18:00', is_rotating: false,
};
const VARIANT = { recordId: 'workoutvariant-70', id: 70, group_id: 7, deleted: false, name: 'A' };
const bpRec = (offset, systolic, diastolic) => ({
  recordId: `bp-${offset}`, deleted: false, measured_at: isoAt(offset), systolic, diastolic, ignore_calc: false,
});

describe('gamification Goal Line — weight goal', () => {
  it('no goal → no_goal, with the workout and BP rows still populated', async () => {
    const { records, gam } = domainOver({
      workoutgroup: [GROUP], workoutvariant: [VARIANT],
      bp: [bpRec(0, 128, 82), bpRec(1, 128, 82), bpRec(2, 128, 82)],
      bpgoal: [{ recordId: 'bpgoal', deleted: false, target_systolic: 130, target_diastolic: 85 }],
    });
    const gl = await gam.getGoalLine();

    expect(gl.goal.status).toBe('no_goal');
    expect(gl.goal.target).toBeNull();
    expect(gl.goal.progress).toBeNull();
    expect(gl.workouts.feature_on).toBe(true);
    expect(gl.workouts.scheduled_this_week).toBe(3); // Mon, Wed, Fri
    expect(gl.workouts.next_scheduled).toEqual({ day: '2026-06-17', time: '18:00', group_title: 'Push' });
    expect(gl.bp).toMatchObject({
      feature_on: true, recorded_today: true, days_this_week: 3,
      mean_7d: { systolic: 128, diastolic: 82, days: 3 },
      target: { systolic: 130, diastolic: 85 }, status: 'in_range',
    });
    expect(gl.weighed_today).toBe(false);
    expect(gl.cta).toBe('weigh_in');
    expectNoWrites(records);
  });

  it('3 readings → preliminary: the latest reading as a reading, never a trend', async () => {
    const { gam } = domainOver({
      weight: [weightRec(0, 84), weightRec(3, 84.4), weightRec(6, 85)],
      weightgoal: [goalRec(6, 78, 85)],
    });
    const { goal } = await gam.getGoalLine();

    expect(goal.status).toBe('preliminary');
    expect(goal.trend_weight).toBeNull();
    expect(goal.change_7d).toBeNull();
    expect(goal.next_milestone).toBeNull();
    expect(goal.latest_reading).toEqual({ weight: 84, measured_at: isoAt(0) });
    expect(goal.start_ref).toBe(85);
    expect(goal.start_ref_source).toBe('first_reading');
    expect(goal.distance_to_goal).toBe(6);
    // progress reads off the same reading as the distance: 1 of 7 kg.
    expect(goal.progress).toEqual({ done_kg: 1, total_kg: 7, fraction: 0.143 });
    expect(goal.coverage).toEqual({ weigh_in_days_28d: 3, last_weigh_in_day: '2026-06-17', min_weigh_in_days: 5 });
  });

  it('a preliminary reading past the target caps progress at the target — never "8 of 7 kg"', async () => {
    const { gam } = domainOver({
      weight: [weightRec(0, 77), weightRec(6, 85)],
      weightgoal: [goalRec(6, 78, 85)],
    });
    const { goal } = await gam.getGoalLine();

    expect(goal.status).toBe('preliminary');
    expect(goal.progress).toEqual({ done_kg: 7, total_kg: 7, fraction: 1 });
  });

  it('a maintenance goal (target == baseline) is 1 within reach, 0 when away from it', async () => {
    const near = await domainOver({ weight: [weightRec(0, 80.2)], weightgoal: [goalRec(1, 80, 80)] }).gam.getGoalLine();
    expect(near.goal.direction).toBe(0);
    expect(near.goal.progress).toEqual({ done_kg: 0, total_kg: 0, fraction: 1 });
    const away = await domainOver({ weight: [weightRec(0, 82)], weightgoal: [goalRec(1, 80, 80)] }).gam.getGoalLine();
    expect(away.goal.progress.fraction).toBe(0);
  });

  it('a maintenance goal is reached only within reach of the target — 85 kg against 80 is not "maintaining"', async () => {
    const away = await domainOver({ weight: series(20, () => 85), weightgoal: [goalRec(19, 80, 80)] }).gam.getGoalLine();
    expect(away.goal.direction).toBe(0);
    expect(away.goal.status).toBe('ok');
    expect(away.goal.progress.fraction).toBe(0);
    expect(away.goal.distance_to_goal).toBe(5);

    const near = await domainOver({ weight: series(20, () => 80.2), weightgoal: [goalRec(19, 80, 80)] }).gam.getGoalLine();
    expect(near.goal.status).toBe('maintaining');
    expect(near.goal.progress.fraction).toBe(1);
  });

  it('the episode baseline ignores a weigh-in later on the set day than set_at', async () => {
    // 85 kg every morning; goal set at 09:00 three days ago, then a 70 kg
    // reading at 20:00 that same day must not move trend_at_set.
    const { gam } = domainOver({
      weight: [...series(10, () => 85), { recordId: 'w-3-late', deleted: false, measured_at: isoAt(3, 20), weight: 70 }],
      weightgoal: [goalRec(3, 80, 85)],
    });
    const { goal } = await gam.getGoalLine();
    expect(goal.start_ref_source).toBe('trend_at_set');
    expect(goal.start_ref).toBe(85);
  });

  it('a 60-day downward trend + goal → ok with distance, change_7d, next milestone and direction', async () => {
    // 0.05 kg/day down (≈0.4 %/wk — inside the safe pace), goal set 30 days ago.
    const { records, gam } = domainOver({
      weight: series(60, (o) => 87 + 0.05 * o),
      weightgoal: [goalRec(30, 80, 88.5)],
    });
    const { goal } = await gam.getGoalLine();

    expect(goal.status).toBe('ok');
    expect(goal.episode_id).toBe('weightgoal-episode-1');
    expect(goal.direction).toBe(-1);
    // ≥5 weigh-in days precede the set day → the baseline is the trend there,
    // labeled as such (not the recorded 88.5 start reading).
    expect(goal.start_ref_source).toBe('trend_at_set');
    expect(goal.start_ref).toBeCloseTo(88.93, 1);
    expect(goal.start_day).toBe('2026-05-18');
    expect(goal.trend_weight).toBeCloseTo(87.45, 1);
    expect(goal.distance_to_goal).toBeCloseTo(goal.trend_weight - 80, 2);
    expect(goal.progress.total_kg).toBeCloseTo(goal.start_ref - 80, 1);
    expect(goal.progress.done_kg + goal.distance_to_goal).toBeCloseTo(goal.progress.total_kg, 1);
    expect(goal.progress.fraction).toBeCloseTo(goal.progress.done_kg / goal.progress.total_kg, 2);
    expect(goal.change_7d).toBeCloseTo(-0.35, 1);
    expect(goal.too_fast).toBe(false);
    // 1 kg spacing from the baseline: marker 1 (≈87.93) passed, marker 2 next.
    expect(goal.next_milestone).toMatchObject({ ordinal: 2, count: 9, is_goal: false });
    expect(goal.next_milestone.weight).toBeCloseTo(86.93, 1);
    expect(goal.coverage.weigh_in_days_28d).toBe(28);
    expectNoWrites(records);
  });

  it('trend within reach of the target → at_goal', async () => {
    const { gam } = domainOver({
      weight: series(60, (o) => (o < 20 ? 80.1 : 80.1 + 0.15 * (o - 20))),
      weightgoal: [goalRec(59, 80, 87.6)],
    });
    const { goal } = await gam.getGoalLine();

    expect(goal.status).toBe('at_goal');
    expect(goal.direction).toBe(-1);
    expect(goal.next_milestone).toBeNull();
    expect(goal.progress.fraction).toBe(1);
  });

  it('crossing the target and then regressing never flips the direction', async () => {
    // 85 → 78 over 40 days (crosses 80), then back up to 82 over 30 days.
    const { gam } = domainOver({
      weight: Array.from({ length: 70 }, (_, i) => weightRec(69 - i, i < 40 ? 85 - (7 * i) / 40 : 78 + (4 * (i - 40)) / 30)),
      weightgoal: [goalRec(69, 80, 85)],
    });
    const { goal } = await gam.getGoalLine();

    expect(goal.trend_weight).toBeGreaterThan(80.5);
    expect(goal.status).toBe('ok');
    expect(goal.direction).toBe(-1); // still "lose toward 80", not "gain"
    expect(goal.change_7d).toBeGreaterThan(0);
    expect(goal.next_milestone.is_goal).toBe(true);
  });

  it('a long weigh-in gap restarts the trend — a year-old EMA is never the baseline', async () => {
    // 5 days at 100 kg a year ago; back at 90 kg for the last 8 days with a
    // gain goal of 95 set 7 days ago (start_weight 90 recorded at set time).
    const { gam } = domainOver({
      weight: [
        ...[0, 1, 2, 3, 4].map((k) => weightRec(365 + k, 100)),
        ...series(8, () => 90),
      ],
      weightgoal: [goalRec(7, 95, 90)],
    });
    const { goal } = await gam.getGoalLine();

    expect(goal.start_ref_source).toBe('first_reading');
    expect(goal.start_ref).toBe(90);
    expect(goal.direction).toBe(1);
    expect(goal.trend_weight).toBe(90);
    expect(goal.status).toBe('ok');
  });

  it('a gap AFTER the set day never moves the episode baseline', async () => {
    // 31 days at 90 up to the set day (offset 100), a 49-day gap, then 51 days at 85.
    const before = Array.from({ length: 31 }, (_, k) => weightRec(100 + k, 90));
    const after = Array.from({ length: 51 }, (_, k) => weightRec(k, 85));
    const { gam } = domainOver({ weight: [...before, ...after], weightgoal: [goalRec(100, 80, 89.4)] });
    const { goal } = await gam.getGoalLine();

    expect(goal.start_ref_source).toBe('trend_at_set');
    expect(goal.start_ref).toBe(90);
    expect(goal.direction).toBe(-1);
    expect(goal.trend_weight).toBeCloseTo(85, 1); // the current run's own trend
  });

  it('a 2 %/week drop raises too_fast (the only pace judgment)', async () => {
    const { gam } = domainOver({
      weight: series(60, (o) => 100 * (1 + (0.02 / 7) * o)),
      weightgoal: [goalRec(59, 80, 117)],
    });
    const { goal } = await gam.getGoalLine();

    expect(goal.status).toBe('ok');
    expect(goal.too_fast).toBe(true);
  });
});

// goal.projected (med-8tur.7): a date with a ± weeks range from the spread of
// the four weekly trend velocities, only under coverage/freshness/horizon rules.
describe('gamification Goal Line — projected date ± weeks', () => {
  const steady = (o) => 87 + 0.05 * o; // 0.35 kg/week down, 7.45 kg from the 80 kg goal
  const projectedOf = async (weight, goal = goalRec(30, 80, 88.5)) =>
    (await domainOver({ weight, weightgoal: [goal] }).gam.getGoalLine()).goal;

  it('a steady trend → around a date, ± 1 week', async () => {
    const goal = await projectedOf(series(60, steady));
    expect(goal.status).toBe('ok');
    // (7.45 − 0.5 reach) kg ÷ 0.35 kg/week ≈ 19.9 weeks from 2026-06-17.
    expect(goal.projected).toEqual({ date: '2026-11-05', plus_minus_weeks: 1, reason: null });
  });

  it('a noisy trend at the same mean pace → a wider ± around a similar date', async () => {
    // Alternating ±0.1 kg weekly steps on top of the steady line: the weekly
    // trend velocities spread, so the range widens (and the midpoint drifts later,
    // since distance/v is convex in v).
    const goal = await projectedOf(series(60, (o) => steady(o) + (Math.floor(o / 7) % 2 ? 0.1 : -0.1)));
    expect(goal.projected).toEqual({ date: '2026-11-12', plus_minus_weeks: 5, reason: null });
  });

  it('too_fast never carries a date', async () => {
    const goal = await projectedOf(series(60, (o) => 100 * (1 + (0.02 / 7) * o)), goalRec(59, 80, 117));
    expect(goal.too_fast).toBe(true);
    expect(goal.projected).toEqual({ date: null, plus_minus_weeks: null, reason: 'too_fast' });
  });

  it('fewer than 8 weigh-in days in 28 → sparse', async () => {
    const goal = await projectedOf(series(60, steady).filter((_, o) => o % 4 === 0));
    expect(goal.status).toBe('ok');
    expect(goal.projected).toMatchObject({ date: null, reason: 'sparse' });
  });

  it('no reading in the last 7 days → stale', async () => {
    const goal = await projectedOf(series(60, steady).filter((_, o) => o >= 8));
    expect(goal.status).toBe('ok');
    expect(goal.projected).toMatchObject({ date: null, reason: 'stale' });
  });

  it('a trend run younger than 28 days → short_window', async () => {
    const goal = await projectedOf(series(20, steady), goalRec(19, 80, 88));
    expect(goal.status).toBe('ok');
    expect(goal.projected).toMatchObject({ date: null, reason: 'short_window' });
  });

  it('trending away from the goal → not_toward, no date', async () => {
    const goal = await projectedOf(series(60, (o) => 87 - 0.05 * o));
    expect(goal.projected).toMatchObject({ date: null, reason: 'not_toward' });
  });

  it('a stalled or reversed week leaves the range unbounded → unsteady, no date', async () => {
    // Steady loss, except the trend rose over the last week.
    const goal = await projectedOf(series(60, (o) => (o < 7 ? steady(7) + 0.2 * (7 - o) : steady(o))));
    expect(goal.projected).toMatchObject({ date: null, reason: 'unsteady' });
  });

  it('a latest end past 12 months → beyond_horizon (the UI says "more than a year at this pace")', async () => {
    const goal = await projectedOf(series(60, (o) => 87 + 0.01 * o), goalRec(30, 70, 88.5));
    expect(goal.projected).toMatchObject({ date: null, plus_minus_weeks: null, reason: 'beyond_horizon' });
  });

  it('non-ok statuses carry their status as the reason', async () => {
    expect((await domainOver({ weight: series(60, steady) }).gam.getGoalLine()).goal.projected.reason).toBe('no_goal');
    expect((await projectedOf([weightRec(0, 84), weightRec(6, 85)], goalRec(6, 78, 85))).projected.reason).toBe('preliminary');
    const atGoal = await projectedOf(series(60, (o) => (o < 20 ? 80.1 : 80.1 + 0.15 * (o - 20))), goalRec(59, 80, 87.6));
    expect(atGoal.projected).toMatchObject({ date: null, reason: 'at_goal' });
  });

  it('week-over-week shift is reported only when both weeks have a date', () => {
    expect(projectedShift({ date: '2026-11-15' }, { date: '2026-11-01' })).toBe('earlier');
    expect(projectedShift({ date: '2026-11-01' }, { date: '2026-11-15' })).toBe('later');
    expect(projectedShift({ date: '2026-11-15' }, { date: '2026-11-18' })).toBe('unchanged');
    expect(projectedShift({ date: null, reason: 'sparse' }, { date: '2026-11-15' })).toBeNull();
    expect(projectedShift({ date: '2026-11-15' }, { date: null, reason: 'too_fast' })).toBeNull();
    expect(projectedShift(null, { date: '2026-11-15' })).toBeNull();
  });
});

describe('gamification Goal Line — workouts, BP, cta', () => {
  it('counts distinct completed sessions (two on one day = 2, many logs = 1 each); last week does not count', async () => {
    const { gam } = domainOver({
      workoutgroup: [GROUP], workoutvariant: [VARIANT],
      weight: [weightRec(0, 80)],
      workoutsession: [
        { recordId: 'session-7-2026-06-15', deleted: false, group_id: 7, status: 'completed', scheduled_date: '2026-06-15T00:00:00Z' },
        { recordId: 'adhoc-1', deleted: false, group_id: -1, status: 'completed', scheduled_date: '2026-06-15T00:00:00Z' },
        { recordId: 'session-7-2026-06-12', deleted: false, group_id: 7, status: 'completed', scheduled_date: '2026-06-12T00:00:00Z' },
      ],
      workoutlog: [1, 2, 3, 4].map((k) => ({ recordId: `log-${k}`, deleted: false, session_id: 'session-7-2026-06-15' })),
    });
    const gl = await gam.getGoalLine();

    // Not the one-flag-per-day map: both 06-15 sessions count.
    expect(gl.workouts.completed_this_week).toBe(2);
    // The denominator is the plan (Mon/Wed/Fri); the extra ad-hoc session is not "scheduled".
    expect(gl.workouts.scheduled_this_week).toBe(3);
    // weighed today + next scheduled session is today (18:00) → start_session.
    expect(gl.weighed_today).toBe(true);
    expect(gl.workouts.next_scheduled.day).toBe('2026-06-17');
    expect(gl.cta).toBe('start_session');
  });

  it('ad-hoc-only user → scheduled_this_week is null, never a guessed number', async () => {
    const { gam } = domainOver({
      workoutsession: [{
        recordId: 'adhoc-2', deleted: false, group_id: -1, status: 'pending',
        scheduled_date: '2026-06-19T00:00:00Z', scheduled_time: '07:30',
      }],
    });
    const { workouts } = await gam.getGoalLine();

    expect(workouts.scheduled_this_week).toBeNull();
    expect(workouts.next_scheduled).toEqual({ day: '2026-06-19', time: '07:30', group_title: null });
  });

  it('a tombstoned scheduled day is not counted as scheduled', async () => {
    const { gam } = domainOver({
      workoutgroup: [GROUP], workoutvariant: [VARIANT],
      workoutsession: [
        { recordId: 'session-7-2026-06-15', deleted: true, clientTs: NOW - DAY_MS },
        { recordId: 'session-7-2026-06-17', deleted: true, clientTs: NOW - DAY_MS },
      ],
    });
    const { workouts } = await gam.getGoalLine();

    expect(workouts.scheduled_this_week).toBe(1); // only Friday remains
    expect(workouts.next_scheduled).toEqual({ day: '2026-06-19', time: '18:00', group_title: 'Push' });
  });

  it('a snoozed (notified) session today is still next and drives start_session', async () => {
    const { gam } = domainOver({
      workoutgroup: [GROUP], workoutvariant: [VARIANT],
      weight: [weightRec(0, 80)],
      workoutsession: [{
        recordId: 'session-7-2026-06-17', deleted: false, group_id: 7, status: 'notified', scheduled_date: '2026-06-17T00:00:00Z',
      }],
    });
    const gl = await gam.getGoalLine();

    expect(gl.workouts.next_scheduled.day).toBe('2026-06-17');
    expect(gl.cta).toBe('start_session');
  });

  it('a pre-skipped (declined) session today is not next — Friday is', async () => {
    const { gam } = domainOver({
      workoutgroup: [GROUP], workoutvariant: [VARIANT],
      weight: [weightRec(0, 80)],
      workoutsession: [{
        recordId: 'session-7-2026-06-17', deleted: false, group_id: 7, status: 'pre_skipped', scheduled_date: '2026-06-17T00:00:00Z',
      }],
    });
    const gl = await gam.getGoalLine();

    expect(gl.workouts.next_scheduled.day).toBe('2026-06-19');
    expect(gl.cta).toBe('none');
  });

  it('an active plan with no weekdays gives no denominator', async () => {
    const { gam } = domainOver({ workoutgroup: [{ ...GROUP, days_of_week: '[]' }], workoutvariant: [VARIANT] });
    const { workouts } = await gam.getGoalLine();

    expect(workouts.scheduled_this_week).toBeNull();
    expect(workouts.next_scheduled).toBeNull();
  });

  it('BP missing → status unknown; mean above the goal → above', async () => {
    const empty = await domainOver({}).gam.getGoalLine();
    expect(empty.bp).toMatchObject({ recorded_today: false, days_this_week: 0, mean_7d: null, status: 'unknown' });

    const high = await domainOver({
      bp: [bpRec(0, 120, 90), bpRec(1, 122, 88)],
      bpgoal: [{ recordId: 'bpgoal', deleted: false, target_systolic: 130, target_diastolic: 85 }],
    }).gam.getGoalLine();
    expect(high.bp.status).toBe('above'); // diastolic over target — both components count
  });

  it('feature off → feature_on false on that row', async () => {
    const { gam } = domainOver({
      workoutgroup: [GROUP], workoutvariant: [VARIANT], bp: [bpRec(0, 120, 80)],
    });
    const gl = await gam.getGoalLine({ features: { weight: true, workout: false, bp: false, gamification: true } });

    expect(gl.workouts).toEqual({ feature_on: false, completed_this_week: null, next_scheduled: null, scheduled_this_week: null });
    expect(gl.bp.feature_on).toBe(false);
    expect(gl.bp.mean_7d).toBeNull();
    expect(gl.cta).toBe('weigh_in');

    const noWeight = await gam.getGoalLine({ features: { weight: false, workout: true, bp: true, gamification: true } });
    expect(noWeight.cta).toBe('start_session'); // weigh_in skipped; today's 18:00 plan session is next
  });

  // med-8tur.2: the Today card's day key + the medication safety net the rings
  // tile used to carry (same adherenceAlertView source), gated on medication.
  it('carries its local-day key, its zone and the adherence alert (null with medication off)', async () => {
    const { records, gam } = domainOver({});
    const gl = await gam.getGoalLine();
    expect(gl.day).toBe('2026-06-17');
    expect(gl.time_zone).toBe('UTC');
    expect(gl.adherence_alert).toEqual({ active: false, pdc: 0, missed_doses: 0 });
    const off = await gam.getGoalLine({ features: { medication: false, weight: true, workout: true, bp: true, gamification: true } });
    expect(off.adherence_alert).toBeNull();
    expectNoWrites(records);
  });
});

// Durable goal milestones (docs/gamification.md §0.3.5, bd med-8tur.5): reached
// markers materialize floored (putIfAbsent, clientTs 0) from the Goal Line read
// path; acknowledgment is a separate user write; vault round-trip keeps both.
describe('gamification Goal Line — durable milestones', () => {
  // Goal set 20 days ago from a recorded 85 kg start (no earlier readings →
  // first_reading baseline), target 80: 1 kg spacing, 5 markers. The trend sits
  // at 83.8 from the first weigh-in; a day counts once the trend is established
  // (5th weigh-in day, offset 16), so marker 1 (84) is earned on the third
  // established day (offset 14 = 2026-06-03) and marker 2 (83) never.
  const crossing = () => ({ weight: series(21, () => 83.8), weightgoal: [goalRec(20, 80, 85)] });
  const MS_ID = 'gamificationmilestone-weightgoal-episode-1-1';

  it('a seeded crossing creates exactly one floored record, earned on the evidence day', async () => {
    const { records, gam } = domainOver(crossing());
    const gl = await gam.getGoalLineCard();

    expect(gl.goal.status).toBe('ok');
    expect(gl.milestone).toEqual({
      id: MS_ID, ordinal: 1, count: 5, is_halfway: false, is_goal: false,
      earned_at: '2026-06-03', title: 'Weight goal milestone 1 of 5',
    });
    expect(records.put).not.toHaveBeenCalled();
    expect(records.putIfAbsent).toHaveBeenCalledTimes(1);
    expect(records.putIfAbsent.mock.calls[0][1]).toMatchObject({ recordId: MS_ID, clientTs: 0, acknowledged: false });

    await gam.getGoalLineCard(); // re-read: no duplicate
    expect(await records.list('gamificationmilestone')).toHaveLength(1);
  });

  it('a single low reading does not fire a milestone', async () => {
    const weight = series(21, (o) => (o === 10 ? 80 : 85));
    const { records, gam } = domainOver({ weight, weightgoal: [goalRec(20, 80, 85)] });
    expect((await gam.getGoalLineCard()).milestone).toBeNull();
    expect(await records.list('gamificationmilestone')).toHaveLength(0);

    // …nor at the start of a run, where the EMA seeds on the raw reading: a
    // goal from 85 after a long gap, then 82.5, 84.5, 84.5 (still preliminary).
    const run = domainOver({
      weight: [weightRec(2, 82.5), weightRec(1, 84.5), weightRec(0, 84.5), weightRec(90, 85)],
      weightgoal: [goalRec(3, 80, 85)],
    });
    expect((await run.gam.getGoalLineCard()).milestone).toBeNull();
    expect(await run.records.list('gamificationmilestone')).toHaveLength(0);
  });

  it('the goal milestone fires within reach of the target even when the last marker is stricter', async () => {
    // 85.3 → 80: 1 kg markers, marker 5 sits at 80.3; a trend holding at 80.4
    // is at_goal (within 0.5 kg), so the goal ordinal — and 5 with it — is earned.
    const { records, gam } = domainOver({ weight: series(10, () => 80.4), weightgoal: [goalRec(9, 80, 85.3)] });
    const gl = await gam.getGoalLineCard();
    expect(gl.goal.status).toBe('at_goal');
    expect(gl.milestone).toMatchObject({ ordinal: 6, count: 6, is_goal: true, title: 'Weight goal reached' });
    const earned = (await records.list('gamificationmilestone')).sort((a, b) => a.ordinal - b.ordinal);
    expect(earned.map((m) => m.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(earned.map((m) => m.earned_at)).size).toBe(1); // nested thresholds: one evidence day for all
  });

  it('ack retires the card line; re-reads and another device\'s floored replay never clobber it', async () => {
    const { records, gam } = domainOver(crossing());
    await gam.getGoalLineCard();
    expect(await gam.acknowledgeMilestone(MS_ID)).toEqual({ ok: true });
    const [acked] = await records.list('gamificationmilestone');
    expect(acked).toMatchObject({ acknowledged: true, acknowledged_at: NOW, clientTs: NOW });

    expect((await gam.getGoalLineCard()).milestone).toBeNull();
    expect((await records.list('gamificationmilestone'))[0].acknowledged).toBe(true);

    // Device B derives its own floored copy before A's ack arrives; strict-`>`
    // LWW keeps the ack in both apply orders.
    const b = domainOver(crossing());
    await b.gam.getGoalLineCard();
    const [floored] = await b.records.list('gamificationmilestone');
    expect(floored.clientTs).toBe(0);
    expect(applyIncomingReplica(floored, acked)).toBe(acked);
    expect(applyIncomingReplica(acked, floored)).toBe(acked);

    expect(await gam.acknowledgeMilestone('gamificationmilestone-nope-1')).toEqual({ ok: false, error: 'not_found' });
  });

  it('a goal edit starts a new series; the old episode\'s record stays (a keystone), off the card', async () => {
    const { records, gam } = domainOver(crossing());
    await gam.getGoalLineCard();
    await records.put('weightgoal', {
      recordId: 'weightgoal-episode-2', deleted: false, set_at: isoAt(2, 9), target_weight: 78, start_weight: 83.8,
    });
    const gl = await gam.getGoalLineCard();
    expect(gl.goal.episode_id).toBe('weightgoal-episode-2');
    expect(gl.milestone).toBeNull(); // 82.8 not reached yet
    expect((await records.list('gamificationmilestone')).map((m) => m.recordId)).toEqual([MS_ID]);

    const { keystones } = await gam.getKeystones();
    expect(keystones).toContainEqual({
      id: MS_ID, kind: 'goal_milestone', title: 'Weight goal milestone 1 of 5',
      earned_at: Date.parse('2026-06-03T12:00:00Z'),
    });
  });

  it('a twin left under a dead episode id (old-client import) shows as ONE keystone — the live one', async () => {
    const { records, gam } = domainOver(crossing());
    await gam.getGoalLineCard();
    const [live] = await records.list('gamificationmilestone');
    await records.put('gamificationmilestone', {
      ...live, recordId: 'gamificationmilestone-weightgoal-dead-1', episode_id: 'weightgoal-dead', acknowledged: true,
    });
    const goalKeystones = (await gam.getKeystones()).keystones.filter((k) => k.kind === 'goal_milestone');
    expect(goalKeystones.map((k) => k.id)).toEqual([MS_ID]);
  });

  it('an old client\'s import (goal re-minted, milestone passed through) mints no twin; export keeps one row per key', async () => {
    const first = domainOver(crossing());
    await first.gam.getGoalLineCard();
    await first.gam.acknowledgeMilestone(MS_ID);
    const [acked] = await first.records.list('gamificationmilestone');

    // The old client re-mints the goal id (same set_at) and leaves the
    // milestone under the now-dead episode id.
    const { weight, weightgoal: [goal] } = crossing();
    const { records, gam } = domainOver({
      weight, weightgoal: [{ ...goal, recordId: 'weightgoal-reminted' }], gamificationmilestone: [acked],
    });
    expect((await gam.getGoalLineCard()).milestone).toBeNull(); // no re-celebration
    expect(records.putIfAbsent).not.toHaveBeenCalled();
    expect(await records.list('gamificationmilestone')).toHaveLength(1);

    // A store already holding an unacknowledged twin exports one row, the ack.
    await records.put('gamificationmilestone', {
      ...acked, recordId: 'gamificationmilestone-weightgoal-reminted-1', episode_id: 'weightgoal-reminted',
      acknowledged: false, acknowledged_at: undefined, clientTs: 0,
    });
    const all = [];
    for (const t of ['weight', 'weightgoal', 'gamificationmilestone']) {
      for (const r of await records.listRaw(t)) all.push({ ...r, recordType: t });
    }
    const { milestones } = recordsToVault(all, { now: NOW }).data.gamification;
    expect(milestones).toHaveLength(1);
    expect(milestones[0].acknowledged).toBe(true);

    // An UNacknowledged milestone left under the dead id still reaches the card
    // (minted under the live episode) and can be acknowledged there.
    const pending = domainOver({
      weight, weightgoal: [{ ...goal, recordId: 'weightgoal-reminted' }],
      gamificationmilestone: [{ ...acked, acknowledged: false, acknowledged_at: undefined, clientTs: 0 }],
    });
    const card = await pending.gam.getGoalLineCard();
    expect(card.milestone).toMatchObject({ id: 'gamificationmilestone-weightgoal-reminted-1', ordinal: 1 });
    expect(await pending.gam.acknowledgeMilestone(card.milestone.id)).toEqual({ ok: true });
    expect((await pending.gam.getGoalLineCard()).milestone).toBeNull();
  });

  it('vault export → import keeps the record and its ack, re-attached to the re-minted goal', async () => {
    const { records, gam } = domainOver(crossing());
    await gam.getGoalLineCard();
    await gam.acknowledgeMilestone(MS_ID);
    const all = [];
    for (const t of ['weight', 'weightgoal', 'gamificationmilestone']) {
      for (const r of await records.listRaw(t)) all.push({ ...r, recordType: t });
    }
    const vault = recordsToVault(all, { now: NOW });
    expect(vault.data.gamification.milestones).toHaveLength(1);

    const imported = vaultToRecords(vault, { now: NOW });
    const seed = {};
    for (const r of imported) (seed[r.recordType] = seed[r.recordType] || []).push(r);
    const [goal] = seed.weightgoal;
    expect(goal.recordId).not.toBe('weightgoal-episode-1'); // import re-mints goal ids
    expect(seed.gamificationmilestone).toEqual([expect.objectContaining({
      recordId: `gamificationmilestone-${goal.recordId}-1`, episode_id: goal.recordId,
      acknowledged: true, earned_at: '2026-06-03',
    })]);

    const after = domainOver(seed);
    expect((await after.gam.getGoalLineCard()).milestone).toBeNull(); // ack survived, no re-celebration
    expect(await after.records.list('gamificationmilestone')).toHaveLength(1);
  });
});

// Weekly review re-anchored on the goal + the next-week plan (docs/gamification.md
// §0.3.4, bd med-8tur.4): the most recently COMPLETED local week as three fact
// rows, and one user-written gamificationweek-<isoWeekYear>-W<ww> record.
describe('gamification weekly review + week plan', () => {
  const MON = Date.UTC(2026, 5, 22, 12, 0, 0); // Mon 2026-06-22 (2026-W26); last week = 06-15 … 06-21
  const SUN = Date.UTC(2026, 5, 28, 12, 0, 0); // Sun 2026-06-28 (still 2026-W26)
  const at = (nowMs, seed, tz = TZ) => {
    const records = createInMemoryRecordsPort(seed);
    records.put = vi.fn(records.put);
    return { records, gam: createGamificationDomain({ records, now: () => nowMs, timeZone: tz }) };
  };
  // 07:00 UTC `offset` days before MON.
  const isoMon = (offset) => new Date(MON - offset * DAY_MS - 5 * 3600000).toISOString();
  const wMon = (offset, weight) => ({ recordId: `w-${offset}`, deleted: false, measured_at: isoMon(offset), weight });
  const bpMon = (offset, systolic, diastolic) => ({
    recordId: `bp-${offset}`, deleted: false, measured_at: isoMon(offset), systolic, diastolic, ignore_calc: false,
  });
  const weekRec = (week, extra) => ({
    recordId: `gamificationweek-${week}`, deleted: false, clientTs: 1, week,
    intention_id: null, cadence: { weigh_in: 'weekly', bp_days: null }, paused: false, picked_at: 1, ...extra,
  });

  it('a Monday read reviews last week (Mon–Sun), never the partial live week', async () => {
    const { records, gam } = at(MON, {
      weight: Array.from({ length: 40 }, (_, o) => wMon(o, 85 + 0.05 * o)),
      weightgoal: [{ recordId: 'weightgoal-episode-1', deleted: false, set_at: isoMon(30), target_weight: 80, start_weight: 86.5 }],
      // Thu + Sat last week; today's (Monday) high reading belongs to THIS week.
      bp: [bpMon(4, 130, 84), bpMon(2, 126, 80), bpMon(0, 150, 99)],
      bpgoal: [{ recordId: 'bpgoal', deleted: false, target_systolic: 130, target_diastolic: 85 }],
      workoutgroup: [GROUP], workoutvariant: [VARIANT],
      workoutsession: [{ recordId: 'session-7-2026-06-17', deleted: false, status: 'completed', scheduled_date: '2026-06-17T18:00:00Z', group_id: 7 }],
      gamificationmilestone: [{
        recordId: 'gamificationmilestone-weightgoal-episode-1-1', deleted: false, episode_id: 'weightgoal-episode-1',
        ordinal: 1, count: 7, is_halfway: false, is_goal: false, earned_at: '2026-06-18', acknowledged: false,
      }],
    });
    const wr = await gam.getWeeklyReview();

    expect(wr.week).toEqual({ id: '2026-W25', start_day: '2026-06-15', end_day: '2026-06-21' });
    expect(wr.rows.weight).toMatchObject({
      feature_on: true, status: 'ok', goal_status: 'ok', weigh_in_days: 7,
      milestones_reached: [{ id: 'gamificationmilestone-weightgoal-episode-1-1', ordinal: 1, title: 'Weight goal milestone 1 of 7' }],
    });
    expect(wr.rows.weight.trend_change_kg).toBeLessThan(0);
    expect(wr.rows.weight.distance_to_goal).toBeGreaterThan(5);
    expect(wr.rows.workouts).toEqual({ feature_on: true, completed: 1, scheduled: 3 }); // planned rest is not a miss
    expect(wr.rows.bp).toEqual({
      feature_on: true, status: 'in_range', mean: { systolic: 128, diastolic: 82, days: 2 },
      target: { systolic: 130, diastolic: 85 }, days_measured: 2,
    });
    expect(wr.quiet).toBe(false);
    expect(wr.plan_week).toBe('2026-W26');
    expect(wr.plan_scope).toBe('this_week');
    expect(wr.plan).toBeNull();
    expect(wr.options.intentions.map((i) => i.id)).toEqual(['start_session', 'weigh_before_coffee', 'stop_after_dinner', 'log_every_meal']);
    expect(records.put).not.toHaveBeenCalled();
  });

  it('missing data is unknown, never zero-as-failure; feature-off rows and their options drop out', async () => {
    const { gam } = at(MON, {});
    const wr = await gam.getWeeklyReview();
    expect(wr.quiet).toBe(true);
    expect(wr.rows.weight).toMatchObject({ status: 'unknown', weigh_in_days: 0 });
    expect(wr.rows.bp).toMatchObject({ status: 'unknown', mean: null, days_measured: 0 });
    expect(wr.rows.workouts).toEqual({ feature_on: true, completed: 0, scheduled: null });

    const off = await gam.getWeeklyReview({ features: { weight: false, workout: false, food: false, bp: true } });
    expect(off.rows.weight.feature_on).toBe(false);
    expect(off.rows.workouts.feature_on).toBe(false);
    expect(off.options).toEqual({ intentions: [], weigh_in: [], weigh_in_current: 'weekly', bp_days_max: 7 });
  });

  it('intention + cadence persist as a user write and getGoalLine reads them back', async () => {
    const { records, gam } = at(MON, {});
    const res = await gam.putWeekPlan({ choice: 'stop_after_dinner', cadence: { weigh_in: 'daily', bp_days: 3 } });
    expect(res.ok).toBe(true);
    expect(records.put).toHaveBeenCalledWith('gamificationweek', expect.objectContaining({
      recordId: 'gamificationweek-2026-W26', week: '2026-W26', clientTs: MON, picked_at: MON,
      intention_id: 'stop_after_dinner', cadence: { weigh_in: 'daily', bp_days: 3 }, paused: false,
    }));
    const plan = {
      week: '2026-W26', intention: { id: 'stop_after_dinner', text: 'When I log dinner, I will stop eating for the night' },
      cadence: { weigh_in: 'daily', bp_days: 3 }, paused: false, picked_at: MON,
    };
    expect((await gam.getGoalLine()).plan).toEqual(plan);
    expect((await gam.getWeeklyReview()).plan).toEqual(plan);
  });

  it('rejects an unknown intention or cadence without writing', async () => {
    const { records, gam } = at(MON, {});
    expect(await gam.putWeekPlan({ choice: 'eat_less' })).toEqual({ ok: false, error: 'unknown_intention' });
    expect(await gam.putWeekPlan({ cadence: { weigh_in: 'hourly' } })).toEqual({ ok: false, error: 'invalid_cadence' });
    expect(await gam.putWeekPlan({ cadence: { bp_days: 9 } })).toEqual({ ok: false, error: 'invalid_cadence' });
    expect(records.put).not.toHaveBeenCalled();
  });

  it('"Keep this plan" carries last week\'s intention and cadence forward', async () => {
    const { gam } = at(MON, {
      gamificationweek: [weekRec('2026-W25', { intention_id: 'weigh_before_coffee', cadence: { weigh_in: 'daily', bp_days: 2 } })],
    });
    const { plan } = await gam.putWeekPlan({ choice: 'keep' });
    expect(plan).toMatchObject({ week: '2026-W26', intention: { id: 'weigh_before_coffee' }, cadence: { weigh_in: 'daily', bp_days: 2 }, paused: false });
  });

  it('a cadence-only edit never adopts last week\'s intention; weigh_in defaults to the reminder\'s cadence', async () => {
    const { gam } = at(MON, {
      gamificationweek: [weekRec('2026-W25', { intention_id: 'weigh_before_coffee' })],
      weightreminderpref: [{ recordId: 'weightreminderpref', deleted: false, clientTs: 1, enabled: true, cadence: 'daily' }],
    });
    expect((await gam.getWeeklyReview()).options.weigh_in_current).toBe('daily');
    const { plan } = await gam.putWeekPlan({ cadence: { bp_days: 2 } });
    expect(plan.intention).toBeNull();
    expect(plan.cadence).toEqual({ weigh_in: 'weekly', bp_days: 2 }); // last week's contract carries
    const fresh = await at(MON, {
      weightreminderpref: [{ recordId: 'weightreminderpref', deleted: false, clientTs: 1, enabled: true, cadence: 'daily' }],
    }).gam.putWeekPlan({ choice: 'pause' });
    expect(fresh.plan.cadence.weigh_in).toBe('daily'); // no prior contract → the reminder's cadence
  });

  it('a goal set after the reviewed week never re-reads it', async () => {
    const { gam } = at(MON, {
      weight: Array.from({ length: 20 }, (_, o) => wMon(o, 85)),
      weightgoal: [{ recordId: 'weightgoal-new', deleted: false, set_at: isoMon(0), target_weight: 80, start_weight: 85 }],
    });
    const wr = await gam.getWeeklyReview();
    expect(wr.rows.weight.goal_status).toBe('no_goal');
    expect(wr.rows.weight.distance_to_goal).toBeNull();
  });

  it('a Sunday read still reviews the previous week; the pick takes effect on Monday', async () => {
    const seed = {};
    const sun = at(SUN, seed);
    const wr = await sun.gam.getWeeklyReview();
    expect(wr.week.id).toBe('2026-W25');
    expect(wr.plan_week).toBe('2026-W27');
    expect(wr.plan_scope).toBe('next_week');
    await sun.gam.putWeekPlan({ choice: 'log_every_meal' });
    expect((await sun.gam.getGoalLine()).plan).toBeNull(); // the live week has no pick

    const mon = createGamificationDomain({ records: sun.records, now: () => SUN + DAY_MS, timeZone: TZ });
    expect((await mon.getGoalLine()).plan).toMatchObject({ week: '2026-W27', intention: { id: 'log_every_meal' } });
  });

  it('a paused week shows paused instead of change / too-fast, and defers experiments', async () => {
    // NOW (this file's clock) is Wed 2026-06-17, ISO week 2026-W25.
    const seed = {
      weight: series(60, (o) => 100 * (1 + (0.02 / 7) * o)),
      weightgoal: [goalRec(59, 80, 117)],
    };
    const live = await domainOver(seed).gam.getGoalLine();
    expect(live.goal.too_fast).toBe(true);
    expect(live.goal.change_7d).not.toBeNull();

    const { gam } = domainOver({ ...seed, gamificationweek: [weekRec('2026-W25', { paused: true })] });
    const paused = await gam.getGoalLine();
    expect(paused.plan.paused).toBe(true);
    expect(paused.goal.change_7d).toBeNull();
    expect(paused.goal.too_fast).toBe(false);
    expect(paused.goal.projected).toEqual({ date: null, plus_minus_weeks: null, reason: 'paused' });
    expect((await gam.listExperiments()).recovery_paused).toBe(true);
  });

  it('a timezone edit never relabels a stored week', async () => {
    // Mon 03:00 UTC = Sun 20:00 in Los Angeles.
    const t = Date.UTC(2026, 5, 22, 3, 0, 0);
    const utc = at(t, {});
    await utc.gam.putWeekPlan({ choice: 'start_session' });
    const la = createGamificationDomain({ records: utc.records, now: () => t, timeZone: 'America/Los_Angeles' });
    expect((await la.getGoalLine()).plan).toBeNull(); // LA's live week is still 2026-W25
    const wr = await la.getWeeklyReview();
    expect(wr.plan_week).toBe('2026-W26'); // LA Sunday → the coming week: the same record
    expect(wr.plan).toMatchObject({ week: '2026-W26', intention: { id: 'start_session' } });
    expect((await utc.records.list('gamificationweek')).map((r) => r.recordId)).toEqual(['gamificationweek-2026-W26']);
  });

  it('vault export → import keeps the week record, re-attached to the re-minted goal', async () => {
    const { records, gam } = at(MON, {
      weightgoal: [{ recordId: 'weightgoal-episode-1', deleted: false, set_at: '2026-06-01T09:00:00Z', target_weight: 80, start_weight: 86 }],
    });
    await gam.putWeekPlan({ choice: 'pause' });
    const all = [];
    for (const t of ['weightgoal', 'gamificationweek']) {
      for (const r of await records.listRaw(t)) all.push({ ...r, recordType: t });
    }
    const vault = recordsToVault(all, { now: MON });
    expect(vault.data.gamification.weeks).toEqual([expect.objectContaining({ week: '2026-W26', paused: true, goal_set_at: '2026-06-01T09:00:00Z' })]);

    const imported = vaultToRecords(vault, { now: MON });
    const goal = imported.find((r) => r.recordType === 'weightgoal');
    const week = imported.find((r) => r.recordType === 'gamificationweek');
    expect(week).toMatchObject({ recordId: 'gamificationweek-2026-W26', episode_id: goal.recordId, paused: true });
  });
});
