// Focused integration tests for the extracted features/workout/variants.js
// sub-file. Verifies the variant edit flow uses the cross-file
// WorkoutEdit accessors (groupForVariant / editingVariantId) rather than
// the eliminated module-level globals.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/workout/variants.js — split-file integration', () => {
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

  it('exposes the WorkoutVariants public-API namespace + WorkoutEdit accessors', () => {
    const { window } = env;
    expect(window.WorkoutVariants).toBeTypeOf('object');
    expect(window.WorkoutVariants.load).toBeTypeOf('function');
    expect(window.WorkoutVariants.save).toBeTypeOf('function');
    expect(window.WorkoutVariants.openAdd).toBeTypeOf('function');
    expect(window.WorkoutVariants.close).toBeTypeOf('function');

    expect('editingVariantId' in window.WorkoutEdit).toBe(true);
    expect('groupForVariant' in window.WorkoutEdit).toBe(true);
    expect(window.WorkoutEdit.editingVariantId).toBeNull();
    expect(window.WorkoutEdit.groupForVariant).toBeNull();
  });

  it('showAddVariantModal short-circuits when no group is set', () => {
    const { window } = env;
    window.Telegram.WebApp.showAlert = vi.fn();
    window.WorkoutEdit.groupForVariant = null;
    window.WorkoutEdit.editingGroupId = null;

    window.showAddVariantModal();

    expect(window.Telegram.WebApp.showAlert).toHaveBeenCalledTimes(1);
    expect(window.Telegram.WebApp.showAlert.mock.calls[0][0])
      .toContain('Save this workout group first');
  });

  it('showAddVariantModal opens the modal when groupForVariant is set', () => {
    const { window, document } = env;
    window.WorkoutEdit.cachedGroups = [{ id: 7, name: 'PPL', is_rotating: true }];
    window.WorkoutEdit.groupForVariant = 7;

    window.showAddVariantModal();

    expect(window.WorkoutEdit.editingVariantId).toBeNull();
    expect(document.getElementById('workout-variant-modal-title').textContent).toBe('Add Variant');
    expect(document.getElementById('workout-variant-name').value).toBe('');
  });

  it('closeVariantModal clears the closure-private editingVariantId', () => {
    const { window } = env;
    window.WorkoutEdit.editingVariantId = 33;

    window.closeVariantModal();

    expect(window.WorkoutEdit.editingVariantId).toBeNull();
  });
});
