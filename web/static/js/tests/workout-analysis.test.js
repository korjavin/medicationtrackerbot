// workout-analysis.test.js
//
// Pure-unit net for web/domain/workout-analysis.js (Phase 3, med-qj4.3.1):
// Epley est-1RM, PR selection across logs, warm-up exclusion, per-rep-count
// set-records, per-session series. All expectations hand-computed.

import { describe, it, expect } from 'vitest';
import {
  estimated1RM,
  est1RMLowConfidence,
  exercisePRs,
  exerciseSeries,
  goalHeadline,
  weeklyHardSets,
  effortInsight,
  EST_1RM_CONFIDENT_MAX_REPS,
  NEAR_FAILURE_RIR,
} from '../../../domain/workout-analysis.js';

// A working (non-warmup) set. set_type defaults to 'normal'.
function set(weight_kg, reps, set_type = 'normal') {
  return { weight_kg, reps, set_type };
}

// A working set carrying a logged RPE (effort is optional per set).
function ratedSet(weight_kg, reps, rpe) {
  return { weight_kg, reps, rpe, set_type: 'normal' };
}

describe('estimated1RM (Epley)', () => {
  it('computes weight*(1+reps/30), 2dp', () => {
    expect(estimated1RM(100, 5)).toBe(116.67); // 100*(1+5/30)=116.666..
    expect(estimated1RM(100, 1)).toBe(103.33);
    expect(estimated1RM(60, 10)).toBe(80); // 60*(1+10/30)=80
  });

  it('returns 0 for non-positive weight or reps', () => {
    expect(estimated1RM(0, 5)).toBe(0);
    expect(estimated1RM(100, 0)).toBe(0);
    expect(estimated1RM(-10, 5)).toBe(0);
  });
});

describe('exercisePRs', () => {
  it('folds records across logs, excluding warm-ups', () => {
    const logs = [
      // Session 1: warm-up 40kg (ignored) + 100x5 + 90x8.
      { date: '2026-07-01', sets: [set(40, 10, 'warmup'), set(100, 5), set(90, 8)] },
      // Session 2: 110x3 + 100x5.
      { date: '2026-07-08', sets: [set(110, 3), set(100, 5)] },
    ];
    const pr = exercisePRs(logs);
    expect(pr.heaviest_weight).toBe(110);
    expect(pr.most_reps).toBe(8);
    expect(pr.best_set_volume).toBe(90 * 8); // 720, beats 100*5=500 and 110*3=330
    // best est-1RM: 110*(1+3/30)=121, 100*(1+5/30)=116.67, 90*(1+8/30)=114.
    expect(pr.best_est_1rm).toBe(121);
    // session volumes: s1 = 500+720=1220, s2 = 330+500=830. warm-up excluded.
    expect(pr.best_session_volume).toBe(1220);
    // per-rep-count records: heaviest for each rep count.
    expect(pr.set_records).toEqual({ 3: 110, 5: 100, 8: 90 });
  });

  it('keeps the heaviest weight per rep count', () => {
    const logs = [{ date: '2026-07-01', sets: [set(100, 5), set(105, 5), set(95, 5)] }];
    expect(exercisePRs(logs).set_records).toEqual({ 5: 105 });
  });

  it('handles empty / absent sets gracefully', () => {
    expect(exercisePRs([])).toEqual({
      heaviest_weight: 0,
      best_est_1rm: 0,
      best_est_1rm_reps: 0,
      best_est_1rm_low_confidence: false,
      best_set_volume: 0,
      best_session_volume: 0,
      most_reps: 0,
      set_records: {},
    });
    expect(exercisePRs([{ date: '2026-07-01' }, { date: '2026-07-02', sets: [] }]).heaviest_weight).toBe(0);
    expect(exercisePRs(null).set_records).toEqual({});
  });

  it('excludes a fully-warmup log from session volume', () => {
    const logs = [{ date: '2026-07-01', sets: [set(40, 10, 'warmup')] }];
    expect(exercisePRs(logs).best_session_volume).toBe(0);
  });
});

describe('exerciseSeries', () => {
  it('emits one oldest-first point per log with session-best est-1RM/top-weight/volume', () => {
    const logs = [
      { date: '2026-07-08', sets: [set(110, 3), set(100, 5)] },
      { date: '2026-07-01', sets: [set(40, 10, 'warmup'), set(100, 5), set(90, 8)] },
    ];
    const series = exerciseSeries(logs);
    expect(series.map((p) => p.date)).toEqual(['2026-07-01', '2026-07-08']);
    expect(series[0]).toEqual({
      date: '2026-07-01', est_1rm: 116.67, top_weight: 100, volume: 500 + 720, reps: 13, work_sets: 2,
    });
    expect(series[1]).toEqual({
      date: '2026-07-08', est_1rm: 121, top_weight: 110, volume: 330 + 500, reps: 8, work_sets: 2,
    });
  });

  it('emits a zeroed point for a session with no working sets', () => {
    const series = exerciseSeries([{ date: '2026-07-01', sets: [set(40, 10, 'warmup')] }]);
    expect(series).toEqual([{
      date: '2026-07-01', est_1rm: 0, top_weight: 0, volume: 0, reps: 0, work_sets: 0,
    }]);
  });

  it('returns [] for absent input', () => {
    expect(exerciseSeries(null)).toEqual([]);
  });
});

