// Header-actions refactor: LogBPModal / bp-modal (Task 3).
//
// Asserts Cancel + Save sit inside `.wg-bp-modal__header-actions` so
// they remain visible above a focused mobile keyboard, and the legacy
// `.wg-bp-modal__actions` body footer row is gone. The save button keeps
// its `form="bp-form"` association so it still triggers the form's
// submit handler from outside the form, and existing selectors in
// features/bp.js (`#bp-modal button[form="bp-form"]`) keep working.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('BPModal header-actions', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('Cancel and Save live inside .wg-bp-modal__header-actions', () => {
        const { document } = env;
        const headerActions = document.querySelector('#bp-modal .wg-bp-modal__header-actions');
        expect(headerActions).not.toBeNull();

        const cancelBtn = document.getElementById('bp-modal-cancel-btn');
        const saveBtn = document.getElementById('bp-modal-save-btn');
        expect(cancelBtn).not.toBeNull();
        expect(saveBtn).not.toBeNull();
        expect(cancelBtn.parentElement).toBe(headerActions);
        expect(saveBtn.parentElement).toBe(headerActions);
    });

    it('legacy .wg-bp-modal__actions body row no longer exists', () => {
        const { document } = env;
        expect(document.querySelector('#bp-modal .wg-bp-modal__actions')).toBeNull();
    });

    it('button IDs still resolve so existing handlers keep binding', () => {
        const { document } = env;
        expect(document.getElementById('bp-modal-cancel-btn')).not.toBeNull();
        expect(document.getElementById('bp-modal-save-btn')).not.toBeNull();
    });

    it('Cancel sits left of Save inside the header row', () => {
        const { document } = env;
        const headerActions = document.querySelector('#bp-modal .wg-bp-modal__header-actions');
        const cancelBtn = document.getElementById('bp-modal-cancel-btn');
        const saveBtn = document.getElementById('bp-modal-save-btn');
        const children = Array.from(headerActions.children);
        const cancelIdx = children.indexOf(cancelBtn);
        const saveIdx = children.indexOf(saveBtn);
        expect(cancelIdx).toBeGreaterThan(-1);
        expect(saveIdx).toBeGreaterThan(cancelIdx);
    });

    it('Save button keeps form="bp-form" so it submits from outside the form', () => {
        const { document } = env;
        const saveBtn = document.getElementById('bp-modal-save-btn');
        expect(saveBtn.getAttribute('form')).toBe('bp-form');
        // The legacy querySelector used in features/bp.js must keep finding it.
        const viaLegacySelector = document.querySelector('#bp-modal button[form="bp-form"]');
        expect(viaLegacySelector).toBe(saveBtn);
    });

    it('redundant close-X button is removed from the header', () => {
        const { document } = env;
        expect(document.getElementById('bp-modal-close-btn')).toBeNull();
        expect(document.querySelector('#bp-modal .wg-bp-modal__close-btn')).toBeNull();
    });
});
