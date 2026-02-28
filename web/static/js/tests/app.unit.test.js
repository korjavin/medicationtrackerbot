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

  it('shows and hides overlay-backed modals via helper', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const overlay = document.getElementById('modal-overlay');
      const medModal = document.getElementById('med-modal');
      expect(overlay.classList.contains('hidden')).toBe(true);
      expect(medModal.classList.contains('hidden')).toBe(true);

      window.showOverlayModal('med-modal');
      expect(overlay.classList.contains('hidden')).toBe(false);
      expect(medModal.classList.contains('hidden')).toBe(false);

      window.hideOverlayModal('med-modal');
      expect(overlay.classList.contains('hidden')).toBe(true);
      expect(medModal.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('exposes modal manager open/close API', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const overlay = document.getElementById('modal-overlay');
      const bpModal = document.getElementById('bp-modal');

      window.ModalManager.open('bp-modal');
      expect(overlay.classList.contains('hidden')).toBe(false);
      expect(bpModal.classList.contains('hidden')).toBe(false);

      window.ModalManager.close('bp-modal');
      expect(overlay.classList.contains('hidden')).toBe(true);
      expect(bpModal.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });
});
