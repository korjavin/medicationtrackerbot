import { describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('app.js food helpers', () => {
  it('parseOptionalNumber parses valid numeric input and returns null for empty/invalid', () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      expect(window.parseOptionalNumber(' 12.5 ')).toBe(12.5);
      expect(window.parseOptionalNumber('')).toBeNull();
      expect(window.parseOptionalNumber('abc')).toBeNull();
      expect(window.parseOptionalNumber(null)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('calculateFoodCalories computes kcal from macros in per-100g mode', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      document.getElementById('food-weight').value = '150';
      document.getElementById('food-carbs').value = '20';
      document.getElementById('food-protein').value = '10';
      document.getElementById('food-fat').value = '5';
      document.getElementById('food-per-100g').checked = true;
      document.getElementById('food-calories').value = '';

      window.calculateFoodCalories();

      // 150g: carbs=30, protein=15, fat=7.5 => 120 + 60 + 67.5 = 247.5 => 248
      expect(document.getElementById('food-calories').value).toBe('248');
    } finally {
      cleanup();
    }
  });

  it('onFoodPer100gChange converts macro values to absolute when disabling per100g', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      document.getElementById('food-weight').value = '200';
      document.getElementById('food-carbs').value = '10';
      document.getElementById('food-protein').value = '20';
      document.getElementById('food-fat').value = '30';
      document.getElementById('food-per-100g').checked = false;

      window.onFoodPer100gChange();

      expect(document.getElementById('food-carbs').value).toBe('20');
      expect(document.getElementById('food-protein').value).toBe('40');
      expect(document.getElementById('food-fat').value).toBe('60');
    } finally {
      cleanup();
    }
  });

  it('computeFoodTotals derives missing calories from macros', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      document.getElementById('food-weight').value = '100';
      document.getElementById('food-carbs').value = '30';
      document.getElementById('food-protein').value = '20';
      document.getElementById('food-fat').value = '10';
      document.getElementById('food-calories').value = '';
      document.getElementById('food-per-100g').checked = false;

      const totals = window.computeFoodTotals();

      expect(totals).toEqual({
        weight: 100,
        carbs: 30,
        protein: 20,
        fat: 10,
        calories: 290,
        per100g: false
      });
    } finally {
      cleanup();
    }
  });

  it('toISODateLocal formats date without timezone offset artifacts', () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      const d = new Date(2026, 1, 27); // local 2026-02-27
      expect(window.toISODateLocal(d)).toBe('2026-02-27');
    } finally {
      cleanup();
    }
  });
});