// med-qj4.6.4 — est-1RM confidence + goal-driven headline emphasis.
describe('est-1RM confidence', () => {
  it('flags estimates back-computed from sets above the Epley-reliable range', () => {
    expect(EST_1RM_CONFIDENT_MAX_REPS).toBe(12);
    expect(est1RMLowConfidence(12)).toBe(false);
    expect(est1RMLowConfidence(13)).toBe(true);
    expect(est1RMLowConfidence(0)).toBe(false);
  });

  it('exercisePRs carries the reps behind the best estimate and its verdict', () => {
    // 60x20 → 100 est-1RM beats 100x5 → 116.67? No: 116.67 wins, from 5 reps.
    const confident = exercisePRs([{ sets: [set(100, 5), set(50, 20)] }]);
    expect(confident.best_est_1rm_reps).toBe(5);
    expect(confident.best_est_1rm_low_confidence).toBe(false);

    // 80x20 → 133.33 beats 100x5 → 116.67, but it came off a 20-rep set.
    const shaky = exercisePRs([{ sets: [set(100, 5), set(80, 20)] }]);
    expect(shaky.best_est_1rm).toBe(133.33);
    expect(shaky.best_est_1rm_reps).toBe(20);
    expect(shaky.best_est_1rm_low_confidence).toBe(true);
  });
});

describe('goalHeadline', () => {
  const logs = [
    { date: '2026-07-01', sets: [set(100, 5), set(90, 8)] },
    { date: '2026-07-06', sets: [set(100, 6), set(95, 8)] },
  ];
  const prs = exercisePRs(logs);
  const series = exerciseSeries(logs);

  it('leads with est-1RM for a strength goal', () => {
    const h = goalHeadline('strength', prs, series);
    expect(h.metric).toBe('est-1rm');
    expect(h.charts).toEqual(['est-1rm', 'top-weight']);
    expect(h.value).toBe(prs.best_est_1rm);
    expect(h.unit).toBe('kg');
    expect(h.low_confidence).toBe(false);
  });

  it('leads with volume load + weekly hard sets for a hypertrophy goal', () => {
    const h = goalHeadline('hypertrophy', prs, series);
    expect(h.metric).toBe('volume');
    expect(h.charts).toEqual(['volume', 'est-1rm']);
    expect(h.value).toBe(100 * 6 + 95 * 8); // newest session's working volume
    expect(h.sub_label).toBe('Hard sets · last 7 days');
    expect(h.sub_value).toBe(4); // both sessions fall inside the trailing week
  });

  it('leads with total reps for an endurance goal', () => {
    const h = goalHeadline('endurance', prs, series);
    expect(h.metric).toBe('reps');
    expect(h.charts).toEqual(['reps', 'volume']);
    expect(h.value).toBe(14); // 6 + 8 in the newest session
    expect(h.unit).toBe('reps');
  });

  it('falls back to the hypertrophy default for an unknown/absent goal', () => {
    expect(goalHeadline(null, prs, series).goal).toBe('hypertrophy');
    expect(goalHeadline('bogus', prs, series).metric).toBe('volume');
    // `general` shares hypertrophy's emphasis, like its rep-range defaults.
    expect(goalHeadline('general', prs, series).metric).toBe('volume');
  });

  it('surfaces the est-1RM confidence caveat on the strength headline', () => {
    const shaky = exercisePRs([{ sets: [set(80, 20)] }]);
    const h = goalHeadline('strength', shaky, []);
    expect(h.low_confidence).toBe(true);
    expect(h.confidence_reps).toBe(20);
  });

  it('survives empty history', () => {
    const h = goalHeadline('hypertrophy', exercisePRs([]), []);
    expect(h.value).toBe(0);
    expect(h.sub_value).toBe(0);
  });
});

describe('weeklyHardSets', () => {
  it('sums working sets in the 7 days ending at the newest point', () => {
    const series = [
      { date: '2026-06-01', work_sets: 5 }, // outside the trailing week
      { date: '2026-07-01', work_sets: 3 },
      { date: '2026-07-06', work_sets: 4 },
    ];
    expect(weeklyHardSets(series)).toBe(7);
  });

  it('returns 0 for empty/absent input', () => {
    expect(weeklyHardSets([])).toBe(0);
    expect(weeklyHardSets(null)).toBe(0);
  });
});

