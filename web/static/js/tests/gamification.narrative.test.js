// gamification.narrative.test.js
//
// Pure-unit suite for the Phase 5 narrative layer of web/domain/gamification.js:
// Chapters (getChapter / startChapter / closeChapter), Traits (getTraits), and
// Keystones (getKeystones + the experiment-completion timeline). Like the
// Atlas/Forecast/Experiments suites, a pure-unit test is the right shape
// (CLAUDE.md testing posture): the domain layer is driven only by injected
// ports, so it has no integration entry point.
//
// The fixtures pin the design's load-bearing invariants (§3.5–3.7 / §5):
//   - a lapsed trait renders DORMANT (never deleted) with a stated rekindle cost,
//   - traits are LEVERS ONLY — no gauge/outcome/body identity (guardrail),
//   - recovery mode pauses the trait dormancy clock,
//   - a closed chapter produces a deterministic written review,
//   - keystones are permanent, deduped, and appear only on genuine events.
import { describe, it, expect } from 'vitest';
import {
  createGamificationDomain,
  CHAPTER_THEMES,
  TRAITS,
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
function sleepRec(offset, totalMinutes) {
  return {
    recordId: `sleep-${offset}`, deleted: false,
    day: dayAt(offset), total_minutes: totalMinutes, heart_rate_avg: 60,
  };
}
function workoutRec(offset) {
  return {
    recordId: `wo-${offset}`, deleted: false,
    status: 'completed', completed_at: isoAt(offset),
  };
}
function bpRec(offset, systolic) {
  return {
    recordId: `bp-${offset}`, deleted: false,
    measured_at: isoAt(offset), systolic, diastolic: 80, ignore_calc: false,
  };
}

// Seeds N consecutive nights (offsets 1..count) of 7h+ sleep — enough window
// nights to earn the Early Sleeper trait (earn = 21 of 28).
function windowNights(count) {
  const sleep = [];
  for (let offset = 1; offset <= count; offset++) sleep.push(sleepRec(offset, 450));
  return sleep;
}

describe('gamification Chapters — opt-in 4-week arcs + written review', () => {
  it('starts a chapter from a curated theme and persists enrollment', async () => {
    const { gam, records } = domainOver({});
    const res = await gam.startChapter('early_sleeper');
    expect(res.ok).toBe(true);
    expect(res.active.theme_id).toBe('early_sleeper');
    expect(res.active.duration).toBe(28);
    expect(res.active.day_number).toBe(1);

    const journal = (await records.list('gamificationjournal'))[0];
    expect(journal.chapter.theme_id).toBe('early_sleeper');
    expect(journal.chapter.started_at).toBe(NOW);
  });

  it('rejects an unknown theme and enforces one active chapter at a time', async () => {
    const { gam } = domainOver({});
    expect((await gam.startChapter('lose_5kg')).ok).toBe(false);
    expect((await gam.startChapter('steady_month')).ok).toBe(true);
    const second = await gam.startChapter('early_sleeper');
    expect(second.ok).toBe(false);
    expect(second.error).toBe('already_active');
  });

  it('closeChapter ends the arc early with no penalty and writes a review', async () => {
    const seed = { sleep: windowNights(20) };
    const { gam, records } = domainOver(seed);
    await gam.startChapter('early_sleeper');
    const closed = await gam.closeChapter();
    expect(closed.ok).toBe(true);
    expect(closed.review.theme_id).toBe('early_sleeper');
    expect(typeof closed.review.text).toBe('string');
    expect(closed.review.text.length).toBeGreaterThan(0);

    // No active chapter remains; the review is retrievable + the library reopens.
    const after = await gam.getChapter();
    expect(after.active).toBeNull();
    expect(after.can_start).toBe(true);
    expect(after.review.theme_id).toBe('early_sleeper');

    const journal = (await records.list('gamificationjournal'))[0];
    expect(journal.chapter).toBeNull();
    expect(journal.closed_chapters).toHaveLength(1);
  });

  it('auto-closes an elapsed chapter into a review on read (fresh-start landmark)', async () => {
    const seed = {
      sleep: windowNights(25),
      gamificationjournal: [{
        recordId: 'journal', deleted: false,
        chapter: { theme_id: 'steady_month', started_at: NOW - 30 * DAY_MS },
      }],
    };
    const { gam } = domainOver(seed);
    const res = await gam.getChapter();
    expect(res.active).toBeNull();      // 30 days > 28-day window → auto-closed
    expect(res.review).not.toBeNull();
    expect(res.can_start).toBe(true);
  });

  it('a barely-logged window closes as "a quiet chapter", not a wall of zeros', async () => {
    const { gam } = domainOver({});
    await gam.startChapter('the_rebuild');
    const closed = await gam.closeChapter();
    expect(closed.review.quiet).toBe(true);
    expect(closed.review.text).toMatch(/quiet chapter/i);
  });
});

describe('gamification Traits — levers-only identity, dormant + rekindle', () => {
  it('earns a trait from lever consistency and persists only the earned timestamp', async () => {
    const { gam, records } = domainOver({ sleep: windowNights(24) });
    const res = await gam.getTraits();
    const early = res.traits.find((t) => t.id === 'early_sleeper');
    expect(early.state).toBe('held');
    expect(early.earned_at).toBe(NOW);

    const journal = (await records.list('gamificationjournal'))[0];
    expect(journal.traits.early_sleeper.earned_at).toBe(NOW);
  });

  it('renders a lapsed trait as DORMANT (never deleted) with a stated rekindle cost', async () => {
    // Earned in the past, but no recent window nights → dormant now.
    const seed = {
      gamificationjournal: [{
        recordId: 'journal', deleted: false,
        traits: { early_sleeper: { earned_at: NOW - 60 * DAY_MS } },
      }],
    };
    const { gam } = domainOver(seed);
    const res = await gam.getTraits();
    const early = res.traits.find((t) => t.id === 'early_sleeper');
    expect(early.state).toBe('dormant');
    expect(early.earned_at).toBe(NOW - 60 * DAY_MS); // durable fact survives
    expect(early.rekindle_remaining).toBe(early.rekindle); // no recent nights
    expect(early.rekindle).toBeLessThan(early.earn);       // rekindle is cheap
  });

  it('rekindles a dormant trait from a handful of recent lever-days (cheap loss-aversion)', async () => {
    // Earned long ago; only 5 recent window nights — below the 21/28 earn bar
    // but at/above the rekindle threshold → held again.
    const seed = {
      sleep: windowNights(5),
      gamificationjournal: [{
        recordId: 'journal', deleted: false,
        traits: { early_sleeper: { earned_at: NOW - 60 * DAY_MS } },
      }],
    };
    const { gam } = domainOver(seed);
    const res = await gam.getTraits();
    const early = res.traits.find((t) => t.id === 'early_sleeper');
    expect(early.state).toBe('held');
  });

  it('recovery mode pauses the dormancy clock — a sick stretch cannot demote a held trait', async () => {
    const seed = {
      gamificationjournal: [{
        recordId: 'journal', deleted: false,
        traits: { early_sleeper: { earned_at: NOW - 60 * DAY_MS } },
      }],
      gamificationmode: [{ recordId: 'mode', deleted: false, recovery: true }],
    };
    const { gam } = domainOver(seed);
    const res = await gam.getTraits();
    expect(res.recovery_paused).toBe(true);
    const early = res.traits.find((t) => t.id === 'early_sleeper');
    expect(early.state).toBe('held');
    expect(early.recovery_held).toBe(true);
  });

  it('GUARDRAIL: every trait is a lever behavior, never a gauge/outcome/body identity', () => {
    expect(TRAITS.length).toBeGreaterThan(0);
    for (const t of TRAITS) {
      expect(typeof t.lever).toBe('function'); // a behavior, not a value target
      const blob = `${t.id} ${t.title} ${t.leverLabel}`.toLowerCase();
      // No gauge/outcome/body identities (no "Weight Loser", no "Low BP").
      expect(blob).not.toMatch(/weight|loser|\bbp\b|blood pressure|systolic|heart rate|\bhr\b|kg|calorie|low bp|slim|lean/);
    }
  });
});

describe('gamification Keystones — rare, permanent milestones', () => {
  it('is empty for a fresh account (earned scarcity, never manufactured)', async () => {
    const { gam } = domainOver({});
    const res = await gam.getKeystones();
    expect(res.keystones).toEqual([]);
  });

  it('records a permanent keystone when an experiment resolves (any callable verdict)', async () => {
    // A fully-elapsed trial with a clean two-arm contrast → resolves to a
    // rewarded verdict, which appends an experiment keystone.
    const sleep = [];
    const bp = [];
    for (let offset = 7; offset <= 20; offset++) {
      const goodNight = offset % 2 === 0;
      sleep.push(sleepRec(offset, goodNight ? 450 : 360));
      bp.push(bpRec(offset, goodNight ? 118 : 145));
    }
    const seed = {
      sleep, bp,
      gamificationexperiment: [{
        recordId: 'exp-1', deleted: false,
        template_id: 'bedtime_window', status: 'active',
        started_at: NOW - 20 * DAY_MS, duration_days: 14,
      }],
    };
    const { gam } = domainOver(seed);
    await gam.listExperiments(); // triggers auto-resolve → keystone append

    const res = await gam.getKeystones();
    expect(res.keystones).toHaveLength(1);
    expect(res.keystones[0].kind).toBe('experiment');
    expect(res.keystones[0].earned_at).toBe(NOW);
  });

  it('detects a real-outcome BP-in-band keystone once (deduped, permanent)', async () => {
    // 25 mornings, all comfortably inside the default target band → a genuine
    // trend, not a lucky week (min sample 20).
    const bp = [];
    for (let offset = 1; offset <= 25; offset++) bp.push(bpRec(offset, 118));
    const { gam } = domainOver({ bp });

    const first = await gam.getKeystones();
    expect(first.keystones.some((k) => k.id === 'bp_in_target_band')).toBe(true);

    // Idempotent: a second read does not append a duplicate.
    const second = await gam.getKeystones();
    expect(second.keystones.filter((k) => k.id === 'bp_in_target_band')).toHaveLength(1);
  });

  it('does not manufacture a BP keystone from too small a sample', async () => {
    const bp = [];
    for (let offset = 1; offset <= 5; offset++) bp.push(bpRec(offset, 118));
    const { gam } = domainOver({ bp });
    const res = await gam.getKeystones();
    expect(res.keystones.some((k) => k.id === 'bp_in_target_band')).toBe(false);
  });
});

describe('gamification narrative layer — catalogs are curated', () => {
  it('exposes a small curated chapter theme library (pace/consistency only)', () => {
    expect(CHAPTER_THEMES.length).toBeGreaterThan(0);
    for (const t of CHAPTER_THEMES) {
      const blob = `${t.id} ${t.title} ${t.focus} ${t.blurb}`.toLowerCase();
      expect(blob).not.toMatch(/lose|weight|kg|calorie/); // no weight-loss theme
    }
  });
});
