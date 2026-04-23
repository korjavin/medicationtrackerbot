// Wandergeek Edit-note modal tests (Phase 8, Task 8).
//
// Covers the new `#note-modal` shell:
//   • markup uses `.wg-modal` + `.wg-health-modal__*` wrappers with a
//     dual-line eyebrow + mono title, top-right `.wg-icon-btn` close,
//     gloss-inset textarea wrap, and a Cancel + Save action bar where Save
//     carries 2× flex per modal-button-order convention.
//   • opening via editNote(note) populates the textarea, sets the title to
//     "Edit note", and reveals the modal.
//   • cancel button + close icon both close the modal (modal-controller
//     history wiring preserved via the modal-overlay class change).
//   • submit POSTs the new content first, then DELETEs the original — the
//     happy path closes the modal, invalidates the notes tag, and reloads.
//   • a failed POST does NOT issue the DELETE and leaves the modal open so
//     the user can retry without losing the original note.
//   • round-trip: editing a note prefills the textarea with its content;
//     submitting an unchanged value short-circuits without a network call.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_PATH = path.resolve(__dirname, '../../../../web/static/index.html');
const CSS_PATH = path.resolve(__dirname, '../../../../web/static/css/styles.css');

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Edit-note modal (Phase 8, Task 8)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    describe('markup (index.html)', () => {
        it('note-modal uses the generic .wg-modal + .wg-health-modal shell', () => {
            const html = fs.readFileSync(INDEX_PATH, 'utf8');
            const m = html.match(/<mt-modal[^>]*id="note-modal"[^>]*>/);
            expect(m, 'expected #note-modal declaration').not.toBeNull();
            expect(m[0]).toMatch(/wg-modal/);
            expect(m[0]).toMatch(/wg-health-modal/);
            expect(m[0]).toMatch(/\bhidden\b/);
        });

        it('renders mono header, close icon-btn, gloss-inset textarea wrap, and action bar', () => {
            const { document } = env;
            const modal = document.getElementById('note-modal');
            expect(modal).not.toBeNull();

            const header = modal.querySelector('.wg-health-modal__header');
            expect(header).not.toBeNull();

            const eyebrow = document.getElementById('note-modal-eyebrow');
            expect(eyebrow).not.toBeNull();
            expect(eyebrow.classList.contains('wg-section-label')).toBe(true);
            expect(eyebrow.classList.contains('wg-health-modal__eyebrow')).toBe(true);

            const title = document.getElementById('note-modal-title');
            expect(title).not.toBeNull();
            expect(title.classList.contains('wg-mono-display')).toBe(true);
            expect(title.classList.contains('wg-health-modal__title')).toBe(true);

            const close = document.getElementById('note-modal-close-btn');
            expect(close).not.toBeNull();
            expect(close.classList.contains('wg-icon-btn')).toBe(true);
            expect(close.querySelector('.wg-gloss')).not.toBeNull();

            const textarea = document.getElementById('note-modal-textarea');
            expect(textarea).not.toBeNull();
            expect(textarea.tagName).toBe('TEXTAREA');
            expect(textarea.parentElement.classList.contains('wg-gloss--inset')).toBe(true);
            expect(textarea.parentElement.classList.contains('wg-health-modal__input-wrap')).toBe(true);

            const cancelBtn = document.getElementById('note-modal-cancel-btn');
            const saveBtn = document.getElementById('note-modal-save-btn');
            expect(cancelBtn).not.toBeNull();
            expect(saveBtn).not.toBeNull();
            expect(cancelBtn.classList.contains('wg-gloss')).toBe(true);
            expect(cancelBtn.classList.contains('wg-gloss--sun')).toBe(false);
            expect(saveBtn.classList.contains('wg-gloss')).toBe(true);
            expect(saveBtn.classList.contains('wg-gloss--sun')).toBe(true);
            expect(saveBtn.getAttribute('type')).toBe('submit');
            expect(saveBtn.getAttribute('form')).toBe('note-form');

            const actions = modal.querySelector('.wg-health-modal__actions');
            expect(actions).not.toBeNull();
            // Cancel left, Save right.
            expect(actions.firstElementChild).toBe(cancelBtn);
            expect(actions.lastElementChild).toBe(saveBtn);
        });

        it('styles.css gives Save 2× flex vs. Cancel in the action bar', () => {
            const css = fs.readFileSync(CSS_PATH, 'utf8');
            expect(css).toMatch(/\.wg-health-modal__action--cancel\s*\{\s*flex:\s*1\s+1\s+0/);
            expect(css).toMatch(/\.wg-health-modal__action--save\s*\{\s*flex:\s*2\s+1\s+0/);
        });

        it('styles.css registers the .wg-health-modal__* rules', () => {
            const css = fs.readFileSync(CSS_PATH, 'utf8');
            expect(css).toMatch(/\.wg-health-modal__header\s*\{/);
            expect(css).toMatch(/\.wg-health-modal__heading\s*\{/);
            expect(css).toMatch(/\.wg-health-modal__title\s*\{/);
            expect(css).toMatch(/\.wg-health-modal__body\s*\{/);
            expect(css).toMatch(/\.wg-health-modal__input-wrap\s*\{/);
            expect(css).toMatch(/\.wg-health-modal__textarea\s*\{/);
            expect(css).toMatch(/\.wg-health-modal__actions\s*\{/);
        });
    });

    describe('editNote()', () => {
        it('opens the modal, sets the Edit-note title, and prefills the textarea', () => {
            const { window, document } = env;
            window.editNote({ id: 42, content: 'felt good after run' });

            expect(document.getElementById('note-modal').classList.contains('hidden')).toBe(false);
            expect(document.getElementById('note-modal-title').textContent).toBe('Edit note');
            expect(document.getElementById('note-modal-textarea').value).toBe('felt good after run');
        });

        it('handles a note with empty content gracefully', () => {
            const { window, document } = env;
            window.editNote({ id: 7, content: '' });
            expect(document.getElementById('note-modal').classList.contains('hidden')).toBe(false);
            expect(document.getElementById('note-modal-textarea').value).toBe('');
        });
    });

    describe('cancel + close wiring', () => {
        it('cancel button closes the modal', () => {
            const { window, document } = env;
            window.editNote({ id: 1, content: 'hi' });
            expect(document.getElementById('note-modal').classList.contains('hidden')).toBe(false);
            document.getElementById('note-modal-cancel-btn').click();
            expect(document.getElementById('note-modal').classList.contains('hidden')).toBe(true);
        });

        it('close icon-btn also closes the modal', () => {
            const { window, document } = env;
            window.editNote({ id: 1, content: 'hi' });
            expect(document.getElementById('note-modal').classList.contains('hidden')).toBe(false);
            document.getElementById('note-modal-close-btn').click();
            expect(document.getElementById('note-modal').classList.contains('hidden')).toBe(true);
        });

        it('opening the modal toggles the modal-overlay (modal-controller history wiring)', () => {
            const { window, document } = env;
            window.editNote({ id: 1, content: 'hi' });
            expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(false);

            // Simulate the Telegram BackButton flow.
            window.ModalManager.closeTopMostVisibleModal();
            expect(document.getElementById('note-modal').classList.contains('hidden')).toBe(true);
        });
    });

    describe('handleEditNoteSubmit()', () => {
        it('POSTs the replacement, DELETEs the original, invalidates notes, and closes the modal', async () => {
            const { window, document } = env;
            const apiCallSpy = vi.fn().mockResolvedValue({ id: 99 });
            const invalidateSpy = vi.fn().mockResolvedValue(undefined);
            const loadNotesSpy = vi.fn();

            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = invalidateSpy;
            window.loadNotes = loadNotesSpy;

            window.editNote({ id: 17, content: 'first version' });
            document.getElementById('note-modal-textarea').value = 'second version';

            await window.handleEditNoteSubmit({ preventDefault() {} });

            expect(apiCallSpy).toHaveBeenCalledTimes(2);
            const [postUrl, postMethod, postPayload] = apiCallSpy.mock.calls[0];
            expect(postUrl).toBe('/api/notes');
            expect(postMethod).toBe('POST');
            expect(postPayload).toEqual({ content: 'second version' });

            const [delUrl, delMethod] = apiCallSpy.mock.calls[1];
            expect(delUrl).toBe('/api/notes/17');
            expect(delMethod).toBe('DELETE');

            expect(invalidateSpy).toHaveBeenCalledWith(['notes']);
            expect(loadNotesSpy).toHaveBeenCalledTimes(1);
            expect(document.getElementById('note-modal').classList.contains('hidden')).toBe(true);
        });

        it('skips the DELETE when POST fails so the original note is not lost', async () => {
            const { window, document } = env;
            const apiCallSpy = vi.fn().mockResolvedValueOnce(null);
            const invalidateSpy = vi.fn().mockResolvedValue(undefined);
            const loadNotesSpy = vi.fn();

            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = invalidateSpy;
            window.loadNotes = loadNotesSpy;

            window.editNote({ id: 21, content: 'original' });
            document.getElementById('note-modal-textarea').value = 'edited';

            await window.handleEditNoteSubmit({ preventDefault() {} });

            expect(apiCallSpy).toHaveBeenCalledTimes(1);
            expect(apiCallSpy.mock.calls[0][1]).toBe('POST');
            expect(invalidateSpy).not.toHaveBeenCalled();
            expect(loadNotesSpy).not.toHaveBeenCalled();
            // Modal stays open so the user can retry.
            expect(document.getElementById('note-modal').classList.contains('hidden')).toBe(false);
        });

        it('does not POST when the textarea is empty and surfaces an alert', async () => {
            const { window, document } = env;
            const apiCallSpy = vi.fn();
            window.apiCall = apiCallSpy;
            window.safeAlert = vi.fn();

            window.editNote({ id: 33, content: 'something' });
            document.getElementById('note-modal-textarea').value = '   ';

            await window.handleEditNoteSubmit({ preventDefault() {} });

            expect(apiCallSpy).not.toHaveBeenCalled();
            expect(window.safeAlert).toHaveBeenCalled();
        });

        it('short-circuits when content is unchanged — no network calls, modal still closes', async () => {
            const { window, document } = env;
            const apiCallSpy = vi.fn();
            window.apiCall = apiCallSpy;

            window.editNote({ id: 44, content: 'unchanged' });
            // Textarea is already prefilled to 'unchanged' by editNote().

            await window.handleEditNoteSubmit({ preventDefault() {} });

            expect(apiCallSpy).not.toHaveBeenCalled();
            expect(document.getElementById('note-modal').classList.contains('hidden')).toBe(true);
        });

        it('clicking Save submits the form (form/submit wiring)', async () => {
            const { window, document } = env;
            const apiCallSpy = vi.fn().mockResolvedValue({ id: 100 });
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
            window.loadNotes = vi.fn();

            window.editNote({ id: 55, content: 'old body' });
            document.getElementById('note-modal-textarea').value = 'new body';

            const form = document.getElementById('note-form');
            const submitEvent = new window.Event('submit', { bubbles: true, cancelable: true });
            form.dispatchEvent(submitEvent);

            await flushPromises();
            await flushPromises();

            expect(apiCallSpy).toHaveBeenCalled();
            expect(apiCallSpy.mock.calls[0][1]).toBe('POST');
        });
    });

    describe('local (pending) edit', () => {
        it('purges IndexedDB on a local note edit instead of issuing a DELETE request', async () => {
            const { window, document } = env;
            const apiCallSpy = vi.fn().mockResolvedValue({ id: 200 });
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
            window.loadNotes = vi.fn();

            const confirmDeleteSpy = vi.fn().mockResolvedValue(undefined);
            window.MedTrackerDB = { NotesStore: { confirmDelete: confirmDeleteSpy } };
            window.SyncManager = { updateStatus: vi.fn() };

            window.editNote({ id: 'local_88', content: 'pending body', isLocal: true });
            document.getElementById('note-modal-textarea').value = 'replacement body';

            await window.handleEditNoteSubmit({ preventDefault() {} });

            expect(confirmDeleteSpy).toHaveBeenCalledWith(88);
            expect(apiCallSpy).toHaveBeenCalledTimes(1);
            expect(apiCallSpy.mock.calls[0][1]).toBe('POST');
        });
    });
});
