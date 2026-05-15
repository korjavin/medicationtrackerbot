import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncEnv } from './helpers/sync-harness.js';

// Build a mock store that records every method call so tests can assert
// the factory invoked the right lifecycle method (confirmDelete vs
// markSynced, markError vs markRejected, etc.).
function makeMockStore({ pending = [], all = [] } = {}) {
  const calls = {
    getPending: 0,
    getAll: 0,
    save: [],
    confirmDelete: [],
    markSynced: [],
    markError: [],
    markRejected: []
  };
  return {
    calls,
    async getPending() { calls.getPending += 1; return pending; },
    async getAll() { calls.getAll += 1; return all; },
    async save(body) {
      calls.save.push(body);
      return { localId: 100 + calls.save.length };
    },
    async confirmDelete(id) { calls.confirmDelete.push(id); },
    async markSynced(id) { calls.markSynced.push(id); },
    async markError(id, msg) { calls.markError.push({ id, msg }); },
    async markRejected(id, msg) { calls.markRejected.push({ id, msg }); }
  };
}

function makeBPLikeConfig(store) {
  return {
    name: 'BP',
    store,
    endpoint: '/api/bp',
    buildPayload: r => ({
      measured_at: r.measured_at,
      systolic: r.systolic,
      diastolic: r.diastolic
    }),
    onSuccess: (localId, result, s) => s.confirmDelete(localId),
    backgroundSyncTag: 'sync-bp-readings',
    toastSingular: 'BP reading saved locally'
  };
}

