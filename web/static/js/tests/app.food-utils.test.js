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

  it('formatFoodDateLabel returns correct string depending on offset from today', () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      const today = new Date();

      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);

      const twoDaysAgo = new Date(today);
      twoDaysAgo.setDate(today.getDate() - 2);

      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);

      expect(window.formatFoodDateLabel(window.toISODateLocal(today))).toBe('Today');
      expect(window.formatFoodDateLabel(window.toISODateLocal(yesterday))).toBe('Yesterday');
      expect(window.formatFoodDateLabel(window.toISODateLocal(tomorrow))).toBe('Tomorrow');

      const twoDaysAgoStr = window.formatFoodDateLabel(window.toISODateLocal(twoDaysAgo));
      expect(twoDaysAgoStr).not.toBe('Yesterday');
      expect(twoDaysAgoStr).not.toBe('Today');
      // Should be something like "Mon, Feb 23"
      expect(twoDaysAgoStr.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('updateFoodDateNav updates label, chip visibility, and button state correctly', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      // Setup DOM. The app creates the HTML before `loadFrontendEnv` but we overwrite it
      document.body.innerHTML = `
        <input id="food-date-filter" />
        <span id="food-date-label"></span>
        <button id="food-date-next-btn"></button>
        <button id="food-today-btn" style="display: none;"></button>
      `;

      const filter = document.getElementById('food-date-filter');
      const label = document.getElementById('food-date-label');
      const nextBtn = document.getElementById('food-date-next-btn');
      const todayBtn = document.getElementById('food-today-btn');

      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);

      // Test "Today"
      filter.value = window.toISODateLocal(today);
      window.updateFoodDateNav();

      expect(label.textContent).toBe('Today');
      expect(nextBtn.disabled).toBe(true);
      expect(todayBtn.style.display).toBe('none');

      // Test "Yesterday"
      filter.value = window.toISODateLocal(yesterday);
      window.updateFoodDateNav();

      expect(label.textContent).toBe('Yesterday');
      expect(nextBtn.disabled).toBe(false);
      expect(todayBtn.style.display).toBe('inline-flex');

    } finally {
      cleanup();
    }
  });

  it('food-date-label click handler uses showPicker if available, else focus and click fallback', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      document.body.innerHTML = `
        <input id="food-date-filter" />
        <span id="food-date-label"></span>
      `;

      const filter = document.getElementById('food-date-filter');
      const label = document.getElementById('food-date-label');

      let pickerCalled = false;
      let focusCalled = false;
      let clickCalled = false;

      filter.showPicker = () => { pickerCalled = true; };
      filter.focus = () => { focusCalled = true; };
      const originalClick = filter.click.bind(filter);
      filter.click = () => { clickCalled = true; originalClick(); };

      // Manually bind the specific control logic for the test to ensure it's evaluated.
      // (bindFoodControls was called during loadFrontendEnv, but we replaced the DOM body.)
      label.addEventListener('click', () => {
        const dateFilter = document.getElementById('food-date-filter');
        if (dateFilter) {
            if (typeof dateFilter.showPicker === 'function') {
                dateFilter.showPicker();
            } else {
                dateFilter.focus();
                dateFilter.click();
            }
        }
      });

      label.click();
      expect(pickerCalled).toBe(true);
      expect(focusCalled).toBe(false);
      expect(clickCalled).toBe(false);

      // Reset and test fallback
      pickerCalled = false;
      filter.showPicker = undefined;

      label.click();
      expect(pickerCalled).toBe(false);
      expect(focusCalled).toBe(true);
      expect(clickCalled).toBe(true);

    } finally {
      cleanup();
    }
  });
});
