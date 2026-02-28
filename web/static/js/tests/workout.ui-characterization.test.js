import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('workout.js UI characterization', () => {
  it('switchWorkoutTab toggles classes and calls corresponding loaders', () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });
    try {
      const loadGroupsSpy = vi.fn();
      const loadNextSpy = vi.fn();
      const loadHistorySpy = vi.fn();
      const loadStatsSpy = vi.fn();

      window.loadWorkoutGroups = loadGroupsSpy;
      window.loadNextWorkout = loadNextSpy;
      window.loadWorkoutHistoryTab = loadHistorySpy;
      window.loadWorkoutStatsTab = loadStatsSpy;

      window.switchWorkoutTab('groups');
      expect(document.querySelector('.workout-tab[data-tab="groups"]').classList.contains('active')).toBe(true);
      expect(document.getElementById('workout-groups-tab').classList.contains('active')).toBe(true);
      expect(loadGroupsSpy).toHaveBeenCalledTimes(1);

      window.switchWorkoutTab('history');
      expect(loadNextSpy).toHaveBeenCalledTimes(1);
      expect(loadHistorySpy).toHaveBeenCalledTimes(1);

      window.switchWorkoutTab('stats');
      expect(loadStatsSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('workout tab click binding switches subtab and triggers loader', () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });
    try {
      const loadStatsSpy = vi.fn();
      window.loadWorkoutStatsTab = loadStatsSpy;

      const statsTab = document.querySelector('.workout-tab[data-tab="stats"]');
      statsTab.click();

      expect(statsTab.classList.contains('active')).toBe(true);
      expect(document.getElementById('workout-stats-tab').classList.contains('active')).toBe(true);
      expect(loadStatsSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('opens and closes workout group modal using shared overlay', () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });
    try {
      const overlay = document.getElementById('modal-overlay');
      const modal = document.getElementById('workout-group-modal');

      expect(overlay.classList.contains('hidden')).toBe(true);
      expect(modal.classList.contains('hidden')).toBe(true);

      window.showAddWorkoutGroupModal();

      expect(overlay.classList.contains('hidden')).toBe(false);
      expect(modal.classList.contains('hidden')).toBe(false);

      window.closeWorkoutGroupModal();

      expect(overlay.classList.contains('hidden')).toBe(true);
      expect(modal.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });
});
