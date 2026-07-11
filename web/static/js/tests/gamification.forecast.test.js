// gamification.forecast.test.js
//
// Pure-unit suite for the Tomorrow Forecast domain evaluator (web/domain/
// gamification.js — getForecast), the Phase 3 slice. Like the Atlas suite, a
// pure-unit test is the right shape (CLAUDE.md testing posture): the domain
// layer is driven only by injected ports, so it has no integration entry point.
//
// The forecast is a fixed lever→outcome pairing: an adequate night (≥7h sleep)
// vs the same morning's first BP reading landing in range. The fixtures assert
// the personalized chance is REAL computed data, resolves against the actual
// morning, self-suppresses below the confidence gate (calibration meter fills
// instead), honors the user's own BP goal band, and never reads weight.
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
function goalRec(target) {
  return { recordId: 'bpgoal', deleted: false, target_systolic: target };
}

// planted builds `count` days where good nights (≥7h) land an in-range morning
// and short nights (<7h) land an out-of-range one — a clean, real correlation.
function planted(count, { goodSys = 118, shortSys = 145, goodMin = 450, shortMin = 360 } = {}) {
  const bp = [];
  const sleep = [];
  for (let offset = 0; offset < count; offset++) {
    const goodNight = offset % 2 === 0;
    bp.push(bpRec(offset, goodNight ? goodSys : shortSys));
    sleep.push(sleepRec(offset, goodNight ? goodMin : shortMin));
  }
  return { bp, sleep };
}

describe('gamification Tomorrow Forecast — evaluator', () => {
  it('quotes a personalized in-range-morning chance once above the gate', async () => {
    // 20 days → 10 good + 10 short nights, well past the 8-per-arm gate. Good
    // nights are in range 100% of the time; short nights 0%.
    const { gam } = domainOver(planted(20));
    const f = await gam.getForecast();

    expect(f.enabled).toBe(true);
    expect(f.evening.state).toBe('ready');
    expect(f.evening.goodShare).toBe(100);
    expect(f.evening.otherShare).toBe(0);
    expect(f.evening.text).toContain('in range 100%');
    expect(f.band.source).toBe('default');
    expect(f.band.max).toBe(130);
  });

  it('resolves this morning against the model’s call', async () => {
    // offset 0 (today) is an even day → good night, morning 118 (in range).
    // The good-night arm predicts in-range → the resolution matches.
    const { gam } = domainOver(planted(20));
    const f = await gam.getForecast();

    expect(f.resolution).not.toBeNull();
    expect(f.resolution.day).toBe(dayAt(0));
    expect(f.resolution.systolic).toBe(118);
    expect(f.resolution.inRange).toBe(true);
    expect(f.resolution.matched).toBe(true);
    expect(f.resolution.text).toMatch(/agreed/i);
  });

  it('self-suppresses below the gate — no number, calibration meter fills instead', async () => {
    // Only 3 good + 3 short nights → below the 8-per-arm gate.
    const { gam } = domainOver(planted(6));
    const f = await gam.getForecast();

    expect(f.evening.state).toBe('insufficient');
    expect(f.evening).not.toHaveProperty('goodShare');
    expect(f.resolution).toBeNull();

    expect(f.calibration.state).toBe('learning');
    expect(f.calibration.have).toBe(3);
    expect(f.calibration.needed).toBe(8);
    expect(f.calibration.fraction).toBeCloseTo(3 / 8);
    expect(f.calibration.label).toMatch(/of 8 paired nights/i);
  });

  it('reports the trailing hit-rate as the calibration meter when calibrated', async () => {
    const { gam } = domainOver(planted(20));
    const f = await gam.getForecast();

    expect(f.calibration.state).toBe('calibrated');
    expect(f.calibration.n).toBe(20);
    expect(f.calibration.hitRate).toBe(100); // model’s majority call held every day
    expect(f.calibration.fraction).toBeCloseTo(1);
  });

  it('honors the user’s own BP goal band (personalized, not a black box)', async () => {
    // Short nights read 128 — under the 130 default, but OVER a 120 goal. With
    // the goal band, those mornings are out of range and the effect appears;
    // proving the band comes from the user’s data, not a constant.
    const { gam } = domainOver({ ...planted(20, { shortSys: 128 }), bpgoal: [goalRec(120)] });
    const f = await gam.getForecast();

    expect(f.band.source).toBe('goal');
    expect(f.band.max).toBe(120);
    expect(f.evening.goodShare).toBe(100); // 118 ≤ 120
    expect(f.evening.otherShare).toBe(0); // 128 > 120
  });

  it('never reads weight records', async () => {
    const seed = {
      ...planted(20),
      weight: [{ recordId: 'w-0', deleted: false, measured_at: isoAt(0), weight: 80 }],
    };
    const records = createInMemoryRecordsPort(seed);
    const listed = new Set();
    const tracking = { ...records, list: (t) => { listed.add(t); return records.list(t); } };
    const gam = createGamificationDomain({ records: tracking, now: () => NOW, timeZone: TZ });

    const f = await gam.getForecast();
    expect(f.evening.state).toBe('ready'); // still computes from bp + sleep
    expect(listed.has('weight')).toBe(false);
  });
});
