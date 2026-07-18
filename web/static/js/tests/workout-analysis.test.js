// workout-analysis.test.js
//
// Pure-unit net for web/domain/workout-analysis.js (Phase 3, med-qj4.3.1):
// Epley est-1RM, PR selection across logs, warm-up exclusion, per-rep-count
// set-records, per-session series. All expectations hand-computed.

import { describe, it, expect } from 'vitest';
import { estimated1RM, exercisePRs, exerciseSeries } from '../../../domain/workout-analysis.js';

// A working (non-warmup) set. set_type defaults to 'normal'.
function set(weight_kg, reps, set_type = 'normal') {
  return { weight_kg, reps, set_type };
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
      date: '2026-07-01', est_1rm: 116.67, top_weight: 100, volume: 500 + 720,
    });
    expect(series[1]).toEqual({
      date: '2026-07-08', est_1rm: 121, top_weight: 110, volume: 330 + 500,
    });
  });

  it('emits a zeroed point for a session with no working sets', () => {
    const series = exerciseSeries([{ date: '2026-07-01', sets: [set(40, 10, 'warmup')] }]);
    expect(series).toEqual([{ date: '2026-07-01', est_1rm: 0, top_weight: 0, volume: 0 }]);
  });

  it('returns [] for absent input', () => {
    expect(exerciseSeries(null)).toEqual([]);
  });
});
