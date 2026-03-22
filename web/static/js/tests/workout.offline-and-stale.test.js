import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

describe('workout.js offline write routing and stale indicators', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('loadNextWorkout onCached calls showStaleIndicator when meta is available', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const container = document.getElementById('next-workout-card');
      const cachedAt = Date.now() - 3600000; // 1 hour ago
      const cachedData = {
        session: { id: 1, status: 'notified', scheduled_date: new Date().toISOString(), scheduled_time: '09:00' },
        group_name: 'Push', variant_name: 'A', exercises_count: 4, variant_id: 1, group_id: 1
      };

      const showStaleSpy = vi.fn();
      window.showStaleIndicator = showStaleSpy;

      window.DataStore.loadSWR = vi.fn(async (options) => {
        window.DataStore.getCachedMeta = vi.fn().mockResolvedValue({ cachedAt });
        await options.onCached(cachedData);
      });

      await window.loadNextWorkout();

      expect(showStaleSpy).toHaveBeenCalledWith(container, cachedAt);
    } finally {
      cleanup();
    }
  });

  it('loadNextWorkout onFresh calls hideStaleIndicator', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const container = document.getElementById('next-workout-card');
      const freshData = {
        session: { id: 2, status: 'scheduled', scheduled_date: new Date().toISOString(), scheduled_time: '10:00' },
        group_name: 'Pull', variant_name: 'B', exercises_count: 5, variant_id: 2, group_id: 2
      };

      const hideStaleSpy = vi.fn();
      window.hideStaleIndicator = hideStaleSpy;

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(freshData);
      });

      await window.loadNextWorkout();

      expect(hideStaleSpy).toHaveBeenCalledWith(container);
    } finally {
      cleanup();
    }
  });

  it('loadNextWorkout onCached does not call showStaleIndicator when no meta', async () => {
    const { window, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const showStaleSpy = vi.fn();
      window.showStaleIndicator = showStaleSpy;

      window.DataStore.loadSWR = vi.fn(async (options) => {
        window.DataStore.getCachedMeta = vi.fn().mockResolvedValue(null);
        await options.onCached({ session: { id: 3, status: 'scheduled', scheduled_date: new Date().toISOString(), scheduled_time: '08:00' } });
      });

      await window.loadNextWorkout();

      expect(showStaleSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('loadWorkoutGroups onCached shows stale indicator and onFresh hides it', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const container = document.getElementById('workout-groups-list');
      const cachedAt = Date.now() - 7200000;
      const cachedGroups = [{ id: 1, name: 'Strength', description: '', is_rotating: false, days_of_week: '[]', scheduled_time: '08:00', notification_advance_minutes: 15, active: true }];

      const showStaleSpy = vi.fn();
      const hideStaleSpy = vi.fn();
      window.showStaleIndicator = showStaleSpy;
      window.hideStaleIndicator = hideStaleSpy;

      // Test onCached
      window.DataStore.loadSWR = vi.fn(async (options) => {
        window.DataStore.getCachedMeta = vi.fn().mockResolvedValue({ cachedAt });
        await options.onCached(cachedGroups);
      });
      await window.loadWorkoutGroups();
      expect(showStaleSpy).toHaveBeenCalledWith(container, cachedAt);

      // Test onFresh
      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(cachedGroups);
      });
      await window.loadWorkoutGroups();
      expect(hideStaleSpy).toHaveBeenCalledWith(container);
    } finally {
      cleanup();
    }
  });

  it('loadWorkoutStatsTab onCached shows stale indicator and onFresh hides it', async () => {
    const { window, document, cleanup } = loadFrontendEnv({ withWorkout: true });

    try {
      const container = document.getElementById('workout-stats-display');
      const cachedAt = Date.now() - 1800000;
      const statsData = { active_weeks: 3, completion_rate: 75, completed_sessions: 6, skipped_sessions: 2, total_sessions: 8, top_exercises: [], weekly_activity: [] };

      const showStaleSpy = vi.fn();
      const hideStaleSpy = vi.fn();
      window.showStaleIndicator = showStaleSpy;
      window.hideStaleIndicator = hideStaleSpy;

      // Test onCached
      window.DataStore.loadSWR = vi.fn(async (options) => {
        window.DataStore.getCachedMeta = vi.fn().mockResolvedValue({ cachedAt });
        await options.onCached(statsData);
      });
      await window.loadWorkoutStatsTab();
      expect(showStaleSpy).toHaveBeenCalledWith(container, cachedAt);

      // Test onFresh
      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(statsData);
      });
      await window.loadWorkoutStatsTab();
      expect(hideStaleSpy).toHaveBeenCalledWith(container);
    } finally {
      cleanup();
    }
  });
});
