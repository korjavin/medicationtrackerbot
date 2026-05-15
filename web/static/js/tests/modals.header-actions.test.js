// Consolidated header-actions tests for every wg-* modal (Tasks 1–11
// of the original mobile-keyboard refactor). Each modal's Cancel +
// primary button (Save or Start) must live inside the modal's
// `.wg-<modal>__header-actions` row so they stay visible above a
// focused mobile keyboard. The legacy body footer row must be gone
// and the existing button IDs must still resolve.
//
// This single parameterized suite replaces the per-modal files:
//   modals.bp.header-actions.test.js
//   modals.food.header-actions.test.js
//   modals.meds.header-actions.test.js
//   modals.note.header-actions.test.js
//   modals.weight.header-actions.test.js
//   modals.workouts-exercise.header-actions.test.js
//   modals.workouts-group.header-actions.test.js
//   modals.workouts-library.header-actions.test.js
//   modals.workouts-log-set.header-actions.test.js
//   modals.workouts-start.header-actions.test.js
//   modals.workouts-variant.header-actions.test.js

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const cases = [
    {
        name: 'BPModal',
        modalId: 'bp-modal',
        headerActionsClass: 'wg-bp-modal__header-actions',
        legacyActionsSelector: '#bp-modal .wg-bp-modal__actions',
        cancelBtnId: 'bp-modal-cancel-btn',
        primaryBtnId: 'bp-modal-save-btn',
        primaryLabel: 'Save',
        formAttr: 'bp-form',
        legacyFormSelector: '#bp-modal button[form="bp-form"]',
        closeBtnId: 'bp-modal-close-btn',
        closeBtnSelector: '#bp-modal .wg-bp-modal__close-btn',
    },
    {
        name: 'EditFoodModal',
        modalId: 'food-modal',
        headerActionsClass: 'wg-food-modal__header-actions',
        legacyActionsSelector: '#food-modal .wg-food-modal__actions',
        cancelBtnId: 'food-modal-cancel-btn',
        primaryBtnId: 'food-modal-save-btn',
        primaryLabel: 'Save',
        closeBtnId: 'food-modal-close-btn',
        closeBtnSelector: '#food-modal .wg-food-modal__close-btn',
    },
    {
        name: 'MedModal',
        modalId: 'med-modal',
        headerActionsClass: 'wg-meds-modal__header-actions',
        legacyActionsSelector: '#med-modal .wg-meds-modal__actions',
        cancelBtnId: 'med-modal-cancel-btn',
        primaryBtnId: 'med-modal-save-btn',
        primaryLabel: 'Save',
        closeBtnId: 'med-modal-close-btn',
        closeBtnSelector: '#med-modal .wg-meds-modal__close-btn',
    },
    {
        name: 'NoteModal',
        modalId: 'note-modal',
        headerActionsClass: 'wg-health-modal__header-actions',
        legacyActionsSelector: '#note-modal .wg-health-modal__actions',
        cancelBtnId: 'note-modal-cancel-btn',
        primaryBtnId: 'note-modal-save-btn',
        primaryLabel: 'Save',
        formAttr: 'note-form',
        formAttrType: 'submit',
        closeBtnId: 'note-modal-close-btn',
        closeBtnSelector: '#note-modal .wg-health-modal__close-btn',
    },
    {
        name: 'WeightModal',
        modalId: 'weight-modal',
        headerActionsClass: 'wg-weight-modal__header-actions',
        legacyActionsSelector: '#weight-modal .wg-weight-modal__actions',
        cancelBtnId: 'weight-modal-cancel-btn',
        primaryBtnId: 'weight-modal-save-btn',
        primaryLabel: 'Save',
        formAttr: 'weight-form',
        formAttrType: 'submit',
        closeBtnId: 'weight-modal-close-btn',
        closeBtnSelector: '#weight-modal .wg-weight-modal__close-btn',
    },
    {
        name: 'WorkoutExerciseModal',
        modalId: 'workout-exercise-modal',
        headerActionsClass: 'wg-workouts-exercise-modal__header-actions',
        legacyActionsSelector: '#workout-exercise-modal .wg-workouts-exercise-modal__actions',
        cancelBtnId: 'exercise-cancel-btn',
        primaryBtnId: 'exercise-save-btn',
        primaryLabel: 'Save',
        closeBtnId: 'exercise-close-btn',
    },
    {
        name: 'WorkoutGroupModal',
        modalId: 'workout-group-modal',
        headerActionsClass: 'wg-workouts-group-modal__header-actions',
        legacyActionsSelector: '#workout-group-modal .wg-workouts-group-modal__actions',
        cancelBtnId: 'workout-group-cancel-btn',
        primaryBtnId: 'workout-group-save-btn',
        primaryLabel: 'Save',
        closeBtnId: 'workout-group-close-btn',
        closeBtnSelector: '#workout-group-modal .wg-workouts-group-modal__close-btn',
    },
    {
        name: 'WorkoutLibraryModal',
        modalId: 'exercise-library-modal',
        headerActionsClass: 'wg-workouts-library-modal__header-actions',
        legacyActionsSelector: '#exercise-library-modal .wg-workouts-library-modal__actions',
        cancelBtnId: 'exercise-library-cancel-btn',
        primaryBtnId: 'exercise-library-save-btn',
        primaryLabel: 'Save',
        closeBtnId: 'exercise-library-close-btn',
    },
    {
        name: 'WorkoutLogSetModal',
        modalId: 'workout-add-exercise-to-session-modal',
        headerActionsClass: 'wg-workouts-log-set-modal__header-actions',
        legacyActionsSelector: '#workout-add-exercise-to-session-modal .wg-workouts-log-set-modal__actions',
        cancelBtnId: 'session-add-exercise-cancel-btn',
        primaryBtnId: 'session-add-exercise-save-btn',
        primaryLabel: 'Save',
        closeBtnId: 'session-add-exercise-close-btn',
    },
    {
        name: 'WorkoutVariantModal',
        modalId: 'workout-variant-modal',
        headerActionsClass: 'wg-workouts-variant-modal__header-actions',
        legacyActionsSelector: '#workout-variant-modal .wg-workouts-variant-modal__actions',
        cancelBtnId: 'variant-cancel-btn',
        primaryBtnId: 'variant-save-btn',
        primaryLabel: 'Save',
        closeBtnId: 'workout-variant-close-btn',
        closeBtnSelector: '#workout-variant-modal .wg-workouts-variant-modal__close-btn',
    },
    {
        name: 'WorkoutStartModal',
        modalId: 'workout-start-modal',
        headerActionsClass: 'wg-workouts-start-modal__header-actions',
        legacyActionsSelector: '#workout-start-modal .actions',
        cancelBtnId: 'workout-start-dismiss-btn',
        primaryBtnId: 'workout-start-now-btn',
        primaryLabel: 'Start',
        extraResolvedIds: [
            'workout-start-snooze-60-btn',
            'workout-start-snooze-120-btn',
            'workout-start-skip-btn',
        ],
        bodySelector: '#workout-start-modal .wg-workouts-start-modal__body',
        bodyBtnIds: [
            'workout-start-snooze-60-btn',
            'workout-start-snooze-120-btn',
            'workout-start-skip-btn',
        ],
        wgShellClasses: ['wg-modal', 'wg-workouts-start-modal'],
    },
];

