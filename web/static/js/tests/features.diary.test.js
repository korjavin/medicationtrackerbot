// Plan 2026-05-17 Task 7 — Optimistic write conversion for diary notes
// handlers in features/health.js. addNote / deleteNote / handleEditNoteSubmit
// must update the cached `diary_notes` payload BEFORE the network round-trip
// resolves, then roll back on POST/DELETE failure.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function installApiCache(window, seed = {}) {
    const map = new Map(Object.entries(seed));
    window.MedTrackerDB = {
        ...(window.MedTrackerDB || {}),
        ApiCache: {
            async get(key) { return map.has(key) ? map.get(key) : null; },
            async set(key, value) { map.set(key, value); },
            async clear(key) { map.delete(key); },
            async keys(prefix) {
                const all = [...map.keys()];
                return typeof prefix === 'string' && prefix
                    ? all.filter((k) => k.startsWith(prefix))
                    : all;
            }
        },
        NotesStore: {
            confirmDelete: async () => undefined
        }
    };
    return map;
}

function deferred() {
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });
    return { promise, resolve: resolveFn, reject: rejectFn };
}

describe('features/health.js — diary notes optimistic write conversion', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('addNote prepends an optimistic row into the cached diary_notes payload before POST resolves', async () => {
        const { window, document } = env;
        const existing = {
            id: 1,
            content: 'previous note',
            tag: null,
            created_at: '2026-05-16T10:00:00.000Z'
        };
        const cache = installApiCache(window, {
            diary_notes: [existing]
        });

        const textarea = document.getElementById('notes-textarea');
        textarea.value = 'felt good today';

        window.loadNotes = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/notes') {
                postCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.addNote();
        await postCalled;

        const notes = cache.get('diary_notes');
        expect(notes).toBeTruthy();
        expect(notes.length).toBe(2);
        // Newly-added note sits at the front of the array (prepended).
        expect(notes[0].content).toBe('felt good today');
        expect(notes[0]._optimistic).toBe(true);
        expect(typeof notes[0].id).toBe('string');
        expect(notes[0].id.startsWith('local_optimistic_')).toBe(true);
        // Existing note survives.
        expect(notes[1].id).toBe(1);

        pending.resolve({ id: 42, content: 'felt good today', tag: null, created_at: '2026-05-17T12:00:00.000Z' });
        await handlerDone;

        // Composer resets on success.
        expect(textarea.value).toBe('');
    });

    it('addNote carries the selected tag into the optimistic row', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, { diary_notes: [] });

        if (typeof window.bindNotesComposer === 'function') window.bindNotesComposer();
        const textarea = document.getElementById('notes-textarea');
        textarea.value = 'slept 8h';
        textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
        const sleepChip = document.getElementById('notes-compose-tags').querySelector('[data-tag="SLEEP"]');
        sleepChip.click();

        window.loadNotes = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/notes') {
                postCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.addNote();
        await postCalled;

        const notes = cache.get('diary_notes');
        expect(notes.length).toBe(1);
        expect(notes[0].content).toBe('slept 8h');
        expect(notes[0].tag).toBe('SLEEP');

        pending.resolve({ id: 7, content: 'slept 8h', tag: 'SLEEP', created_at: '2026-05-17T12:00:00.000Z' });
        await handlerDone;
    });

    it('addNote rolls back the optimistic prepend when the POST returns null', async () => {
        const { window, document } = env;
        const existing = {
            id: 1,
            content: 'survives',
            tag: null,
            created_at: '2026-05-16T10:00:00.000Z'
        };
        const cache = installApiCache(window, {
            diary_notes: [existing]
        });

        const textarea = document.getElementById('notes-textarea');
        textarea.value = 'will fail';

        window.loadNotes = vi.fn();
        window.safeAlert = vi.fn();
        window.apiCall = vi.fn(async () => null);

        await window.addNote();

        const notes = cache.get('diary_notes');
        // Either the prior snapshot is restored (just the existing note) or
        // the cache entry was invalidated; both prove the optimistic add was
        // discarded.
        if (notes) {
            expect(notes.length).toBe(1);
            expect(notes[0].id).toBe(1);
            expect(notes[0].content).toBe('survives');
        }
        // Composer was NOT reset on failure.
        expect(textarea.value).toBe('will fail');
    });

    it('deleteNote removes the matching row from cached diary_notes before DELETE resolves', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            diary_notes: [
                { id: 1, content: 'keep', tag: null, created_at: '2026-05-16T08:00:00.000Z' },
                { id: 2, content: 'delete me', tag: null, created_at: '2026-05-16T09:00:00.000Z' }
            ]
        });

        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
        window.loadNotes = vi.fn();

        let deleteCalledSignal;
        const deleteCalled = new Promise((r) => { deleteCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'DELETE' && url === '/api/notes/2') {
                deleteCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.deleteNote(2);
        await deleteCalled;

        const notes = cache.get('diary_notes');
        expect(notes).toBeTruthy();
        expect(notes.length).toBe(1);
        expect(notes[0].id).toBe(1);

        pending.resolve({ ok: true });
        await handlerDone;
    });

    it('deleteNote rolls back the optimistic filter when the DELETE returns null', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            diary_notes: [
                { id: 1, content: 'keep', tag: null, created_at: '2026-05-16T08:00:00.000Z' },
                { id: 2, content: 'fails to delete', tag: null, created_at: '2026-05-16T09:00:00.000Z' }
            ]
        });

        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
        window.loadNotes = vi.fn();
        window.apiCall = vi.fn(async () => null);

        await window.deleteNote(2);

        const notes = cache.get('diary_notes');
        if (notes) {
            expect(notes.length).toBe(2);
            expect(notes.map((n) => n.id).sort()).toEqual([1, 2]);
        }
    });

    it('deleteNote with a local_ id purges via IndexedDB and skips the server DELETE', async () => {
        const { window } = env;
        installApiCache(window, {
            diary_notes: [
                { id: 1, content: 'numeric', tag: null, created_at: '2026-05-16T08:00:00.000Z' },
                { id: 'local_5', content: 'pending', tag: null, created_at: '2026-05-16T09:00:00.000Z', isLocal: true }
            ]
        });

        const confirmDelete = vi.fn(async () => undefined);
        window.MedTrackerDB.NotesStore.confirmDelete = confirmDelete;

        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
        window.loadNotes = vi.fn();
        window.SyncManager = { updateStatus: vi.fn() };
        // Server DELETE must not be called for local rows.
        const apiCall = vi.fn(async () => null);
        window.apiCall = apiCall;

        await window.deleteNote('local_5');

        // Dexie purge happened, and no /api/notes/* DELETE was issued.
        expect(confirmDelete).toHaveBeenCalledWith(5);
        expect(apiCall.mock.calls.filter((c) => String(c[0]).startsWith('/api/notes')).length).toBe(0);
        expect(window.loadNotes).toHaveBeenCalled();
    });

    it('handleEditNoteSubmit rewrites the targeted row in cached diary_notes before POST resolves', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            diary_notes: [
                { id: 7, content: 'old text', tag: 'SLEEP', created_at: '2026-05-16T08:00:00.000Z' },
                { id: 8, content: 'other note', tag: null, created_at: '2026-05-16T09:00:00.000Z' }
            ]
        });

        window.editNote({ id: 7, content: 'old text', tag: 'SLEEP' });
        const textarea = document.getElementById('note-modal-textarea');
        expect(textarea.value).toBe('old text');
        textarea.value = 'edited text';

        window.loadNotes = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/notes') {
                postCalledSignal();
                return pending.promise;
            }
            if (method === 'DELETE' && url === '/api/notes/7') {
                return { ok: true };
            }
            return null;
        });

        const handlerDone = window.handleEditNoteSubmit({ preventDefault() {} });
        await postCalled;

        const notes = cache.get('diary_notes');
        expect(notes).toBeTruthy();
        expect(notes.length).toBe(2);
        const edited = notes.find((n) => n.id === 7);
        expect(edited.content).toBe('edited text');
        expect(edited._optimistic).toBe(true);
        // POST body carries the new content and inherited tag.
        const postCall = window.apiCall.mock.calls.find((c) => c[0] === '/api/notes' && c[1] === 'POST');
        expect(postCall[2]).toEqual({ content: 'edited text', tag: 'SLEEP' });

        pending.resolve({ id: 99, content: 'edited text', tag: 'SLEEP', created_at: '2026-05-17T12:00:00.000Z' });
        await handlerDone;
    });

    it('handleEditNoteSubmit rolls back when the POST returns null', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            diary_notes: [
                { id: 7, content: 'original text', tag: null, created_at: '2026-05-16T08:00:00.000Z' }
            ]
        });

        window.editNote({ id: 7, content: 'original text', tag: null });
        const textarea = document.getElementById('note-modal-textarea');
        textarea.value = 'will fail';

        window.loadNotes = vi.fn();
        window.safeAlert = vi.fn();
        window.apiCall = vi.fn(async () => null);

        await window.handleEditNoteSubmit({ preventDefault() {} });

        const notes = cache.get('diary_notes');
        if (notes) {
            expect(notes.length).toBe(1);
            expect(notes[0].id).toBe(7);
            expect(notes[0].content).toBe('original text');
        }
    });
});
