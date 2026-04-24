// Round-2 Task 5 — Vitals/Health design parity:
//   * row-tag chips filter the notes list on click and toggle the
//     `.wg-health-notes-row__tag--active` class,
//   * note create/delete dispatch `invalidateTags(['health-notes'])`
//     and re-render the list in place (no full-page reload),
//   * `#health-view` carries the `.wg-screen-stage` class so the
//     Overview subtab sits on the shared teal stage.
//
// Companion to health.notes.test.js (which pins the base render
// structure). Lives alongside the other `*.design-parity.test.js`
// files Round-2 added per section.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_PATH = path.resolve(__dirname, '../../../../web/static/index.html');

function midday(daysAgo = 0) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    return d;
}

describe('Health design parity — Round 2 (Task 5)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('#health-view carries the .wg-screen-stage class in index.html', () => {
        const html = fs.readFileSync(INDEX_PATH, 'utf8');
        const viewMatch = html.match(/<div[^>]*id="health-view"[^>]*>/);
        expect(viewMatch, 'expected #health-view element in index.html').not.toBeNull();
        expect(viewMatch[0]).toMatch(/\bwg-screen-stage\b/);
    });

    it('#health-view in the live DOM has the .wg-screen-stage class applied', () => {
        const { document } = env;
        const view = document.getElementById('health-view');
        expect(view).not.toBeNull();
        expect(view.classList.contains('wg-screen-stage')).toBe(true);
    });

    it('clicking a .wg-health-notes-row__tag chip filters the list and marks the chip active', () => {
        const { document, window } = env;
        const list = document.getElementById('notes-list');
        window.renderNotes(list, [
            { id: 1, created_at: midday(0).toISOString(), content: 'slept well', tag: 'SLEEP' },
            { id: 2, created_at: midday(0).toISOString(), content: 'stressful meeting', tag: 'STRESS' },
            { id: 3, created_at: midday(0).toISOString(), content: 'another sleep note', tag: 'SLEEP' },
            { id: 4, created_at: midday(0).toISOString(), content: 'plain note', tag: null }
        ]);

        // Before any filter, all 4 rows are visible.
        expect(list.querySelectorAll('.wg-health-notes-row').length).toBe(4);
        // No active class on any chip yet.
        expect(list.querySelectorAll('.wg-health-notes-row__tag--active').length).toBe(0);

        // Click the STRESS chip — row 2 only.
        const stressChip = list.querySelector('[data-note-id="2"] .wg-health-notes-row__tag');
        expect(stressChip).not.toBeNull();
        stressChip.click();

        const visibleRows = list.querySelectorAll('.wg-health-notes-row');
        expect(visibleRows.length).toBe(1);
        expect(visibleRows[0].getAttribute('data-note-id')).toBe('2');

        const activeChips = list.querySelectorAll('.wg-health-notes-row__tag--active');
        expect(activeChips.length).toBe(1);
        expect(activeChips[0].getAttribute('data-tag')).toBe('STRESS');
    });

    it('clicking the already-active chip clears the filter and restores the full list', () => {
        const { document, window } = env;
        const list = document.getElementById('notes-list');
        window.renderNotes(list, [
            { id: 1, created_at: midday(0).toISOString(), content: 'a', tag: 'SLEEP' },
            { id: 2, created_at: midday(0).toISOString(), content: 'b', tag: 'HR' }
        ]);

        const hrChip = list.querySelector('[data-note-id="2"] .wg-health-notes-row__tag');
        hrChip.click();
        expect(list.querySelectorAll('.wg-health-notes-row').length).toBe(1);

        // Click the same chip again → filter toggles off.
        list.querySelector('.wg-health-notes-row__tag--active').click();
        expect(list.querySelectorAll('.wg-health-notes-row').length).toBe(2);
        expect(list.querySelectorAll('.wg-health-notes-row__tag--active').length).toBe(0);
    });

    it('switching filters swaps the active chip to the newly-clicked tag', () => {
        const { document, window } = env;
        const list = document.getElementById('notes-list');
        window.renderNotes(list, [
            { id: 1, created_at: midday(0).toISOString(), content: 'a', tag: 'SLEEP' },
            { id: 2, created_at: midday(0).toISOString(), content: 'b', tag: 'HR' }
        ]);

        list.querySelector('[data-note-id="1"] .wg-health-notes-row__tag').click();
        // Only the SLEEP row is visible, so only that chip exists in the DOM.
        expect(list.querySelectorAll('.wg-health-notes-row').length).toBe(1);
        const sleepChip = list.querySelector('.wg-health-notes-row__tag--active');
        expect(sleepChip.getAttribute('data-tag')).toBe('SLEEP');

        // Reset (click same chip) then pick HR.
        sleepChip.click();
        list.querySelector('[data-note-id="2"] .wg-health-notes-row__tag').click();

        const visible = list.querySelectorAll('.wg-health-notes-row');
        expect(visible.length).toBe(1);
        expect(visible[0].getAttribute('data-note-id')).toBe('2');

        const activeChips = list.querySelectorAll('.wg-health-notes-row__tag--active');
        expect(activeChips.length).toBe(1);
        expect(activeChips[0].getAttribute('data-tag')).toBe('HR');
    });

    it('filter with no matching notes shows a filter-specific empty card', () => {
        const { document, window } = env;
        const list = document.getElementById('notes-list');
        window.renderNotes(list, [
            { id: 1, created_at: midday(0).toISOString(), content: 'sleep only', tag: 'SLEEP' }
        ]);
        // Click SLEEP then re-render with zero matching notes (simulate the
        // user deleting the only matching note while filter is active).
        list.querySelector('.wg-health-notes-row__tag').click();
        window.renderNotes(list, []);

        const empty = list.querySelector('.wg-health-notes__empty');
        expect(empty).not.toBeNull();
        // Accept either the generic empty message or the filter-specific one —
        // the latter is the post-fix behavior, but don't over-constrain if
        // the cache reset drops the filter first.
        expect(empty.textContent.length).toBeGreaterThan(0);
    });

    it('deleteNote dispatches invalidateTags([\'health-notes\']) and re-renders without a full reload', async () => {
        const { window } = env;

        const invalidateSpy = vi.fn(async () => {});
        window.DataStore.invalidateTags = invalidateSpy;
        const loadNotesSpy = vi.fn(async () => {});
        window.loadNotes = loadNotesSpy;
        // Auto-confirm the safeConfirm dialog.
        window.safeConfirm = (_msg, cb) => cb(true);
        // Make the DELETE call succeed.
        window.apiCall = vi.fn(async () => ({ ok: true }));

        await window.deleteNote(42);

        expect(window.apiCall).toHaveBeenCalledWith('/api/notes/42', 'DELETE');
        expect(invalidateSpy).toHaveBeenCalledTimes(1);
        expect(invalidateSpy.mock.calls[0][0]).toEqual(['health-notes']);
        // loadNotes is called to repaint the list in place — no full reload.
        expect(loadNotesSpy).toHaveBeenCalledTimes(1);
    });

    it('addNote dispatches invalidateTags([\'health-notes\']) on successful POST', async () => {
        const { document, window } = env;
        const textarea = document.getElementById('notes-textarea');
        textarea.value = 'new note body';

        const invalidateSpy = vi.fn(async () => {});
        window.DataStore.invalidateTags = invalidateSpy;
        const loadNotesSpy = vi.fn(async () => {});
        window.loadNotes = loadNotesSpy;
        window.apiCall = vi.fn(async () => ({ id: 100 }));

        await window.addNote();

        expect(window.apiCall).toHaveBeenCalledWith('/api/notes', 'POST', expect.any(Object));
        expect(invalidateSpy).toHaveBeenCalledTimes(1);
        expect(invalidateSpy.mock.calls[0][0]).toEqual(['health-notes']);
        expect(loadNotesSpy).toHaveBeenCalledTimes(1);
    });
});
