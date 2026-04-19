/**
 * Single-active invariant for the top-level view group.
 *
 * After the Today-as-primary-nav rework there is no tab strip; switchTab()
 * activates exactly one `.view` element at a time. This test guards that
 * invariant and keeps coverage on the sub-tab (delegated click) path.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Top-level view switching', () => {
  it('switching to a tab activates exactly one .view', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.loadBPReadings = vi.fn();

      window.switchTab('bp');

      const active = document.querySelectorAll('.view.active');
      expect(active.length).toBe(1);
      expect(active[0].id).toBe('bp-view');
    } finally {
      cleanup();
    }
  });

  it('switching between tabs keeps exactly one .view active', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.loadBPReadings = vi.fn();
      window.loadWeightLogs = vi.fn();

      window.switchTab('bp');
      window.switchTab('weight');

      const active = document.querySelectorAll('.view.active');
      expect(active.length).toBe(1);
      expect(active[0].id).toBe('weight-view');
    } finally {
      cleanup();
    }
  });

  it('one click on a med sub-tab invokes its loader exactly once', () => {
    const { document, window, cleanup } = loadFrontendEnv();
    try {
      const loadMedsSpy = vi.fn();
      window.loadMeds = loadMedsSpy;

      document.querySelector('.med-tab[data-tab="schedule"]').click();

      expect(loadMedsSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});
