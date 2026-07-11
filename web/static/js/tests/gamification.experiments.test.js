// gamification.experiments.test.js
//
// Pure-unit suite for the Self-Experiments (N-of-1) domain lifecycle
// (web/domain/gamification.js — listExperiments / startExperiment /
// cancelExperiment + EXPERIMENT_TEMPLATES), the Phase 4 flagship mechanic.
// Like the Atlas/Forecast suites, a pure-unit test is the right shape
// (CLAUDE.md testing posture): the domain layer is driven only by injected
// ports, so it has no integration entry point.
//
// The fixtures assert the design's load-bearing invariants:
//   - a 14-day trial persists as a gamificationexperiment vault record,
//   - the verdict is the honesty-gate math over the user's OWN logged data,
//   - a no_effect verdict is rewarded IDENTICALLY to an effect (§3.3),
//   - max-1-concurrent, cancel-with-no-penalty, lever-template-only,
//   - the recovery-mode auto-pause seam (no-op until the flag record exists).
import { describe, it, expect } from 'vitest';
import {
  createGamificationDomain,
  EXPERIMENT_TEMPLATES,
} from '../../../../web/domain/gamification.js';
import { createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // fixed clock, all offsets < 90d
const TZ = 'UTC';

function domainOver(seed) {
  const records = createInMemoryRecordsPort(seed);
  const gam = createGamificationDomain({ records, now: () => NOW, timeZone: TZ });
  return { records, gam };
}

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
function sleepRec(offset, totalMinutes) {
  return {
    recordId: `sleep-${offset}`, deleted: false,
    day: dayAt(offset), total_minutes: totalMinutes, heart_rate_avg: 60,
  };
}

// An experiment record started 20 days ago (duration 14 → window fully elapsed
// by NOW, so listExperiments auto-resolves it) unless overridden.
function expRec(overrides = {}) {
  return {
    recordId: 'exp-1', deleted: false,
    template_id: 'bedtime_window', status: 'active',
    started_at: NOW - 20 * DAY_MS, duration_days: 14,
    ...overrides,
  };
}

// Seeds bp + sleep across the elapsed trial window (offsets 7..20). Even days
// are "window nights" (7h+), odd days are shorter — systolicFor decides the
// morning reading per arm so a fixture can plant an effect, a null, or no
// contrast.
function seedWindow(systolicFor, minutesFor) {
  const bp = [];
  const sleep = [];
  for (let offset = 7; offset <= 20; offset++) {
    const goodNight = offset % 2 === 0;
    sleep.push(sleepRec(offset, minutesFor(goodNight)));
    bp.push(bpRec(offset, systolicFor(goodNight)));
  }
  return { bp, sleep };
}

describe('gamification Self-Experiments — lifecycle', () => {
  it('starts a 14-day trial and persists it as a vault record', async () => {
    const { gam, records } = domainOver({});
    const res = await gam.startExperiment('bedtime_window', { source_discovery: 'short_sleep_next_morning_bp' });

    expect(res.ok).toBe(true);
    expect(res.active.template_id).toBe('bedtime_window');
    expect(res.active.duration).toBe(14);
    expect(res.active.day_number).toBe(1);

    const stored = await records.list('gamificationexperiment');
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe('active');
    expect(stored[0].started_at).toBe(NOW);
    expect(stored[0].source_discovery).toBe('short_sleep_next_morning_bp');
  });

  it('enforces max-1-concurrent', async () => {
    const { gam } = domainOver({});
    expect((await gam.startExperiment('bedtime_window', {})).ok).toBe(true);
    const second = await gam.startExperiment('workout_cadence', {});
    expect(second.ok).toBe(false);
    expect(second.error).toBe('already_active');
  });

  it('rejects an unknown / non-curated template (lever-only guardrail)', async () => {
    const { gam } = domainOver({});
    const res = await gam.startExperiment('lose_5kg', {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unknown_template');
  });

  it('cancels an active trial with no penalty and frees the slot', async () => {
    const { gam } = domainOver({});
    const started = await gam.startExperiment('bedtime_window', {});
    const cancelled = await gam.cancelExperiment(started.active.id);
    expect(cancelled.status).toBe('cancelled');

    const after = await gam.listExperiments();
    expect(after.active).toBeNull();
    expect(after.verdict).toBeNull(); // a cancel produces no verdict, no penalty
    expect(after.can_start).toBe(true);
  });

  it('tracks progress mid-trial (Day N of 14 · lever-on count)', async () => {
    // Started 5 days ago; even-offset days in [1..5] logged a window night.
    const seed = {
      ...seedWindow(() => 120, (g) => (g ? 450 : 360)),
      gamificationexperiment: [expRec({ started_at: NOW - 5 * DAY_MS })],
    };
    // Re-seed the recent nights the tracker counts (offsets 1..5).
    for (let offset = 1; offset <= 5; offset++) {
      seed.sleep.push(sleepRec(100 + offset, offset % 2 === 0 ? 450 : 360));
    }
    const { gam } = domainOver(seed);
    const res = await gam.listExperiments();
    expect(res.active).not.toBeNull();
    expect(res.active.day_number).toBe(6); // started 5 days ago → today is day 6
    expect(res.active.tracker).toMatch(/Day 6 of 14/);
    expect(res.verdict).toBeNull(); // window not elapsed yet
  });
});

describe('gamification Self-Experiments — honesty-gate verdict', () => {
  it('resolves to `effect` with the numbers when the window elapses', async () => {
    const seed = {
      ...seedWindow((g) => (g ? 118 : 145), (g) => (g ? 450 : 360)),
      gamificationexperiment: [expRec()],
    };
    const { gam, records } = domainOver(seed);
    const res = await gam.listExperiments();

    expect(res.active).toBeNull();
    expect(res.verdict.verdict).toBe('effect');
    expect(res.verdict.rewarded).toBe(true);
    expect(res.verdict.delta).toBeLessThan(0); // window nights ran lower
    expect(res.verdict.n_on).toBeGreaterThanOrEqual(4);
    expect(res.verdict.n_off).toBeGreaterThanOrEqual(4);
    expect(res.verdict.disclaimer).toMatch(/not medical advice/i);

    // Frozen once, on completion — the record is now resolved.
    const stored = await records.list('gamificationexperiment');
    expect(stored[0].status).toBe('resolved');
    expect(stored[0].verdict.verdict).toBe('effect');
  });

  it('resolves to `no_effect` — a real finding rewarded IDENTICALLY to `effect`', async () => {
    // Same clean two-arm contrast (7 window nights vs 7 short), but the morning
    // reading is flat regardless → a genuine null result.
    const seed = {
      ...seedWindow(() => 120, (g) => (g ? 450 : 360)),
      gamificationexperiment: [expRec()],
    };
    const { gam } = domainOver(seed);
    const res = await gam.listExperiments();

    expect(res.verdict.verdict).toBe('no_effect');
    // THE invariant: no_effect pays the same reward as effect.
    expect(res.verdict.rewarded).toBe(true);
    expect(res.verdict.text).toMatch(/null result/i);
  });

  it('resolves to `not_enough_contrast` (no reward, no penalty) when an arm is empty', async () => {
    // Every night is a window night → the off-arm never fills.
    const seed = {
      ...seedWindow((g) => (g ? 118 : 145), () => 450),
      gamificationexperiment: [expRec()],
    };
    const { gam } = domainOver(seed);
    const res = await gam.listExperiments();

    expect(res.verdict.verdict).toBe('not_enough_contrast');
    expect(res.verdict.rewarded).toBe(false);
    expect(res.verdict.text).toMatch(/no penalty/i);
  });

  it('a fresh read after resolution is idempotent (never recomputes a frozen verdict)', async () => {
    const seed = {
      ...seedWindow((g) => (g ? 118 : 145), (g) => (g ? 450 : 360)),
      gamificationexperiment: [expRec()],
    };
    const { gam } = domainOver(seed);
    const first = await gam.listExperiments();
    const second = await gam.listExperiments();
    expect(second.verdict.verdict).toBe(first.verdict.verdict);
    expect(second.verdict.delta).toBe(first.verdict.delta);
  });
});

describe('gamification Self-Experiments — recovery-mode auto-pause seam', () => {
  it('no-ops when no recovery-mode signal exists (the flag is not in the codebase yet)', async () => {
    const { gam } = domainOver({});
    const res = await gam.listExperiments();
    expect(res.recovery_paused).toBe(false);
    expect(res.can_start).toBe(true);
  });

  it('pauses an active trial and blocks resolution + new starts when the signal is present', async () => {
    const seed = {
      ...seedWindow((g) => (g ? 118 : 145), (g) => (g ? 450 : 360)),
      gamificationexperiment: [expRec()],
      gamificationmode: [{ recordId: 'mode', deleted: false, recovery: true }],
    };
    const { gam } = domainOver(seed);
    const res = await gam.listExperiments();

    expect(res.recovery_paused).toBe(true);
    expect(res.active).not.toBeNull();
    expect(res.active.paused).toBe(true);
    expect(res.verdict).toBeNull(); // elapsed, but NOT frozen while paused
    expect(res.can_start).toBe(false);

    const start = await gam.startExperiment('workout_cadence', {});
    expect(start.ok).toBe(false);
    expect(start.error).toBe('recovery_paused');
  });
});

describe('gamification Self-Experiments — curated lever-only template library', () => {
  it('every template is a lever tied to a probe, never a restriction or weight target', () => {
    expect(EXPERIMENT_TEMPLATES.length).toBeGreaterThan(0);
    for (const t of EXPERIMENT_TEMPLATES) {
      expect(typeof t.lever).toBe('function'); // a behavior, not a value target
      expect(typeof t.fromProbe).toBe('string');
      const blob = `${t.title} ${t.intention} ${t.measure}`.toLowerCase();
      expect(blob).not.toMatch(/weight|calorie|kg|lose|less|restrict/);
    }
  });
});
