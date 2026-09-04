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
import { createGamificationDomain } from '../../../../web/domain/gamification.js';
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
    measured_at: isoAt(offset), systolic, diastolic: 80, ignore_calc: false,
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
    expect(atlas.cards).toHaveLength(6);

    const states = new Set(atlas.cards.map((c) => c.state));
    expect(states.has('revealed')).toBe(true);
    expect(states.has('developing')).toBe(true);
    expect(states.has('no_effect')).toBe(true);

    // Zero server-side reads: every number came from the injected records port.
    expect(cardById(atlas, 'workout_next_morning_bp').state).toBe('revealed');
    expect(cardById(atlas, 'short_sleep_next_day_steps').state).toBe('developing');
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

  it('shows nothing at all on a fresh account', async () => {
    const { gam } = domainOver({});
    expect((await gam.getAtlas()).whats_new).toEqual([]);
  });
});
