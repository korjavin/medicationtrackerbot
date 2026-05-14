// Focused integration tests for the extracted features/workout/next-card.js
// sub-file. Covers the WorkoutNextCard public-API surface plus the
// shared rotation-slot utilities consumed by sibling files.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/workout/next-card.js — split-file integration', () => {
  let env;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    env = loadFrontendEnv({ withWorkout: true });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
    env.cleanup();
    env = null;
  });

  it('exposes the WorkoutNextCard public-API namespace', () => {
    const { window } = env;
    expect(window.WorkoutNextCard).toBeTypeOf('object');
    expect(window.WorkoutNextCard.load).toBeTypeOf('function');
    expect(window.WorkoutNextCard.renderToday).toBeTypeOf('function');
    expect(window.WorkoutNextCard.openEdit).toBeTypeOf('function');
    expect(window.WorkoutNextCard.nextVariant).toBeTypeOf('function');
  });

  it('getRotationSlot classifies variant names into PUSH/PULL/LEGS/REST/AD-HOC', () => {
    const { window } = env;
    expect(window.getRotationSlot('Push Day')).toBe('PUSH');
    expect(window.getRotationSlot('Pull Workout')).toBe('PULL');
    expect(window.getRotationSlot('Leg Day')).toBe('LEGS');
    expect(window.getRotationSlot('Legs')).toBe('LEGS');
    expect(window.getRotationSlot('Rest Day')).toBe('REST');
    expect(window.getRotationSlot('')).toBe('AD-HOC');
    expect(window.getRotationSlot(null)).toBe('AD-HOC');
    expect(window.getRotationSlot('Unknown')).toBe('AD-HOC');
  });

  it('renderTodaysWorkoutCard renders rest state when no rotation session is provided', () => {
    const { window } = env;
    const onAdhoc = vi.fn();
    const card = window.WorkoutNextCard.renderToday(null, [], { onAdhoc });

    expect(card).toBeTruthy();
    expect(card.dataset.state).toBe('rest');
    expect(card.textContent).toContain('Rest day');

    const adhocBtn = card.querySelector('.wg-workouts-today-card__adhoc');
    expect(adhocBtn).toBeTruthy();
    adhocBtn.click();
    expect(onAdhoc).toHaveBeenCalledTimes(1);
  });

  it('renderTodaysWorkoutCard renders completed state when todaySessions has a completed entry', () => {
    const { window } = env;
    const rotation = { variant_name: 'Push', group_name: 'PPL', session: { id: 1 }, exercises_count: 5 };
    const todaySessions = [{ status: 'completed', duration_minutes: 45 }];

    const card = window.WorkoutNextCard.renderToday(rotation, todaySessions, {});

    expect(card.dataset.state).toBe('completed');
    expect(card.textContent).toContain('Completed');
    expect(card.textContent).toContain('PPL');
  });

  it('renderTodaysWorkoutCard renders today state and wires Start button to onStart', () => {
    const { window } = env;
    const onStart = vi.fn();
    const rotation = {
      variant_name: 'Push',
      group_name: 'PPL',
      session: { id: 42 },
      exercises_count: 3,
      exercises: [{ name: 'Bench' }, { name: 'Press' }]
    };

    const card = window.WorkoutNextCard.renderToday(rotation, [], { onStart });

    expect(card.dataset.state).toBe('today');
    expect(card.textContent).toContain('Today');

    const startBtn = card.querySelector('.wg-workouts-today-card__start');
    expect(startBtn).toBeTruthy();
    startBtn.click();
    expect(onStart).toHaveBeenCalledWith(42);
  });
});
