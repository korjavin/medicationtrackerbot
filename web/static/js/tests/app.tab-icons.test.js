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

  it('every .tab button carries role="tab" and an aria-label', () => {
    const { document, cleanup } = loadFrontendEnv();
    try {
      const tabs = document.querySelectorAll('#tabs .tab');
      tabs.forEach((tab) => {
        expect(tab.getAttribute('role')).toBe('tab');
        expect(tab.getAttribute('aria-label')).toBeTruthy();
      });
    } finally {
      cleanup();
    }
  });
});
