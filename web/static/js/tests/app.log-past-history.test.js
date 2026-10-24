import { describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

// Reproduction for the bug reported in
// docs/plans/completed/2026-04-16-fix-log-past-intake-history.md:
//   "Intake logged via the Log button on the medication schedule page does not
//    appear on the intake history page, even after refresh."
//
// The History list is gone (bd med-wi09.3); the Meds timeline over GET
// /api/doses is where a logged dose shows. This suite exercises the frontend
// path: open the log-past modal -> confirmLogPast() -> loadTimeline() and
// asserts the new intake shows up in #med-timeline-list.
describe('app.js log-past -> timeline reflects new intake', () => {
  async function seedMedications(window, meds) {
    // Prime the medications array via the same loadMeds() path the real app uses.
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

  // The GET /api/doses projection row of a logged (manual) intake.
  function doseRow(intake) {
    return {
      occId: intake.id,
      medId: intake.medication_id,
      plannedAt: intake.scheduled_at,
      tz: 'UTC',
      localDate: intake.scheduled_at.slice(0, 10),
      localTime: intake.scheduled_at.slice(11, 16),
      source: 'manual',
      state: 'taken',
      takenAt: intake.taken_at
    };
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

      // Record call ordering to verify invalidation happens before /api/doses.
      const callLog = [];
      const invalidateSpy = vi.spyOn(window.DataStore, 'invalidateByTag').mockImplementation(async (tag) => {
        callLog.push({ type: 'invalidate', tag });
      });

      window.apiCall = vi.fn(async (endpoint, method) => {
        if (endpoint === '/api/medications/log-past' && method === 'POST') {
          callLog.push({ type: 'api', endpoint, method });
          return newIntake;
        }
        if (typeof endpoint === 'string' && endpoint.startsWith('/api/doses')) {
          callLog.push({ type: 'api', endpoint, method });
          return [doseRow(newIntake)];
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

      // Cache invalidation must occur BEFORE the timeline GET so that the
      // refetch bypasses any stale payload.
      const firstDosesIdx = callLog.findIndex(
        (e) => e.type === 'api' && typeof e.endpoint === 'string' && e.endpoint.startsWith('/api/doses')
      );
      const firstInvalidateHistoryIdx = callLog.findIndex((e) => e.type === 'invalidate' && e.tag === 'history');
      const firstInvalidateMedicationsIdx = callLog.findIndex((e) => e.type === 'invalidate' && e.tag === 'medications');
      expect(firstInvalidateHistoryIdx).toBeGreaterThanOrEqual(0);
      expect(firstInvalidateMedicationsIdx).toBeGreaterThanOrEqual(0);
      expect(firstDosesIdx).toBeGreaterThan(firstInvalidateHistoryIdx);
      expect(firstDosesIdx).toBeGreaterThan(firstInvalidateMedicationsIdx);

      // The timeline must now contain the newly logged intake.
      const row = document.querySelector('#med-timeline-list .wg-timeline__row[data-occ-ids~="9001"]');
      expect(row).not.toBeNull();
      expect(row.dataset.state).toBe('taken');
      expect(row.textContent).toContain('Vitamin D');

      // And the user saw the success toast, not a blocking alert (med-omvw).
      expect(window.safeAlert).not.toHaveBeenCalled();
      expect(window.SyncManager.showToast).toHaveBeenCalledWith('Intake logged!', 'info');

      // The visibility check passed — no missing-intake warning or error toast.
      expect(window.SyncDebug.warn).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('warns and toasts when the refreshed timeline does not contain the new intake', async () => {
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
      // but the subsequent /api/doses read does NOT include it — the exact
      // condition the defensive visibility check exists to catch.
      window.apiCall = vi.fn(async (endpoint, method) => {
        if (endpoint === '/api/medications/log-past' && method === 'POST') {
          return newIntake;
        }
        if (typeof endpoint === 'string' && endpoint.startsWith('/api/doses')) {
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

      // The success toast fires first, then the visibility-check warning.
      expect(toastSpy).toHaveBeenCalledWith('Intake logged!', 'info');
      const toastArgs = toastSpy.mock.calls.find((c) => c[1] === 'error');
      expect(toastArgs[0]).toContain('Saved');
    } finally {
      cleanup();
    }
  });

  it('a string occId from the projection still matches the POST\'s numeric id', async () => {
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
          return newIntake;
        }
        if (typeof endpoint === 'string' && endpoint.startsWith('/api/doses')) {
          return [{ ...doseRow(newIntake), occId: '777', medId: '17' }];
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

      const node = document.querySelector(`#med-timeline-list [data-occ-ids~="${newIntake.id}"]`);
      expect(node).not.toBeNull();
      expect(node.textContent).toContain('Fish Oil');

      // Success toasts on the happy path, but no visibility-check warning
      // or error toast (med-omvw).
      expect(window.SyncDebug.warn).not.toHaveBeenCalled();
      expect(window.SyncManager.showToast).toHaveBeenCalledWith('Intake logged!', 'info');
    } finally {
      cleanup();
    }
  });
});
