// Header-actions refactor: EditWeightModal / weight-modal (Task 4).
//
// Asserts Cancel + Save sit inside `.wg-weight-modal__header-actions` so
// they remain visible above a focused mobile keyboard, and the legacy
// `.wg-weight-modal__actions` body footer row is gone. The save button
// keeps its `form="weight-form"` association so it still triggers the
// form's submit handler from outside the form, and existing
// `bindClick('weight-modal-cancel-btn', ...)` wiring in app.js keeps
// working.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('WeightModal header-actions', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('Cancel and Save live inside .wg-weight-modal__header-actions', () => {
        const { document } = env;
        const headerActions = document.querySelector('#weight-modal .wg-weight-modal__header-actions');
        expect(headerActions).not.toBeNull();

        const cancelBtn = document.getElementById('weight-modal-cancel-btn');
        const saveBtn = document.getElementById('weight-modal-save-btn');
        expect(cancelBtn).not.toBeNull();
        expect(saveBtn).not.toBeNull();
        expect(cancelBtn.parentElement).toBe(headerActions);
        expect(saveBtn.parentElement).toBe(headerActions);
    });

    it('legacy .wg-weight-modal__actions body row no longer exists', () => {
        const { document } = env;
        expect(document.querySelector('#weight-modal .wg-weight-modal__actions')).toBeNull();
    });

    it('button IDs still resolve so existing handlers keep binding', () => {
        const { document } = env;
        expect(document.getElementById('weight-modal-cancel-btn')).not.toBeNull();
        expect(document.getElementById('weight-modal-save-btn')).not.toBeNull();
    });

    it('Cancel sits left of Save inside the header row', () => {
        const { document } = env;
        const headerActions = document.querySelector('#weight-modal .wg-weight-modal__header-actions');
        const cancelBtn = document.getElementById('weight-modal-cancel-btn');
        const saveBtn = document.getElementById('weight-modal-save-btn');
        const children = Array.from(headerActions.children);
        const cancelIdx = children.indexOf(cancelBtn);
        const saveIdx = children.indexOf(saveBtn);
        expect(cancelIdx).toBeGreaterThan(-1);
        expect(saveIdx).toBeGreaterThan(cancelIdx);
    });

    it('Save button keeps form="weight-form" so it submits from outside the form', () => {
        const { document } = env;
        const saveBtn = document.getElementById('weight-modal-save-btn');
        expect(saveBtn.getAttribute('form')).toBe('weight-form');
        expect(saveBtn.getAttribute('type')).toBe('submit');
    });
});
