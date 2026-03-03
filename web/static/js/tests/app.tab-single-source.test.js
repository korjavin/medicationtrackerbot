/**
 * PR3 – Single Event Source for Tabs
 *
 * Confirms that the tab system has exactly one event handler per tab group
 * so that one user click triggers exactly one handler invocation.
 *
 * The implementation uses a single delegated 'click' listener on the #tabs
 * container (via bindTabGroup) with a data-tabBound guard that prevents
 * accidental double-wiring.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('PR3 – Single event source for tab switching', () => {
  it('one click on a main tab invokes its loader exactly once', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const loadBPSpy = vi.fn();
      window.loadBPReadings = loadBPSpy;

      document.querySelector('.tab[data-tab="bp"]').click();

      expect(loadBPSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('two sequential clicks on different main tabs each fire their loader once', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const loadBPSpy = vi.fn();
      const loadWeightSpy = vi.fn();
      window.loadBPReadings = loadBPSpy;
      window.loadWeightLogs = loadWeightSpy;

      document.querySelector('.tab[data-tab="bp"]').click();
      document.querySelector('.tab[data-tab="weight"]').click();

      expect(loadBPSpy).toHaveBeenCalledTimes(1);
      expect(loadWeightSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('bindTabGroup data-tabBound guard prevents the container from being wired twice', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const loadSettingsSpy = vi.fn();
      window.loadSettings = loadSettingsSpy;

      const tabsContainer = document.getElementById('tabs');

      // Simulate a second call to bindTabGroup on the same container
      window.bindTabGroup({
        container: tabsContainer,
        buttonSelector: '.tab',
        onTabSelect: window.switchTab
      });

      // Click should still fire exactly once (guard prevented double registration)
      document.querySelector('.tab[data-tab="settings"]').click();
      expect(loadSettingsSpy).toHaveBeenCalledTimes(1);
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
