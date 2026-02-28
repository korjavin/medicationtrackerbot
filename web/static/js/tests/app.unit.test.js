import { describe, expect, it, vi } from 'vitest';
import { createMockResponse, loadFrontendEnv } from './helpers/frontend-harness.js';

describe('app.js unit tests', () => {
  it('classifies blood pressure categories on guideline thresholds', () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      expect(window.getBPCategory(120, 80).label).toBe('Normal');
      expect(window.getBPCategory(130, 84).label).toBe('High-normal');
      expect(window.getBPCategory(140, 89).label).toBe('Grade 1 HTN');
      expect(window.getBPCategory(160, 80).label).toBe('Grade 2 HTN');
      expect(window.getBPCategory(120, 100).label).toBe('Grade 2 HTN');
    } finally {
      cleanup();
    }
  });

  it('normalizes settings bundle for mixed snake_case and camelCase backend payloads', () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const normalized = window.normalizeSettingsBundle({
        features: { bp: false, weight: true },
        settings: {
          food_targets: { calories: '1700', carbs: '180', protein: '120', fat: '60' },
          bp_reminder_status: { enabled: 1 },
          weight_reminder_status: { enabled: 0 }
        }
      });

      expect(normalized.featureSettings).toEqual({ bp: false, weight: true });
      expect(normalized.foodTargets).toEqual({ calories: 1700, carbs: 180, protein: 120, fat: 60 });
      expect(normalized.bpReminderStatus.enabled).toBe(true);
      expect(normalized.weightReminderStatus.enabled).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('throws Unauthorized for apiCallDirect on 401/403 responses', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      window.fetch = async () => createMockResponse({ status: 401, text: 'nope' });
      await expect(window.apiCallDirect('/api/test', 'GET')).rejects.toThrow('Unauthorized');
    } finally {
      cleanup();
    }
  });

  it('returns true for apiCallDirect on DELETE/204 responses', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      window.fetch = async () => createMockResponse({ status: 204, text: '' });
      const result = await window.apiCallDirect('/api/test', 'DELETE');
      expect(result).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('formats datetime-local input values and throws for invalid date values', () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const value = window.formatDateTimeLocalForInput('2026-02-28T10:15:00Z');
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(() => window.formatDateTimeLocalForInput('not-a-date')).toThrow('Invalid time value');
    } finally {
      cleanup();
    }
  });

  it('registers mt-modal custom element and updates hidden/aria state via open and close', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      expect(window.customElements.get('mt-modal')).toBeDefined();

      const foodProductModal = document.getElementById('food-product-modal');
      const medModal = document.getElementById('med-modal');
      const medConfirmModal = document.getElementById('med-confirm-modal');
      expect(foodProductModal.tagName.toLowerCase()).toBe('mt-modal');
      expect(medModal.tagName.toLowerCase()).toBe('mt-modal');
      expect(medConfirmModal.tagName.toLowerCase()).toBe('mt-modal');

      foodProductModal.open();
      expect(foodProductModal.classList.contains('hidden')).toBe(false);
      expect(foodProductModal.getAttribute('aria-hidden')).toBe('false');
      foodProductModal.close();
      expect(foodProductModal.classList.contains('hidden')).toBe(true);
      expect(foodProductModal.getAttribute('aria-hidden')).toBe('true');

      window.ModalManager.medConfirm.open();
      expect(medConfirmModal.classList.contains('hidden')).toBe(false);
      expect(medConfirmModal.getAttribute('aria-hidden')).toBe('false');
      window.ModalManager.medConfirm.close();
      expect(medConfirmModal.classList.contains('hidden')).toBe(true);
      expect(medConfirmModal.getAttribute('aria-hidden')).toBe('true');
    } finally {
      cleanup();
    }
  });

  it('downloads blob payload as a file via object URL', () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const clickSpy = vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      const originalCreateObjectURL = window.URL.createObjectURL;
      const originalRevokeObjectURL = window.URL.revokeObjectURL;
      const createObjectURLSpy = vi.fn().mockReturnValue('blob:test');
      const revokeObjectURLSpy = vi.fn();
      window.URL.createObjectURL = createObjectURLSpy;
      window.URL.revokeObjectURL = revokeObjectURLSpy;

      window.downloadBlobAsFile(new window.Blob(['x']), 'sample.csv');

      expect(createObjectURLSpy).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:test');
      expect(window.document.querySelector('a[download=\"sample.csv\"]')).toBeNull();

      window.URL.createObjectURL = originalCreateObjectURL;
      window.URL.revokeObjectURL = originalRevokeObjectURL;
      clickSpy.mockRestore();
    } finally {
      cleanup();
    }
  });

  it('exposes modal manager APIs for generic and typed modal operations', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    let pauseSpy;
    try {
      pauseSpy = vi
        .spyOn(window.HTMLMediaElement.prototype, 'pause')
        .mockImplementation(() => {});
      const overlay = document.getElementById('modal-overlay');
      const bpModal = document.getElementById('bp-modal');
      const weightModal = document.getElementById('weight-modal');
      const foodModal = document.getElementById('food-modal');
      const scannerModal = document.getElementById('food-scanner-modal');
      const medModal = document.getElementById('med-modal');
      const medConfirmModal = document.getElementById('med-confirm-modal');
      const workoutStartModal = document.getElementById('workout-start-modal');
      const workoutGroupModal = document.getElementById('workout-group-modal');
      const workoutVariantModal = document.getElementById('workout-variant-modal');
      const workoutExerciseModal = document.getElementById('workout-exercise-modal');
      const workoutSessionModal = document.getElementById('workout-session-modal');
      const addExerciseToSessionModal = document.getElementById('workout-add-exercise-to-session-modal');

      window.ModalManager.open('bp-modal');
      expect(overlay.classList.contains('hidden')).toBe(false);
      expect(bpModal.classList.contains('hidden')).toBe(false);

      window.ModalManager.close('bp-modal');
      expect(overlay.classList.contains('hidden')).toBe(true);
      expect(bpModal.classList.contains('hidden')).toBe(true);

      window.ModalManager.weight.open();
      expect(weightModal.classList.contains('hidden')).toBe(false);
      window.ModalManager.weight.close();
      expect(weightModal.classList.contains('hidden')).toBe(true);

      window.ModalManager.med.open();
      expect(medModal.classList.contains('hidden')).toBe(false);
      window.ModalManager.med.close();
      expect(medModal.classList.contains('hidden')).toBe(true);

      window.ModalManager.medConfirm.open();
      expect(medConfirmModal.classList.contains('hidden')).toBe(false);
      window.ModalManager.medConfirm.close();
      expect(medConfirmModal.classList.contains('hidden')).toBe(true);

      window.ModalManager.workoutStart.open();
      expect(workoutStartModal.classList.contains('hidden')).toBe(false);
      window.ModalManager.workoutStart.close();
      expect(workoutStartModal.classList.contains('hidden')).toBe(true);

      window.ModalManager.workoutGroup.open();
      expect(workoutGroupModal.classList.contains('hidden')).toBe(false);
      window.ModalManager.workoutGroup.close();
      expect(workoutGroupModal.classList.contains('hidden')).toBe(true);

      window.ModalManager.workoutVariant.open();
      expect(workoutVariantModal.classList.contains('hidden')).toBe(false);
      window.ModalManager.workoutVariant.close();
      expect(workoutVariantModal.classList.contains('hidden')).toBe(true);

      window.ModalManager.workoutExercise.open();
      expect(workoutExerciseModal.classList.contains('hidden')).toBe(false);
      window.ModalManager.workoutExercise.close();
      expect(workoutExerciseModal.classList.contains('hidden')).toBe(true);

      window.ModalManager.workoutSession.open();
      expect(workoutSessionModal.classList.contains('hidden')).toBe(false);
      window.ModalManager.workoutSession.close();
      expect(workoutSessionModal.classList.contains('hidden')).toBe(true);

      window.ModalManager.workoutAddExerciseToSession.open();
      expect(addExerciseToSessionModal.classList.contains('hidden')).toBe(false);
      window.ModalManager.workoutAddExerciseToSession.close();
      expect(addExerciseToSessionModal.classList.contains('hidden')).toBe(true);

      window.ModalManager.foodScanner.open();
      expect(scannerModal.classList.contains('hidden')).toBe(false);
      window.ModalManager.foodScanner.close();
      expect(scannerModal.classList.contains('hidden')).toBe(true);

      scannerModal.classList.remove('hidden');
      window.ModalManager.food.open();
      expect(foodModal.classList.contains('hidden')).toBe(false);
      window.ModalManager.food.close();
      expect(foodModal.classList.contains('hidden')).toBe(true);
      expect(scannerModal.classList.contains('hidden')).toBe(true);

      window.ModalManager.foodProduct.open();
      expect(document.getElementById('food-product-modal').classList.contains('hidden')).toBe(false);
      window.ModalManager.foodProduct.close();
      expect(document.getElementById('food-product-modal').classList.contains('hidden')).toBe(true);
    } finally {
      if (pauseSpy) pauseSpy.mockRestore();
      cleanup();
    }
  });

  it('provides top-level modal registry from modal manager', () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const defs = window.ModalManager.getTopModalDefs();
      const ids = defs.map((item) => item.id);
      expect(ids).toContain('bp-modal');
      expect(ids).toContain('weight-modal');
      expect(ids).toContain('food-modal');
      expect(ids).toContain('med-modal');
      defs.forEach((item) => expect(typeof item.fn).toBe('function'));
    } finally {
      cleanup();
    }
  });

  it('provides sub-modal registry from modal manager', () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const defs = window.ModalManager.getSubModalDefs();
      const ids = defs.map((item) => item.id);
      expect(ids).toContain('food-product-modal');
      expect(ids).toContain('food-scanner-modal');
      defs.forEach((item) => expect(typeof item.fn).toBe('function'));
    } finally {
      cleanup();
    }
  });

  it('closes topmost visible modal by configured priority and returns whether anything was closed', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    let pauseSpy;

    try {
      pauseSpy = vi
        .spyOn(window.HTMLMediaElement.prototype, 'pause')
        .mockImplementation(() => {});

      expect(window.ModalManager.closeTopMostVisibleModal()).toBe(false);

      window.ModalManager.food.open();
      window.ModalManager.foodProduct.open();
      expect(window.ModalManager.closeTopMostVisibleModal()).toBe(true);
      expect(document.getElementById('food-product-modal').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);

      expect(window.ModalManager.closeTopMostVisibleModal()).toBe(true);
      expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(true);
    } finally {
      if (pauseSpy) pauseSpy.mockRestore();
      cleanup();
    }
  });
});
