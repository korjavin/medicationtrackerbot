// gamification.goal-line.test.js
//
// Fixture-vault suite for the Goal Line read-model (web/domain/gamification.js
// getGoalLine, docs/gamification.md §0.3.1, bd med-8tur.1). Same shape as the
// Atlas/forecast suites: the domain layer is driven only by injected ports, so
// a seeded in-memory vault is its integration entry point. The shim route's
// flag gating is covered in cloud.shim-contract.settings.test.js.
import { describe, it, expect, vi } from 'vitest';
import { createGamificationDomain } from '../../../../web/domain/gamification.js';
import { createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';

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
    expect(goal.coverage).toEqual({ weigh_in_days_28d: 3, last_weigh_in_day: '2026-06-17' });
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

describe('gamification Goal Line — workouts, BP, cta', () => {
  it('duplicate same-session logs count once; last week does not count', async () => {
    const { gam } = domainOver({
      workoutgroup: [GROUP], workoutvariant: [VARIANT],
      weight: [weightRec(0, 80)],
      workoutsession: [
        { recordId: 'session-7-2026-06-15', deleted: false, group_id: 7, status: 'completed', scheduled_date: '2026-06-15T00:00:00Z' },
        { recordId: 'adhoc-1', deleted: false, group_id: -1, status: 'completed', scheduled_date: '2026-06-16T00:00:00Z' },
        { recordId: 'session-7-2026-06-12', deleted: false, group_id: 7, status: 'completed', scheduled_date: '2026-06-12T00:00:00Z' },
      ],
      workoutlog: [1, 2, 3, 4].map((k) => ({ recordId: `log-${k}`, deleted: false, session_id: 'session-7-2026-06-15' })),
    });
    const gl = await gam.getGoalLine();

    expect(gl.workouts.completed_this_week).toBe(2);
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
    const gl = await gam.getGoalLine({ features: { workout: false, bp: false, gamification: true } });

    expect(gl.workouts).toEqual({ feature_on: false, completed_this_week: null, next_scheduled: null, scheduled_this_week: null });
    expect(gl.bp.feature_on).toBe(false);
    expect(gl.bp.mean_7d).toBeNull();
    expect(gl.cta).toBe('weigh_in');
  });
});
