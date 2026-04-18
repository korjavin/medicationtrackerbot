/**
 * Task 2 — Tab active state: stroke/fill icon toggle, single-active invariant,
 * and accent-strip pseudo-element defined in CSS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STYLES_CSS = path.resolve(__dirname, '../../css/styles.css');

describe('Tab active state — single-active invariant', () => {
  it('only one .tab has .active at a time after a data-tab switch', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.loadBPReadings = vi.fn();
      window.loadWeightLogs = vi.fn();
      window.loadSettings = vi.fn();

      document.querySelector('.tab[data-tab="weight"]').click();
      let activeTabs = document.querySelectorAll('#tabs .tab.active');
      expect(activeTabs.length).toBe(1);
      expect(activeTabs[0].dataset.tab).toBe('weight');

      document.querySelector('.tab[data-tab="settings"]').click();
      activeTabs = document.querySelectorAll('#tabs .tab.active');
      expect(activeTabs.length).toBe(1);
      expect(activeTabs[0].dataset.tab).toBe('settings');
    } finally {
      cleanup();
    }
  });
});

describe('Tab active state — aria-current on active tab', () => {
  it('sets aria-current="page" on the active tab and removes it from siblings after a data-tab switch', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.loadBPReadings = vi.fn();
      window.loadWeightLogs = vi.fn();
      window.loadSettings = vi.fn();

      document.querySelector('.tab[data-tab="weight"]').click();
      let current = document.querySelectorAll('#tabs .tab[aria-current="page"]');
      expect(current.length).toBe(1);
      expect(current[0].dataset.tab).toBe('weight');
      document.querySelectorAll('#tabs .tab').forEach((el) => {
        if (el.dataset.tab !== 'weight') {
          expect(el.hasAttribute('aria-current')).toBe(false);
        }
      });

      document.querySelector('.tab[data-tab="settings"]').click();
      current = document.querySelectorAll('#tabs .tab[aria-current="page"]');
      expect(current.length).toBe(1);
      expect(current[0].dataset.tab).toBe('settings');
      document.querySelectorAll('#tabs .tab').forEach((el) => {
        if (el.dataset.tab !== 'settings') {
          expect(el.hasAttribute('aria-current')).toBe(false);
        }
      });
    } finally {
      cleanup();
    }
  });
});

describe('Tab active state — accent strip pseudo-element', () => {
  it('styles.css defines a .tab.active::before accent strip', () => {
    const css = fs.readFileSync(STYLES_CSS, 'utf8');
    expect(css).toMatch(/\.tab\.active::before\s*\{[\s\S]*?\}/);
  });

  it('the accent strip rule positions it at top:0 with a height', () => {
    const css = fs.readFileSync(STYLES_CSS, 'utf8');
    const match = css.match(/\.tab\.active::before\s*\{([\s\S]*?)\}/);
    expect(match).toBeTruthy();
    const body = match[1];
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/top:\s*0/);
    expect(body).toMatch(/height:\s*2px/);
  });

  it('removes the old bottom border from .tab.active', () => {
    const css = fs.readFileSync(STYLES_CSS, 'utf8');
    const match = css.match(/\.tab\.active\s*\{([\s\S]*?)\}/);
    expect(match).toBeTruthy();
    expect(match[1]).not.toMatch(/border-bottom/);
  });

  it('.tab has position: relative so the accent strip can anchor to it', () => {
    const css = fs.readFileSync(STYLES_CSS, 'utf8');
    const match = css.match(/\.tab\s*\{([\s\S]*?)\}/);
    expect(match).toBeTruthy();
    expect(match[1]).toMatch(/position:\s*relative/);
  });
});
