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

  it('sums distance_m across exercises (2km bicycle -> 2000m)', () => {
    const out = convertParsedActivity({
      name: 'Bike ride',
      exercises: [{ name: 'Cycling', distance_m: 2000 }],
    });
    expect(out.distanceM).toBe(2000);
  });

  it('carries a mile-derived distance in meters (5 mi -> ~8047m)', () => {
    const out = convertParsedActivity({
      name: 'Run',
      exercises: [
        { name: 'Warmup jog', distance_m: 1000 },
        { name: 'Run', distance_m: 8047 },
      ],
    });
    expect(out.distanceM).toBe(9047);
  });

  it('treats missing duration_minutes and distance_m as zero (strength exercises)', () => {
    const out = convertParsedActivity({
      name: 'Push day',
      exercises: [{ name: 'Bench press', sets: 3, reps: 8 }],
    });
    expect(out.durationSec).toBe(0);
    expect(out.distanceM).toBe(0);
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

  it('parses a description into name + summed duration', async () => {
    const domain = createActivityAIDomain({
      aiClient: stub({ name: 'Bike ride', exercises: [{ name: 'Cycling', duration_minutes: 15, distance_m: 2000 }] }),
    });
    const out = await domain.parseActivityFromDescription('2km bicycle');
    expect(out).toEqual({
      name: 'Bike ride',
      durationSec: 900,
      distanceM: 2000,
    });
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
  it('exports the bot system prompt plus the cloud distance instruction', () => {
    expect(ActivitySystemPrompt).toContain('You are a fitness expert.');
    expect(ActivitySystemPrompt).toContain('distance_m');
    expect(ActivitySystemPrompt).toMatch(/METERS/);
  });

  it('exports the activity json-schema shape with cloud-only distance_m', () => {
    expect(activitySchema.required).toEqual(['name', 'exercises']);
    const item = activitySchema.properties.exercises.items;
    expect(item.properties.duration_minutes.type).toEqual(['number', 'null']);
    expect(item.properties.distance_m.type).toEqual(['number', 'null']);
    expect(item.required).toContain('distance_m');
  });
});
