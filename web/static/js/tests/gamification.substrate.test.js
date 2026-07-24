// gamification.substrate.test.js
//
// Parity vectors for the substrate scoring core ported from the Go engine
// (internal/domain/gamification/scoring/scoring.go). Every expected value below
// is the SAME value the Go table tests (scoring/scoring_test.go) assert — this
// file is the acceptance bar for med-eyb: a JS scorer that drifts from the Go
// number is a bug. When the Go engine's constants or math change, these vectors
// must change with them (they mirror scoring_test.go one-for-one).
import { describe, it, expect, vi } from 'vitest';
import { scoring, DEFAULT_CONFIG as cfg } from '../../../../web/domain/gamification.js';

function findAward(awards, ring, source, kind) {
  const a = awards.find((x) => x.ring === ring && x.source === source && x.kind === kind);
  return a ? a.hp : undefined;
}

describe('substrate parity — RangeMembership (trapezoid §4.1)', () => {
  const low = 10; const high = 20; const delta = 5;
  const cases = [
    ['in-band low edge', 10, 1],
    ['in-band high edge', 20, 1],
    ['in-band middle', 15, 1],
    ['below halfway', 7.5, 0.5],
    ['below near band', 9, 0.8],
    ['below outer edge zero', 5, 0],
    ['below beyond tail', 2, 0],
    ['above halfway', 22.5, 0.5],
    ['above near band', 21, 0.8],
    ['above outer edge zero', 25, 0],
    ['above beyond tail', 40, 0],
  ];
  cases.forEach(([name, x, want]) => {
    it(name, () => {
      expect(scoring.rangeMembership(x, low, high, delta)).toBeCloseTo(want, 9);
    });
  });

  it('degenerate + step behaviour', () => {
    expect(scoring.rangeMembership(15, 10, 20, 0)).toBe(1);
    expect(scoring.rangeMembership(9, 10, 20, 0)).toBe(0);
    expect(scoring.rangeMembership(21, 10, 20, 0)).toBe(0);
    expect(scoring.rangeMembership(15, 20, 10, 5)).toBe(0); // low>high
    expect(scoring.rangeMembership(10, 10, 10, 5)).toBe(1); // point band at point
    expect(scoring.rangeMembership(12.5, 10, 10, 5)).toBeCloseTo(0.5, 9);
    expect(scoring.rangeMembership(15, 10, 20, 5)).toBeLessThanOrEqual(1);
  });
});

describe('substrate parity — ScoreAdherence', () => {
  it('all taken on time → floor + full outcome', () => {
    const aw = scoring.scoreAdherence([{ status: 'taken', minutesLate: 0 }, { status: 'taken', minutesLate: 0 }], cfg);
    expect(findAward(aw, 'adherence', 'medication', 'floor')).toBe(2 * cfg.floorHP);
    expect(findAward(aw, 'adherence', 'medication', 'outcome')).toBe(cfg.adherenceOutcomeMaxHP);
  });
  it('120 min late → r=0.5 → 5 HP', () => {
    const aw = scoring.scoreAdherence([{ status: 'taken', minutesLate: 120 }], cfg);
    expect(findAward(aw, 'adherence', 'medication', 'outcome')).toBe(5);
  });
  it('skip-with-reason → floor only, no outcome', () => {
    const aw = scoring.scoreAdherence([{ status: 'skipped' }], cfg);
    expect(findAward(aw, 'adherence', 'medication', 'floor')).toBe(cfg.floorHP);
    expect(findAward(aw, 'adherence', 'medication', 'outcome')).toBeUndefined();
  });
  it('missed drags outcome, earns no floor (mean 0.5 → 5)', () => {
    const aw = scoring.scoreAdherence([{ status: 'taken', minutesLate: 0 }, { status: 'missed' }], cfg);
    expect(findAward(aw, 'adherence', 'medication', 'floor')).toBe(cfg.floorHP);
    expect(findAward(aw, 'adherence', 'medication', 'outcome')).toBe(5);
  });
  it('empty day → no awards', () => {
    expect(scoring.scoreAdherence([], cfg)).toHaveLength(0);
  });
});

