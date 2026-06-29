import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

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

  it('renderMeds and populateMedFilter render mixed schedules and inventory badges', async () => {
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
      expect(medsHtml).toContain('Weekly');
      expect(medsHtml).toContain('As Needed');
      expect(medsHtml).toContain('archived');
      expect(medsHtml).toContain('⚠️');
      expect(medsHtml).toContain('Soon Med Rx');
      expect(document.getElementById('med-list').textContent).toContain('<b>As Needed</b>');
      expect(medsHtml).not.toContain('<b>As Needed</b>');

      const editSpy = vi.spyOn(window, 'showEditModal').mockImplementation(() => {});
      const logSpy = vi.spyOn(window, 'logMedicationPast').mockImplementation(() => {});
      const deleteSpy = vi.spyOn(window, 'deleteMed').mockImplementation(() => {});

      const soonCard = Array.from(document.querySelectorAll('#med-list .med-item'))
        .find((el) => el.textContent.includes('Soon Med'));
      soonCard.querySelector('.icon-action-btn:not(.delete)').click(); // Edit button
      soonCard.querySelector('.btn-sm').click();
      soonCard.querySelector('.icon-action-btn.delete').click();

      expect(editSpy).toHaveBeenCalledWith(1);
      expect(logSpy).toHaveBeenCalledWith(1, 'Soon Med');
      expect(deleteSpy).toHaveBeenCalledWith(1);

      const filter = document.getElementById('history-filter-med');
      const options = Array.from(filter.querySelectorAll('option'));

      // Should include 'All Medications' and 'Soon Med' (taken recently)
      // but NOT 'Later Med' (taken 2 days ago, which IS recent, so we need to add a test case for one > 7 days)

      // But let's check what's actually there
      expect(options.some(o => o.text.includes('All Medications'))).toBe(true);
      expect(options.some(o => o.text.includes('Soon Med'))).toBe(true);
      expect(options.some(o => o.text.includes('Later Med'))).toBe(true); // 2 days ago is within 7 days
      expect(options.some(o => o.text.includes('As Needed'))).toBe(false); // no last_taken_at
      expect(options.some(o => o.text.includes('Archived Med'))).toBe(false); // no last_taken_at
    } finally {
      cleanup();
    }
  });

  it('populateMedFilter only shows medications taken in the last 7 days', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - (3 * 24 * 60 * 60 * 1000));
      const eightDaysAgo = new Date(now.getTime() - (8 * 24 * 60 * 60 * 1000));

      await seedMedications(window, [
        {
          id: 1,
          name: 'Recent Med',
          schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }),
          last_taken_at: threeDaysAgo.toISOString()
        },
        {
          id: 2,
          name: 'Old Med',
          schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
          last_taken_at: eightDaysAgo.toISOString()
        },
        {
          id: 3,
          name: 'Never Taken Med',
          schedule: JSON.stringify({ type: 'daily', times: ['10:00'] }),
          last_taken_at: null
        }
      ]);

      const filter = document.getElementById('history-filter-med');
      const options = Array.from(filter.querySelectorAll('option'));

      expect(options.length).toBe(2); // All Medications + Recent Med
      expect(options[0].text).toBe('All Medications');
      expect(options[1].text).toBe('Recent Med');

      // Test fallback to 0 when previously selected medication ages out
      filter.value = "2"; // Simulate 'Old Med' was selected
      window.populateMedFilter();
      expect(filter.value).toBe("0"); // Should fallback to 'All Medications'

      // Test retaining selected value when still valid
      filter.value = "1"; // Simulate 'Recent Med' was selected
      window.populateMedFilter();
      expect(filter.value).toBe("1"); // Should retain 'Recent Med'
    } finally {
      cleanup();
    }
  });

  it('loadHistory clears the list when fetching returns null or empty array', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      await seedMedications(window, [
        { id: 1, name: 'Aspirin' }
      ]);

      // Seed with initial history
      const now = new Date();
      window.renderHistory([
        { id: 100, medication_id: 1, status: 'TAKEN', taken_at: now.toISOString(), scheduled_at: now.toISOString() }
      ]);

      const list = document.getElementById('history-list');
      expect(list.innerHTML).toContain('Aspirin');

      // Now mock DataStore.loadSWR to return null for fresh
      window.DataStore.loadSWR = vi.fn(async (options) => {
        // Assert we passed allowNullFresh
        expect(options.allowNullFresh).toBe(true);
        await options.onFresh(null);
      });

      await window.loadHistory();

      // List should be empty
      expect(list.innerHTML).toContain('No history yet.');
      expect(list.innerHTML).not.toContain('Aspirin');

      // Test empty array as well
      window.renderHistory([
        { id: 100, medication_id: 1, status: 'TAKEN', taken_at: now.toISOString(), scheduled_at: now.toISOString() }
      ]);
      expect(list.innerHTML).toContain('Aspirin');

      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh([]);
      });
      await window.loadHistory();
      expect(list.innerHTML).toContain('No history yet.');
    } finally {
      cleanup();
    }
  });

  it('loadHistory populates the med filter when medications are pre-loaded from bootstrap', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const now = new Date();
      // Pre-populate medications directly (simulating bootstrap path — loadMeds() will be skipped)
      const recentDate = new Date(now.getTime() - (2 * 24 * 60 * 60 * 1000)).toISOString();
      await seedMedications(window, [
        {
          id: 10,
          name: 'Pre-loaded Med',
          schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }),
          last_taken_at: recentDate
        }
      ]);

      // Reset the filter to only default option to simulate it not being populated yet
      const filter = document.getElementById('history-filter-med');
      filter.innerHTML = '<option value="0">All Medications</option>';
      expect(filter.querySelectorAll('option').length).toBe(1);

      // Mock DataStore.loadSWR so loadHistory doesn't fail
      window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh([]);
      });

      await window.loadHistory();

      // Filter should now include Pre-loaded Med (medications were already loaded, populateMedFilter called)
      const options = Array.from(filter.querySelectorAll('option'));
      expect(options.some(o => o.text.includes('Pre-loaded Med'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('renderHistory groups intakes and opens edit modal on TAKEN group click', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      await seedMedications(window, [
        { id: 1, name: 'Aspirin' },
        { id: 2, name: '<b>Magnesium</b>' }
      ]);

      const now = new Date();
      const takenAt = new Date(now.getTime() - (60 * 60 * 1000)).toISOString();
      const scheduledAt = new Date(now.getTime() - (2 * 60 * 60 * 1000)).toISOString();

      const logs = [
        { id: 100, medication_id: 1, status: 'TAKEN', taken_at: takenAt, scheduled_at: scheduledAt },
        { id: 101, medication_id: 2, status: 'TAKEN', taken_at: takenAt, scheduled_at: scheduledAt },
        { id: 102, medication_id: 1, status: 'PENDING', scheduled_at: new Date(now.getTime() + (60 * 60 * 1000)).toISOString() }
      ];

      const modalSpy = vi.fn();
      window.showMedicationConfirmModal = modalSpy;

      window.renderHistory(logs);
      const list = document.getElementById('history-list');
      expect(list.innerHTML).toContain('Aspirin');
      expect(list.innerHTML).toContain('Magnesium');
      expect(list.innerHTML).toContain('✅');
      expect(list.textContent).toContain('<b>Magnesium</b>');
      expect(list.innerHTML).not.toContain('<b>');

      const groups = list.querySelectorAll('.history-group');
      expect(groups.length).toBeGreaterThan(0);
      groups[1].click();

      expect(modalSpy).toHaveBeenCalled();
      expect(modalSpy.mock.calls[0][0]).toEqual([1, 2]);
      expect(modalSpy.mock.calls[0][3]).toBe('edit');
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

  it('next intake trigger render/action behave correctly', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      const container = document.getElementById('next-intake-trigger');
      const alertSpy = vi.fn();
      window.Telegram.WebApp.showAlert = alertSpy;

      // fetchFresh is called for its cache side-effect; the caller reads the
      // authoritative value via getCached. Mock getCached to drive the render:
      // first pass returns nothing cached (empty card), second returns data.
      window.DataStore.fetchFresh = vi.fn().mockResolvedValue(null);
      window.DataStore.getCached = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          scheduled_at: new Date().toISOString(),
          medication_names: ['<b>Aspirin</b>', 'Vitamin D']
        });

      await window.renderNextIntakeTrigger();
      expect(container.innerHTML).toBe('');

      await window.renderNextIntakeTrigger();
      expect(container.innerHTML).toContain('Next scheduled intake');
      expect(container.innerHTML).toContain('Take Now');
      expect(container.textContent).toContain('<b>Aspirin</b>, Vitamin D');
      expect(container.innerHTML).not.toContain('<b>');

      const triggerSpy = vi.spyOn(window, 'triggerNextIntake').mockResolvedValue(undefined);
      container.querySelector('button').click();
      expect(triggerSpy).toHaveBeenCalledTimes(1);
      triggerSpy.mockRestore();

      window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
      window.DataStore.invalidateKey = vi.fn().mockResolvedValue(undefined);
      const loadHistorySpy = vi.spyOn(window, 'loadHistory').mockResolvedValue(undefined);

      window.apiCall = vi
        .fn()
        .mockResolvedValueOnce({
          status: 'confirmed',
          medication_names: ['Aspirin'],
          scheduled_at: new Date().toISOString(),
          taken_at: new Date().toISOString()
        })
        .mockResolvedValueOnce(null); // null = apiCall handled the error internally

      await window.triggerNextIntake();
      expect(window.DataStore.invalidateTags).toHaveBeenCalledWith(['history', 'medications', 'gamification']);
      expect(window.DataStore.invalidateKey).toHaveBeenCalledWith('next_intake');
      expect(loadHistorySpy).toHaveBeenCalled();
      expect(alertSpy).toHaveBeenCalled();

      // apiCall returned null → no further action (no extra alert from triggerNextIntake)
      loadHistorySpy.mockClear();
      alertSpy.mockClear();
      await window.triggerNextIntake();
      expect(loadHistorySpy).not.toHaveBeenCalled();
      expect(alertSpy).not.toHaveBeenCalled();
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

      // Uncheck Magnesium (index 1) → revert intake 101 to PENDING.
      const checks = document.querySelectorAll('.med-confirm-check');
      checks[1].checked = false;

      // Server reports the revert did NOT persist.
      window.apiCall = vi.fn().mockResolvedValue({
        updated: 0,
        failed: 1,
        failures: [{ id: 101, reason: 'no_row_matched' }],
      });

      const safeAlertSpy = vi.spyOn(window, 'safeAlert').mockImplementation(() => {});
      const rollbackSpy = vi.spyOn(window, '_rollbackOptimistic');
      const commitSpy = vi.spyOn(window, '_commitOptimistic');
      const refreshSpy = vi.spyOn(window, 'refreshMedsAfterMutation').mockImplementation(() => {});

      await window.updateIntakeHistory();

      // POST carried both the TAKEN re-confirm and the PENDING revert.
      expect(window.apiCall).toHaveBeenCalledWith(
        '/api/intakes/update',
        'POST',
        expect.objectContaining({
          updates: expect.arrayContaining([
            expect.objectContaining({ id: 101, status: 'PENDING' }),
            expect.objectContaining({ id: 100, status: 'TAKEN' }),
          ]),
        })
      );

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
      window.showMedicationConfirmModal([1, 2], ['Aspirin', 'Magnesium'], new Date(), 'edit', [100, 101]);
      const checks = document.querySelectorAll('.med-confirm-check');
      checks[1].checked = false;

      window.apiCall = vi.fn().mockResolvedValue({ updated: 1, failed: 0, failures: [] });

      const safeAlertSpy = vi.spyOn(window, 'safeAlert').mockImplementation(() => {});
      const rollbackSpy = vi.spyOn(window, '_rollbackOptimistic');
      const commitSpy = vi.spyOn(window, '_commitOptimistic');
      const refreshSpy = vi.spyOn(window, 'refreshMedsAfterMutation').mockImplementation(() => {});

      await window.updateIntakeHistory();

      expect(commitSpy).toHaveBeenCalled();
      expect(rollbackSpy).not.toHaveBeenCalled();
      const messages = safeAlertSpy.mock.calls.map((c) => c[0]);
      expect(messages).toContain('Updated!');
      expect(refreshSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('clicking the edit-modal action button reverts via /api/intakes/update, not confirm-schedule', async () => {
    const { window, document, cleanup } = loadFrontendEnv();

    try {
      // Edit modal for a single TAKEN dose: Lercanidipine = intake 4851.
      window.showMedicationConfirmModal([7], ['Lercanidipin'], new Date(), 'edit', [4851]);

      // Uncheck it → "Update" must revert that intake to PENDING.
      const checks = document.querySelectorAll('.med-confirm-check');
      checks[0].checked = false;

      const endpoints = [];
      window.apiCall = vi.fn(async (endpoint) => {
        endpoints.push(endpoint);
        if (endpoint === '/api/intakes/update') return { updated: 1, failed: 0, failures: [] };
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

      expect(endpoints).toContain('/api/intakes/update');
      expect(endpoints).not.toContain('/api/medications/confirm-schedule');
    } finally {
      cleanup();
    }
  });

  it('un-checking one med in a TAKEN cluster reverts only that row to Pending after the round-trip', async () => {
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

      // Stateful apiCall: /api/intakes/update mutates serverLogs and reports
      // per-update outcomes (the new handler contract); /api/history echoes the
      // current serverLogs so the post-mutation refresh repaints authoritative
      // state. Everything else (e.g. /api/medications/next-intake) clears.
      window.apiCall = vi.fn(async (endpoint, _method, body) => {
        if (endpoint.startsWith('/api/history')) {
          return serverLogs.map((l) => ({ ...l }));
        }
        if (endpoint === '/api/intakes/update') {
          let updated = 0;
          const failures = [];
          for (const u of (body && body.updates) || []) {
            const row = serverLogs.find((l) => l.id === u.id);
            if (!row) {
              failures.push({ id: u.id, reason: 'not_found_or_forbidden' });
              continue;
            }
            row.status = u.status;
            row.taken_at = u.status === 'TAKEN' ? u.taken_at : null;
            updated += 1;
          }
          return { updated, failed: failures.length, failures };
        }
        return null;
      });

      // Per-key loadSWR: medications resolves to the seeded list; history_* keys
      // route through options.fetcher() so the real /api/history round-trip drives
      // the render, exercising the full uncheck → update → re-render path.
      window.DataStore.loadSWR = vi.fn(async (options) => {
        if (options.key === 'medications') {
          await options.onFresh([
            { id: 1, name: 'Aspirin' },
            { id: 2, name: 'Magnesium' }
          ]);
          return;
        }
        if (typeof options.key === 'string' && options.key.startsWith('history_')) {
          const fresh = await options.fetcher();
          await options.onFresh(fresh);
        }
      });

      // Initial render: one TAKEN cluster covering both meds.
      await window.loadHistory();
      const list = document.getElementById('history-list');
      let groups = Array.from(list.querySelectorAll('.history-group'));
      expect(groups.length).toBe(1);
      expect(groups[0].dataset.status).toBe('TAKEN');

      // Open the edit modal via the group click (real cluster → modal wiring).
      groups[0].click();
      const checks = document.querySelectorAll('.med-confirm-check');
      expect(checks.length).toBe(2);

      // Uncheck Magnesium (index 1 → intake 101) and submit the edit.
      checks[1].checked = false;
      await window.updateIntakeHistory();

      // refreshMedsAfterMutation() already kicks loadHistory(), but await an
      // explicit refresh so the assertion runs against settled server state.
      await window.loadHistory();

      groups = Array.from(document.querySelectorAll('.history-group'));
      const takenRow = groups.find((g) => g.dataset.status === 'TAKEN');
      const pendingRow = groups.find((g) => g.dataset.status === 'PENDING');

      // Aspirin stays Taken; only Magnesium reverted to Pending.
      expect(takenRow).toBeTruthy();
      expect(takenRow.textContent).toContain('Aspirin');
      expect(takenRow.textContent).toContain('✅ Taken');
      expect(takenRow.textContent).not.toContain('Magnesium');

      expect(pendingRow).toBeTruthy();
      expect(pendingRow.textContent).toContain('Magnesium');
      expect(pendingRow.textContent).toContain('⏳ Pending');
      expect(pendingRow.textContent).not.toContain('Aspirin');
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

  it('confirmSelectedMedications POSTs confirm-schedule, commits and shows "Confirmed!"', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const scheduled = new Date().toISOString();
      window.showMedicationConfirmModal([1, 2], ['Aspirin', 'Magnesium'], scheduled, 'confirm', [100, 101]);
      // Both rows are checked by default → both meds confirmed.
      expect(document.querySelectorAll('.med-confirm-check:checked').length).toBe(2);

      window.apiCall = vi.fn().mockResolvedValue({ status: 'ok' });
      const safeAlertSpy = vi.spyOn(window, 'safeAlert').mockImplementation(() => {});
      const commitSpy = vi.spyOn(window, '_commitOptimistic');
      const rollbackSpy = vi.spyOn(window, '_rollbackOptimistic');
      const refreshSpy = vi.spyOn(window, 'refreshMedsAfterMutation').mockImplementation(() => {});
      const closeSpy = vi.spyOn(window, 'closeMedicationConfirmModal');

      await window.confirmSelectedMedications();

      expect(window.apiCall).toHaveBeenCalledWith(
        '/api/medications/confirm-schedule',
        'POST',
        expect.objectContaining({
          scheduled_at: scheduled,
          medication_ids: [1, 2],
          intake_ids: [100, 101]
        })
      );
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
      expect(document.querySelectorAll('.med-confirm-check:checked').length).toBe(1);

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

  it('skipSelectedMedications POSTs /api/medications/skip per intake and shows "Skipped!"', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.showMedicationConfirmModal([1, 2], ['Aspirin', 'Magnesium'], new Date().toISOString(), 'confirm', [100, 101]);

      const endpoints = [];
      window.apiCall = vi.fn(async (endpoint, _method, body) => {
        endpoints.push([endpoint, body]);
        return { ok: true };
      });
      const safeAlertSpy = vi.spyOn(window, 'safeAlert').mockImplementation(() => {});
      const commitSpy = vi.spyOn(window, '_commitOptimistic');
      const refreshSpy = vi.spyOn(window, 'refreshMedsAfterMutation').mockImplementation(() => {});

      await window.skipSelectedMedications();

      const skipCalls = endpoints.filter(([e]) => e === '/api/medications/skip');
      expect(skipCalls.map(([, b]) => b.intake_id).sort()).toEqual([100, 101]);
      expect(commitSpy).toHaveBeenCalled();
      expect(safeAlertSpy.mock.calls.map((c) => c[0])).toContain('Skipped!');
      expect(refreshSpy).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('skipSelectedMedications rolls back and reports an error when a skip POST fails', async () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      window.showMedicationConfirmModal([1], ['Aspirin'], new Date().toISOString(), 'confirm', [100]);

      window.apiCall = vi.fn(async (endpoint) => {
        if (endpoint === '/api/medications/skip') return null; // server rejected the skip
        return [];
      });
      const safeAlertSpy = vi.spyOn(window, 'safeAlert').mockImplementation(() => {});
      const commitSpy = vi.spyOn(window, '_commitOptimistic');
      const rollbackSpy = vi.spyOn(window, '_rollbackOptimistic');
      // skipSelectedMedications refreshes the meds view even on error; stub it
      // so the fire-and-forget loadMeds()/loadHistory() don't reject unhandled
      // against an unseeded DOM.
      vi.spyOn(window, 'refreshMedsAfterMutation').mockImplementation(() => {});

      await window.skipSelectedMedications();

      expect(rollbackSpy).toHaveBeenCalled();
      expect(commitSpy).not.toHaveBeenCalled();
      const messages = safeAlertSpy.mock.calls.map((c) => c[0]);
      expect(messages).toContain('Error skipping some medications.');
      expect(messages).not.toContain('Skipped!');
    } finally {
      cleanup();
    }
  });
});
