// Wandergeek Workouts exercises sub-tab (Phase 7, Task 6).
//
// Exercises the rewritten `_renderExerciseLibrary` path. Each row is a
// `.wg-card.wg-workouts-exercises-row` carrying a rotation-slot mono tag,
// the exercise mono name, a defaults eyebrow (sets x reps + weight + notes),
// and a trailing `.wg-icon-btn` cluster (edit / delete). A full-width
// `.wg-gloss--sun` "Add exercise" CTA replaces the paper-era FAB. The
// edit-library-exercise modal uses the shared `.wg-modal` shell with mono
// eyebrow + title, gloss-inset input wraps, and a Cancel/Save action bar
// (Save 2x flex).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function makeExercise(overrides) {
    return {
        id: 1,
        name: 'Push Press',
        default_sets: 4,
        default_reps_min: 6,
        default_reps_max: 8,
        default_weight_kg: 45,
        notes: '',
        ...overrides
    };
}

describe('Workouts exercises library (Phase 7, Task 6)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withWorkout: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders the empty state when no exercises are present', () => {
        const { window, document } = env;
        const container = document.getElementById('exercise-library-list');
        window._renderExerciseLibrary(container, []);

        expect(container.classList.contains('wg-workouts-exercises')).toBe(true);
        const empty = container.querySelector('.wg-workouts-exercises__empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toMatch(/No exercises in library yet/);
    });

    it('renders .wg-card exercise rows with slot tag, mono name, and defaults meta', () => {
        const { window, document } = env;
        const container = document.getElementById('exercise-library-list');
        window._renderExerciseLibrary(container, [makeExercise()]);

        const row = container.querySelector('.wg-workouts-exercises-row');
        expect(row).not.toBeNull();
        expect(row.classList.contains('wg-card')).toBe(true);
        expect(row.dataset.exerciseId).toBe('1');
        expect(row.dataset.slot).toBe('PUSH');

        const slotTag = row.querySelector('.wg-workouts-exercises-row__slot');
        expect(slotTag).not.toBeNull();
        expect(slotTag.classList.contains('wg-tag')).toBe(true);
        expect(slotTag.classList.contains('wg-tag--mono')).toBe(true);
        expect(slotTag.classList.contains('wg-workouts-slot-tag--push')).toBe(true);
        expect(slotTag.textContent).toBe('PUSH');

        const name = row.querySelector('.wg-workouts-exercises-row__name');
        expect(name).not.toBeNull();
        expect(name.textContent).toBe('Push Press');

        const defaults = row.querySelector('.wg-workouts-exercises-row__defaults');
        expect(defaults).not.toBeNull();
        expect(defaults.textContent).toBe('4\u00d76-8');

        const weight = row.querySelector('.wg-workouts-exercises-row__weight');
        expect(weight).not.toBeNull();
        expect(weight.textContent).toBe('45kg');
    });

    it('omits the weight chip when default_weight_kg is missing', () => {
        const { window, document } = env;
        const container = document.getElementById('exercise-library-list');
        window._renderExerciseLibrary(container, [makeExercise({ default_weight_kg: null })]);

        const weight = container.querySelector('.wg-workouts-exercises-row__weight');
        expect(weight).toBeNull();
    });

    it('collapses the reps range to a single value when max is absent', () => {
        const { window, document } = env;
        const container = document.getElementById('exercise-library-list');
        window._renderExerciseLibrary(container, [makeExercise({ default_reps_max: null })]);

        const defaults = container.querySelector('.wg-workouts-exercises-row__defaults');
        expect(defaults).not.toBeNull();
        expect(defaults.textContent).toBe('4\u00d76');
    });

    it('renders the notes chip when notes are present', () => {
        const { window, document } = env;
        const container = document.getElementById('exercise-library-list');
        window._renderExerciseLibrary(container, [makeExercise({ notes: 'Squeeze at top' })]);

        const notes = container.querySelector('.wg-workouts-exercises-row__notes');
        expect(notes).not.toBeNull();
        expect(notes.textContent).toBe('Squeeze at top');
    });

    it('renders an edit / delete icon-button cluster on each row', () => {
        const { window, document } = env;
        const container = document.getElementById('exercise-library-list');
        window._renderExerciseLibrary(container, [makeExercise()]);

        const actions = container.querySelector('.wg-workouts-exercises-row__actions');
        expect(actions).not.toBeNull();

        const editBtn = actions.querySelector('.wg-workouts-exercises-row__edit');
        const deleteBtn = actions.querySelector('.wg-workouts-exercises-row__delete');
        expect(editBtn).not.toBeNull();
        expect(deleteBtn).not.toBeNull();

        expect(editBtn.getAttribute('aria-label')).toBe('Edit exercise');
        expect(deleteBtn.getAttribute('aria-label')).toBe('Delete exercise');

        [editBtn, deleteBtn].forEach((btn) => {
            expect(btn.classList.contains('wg-icon-btn')).toBe(true);
            expect(btn.querySelector('.wg-gloss')).not.toBeNull();
        });
    });

    it('clicking the row (not the icon cluster) opens the edit-exercise modal', () => {
        const { window, document } = env;
        const container = document.getElementById('exercise-library-list');
        const showSpy = vi.fn();
        window.showEditExerciseLibraryModal = showSpy;

        window._renderExerciseLibrary(container, [makeExercise({ id: 77 })]);
        const row = container.querySelector('.wg-workouts-exercises-row');

        row.click();
        expect(showSpy).toHaveBeenCalledWith(77);
    });

    it('clicking the edit icon opens the edit-exercise modal and stops row propagation', () => {
        const { window, document } = env;
        const container = document.getElementById('exercise-library-list');
        const showSpy = vi.fn();
        window.showEditExerciseLibraryModal = showSpy;

        window._renderExerciseLibrary(container, [makeExercise({ id: 88 })]);
        const editBtn = container.querySelector('.wg-workouts-exercises-row__edit');
        editBtn.click();

        expect(showSpy).toHaveBeenCalledTimes(1);
        expect(showSpy).toHaveBeenCalledWith(88);
    });

    it('clicking the delete icon dispatches deleteExerciseLibraryItem with confirm', async () => {
        const { window, document } = env;
        const container = document.getElementById('exercise-library-list');
        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
        const apiSpy = vi.fn(async () => true);
        window.apiCall = apiSpy;
        window.loadExerciseLibrary = vi.fn();

        window._renderExerciseLibrary(container, [makeExercise({ id: 99 })]);
        const deleteBtn = container.querySelector('.wg-workouts-exercises-row__delete');
        deleteBtn.click();
        for (let i = 0; i < 8; i += 1) await Promise.resolve();

        expect(window.safeConfirm).toHaveBeenCalled();
        expect(apiSpy).toHaveBeenCalledWith('/api/workout/exercise-library/delete?id=99', 'DELETE');
        expect(window.loadExerciseLibrary).toHaveBeenCalled();
    });

    it('renders an inline Add exercise sun-gloss pill in the Exercises tab header (Round-2 Task 6)', () => {
        const { document } = env;
        const cta = document.getElementById('add-exercise-library-btn');
        expect(cta).not.toBeNull();
        expect(cta.classList.contains('wg-gloss')).toBe(true);
        expect(cta.classList.contains('wg-gloss--sun')).toBe(true);
        // Round-2 Task 6: button moved from the sticky bottom CTA
        // (`.wg-workouts-exercises__add-cta`) into the top-right of the
        // exercises tab header (`.wg-workouts-exercises-header__add`).
        expect(cta.classList.contains('wg-workouts-exercises-header__add')).toBe(true);
        expect(cta.classList.contains('wg-workouts-exercises__add-cta')).toBe(false);
    });

    describe('edit-library-exercise modal shell', () => {
        it('uses the .wg-modal + .wg-workouts-library-modal classes', () => {
            const { document } = env;
            const modal = document.getElementById('exercise-library-modal');
            expect(modal).not.toBeNull();
            expect(modal.classList.contains('wg-modal')).toBe(true);
            expect(modal.classList.contains('wg-workouts-library-modal')).toBe(true);
        });

        it('renders a mono eyebrow + title heading', () => {
            const { document } = env;
            const modal = document.getElementById('exercise-library-modal');
            const eyebrow = modal.querySelector('.wg-workouts-library-modal__eyebrow');
            const title = modal.querySelector('.wg-workouts-library-modal__title');
            expect(eyebrow).not.toBeNull();
            expect(eyebrow.classList.contains('wg-section-label')).toBe(true);
            expect(eyebrow.textContent).toBe('Exercise library');
            expect(title).not.toBeNull();
            expect(title.classList.contains('wg-mono-display')).toBe(true);
            expect(title.id).toBe('exercise-library-modal-title');
        });

        it('wraps the name + notes inputs in .wg-gloss--inset', () => {
            const { document } = env;
            const nameWrap = document.querySelector('#exercise-library-modal .wg-workouts-library-modal__field label[for="exercise-library-name"]')
                .parentElement.querySelector('.wg-workouts-library-modal__input-wrap');
            expect(nameWrap).not.toBeNull();
            expect(nameWrap.classList.contains('wg-gloss--inset')).toBe(true);

            const notesWrap = document.querySelector('#exercise-library-modal .wg-workouts-library-modal__field label[for="exercise-library-notes"]')
                .parentElement.querySelector('.wg-workouts-library-modal__input-wrap');
            expect(notesWrap).not.toBeNull();
            expect(notesWrap.classList.contains('wg-gloss--inset')).toBe(true);
        });

        it('has Cancel + Save header-action buttons with Save as sun-glossed', () => {
            const { document } = env;
            const actions = document.querySelector('#exercise-library-modal .wg-workouts-library-modal__header-actions');
            expect(actions).not.toBeNull();

            const cancel = actions.querySelector('#exercise-library-cancel-btn');
            const save = actions.querySelector('#exercise-library-save-btn');
            expect(cancel).not.toBeNull();
            expect(save).not.toBeNull();

            expect(cancel.classList.contains('wg-gloss')).toBe(true);
            expect(cancel.classList.contains('wg-workouts-library-modal__header-btn')).toBe(true);

            expect(save.classList.contains('wg-gloss')).toBe(true);
            expect(save.classList.contains('wg-gloss--sun')).toBe(true);
            expect(save.classList.contains('wg-workouts-library-modal__header-btn--save')).toBe(true);
        });

        it('preserves the preexisting ID hooks used by saveExerciseLibraryItem / showEditExerciseLibraryModal', () => {
            const { document } = env;
            // These IDs are referenced directly from features/workout.js —
            // renaming them would silently break the Save / Edit flow.
            ['exercise-library-name', 'exercise-library-sets', 'exercise-library-reps-min',
             'exercise-library-reps-max', 'exercise-library-weight', 'exercise-library-notes',
             'exercise-library-modal-title', 'exercise-library-cancel-btn',
             'exercise-library-save-btn', 'exercise-library-close-btn']
                .forEach((id) => {
                    expect(document.getElementById(id), `expected #${id} to exist`).not.toBeNull();
                });
        });
    });

    describe('modal open / save / cancel flow', () => {
        it('showExerciseLibraryModal clears the inputs and flips the title to Add Exercise', () => {
            const { window, document } = env;
            document.getElementById('exercise-library-name').value = 'stale name';
            document.getElementById('exercise-library-sets').value = '7';
            document.getElementById('exercise-library-reps-min').value = '12';
            document.getElementById('exercise-library-reps-max').value = '15';
            document.getElementById('exercise-library-weight').value = '99';
            document.getElementById('exercise-library-notes').value = 'stale notes';

            window.showExerciseLibraryModal();

            expect(document.getElementById('exercise-library-modal-title').textContent).toBe('Add Exercise');
            expect(document.getElementById('exercise-library-name').value).toBe('');
            expect(document.getElementById('exercise-library-sets').value).toBe('');
            expect(document.getElementById('exercise-library-reps-min').value).toBe('');
            expect(document.getElementById('exercise-library-reps-max').value).toBe('');
            expect(document.getElementById('exercise-library-weight').value).toBe('');
            expect(document.getElementById('exercise-library-notes').value).toBe('');
        });

        it('showEditExerciseLibraryModal populates the inputs from the apiCall fetch', async () => {
            const { window, document } = env;
            window.apiCall = vi.fn(async () => [makeExercise({
                id: 42,
                name: 'Bent-over Rows',
                default_sets: 3,
                default_reps_min: 10,
                default_reps_max: 12,
                default_weight_kg: 60,
                notes: 'Squeeze shoulder blades'
            })]);

            await window.showEditExerciseLibraryModal(42);

            expect(document.getElementById('exercise-library-modal-title').textContent).toBe('Edit Exercise');
            expect(document.getElementById('exercise-library-name').value).toBe('Bent-over Rows');
            expect(document.getElementById('exercise-library-sets').value).toBe('3');
            expect(document.getElementById('exercise-library-reps-min').value).toBe('10');
            expect(document.getElementById('exercise-library-reps-max').value).toBe('12');
            expect(document.getElementById('exercise-library-weight').value).toBe('60');
            expect(document.getElementById('exercise-library-notes').value).toBe('Squeeze shoulder blades');
        });

        it('saveExerciseLibraryItem POSTs to /create for a new item and reloads the list', async () => {
            const { window, document } = env;
            document.getElementById('exercise-library-name').value = 'Deadlift';
            document.getElementById('exercise-library-sets').value = '5';
            document.getElementById('exercise-library-reps-min').value = '5';
            document.getElementById('exercise-library-reps-max').value = '';
            document.getElementById('exercise-library-weight').value = '100';
            document.getElementById('exercise-library-notes').value = '';

            const apiSpy = vi.fn(async () => ({ ok: true }));
            window.apiCall = apiSpy;
            window.loadExerciseLibrary = vi.fn();

            await window.saveExerciseLibraryItem();

            expect(apiSpy).toHaveBeenCalledWith(
                '/api/workout/exercise-library/create',
                'POST',
                expect.objectContaining({
                    name: 'Deadlift',
                    default_sets: 5,
                    default_reps_min: 5,
                    default_reps_max: null,
                    default_weight_kg: 100
                })
            );
            expect(window.loadExerciseLibrary).toHaveBeenCalled();
        });

        it('closeExerciseLibraryModal calls the shared ModalManager close', () => {
            const { window } = env;
            const closeSpy = vi.fn();
            window.ModalManager.exerciseLibrary = {
                open: vi.fn(),
                close: closeSpy
            };

            window.closeExerciseLibraryModal();
            expect(closeSpy).toHaveBeenCalled();
        });
    });
});
