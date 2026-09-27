import { describe, it, expect } from 'vitest';
import {
  ActivitySystemPrompt,
  activitySchema,
  convertParsedActivity,
  createActivityAIDomain,
} from '../../../domain/activityai.js';

describe('activityai — convertParsedActivity', () => {
  it('keeps name and sums duration_minutes across cardio exercises', () => {
    const parsed = {
      name: 'Morning cardio',
      exercises: [
        { name: 'Cycling', duration_minutes: 20 },
        { name: 'Running', duration_minutes: 10 },
      ],
    };
    const out = convertParsedActivity(parsed);
    expect(out.name).toBe('Morning cardio');
    expect(out.durationSec).toBe(30 * 60);
  });

  it('converts stated distances to whole meters (800m + 2km + 1.5mi)', () => {
    const out = convertParsedActivity({
      name: 'Mixed cardio',
      exercises: [
        { name: 'Swim', distance: 800, distance_unit: 'm' },
        { name: 'Cycling', distance: 2, distance_unit: 'km' },
        { name: 'Run', distance: 1.5, distance_unit: 'mi' },
      ],
    });
    expect(out.distanceM).toBe(800 + 2000 + 2414);
  });

  it('converts a 5-mile run next to a metric warmup (1000m + 5mi -> 9047m)', () => {
    const out = convertParsedActivity({
      name: 'Run',
      exercises: [
        { name: 'Warmup jog', distance: 1000, distance_unit: 'm' },
        { name: 'Run', distance: 5, distance_unit: 'mi' },
      ],
    });
    expect(out.distanceM).toBe(9047);
  });

  it('accepts the colloquial "k" shorthand for kilometers (2k -> 2000m)', () => {
    const out = convertParsedActivity({
      name: 'Bike ride',
      exercises: [{ name: 'Cycling', distance: 2, distance_unit: 'k' }],
    });
    expect(out.distanceM).toBe(2000);
  });

  it('reads a bare distance with an empty unit as meters', () => {
    const out = convertParsedActivity({
      name: 'Row',
      exercises: [{ name: 'Rowing', distance: 500, distance_unit: '' }],
    });
    expect(out.distanceM).toBe(500);
  });

  it('converts US customary pool/climb units (100 yards -> 91m, 1000 ft -> 305m)', () => {
    const out = convertParsedActivity({
      name: 'Swim',
      exercises: [
        { name: 'Pool swim', distance: 100, distance_unit: 'yards' },
        { name: 'Climb', distance: 1000, distance_unit: 'ft' },
      ],
    });
    expect(out.distanceM).toBe(91 + 305);
  });

  it('treats an inherited-property unit name as unknown, never NaN', () => {
    const out = convertParsedActivity({
      name: 'Odd',
      exercises: [{ name: 'Jog', distance: 100, distance_unit: 'constructor' }],
    });
    expect(out.distanceM).toBe(0);
  });

  it('treats missing duration_minutes and distance as zero (strength exercises)', () => {
    const out = convertParsedActivity({
      name: 'Push day',
      exercises: [{ name: 'Bench press', sets: 3, reps: 8 }],
    });
    expect(out.durationSec).toBe(0);
    expect(out.distanceM).toBe(0);
  });

  it('still accepts the legacy distance_m field (old providers, cached responses)', () => {
    const out = convertParsedActivity({
      name: 'Bike ride',
      exercises: [{ name: 'Cycling', distance_m: 2000 }],
    });
    expect(out.distanceM).toBe(2000);
  });

  it('mixes legacy and new-shape exercises in one sum', () => {
    const out = convertParsedActivity({
      name: 'Mixed',
      exercises: [
        { name: 'Legacy ride', distance_m: 8047 },
        { name: 'New ride', distance: 1, distance_unit: 'km' },
      ],
    });
    expect(out.distanceM).toBe(9047);
  });

  it('prefers the new distance fields when both shapes are present', () => {
    const out = convertParsedActivity({
      name: 'Both shapes',
      exercises: [{ name: 'Ride', distance: 2, distance_unit: 'km', distance_m: 999 }],
    });
    expect(out.distanceM).toBe(2000);
  });

  it('accepts weight fields, new and legacy, without changing the reduced result', () => {
    const out = convertParsedActivity({
      name: 'Lift',
      exercises: [
        { name: 'Squat', weight: 135, weight_unit: 'lb' },
        { name: 'Bench', weight_kg: 60 },
      ],
    });
    expect(out).toEqual({ name: 'Lift', durationSec: 0, distanceM: 0 });
  });

  it('throws no_activity on nil / nameless parse', () => {
    expect(() => convertParsedActivity(null)).toThrow(/no activity/i);
    expect(() => convertParsedActivity({ exercises: [] })).toThrow(/no activity/i);
  });

  it('throws no_exercises on empty exercises', () => {
    let err;
    try {
      convertParsedActivity({ name: 'x', exercises: [] });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('no_exercises');
  });
});

describe('activityai — createActivityAIDomain', () => {
  const stub = (parsed) => ({ parseActivityFromDescription: async () => parsed });

  it('parses a description into name + summed duration + converted distance', async () => {
    const domain = createActivityAIDomain({
      aiClient: stub({ name: 'Bike ride', exercises: [{ name: 'Cycling', duration_minutes: 15, distance: 2, distance_unit: 'km' }] }),
    });
    const out = await domain.parseActivityFromDescription('2km bicycle');
    expect(out).toEqual({
      name: 'Bike ride',
      durationSec: 900,
      distanceM: 2000,
    });
  });

  it('still accepts a legacy distance_m parse from the provider', async () => {
    const domain = createActivityAIDomain({
      aiClient: stub({ name: 'Run', exercises: [{ name: 'Running', duration_minutes: 30, distance_m: 5000 }] }),
    });
    const out = await domain.parseActivityFromDescription('5k run');
    expect(out).toEqual({ name: 'Run', durationSec: 1800, distanceM: 5000 });
  });

  it('throws on empty description before any AI call', async () => {
    let called = false;
    const domain = createActivityAIDomain({
      aiClient: { parseActivityFromDescription: async () => { called = true; return {}; } },
    });
    await expect(domain.parseActivityFromDescription('   ')).rejects.toThrow(/required/i);
    expect(called).toBe(false);
  });
});

describe('activityai — schema/prompt parity', () => {
  it('exports the bot system prompt plus cloud unit-echo instructions, without model-side conversion', () => {
    expect(ActivitySystemPrompt).toContain('You are a fitness expert.');
    expect(ActivitySystemPrompt).toContain('distance_unit');
    expect(ActivitySystemPrompt).toContain('weight_unit');
    expect(ActivitySystemPrompt).toMatch(/Never convert/);
    expect(ActivitySystemPrompt).not.toContain('distance_m');
    expect(ActivitySystemPrompt).not.toContain('weight_kg');
  });

  it('exports the activity json-schema shape with cloud-only distance/weight + unit', () => {
    expect(activitySchema.required).toEqual(['name', 'exercises']);
    const item = activitySchema.properties.exercises.items;
    expect(item.properties.duration_minutes.type).toEqual(['number', 'null']);
    expect(item.properties.distance.type).toEqual(['number', 'null']);
    expect(item.properties.distance_unit.type).toBe('string');
    expect(item.properties.weight.type).toEqual(['number', 'null']);
    expect(item.properties.weight_unit.type).toBe('string');
    expect(item.required).toContain('distance');
    expect(item.required).toContain('distance_unit');
    expect(item.required).toContain('weight');
    expect(item.required).toContain('weight_unit');
    expect(item.required).not.toContain('distance_m');
    expect(item.required).not.toContain('weight_kg');
  });
});
