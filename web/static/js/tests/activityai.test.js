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

  it('treats missing duration_minutes as zero (strength exercises)', () => {
    const out = convertParsedActivity({
      name: 'Push day',
      exercises: [{ name: 'Bench press', sets: 3, reps: 8 }],
    });
    expect(out.durationSec).toBe(0);
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
      aiClient: stub({ name: 'Bike ride', exercises: [{ name: 'Cycling', duration_minutes: 15 }] }),
    });
    const out = await domain.parseActivityFromDescription('2km bicycle');
    expect(out).toEqual({
      name: 'Bike ride',
      durationSec: 900,
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
  it('exports the verbatim bot system prompt', () => {
    expect(ActivitySystemPrompt).toContain('You are a fitness expert.');
    expect(ActivitySystemPrompt).toContain('Respond ONLY with the requested JSON schema.');
  });

  it('exports the activity json-schema shape', () => {
    expect(activitySchema.required).toEqual(['name', 'exercises']);
    expect(activitySchema.properties.exercises.items.properties.duration_minutes.type)
      .toEqual(['number', 'null']);
  });
});
