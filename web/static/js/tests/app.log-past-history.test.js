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

  it('confirmLogPast posts and loadHistory renders the new intake (not "No history yet.")', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.safeAlert = vi.fn();

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

      // Populate the datetime input (simulate the user accepting "now").
      const takenDate = new Date();
      // datetime-local needs a value without the Z suffix.
      const pad = (n) => String(n).padStart(2, '0');
      const localValue =
        `${takenDate.getFullYear()}-${pad(takenDate.getMonth() + 1)}-${pad(takenDate.getDate())}` +
        `T${pad(takenDate.getHours())}:${pad(takenDate.getMinutes())}`;
      document.getElementById('med-confirm-datetime').value = localValue;

      // Route API calls: log-past returns success, /api/history returns a list
      // that includes the freshly-logged intake, other GETs return empty.
      const newIntake = {
        id: 9001,
        medication_id: 42,
        status: 'TAKEN',
        taken_at: takenDate.toISOString(),
        scheduled_at: takenDate.toISOString()
      };

      window.apiCall = vi.fn(async (endpoint, method) => {
        if (endpoint === '/api/medications/log-past' && method === 'POST') {
          return { ok: true };
        }
        if (endpoint.startsWith('/api/history')) {
          return [newIntake];
        }
        if (endpoint.startsWith('/api/medications')) {
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

      // Run the real confirmLogPast() — no stubs on loadHistory/loadMeds.
      await window.confirmLogPast();

      // Give background microtasks kicked off by loadHistory a chance to run.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The POST must have been sent.
      expect(window.apiCall).toHaveBeenCalledWith('/api/medications/log-past', 'POST', {
        medication_id: 42,
        taken_at: new Date(localValue).toISOString()
      });

      // loadHistory must have queried the default 3-day filter for all meds.
      const historyCalls = window.apiCall.mock.calls.filter(([endpoint]) =>
        typeof endpoint === 'string' && endpoint.startsWith('/api/history')
      );
      expect(historyCalls.length).toBeGreaterThan(0);
      const historyUrl = new URL(historyCalls[0][0], 'http://test.local');
      expect(historyUrl.pathname).toBe('/api/history');
      expect(historyUrl.searchParams.get('days')).toBe('3');
      expect(historyUrl.searchParams.get('med_id')).toBe('0');

      // The history DOM must now contain the newly logged intake, NOT the empty state.
      const list = document.getElementById('history-list');
      expect(list.textContent).not.toContain('No history yet.');
      expect(list.textContent).toContain('Vitamin D');
      expect(list.querySelectorAll('.history-group').length).toBeGreaterThan(0);

      // And the user saw the success alert.
      expect(window.safeAlert).toHaveBeenCalledWith('Intake logged!');
    } finally {
      cleanup();
    }
  });

  it('loadHistory after log-past bypasses a previously cached stale list and shows the new intake', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      window.safeAlert = vi.fn();

      await seedMedications(window, [
        {
          id: 7,
          name: 'Magnesium',
          dosage: '200mg',
          schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }),
          archived: false
        }
      ]);

      // Simulate a previously cached (stale) /api/history response — empty list.
      // This mirrors the reported scenario: user viewed History, saw nothing,
      // then logged a past intake. The SWR layer will re-fetch and the fresh
      // response (with the new intake) must reach renderHistory().
      const cachedHistory = new Map();
      const staleKey = 'history_3_0';
      window.DataStore.getCached = vi.fn(async (key) => {
        return cachedHistory.has(key) ? cachedHistory.get(key) : null;
      });
      window.DataStore.setCached = vi.fn(async (key, data) => {
        cachedHistory.set(key, data);
      });
      window.DataStore.clearCached = vi.fn(async (key) => {
        cachedHistory.delete(key);
      });

      cachedHistory.set(staleKey, []); // stale empty list cached

      const takenDate = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const localValue =
        `${takenDate.getFullYear()}-${pad(takenDate.getMonth() + 1)}-${pad(takenDate.getDate())}` +
        `T${pad(takenDate.getHours())}:${pad(takenDate.getMinutes())}`;

      window.showMedicationConfirmModal([7], ['Magnesium'], takenDate, 'log_past');
      document.getElementById('med-confirm-datetime').value = localValue;

      const newIntake = {
        id: 555,
        medication_id: 7,
        status: 'TAKEN',
        taken_at: takenDate.toISOString(),
        scheduled_at: takenDate.toISOString()
      };

      window.apiCall = vi.fn(async (endpoint, method) => {
        if (endpoint === '/api/medications/log-past' && method === 'POST') {
          return { ok: true };
        }
        if (endpoint.startsWith('/api/history')) {
          return [newIntake];
        }
        if (endpoint.startsWith('/api/medications')) {
          return [
            {
              id: 7,
              name: 'Magnesium',
              dosage: '200mg',
              schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }),
              archived: false,
              last_taken_at: takenDate.toISOString()
            }
          ];
        }
        return null;
      });

      await window.confirmLogPast();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const list = document.getElementById('history-list');
      expect(list.textContent).not.toContain('No history yet.');
      expect(list.textContent).toContain('Magnesium');
      expect(list.querySelectorAll('.history-group').length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});
