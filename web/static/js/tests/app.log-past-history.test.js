import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

// Reproduction for the bug reported in
// docs/plans/completed/2026-04-16-fix-log-past-intake-history.md:
//   "Intake logged via the Log button on the medication schedule page does not
//    appear on the intake history page, even after refresh."
//
// Task 1 verified that the HTTP flow (POST /api/medications/log-past followed
// by GET /api/history) works on the backend. This suite exercises the frontend
// path: open the log-past modal -> confirmLogPast() -> loadHistory() ->
// renderHistory() and asserts the new intake shows up in the DOM.
describe('app.js log-past -> history reflects new intake', () => {
  async function seedMedications(window, meds) {
    // Match the seed pattern used by app.medication-history.test.js — prime
    // the medications array via the same loadMeds() path the real app uses.
    const originalLoadSWR = window.DataStore.loadSWR;
    window.DataStore.loadSWR = vi.fn(async (options) => {
      await options.onFresh(meds);
    });
    window.apiCall = vi.fn().mockResolvedValue([]);
    await window.loadMeds();
    window.DataStore.loadSWR = originalLoadSWR;
  }

  function padLocalDatetime(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
  }

  it('confirmLogPast invalidates history+medications cache before reload and renders the new intake', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.safeAlert = vi.fn();
      window.SyncDebug = { warn: vi.fn(), info() {}, error() {} };
      window.SyncManager = { showToast: vi.fn() };

      await seedMedications(window, [
        {
          id: 42,
          name: 'Vitamin D',
          dosage: '1 tab',
          schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
          archived: false
        }
      ]);

      // Open the log-past modal exactly the way the "Log" button does.
      window.showMedicationConfirmModal([42], ['Vitamin D'], new Date(), 'log_past');

      const takenDate = new Date();
      const localValue = padLocalDatetime(takenDate);
      document.getElementById('med-confirm-datetime').value = localValue;

      const newIntake = {
        id: 9001,
        medication_id: 42,
        status: 'TAKEN',
        taken_at: takenDate.toISOString(),
        scheduled_at: takenDate.toISOString()
      };

      // Record call ordering to verify invalidation happens before /api/history.
      const callLog = [];
      const invalidateSpy = vi.spyOn(window.DataStore, 'invalidateByTag').mockImplementation(async (tag) => {
        callLog.push({ type: 'invalidate', tag });
      });

      window.apiCall = vi.fn(async (endpoint, method) => {
        if (endpoint === '/api/medications/log-past' && method === 'POST') {
          callLog.push({ type: 'api', endpoint, method });
          return newIntake;
        }
        if (typeof endpoint === 'string' && endpoint.startsWith('/api/history')) {
          callLog.push({ type: 'api', endpoint, method });
          return [newIntake];
        }
        if (typeof endpoint === 'string' && endpoint.startsWith('/api/medications')) {
          return [
            {
              id: 42,
              name: 'Vitamin D',
              dosage: '1 tab',
              schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
              archived: false,
              last_taken_at: takenDate.toISOString()
            }
          ];
        }
        return null;
      });

      await window.confirmLogPast();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The POST must have been sent with the user's chosen time.
      expect(window.apiCall).toHaveBeenCalledWith('/api/medications/log-past', 'POST', {
        medication_id: 42,
        taken_at: new Date(localValue).toISOString()
      });

      // Both history and medications tags must have been invalidated.
      const invalidatedTags = invalidateSpy.mock.calls.map(([tag]) => tag);
      expect(invalidatedTags).toContain('history');
      expect(invalidatedTags).toContain('medications');

      // Cache invalidation must occur BEFORE the history GET so that the
      // refetch bypasses any stale SWR payload.
      const firstHistoryIdx = callLog.findIndex(
        (e) => e.type === 'api' && typeof e.endpoint === 'string' && e.endpoint.startsWith('/api/history')
      );
      const firstInvalidateHistoryIdx = callLog.findIndex((e) => e.type === 'invalidate' && e.tag === 'history');
      const firstInvalidateMedicationsIdx = callLog.findIndex((e) => e.type === 'invalidate' && e.tag === 'medications');
      expect(firstInvalidateHistoryIdx).toBeGreaterThanOrEqual(0);
      expect(firstInvalidateMedicationsIdx).toBeGreaterThanOrEqual(0);
      expect(firstHistoryIdx).toBeGreaterThan(firstInvalidateHistoryIdx);
      expect(firstHistoryIdx).toBeGreaterThan(firstInvalidateMedicationsIdx);

      // The history DOM must now contain the newly logged intake.
      const list = document.getElementById('history-list');
      expect(list.textContent).not.toContain('No history yet.');
      expect(list.textContent).toContain('Vitamin D');
      expect(list.querySelectorAll('.history-group').length).toBeGreaterThan(0);

      // And the user saw the success alert.
      expect(window.safeAlert).toHaveBeenCalledWith('Intake logged!');

      // The visibility check passed — no missing-intake warning or error toast.
      expect(window.SyncDebug.warn).not.toHaveBeenCalled();
      expect(window.SyncManager.showToast).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('warns and toasts when the refreshed history response does not contain the new intake', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.safeAlert = vi.fn();
      const warnSpy = vi.fn();
      const toastSpy = vi.fn();
      window.SyncDebug = { warn: warnSpy, info() {}, error() {} };
      window.SyncManager = { showToast: toastSpy };

      await seedMedications(window, [
        {
          id: 7,
          name: 'Magnesium',
          dosage: '200mg',
          schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }),
          archived: false
        }
      ]);

      const takenDate = new Date();
      const localValue = padLocalDatetime(takenDate);

      window.showMedicationConfirmModal([7], ['Magnesium'], takenDate, 'log_past');
      document.getElementById('med-confirm-datetime').value = localValue;

      const newIntake = {
        id: 555,
        medication_id: 7,
        status: 'TAKEN',
        taken_at: takenDate.toISOString(),
        scheduled_at: takenDate.toISOString()
      };

      // Simulate the bug path: the POST succeeded (server returned the intake)
      // but the subsequent /api/history fetch does NOT include it — the exact
      // condition the defensive visibility check exists to catch.
      window.apiCall = vi.fn(async (endpoint, method) => {
        if (endpoint === '/api/medications/log-past' && method === 'POST') {
          return newIntake;
        }
        if (typeof endpoint === 'string' && endpoint.startsWith('/api/history')) {
          return []; // empty — new intake missing
        }
        if (typeof endpoint === 'string' && endpoint.startsWith('/api/medications')) {
          return [
            {
              id: 7,
              name: 'Magnesium',
              dosage: '200mg',
              schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }),
              archived: false
            }
          ];
        }
        return null;
      });

      await window.confirmLogPast();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(warnSpy).toHaveBeenCalled();
      const warnArgs = warnSpy.mock.calls[0];
      expect(warnArgs[0]).toContain('log-past: new intake not visible');
      expect(warnArgs[1]).toEqual({ id: newIntake.id });

      expect(toastSpy).toHaveBeenCalled();
      const toastArgs = toastSpy.mock.calls[0];
      expect(toastArgs[0]).toContain('Saved');
      expect(toastArgs[1]).toBe('error');
    } finally {
      cleanup();
    }
  });

  it('POST returns the full intake and the rendered DOM has a node with that id', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.safeAlert = vi.fn();
      window.SyncDebug = { warn: vi.fn(), info() {}, error() {} };
      window.SyncManager = { showToast: vi.fn() };

      await seedMedications(window, [
        {
          id: 17,
          name: 'Fish Oil',
          dosage: '2 caps',
          schedule: JSON.stringify({ type: 'daily', times: ['20:00'] }),
          archived: false
        }
      ]);

      const takenDate = new Date();
      const localValue = padLocalDatetime(takenDate);

      window.showMedicationConfirmModal([17], ['Fish Oil'], takenDate, 'log_past');
      document.getElementById('med-confirm-datetime').value = localValue;

      const newIntake = {
        id: 777,
        medication_id: 17,
        status: 'TAKEN',
        taken_at: takenDate.toISOString(),
        scheduled_at: takenDate.toISOString()
      };

      window.apiCall = vi.fn(async (endpoint, method) => {
        if (endpoint === '/api/medications/log-past' && method === 'POST') {
          // Task 1: server now returns the full persisted IntakeLog.
          return newIntake;
        }
        if (typeof endpoint === 'string' && endpoint.startsWith('/api/history')) {
          return [newIntake];
        }
        if (typeof endpoint === 'string' && endpoint.startsWith('/api/medications')) {
          return [
            {
              id: 17,
              name: 'Fish Oil',
              dosage: '2 caps',
              schedule: JSON.stringify({ type: 'daily', times: ['20:00'] }),
              archived: false
            }
          ];
        }
        return null;
      });

      await window.confirmLogPast();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const list = document.getElementById('history-list');
      const node = list.querySelector(`[data-intake-id="${newIntake.id}"]`);
      expect(node).not.toBeNull();
      expect(node.textContent).toContain('Fish Oil');

      // No visibility-check warning or toast on the happy path.
      expect(window.SyncDebug.warn).not.toHaveBeenCalled();
      expect(window.SyncManager.showToast).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
