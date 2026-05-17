import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('app.js form submissions and push modal behavior', () => {
  let consoleLogSpy;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('showMedicationConfirmModal renders confirm mode and close hides it', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const overlay = document.getElementById('modal-overlay');
      const modal = document.getElementById('med-confirm-modal');

      window.showMedicationConfirmModal(['1', '2'], ['Aspirin', 'Vitamin D'], '2026-02-27T10:00:00Z');

      expect(overlay.classList.contains('hidden')).toBe(false);
      expect(modal.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('med-confirm-action-btn').innerText).toBe('Confirm Selected');
      expect(document.getElementById('med-confirm-snooze-btn').classList.contains('hidden')).toBe(false);
      expect(document.querySelectorAll('.med-confirm-check').length).toBe(2);

      document.getElementById('med-confirm-dismiss-btn').click();
      expect(overlay.classList.contains('hidden')).toBe(true);
      expect(modal.classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('confirmSelectedMedications posts selected ids and refreshes lists', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
      const loadMedsSpy = vi.fn();
      const loadHistorySpy = vi.fn();
      const alertSpy = vi.fn();

      window.apiCall = apiCallSpy;
      window.loadMeds = loadMedsSpy;
      window.loadHistory = loadHistorySpy;
      window.Telegram.WebApp.showAlert = alertSpy;

      window.showMedicationConfirmModal(['10', '20'], ['A', 'B'], '2026-02-27T10:00:00Z');

      const checks = document.querySelectorAll('.med-confirm-check');
      checks[1].checked = false;

      await window.confirmSelectedMedications();

      expect(apiCallSpy).toHaveBeenCalledTimes(1);
      expect(apiCallSpy.mock.calls[0][0]).toBe('/api/medications/confirm-schedule');
      expect(apiCallSpy.mock.calls[0][1]).toBe('POST');
      expect(apiCallSpy.mock.calls[0][2]).toEqual({
        scheduled_at: '2026-02-27T10:00:00Z',
        medication_ids: [10]
      });
      expect(loadMedsSpy).toHaveBeenCalledTimes(1);
      expect(loadHistorySpy).toHaveBeenCalledTimes(1);
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(document.getElementById('med-confirm-modal').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('confirmSelectedMedications includes intake_ids in POST body when provided via push notification', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
      const loadMedsSpy = vi.fn();
      const loadHistorySpy = vi.fn();
      const alertSpy = vi.fn();

      window.apiCall = apiCallSpy;
      window.loadMeds = loadMedsSpy;
      window.loadHistory = loadHistorySpy;
      window.Telegram.WebApp.showAlert = alertSpy;

      window.showMedicationConfirmModal([10, 20], ['A', 'B'], '2026-02-27T10:00:00Z', 'confirm', [100, 200]);

      const checks = document.querySelectorAll('.med-confirm-check');
      checks[1].checked = false;

      await window.confirmSelectedMedications();

      expect(apiCallSpy).toHaveBeenCalledTimes(1);
      expect(apiCallSpy.mock.calls[0][0]).toBe('/api/medications/confirm-schedule');
      expect(apiCallSpy.mock.calls[0][1]).toBe('POST');
      expect(apiCallSpy.mock.calls[0][2]).toEqual({
        scheduled_at: '2026-02-27T10:00:00Z',
        medication_ids: [10],
        intake_ids: [100]
      });
    } finally {
      cleanup();
    }
  });

  it('skipSelectedMedications posts selected intake ids using row indices', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn(async (path, method, body) => {
        if (path === '/api/medications/skip') return { ok: true, body };
        return { ok: true };
      });
      const loadMedsSpy = vi.fn();
      const loadHistorySpy = vi.fn();
      const alertSpy = vi.fn();

      window.apiCall = apiCallSpy;
      window.loadMeds = loadMedsSpy;
      window.loadHistory = loadHistorySpy;
      window.Telegram.WebApp.showAlert = alertSpy;

      window.showMedicationConfirmModal([10, 20], ['A', 'B'], '2026-02-27T10:00:00Z', 'confirm', [100, 200]);

      const checks = document.querySelectorAll('.med-confirm-check');
      checks[1].checked = false;

      await window.skipSelectedMedications();

      expect(apiCallSpy).toHaveBeenCalledTimes(1);
      expect(apiCallSpy.mock.calls[0][0]).toBe('/api/medications/skip');
      expect(apiCallSpy.mock.calls[0][1]).toBe('POST');
      expect(apiCallSpy.mock.calls[0][2]).toEqual({ intake_id: 100 });
      expect(loadMedsSpy).toHaveBeenCalledTimes(1);
      expect(loadHistorySpy).toHaveBeenCalledTimes(1);
      expect(alertSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('handleBPSubmit posts payload, invalidates bp tag and refreshes list', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn().mockResolvedValue({ id: 1 });
      const invalidateSpy = vi.fn().mockResolvedValue(undefined);
      const loadBPSpy = vi.fn();

      window.apiCall = apiCallSpy;
      window.DataStore.invalidateTags = invalidateSpy;
      window.loadBPReadings = loadBPSpy;

      window.showBPRecordModal();

      const inputDateTime = '2026-02-27T10:30';
      document.getElementById('bp-datetime').value = inputDateTime;
      document.getElementById('bp-systolic').value = '128';
      document.getElementById('bp-diastolic').value = '82';
      document.getElementById('bp-pulse').value = '67';
      document.getElementById('bp-site').value = 'right_arm';
      document.getElementById('bp-position').value = 'seated';
      document.getElementById('bp-notes').value = 'Morning';

      await window.handleBPSubmit({ preventDefault() {} });

      expect(apiCallSpy).toHaveBeenCalledTimes(1);
      expect(apiCallSpy.mock.calls[0][0]).toBe('/api/bp');
      expect(apiCallSpy.mock.calls[0][1]).toBe('POST');
      expect(apiCallSpy.mock.calls[0][2]).toEqual({
        measured_at: new Date(inputDateTime).toISOString(),
        systolic: 128,
        diastolic: 82,
        pulse: 67,
        site: 'right_arm',
        position: 'seated',
        notes: 'Morning'
      });
      expect(invalidateSpy).toHaveBeenCalledWith(['bp']);
      expect(loadBPSpy).toHaveBeenCalledTimes(1);
      expect(document.getElementById('bp-modal').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('handleBPSubmit awaits loadBPReadings so the new row renders before resolving', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn().mockResolvedValue({ id: 42 });
      window.apiCall = apiCallSpy;
      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

      let resolveLoad;
      const loadPromise = new Promise((resolve) => { resolveLoad = resolve; });
      let loadResolved = false;
      window.loadBPReadings = vi.fn(() => loadPromise.then(() => {
        const list = document.getElementById('bp-list');
        expect(list).not.toBeNull();
        const row = document.createElement('div');
        row.className = 'wg-bp-history__item';
        row.textContent = '132/84';
        list.appendChild(row);
        loadResolved = true;
      }));

      window.showBPRecordModal();
      document.getElementById('bp-datetime').value = '2026-02-27T10:30';
      document.getElementById('bp-systolic').value = '132';
      document.getElementById('bp-diastolic').value = '84';

      const submitPromise = window.handleBPSubmit({ preventDefault() {} });

      // Microtask drain so apiCall + invalidateTags + loadBPReadings kick off.
      await Promise.resolve();
      await Promise.resolve();
      expect(loadResolved).toBe(false);
      // Modal must stay visible while the reload is pending — we close
      // only after the list has repainted, otherwise the user briefly
      // sees the pre-submit list.
      expect(document.getElementById('bp-modal').classList.contains('hidden')).toBe(false);

      resolveLoad();
      await submitPromise;

      expect(loadResolved).toBe(true);
      const list = document.getElementById('bp-list');
      expect(list.textContent).toContain('132/84');
      expect(document.getElementById('bp-modal').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('handleBPSubmit guards against double-submit while reload is pending', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn().mockResolvedValue({ id: 99 });
      window.apiCall = apiCallSpy;
      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

      let resolveLoad;
      const loadPromise = new Promise((resolve) => { resolveLoad = resolve; });
      window.loadBPReadings = vi.fn(() => loadPromise);

      window.showBPRecordModal();
      document.getElementById('bp-datetime').value = '2026-02-27T10:30';
      document.getElementById('bp-systolic').value = '128';
      document.getElementById('bp-diastolic').value = '82';

      const firstSubmit = window.handleBPSubmit({ preventDefault() {} });
      await Promise.resolve();
      await Promise.resolve();

      const saveBtn = document.querySelector('#bp-modal button[form="bp-form"]');
      expect(saveBtn).not.toBeNull();
      expect(saveBtn.disabled).toBe(true);

      await window.handleBPSubmit({ preventDefault() {} });
      expect(apiCallSpy).toHaveBeenCalledTimes(1);

      resolveLoad();
      await firstSubmit;

      expect(saveBtn.disabled).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('handleBPSubmit does not close modal or reload list when POST fails', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn().mockResolvedValue(null);
      const invalidateSpy = vi.fn().mockResolvedValue(undefined);
      const loadBPSpy = vi.fn();

      window.apiCall = apiCallSpy;
      window.DataStore.invalidateTags = invalidateSpy;
      window.loadBPReadings = loadBPSpy;

      window.showBPRecordModal();
      document.getElementById('bp-datetime').value = '2026-02-27T10:30';
      document.getElementById('bp-systolic').value = '132';
      document.getElementById('bp-diastolic').value = '84';

      await window.handleBPSubmit({ preventDefault() {} });

      expect(apiCallSpy).toHaveBeenCalledTimes(1);
      // Modal stays open + the list is not refreshed on a failed POST. The
      // rollback path DOES call invalidateTags(['bp']) so the next read goes
      // to network after the optimistic state is discarded — we no longer
      // assert it's untouched (Plan 2026-05-17 Task 5 optimistic conversion).
      expect(loadBPSpy).not.toHaveBeenCalled();
      expect(document.getElementById('bp-modal').classList.contains('hidden')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('handleWeightSubmit posts payload, invalidates weight tag and refreshes list', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const apiCallSpy = vi.fn().mockResolvedValue({ id: 1 });
      const invalidateSpy = vi.fn().mockResolvedValue(undefined);
      const loadWeightSpy = vi.fn();

      window.apiCall = apiCallSpy;
      window.DataStore.invalidateTags = invalidateSpy;
      window.loadWeightLogs = loadWeightSpy;

      window.showWeightModal();

      const inputDateTime = '2026-02-27T11:05';
      document.getElementById('weight-datetime').value = inputDateTime;
      document.getElementById('weight-value').value = '79.4';
      document.getElementById('weight-notes').value = 'After workout';

      await window.handleWeightSubmit({ preventDefault() {} });

      expect(apiCallSpy).toHaveBeenCalledTimes(1);
      expect(apiCallSpy).toHaveBeenCalledWith('/api/weight', 'POST', {
        measured_at: new Date(inputDateTime).toISOString(),
        weight: 79.4,
        notes: 'After workout'
      });
      expect(invalidateSpy).toHaveBeenCalledWith(['weight']);
      expect(loadWeightSpy).toHaveBeenCalledTimes(1);
      expect(document.getElementById('weight-modal').classList.contains('hidden')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('handleBPSubmit refreshes Today when the modal was opened from the today shortcut', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.apiCall = vi.fn().mockResolvedValue({ id: 1 });
      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
      window.loadBPReadings = vi.fn().mockResolvedValue(undefined);
      const loadTodaySpy = vi.fn();
      window.loadToday = loadTodaySpy;
      window.AppStore.set('currentTab', 'today');

      window.showBPRecordModal();
      document.getElementById('bp-datetime').value = '2026-02-27T10:30';
      document.getElementById('bp-systolic').value = '128';
      document.getElementById('bp-diastolic').value = '82';

      await window.handleBPSubmit({ preventDefault() {} });

      // Optimistic dispatch + commit dispatch + explicit post-POST refresh
      // may each trigger a reload-via-loadToday. The contract is "Today is
      // refreshed", not an exact call count.
      expect(loadTodaySpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('handleBPSubmit does not refresh Today when the modal was opened from the BP screen', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.apiCall = vi.fn().mockResolvedValue({ id: 1 });
      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
      window.loadBPReadings = vi.fn().mockResolvedValue(undefined);
      const loadTodaySpy = vi.fn();
      window.loadToday = loadTodaySpy;
      window.AppStore.set('currentTab', 'bp');

      window.showBPRecordModal();
      document.getElementById('bp-datetime').value = '2026-02-27T10:30';
      document.getElementById('bp-systolic').value = '128';
      document.getElementById('bp-diastolic').value = '82';

      await window.handleBPSubmit({ preventDefault() {} });

      expect(loadTodaySpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('handleWeightSubmit refreshes Today when the modal was opened from the today shortcut', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.apiCall = vi.fn().mockResolvedValue({ id: 1 });
      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
      window.loadWeightLogs = vi.fn();
      const loadTodaySpy = vi.fn();
      window.loadToday = loadTodaySpy;
      window.AppStore.set('currentTab', 'today');

      window.showWeightModal();
      document.getElementById('weight-datetime').value = '2026-02-27T11:05';
      document.getElementById('weight-value').value = '79.4';

      await window.handleWeightSubmit({ preventDefault() {} });

      // Optimistic dispatch + commit dispatch + explicit post-POST refresh
      // may each trigger a reload-via-loadToday. The contract is "Today is
      // refreshed", not an exact call count.
      expect(loadTodaySpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('handleWeightSubmit explicitly clears the Today weight cache by key', async () => {
    // Regression: this exercise predates CacheKeys.registerAll wiring the
    // 'weight' key at boot. It pins the belt-and-suspenders contract — a
    // bypass of registration (future refactor, or a code path that skips
    // the registry) must still result in eviction via clearCached('weight')
    // so Today's presence check doesn't treat the stale snapshot as fresh.
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.apiCall = vi.fn().mockResolvedValue({ id: 1 });
      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
      const clearCachedSpy = vi.fn().mockResolvedValue(undefined);
      window.DataStore.clearCached = clearCachedSpy;
      window.loadWeightLogs = vi.fn();
      window.loadToday = vi.fn();
      window.AppStore.set('currentTab', 'today');

      window.showWeightModal();
      document.getElementById('weight-datetime').value = '2026-02-27T11:05';
      document.getElementById('weight-value').value = '79.4';

      await window.handleWeightSubmit({ preventDefault() {} });

      expect(clearCachedSpy).toHaveBeenCalledWith('weight');
    } finally {
      cleanup();
    }
  });

  it('handleBPSubmit explicitly clears the Today BP cache by key', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.apiCall = vi.fn().mockResolvedValue({ id: 1 });
      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
      const clearCachedSpy = vi.fn().mockResolvedValue(undefined);
      window.DataStore.clearCached = clearCachedSpy;
      window.loadBPReadings = vi.fn().mockResolvedValue(undefined);
      window.loadToday = vi.fn();
      window.AppStore.set('currentTab', 'today');

      window.showBPRecordModal();
      document.getElementById('bp-datetime').value = '2026-02-27T10:30';
      document.getElementById('bp-systolic').value = '128';
      document.getElementById('bp-diastolic').value = '82';

      await window.handleBPSubmit({ preventDefault() {} });

      expect(clearCachedSpy).toHaveBeenCalledWith('bp');
    } finally {
      cleanup();
    }
  });
});