describe('defineOfflineEntity factory', () => {
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

  it('exposes defineOfflineEntity on window', () => {
    const { window, cleanup } = loadSyncEnv();
    try {
      expect(typeof window.defineOfflineEntity).toBe('function');
      const entity = window.defineOfflineEntity(makeBPLikeConfig(makeMockStore()));
      expect(entity).toMatchObject({
        syncPending: expect.any(Function),
        handleOfflineWrite: expect.any(Function),
        handleOfflineRead: expect.any(Function)
      });
    } finally {
      cleanup();
    }
  });

  describe('syncPending', () => {
    it('drains queue on success and calls onSuccess (BP-style confirmDelete)', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const pending = [
          { localId: 1, measured_at: '2026-01-01T00:00:00Z', systolic: 120, diastolic: 80 },
          { localId: 2, measured_at: '2026-01-02T00:00:00Z', systolic: 130, diastolic: 85 }
        ];
        const store = makeMockStore({ pending });
        const apiCalls = [];
        window.apiCallDirect = vi.fn(async (ep, method, payload) => {
          apiCalls.push({ ep, method, payload });
          return { id: 500 + apiCalls.length };
        });
        const updateSpy = vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

        const entity = window.defineOfflineEntity(makeBPLikeConfig(store));
        window.SyncManager.isOnline = true;
        await entity.syncPending();

        expect(apiCalls).toEqual([
          { ep: '/api/bp', method: 'POST', payload: { measured_at: '2026-01-01T00:00:00Z', systolic: 120, diastolic: 80 } },
          { ep: '/api/bp', method: 'POST', payload: { measured_at: '2026-01-02T00:00:00Z', systolic: 130, diastolic: 85 } }
        ]);
        expect(store.calls.confirmDelete).toEqual([1, 2]);
        expect(store.calls.markError).toEqual([]);
        expect(store.calls.markRejected).toEqual([]);
        expect(updateSpy).toHaveBeenCalledTimes(1);
      } finally {
        cleanup();
      }
    });

    it('drains queue on success and calls onSuccess (intake-style markSynced)', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const pending = [
          { localId: 7, scheduled_at: '2026-01-01T00:00:00Z', medication_ids: [1, 2], intake_ids: [] }
        ];
        const store = makeMockStore({ pending });
        // Intake endpoint returns ok without `id`.
        window.apiCallDirect = vi.fn().mockResolvedValue({ ok: true });
        vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

        const entity = window.defineOfflineEntity({
          name: 'intake',
          store,
          endpoint: '/api/medications/confirm-schedule',
          buildPayload: r => ({
            scheduled_at: r.scheduled_at,
            medication_ids: r.medication_ids,
            intake_ids: r.intake_ids || []
          }),
          onSuccess: (localId, _r, s) => s.markSynced(localId),
          backgroundSyncTag: 'sync-intake-logs',
          toastSingular: 'Medication confirmed locally'
        });

        window.SyncManager.isOnline = true;
        await entity.syncPending();

        expect(store.calls.markSynced).toEqual([7]);
        expect(store.calls.confirmDelete).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('marks transient errors with markError so they retry', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const pending = [{ localId: 9, measured_at: '2026-01-01T00:00:00Z', systolic: 140 }];
        const store = makeMockStore({ pending });
        // No status code -> transient (network error)
        window.apiCallDirect = vi.fn().mockRejectedValue(new Error('network down'));
        vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

        const entity = window.defineOfflineEntity(makeBPLikeConfig(store));
        window.SyncManager.isOnline = true;
        await entity.syncPending();

        expect(store.calls.markError).toEqual([{ id: 9, msg: 'network down' }]);
        expect(store.calls.markRejected).toEqual([]);
        expect(store.calls.confirmDelete).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('marks 4xx errors with markRejected so they do not retry', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const pending = [{ localId: 12, measured_at: '2026-01-01T00:00:00Z', systolic: 150 }];
        const store = makeMockStore({ pending });
        const err = new Error('Bad Request');
        err.status = 400;
        window.apiCallDirect = vi.fn().mockRejectedValue(err);
        vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

        const entity = window.defineOfflineEntity(makeBPLikeConfig(store));
        window.SyncManager.isOnline = true;
        await entity.syncPending();

        expect(store.calls.markRejected).toEqual([{ id: 12, msg: 'Bad Request' }]);
        expect(store.calls.markError).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('treats 401/403/408/429 as transient (markError, not markRejected)', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const transientStatuses = [401, 403, 408, 429];
        for (const status of transientStatuses) {
          const store = makeMockStore({
            pending: [{ localId: 1, measured_at: '2026-01-01T00:00:00Z', systolic: 130 }]
          });
          const err = new Error(`status ${status}`);
          err.status = status;
          window.apiCallDirect = vi.fn().mockRejectedValue(err);
          vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

          const entity = window.defineOfflineEntity(makeBPLikeConfig(store));
          window.SyncManager.isOnline = true;
          await entity.syncPending();

          expect(store.calls.markError.length, `status ${status} should be transient`).toBe(1);
          expect(store.calls.markRejected.length).toBe(0);
        }
      } finally {
        cleanup();
      }
    });

    it('throws "No response from server" when API returns falsy', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const pending = [{ localId: 22, measured_at: '2026-01-01T00:00:00Z', systolic: 110 }];
        const store = makeMockStore({ pending });
        window.apiCallDirect = vi.fn().mockResolvedValue(null);
        vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

        const entity = window.defineOfflineEntity(makeBPLikeConfig(store));
        window.SyncManager.isOnline = true;
        await entity.syncPending();

        expect(store.calls.markError).toEqual([{ id: 22, msg: 'No response from server' }]);
        expect(store.calls.confirmDelete).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('is a no-op when queue is empty', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const store = makeMockStore({ pending: [] });
        window.apiCallDirect = vi.fn();
        const updateSpy = vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

        const entity = window.defineOfflineEntity(makeBPLikeConfig(store));
        window.SyncManager.isOnline = true;
        await entity.syncPending();

        expect(window.apiCallDirect).not.toHaveBeenCalled();
        expect(updateSpy).not.toHaveBeenCalled();
        expect(store.calls.confirmDelete).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('is a no-op when offline', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const store = makeMockStore({
          pending: [{ localId: 1, measured_at: '2026-01-01T00:00:00Z', systolic: 120 }]
        });
        window.apiCallDirect = vi.fn();

        const entity = window.defineOfflineEntity(makeBPLikeConfig(store));
        window.SyncManager.isOnline = false;
        await entity.syncPending();

        expect(store.calls.getPending).toBe(0);
        expect(window.apiCallDirect).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('skips when store getter resolves to null (intake-style optional store)', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const config = makeBPLikeConfig(() => null);
        const entity = window.defineOfflineEntity(config);
        window.SyncManager.isOnline = true;
        // Should not throw.
        await entity.syncPending();
      } finally {
        cleanup();
      }
    });

    it('continues processing remaining entries after one fails', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const pending = [
          { localId: 1, measured_at: '2026-01-01T00:00:00Z', systolic: 120 },
          { localId: 2, measured_at: '2026-01-02T00:00:00Z', systolic: 130 },
          { localId: 3, measured_at: '2026-01-03T00:00:00Z', systolic: 140 }
        ];
        const store = makeMockStore({ pending });
        const permErr = new Error('Forbidden by server');
        permErr.status = 422;
        window.apiCallDirect = vi.fn()
          .mockResolvedValueOnce({ id: 1001 })
          .mockRejectedValueOnce(permErr)
          .mockResolvedValueOnce({ id: 1003 });
        vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

        const entity = window.defineOfflineEntity(makeBPLikeConfig(store));
        window.SyncManager.isOnline = true;
        await entity.syncPending();

        expect(store.calls.confirmDelete).toEqual([1, 3]);
        expect(store.calls.markRejected).toEqual([{ id: 2, msg: 'Forbidden by server' }]);
      } finally {
        cleanup();
      }
    });
  });

  describe('handleOfflineWrite', () => {
    it('saves body, registers background sync, shows toast, returns mock response', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const store = makeMockStore();
        const registerSpy = vi.spyOn(window.SyncManager, 'registerBackgroundSync').mockResolvedValue(undefined);
        const toastSpy = vi.spyOn(window.SyncManager, 'showToast').mockImplementation(() => {});
        const updateSpy = vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

        const entity = window.defineOfflineEntity(makeBPLikeConfig(store));
        const body = { measured_at: '2026-02-27T10:00:00Z', systolic: 125, diastolic: 82 };
        const result = await entity.handleOfflineWrite(body);

        expect(store.calls.save).toEqual([body]);
        expect(registerSpy).toHaveBeenCalledWith('sync-bp-readings');
        expect(toastSpy).toHaveBeenCalledWith(
          'BP reading saved locally — will sync when online',
          'info'
        );
        expect(updateSpy).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
          measured_at: '2026-02-27T10:00:00Z',
          systolic: 125,
          diastolic: 82,
          id: 'local_101',
          localId: 101,
          isLocal: true
        });
      } finally {
        cleanup();
      }
    });

    it('applies prepareOfflineEntry to transform body before save', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const store = makeMockStore();
        vi.spyOn(window.SyncManager, 'registerBackgroundSync').mockResolvedValue(undefined);
        vi.spyOn(window.SyncManager, 'showToast').mockImplementation(() => {});
        vi.spyOn(window.SyncManager, 'updateStatus').mockResolvedValue(undefined);

        const entity = window.defineOfflineEntity({
          name: 'intake',
          store,
          endpoint: '/api/medications/confirm-schedule',
          buildPayload: r => r,
          onSuccess: (id, _r, s) => s.markSynced(id),
          backgroundSyncTag: 'sync-intake-logs',
          toastSingular: 'Medication confirmed locally',
          prepareOfflineEntry: body => ({
            scheduled_at: body.scheduled_at,
            medication_ids: body.medication_ids,
            intake_ids: body.intake_ids || [],
            taken_at: 'frozen-now'
          })
        });

        const body = {
          scheduled_at: '2026-02-27T12:00:00Z',
          medication_ids: [1, 2],
          intake_ids: [10]
        };
        const result = await entity.handleOfflineWrite(body);

        expect(store.calls.save).toEqual([
          {
            scheduled_at: '2026-02-27T12:00:00Z',
            medication_ids: [1, 2],
            intake_ids: [10],
            taken_at: 'frozen-now'
          }
        ]);
        // Returned response spreads the original body, not the prepared row.
        expect(result).toMatchObject({
          scheduled_at: '2026-02-27T12:00:00Z',
          medication_ids: [1, 2],
          intake_ids: [10],
          id: 'local_101',
          localId: 101,
          isLocal: true
        });
        expect(result.taken_at).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    it('returns null when store getter resolves to null', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const entity = window.defineOfflineEntity(makeBPLikeConfig(() => null));
        const result = await entity.handleOfflineWrite({ systolic: 120 });
        expect(result).toBeNull();
      } finally {
        cleanup();
      }
    });
  });

  describe('handleOfflineRead', () => {
    it('maps store entries to {id, ...row, isLocal} shape', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const store = makeMockStore({
          all: [
            { localId: 1, serverId: null, systolic: 120, syncStatus: 'pending' },
            { localId: 2, serverId: 555, systolic: 130, syncStatus: 'synced' }
          ]
        });
        const entity = window.defineOfflineEntity(makeBPLikeConfig(store));
        const result = await entity.handleOfflineRead();
        expect(result).toEqual([
          { id: 'local_1', localId: 1, serverId: null, systolic: 120, syncStatus: 'pending', isLocal: true },
          { id: 555, localId: 2, serverId: 555, systolic: 130, syncStatus: 'synced', isLocal: false }
        ]);
      } finally {
        cleanup();
      }
    });

    it('returns empty array when store getter resolves to null', async () => {
      const { window, cleanup } = loadSyncEnv();
      try {
        const entity = window.defineOfflineEntity(makeBPLikeConfig(() => null));
        const result = await entity.handleOfflineRead();
        expect(result).toEqual([]);
      } finally {
        cleanup();
      }
    });
  });
});
