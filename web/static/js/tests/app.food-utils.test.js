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

  it('onFoodPer100gChange does not mutate macro values when disabling per100g', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      document.getElementById('food-weight').value = '200';
      document.getElementById('food-carbs').value = '10';
      document.getElementById('food-protein').value = '20';
      document.getElementById('food-fat').value = '30';
      document.getElementById('food-per-100g').checked = false;

      window.onFoodPer100gChange();

      expect(document.getElementById('food-carbs').value).toBe('10');
      expect(document.getElementById('food-protein').value).toBe('20');
      expect(document.getElementById('food-fat').value).toBe('30');
    } finally {
      cleanup();
    }
  });

  it('TC1: toggling per100g recalculates calories without changing macro values', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      document.getElementById('food-weight').value = '200';
      document.getElementById('food-carbs').value = '50';
      document.getElementById('food-protein').value = '0';
      document.getElementById('food-fat').value = '0';

      const per100gCheckbox = document.getElementById('food-per-100g');
      per100gCheckbox.checked = true;
      window.calculateFoodCalories();

      // 50 * 200 / 100 * 4 = 400
      expect(document.getElementById('food-calories').value).toBe('400');
      expect(document.getElementById('food-carbs').value).toBe('50');

      // Toggle off
      per100gCheckbox.checked = false;
      window.onFoodPer100gChange();

      // 50 * 4 = 200
      expect(document.getElementById('food-calories').value).toBe('200');
      expect(document.getElementById('food-carbs').value).toBe('50');

      // Toggle back on
      per100gCheckbox.checked = true;
      window.onFoodPer100gChange();

      expect(document.getElementById('food-calories').value).toBe('400');
      expect(document.getElementById('food-carbs').value).toBe('50');
    } finally {
      cleanup();
    }
  });

  it('TC2: focusing calories field while per-100g is checked leaves checkbox checked and macros unchanged', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      document.getElementById('food-weight').value = '200';
      document.getElementById('food-carbs').value = '50';
      const per100gCheckbox = document.getElementById('food-per-100g');
      per100gCheckbox.checked = true;

      window.onFoodCaloriesFocus();

      expect(per100gCheckbox.checked).toBe(true);
      expect(document.getElementById('food-carbs').value).toBe('50');
    } finally {
      cleanup();
    }
  });

  it('TC3: manual entry in per-100g=false mode calculates correctly and no recalc on toggle to same state', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      document.getElementById('food-carbs').value = '30';
      document.getElementById('food-protein').value = '20';
      document.getElementById('food-fat').value = '10';
      document.getElementById('food-weight').value = '';

      const per100gCheckbox = document.getElementById('food-per-100g');
      per100gCheckbox.checked = false;

      window.calculateFoodCalories();

      // 30*4 + 20*4 + 10*9 = 120 + 80 + 90 = 290
      expect(document.getElementById('food-calories').value).toBe('290');
      expect(per100gCheckbox.checked).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('TC4: toggling checkbox multiple times never changes macro values', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      document.getElementById('food-weight').value = '150';
      document.getElementById('food-carbs').value = '10';
      document.getElementById('food-protein').value = '20';
      document.getElementById('food-fat').value = '30';
      const per100gCheckbox = document.getElementById('food-per-100g');

      for (let i = 0; i < 5; i++) {
        per100gCheckbox.checked = !per100gCheckbox.checked;
        window.onFoodPer100gChange();

        expect(document.getElementById('food-carbs').value).toBe('10');
        expect(document.getElementById('food-protein').value).toBe('20');
        expect(document.getElementById('food-fat').value).toBe('30');
      }
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

  it('computeFoodTotals does not doubly multiply calories in per-100g mode', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      document.getElementById('food-weight').value = '500';
      document.getElementById('food-carbs').value = '4';
      document.getElementById('food-protein').value = '3.4';
      document.getElementById('food-fat').value = '1.6';
      document.getElementById('food-calories').value = '220';
      document.getElementById('food-per-100g').checked = true;

      const totals = window.computeFoodTotals();

      expect(totals).toEqual({
        weight: 500,
        carbs: 20,
        protein: 17,
        fat: 8,
        calories: 220, // Should NOT be 220 * 5 = 1100
        per100g: true
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
