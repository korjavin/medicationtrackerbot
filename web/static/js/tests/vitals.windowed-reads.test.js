// vitals.windowed-reads.test.js
//
// Task 1 of the cloud composite-analysis plan (docs/plans/20260717-cloud-analysis-pathb.md):
// createVitalsDomain gained listHeart/listSpO2/listDayStats — windowed raw reads
// the composite analyses (web/domain/analysis.js) aggregate over. These assert
// the [from,to] clamp (day-batches overshoot by a padded day) and the daystats
// day-string range filter.

import { describe, it, expect } from 'vitest';
import { createVitalsDomain } from '../../../domain/vitals.js';
import { createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';

// hr/spo2 are day-batched: one record per UTC stream-day, body {day, samples:[]}.
function batch(type, day, samples) {
  return {
    recordId: `${type}-${day}`, clientTs: 0, deleted: false, day, samples,
  };
}
function sample(dateTime, value) {
  return { date_time: dateTime, tz_offset: 0, value };
}

function domain(seed) {
  const records = createInMemoryRecordsPort(seed);
  return createVitalsDomain({ records, now: () => Date.parse('2026-07-17T00:00:00Z'), timeZone: 'UTC' });
}

describe('vitals windowed reads', () => {
  it('listHeart clamps samples to the [from,to] instant window', async () => {
    const v = domain({
      hrsample: [
        batch('hrsample', '2026-07-10', [
          sample('2026-07-10T06:00:00Z', 60),
          sample('2026-07-10T23:30:00Z', 80), // inside
        ]),
        batch('hrsample', '2026-07-11', [
          sample('2026-07-11T00:30:00Z', 70), // inside
          sample('2026-07-11T12:00:00Z', 90), // after `to`
        ]),
      ],
    });
    const from = Date.parse('2026-07-10T23:00:00Z');
    const to = Date.parse('2026-07-11T06:00:00Z');
    const got = (await v.listHeart({ from, to })).map((s) => s.value).sort((a, b) => a - b);
    expect(got).toEqual([70, 80]);
  });

  it('listSpO2 reads the spo2 stream', async () => {
    const v = domain({
      spo2sample: [batch('spo2sample', '2026-07-12', [
        sample('2026-07-12T08:00:00Z', 97),
        sample('2026-07-12T09:00:00Z', 95),
      ])],
    });
    const from = Date.parse('2026-07-12T00:00:00Z');
    const to = Date.parse('2026-07-12T23:59:59Z');
    const got = (await v.listSpO2({ from, to })).map((s) => s.value);
    expect(got).toEqual([97, 95]);
  });

  // bd med-29gh.3 — overview()'s per-local-day sleep fold, windowed, so the
  // doctor brief's sleep chart plots the Vitals screen's own numbers instead
  // of a second derivation.
  it('sleepDaily sums a day\'s sessions and weights heart rate by minutes', async () => {
    const v = domain({
      sleep: [
        {
          recordId: 's-1', deleted: false, day: '2026-07-14',
          start_time: '2026-07-13T23:00:00Z', total_minutes: 300,
          deep_minutes: 60, light_minutes: 200, rem_minutes: 30, awake_minutes: 10,
          heart_rate_avg: 60,
        },
        {
          // A second session the same day: phases add, HR is minutes-weighted
          // ((300*60 + 100*80) / 400 = 65), not a flat mean of 70.
          recordId: 's-2', deleted: false, day: '2026-07-14',
          start_time: '2026-07-14T14:00:00Z', total_minutes: 100,
          deep_minutes: 20, light_minutes: 70, rem_minutes: 10, awake_minutes: 0,
          heart_rate_avg: 80,
        },
        {
          recordId: 's-3', deleted: false, day: '2026-07-16',
          start_time: '2026-07-15T23:00:00Z', total_minutes: 420,
        },
        // Outside the window on either side.
        {
          recordId: 's-0', deleted: false, day: '2026-07-10',
          start_time: '2026-07-09T23:00:00Z', total_minutes: 400,
        },
      ],
    });

    const got = await v.sleepDaily({
      from: Date.parse('2026-07-13T00:00:00Z'), to: Date.parse('2026-07-16T23:00:00Z'),
    });

    expect(got).toEqual([
      {
        date: '2026-07-14', total_mins: 400, deep_mins: 80, light_mins: 270, rem_mins: 40, awake_mins: 10, heart_rate_avg: 65,
      },
      {
        date: '2026-07-16', total_mins: 420, deep_mins: 0, light_mins: 0, rem_mins: 0, awake_mins: 0, heart_rate_avg: 0,
      },
    ]);
  });

  it('listDayStats filters by inclusive day-string range, sorted ascending', async () => {
    const v = domain({
      daystats: [
        { recordId: 'daystats-2026-07-09', deleted: false, day: '2026-07-09', steps: 100 },
        { recordId: 'daystats-2026-07-10', deleted: false, day: '2026-07-10', steps: 8000, calories: 300, distance: 5 },
        { recordId: 'daystats-2026-07-12', deleted: false, day: '2026-07-12', steps: 9000 },
        { recordId: 'daystats-2026-07-15', deleted: false, day: '2026-07-15', steps: 200 },
      ],
    });
    const got = await v.listDayStats({ from: '2026-07-10', to: '2026-07-12' });
    expect(got.map((d) => d.day)).toEqual(['2026-07-10', '2026-07-12']);
    expect(got[0]).toMatchObject({ steps: 8000, calories: 300, distance: 5 });
  });
});