describe('substrate parity — ScoreBP', () => {
  it('readings → floor only', () => {
    const aw = scoring.scoreBP(true, cfg);
    expect(findAward(aw, 'vitals', 'bp', 'floor')).toBe(cfg.floorHP);
    expect(findAward(aw, 'vitals', 'bp', 'outcome')).toBeUndefined();
  });
  it('no readings → nil', () => {
    expect(scoring.scoreBP(false, cfg)).toHaveLength(0);
  });
});

describe('substrate parity — ScoreSleep', () => {
  it('logged night → floor only, no outcome', () => {
    const aw = scoring.scoreSleep({ logged: true }, cfg);
    expect(findAward(aw, 'mind', 'sleep', 'floor')).toBe(cfg.floorHP);
    expect(findAward(aw, 'mind', 'sleep', 'outcome')).toBeUndefined();
  });
  it('bedtime timing dev 15 within window → full consistency HP', () => {
    const aw = scoring.scoreSleep({ logged: true, hasRegularity: true, timingDeviationMin: 15 }, cfg);
    expect(findAward(aw, 'mind', 'sleep', 'consistency')).toBe(cfg.sleepRegularityMaxHP);
  });
});

describe('substrate parity — ScoreMovement', () => {
  it('steps 8000 in band → full outcome', () => {
    const aw = scoring.scoreMovement({ hasSteps: true, steps: 8000 }, cfg);
    expect(findAward(aw, 'movement', 'steps', 'outcome')).toBe(cfg.stepsOutcomeMaxHP);
  });
  it('activity saturates at WHO ceiling — exceeding never penalized', () => {
    const at = scoring.scoreMovement({ hasActivity: true, weeklyActivityMinutes: 150 }, cfg);
    const over = scoring.scoreMovement({ hasActivity: true, weeklyActivityMinutes: 600 }, cfg);
    expect(findAward(at, 'movement', 'activity', 'outcome')).toBe(cfg.movementOutcomeMaxHP);
    expect(findAward(over, 'movement', 'activity', 'outcome')).toBe(cfg.movementOutcomeMaxHP);
  });
  it('workout logged → activity floor', () => {
    const aw = scoring.scoreMovement({ workoutLogged: true }, cfg);
    expect(findAward(aw, 'movement', 'activity', 'floor')).toBe(cfg.floorHP);
  });
});

describe('substrate parity — ScoreNourishment', () => {
  it('on-target calories → full outcome + meal floor', () => {
    const aw = scoring.scoreNourishment({ logged: true, calories: 2000, calorieTarget: 2000 }, cfg);
    expect(findAward(aw, 'nourishment', 'calories', 'outcome')).toBe(cfg.nourishmentCaloriesMaxHP);
    expect(findAward(aw, 'nourishment', 'meal', 'floor')).toBe(cfg.floorHP);
  });
  it('over-target → zero calorie HP', () => {
    const aw = scoring.scoreNourishment({ logged: true, calories: 2600, calorieTarget: 2000 }, cfg);
    expect(findAward(aw, 'nourishment', 'calories', 'outcome')).toBeUndefined();
  });
  it('below calorie floor → zero outcome, still meal floor', () => {
    const aw = scoring.scoreNourishment({ logged: true, calories: 1100, calorieTarget: 2000, calorieFloor: 1200 }, cfg);
    expect(findAward(aw, 'nourishment', 'calories', 'outcome')).toBeUndefined();
    expect(findAward(aw, 'nourishment', 'meal', 'floor')).toBe(cfg.floorHP);
  });
  it('protein one-sided-OK: meeting & exceeding both full', () => {
    const at = scoring.scoreNourishment({ proteinTarget: 100, protein: 100 }, cfg);
    const over = scoring.scoreNourishment({ proteinTarget: 100, protein: 160 }, cfg);
    expect(findAward(at, 'nourishment', 'protein', 'outcome')).toBe(cfg.nourishmentProteinMaxHP);
    expect(findAward(over, 'nourishment', 'protein', 'outcome')).toBe(cfg.nourishmentProteinMaxHP);
  });
  it('veg scales toward target', () => {
    const aw = scoring.scoreNourishment({ vegTarget: 5, vegServings: 5 }, cfg);
    expect(findAward(aw, 'nourishment', 'veg', 'outcome')).toBe(cfg.nourishmentVegMaxHP);
  });
});