// med-qj4.6.5 — near-failure effort insight. Advisory only: it never gates
// anything, and it stays silent unless there is real evidence.
describe('effortInsight', () => {
  it('advises a hypertrophy exercise whose recent rated sets sit far from failure', () => {
    const logs = [
      { date: '2026-07-06', sets: [ratedSet(60, 10, 5), ratedSet(60, 10, 6), ratedSet(60, 10, 5)] },
      { date: '2026-07-01', sets: [ratedSet(60, 10, 6), ratedSet(60, 10, 6), ratedSet(60, 10, 5)] },
    ];
    const insight = effortInsight(logs, 'hypertrophy');
    expect(insight.sets).toBe(6);
    // RPE 5 → RIR 5, RPE 6 → RIR 4; [4,4,4,5,5,5] → 4.5.
    expect(insight.median_rir).toBe(4.5);
    expect(insight.median_rir).toBeGreaterThanOrEqual(NEAR_FAILURE_RIR);
    expect(insight.advise).toBe(true);
  });

  it('stays quiet when the sets are already close to failure', () => {
    const logs = [{ date: '2026-07-06', sets: [ratedSet(60, 10, 9), ratedSet(60, 10, 8), ratedSet(60, 10, 9)] }];
    const insight = effortInsight(logs, 'hypertrophy');
    expect(insight.median_rir).toBe(1);
    expect(insight.advise).toBe(false);
  });

  it('returns null when no RPE was logged at all — no RPE must change nothing', () => {
    const logs = [{ date: '2026-07-06', sets: [set(60, 10), set(60, 10)] }];
    expect(effortInsight(logs, 'hypertrophy')).toBeNull();
    expect(effortInsight([], 'hypertrophy')).toBeNull();
    expect(effortInsight(null, 'hypertrophy')).toBeNull();
  });

  it('never nags strength / endurance / general goals', () => {
    const logs = [
      { date: '2026-07-06', sets: [ratedSet(100, 5, 5), ratedSet(100, 5, 5), ratedSet(100, 5, 6)] },
    ];
    for (const goal of ['strength', 'endurance', 'general']) {
      const insight = effortInsight(logs, goal);
      expect(insight.advise).toBe(false);   // summary still available…
      expect(insight.median_rir).toBe(5);   // …the RIR number is not goal-gated
    }
  });

  it('needs more than a single rated set before advising', () => {
    const logs = [{ date: '2026-07-06', sets: [ratedSet(60, 10, 4), set(60, 10)] }];
    const insight = effortInsight(logs, 'hypertrophy');
    expect(insight.sets).toBe(1);
    expect(insight.advise).toBe(false);
  });

  it('fills the window from the END of a long session, not its opening sets', () => {
    // One session of 8 rated sets: easy early (RIR 5), taken close to failure by
    // the end (RIR 1). Walking the session forwards would judge the user on the
    // openers and wrongly advise; the last 6 sets are what actually happened.
    const sets = [
      ratedSet(60, 10, 5), ratedSet(60, 10, 5), ratedSet(60, 10, 5), ratedSet(60, 10, 5), // RIR 5
      ratedSet(60, 10, 9), ratedSet(60, 10, 9), ratedSet(60, 10, 9), ratedSet(60, 10, 9), // RIR 1
    ];
    const insight = effortInsight([{ date: '2026-07-06', sets }], 'hypertrophy');
    expect(insight.sets).toBe(6);
    // Last 6 → [1,1,1,1,5,5] → 1. Forwards it would be [1,1,5,5,5,5] → 5, and
    // this user would be told to try harder right after taking four sets to the
    // brink.
    expect(insight.median_rir).toBe(1);
    expect(insight.advise).toBe(false);
  });

  it('windows to the newest ~6 rated sets, ignoring older history', () => {
    const logs = [
      { date: '2026-07-06', sets: [ratedSet(60, 10, 9), ratedSet(60, 10, 9), ratedSet(60, 10, 9)] },
      { date: '2026-07-04', sets: [ratedSet(60, 10, 9), ratedSet(60, 10, 9), ratedSet(60, 10, 9)] },
      // Ancient easy sets — outside the window, must not drag the median up.
      { date: '2026-01-01', sets: [ratedSet(60, 10, 3), ratedSet(60, 10, 3), ratedSet(60, 10, 3)] },
    ];
    const insight = effortInsight(logs, 'hypertrophy');
    expect(insight.sets).toBe(6);
    expect(insight.median_rir).toBe(1);
    expect(insight.advise).toBe(false);
  });
});
