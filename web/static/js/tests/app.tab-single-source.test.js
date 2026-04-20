/**
 * Single-active invariant for the top-level view group.
 *
 * After the Wandergeek bottom-nav rework the canonical lateral nav is
 * `.wg-bottom-nav`; switchTab() still activates exactly one `.view` at a
 * time and, when the nav is mounted, exactly one `.wg-nav-item--active`.
 * This file guards both invariants and keeps coverage on the sub-tab
 * (delegated click) path.
 *
 * The nav is fixed-order (no drag-to-reorder); reorderability tests were
 * intentionally removed.
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

  it('switchTab notifies a registered AppKernel module so the bottom nav can update', () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      window.loadBPReadings = vi.fn();
      const onTabSwitch = vi.fn();
      window.AppKernel.register('probe', { onTabSwitch });

      window.switchTab('bp');

      expect(onTabSwitch).toHaveBeenCalledWith('bp');
    } finally {
      cleanup();
    }
  });

  it('a mounted bottom nav ends up with exactly one .wg-nav-item--active after switchTab', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.loadBPReadings = vi.fn();
      window.loadWeightLogs = vi.fn();

      const host = document.getElementById('app');
      const ctrl = window.WGBottomNav.mount(host, { active: 'today' });
      window.AppKernel.register('nav', {
        onTabSwitch(tab) { ctrl.setActive(tab); },
      });

      window.switchTab('bp');
      let actives = document.querySelectorAll('.wg-nav-item--active');
      expect(actives.length).toBe(1);
      expect(actives[0].dataset.navId).toBe('bp');

      window.switchTab('weight');
      actives = document.querySelectorAll('.wg-nav-item--active');
      expect(actives.length).toBe(1);
      expect(actives[0].dataset.navId).toBe('weight');
    } finally {
      cleanup();
    }
  });

  it('bottom nav with the default 8 items lays out as 2 rows of 4 cols', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const host = document.getElementById('app');
      window.WGBottomNav.mount(host, { items: window.WGBottomNav.DEFAULT_ITEMS });

      const inner = document.querySelector('.wg-bottom-nav__inner');
      expect(inner).not.toBeNull();
      expect(inner.style.getPropertyValue('--wg-nav-cols')).toBe('4');
      expect(inner.children.length).toBe(8);
    } finally {
      cleanup();
    }
  });
});
