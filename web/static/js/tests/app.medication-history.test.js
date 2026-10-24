import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickRowAction, loadFrontendEnv } from './helpers/frontend-harness.js';

function toLocalTime(date) {
  return date.toTimeString().slice(0, 5);
}

async function seedMedications(window, meds) {
  window.DataStore.loadSWR = vi.fn(async (options) => {
    await options.onFresh(meds);
  });
  window.apiCall = vi.fn().mockResolvedValue([]);
  await window.loadMeds();
}

describe('app.js medication, history and intake flows', () => {
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('addTimeInput/removeTime manipulate dynamic medication time rows', () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const container = document.getElementById('time-inputs');
      const initialRows = container.querySelectorAll('.time-row').length;

      window.addTimeInput('08:45');
      expect(container.querySelectorAll('.time-row').length).toBe(initialRows + 1);
      const lastInput = container.querySelector('.time-row:last-child .med-time-input');
      expect(lastInput.value).toBe('08:45');

      const removeBtn = container.querySelector('.time-row:last-child .remove-time');
      window.removeTime(removeBtn);
      expect(container.querySelectorAll('.time-row').length).toBe(initialRows);
    } finally {
      cleanup();
    }
  });

  it('renderMeds renders mixed schedules and inventory badges', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const now = new Date();
      const soon = new Date(now.getTime() + (60 * 60 * 1000));
      const far = new Date(now.getTime() + (20 * 60 * 60 * 1000));
      const todayDow = now.getDay();

      await seedMedications(window, [
        {
          id: 1,
          name: 'Soon Med',
          dosage: '10mg',
          schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(soon)] }),
          archived: false,
          inventory_count: 2,
          last_taken_at: now.toISOString(),
          normalized_name: 'Soon Med Rx'
        },
        {
          id: 2,
          name: 'Later Med',
          dosage: '5mg',
          schedule: JSON.stringify({ type: 'weekly', days: [todayDow], times: [toLocalTime(far)] }),
          archived: false,
          inventory_count: 20,
          last_taken_at: new Date(now.getTime() - (2 * 24 * 60 * 60 * 1000)).toISOString()
        },
        {
          id: 3,
          name: '<b>As Needed</b>',
          dosage: '1 tab',
          schedule: JSON.stringify({ type: 'as_needed' }),
          archived: false,
          inventory_count: null
        },
        {
          id: 4,
          name: 'Archived Med',
          dosage: '2mg',
          schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
          archived: true
        }
      ]);

      const medsHtml = document.getElementById('med-list').innerHTML;
      expect(medsHtml).toContain('Soon Med');
      expect(medsHtml).toMatch(/(Sun|Mon|Tue|Wed|Thu|Fri|Sat) at \d\d:\d\d/); // weekly copy (med-aec1)
      expect(medsHtml).toContain('As Needed');
      expect(medsHtml).toContain('archived');
      expect(medsHtml).toContain('wg-chip--warn');
      expect(medsHtml).toContain('Soon Med Rx');
      expect(document.getElementById('med-list').textContent).toContain('<b>As Needed</b>');
      // Escaped, not parsed: no <b> element (the More button's aria-label
      // carries the raw name as an attribute value).
      expect(document.getElementById('med-list').querySelector('b')).toBeNull();

      const editSpy = vi.spyOn(window, 'showEditModal').mockImplementation(() => {});
      const logSpy = vi.spyOn(window, 'logMedicationPast').mockImplementation(() => {});
      const deleteSpy = vi.spyOn(window, 'deleteMed').mockImplementation(() => {});

      const soonCard = Array.from(document.querySelectorAll('#med-list .med-item'))
        .find((el) => el.textContent.includes('Soon Med'));
      clickRowAction(soonCard, 'Edit');
      clickRowAction(soonCard, 'Log a dose');
      clickRowAction(soonCard, 'Delete');

      expect(editSpy).toHaveBeenCalledWith(1);
      expect(logSpy).toHaveBeenCalledWith(1, 'Soon Med');
      expect(deleteSpy).toHaveBeenCalledWith(1);
    } finally {
      cleanup();
    }
  });

  it('loadMeds handles cached/fresh/offline-fallback callbacks and refreshes medication list', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const cached = [{
        id: 10,
        name: 'Cached Med',
        dosage: '1',
        schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
        archived: false
      }];
      const fresh = [{
        id: 11,
        name: 'Fresh Med',
        dosage: '2',
        schedule: JSON.stringify({ type: 'daily', times: ['10:00'] }),
        archived: false
      }];
      const offline = [{
        id: 12,
        name: 'Offline Med',
        dosage: '3',
        schedule: JSON.stringify({ type: 'daily', times: ['11:00'] }),
        archived: false
      }];

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onCached(cached);
        await options.onFresh(fresh);
        await options.onError(new Error('boom'), null);
      });

      window.MedTrackerDB = {
        MedicationStore: {
          saveCache: vi.fn().mockResolvedValue(undefined),
          getCache: vi.fn().mockResolvedValue(offline)
        }
      };

      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint.startsWith('/api/history?days=7')) return [];
        return [];
      });

      await window.loadMeds();

      expect(window.DataStore.loadSWR).toHaveBeenCalled();
      expect(window.MedTrackerDB.MedicationStore.saveCache).toHaveBeenCalledWith(fresh);
      expect(window.MedTrackerDB.MedicationStore.getCache).toHaveBeenCalled();
      expect(document.getElementById('med-list').innerHTML).toContain('Offline Med');
    } finally {
      cleanup();
    }
  });

  it('fetchNextIntakePayload maps 204 to an empty-state sentinel so stale reminders clear', async () => {
    const { window, cleanup } = loadFrontendEnv();

    try {
      // apiCall coerces a 204 response into boolean `true`. The sentinel object
      // is what fetchFresh then caches, ensuring a previously-cached reminder
      // whose scheduled time drifts into the past (no change-event fired)
      // does not keep rendering.
      window.apiCall = vi.fn().mockResolvedValue(true);
      const sentinel = await window.fetchNextIntakePayload();
      expect(sentinel).toEqual({ scheduled_at: null, medication_names: [] });

      // Real payloads pass through unchanged.
      const payload = { scheduled_at: '2026-04-19T10:00:00Z', medication_names: ['Aspirin'] };
      window.apiCall = vi.fn().mockResolvedValue(payload);
      expect(await window.fetchNextIntakePayload()).toEqual(payload);

      // Null (transient network failure handled by apiCall) still returns null
      // so fetchFresh leaves the existing cache alone.
      window.apiCall = vi.fn().mockResolvedValue(null);
      expect(await window.fetchNextIntakePayload()).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('updateIntakeHistory rolls back and surfaces an error when the server reports a failure', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      // Edit modal for a 2-med TAKEN cluster: Aspirin=intake100, Magnesium=intake101.
      window.showMedicationConfirmModal([1, 2], ['Aspirin', 'Magnesium'], new Date(), 'edit', [100, 101]);

      // Leave Aspirin (index 0) as it was; Magnesium → Not taken (intake 101).
      const checks = document.querySelectorAll('.med-confirm-check');
      checks[0].setAttribute('aria-pressed', 'false');
      document.querySelector('#med-confirm-state [data-dose-state="pending"]').click();

      // The explicit undo of 101 does NOT persist.
      window.apiCall = vi.fn(async (_endpoint, _method, body) => (body.action === 'undo'
        ? { updated: 0, unchanged: 0, failed: 1, failures: [{ id: 101, reason: 'not_found' }] }
        : { updated: 1, unchanged: 0, failed: 0, failures: [] }));

      const safeAlertSpy = vi.spyOn(window, 'safeAlert').mockImplementation(() => {});
      const rollbackSpy = vi.spyOn(window, '_rollbackOptimistic');
      const commitSpy = vi.spyOn(window, '_commitOptimistic');
      const refreshSpy = vi.spyOn(window, 'refreshMedsAfterMutation').mockImplementation(() => {});

      await window.updateIntakeHistory();

      // Explicit actions on explicit ids (bd med-wi09.2): only the checked
      // dose, and the unchecked one is never touched.
      expect(window.apiCall).toHaveBeenCalledTimes(1);
      expect(window.apiCall).toHaveBeenCalledWith('/api/doses/act', 'POST',
        { action: 'undo', occ_ids: [101] });

      // Optimistic flip rolled back, never committed.
      expect(rollbackSpy).toHaveBeenCalled();
      expect(commitSpy).not.toHaveBeenCalled();

      // No "Updated!" lie; the error names the failed med.
      const messages = safeAlertSpy.mock.calls.map((c) => c[0]);
      expect(messages).not.toContain('Updated!');
      expect(messages.some((m) => typeof m === 'string' && m.includes('Magnesium'))).toBe(true);

      // Still refreshes so the list shows authoritative server state.
      expect(refreshSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('updateIntakeHistory commits and shows "Updated!" when the server reports no failures', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      // Both taken; the segment's Skipped applies to both: undo, then skip.
      window.showMedicationConfirmModal([1, 2], ['Aspirin', 'Magnesium'], new Date(), 'edit', [100, 101], ['taken', 'taken']);
      document.querySelector('#med-confirm-state [data-dose-state="skipped"]').click();
      expect(document.getElementById('med-confirm-time-edit').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('med-confirm-action-btn').textContent.replace(/\s+/g, ' ').trim()).toBe('Update 2');

      window.apiCall = vi.fn().mockResolvedValue({ updated: 2, unchanged: 0, failed: 0, failures: [] });

      const safeAlertSpy = vi.spyOn(window, 'safeAlert').mockImplementation(() => {});
      const rollbackSpy = vi.spyOn(window, '_rollbackOptimistic');
      const commitSpy = vi.spyOn(window, '_commitOptimistic');
      const refreshSpy = vi.spyOn(window, 'refreshMedsAfterMutation').mockImplementation(() => {});

      await window.updateIntakeHistory();

      expect(window.apiCall.mock.calls.map((c) => c[2])).toEqual([
        { action: 'undo', occ_ids: [100, 101] },
        { action: 'skip', occ_ids: [100, 101] },
      ]);
      expect(commitSpy).toHaveBeenCalled();
      expect(rollbackSpy).not.toHaveBeenCalled();
      const messages = safeAlertSpy.mock.calls.map((c) => c[0]);
      expect(messages).toContain('Updated!');
      expect(refreshSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('clicking the edit-modal action button undoes that dose explicitly, never a take', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      // Edit modal for a single TAKEN dose: Lercanidipine = intake 4851.
      window.showMedicationConfirmModal([7], ['Lercanidipin'], new Date(), 'edit', [4851]);

      // Not taken → "Update" must revert that intake to PENDING.
      document.querySelector('#med-confirm-state [data-dose-state="pending"]').click();

      const endpoints = [];
      window.apiCall = vi.fn(async (endpoint, _method, body) => {
        endpoints.push(endpoint === '/api/doses/act' ? `act:${body.action}` : endpoint);
        if (endpoint === '/api/doses/act') return { updated: 1, unchanged: 0, failed: 0, failures: [] };
        return true;
      });
      vi.spyOn(window, 'safeAlert').mockImplementation(() => {});
      vi.spyOn(window, 'refreshMedsAfterMutation').mockImplementation(() => {});

      // Dispatch a REAL click (not a direct updateIntakeHistory() call) so any
      // stray binding on the action button is exercised. Regression guard for the
      // double-bind: a permanent addEventListener('click', confirmSelectedMedications)
      // from init used to fire first in edit mode, disable the button via withSubmit,
      // and make the per-mode updateIntakeHistory bail out of its own withSubmit guard
      // — so unchecking a taken med POSTed /api/medications/confirm-schedule
      // ("Confirmed!") instead of /api/intakes/update and never reverted the dose.
      const btn = document.getElementById('med-confirm-action-btn');
      btn.dispatchEvent(new window.Event('click', { bubbles: true }));
      // Let withSubmit's async handler settle.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(endpoints).toEqual(['act:undo']);
    } finally {
      cleanup();
    }
  });

  it('Not taken on one med of a TAKEN timeline row reverts only that dose to Pending after the round-trip', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      await seedMedications(window, [
        { id: 1, name: 'Aspirin' },
        { id: 2, name: 'Magnesium' }
      ]);

      const now = new Date();
      const takenAt = new Date(now.getTime() - (60 * 60 * 1000)).toISOString();
      const scheduledAt = new Date(now.getTime() - (2 * 60 * 60 * 1000)).toISOString();

      // Authoritative server state: a 2-med TAKEN cluster — Aspirin=intake 100,
      // Magnesium=intake 101 — both taken at the same instant so they group.
      const serverLogs = [
        { id: 100, medication_id: 1, status: 'TAKEN', taken_at: takenAt, scheduled_at: scheduledAt },
        { id: 101, medication_id: 2, status: 'TAKEN', taken_at: takenAt, scheduled_at: scheduledAt }
      ];

      // Stateful apiCall: /api/doses/act mutates serverLogs and reports
      // per-id outcomes; GET /api/doses projects the current serverLogs (as
      // web/domain/medintake.js would) so the timeline repaints authoritative
      // state. Everything else clears.
      window.apiCall = vi.fn(async (endpoint, _method, body) => {
        if (endpoint === '/api/doses/act') {
          let updated = 0;
          const failures = [];
          for (const id of body.occ_ids) {
            const row = serverLogs.find((l) => l.id === id);
            if (!row) {
              failures.push({ id, reason: 'not_found' });
              continue;
            }
            if (body.action === 'undo') {
              row.status = 'PENDING';
              row.taken_at = null;
            } else if (body.action === 'edit_time') {
              row.taken_at = body.taken_at;
            }
            updated += 1;
          }
          return { updated, unchanged: 0, failed: failures.length, failures };
        }
        if (endpoint.startsWith('/api/doses')) {
          return serverLogs.map((l) => ({
            occId: l.id,
            medId: l.medication_id,
            plannedAt: l.scheduled_at,
            tz: 'UTC',
            localDate: l.scheduled_at.slice(0, 10),
            localTime: l.scheduled_at.slice(11, 16),
            source: 'schedule',
            state: l.status === 'TAKEN' ? 'taken' : 'due',
            ...(l.taken_at ? { takenAt: l.taken_at } : {})
          }));
        }
        return null;
      });

      // Initial render: one Taken group covering both meds.
      await window.loadTimeline();
      const timeline = document.getElementById('med-timeline-list');
      expect(Array.from(timeline.querySelectorAll('.wg-timeline__row')).map((r) => r.dataset.state)).toEqual(['taken']);

      // Tapping the Taken row opens the edit sheet over that cluster (MT3).
      timeline.querySelector('.wg-timeline__row[data-state="taken"]').click();
      expect(document.getElementById('med-confirm-eyebrow').textContent).toBe('Edit intake');
      const checks = document.querySelectorAll('.med-confirm-check');
      expect(checks.length).toBe(2);

      // Leave Aspirin as it was; Magnesium (index 1 → intake 101) → Not taken.
      checks[0].setAttribute('aria-pressed', 'false');
      document.querySelector('#med-confirm-state [data-dose-state="pending"]').click();
      await window.updateIntakeHistory();

      // refreshMedsAfterMutation() already kicks loadTimeline(), but await an
      // explicit refresh so the assertion runs against settled server state.
      await window.loadTimeline();

      const takenRow = timeline.querySelector('.wg-timeline__row[data-state="taken"]');
      const pendingRow = timeline.querySelector('.wg-timeline__row[data-state="due"]');

      // Aspirin stays Taken; only Magnesium reverted to Pending.
      expect(takenRow.dataset.occIds).toBe('100');
      expect(takenRow.textContent).toContain('Aspirin');
      expect(takenRow.textContent).not.toContain('Magnesium');
      expect(pendingRow.dataset.occIds).toBe('101');
      expect(pendingRow.textContent).toContain('Magnesium');
      expect(pendingRow.textContent).not.toContain('Aspirin');

      // Let refreshMedsAfterMutation's floating loadMeds().then() settle
      // before the window closes.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      cleanup();
    }
  });
});

// Confirm/skip flows extracted from app.js into features/meds-history.js
// (Plan 2026-06-10 finish-app-js-split, Task 1). These pin the
// medication-confirm modal's two primary mutations end-to-end through the
// harness so the extraction stays behavior-preserving.
describe('meds-history confirm/skip flows (extracted module)', () => {
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('confirmSelectedMedications takes exactly the sheet\'s occIds, commits and shows "Confirmed!"', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const scheduled = new Date().toISOString();
      window.showMedicationConfirmModal([1, 2], ['Aspirin', 'Magnesium'], scheduled, 'confirm', [100, 101]);
      // Both rows are checked by default → both meds confirmed.
      expect(document.querySelectorAll('.med-confirm-check[aria-pressed="true"]').length).toBe(2);

      window.apiCall = vi.fn().mockResolvedValue({ updated: 2, unchanged: 0, failed: 0, failures: [] });
      const safeAlertSpy = vi.spyOn(window, 'safeAlert').mockImplementation(() => {});
      const commitSpy = vi.spyOn(window, '_commitOptimistic');
      const rollbackSpy = vi.spyOn(window, '_rollbackOptimistic');
      const refreshSpy = vi.spyOn(window, 'refreshMedsAfterMutation').mockImplementation(() => {});
      const closeSpy = vi.spyOn(window, 'closeMedicationConfirmModal');

      await window.confirmSelectedMedications();

      expect(window.apiCall).toHaveBeenCalledWith('/api/doses/act', 'POST', { action: 'take', occ_ids: [100, 101] });
      expect(commitSpy).toHaveBeenCalled();
      expect(rollbackSpy).not.toHaveBeenCalled();
      expect(safeAlertSpy.mock.calls.map((c) => c[0])).toContain('Confirmed!');
      expect(refreshSpy).toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('confirmSelectedMedications rolls back and never claims success when the POST throws', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.showMedicationConfirmModal([1], ['Aspirin'], new Date().toISOString(), 'confirm', [100]);
      expect(document.querySelectorAll('.med-confirm-check[aria-pressed="true"]').length).toBe(1);

      window.apiCall = vi.fn().mockRejectedValue(new Error('network down'));
      const safeAlertSpy = vi.spyOn(window, 'safeAlert').mockImplementation(() => {});
      const commitSpy = vi.spyOn(window, '_commitOptimistic');
      const rollbackSpy = vi.spyOn(window, '_rollbackOptimistic');
      const closeSpy = vi.spyOn(window, 'closeMedicationConfirmModal');

      await expect(window.confirmSelectedMedications()).rejects.toThrow('network down');

      expect(rollbackSpy).toHaveBeenCalled();
      expect(commitSpy).not.toHaveBeenCalled();
      // No optimistic "Confirmed!" lie, and the modal stays open for a retry.
      expect(safeAlertSpy.mock.calls.map((c) => c[0])).not.toContain('Confirmed!');
      expect(closeSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('confirmSelectedMedications rolls back without success when the POST resolves falsy', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.showMedicationConfirmModal([1], ['Aspirin'], new Date().toISOString(), 'confirm', [100]);

      window.apiCall = vi.fn().mockResolvedValue(null); // apiCall handled the error internally
      const safeAlertSpy = vi.spyOn(window, 'safeAlert').mockImplementation(() => {});
      const commitSpy = vi.spyOn(window, '_commitOptimistic');
      const rollbackSpy = vi.spyOn(window, '_rollbackOptimistic');
      const closeSpy = vi.spyOn(window, 'closeMedicationConfirmModal');

      await window.confirmSelectedMedications();

      expect(rollbackSpy).toHaveBeenCalled();
      expect(commitSpy).not.toHaveBeenCalled();
      expect(safeAlertSpy.mock.calls.map((c) => c[0])).not.toContain('Confirmed!');
      // Falsy resolution still closes the modal (the catch path is the one that keeps it open).
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('confirmSelectedMedications derives the exact slot occId for a med with no stored row (Schedule "Take N")', async () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      const scheduled = '2026-10-23T18:00:00.000Z';
      window.showMedicationConfirmModal([3], ['Aspirin'], scheduled, 'confirm');
      window.apiCall = vi.fn().mockResolvedValue({ updated: 1, unchanged: 0, failed: 0, failures: [] });
      vi.spyOn(window, 'safeAlert').mockImplementation(() => {});
      vi.spyOn(window, 'refreshMedsAfterMutation').mockImplementation(() => {});

      await window.confirmSelectedMedications();

      expect(window.apiCall).toHaveBeenCalledWith('/api/doses/act', 'POST',
        { action: 'take', occ_ids: [`intake-3-${Date.parse(scheduled) / 1000}`] });
    } finally {
      cleanup();
    }
  });

  it('skipSelectedMedications skips exactly the sheet\'s occIds in one POST and shows "Skipped!"', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.showMedicationConfirmModal([1, 2], ['Aspirin', 'Magnesium'], new Date().toISOString(), 'confirm', [100, 101]);

      const endpoints = [];
      window.apiCall = vi.fn(async (endpoint, _method, body) => {
        endpoints.push([endpoint, body]);
        return { updated: 2, unchanged: 0, failed: 0, failures: [] };
      });
      const safeAlertSpy = vi.spyOn(window, 'safeAlert').mockImplementation(() => {});
      const commitSpy = vi.spyOn(window, '_commitOptimistic');
      const refreshSpy = vi.spyOn(window, 'refreshMedsAfterMutation').mockImplementation(() => {});

      await window.skipSelectedMedications();

      expect(endpoints).toEqual([['/api/doses/act', { action: 'skip', occ_ids: [100, 101] }]]);
      expect(commitSpy).toHaveBeenCalled();
      expect(safeAlertSpy.mock.calls.map((c) => c[0])).toContain('Skipped!');
      expect(refreshSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('skipSelectedMedications rolls back and reports an error when a skip fails', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.showMedicationConfirmModal([1], ['Aspirin'], new Date().toISOString(), 'confirm', [100]);

      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint === '/api/doses/act') return { updated: 0, unchanged: 0, failed: 1, failures: [{ id: 100, reason: 'not_pending' }] };
        return [];
      });
      const safeAlertSpy = vi.spyOn(window, 'safeAlert').mockImplementation(() => {});
      const commitSpy = vi.spyOn(window, '_commitOptimistic');
      const rollbackSpy = vi.spyOn(window, '_rollbackOptimistic');
      // skipSelectedMedications refreshes the meds view even on error; stub it
      // so the fire-and-forget loadMeds()/loadTimeline() don't reject unhandled
      // against an unseeded DOM.
      vi.spyOn(window, 'refreshMedsAfterMutation').mockImplementation(() => {});

      await window.skipSelectedMedications();

      expect(rollbackSpy).toHaveBeenCalled();
      expect(commitSpy).not.toHaveBeenCalled();
      const messages = safeAlertSpy.mock.calls.map((c) => c[0]);
      expect(messages).toContain("Couldn't update: Aspirin. Please try again.");
      expect(messages).not.toContain('Skipped!');
    } finally {
      cleanup();
    }
  });
});
