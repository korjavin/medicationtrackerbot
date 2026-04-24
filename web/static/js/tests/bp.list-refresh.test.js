// Round-2 Task 5 (defects #7a / #7b) — BP list must reflect add and delete
// without a full page reload.
//
// Exercises the full post-mutation chain end-to-end in jsdom:
//   POST /api/bp   → invalidateTags(['bp']) → loadBPReadings → fresh GETs
//                  → _renderBPData → renderBPReadings → DOM contains new row
//   DELETE /api/bp → same chain, resulting DOM omits the deleted row
//
// Task 1's SW fix (idempotent put() + per-item ConstraintError swallow)
// cleared the way for this chain to complete — before Task 1, an uncaught
// ConstraintError on a duplicate `changes?since` replay aborted the
// post-mutation refresh and the list stayed stale. If a later change re-
// breaks the chain (e.g. swaps `put()` back to `add()` or drops the
// per-item try/catch), this test regresses because the refresh handler
// rejects before reaching _renderBPData.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function isoNow() { return new Date().toISOString(); }

describe('BP list refresh after add + delete (Round-2 Task 5, #7a/#7b)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('list reflects the newly-saved reading after handleBPSubmit (no page reload)', async () => {
        const { window, document } = env;

        // Stub MedTrackerDB so _renderBPData does not mix offline pending
        // rows into the rendered list (keeps assertions deterministic).
        window.MedTrackerDB = {
            BPStore: {
                getPending: async () => [],
                getRejected: async () => []
            }
        };

        let bpReadings = [];
        const goal = { systolic: 120, diastolic: 80 };
        const stats = {};

        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/bp') {
                const newReading = {
                    id: 777,
                    measured_at: isoNow(),
                    systolic: 128,
                    diastolic: 82,
                    pulse: 67,
                    site: 'right_arm',
                    position: 'seated',
                    notes: 'Morning'
                };
                bpReadings = [newReading];
                return newReading;
            }
            if (!method || method === 'GET') {
                if (url.startsWith('/api/bp?days=')) return bpReadings;
                if (url === '/api/bp/goal') return goal;
                if (url === '/api/bp/stats') return stats;
            }
            return null;
        });

        // Prime the initial empty list render.
        await window.loadBPReadings();
        expect(document.querySelectorAll('#bp-list .wg-bp-reading-row').length).toBe(0);

        // Fill form + submit.
        window.showBPRecordModal();
        document.getElementById('bp-datetime').value = '2026-02-27T10:30';
        document.getElementById('bp-systolic').value = '128';
        document.getElementById('bp-diastolic').value = '82';
        document.getElementById('bp-pulse').value = '67';
        document.getElementById('bp-site').value = 'right_arm';
        document.getElementById('bp-position').value = 'seated';
        document.getElementById('bp-notes').value = 'Morning';

        await window.handleBPSubmit({ preventDefault() {} });

        // Post-mutation chain must have run through to renderBPReadings —
        // the new row is now in the DOM without a page reload.
        const rows = document.querySelectorAll('#bp-list .wg-bp-reading-row');
        expect(rows.length).toBe(1);
        expect(rows[0].getAttribute('data-reading-id')).toBe('777');
    });

    it('list removes the deleted reading after _deleteBPApi (no page reload)', async () => {
        const { window, document } = env;

        window.MedTrackerDB = {
            BPStore: {
                getPending: async () => [],
                getRejected: async () => [],
                getAll: async () => [],
                confirmDelete: async () => undefined
            }
        };
        window.SyncManager = { updateStatus: () => {} };

        let bpReadings = [
            { id: 1, measured_at: isoNow(), systolic: 120, diastolic: 78 },
            { id: 2, measured_at: isoNow(), systolic: 128, diastolic: 82 }
        ];

        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'DELETE' && url.startsWith('/api/bp/')) {
                const id = parseInt(url.replace('/api/bp/', ''), 10);
                bpReadings = bpReadings.filter((r) => r.id !== id);
                return true;
            }
            if (!method || method === 'GET') {
                if (url.startsWith('/api/bp?days=')) return bpReadings;
                if (url === '/api/bp/goal') return {};
                if (url === '/api/bp/stats') return {};
            }
            return null;
        });

        // Prime the list with two readings.
        await window.loadBPReadings();
        expect(document.querySelectorAll('#bp-list .wg-bp-reading-row').length).toBe(2);

        // Delete id=1 directly via the private handler (skips safeConfirm).
        await window._deleteBPApi(1);

        const rows = document.querySelectorAll('#bp-list .wg-bp-reading-row');
        expect(rows.length).toBe(1);
        expect(rows[0].getAttribute('data-reading-id')).toBe('2');
    });
});