describe.each(cases)('$name header-actions', (row) => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it(`Cancel and ${row.primaryLabel} live inside .${row.headerActionsClass}`, () => {
        const { document } = env;
        const headerActions = document.querySelector(`#${row.modalId} .${row.headerActionsClass}`);
        expect(headerActions).not.toBeNull();

        const cancelBtn = document.getElementById(row.cancelBtnId);
        const primaryBtn = document.getElementById(row.primaryBtnId);
        expect(cancelBtn).not.toBeNull();
        expect(primaryBtn).not.toBeNull();
        expect(cancelBtn.parentElement).toBe(headerActions);
        expect(primaryBtn.parentElement).toBe(headerActions);
    });

    it('legacy actions body row no longer exists', () => {
        const { document } = env;
        expect(document.querySelector(row.legacyActionsSelector)).toBeNull();
    });

    it('button IDs still resolve so existing handlers keep binding', () => {
        const { document } = env;
        expect(document.getElementById(row.cancelBtnId)).not.toBeNull();
        expect(document.getElementById(row.primaryBtnId)).not.toBeNull();
        for (const extraId of row.extraResolvedIds || []) {
            expect(document.getElementById(extraId)).not.toBeNull();
        }
    });

    it(`Cancel sits left of ${row.primaryLabel} inside the header row`, () => {
        const { document } = env;
        const headerActions = document.querySelector(`#${row.modalId} .${row.headerActionsClass}`);
        const cancelBtn = document.getElementById(row.cancelBtnId);
        const primaryBtn = document.getElementById(row.primaryBtnId);
        const children = Array.from(headerActions.children);
        const cancelIdx = children.indexOf(cancelBtn);
        const primaryIdx = children.indexOf(primaryBtn);
        expect(cancelIdx).toBeGreaterThan(-1);
        expect(primaryIdx).toBeGreaterThan(cancelIdx);
    });

    it.skipIf(!row.formAttr)(`Save button keeps form="${row.formAttr}" so it submits from outside the form`, () => {
        const { document } = env;
        const primaryBtn = document.getElementById(row.primaryBtnId);
        expect(primaryBtn.getAttribute('form')).toBe(row.formAttr);
        if (row.formAttrType) {
            expect(primaryBtn.getAttribute('type')).toBe(row.formAttrType);
        }
        if (row.legacyFormSelector) {
            const viaLegacySelector = document.querySelector(row.legacyFormSelector);
            expect(viaLegacySelector).toBe(primaryBtn);
        }
    });

    it.skipIf(!row.closeBtnId)('redundant close-X button is removed from the header', () => {
        const { document } = env;
        expect(document.getElementById(row.closeBtnId)).toBeNull();
        if (row.closeBtnSelector) {
            expect(document.querySelector(row.closeBtnSelector)).toBeNull();
        }
    });

    it.skipIf(!row.bodyBtnIds)('secondary buttons stay in the body, not the header row', () => {
        const { document } = env;
        const headerActions = document.querySelector(`#${row.modalId} .${row.headerActionsClass}`);
        const body = document.querySelector(row.bodySelector);
        expect(body).not.toBeNull();
        for (const id of row.bodyBtnIds) {
            const btn = document.getElementById(id);
            expect(headerActions.contains(btn)).toBe(false);
            expect(body.contains(btn)).toBe(true);
        }
    });

    it.skipIf(!row.wgShellClasses)('modal carries the wg-modal shell classes', () => {
        const { document } = env;
        const modal = document.getElementById(row.modalId);
        for (const cls of row.wgShellClasses) {
            expect(modal.classList.contains(cls)).toBe(true);
        }
    });
});
