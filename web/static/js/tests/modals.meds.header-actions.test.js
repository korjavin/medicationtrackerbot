// Header-actions refactor: TakeMedsModal / med-modal (Task 2).
//
// Asserts Cancel + Save sit inside `.wg-meds-modal__header-actions` so
// they remain visible above a focused mobile keyboard, and the legacy
// `.wg-meds-modal__actions` body footer row is gone. Button IDs must
// still resolve via getElementById so existing app.js handlers keep
// binding without rewiring.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('MedModal header-actions', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('Cancel and Save live inside .wg-meds-modal__header-actions', () => {
        const { document } = env;
        const headerActions = document.querySelector('#med-modal .wg-meds-modal__header-actions');
        expect(headerActions).not.toBeNull();

        const cancelBtn = document.getElementById('med-modal-cancel-btn');
        const saveBtn = document.getElementById('med-modal-save-btn');
        expect(cancelBtn).not.toBeNull();
        expect(saveBtn).not.toBeNull();
        expect(cancelBtn.parentElement).toBe(headerActions);
        expect(saveBtn.parentElement).toBe(headerActions);
    });

    it('legacy .wg-meds-modal__actions body row no longer exists', () => {
        const { document } = env;
        expect(document.querySelector('#med-modal .wg-meds-modal__actions')).toBeNull();
    });

    it('button IDs still resolve so existing handlers keep binding', () => {
        const { document } = env;
        expect(document.getElementById('med-modal-cancel-btn')).not.toBeNull();
        expect(document.getElementById('med-modal-save-btn')).not.toBeNull();
    });

    it('Cancel sits left of Save inside the header row', () => {
        const { document } = env;
        const headerActions = document.querySelector('#med-modal .wg-meds-modal__header-actions');
        const cancelBtn = document.getElementById('med-modal-cancel-btn');
        const saveBtn = document.getElementById('med-modal-save-btn');
        const children = Array.from(headerActions.children);
        const cancelIdx = children.indexOf(cancelBtn);
        const saveIdx = children.indexOf(saveBtn);
        expect(cancelIdx).toBeGreaterThan(-1);
        expect(saveIdx).toBeGreaterThan(cancelIdx);
    });
});