describe('substrate parity — ScoreWeight', () => {
  it('logged → floor only', () => {
    const aw = scoring.scoreWeight(true, cfg);
    expect(findAward(aw, 'vitals', 'weight', 'floor')).toBe(cfg.floorHP);
    expect(findAward(aw, 'vitals', 'weight', 'outcome')).toBeUndefined();
  });
  it('not logged → no awards', () => {
    expect(scoring.scoreWeight(false, cfg)).toHaveLength(0);
  });
});

describe('substrate parity — weekly gauge awards', () => {
  it('weight goal: safe-pace loss full, crash-diet zero', () => {
    const safe = scoring.scoreWeightWeekly({ hasData: true, velocityPctPerWeek: -0.6, goalDirection: -1 }, cfg);
    const crash = scoring.scoreWeightWeekly({ hasData: true, velocityPctPerWeek: -2.0, goalDirection: -1 }, cfg);
    expect(findAward(safe, 'vitals', 'weight_trend_week', 'outcome')).toBe(cfg.gaugeWeightWeeklyMaxHP);
    expect(findAward(crash, 'vitals', 'weight_trend_week', 'outcome')).toBeUndefined();
  });
  it('weight no goal: steady full, drift partial then zero', () => {
    const steady = scoring.scoreWeightWeekly({ hasData: true, velocityPctPerWeek: 0, goalDirection: 0 }, cfg);
    const partial = scoring.scoreWeightWeekly({ hasData: true, velocityPctPerWeek: 0.5, goalDirection: 0 }, cfg);
    expect(findAward(steady, 'vitals', 'weight_trend_week', 'outcome')).toBe(cfg.gaugeWeightWeeklyMaxHP);
    const p = findAward(partial, 'vitals', 'weight_trend_week', 'outcome');
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(cfg.gaugeWeightWeeklyMaxHP);
    expect(findAward(scoring.scoreWeightWeekly({ hasData: true, velocityPctPerWeek: 2.0, goalDirection: 0 }, cfg), 'vitals', 'weight_trend_week', 'outcome')).toBeUndefined();
  });
  it('weight insufficient → no award', () => {
    expect(scoring.scoreWeightWeekly({ hasData: false }, cfg)).toHaveLength(0);
  });
  it('BP share held → full, dropped far → zero', () => {
    expect(findAward(scoring.scoreBPWeekly({ hasData: true, share30d: 0.8, baselineShare60d: 0.8 }, cfg), 'vitals', 'bp_share_week', 'outcome')).toBe(cfg.gaugeBPWeeklyMaxHP);
    expect(findAward(scoring.scoreBPWeekly({ hasData: true, share30d: 0.95, baselineShare60d: 0.7 }, cfg), 'vitals', 'bp_share_week', 'outcome')).toBe(cfg.gaugeBPWeeklyMaxHP);
    expect(findAward(scoring.scoreBPWeekly({ hasData: true, share30d: 0.2, baselineShare60d: 0.8 }, cfg), 'vitals', 'bp_share_week', 'outcome')).toBeUndefined();
  });
  it('resting HR held/improved → full, rose beyond falloff → zero', () => {
    expect(findAward(scoring.scoreRestingHRWeekly({ hasData: true, deltaFromBaseline: -2 }, cfg), 'vitals', 'resting_hr_trend_week', 'outcome')).toBe(cfg.gaugeRestingHRWeeklyMaxHP);
    expect(findAward(scoring.scoreRestingHRWeekly({ hasData: true, deltaFromBaseline: cfg.gaugeRestingHRFalloffBPM + 1 }, cfg), 'vitals', 'resting_hr_trend_week', 'outcome')).toBeUndefined();
  });
});

