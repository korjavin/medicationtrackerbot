// analysis.fitness.test.js
//
// Task 3 of the cloud composite-analysis plan (docs/plans/20260717-cloud-analysis-pathb.md):
// web/domain/analysis.js reproduces bot mode's analyze_fitness composite tool
// client-side over vault data. Expectations are hand-ported from the Go oracle
// internal/mcp/fitness_test.go (Path B runs no Go in tests).

import { describe, it, expect } from 'vitest';
import { createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';
import { createBPDomain } from '../../../domain/bp.js';
import { createVitalsDomain } from '../../../domain/vitals.js';
import { createNotesDomain } from '../../../domain/notes.js';
import { createMedicationsDomain } from '../../../domain/medications.js';
import { createIntakeDomain } from '../../../domain/medintake.js';
import { createFoodDomain } from '../../../domain/food.js';
import { createWeightDomain } from '../../../domain/weight.js';
import { createWorkoutDomain } from '../../../domain/workout.js';
import { createAnalysis } from '../../../domain/analysis.js';

const NOW = Date.parse('2026-07-17T00:00:00Z');

function build(seed) {
  const records = createInMemoryRecordsPort(seed);
  const now = () => NOW;
  const timeZone = 'UTC';
  const bp = createBPDomain({ records, now, timeZone });
  const vitals = createVitalsDomain({ records, now, timeZone });
  const notes = createNotesDomain({ records, now });
  const medications = createMedicationsDomain({
    records, now, timeZone, rxnorm: { normalize: async () => null },
  });
  const intake = createIntakeDomain({ records, now, timeZone });
  const food = createFoodDomain({ records, now, timeZone });
  const weight = createWeightDomain({ records, now, timeZone });
  const workout = createWorkoutDomain({ records, now, timeZone });
  return createAnalysis({
    bp, vitals, medications, intake, food, weight, workout, notes, now, timeZone,
  });
}

function session(id, scheduledDate, status) {
  return {
    recordId: `session-${id}`, deleted: false, id, group_id: 1, variant_id: 1,
    scheduled_date: scheduledDate, scheduled_time: '09:00', status, snooze_count: 0,
  };
}
function miband(id, startMs, extra = {}) {
  return {
    recordId: `miband-${id}`, deleted: false, id,
    activity_type: 'run', activity_name: 'Outdoor Run',
    source_start_ms: startMs, source_end_ms: startMs + 3600 * 1000, tz_offset: 0,
    duration_sec: 3600, distance_m: 6000, steps: 0, calories: 0, heart_rate_avg: 0,
    source: 'miband', ...extra,
  };
}
function foodLog(recordId, eatenAt, m) {
  return {
    recordId, deleted: false, eaten_at: eatenAt, name: m.name || 'Meal', weight: 300,
    calories: m.calories, protein: m.protein, carbs: m.carbs, fat: m.fat,
  };
}

describe('analysis.fitness', () => {
  it('aggregates every domain into the bot-shaped summary', async () => {
    const analysis = build({
      workoutsession: [
        session(1, '2026-07-10T00:00:00Z', 'completed'),
        session(2, '2026-07-12T00:00:00Z', 'skipped'),
      ],
      miband: [miband(3, Date.parse('2026-07-11T08:00:00Z'), { steps: 8000, calories: 400, heart_rate_avg: 130 })],
      daystats: [{ recordId: 'daystats-2026-07-10', deleted: false, day: '2026-07-10', steps: 8500, calories: 350, distance: 6200 }],
      foodlog: [foodLog('food-1', '2026-07-10T12:00:00Z', { calories: 450, protein: 40, carbs: 20, fat: 15 })],
      weight: [
        { recordId: 'w-old', deleted: false, measured_at: '2026-06-20T00:00:00Z', weight: 80.0 },
        { recordId: 'w-new', deleted: false, measured_at: '2026-07-05T00:00:00Z', weight: 79.5 },
      ],
      note: [{ recordId: '2000', deleted: false, content: 'felt great during workout', created_at: '2026-07-10T10:00:00Z' }],
    });

    const resp = await analysis.fitness({ from: '2026-06-01', to: '2026-07-17' });

    // Workouts: 2 manual (1 completed) + 1 mi-band (completed) → 2/3.
    expect(resp.workouts).toBeTruthy();
    expect(resp.workouts.total_sessions).toBe(3);
    expect(resp.workouts.completion_rate).toBeCloseTo(200 / 3, 5);
    expect(resp.workouts.sessions).toHaveLength(3);
    const mb = resp.workouts.sessions.find((s) => s.type === 'miband');
    expect(mb).toMatchObject({ group_name: 'Outdoor Run', status: 'completed', steps: 8000 });

    // Steps.
    expect(resp.steps.daily).toHaveLength(1);
    expect(resp.steps.avg_daily_steps).toBe(8500);

    // Nutrition (food names dropped).
    expect(resp.nutrition.daily_totals).toHaveLength(1);
    expect(resp.nutrition.avg_daily_calories).toBe(450);
    expect(resp.nutrition.avg_daily_protein).toBe(40);
    expect(resp.nutrition.daily_totals[0]).toEqual({
      date: '2026-07-10', calories: 450, protein_g: 40, carbs_g: 20, fat_g: 15,
    });
    expect('name' in resp.nutrition.daily_totals[0]).toBe(false);

    // Weight — kg-only, current newest, losing trend.
    expect(resp.weight.logs).toHaveLength(2);
    expect(resp.weight.current_kg).toBe(79.5);
    expect(resp.weight.change_kg).toBeCloseTo(-0.5, 5);
    expect(resp.weight.trend_direction).toBe('losing');
    expect('weight' in resp.weight.logs[0]).toBe(false);
    expect(resp.weight.logs[0].weight_kg).toBeTruthy();

    // Diary notes present, no unavailable → no warning.
    expect(resp.diary_notes).toHaveLength(1);
    expect(resp.period).toBe('2026-06-01 to 2026-07-17');
    expect(resp.warning).toBeUndefined();
  });

  it('sums multiple food logs for one day with no food names', async () => {
    const analysis = build({
      foodlog: [
        foodLog('f-1', '2026-07-10T09:00:00Z', { name: 'Secret Smoothie', calories: 200, protein: 10, carbs: 30, fat: 5 }),
        foodLog('f-2', '2026-07-10T19:00:00Z', { name: 'Comfort Food', calories: 600, protein: 25, carbs: 50, fat: 30 }),
      ],
    });

    const resp = await analysis.fitness({ from: '2026-07-01', to: '2026-07-17' });

    expect(resp.nutrition.daily_totals).toHaveLength(1);
    expect(resp.nutrition.daily_totals[0]).toEqual({
      date: '2026-07-10', calories: 800, protein_g: 35, carbs_g: 80, fat_g: 35,
    });
    // Averages over the single day-with-data.
    expect(resp.nutrition.avg_daily_calories).toBe(800);
    expect(resp.nutrition.avg_daily_protein).toBe(35);
  });

  it('reports insufficient_data with a single weight reading', async () => {
    const analysis = build({
      weight: [{ recordId: 'w-1', deleted: false, measured_at: '2026-07-05T00:00:00Z', weight: 79.5 }],
    });
    const resp = await analysis.fitness({ from: '2026-07-01', to: '2026-07-17' });
    expect(resp.weight.current_kg).toBe(79.5);
    expect(resp.weight.trend_direction).toBe('insufficient_data');
    expect(resp.weight.change_kg).toBeUndefined();
  });

  it('omits gated-off sections and lists them as unavailable', async () => {
    const analysis = build({
      foodlog: [foodLog('f-1', '2026-07-10T12:00:00Z', { calories: 450, protein: 40, carbs: 20, fat: 15 })],
      weight: [{ recordId: 'w-1', deleted: false, measured_at: '2026-07-05T00:00:00Z', weight: 79.5 }],
    });

    const resp = await analysis.fitness({
      from: '2026-07-01', to: '2026-07-17', features: { food: false, workout: true, weight: true },
    });

    expect(resp.nutrition).toBeUndefined();
    expect(resp.warning).toContain('nutrition (feature disabled)');
    // Workouts + steps + weight still resolve (present-but-empty workouts).
    expect(resp.workouts).toEqual({ sessions: [], total_sessions: 0, completion_rate: 0 });
    expect(resp.steps).toBeTruthy();
    expect(resp.weight).toBeTruthy();
  });
});
