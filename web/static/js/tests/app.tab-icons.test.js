/**
 * Tab icon structure — each .tab button must expose both stroke and fill
 * SVG variants so the CSS can toggle between them for active/inactive state.
 */
import { describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Tab icon stroke/fill variants', () => {
  it('every .tab button contains exactly one .tab-icon-stroke and one .tab-icon-fill', () => {
    const { document, cleanup } = loadFrontendEnv();
    try {
      const tabs = document.querySelectorAll('#tabs .tab');
      expect(tabs.length).toBeGreaterThan(0);
      tabs.forEach((tab) => {
        const strokes = tab.querySelectorAll('.tab-icon-stroke');
        const fills = tab.querySelectorAll('.tab-icon-fill');
        expect(strokes.length).toBe(1);
        expect(fills.length).toBe(1);
      });
    } finally {
      cleanup();
    }
  });

  it('#tabs contains only .tab buttons — no orphan icons between them', () => {
    const { document, cleanup } = loadFrontendEnv();
    try {
      const tabsRoot = document.getElementById('tabs');
      const tabButtons = tabsRoot.querySelectorAll(':scope > .tab');
      expect(tabsRoot.children.length).toBe(tabButtons.length);
      const totalStrokes = tabsRoot.querySelectorAll('.tab-icon-stroke').length;
      const totalFills = tabsRoot.querySelectorAll('.tab-icon-fill').length;
      expect(totalStrokes).toBe(tabButtons.length);
      expect(totalFills).toBe(tabButtons.length);
    } finally {
      cleanup();
    }
  });

  it('every .tab button carries an aria-label', () => {
    const { document, cleanup } = loadFrontendEnv();
    try {
      const tabs = document.querySelectorAll('#tabs .tab');
      tabs.forEach((tab) => {
        expect(tab.getAttribute('aria-label')).toBeTruthy();
      });
    } finally {
      cleanup();
    }
  });
});