describe('substrate parity — ScoreMind', () => {
  it('journaling earns floor, no outcome', () => {
    const aw = scoring.scoreMind({ journaledEntries: 2 }, cfg);
    expect(findAward(aw, 'mind', 'diary', 'floor')).toBe(cfg.floorHP);
    expect(findAward(aw, 'mind', 'diary', 'outcome')).toBeUndefined();
  });
  it('reflection prompt → consistency bonus', () => {
    const aw = scoring.scoreMind({ journaledEntries: 1, engagedWithPrompt: true }, cfg);
    expect(findAward(aw, 'mind', 'diary', 'consistency')).toBe(cfg.mindReflectBonusHP);
  });
});

describe('substrate parity — level curve + tiers + streak', () => {
  it('HPToReachLevel(1) = 0 and strictly increasing', () => {
    expect(scoring.hpToReachLevel(1, cfg)).toBe(0);
    let prev = -1;
    for (let n = 1; n <= 50; n += 1) {
      const th = scoring.hpToReachLevel(n, cfg);
      if (n > 1) expect(th).toBeGreaterThan(prev);
      prev = th;
    }
  });
  it('LevelForLifetimeHP monotonic & consistent with thresholds', () => {
    let last = 0;
    for (let hp = 0; hp <= 5000; hp += 25) {
      const lv = scoring.levelForLifetimeHP(hp, cfg);
      expect(lv).toBeGreaterThanOrEqual(1);
      expect(lv).toBeGreaterThanOrEqual(last);
      expect(hp).toBeGreaterThanOrEqual(scoring.hpToReachLevel(lv, cfg));
      last = lv;
    }
    expect(scoring.levelForLifetimeHP(0, cfg)).toBe(1);
    expect(scoring.levelForLifetimeHP(-100, cfg)).toBe(1);
  });
  it('InsightTierForLevel {3,5,7} cap 4', () => {
    const cases = [[1, 1], [2, 1], [3, 2], [4, 2], [5, 3], [6, 3], [7, 4], [8, 4], [100, 4]];
    cases.forEach(([lvl, want]) => expect(scoring.insightTierForLevel(lvl, cfg)).toBe(want));
  });
  it('NextStreak', () => {
    expect(scoring.nextStreak({ currentStreak: 3, freezes: 1 }, true, cfg)).toEqual({ currentStreak: 4, freezes: 2 });
    expect(scoring.nextStreak({ currentStreak: 1, freezes: cfg.maxFreezes }, true, cfg).freezes).toBe(cfg.maxFreezes);
    expect(scoring.nextStreak({ currentStreak: 5, freezes: 2 }, false, cfg)).toEqual({ currentStreak: 5, freezes: 1 });
    expect(scoring.nextStreak({ currentStreak: 9, freezes: 0 }, false, cfg)).toEqual({ currentStreak: 0, freezes: 0 });
    const neg = scoring.nextStreak({ currentStreak: -3, freezes: -2 }, false, cfg);
    expect(neg.currentStreak).toBeGreaterThanOrEqual(0);
    expect(neg.freezes).toBeGreaterThanOrEqual(0);
  });
});

describe('substrate parity — BaselineRelative + scaleHP', () => {
  it('BaselineRelative span 0.2 baseline 100 (lower better)', () => {
    expect(scoring.baselineRelative(100, 100, true, 0.2)).toBeCloseTo(0.5, 9);
    expect(scoring.baselineRelative(80, 100, true, 0.2)).toBeCloseTo(1.0, 9);
    expect(scoring.baselineRelative(120, 100, true, 0.2)).toBe(0);
    expect(scoring.baselineRelative(80, 0, true, 0.2)).toBe(0);
  });
  it('scaleHP never negative, clamps r>1', () => {
    expect(scoring.scaleHP(10, -5)).toBe(0);
    expect(scoring.scaleHP(10, 2.0)).toBe(10);
  });
});

