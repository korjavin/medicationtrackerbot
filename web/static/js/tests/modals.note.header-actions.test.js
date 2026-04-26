// Header-actions refactor: EditNoteModal / note-modal (Task 5).
//
// Asserts Cancel + Save sit inside `.wg-health-modal__header-actions` so
// they remain visible above a focused mobile keyboard, and the legacy
// `.wg-health-modal__actions` body footer row is gone. The save button
// keeps its `form="note-form"` association so it still triggers the
// form's submit handler from outside the form, and existing
// `bindClick('note-modal-cancel-btn', ...)` wiring keeps working.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('NoteModal header-actions', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('Cancel and Save live inside .wg-health-modal__header-actions', () => {
        const { document } = env;
        const headerActions = document.querySelector('#note-modal .wg-health-modal__header-actions');
        expect(headerActions).not.toBeNull();

        const cancelBtn = document.getElementById('note-modal-cancel-btn');
        const saveBtn = document.getElementById('note-modal-save-btn');
        expect(cancelBtn).not.toBeNull();
        expect(saveBtn).not.toBeNull();
        expect(cancelBtn.parentElement).toBe(headerActions);
        expect(saveBtn.parentElement).toBe(headerActions);
    });

    it('legacy .wg-health-modal__actions body row no longer exists', () => {
        const { document } = env;
        expect(document.querySelector('#note-modal .wg-health-modal__actions')).toBeNull();
    });

    it('button IDs still resolve so existing handlers keep binding', () => {
        const { document } = env;
        expect(document.getElementById('note-modal-cancel-btn')).not.toBeNull();
        expect(document.getElementById('note-modal-save-btn')).not.toBeNull();
    });

    it('Cancel sits left of Save inside the header row', () => {
        const { document } = env;
        const headerActions = document.querySelector('#note-modal .wg-health-modal__header-actions');
        const cancelBtn = document.getElementById('note-modal-cancel-btn');
        const saveBtn = document.getElementById('note-modal-save-btn');
        const children = Array.from(headerActions.children);
        const cancelIdx = children.indexOf(cancelBtn);
        const saveIdx = children.indexOf(saveBtn);
        expect(cancelIdx).toBeGreaterThan(-1);
        expect(saveIdx).toBeGreaterThan(cancelIdx);
    });

    it('Save button keeps form="note-form" so it submits from outside the form', () => {
        const { document } = env;
        const saveBtn = document.getElementById('note-modal-save-btn');
        expect(saveBtn.getAttribute('form')).toBe('note-form');
        expect(saveBtn.getAttribute('type')).toBe('submit');
    });

    it('redundant close-X button is removed (Cancel + backdrop suffice)', () => {
        const { document } = env;
        expect(document.getElementById('note-modal-close-btn')).toBeNull();
        expect(document.querySelector('#note-modal .wg-health-modal__close-btn')).toBeNull();
    });
});
