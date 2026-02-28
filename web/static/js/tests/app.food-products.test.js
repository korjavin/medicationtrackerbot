import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('food product edit/delete in autocomplete', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renderFoodAutocomplete shows edit/delete buttons for user products (id > 0) but not for OpenFoodFacts (id = 0)', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const products = [
        { id: 5, name: 'Oatmeal', barcode: '123', carbs_100g: 60, protein_100g: 13, fat_100g: 7, energy_kcal_100g: 370 },
        { id: 0, name: 'Remote Apple', barcode: null, carbs_100g: 14, protein_100g: 0, fat_100g: 0, energy_kcal_100g: 52 },
        { name: 'No ID Product', carbs_100g: 10, protein_100g: 2, fat_100g: 1, energy_kcal_100g: 50 },
      ];

      window.renderFoodAutocomplete(products, false, null, true);

      const list = document.getElementById('food-autocomplete-list');
      expect(list.classList.contains('hidden')).toBe(false);

      const items = list.querySelectorAll('.autocomplete-item');
      expect(items.length).toBe(3);

      // First item (id=5) should have action buttons
      const firstActions = items[0].querySelector('.autocomplete-item-actions');
      expect(firstActions).not.toBeNull();
      const firstButtons = firstActions.querySelectorAll('.autocomplete-action-btn');
      expect(firstButtons.length).toBe(2);

      // Second item (id=0) should NOT have action buttons
      const secondActions = items[1].querySelector('.autocomplete-item-actions');
      expect(secondActions).toBeNull();

      // Third item (no id) should NOT have action buttons
      const thirdActions = items[2].querySelector('.autocomplete-item-actions');
      expect(thirdActions).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('clicking edit button opens the product edit modal with correct values', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const product = {
        id: 10,
        name: 'Greek Yogurt',
        barcode: '456789',
        carbs_100g: 3.6,
        protein_100g: 10.3,
        fat_100g: 0.4,
        energy_kcal_100g: 59,
      };

      window.renderFoodAutocomplete([product], false, null, true);

      const list = document.getElementById('food-autocomplete-list');
      const editBtn = list.querySelector('.autocomplete-action-btn');
      editBtn.click();

      const modal = document.getElementById('food-product-modal');
      expect(modal.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('food-product-id').value).toBe('10');
      expect(document.getElementById('food-product-name').value).toBe('Greek Yogurt');
      expect(document.getElementById('food-product-barcode').value).toBe('456789');
      expect(document.getElementById('food-product-carbs').value).toBe('3.6');
      expect(document.getElementById('food-product-protein').value).toBe('10.3');
      expect(document.getElementById('food-product-fat').value).toBe('0.4');
      expect(document.getElementById('food-product-calories').value).toBe('59');

      // Autocomplete list should be hidden
      expect(list.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('closeFoodProductModal hides the modal', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      document.getElementById('food-product-modal').classList.remove('hidden');
      window.closeFoodProductModal();
      expect(document.getElementById('food-product-modal').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('saveFoodProduct validates name and sends PUT request', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.safeAlert = vi.fn();

      // Empty name should alert
      document.getElementById('food-product-id').value = '10';
      document.getElementById('food-product-name').value = '';
      await window.saveFoodProduct();
      expect(window.safeAlert).toHaveBeenCalledWith('Please enter a product name.');

      // Valid name should send PUT
      document.getElementById('food-product-name').value = 'Updated Yogurt';
      document.getElementById('food-product-barcode').value = '999';
      document.getElementById('food-product-carbs').value = '5';
      document.getElementById('food-product-protein').value = '12';
      document.getElementById('food-product-fat').value = '1';
      document.getElementById('food-product-calories').value = '77';

      window.apiCall = vi.fn().mockResolvedValue({ status: 'updated' });
      window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
      window.renderFoodAutocomplete = vi.fn();
      window.MedTrackerDB = { FoodProductsStore: { clearCache: vi.fn().mockResolvedValue(undefined) } };

      document.getElementById('food-product-modal').classList.remove('hidden');

      await window.saveFoodProduct();
      expect(window.apiCall).toHaveBeenCalledWith('/api/food/products/10', 'PUT', {
        name: 'Updated Yogurt',
        barcode: '999',
        carbs_100g: 5,
        protein_100g: 12,
        fat_100g: 1,
        energy_kcal_100g: 77,
      });
      expect(document.getElementById('food-product-modal').classList.contains('hidden')).toBe(true);
      expect(window.MedTrackerDB.FoodProductsStore.clearCache).toHaveBeenCalled();
      expect(window.initFoodProductsCache).toHaveBeenCalled();
      expect(window.safeAlert).toHaveBeenCalledWith('Product updated.');
    } finally {
      cleanup();
    }
  });

  it('saveFoodProduct handles API error gracefully', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.safeAlert = vi.fn();
      document.getElementById('food-product-id').value = '10';
      document.getElementById('food-product-name').value = 'Failing Product';
      window.apiCall = vi.fn().mockRejectedValue(new Error('network error'));

      await window.saveFoodProduct();
      expect(window.safeAlert).toHaveBeenCalledWith('Failed to update product.');
    } finally {
      cleanup();
    }
  });

  it('deleteFoodProduct asks confirmation, sends DELETE and refreshes cache without success alert', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      window.safeAlert = vi.fn();

      // User cancels - no API call
      window.confirm = vi.fn().mockReturnValue(false);
      window.apiCall = vi.fn();
      await window.deleteFoodProduct(5, 'Oats');
      expect(window.apiCall).not.toHaveBeenCalled();

      // User confirms - sends DELETE, no success alert
      window.confirm = vi.fn().mockReturnValue(true);
      window.apiCall = vi.fn().mockResolvedValue({});
      window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
      window.renderFoodAutocomplete = vi.fn();
      window.MedTrackerDB = { FoodProductsStore: { clearCache: vi.fn().mockResolvedValue(undefined) } };

      await window.deleteFoodProduct(5, 'Oats');
      expect(window.confirm).toHaveBeenCalledWith('Delete "Oats" from your food database?');
      expect(window.apiCall).toHaveBeenCalledWith('/api/food/products/5', 'DELETE');
      expect(window.MedTrackerDB.FoodProductsStore.clearCache).toHaveBeenCalled();
      expect(window.initFoodProductsCache).toHaveBeenCalled();
      expect(window.safeAlert).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('deleteFoodProduct handles API error gracefully', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      window.safeAlert = vi.fn();
      window.confirm = vi.fn().mockReturnValue(true);
      window.apiCall = vi.fn().mockRejectedValue(new Error('delete failed'));

      await window.deleteFoodProduct(5, 'Oats');
      expect(window.safeAlert).toHaveBeenCalledWith('Failed to delete product.');
    } finally {
      cleanup();
    }
  });

  it('clicking autocomplete item name still autofills the food modal', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const product = {
        id: 5,
        name: 'Banana',
        barcode: null,
        carbs_100g: 23,
        protein_100g: 1.1,
        fat_100g: 0.3,
        energy_kcal_100g: 89,
      };

      window.renderFoodAutocomplete([product], false, null, true);

      const list = document.getElementById('food-autocomplete-list');
      const nameSpan = list.querySelector('.autocomplete-item-name');
      expect(nameSpan.textContent).toBe('Banana');

      // Set weight so calculateFoodCalories doesn't zero out the calories
      document.getElementById('food-weight').value = '100';

      nameSpan.click();

      expect(document.getElementById('food-name').value).toBe('Banana');
      expect(document.getElementById('food-carbs').value).toBe('23');
      expect(document.getElementById('food-protein').value).toBe('1.1');
      expect(document.getElementById('food-fat').value).toBe('0.3');
      // per-100g mode with 100g weight: calories = (23*4 + 1.1*4 + 0.3*9) * 100/100 = 99.1
      // calculateFoodCalories recalculates from macros, so check it's reasonable
      const cal = parseFloat(document.getElementById('food-calories').value);
      expect(cal).toBeGreaterThan(0);
      expect(list.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });
});