describe('substrate parity — ComputeHealthScore composite', () => {
  it('renormalizes over present weight; missing dilutes not zeroes', () => {
    const res = scoring.computeHealthScore([
      { key: 'bp', label: 'BP', value: 1.0, weight: 1.0, present: true },
      { key: 'sleep', label: 'Sleep', value: 0.5, weight: 1.0, present: true },
      { key: 'weight', label: 'Weight', value: 0, weight: 1.0, present: false },
    ], cfg);
    // (1*1 + 0.5*1) / (1+1) * 100 = 75
    expect(res.score).toBeCloseTo(75, 9);
    expect(res.missing).toEqual(['weight']);
  });
  it('below min contributors → null score', () => {
    const res = scoring.computeHealthScore([
      { key: 'bp', label: 'BP', value: 1.0, weight: 1.0, present: true },
      { key: 'sleep', label: 'Sleep', value: 0.5, weight: 1.0, present: false },
    ], cfg);
    expect(res.score).toBeNull();
  });
});

describe('substrate parity — HabitStrength EMA', () => {
  it('all-1 daily series converges upward toward 1', () => {
    const ones = Array(90).fill(1);
    const v = scoring.habitStrength(ones, 1, cfg);
    expect(v).toBeGreaterThan(0.9);
    expect(v).toBeLessThanOrEqual(1);
  });
  it('empty series → 0; a single 1 → (1-m)', () => {
    expect(scoring.habitStrength([], 1, cfg)).toBe(0);
    const m = Math.pow(0.5, 1 / cfg.habitStrengthHalfLifeDays);
    expect(scoring.habitStrength([1], 1, cfg)).toBeCloseTo(1 - m, 12);
  });
});

