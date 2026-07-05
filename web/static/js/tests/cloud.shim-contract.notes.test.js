// Plan 2026-07-05 cloud-c2a, Task 5 — shim-mode contract run of the diary
// notes feature against web/domain/notes.js. Drives the real feature code
// (addNote / loadNotes / deleteNote in features/health.js) through the real
// window.apiCall (core/api.js), which delegates to the cloud shim
// (web/cloud/js/apishim.js) instead of the network. Additive suite — the
// original (network-mocked) health.notes.test.js keeps running unshimmed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installApiCache, loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

describe('cloud shim contract — notes flows (features/health.js over web/domain/notes.js)', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
        env.window.SyncManager = { isOnline: true, updateStatus: () => {} };
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('addNote persists through the shim and loadNotes repaints the list newest-first', async () => {
        const { window, document } = env;
        if (typeof window.bindNotesComposer === 'function') window.bindNotesComposer();

        const textarea = document.getElementById('notes-textarea');
        textarea.value = 'first note';
        textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
        await window.addNote();
        await new Promise((resolve) => setTimeout(resolve, 0));

        textarea.value = 'second note';
        textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
        const sleepChip = document.getElementById('notes-compose-tags').querySelector('[data-tag="SLEEP"]');
        sleepChip.click();
        await window.addNote();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const list = await window.apiCall('/api/notes?limit=50', 'GET');
        expect(list).toHaveLength(2);
        expect(list[0].content).toBe('second note');
        expect(list[0].tag).toBe('SLEEP');
        expect(list[1].content).toBe('first note');

        const rows = document.getElementById('notes-list').querySelectorAll('.wg-health-notes-row');
        expect(rows.length).toBe(2);
    });

    it('emits numeric ids so before_id pagination advances past page 1', async () => {
        const { window } = env;
        // Two pages worth (>50). Ids must be numeric for the frontend's
        // `_notesCursor > 0` gate and the shim's before_id keyset to work.
        for (let i = 0; i < 55; i++) {
            await window.apiCall('/api/notes', 'POST', { content: `note ${i}` });
        }

        const page1 = await window.apiCall('/api/notes?limit=50', 'GET');
        expect(page1).toHaveLength(50);
        const cursor = page1[page1.length - 1].id;
        expect(Number(cursor) > 0).toBe(true);

        const page2 = await window.apiCall(`/api/notes?limit=50&before_id=${cursor}`, 'GET');
        expect(page2).toHaveLength(5);
        // No overlap between pages — the cursor actually advanced.
        expect(page2.map((n) => n.id)).not.toContain(cursor);
    });

    it('deleteNote removes the note from the shim-backed store', async () => {
        const { window, document } = env;
        const created = await window.apiCall('/api/notes', 'POST', { content: 'to be removed' });

        window.safeConfirm = async (msg, cb) => { await cb(true); };
        await window.deleteNote(created.id);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const list = await window.apiCall('/api/notes?limit=50', 'GET');
        expect(list).toHaveLength(0);
    });
});
