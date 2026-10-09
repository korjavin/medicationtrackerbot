// gamification.atlas.test.js
//
// Pure-unit suite for the Discovery Atlas domain module (web/domain/
// gamification.js) — the deterministic probe evaluator, exercised over fixture
// vaults through the same in-memory records port the cloud shim uses. A
// pure-unit test is the right shape here (CLAUDE.md testing posture): the domain
// layer has no integration entry point of its own — it is driven by injected
// ports, exactly like bp.js/weight.js.
//
// The fixtures assert the three card states are REAL computed results, not
// hand-set strings: a planted correlation reveals, sparse data stays developing
// with a meter that names the next log action, and a flat dataset yields a
// dignified no_effect finding.
import { describe, it, expect } from 'vitest';
import { createGamificationDomain, PROBES } from '../../../../web/domain/gamification.js';
import { createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // fixed clock, all offsets < 90d
const TZ = 'UTC';

function domainOver(seed) {
  const records = createInMemoryRecordsPort(seed);
  const gam = createGamificationDomain({ records, now: () => NOW, timeZone: TZ });
  return { records, gam };
}

// isoAt returns the RFC3339 instant `offset` whole days before NOW (noon UTC),
// so every record on a given offset buckets to the same UTC calendar day.
function isoAt(offset) {
  return new Date(NOW - offset * DAY_MS).toISOString();
}
function dayAt(offset) {
  return isoAt(offset).slice(0, 10);
}

function bpRec(offset, systolic) {
  return {
    recordId: `bp-${offset}`, deleted: false,
    // 07:00 UTC: firstMorningSystolic only counts readings before local noon.
    measured_at: new Date(NOW - offset * DAY_MS - 5 * 3600000).toISOString(), systolic, diastolic: 80, ignore_calc: false,
  };
}
function workoutRec(offset) {
  return {
    recordId: `ws-${offset}`, deleted: false,
    status: 'completed', completed_at: isoAt(offset),
  };
}
function sleepRec(offset, totalMinutes, hr) {
  return {
    recordId: `sleep-${offset}`, deleted: false,
    day: dayAt(offset), start_time: isoAt(offset + 1), end_time: isoAt(offset),
    total_minutes: totalMinutes, heart_rate_avg: hr,
  };
}
function foodRec(offset, hour) {
  const d = new Date(NOW - offset * DAY_MS);
  d.setUTCHours(hour, 0, 0, 0);
  return { recordId: `food-${offset}`, deleted: false, eaten_at: d.toISOString() };
}

function cardById(atlas, id) {
  return atlas.cards.find((c) => c.id === id);
}

describe('gamification Discovery Atlas — probe evaluator', () => {
  it('reveals a planted workout → next-morning-BP correlation with real numbers', async () => {
    // 26 chronological days: workout on even days; the morning AFTER a workout
    // reads 116, the morning after a rest day reads 132. Arm = workout(d),
    // gauge = first-morning systolic(d+1). Expect ~ -16 mmHg, well past the
    // 3 mmHg noise floor and ≥ 8 pairs per arm.
    const bp = [];
    const workoutsession = [];
    const count = 26;
    for (let i = 0; i < count; i++) {
      const offset = count - 1 - i; // i ascending in real time
      const workoutToday = i % 2 === 0;
      const prevWorkout = i > 0 && ((i - 1) % 2 === 0);
      const systolic = i === 0 ? 124 : (prevWorkout ? 116 : 132);
      bp.push(bpRec(offset, systolic));
      if (workoutToday) workoutsession.push(workoutRec(offset));
    }

    const { gam } = domainOver({ bp, workoutsession });
    const atlas = await gam.getAtlas();
    const card = cardById(atlas, 'workout_next_morning_bp');

    expect(card.state).toBe('revealed');
    expect(Math.round(card.delta)).toBe(-16);
    expect(card.n).toBeGreaterThanOrEqual(16);
    expect(card.text).toContain('16 mmHg lower');
    expect(card.seen).toBe(false); // reveal-once flag starts unset
  });

  it('keeps a sparse probe developing and names the exact next log action', async () => {
    // Only 3 workout days → below the min-8-per-arm gate.
    const bp = [];
    const workoutsession = [];
    for (let offset = 1; offset <= 12; offset++) bp.push(bpRec(offset, 120));
    [2, 4, 6].forEach((offset) => workoutsession.push(workoutRec(offset)));

    const { gam } = domainOver({ bp, workoutsession });
    const card = cardById(await gam.getAtlas(), 'workout_next_morning_bp');

    expect(card.state).toBe('developing');
    expect(card.needed).toBe(8);
    expect(card.have).toBeLessThan(8);
    expect(card.remaining).toBe(card.needed - card.have);
    expect(card.next).toMatch(/log/i); // names a concrete log action
    expect(card).not.toHaveProperty('delta'); // nothing revealed
  });

  it('reports a flat dataset as a no_effect finding, not a blank', async () => {
    // ≥ 8 workout and ≥ 8 rest days, but next-morning systolic is identical
    // (120) throughout → delta 0, under the noise floor → no_effect.
    const bp = [];
    const workoutsession = [];
    for (let offset = 0; offset <= 24; offset++) {
      bp.push(bpRec(offset, 120));
      if (offset % 2 === 0) workoutsession.push(workoutRec(offset));
    }
    const { gam } = domainOver({ bp, workoutsession });
    const card = cardById(await gam.getAtlas(), 'workout_next_morning_bp');

    expect(card.state).toBe('no_effect');
    expect(card.text).toMatch(/steady/i);
    expect(card).not.toHaveProperty('delta');
  });

  it('persists reveal-once seen flags (and only seen flags)', async () => {
    const bp = [];
    const workoutsession = [];
    const count = 26;
    for (let i = 0; i < count; i++) {
      const offset = count - 1 - i;
      const prevWorkout = i > 0 && ((i - 1) % 2 === 0);
      bp.push(bpRec(offset, i === 0 ? 124 : (prevWorkout ? 116 : 132)));
      if (i % 2 === 0) workoutsession.push(workoutRec(offset));
    }
    const { records, gam } = domainOver({ bp, workoutsession });

    let card = cardById(await gam.getAtlas(), 'workout_next_morning_bp');
    expect(card.seen).toBe(false);

    await gam.markDiscoverySeen('workout_next_morning_bp');
    card = cardById(await gam.getAtlas(), 'workout_next_morning_bp');
    expect(card.seen).toBe(true);

    // The only persisted state is the seen-flag journal singleton — no cached
    // scores, no revealed numbers (§4.2: recompute-on-read).
    const journal = await records.list('gamificationjournal');
    expect(journal).toHaveLength(1);
    expect(journal[0].seen_discoveries).toEqual(['workout_next_morning_bp']);
    // journey.js fires this as a terminal card RENDERS, so it is a read-side
    // write on the shared journal blob and takes the derived floor rather than
    // now() — otherwise a stale tab's repaint erases newer traits/keystones
    // (bd med-y4ue). Losing it costs exactly one extra reveal.
    expect(journal[0].clientTs).toBe(0);
  });

  it('opens a full Atlas showing all three states at once (acceptance)', async () => {
    // Rich vault: workout→BP planted (revealed); constant resting-HR after
    // workouts (no_effect); no step data (developing).
    const bp = [];
    const workoutsession = [];
    const sleep = [];
    const foodlog = [];
    const count = 26;
    for (let i = 0; i < count; i++) {
      const offset = count - 1 - i;
      const workoutToday = i % 2 === 0;
      const prevWorkout = i > 0 && ((i - 1) % 2 === 0);
      bp.push(bpRec(offset, i === 0 ? 124 : (prevWorkout ? 116 : 132)));
      if (workoutToday) workoutsession.push(workoutRec(offset));
      sleep.push(sleepRec(offset, 420, 60)); // constant → HR probe no_effect
      foodlog.push(foodRec(offset, workoutToday ? 22 : 19));
    }

    const { gam } = domainOver({
      bp, workoutsession, sleep, foodlog,
    });
    const atlas = await gam.getAtlas();
    expect(atlas.cards).toHaveLength(PROBES.length);

    const states = new Set(atlas.cards.map((c) => c.state));
    expect(states.has('revealed')).toBe(true);
    expect(states.has('developing')).toBe(true);
    expect(states.has('no_effect')).toBe(true);

    // Zero server-side reads: every number came from the injected records port.
    expect(cardById(atlas, 'workout_next_morning_bp').state).toBe('revealed');
    expect(cardById(atlas, 'short_sleep_next_day_steps').state).toBe('developing');
  });
});

// --- Morning gauge (med-8tur.14) ---------------------------------------------
// firstMorningSystolic only counts a day's earliest reading before local noon,
// so evening-only readings never feed a "next-morning" probe.
describe('gamification Discovery Atlas — morning-only gauge', () => {
  it('evening-only readings in the short-night arm never reveal', async () => {
    for (const [shortNightHour, expected] of [[7, 'revealed'], [19, 'developing']]) {
      const bp = [];
      const sleep = [];
      for (let offset = 0; offset < 26; offset++) {
        const short = offset % 2 === 0;
        sleep.push(sleepRec(offset, short ? 360 : 480, 60));
        const hour = short ? shortNightHour : 7;
        bp.push({
          recordId: `bp-${offset}`, deleted: false, ignore_calc: false, diastolic: 80,
          measured_at: new Date(NOW - offset * DAY_MS - (12 - hour) * 3600000).toISOString(),
          systolic: short ? 140 : 120,
        });
      }
      const { gam } = domainOver({ bp, sleep });
      const card = cardById(await gam.getAtlas({ whatsNew: false }), 'short_sleep_next_morning_bp');
      expect(card.state).toBe(expected);
    }
  });
});

// --- Sleep-timing probes (med-8tur.15) ---------------------------------------
// Bedtime vs the window's own median onset; gauge = next-morning systolic.
describe('gamification Discovery Atlas — sleep-timing probes', () => {
  const TIMING = ['late_bedtime_next_morning_bp', 'irregular_bedtime_next_morning_bp'];

  // A night ending on wake day `offset`: bedtime at `localMin` minutes after
  // the previous local midnight (23:30 = 1410, 01:00 = 1500) on a clock
  // `tz` minutes west of UTC (the sleep record's timezone_offset).
  function night({ offset, localMin, tz = 0, minutes = 420 }) {
    const wakeMidnight = Date.parse(`${dayAt(offset)}T00:00:00Z`);
    const start = wakeMidnight - DAY_MS + localMin * 60000 + tz * 60000;
    const rec = {
      recordId: `sleep-${offset}`, deleted: false, day: dayAt(offset),
      start_time: new Date(start).toISOString(), timezone_offset: tz,
    };
    if (minutes !== undefined) rec.total_minutes = minutes;
    return rec;
  }

  // 20 usual nights (23:00) and `late` late nights (01:00), each followed by
  // a morning reading: usualBp / lateBp.
  function timingVault({ late = 10, usualBp = 125, lateBp = 135 } = {}) {
    const sleep = [];
    const bp = [];
    for (let offset = 0; offset < 20 + late; offset++) {
      const isLate = offset < late;
      sleep.push(night({ offset, localMin: isLate ? 1500 : 1380 }));
      bp.push(bpRec(offset, isLate ? lateBp : usualBp));
    }
    return { sleep, bp };
  }

  it('reveals later-than-usual bedtimes with the delta and its spread', async () => {
    const { gam } = domainOver(timingVault());
    const atlas = await gam.getAtlas({ whatsNew: false });
    for (const id of TIMING) {
      const card = cardById(atlas, id);
      expect(card.state).toBe('revealed');
      expect(Math.round(card.delta)).toBe(10);
      expect(card.n).toBe(30);
      expect(Number.isFinite(card.se)).toBe(true);
      expect(card.text).toContain('~10 mmHg higher · 30 paired days');
    }
  });

  it('reports matching mornings as no_effect', async () => {
    const { gam } = domainOver(timingVault({ usualBp: 120, lateBp: 121 }));
    const atlas = await gam.getAtlas({ whatsNew: false });
    for (const id of TIMING) {
      const card = cardById(atlas, id);
      expect(card.state).toBe('no_effect');
      expect(card.text).toMatch(/about the same/);
      expect(card).not.toHaveProperty('se');
    }
  });

  it('stays developing below 8 nights per arm', async () => {
    const { gam } = domainOver(timingVault({ late: 5 }));
    const atlas = await gam.getAtlas({ whatsNew: false });
    for (const id of TIMING) {
      const card = cardById(atlas, id);
      expect(card.state).toBe('developing');
      expect(card.have).toBe(5);
      expect(card.next).toMatch(/sleep/);
    }
  });

  it('needs 5 nights with a bedtime: start_time-only nights count, minutes-only nights never do', async () => {
    const bp = Array.from({ length: 90 }, (_, offset) => bpRec(offset, 120));
    const sleep = [1, 2, 3, 4].map((offset) => night({ offset, localMin: 1380 }));
    // No start_time → no bedtime (and no NaN), however long the night.
    sleep.push({ recordId: 'sleep-5', deleted: false, day: dayAt(5), total_minutes: 600 });
    let atlas = await domainOver({ bp, sleep }).gam.getAtlas({ whatsNew: false });
    for (const id of TIMING) expect(cardById(atlas, id).have).toBe(0);

    // A late night with a start_time but no total_minutes is the fifth onset.
    sleep.push(night({ offset: 6, localMin: 1500, minutes: undefined }));
    atlas = await domainOver({ bp, sleep }).gam.getAtlas({ whatsNew: false });
    for (const id of TIMING) expect(cardById(atlas, id).have).toBe(1);
  });

  it('reads each night on its own clock: 23:30 in UTC-5 and UTC+3 are both usual', async () => {
    const sleep = [];
    const bp = [];
    for (let offset = 0; offset < 28; offset++) {
      const isLate = offset < 8;
      sleep.push(isLate
        ? night({ offset, localMin: 1500 })
        : night({ offset, localMin: 1410, tz: offset % 2 ? 300 : -180 }));
      bp.push(bpRec(offset, isLate ? 140 : 120));
    }
    const atlas = await domainOver({ sleep, bp }).gam.getAtlas({ whatsNew: false });
    const card = cardById(atlas, 'late_bedtime_next_morning_bp');
    expect(card.state).toBe('revealed');
    expect(Math.round(card.delta)).toBe(20); // every shifted-zone night sat in the usual arm
    expect(card.n).toBe(28);
  });
});

// --- Goal-relevant probes (med-8tur.10, docs/gamification.md §0.3.6) ---------
// Week-bucketed: complete local ISO weeks of the 90-day window, gauge = the
// week's change in the Goal Line trend (sum of its EMA steps). NOW is a Monday,
// so offsets 1..7 are the last complete week; daily weigh-ins from offset 110
// keep the trend run older than the window, so every week is readable.
describe('gamification Discovery Atlas — goal-relevant weekly probes', () => {
  const WEEK_PROBES = ['workout_weeks_vs_trend_velocity', 'food_logged_weeks_vs_trend_velocity'];

  // Odd weeks back (1, 3, 5, ...) are "active": workouts Mon/Wed/Fri and food
  // logged Mon–Fri. weightAt(offset, active) sets that morning's reading.
  function weeklyVault(weightAt) {
    const weight = [];
    const workoutsession = [];
    const foodlog = [];
    for (let offset = 0; offset <= 110; offset++) {
      const active = Math.floor((offset + 6) / 7) % 2 === 1;
      const morning = new Date(NOW - offset * DAY_MS - 5 * 3600000).toISOString();
      weight.push({ recordId: `w-${offset}`, deleted: false, measured_at: morning, weight: weightAt(offset, active) });
      const dow = new Date(NOW - offset * DAY_MS).getUTCDay();
      if (active && [1, 3, 5].includes(dow)) workoutsession.push(workoutRec(offset));
      if (active && dow >= 1 && dow <= 5) foodlog.push(foodRec(offset, 13));
    }
    return { weight, workoutsession, foodlog };
  }

  it('reveals a trend that moves more downward in active weeks, in kg/week', async () => {
    // −0.3 kg/day through active weeks, +0.3 kg/day through the others.
    const byOffset = new Map();
    let w = 90;
    for (let offset = 110; offset >= 0; offset--) {
      w += Math.floor((offset + 6) / 7) % 2 === 1 ? -0.3 : 0.3;
      byOffset.set(offset, w);
    }
    const { gam } = domainOver(weeklyVault((offset) => byOffset.get(offset)));
    const atlas = await gam.getAtlas({ whatsNew: false });
    for (const id of WEEK_PROBES) {
      const card = cardById(atlas, id);
      expect(card.state).toBe('revealed');
      expect(card.bucket).toBe('week');
      expect(card.unit).toBe('kg/wk');
      expect(card.delta).toBeLessThan(-0.2);
      expect(card.n).toBe(12); // twelve complete weeks in the window
      expect(card.text).toMatch(/kg\/week more downward than in other weeks · 12 weeks/);
    }
  });

  it('a food day flagged incomplete does not count as a food-logged day (med-0sgs)', async () => {
    const byOffset = new Map();
    let w = 90;
    for (let offset = 110; offset >= 0; offset--) {
      w += Math.floor((offset + 6) / 7) % 2 === 1 ? -0.3 : 0.3;
      byOffset.set(offset, w);
    }
    const vault = weeklyVault((offset) => byOffset.get(offset));
    // Flag one weekday per active week: 4 counted days < the 5-day arm.
    vault.fooddaystatus = vault.foodlog
      .filter((r) => new Date(r.eaten_at).getUTCDay() === 3)
      .map((r) => {
        const date = r.eaten_at.slice(0, 10);
        return { recordId: `fooddaystatus:${date}`, deleted: false, date, incomplete: true };
      });
    const { gam } = domainOver(vault);
    const atlas = await gam.getAtlas({ whatsNew: false });
    expect(cardById(atlas, 'workout_weeks_vs_trend_velocity').state).toBe('revealed');
    expect(cardById(atlas, 'food_logged_weeks_vs_trend_velocity').state).not.toBe('revealed');
  });

  it('reports a flat trend as a no_effect finding, not a blank', async () => {
    const { gam } = domainOver(weeklyVault(() => 80));
    const atlas = await gam.getAtlas({ whatsNew: false });
    for (const id of WEEK_PROBES) {
      const card = cardById(atlas, id);
      expect(card.state).toBe('no_effect');
      expect(card.text).toMatch(/about the same/);
      expect(card).not.toHaveProperty('delta');
    }
  });

  it('ED-safe drops both weight-trend probes from the Atlas', async () => {
    const vault = weeklyVault(() => 80);
    vault.gamificationmode = [{ recordId: 'gamificationmode', deleted: false, ed_safe: true }];
    const { gam } = domainOver(vault);
    const atlas = await gam.getAtlas({ whatsNew: false });
    for (const id of WEEK_PROBES) expect(cardById(atlas, id)).toBeUndefined();
    expect(atlas.cards).toHaveLength(PROBES.filter((p) => !p.weight).length);
  });

  it('stays developing while the trend run is too young to read a week', async () => {
    // 18 days of weigh-ins: the run starts inside the window, so the week that
    // holds its first reading is unreadable and no week has both arms.
    const weight = Array.from({ length: 18 }, (_, offset) => ({
      recordId: `w-${offset}`, deleted: false, measured_at: isoAt(offset), weight: 80,
    }));
    const { gam } = domainOver({ weight });
    const atlas = await gam.getAtlas({ whatsNew: false });
    for (const id of WEEK_PROBES) {
      const card = cardById(atlas, id);
      expect(card.state).toBe('developing');
      expect(card.needed).toBe(3);
      expect(card.have).toBe(0);
      expect(card.next).toMatch(/Weigh in/);
    }
  });
});

// --- "Since you last looked" strip (med-edxz.3) ---------------------------
// getWhatsNew composes the existing narrative reads and rides on the Atlas
// payload, so these drive the real getAtlas() path over fixture vaults.
describe('gamification "since you last looked" strip', () => {
  const PROBE_IDS = [
    'workout_next_morning_bp', 'short_sleep_next_morning_bp', 'weekend_systolic',
    'workout_next_day_resting_hr', 'short_sleep_next_day_steps', 'late_dinner_sleep_duration',
  ];

  function journalRec(fields) {
    return { recordId: 'journal', deleted: false, clientTs: NOW, ...fields };
  }

  function wordCount(text) {
    return text.split(/\s+/).filter((w) => /[\w\d]/.test(w)).length;
  }

  it('leads with the unseen discovery, then the trait earned two days ago', async () => {
    // 26 days with a planted workout -> next-morning-BP effect (~-16 mmHg), and
    // 13 workout days in the trailing 28 so Consistent Mover is held. Systolics
    // sit ABOVE the default 130 target band, so no BP keystone is minted; every
    // other probe's finding is already marked read. What is left is exactly one
    // unseen discovery and one trait earned two days ago.
    const bp = [];
    const workoutsession = [];
    const count = 26;
    for (let i = 0; i < count; i++) {
      const offset = count - 1 - i;
      const prevWorkout = i > 0 && ((i - 1) % 2 === 0);
      bp.push(bpRec(offset, i === 0 ? 134 : (prevWorkout ? 126 : 142)));
      if (i % 2 === 0) workoutsession.push(workoutRec(offset));
    }
    const { gam } = domainOver({
      bp,
      workoutsession,
      gamificationjournal: [journalRec({
        seen_discoveries: PROBE_IDS.filter((id) => id !== 'workout_next_morning_bp'),
        traits: { consistent_mover: { earned_at: NOW - 2 * DAY_MS } },
      })],
    });

    const atlas = await gam.getAtlas();
    expect(cardById(atlas, 'workout_next_morning_bp').state).toBe('revealed');

    const items = atlas.whats_new;
    expect(items.map((it) => it.kind)).toEqual(['discovery', 'trait']);
    expect(items[0].text).toContain('New: ');
    expect(items[0].text).toContain('16 mmHg lower');
    expect(items[0].target).toBe('journey-atlas-card');
    expect(items[1].text).toBe('You\u2019re now a Consistent Mover.');
    expect(items[1].target).toBe('journey-traits-card');

    // The strip stays skimmable: at most four lines, each a short one-liner.
    expect(items.length).toBeLessThanOrEqual(4);
    items.forEach((it) => expect(wordCount(it.text)).toBeLessThanOrEqual(20));
  });

  it('falls back to one anticipation line naming the closest developing probe', async () => {
    // Three weeks of BP and nothing else: no finding has cleared its gate, no
    // trait, no keystone (the readings sit above the target band), no trial.
    // The weekend probe is the only one with real pairs, so it headlines.
    const bp = [];
    for (let offset = 40; offset <= 60; offset++) bp.push(bpRec(offset, 140));
    const { gam } = domainOver({ bp });

    const atlas = await gam.getAtlas();
    const items = atlas.whats_new;
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('anticipation');
    expect(items[0].target).toBe('journey-atlas-card');

    // The count is the real remaining, read off the same card the line names.
    const closest = atlas.cards
      .filter((c) => c.state === 'developing' && c.have > 0)
      .sort((a, b) => a.remaining - b.remaining)[0];
    expect(closest).toBeDefined();
    expect(items[0].text).toBe(`${closest.remaining} more paired days until: ${closest.question}`);
    expect(wordCount(items[0].text)).toBeLessThanOrEqual(20);
  });

  // A vault rich enough to fire every candidate at once: four unseen terminal
  // findings, a BP keystone and a freshly held trait. Both caps have to bite.
  function saturatedVault() {
    const bp = [];
    const workoutsession = [];
    const sleep = [];
    const count = 30;
    for (let i = 0; i < count; i++) {
      const offset = count - 1 - i;
      const prevWorkout = i > 0 && ((i - 1) % 2 === 0);
      bp.push(bpRec(offset, i === 0 ? 118 : (prevWorkout ? 110 : 126)));
      if (i % 2 === 0) workoutsession.push(workoutRec(offset));
      // A constant resting HR makes the workout→resting-HR probe a no_effect
      // finding, which is the fourth unseen terminal card.
      sleep.push(sleepRec(offset, i % 2 === 0 ? 450 : 360, 60));
    }
    return { bp, workoutsession, sleep };
  }

  it('caps the strip at four lines and at two discoveries, dropping the lowest priority', async () => {
    const { gam } = domainOver(saturatedVault());
    const atlas = await gam.getAtlas();

    // Four findings have cleared their gate and none has been read yet...
    expect(atlas.cards.filter((c) => c.seen === false)).toHaveLength(4);
    // ...but only two reach the strip, and the whole strip is four lines.
    expect(atlas.whats_new.map((it) => it.kind)).toEqual(['discovery', 'discovery', 'keystone', 'trait']);
  });

  // med-8tur.12: the Tomorrow Forecast is gone, so it no longer contributes a
  // strip line; the strip can still be skipped outright.
  it('falls through to the lower-priority lines once findings are read, and drops the strip on demand', async () => {
    const { gam } = domainOver(saturatedVault());
    // Read every finding so the strip falls through to the lower-priority items.
    for (const c of (await gam.getAtlas()).cards) {
      if (c.seen === false) await gam.markDiscoverySeen(c.id);
    }

    expect((await gam.getAtlas()).whats_new.map((it) => it.kind))
      .toEqual(['keystone', 'trait']);
    // The narrate handlers hold these payloads already and drop whats_new, so
    // they opt out of composing it entirely.
    expect(await gam.getAtlas({ whatsNew: false })).not.toHaveProperty('whats_new');
  });

  // med-huec — the dormant and verdict lines carry a 7-day recency window
  // so a stale trait or an undismissed verdict stops pinning the strip
  // non-empty (and starving the anticipation fallback) forever.

  // Three weeks of above-band BP and nothing else: no finding clears its
  // gate, no keystone — the weekend probe holds real pairs, so
  // the strip falls through to anticipation unless a recent dormant/verdict
  // line claims it first.
  function quietVaultWithPairs() {
    const bp = [];
    for (let offset = 40; offset <= 60; offset++) bp.push(bpRec(offset, 140));
    return { bp };
  }

  function resolvedExpRec(resolvedOffset) {
    return {
      recordId: 'exp-1', deleted: false,
      template_id: 'bedtime_window', status: 'resolved',
      started_at: NOW - (resolvedOffset + 14) * DAY_MS, duration_days: 14,
      resolved_at: NOW - resolvedOffset * DAY_MS,
      acknowledged: false,
      verdict: { verdict: 'effect', rewarded: true },
    };
  }

  it('shows a recently dormant trait, hiding the anticipation fallback', async () => {
    // Consistent Mover (earn 12/28, rekindle 3/7), earned long ago: 12
    // workout days with the 4 oldest about to age out of the 28-day window,
    // so the trait held 4 days ago and lapsed since.
    const seed = quietVaultWithPairs();
    seed.workoutsession = [10, 11, 12, 13, 14, 15, 16, 17, 29, 30, 31, 32]
      .map((offset) => workoutRec(offset));
    seed.gamificationjournal = [journalRec({
      traits: { consistent_mover: { earned_at: NOW - 60 * DAY_MS } },
    })];
    const { gam } = domainOver(seed);

    const mover = (await gam.getTraits()).traits
      .find((t) => t.id === 'consistent_mover');
    expect(mover.state).toBe('dormant');
    expect(mover.dormant_since).toBeGreaterThan(NOW - 7 * DAY_MS);

    const items = (await gam.getAtlas()).whats_new;
    expect(items.map((it) => it.kind)).toEqual(['trait']);
    expect(items[0].text).toContain('is dormant');
    expect(items[0].target).toBe('journey-traits-card');
  });

  it('lets a long-dormant trait age out so the anticipation fallback returns', async () => {
    // Earned 60 days ago with no lever day left in the window: dormant with
    // no recent transition — not news, so the strip falls through.
    const seed = quietVaultWithPairs();
    seed.gamificationjournal = [journalRec({
      traits: { consistent_mover: { earned_at: NOW - 60 * DAY_MS } },
    })];
    const { gam } = domainOver(seed);

    const mover = (await gam.getTraits()).traits
      .find((t) => t.id === 'consistent_mover');
    expect(mover.state).toBe('dormant');

    const items = (await gam.getAtlas()).whats_new;
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('anticipation');
  });

  it('uses the singular unit when one lever day rekindles a dormant trait', async () => {
    // The same lapse plus two move days this week: dormant with exactly one
    // day left to rekindle.
    const seed = quietVaultWithPairs();
    seed.workoutsession = [1, 2, 10, 11, 12, 13, 14, 15, 16, 17, 29, 30, 31, 32]
      .map((offset) => workoutRec(offset));
    seed.gamificationjournal = [journalRec({
      traits: { consistent_mover: { earned_at: NOW - 60 * DAY_MS } },
    })];
    const { gam } = domainOver(seed);

    const items = (await gam.getAtlas()).whats_new;
    expect(items.map((it) => it.kind)).toEqual(['trait']);
    expect(items[0].text)
      .toBe('Consistent Mover is dormant — 1 more move day rekindles it. Nothing was lost.');
  });

  it('shows a recently resolved trial, hiding the anticipation fallback', async () => {
    const seed = quietVaultWithPairs();
    seed.gamificationexperiment = [resolvedExpRec(2)];
    const { gam } = domainOver(seed);

    const items = (await gam.getAtlas()).whats_new;
    expect(items.map((it) => it.kind)).toEqual(['experiment']);
    expect(items[0].text).toContain('Your trial finished');
    expect(items[0].target).toBe('journey-experiment-card');
  });

  it('lets an old unacknowledged verdict age out so the anticipation fallback returns', async () => {
    const seed = quietVaultWithPairs();
    seed.gamificationexperiment = [resolvedExpRec(10)];
    const { gam } = domainOver(seed);

    // The verdict still waits on its own card — it just stops leading news.
    expect((await gam.listExperiments()).verdict).not.toBeNull();

    const items = (await gam.getAtlas()).whats_new;
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('anticipation');
  });

  it('dates the dormancy transition on the local calendar across a DST change', async () => {
    // Europe/Berlin springs forward on 2026-03-29; at 00:30 local on Mar 30
    // a fixed-24h replay lands back on Mar 28 and skips Mar 29 entirely. The
    // transition must come from local date keys, not elapsed hours.
    const tz = 'Europe/Berlin';
    const at = Date.parse('2026-03-29T22:30:00Z'); // Mar 30 00:30 CEST
    const dates = ['2026-02-28',
      ...Array.from({ length: 11 }, (_, i) => `2026-03-${String(i + 2).padStart(2, '0')}`)];
    const records = createInMemoryRecordsPort({
      workoutsession: dates.map((d, i) => ({
        recordId: `ws-${i}`, deleted: false, status: 'completed', completed_at: `${d}T12:00:00Z`,
      })),
      gamificationjournal: [journalRec({
        traits: { consistent_mover: { earned_at: Date.parse('2026-02-20T12:00:00Z') } },
      })],
    });
    const gam = createGamificationDomain({ records, now: () => at, timeZone: tz });
    const mover = (await gam.getTraits()).traits
      .find((t) => t.id === 'consistent_mover');
    expect(mover.state).toBe('dormant');
    // Held through Mar 28, dormant since Mar 29 — never Mar 30.
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(mover.dormant_since));
    expect(day).toBe('2026-03-29');
  });

  it('shows nothing at all on a fresh account', async () => {
    const { gam } = domainOver({});
    expect((await gam.getAtlas()).whats_new).toEqual([]);
  });
});