// ---------------------------------------------------------------------------
// Read-model integration: drive the domain factory over an in-memory vault and
// assert the wired HP/rings/gauges/targets outputs. The HP numbers below are
// hand-computed from the SAME ported scorers the parity vectors above lock to
// Go, so a read-model that mis-maps vault records → scorer inputs fails here.
import { createGamificationDomain } from '../../../../web/domain/gamification.js';
import { createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';

const RM_NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // Mon Jun 15 2026, noon UTC
const RM_TODAY = '2026-06-15';
const isoAtMs = (ms) => new Date(ms).toISOString();

function seededDomain() {
  const records = createInMemoryRecordsPort({
    foodtargets: [{ recordId: 'foodtargets', deleted: false, calories: 2000, protein: 100 }],
    foodlog: [{ recordId: 'f1', deleted: false, eaten_at: isoAtMs(RM_NOW), calories: 2000, protein: 100 }],
    workoutsession: [{ recordId: 'w1', deleted: false, status: 'completed', started_at: isoAtMs(RM_NOW - 60 * 60000), completed_at: isoAtMs(RM_NOW) }],
    daystats: [{ recordId: 'ds1', deleted: false, day: RM_TODAY, steps: 8000 }],
    sleep: [{ recordId: 's1', deleted: false, day: RM_TODAY, start_time: isoAtMs(RM_NOW - 8 * 3600000), total_minutes: 480, timezone_offset: 0 }],
    bp: [{ recordId: 'bp1', deleted: false, measured_at: isoAtMs(RM_NOW), systolic: 115, diastolic: 75, ignore_calc: false }],
    weight: [{ recordId: 'wt1', deleted: false, measured_at: isoAtMs(RM_NOW), weight: 80 }],
    note: [{ recordId: 'n1', deleted: false, created_at: isoAtMs(RM_NOW), content: 'hi' }],
  });
  return { records, gam: createGamificationDomain({ records, now: () => RM_NOW, timeZone: 'UTC' }) };
}

describe('substrate read models — end-to-end HP over a synthetic vault', () => {
  it('getSummary rings + lifetime HP match hand-computed scorer output', async () => {
    const { gam } = seededDomain();
    const s = await gam.getSummary();
    expect(s.enabled).toBe(true);
    const ringHP = Object.fromEntries(s.today_rings.map((r) => [r.ring, r]));
    // bedtime: sleep floor only (no regularity baseline) → 2, not closed.
    expect(ringHP.bedtime.hp).toBe(2);
    expect(ringHP.bedtime.closed).toBe(false);
    // movement: steps floor 2 + steps outcome 6 + activity floor 2 + activity outcome 4 (60min→rampUp 0.4) = 14.
    expect(ringHP.movement.hp).toBe(14);
    expect(ringHP.movement.closed).toBe(true);
    // nourishment: meal floor 2 + calories outcome 8 + protein outcome 4 = 14.
    expect(ringHP.nourishment.hp).toBe(14);
    expect(ringHP.nourishment.closed).toBe(true);
    expect(s.today_hp).toBe(30);
    // lifetime adds vitals bp-floor 2 + vitals weight-floor 2 + mind diary-floor 2 = 36.
    expect(s.lifetime_hp).toBe(36);
    expect(s.level).toBe(scoring.levelForLifetimeHP(36, cfg));
    expect(s.health_score.contributors).toHaveLength(5);
  });

  it('getRings mirrors the slim Today shape', async () => {
    const { gam } = seededDomain();
    const r = await gam.getRings();
    expect(r.enabled).toBe(true);
    expect(r.today_hp).toBe(30);
    expect(r.rings).toHaveLength(3);
    expect(r.health_score).toBeDefined();
  });

  it('getGauges reports insufficient_data on thin history', async () => {
    const { gam } = seededDomain();
    const g = await gam.getGauges();
    expect(g.enabled).toBe(true);
    expect(g.weight.status).toBe('insufficient_data');
    expect(g.bp.status).toBe('insufficient_data');
    expect(g.resting_hr.status).toBe('insufficient_data');
    expect(g.weight.goal_direction).toBeUndefined(); // internal-only, stripped
  });

  it('getWeeklyReview folds 3 levers with best-day', async () => {
    const { gam } = seededDomain();
    const w = await gam.getWeeklyReview();
    expect(w.enabled).toBe(true);
    expect(w.levers).toHaveLength(3);
    expect(w.days_with_any_hp).toBeGreaterThanOrEqual(1);
    // both nourishment + movement closed today → best day has 2 rings closed.
    expect(w.best_day.rings_closed).toBe(2);
  });

  it('getTargets → 6 recommended metrics; putTargets override then reset', async () => {
    const { gam } = seededDomain();
    const t0 = await gam.getTargets();
    expect(t0.enabled).toBe(true);
    expect(t0.targets).toHaveLength(6);
    expect(t0.targets.every((m) => m.is_recommended)).toBe(true);

    const put = await gam.putTargets({ targets: [{ metric_key: 'bp_systolic', low_val: 100, high_val: 125 }] });
    const sys = put.targets.find((m) => m.metric_key === 'bp_systolic');
    expect(sys.is_custom).toBe(true);
    expect(sys.low).toBe(100);
    expect(sys.high).toBe(125);
    expect(sys.recommended_low).toBe(90); // default preserved for the hint

    const bad = await gam.putTargets({ targets: [{ metric_key: 'nope', low_val: 1 }] });
    expect(bad.ok).toBe(false);

    // reset (all-null) drops the override.
    const reset = await gam.putTargets({ targets: [{ metric_key: 'bp_systolic' }] });
    expect(reset.targets.find((m) => m.metric_key === 'bp_systolic').is_recommended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Read-path memoization (med-90w.2): the cloud read path memoizes loadForRead
// (11 record reads + effectiveConfig) and the 365-day scoreWindow fold, keyed on
// an injected records-change signal. A memo hit must return byte-identical scoring
// output; with no signal (bot mode / direct harnesses) every read recomputes.
const DAY_MS = 86400000;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function seedRecords() {
  return createInMemoryRecordsPort({
    foodtargets: [{ recordId: 'foodtargets', deleted: false, calories: 2000, protein: 100 }],
    foodlog: [{ recordId: 'f1', deleted: false, eaten_at: isoAtMs(RM_NOW), calories: 2000, protein: 100 }],
    workoutsession: [{ recordId: 'w1', deleted: false, status: 'completed', started_at: isoAtMs(RM_NOW - 60 * 60000), completed_at: isoAtMs(RM_NOW) }],
    daystats: [{ recordId: 'ds1', deleted: false, day: RM_TODAY, steps: 8000 }],
    sleep: [{ recordId: 's1', deleted: false, day: RM_TODAY, start_time: isoAtMs(RM_NOW - 8 * 3600000), total_minutes: 480, timezone_offset: 0 }],
    bp: [{ recordId: 'bp1', deleted: false, measured_at: isoAtMs(RM_NOW), systolic: 115, diastolic: 75, ignore_calc: false }],
    weight: [{ recordId: 'wt1', deleted: false, measured_at: isoAtMs(RM_NOW), weight: 80 }],
    note: [{ recordId: 'n1', deleted: false, created_at: isoAtMs(RM_NOW), content: 'hi' }],
    // HR day-batch records (recordId hrsample-<day>, .samples arrays, sample shape
    // { date_time, value } per buildHRDailyMin): one inside the scoring window, one
    // 500 days back — beyond the 426-day (SCORING_WINDOW_DAYS + baseline + 1) lower
    // bound — that a bounded read must exclude.
    hrsample: [
      { recordId: `hrsample-${RM_TODAY}`, deleted: false, samples: [{ date_time: isoAtMs(RM_NOW), value: 60 }] },
      { recordId: `hrsample-${utcDay(RM_NOW - 500 * DAY_MS)}`, deleted: false, samples: [{ date_time: isoAtMs(RM_NOW - 500 * DAY_MS), value: 90 }] },
    ],
  });
}

describe('read-path memoization (med-90w.2)', () => {
  it('memo hit when port present and no write; invalidates on change-count bump', async () => {
    const records = seedRecords();
    let changeCount = 7;
    const gam = createGamificationDomain({ records, now: () => RM_NOW, timeZone: 'UTC', getRecordsChangeCount: () => changeCount });
    const listSpy = vi.spyOn(records, 'list');
    const rangeSpy = vi.spyOn(records, 'listRange');

    await gam.getSummary();
    const readsAfterFirst = listSpy.mock.calls.length + rangeSpy.mock.calls.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    // 2nd call, same change-count, no write → memo hit, no new record reads.
    await gam.getSummary();
    expect(listSpy.mock.calls.length + rangeSpy.mock.calls.length).toBe(readsAfterFirst);

    // Bump the signal (a write happened) → reads fire again.
    changeCount = 8;
    await gam.getSummary();
    expect(listSpy.mock.calls.length + rangeSpy.mock.calls.length).toBeGreaterThan(readsAfterFirst);
  });

  it('memo invalidates when a PENDING dose crosses its due time (no write, same day)', async () => {
    // A pending dose flips to missed purely by clock (schedMs < now), moving no
    // change-count — the day-suffix key can't see it since the crossing is intraday.
    const dueMs = RM_NOW + 2 * 3600000; // due 14:00 UTC, still RM_TODAY
    const records = createInMemoryRecordsPort({
      intake: [{ recordId: 'i1', deleted: false, medication_id: 'm1', scheduled_at: isoAtMs(dueMs), status: 'PENDING' }],
    });
    let clock = RM_NOW;
    const gam = createGamificationDomain({ records, now: () => clock, timeZone: 'UTC', getRecordsChangeCount: () => 1 });
    const listSpy = vi.spyOn(records, 'list');
    const rangeSpy = vi.spyOn(records, 'listRange');
    const reads = () => listSpy.mock.calls.length + rangeSpy.mock.calls.length;

    await gam.getSummary();
    const afterFirst = reads();

    // Still before due, same change-count, same day → memo hit.
    clock = dueMs - 1;
    await gam.getSummary();
    expect(reads()).toBe(afterFirst);

    // Clock passes the scheduled instant → PENDING→missed → memo must recompute.
    clock = dueMs + 1;
    await gam.getSummary();
    expect(reads()).toBeGreaterThan(afterFirst);
  });

  it('memo invalidates at UTC-day rollover (no write, no pending dose)', async () => {
    // seedRecords has no PENDING intake → nextPendingDueMs === Infinity, so the
    // ONLY guard forcing a post-midnight recompute is the :msToUTCDay(now()) key
    // suffix. Without it a stale ctx would score yesterday's nowMs as "today".
    const records = seedRecords();
    let clock = RM_NOW; // noon Jun 15 UTC
    const gam = createGamificationDomain({ records, now: () => clock, timeZone: 'UTC', getRecordsChangeCount: () => 1 });
    const listSpy = vi.spyOn(records, 'list');
    const rangeSpy = vi.spyOn(records, 'listRange');
    const reads = () => listSpy.mock.calls.length + rangeSpy.mock.calls.length;

    await gam.getSummary();
    const afterFirst = reads();

    // Later same day, fixed change-count → memo hit.
    clock = Date.UTC(2026, 5, 15, 23, 59, 0);
    await gam.getSummary();
    expect(reads()).toBe(afterFirst);

    // Past 00:00 UTC into Jun 16, same change-count, no write → day key changes → recompute.
    clock = Date.UTC(2026, 5, 16, 0, 1, 0);
    await gam.getSummary();
    expect(reads()).toBeGreaterThan(afterFirst);
  });

  it('no memo when the change-count port is absent (bot behavior unchanged)', async () => {
    const records = seedRecords();
    const gam = createGamificationDomain({ records, now: () => RM_NOW, timeZone: 'UTC' });
    const listSpy = vi.spyOn(records, 'list');
    const rangeSpy = vi.spyOn(records, 'listRange');

    await gam.getSummary();
    const readsAfterFirst = listSpy.mock.calls.length + rangeSpy.mock.calls.length;
    await gam.getSummary();
    expect(listSpy.mock.calls.length + rangeSpy.mock.calls.length).toBeGreaterThan(readsAfterFirst);
  });

  it('scoring output identical with vs without the memo', async () => {
    const withMemo = createGamificationDomain({ records: seedRecords(), now: () => RM_NOW, timeZone: 'UTC', getRecordsChangeCount: () => 1 });
    const noMemo = createGamificationDomain({ records: seedRecords(), now: () => RM_NOW, timeZone: 'UTC' });
    expect(await withMemo.getSummary()).toEqual(await noMemo.getSummary());
    expect(await withMemo.getRings()).toEqual(await noMemo.getRings());
    expect(await withMemo.getGauges()).toEqual(await noMemo.getGauges());
  });

  it('HR is read via bounded listRange within the scoring window, never list()', async () => {
    const records = seedRecords();
    const gam = createGamificationDomain({ records, now: () => RM_NOW, timeZone: 'UTC' });
    const listSpy = vi.spyOn(records, 'list');
    const rangeSpy = vi.spyOn(records, 'listRange');

    await gam.getSummary();

    // HR never scanned via the unbounded list().
    expect(listSpy.mock.calls.some((c) => c[0] === 'hrsample')).toBe(false);
    const hrCall = rangeSpy.mock.calls.find((c) => c[0] === 'hrsample');
    expect(hrCall).toBeDefined();
    // Lower bound reaches below the oldest scoring day by the resting-HR gauge baseline
    // window: SCORING_WINDOW_DAYS(365) + gaugeRestingHRBaselineWindowDays(60) + 1 = 426 back, +1 fwd.
    expect(hrCall[1]).toBe(`hrsample-${utcDay(RM_NOW - 426 * DAY_MS)}`);
    expect(hrCall[2]).toBe(`hrsample-${utcDay(RM_NOW + DAY_MS)}`);
  });
});
