import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');

function loadTodayEnv() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://example.test/',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  const { window } = dom;
  const src = fs.readFileSync(TODAY_JS, 'utf8');
  window.eval(`${src}\n//# sourceURL=file://${TODAY_JS}`);
  return {
    window,
    aggregate: window.TodayDashboard.aggregateToday,
    cleanup: () => dom.window.close()
  };
}

function isoDaysAgo(now, days) {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function fullBootstrap(now) {
  return {
    features: {
      medication: true,
      bp: true,
      weight: true,
      food: true,
      workout: true,
      health: true
    },
    next_intake: {
      scheduled_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
      medication_names: ['Aspirin']
    },
    bp: {
      readings: [
        { measured_at: isoDaysAgo(now, 6), systolic: 132, diastolic: 88 },
        { measured_at: isoDaysAgo(now, 3), systolic: 128, diastolic: 84 },
        { measured_at: isoDaysAgo(now, 1), systolic: 122, diastolic: 80 }
      ],
      goal: null,
      stats: null
    },
    weight: {
      logs: [
        { measured_at: isoDaysAgo(now, 6), weight: 82.4 },
        { measured_at: isoDaysAgo(now, 1), weight: 81.6 }
      ],
      goal: null
    },
    settings: {
      food_targets: { calories: 2200, carbs: 250, protein: 150, fat: 70 },
      timezone: 'Europe/Berlin',
      tab_order: null
    }
  };
}

function fullSWRCaches() {
  return {
    food_today: {
      groups: [
        { calories: 500, carbs: 60, protein: 20, fat: 15 },
        { calories: 700, carbs: 80, protein: 35, fat: 20 }
      ]
    },
    workout_next: {
      session: {
        scheduled_date: '2026-04-20T00:00:00Z',
        scheduled_time: '18:30',
        group_name: 'Push day',
        status: 'pending',
        is_today: false
      }
    },
    health_overview: {
      sleep_stats_7d: [
        { day: '2026-04-18', total_minutes: 430 },
        { day: '2026-04-19', total_minutes: 465 }
      ],
      average_sleep_hours_7d: 7.2,
      average_sleep_hours_30d: 7.5
    }
  };
}

describe('TodayDashboard.aggregateToday', () => {
  let env;

  beforeEach(() => {
    env = loadTodayEnv();
  });

  it('returns ok-state fields when all bootstrap + SWR caches are populated', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    const result = env.aggregate(fullBootstrap(now), fullSWRCaches(), now);

    expect(result.greeting).toEqual({
      value: expect.stringMatching(/Good (morning|afternoon|evening|night)/),
      deeplink: null,
      status: 'ok'
    });

    expect(result.nextMed.status).toBe('ok');
    expect(result.nextMed.deeplink).toBe('meds');
    expect(result.nextMed.value.names).toEqual(['Aspirin']);

    expect(result.bpLatest.status).toBe('ok');
    expect(result.bpLatest.value.systolic).toBe(122);
    expect(result.bpLatest.value.diastolic).toBe(80);

    expect(result.bpTrend7d.status).toBe('ok');
    expect(result.bpTrend7d.value.systolicDirection).toBe('down');
    expect(result.bpTrend7d.value.systolicDelta).toBe(-10);
    expect(result.bpTrend7d.value.diastolicDirection).toBe('down');

    expect(result.weightLatest.status).toBe('ok');
    expect(result.weightLatest.value.weight).toBe(81.6);

    expect(result.weightTrend7d.status).toBe('ok');
    expect(result.weightTrend7d.value.direction).toBe('down');
    expect(result.weightTrend7d.value.delta).toBe(-0.8);

    expect(result.caloriesToday.status).toBe('ok');
    expect(result.caloriesToday.value).toBe(1200);
    expect(result.caloriesTarget.status).toBe('ok');
    expect(result.caloriesTarget.value).toBe(2200);

    expect(result.nextWorkout.status).toBe('ok');
    expect(result.nextWorkout.value.group_name).toBe('Push day');

    expect(result.sleepLastNight.status).toBe('ok');
    expect(result.sleepLastNight.value.hours).toBeCloseTo(7.8, 1);
  });

  it('returns missing status when bootstrap is empty and SWR caches are absent', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    const result = env.aggregate({ features: {} }, {}, now);

    expect(result.nextMed.status).toBe('missing');
    expect(result.bpLatest.status).toBe('missing');
    expect(result.bpTrend7d.status).toBe('missing');
    expect(result.weightLatest.status).toBe('missing');
    expect(result.weightTrend7d.status).toBe('missing');
    expect(result.caloriesToday.status).toBe('missing');
    expect(result.caloriesTarget.status).toBe('missing');
    expect(result.nextWorkout.status).toBe('missing');
    expect(result.sleepLastNight.status).toBe('missing');
  });

  it('handles partial data: BP present but no weight or food caches', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    const bootstrap = fullBootstrap(now);
    bootstrap.weight = { logs: [], goal: null };
    bootstrap.next_intake = null;

    const result = env.aggregate(bootstrap, null, now);

    expect(result.bpLatest.status).toBe('ok');
    expect(result.nextMed.status).toBe('missing');
    expect(result.weightLatest.status).toBe('missing');
    expect(result.weightTrend7d.status).toBe('missing');
    expect(result.caloriesToday.status).toBe('missing');
    expect(result.nextWorkout.status).toBe('missing');
    expect(result.sleepLastNight.status).toBe('missing');
  });

  it('marks overdue when next_intake is past the grace window', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    const bootstrap = fullBootstrap(now);
    bootstrap.next_intake.scheduled_at = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

    const result = env.aggregate(bootstrap, fullSWRCaches(), now);
    expect(result.nextMed.status).toBe('overdue');
  });

  it('returns missing trend when fewer than 2 points exist in the 7-day window', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    const bootstrap = fullBootstrap(now);
    bootstrap.bp.readings = [
      { measured_at: isoDaysAgo(now, 1), systolic: 120, diastolic: 80 }
    ];
    bootstrap.weight.logs = [
      { measured_at: isoDaysAgo(now, 20), weight: 80.0 }
    ];

    const result = env.aggregate(bootstrap, fullSWRCaches(), now);
    expect(result.bpTrend7d.status).toBe('missing');
    expect(result.weightTrend7d.status).toBe('missing');
  });

  it('marks cards disabled when the feature flag is false', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    const bootstrap = fullBootstrap(now);
    bootstrap.features = {
      medication: false,
      bp: false,
      weight: false,
      food: false,
      workout: false,
      health: false
    };

    const result = env.aggregate(bootstrap, fullSWRCaches(), now);
    expect(result.nextMed.status).toBe('disabled');
    expect(result.bpLatest.status).toBe('disabled');
    expect(result.bpTrend7d.status).toBe('disabled');
    expect(result.weightLatest.status).toBe('disabled');
    expect(result.weightTrend7d.status).toBe('disabled');
    expect(result.caloriesToday.status).toBe('disabled');
    expect(result.caloriesTarget.status).toBe('disabled');
    expect(result.nextWorkout.status).toBe('disabled');
    expect(result.sleepLastNight.status).toBe('disabled');
  });

  it('flags bpLatest as stale when the most recent reading is older than the freshness window', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    const bootstrap = fullBootstrap(now);
    bootstrap.bp.readings = [
      { measured_at: isoDaysAgo(now, 2), systolic: 130, diastolic: 85 },
      { measured_at: isoDaysAgo(now, 4), systolic: 135, diastolic: 88 }
    ];

    const result = env.aggregate(bootstrap, fullSWRCaches(), now);
    // 2 days old > 24h — expect 'stale'
    expect(result.bpLatest.status).toBe('stale');
  });

  it('greeting varies by hour of day', () => {
    const bootstrap = { features: {} };

    const morning = env.aggregate(bootstrap, null, new Date('2026-04-19T08:00:00'));
    expect(morning.greeting.value).toBe('Good morning');

    const afternoon = env.aggregate(bootstrap, null, new Date('2026-04-19T14:00:00'));
    expect(afternoon.greeting.value).toBe('Good afternoon');

    const evening = env.aggregate(bootstrap, null, new Date('2026-04-19T20:00:00'));
    expect(evening.greeting.value).toBe('Good evening');

    const night = env.aggregate(bootstrap, null, new Date('2026-04-19T02:00:00'));
    expect(night.greeting.value).toBe('Good night');
  });

  it('returns 0 calories when food feature is enabled but no entries today', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    const bootstrap = fullBootstrap(now);
    const caches = fullSWRCaches();
    caches.food_today = { groups: [] };

    const result = env.aggregate(bootstrap, caches, now);
    expect(result.caloriesToday.status).toBe('missing');
    expect(result.caloriesToday.value).toBe(0);
  });

  it('does not set __firstRun on aggregate regardless of input shape (caller decides)', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    // Bootstrap-missing shape: aggregate should not infer firstRun from the data.
    // The decision is made by the caller based on whether any cache entry loaded.
    expect(env.aggregate(null, null, now).__firstRun).toBeUndefined();
    expect(env.aggregate({ features: {} }, {}, now).__firstRun).toBeUndefined();
    const empty = env.aggregate({ features: {}, bp: { readings: [] }, weight: { logs: [] } }, {}, now);
    expect(empty.__firstRun).toBeUndefined();
    const withBP = env.aggregate(
      { features: {}, bp: { readings: [{ systolic: 120, diastolic: 80, measured_at: '2026-04-19T08:00:00Z' }] } },
      {},
      now
    );
    expect(withBP.__firstRun).toBeUndefined();
  });

  it('flags weightLatest as stale when the most recent log is older than one week', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    const bootstrap = fullBootstrap(now);
    bootstrap.weight.logs = [
      { measured_at: isoDaysAgo(now, 10), weight: 80.0 }
    ];
    const result = env.aggregate(bootstrap, fullSWRCaches(), now);
    expect(result.weightLatest.status).toBe('stale');
  });

  it('keeps weightLatest ok when the most recent log is within the stale window', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    const bootstrap = fullBootstrap(now);
    bootstrap.weight.logs = [
      { measured_at: isoDaysAgo(now, 3), weight: 80.0 }
    ];
    const result = env.aggregate(bootstrap, fullSWRCaches(), now);
    expect(result.weightLatest.status).toBe('ok');
  });

  it('reads real API sleep field total_mins (not just total_minutes)', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    const caches = {
      health_overview: {
        sleep_stats_7d: [
          { date: '2026-04-18', total_mins: 450 }
        ]
      }
    };
    const result = env.aggregate({ features: { health: true } }, caches, now);
    expect(result.sleepLastNight.status).toBe('ok');
    expect(result.sleepLastNight.value.hours).toBe(7.5);
    expect(result.sleepLastNight.value.day).toBe('2026-04-18');
  });

  it('flags sleepLastNight as stale when the most recent entry is older than ~2 days', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    const staleDay = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const caches = {
      health_overview: {
        sleep_stats_7d: [{ date: staleDay, total_mins: 420 }]
      }
    };
    const result = env.aggregate({ features: { health: true } }, caches, now);
    expect(result.sleepLastNight.status).toBe('stale');
  });

  it('reads workout group_name from the top level of the workout_next cache (real API shape)', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    const caches = {
      workout_next: {
        session: {
          scheduled_date: '2026-04-20T00:00:00Z',
          scheduled_time: '09:00',
          status: 'pending',
          is_today: false
        },
        group_name: 'Push day'
      }
    };
    const result = env.aggregate({ features: { workout: true } }, caches, now);
    expect(result.nextWorkout.status).toBe('ok');
    expect(result.nextWorkout.value.group_name).toBe('Push day');
  });

  it('reports flat trend when the delta falls inside the epsilon band', () => {
    const now = new Date('2026-04-19T09:00:00Z');
    const bootstrap = fullBootstrap(now);
    bootstrap.weight.logs = [
      { measured_at: isoDaysAgo(now, 6), weight: 80.0 },
      { measured_at: isoDaysAgo(now, 1), weight: 80.1 }
    ];
    const result = env.aggregate(bootstrap, fullSWRCaches(), now);
    expect(result.weightTrend7d.status).toBe('ok');
    expect(result.weightTrend7d.value.direction).toBe('flat');
  });
});
