// ====================================
// EXERCISES — CRUD (within variants)
// ====================================
//
// Owns:
//   - "currently editing exercise id" + "currently active variant for
//     exercise" form state (closure-private; read/written via
//     window.WorkoutEdit getters/setters).
//   - "currently-loaded exercises container id" so a re-render after
//     save targets the same list (variant modal vs. flat-exercises panel).

(function () {
    let _editingExerciseId = null;
    let _variantForExercise = null;
    // Container id the most recent loadExercisesForVariant() targeted. Used by
    // the post-save / post-delete refresh so we re-render in the right slot
    // (the variant modal's #workout-exercises-list vs. the non-rotating
    // group modal's #workout-group-flat-exercises-list).
    let _exercisesContainerId = 'workout-exercises-list';

    window.WorkoutEdit = window.WorkoutEdit || {};
    Object.defineProperty(window.WorkoutEdit, 'editingExerciseId', {
        get: () => _editingExerciseId,
        set: (v) => { _editingExerciseId = v; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.WorkoutEdit, 'variantForExercise', {
        get: () => _variantForExercise,
        set: (v) => { _variantForExercise = v; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.WorkoutEdit, 'exercisesContainerId', {
        get: () => _exercisesContainerId,
        set: (v) => { _exercisesContainerId = v || 'workout-exercises-list'; },
        enumerable: true,
        configurable: true
    });
})();

// Goal → editor defaults for the cascade (med-qj4.6.1). Canonical copy lives in
// web/domain/workout-goals.js (cloud/goja side); duplicated here because the
// web/static frontend loads as plain scripts, not ES modules. Keep in sync.
// (RIR is intentionally omitted — the exercise editor has no target-RIR field.)
const WORKOUT_GOAL_DEFAULTS = {
    strength:    { reps_min: 3,  reps_max: 6,  progression: 'linear' },
    hypertrophy: { reps_min: 8,  reps_max: 12, progression: 'double' },
    endurance:   { reps_min: 15, reps_max: 25, progression: 'double' },
    general:     { reps_min: 8,  reps_max: 12, progression: 'none' },
};

// The routine (group) that owns the exercise being edited, used to resolve an
// "Inherit from routine" goal to a concrete one. When the group modal is open
// (the only path that reaches "Add exercise" mid-edit), its live
// #workout-group-goal select is the source of truth — it reflects an unsaved
// goal change that cachedGroups (only refreshed on save) wouldn't yet see.
// When the modal is closed, that select still holds a stale/default value, so
// fall back to the saved cachedGroups goal.
function routineGoalForExercise() {
    const groupModal = document.getElementById('workout-group-modal');
    const liveGoal = document.getElementById('workout-group-goal');
    if (groupModal && !groupModal.classList.contains('hidden') && liveGoal && liveGoal.value) {
        return liveGoal.value;
    }
    const groupId = window.WorkoutEdit.groupForVariant || window.WorkoutEdit.editingGroupId;
    const group = (window.WorkoutEdit.cachedGroups || []).find(g => g.id === groupId);
    return (group && group.training_goal) || 'hypertrophy';
}

// Effective goal for the cascade: the per-exercise override if picked, else the
// routine's goal ("" in the selector = inherit).
function effectiveExerciseGoal() {
    return document.getElementById('workout-exercise-goal').value || routineGoalForExercise();
}

// Fill-only cascade: pre-fill rep-range + progression preset from the goal
// defaults. Never disables editing; the user can still override every field.
function applyGoalCascade(goal) {
    const d = WORKOUT_GOAL_DEFAULTS[goal] || WORKOUT_GOAL_DEFAULTS.hypertrophy;
    document.getElementById('workout-exercise-reps-min').value = d.reps_min;
    document.getElementById('workout-exercise-reps-max').value = d.reps_max;
    document.getElementById('workout-exercise-progression').value = d.progression;
}

// Wire the goal selector so changing it re-runs the cascade for the effective
// goal. Idempotent (assigns onchange, not addEventListener).
function bindGoalCascade() {
    const goalSel = document.getElementById('workout-exercise-goal');
    if (goalSel) goalSel.onchange = () => applyGoalCascade(effectiveExerciseGoal());
}

async function loadExercisesForVariant(variantId, containerId = 'workout-exercises-list') {
    window.WorkoutEdit.variantForExercise = variantId;
    window.WorkoutEdit.exercisesContainerId = containerId;
    const container = document.getElementById(containerId);

    try {
        const exercises = await apiCall(`/api/workout/exercises?variant_id=${variantId}`);

        if (!exercises || exercises.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'workout-pending-msg';
            empty.textContent = 'No exercises yet. Add one!';
            container.replaceChildren(empty);
            return;
        }

        // Sort by order
        const sortedExercises = [...exercises].sort((a, b) => a.order_index - b.order_index);
        container.replaceChildren();
        sortedExercises.forEach((ex) => {
            const repsText = ex.target_reps_max
                ? `${ex.target_reps_min}-${ex.target_reps_max}`
                : `${ex.target_reps_min}`;
            const weightText = ex.target_weight_kg ? ` @ ${ex.target_weight_kg}kg` : '';

            const card = document.createElement('div');
            card.className = 'wg-workouts-exercise-row';

            const info = document.createElement('div');
            info.className = 'wg-workouts-exercise-row__info';
            info.addEventListener('click', () => {
                showEditExerciseModal(ex.id);
            });

            const title = document.createElement('span');
            title.className = 'wg-workouts-exercise-row__title';
            title.textContent = `${ex.order_index + 1}. ${ex.exercise_name}`;

            const meta = document.createElement('span');
            meta.className = 'wg-workouts-exercise-row__meta';
            meta.textContent = `${ex.target_sets} sets × ${repsText} reps${weightText}`;

            info.appendChild(title);
            info.appendChild(meta);

            const deleteBtn = createDeleteButton((event) => {
                deleteExercise(ex.id, event);
            });
            deleteBtn.classList.add('workout-delete-btn-inline', 'wg-workouts-exercise-row__delete');

            card.appendChild(info);
            card.appendChild(deleteBtn);
            container.appendChild(card);
        });
    } catch (error) {
        console.error('Error loading exercises:', error);
        const message = document.createElement('p');
        message.className = 'text-danger';
        message.textContent = 'Error loading exercises';
        container.replaceChildren(message);
    }
}

async function resolveVariantForExercise() {
    if (window.WorkoutEdit.variantForExercise) return true;

    const groupId = window.WorkoutEdit.groupForVariant || window.WorkoutEdit.editingGroupId;
    if (!groupId) {
        safeAlert('Save this plan first to add exercises.');
        return false;
    }

    const group = window.WorkoutEdit.cachedGroups.find(g => g.id === groupId);
    if (group && group.is_rotating) {
        safeAlert('Open a day first to add exercises.');
        return false;
    }

    try {
        // The variant POST below is a workout mutation; invalidate the
        // workout-tagged caches if the implicit create succeeds so a later
        // cancel doesn't leave workout_next / workout_stats stale.
        let variants = await apiCall(`/api/workout/variants?group_id=${groupId}`);
        if (!variants || variants.length === 0) {
            const createdVariant = await apiCall('/api/workout/variants/create', 'POST', {
                group_id: groupId,
                name: 'Main',
                rotation_order: null,
                description: ''
            });
            if (createdVariant) {
                await invalidateWorkoutCache();
                variants = [createdVariant];
            } else {
                variants = [];
            }
        }

        const variantId = variants[0]?.id;
        if (!variantId) {
            safeAlert('Save this plan first to add exercises.');
            return false;
        }

        window.WorkoutEdit.groupForVariant = groupId;
        window.WorkoutEdit.variantForExercise = variantId;
        return true;
    } catch (error) {
        console.error('Failed to resolve variant for exercise modal:', error);
        safeAlert('Failed to prepare exercise editor. Please try again.');
        return false;
    }
}

async function showAddExerciseModal() {
    const canOpen = await resolveVariantForExercise();
    if (!canOpen) return;

    window.WorkoutEdit.editingExerciseId = null;
    document.getElementById('workout-exercise-modal-title').textContent = 'Add Exercise';
    window.ModalManager.workoutExercise.open();

    document.getElementById('workout-exercise-name').value = '';
    document.getElementById('workout-exercise-sets').value = '';
    document.getElementById('workout-exercise-reps-min').value = '';
    document.getElementById('workout-exercise-reps-max').value = '';
    document.getElementById('workout-exercise-weight').value = '';
    document.getElementById('workout-exercise-order').value = '0';
    document.getElementById('workout-exercise-progression').value = 'none';
    document.getElementById('workout-exercise-progression-increment').value = '';

    // New exercise inherits the routine goal; seed the rep-range + progression
    // defaults for it (all still editable), and wire the change cascade.
    document.getElementById('workout-exercise-goal').value = '';
    bindGoalCascade();
    applyGoalCascade(routineGoalForExercise());

    // Load exercise library for autocomplete via the shared picker (med-prk.3).
    let datalist = document.getElementById('exercise-library-datalist');
    if (!datalist) {
        datalist = document.createElement('datalist');
        datalist.id = 'exercise-library-datalist';
        document.body.appendChild(datalist);
        document.getElementById('workout-exercise-name').setAttribute('list', 'exercise-library-datalist');
    }
    const nameInput = document.getElementById('workout-exercise-name');
    await window.WorkoutLibrary.populatePickerOptions(datalist, nameInput);

    // Add change handler to pre-fill defaults from library
    nameInput.onchange = function () {
        const option = Array.from(datalist.options).find(o => o.value === nameInput.value);
        if (option) {
            if (!document.getElementById('workout-exercise-sets').value && option.dataset.sets)
                document.getElementById('workout-exercise-sets').value = option.dataset.sets;
            // In the Add flow reps are goal-cascade-seeded on open, so a bare
            // `!value` guard would never let a picked library exercise's own
            // saved reps through — a named pick is explicit, its reps win over
            // the seed. This handler is bound only in showAddExerciseModal but
            // leaks onto the shared name input into a later Edit open, where the
            // reps fields hold the user's stored targets (no seed); keep the
            // `!value` guard there so a rename doesn't clobber them.
            const isAdd = !window.WorkoutEdit.editingExerciseId;
            const repsMinEl = document.getElementById('workout-exercise-reps-min');
            const repsMaxEl = document.getElementById('workout-exercise-reps-max');
            if (option.dataset.repsMin && (isAdd || !repsMinEl.value))
                repsMinEl.value = option.dataset.repsMin;
            if (option.dataset.repsMax && (isAdd || !repsMaxEl.value))
                repsMaxEl.value = option.dataset.repsMax;
            if (!document.getElementById('workout-exercise-weight').value && option.dataset.weight)
                document.getElementById('workout-exercise-weight').value = option.dataset.weight;
        }
    };
}

async function showAddExerciseModalFromGroup() {
    // It's the same modal, we just use the default variant already set in WorkoutEdit.variantForExercise
    await showAddExerciseModal();
}

async function showEditExerciseModal(exerciseId) {
    window.WorkoutEdit.editingExerciseId = exerciseId;

    const exercises = await apiCall(`/api/workout/exercises?variant_id=${window.WorkoutEdit.variantForExercise}`);
    const exercise = exercises && exercises.find(e => e.id === exerciseId);
    if (!exercise) return;

    document.getElementById('workout-exercise-modal-title').textContent = 'Edit Exercise';
    window.ModalManager.workoutExercise.open();

    document.getElementById('workout-exercise-name').value = exercise.exercise_name;
    document.getElementById('workout-exercise-sets').value = exercise.target_sets;
    document.getElementById('workout-exercise-reps-min').value = exercise.target_reps_min;
    document.getElementById('workout-exercise-reps-max').value = exercise.target_reps_max || '';
    document.getElementById('workout-exercise-weight').value = exercise.target_weight_kg || '';
    document.getElementById('workout-exercise-order').value = exercise.order_index;

    const rule = exercise.progression_rule || { type: 'none' };
    document.getElementById('workout-exercise-progression').value = rule.type || 'none';
    document.getElementById('workout-exercise-progression-increment').value =
        rule.increment_kg != null ? rule.increment_kg : '';

    // Show the stored override (blank = inherit); the stored rep-range +
    // progression above are kept as-is — the cascade only fires on a change.
    document.getElementById('workout-exercise-goal').value = exercise.training_goal || '';
    bindGoalCascade();
}

function closeExerciseModal() {
    window.ModalManager.workoutExercise.close();
    window.WorkoutEdit.editingExerciseId = null;
}

async function saveExercise() {
    const name = document.getElementById('workout-exercise-name').value.trim();
    const sets = parseInt(document.getElementById('workout-exercise-sets').value);
    const repsMin = parseInt(document.getElementById('workout-exercise-reps-min').value);
    const repsMaxRaw = document.getElementById('workout-exercise-reps-max').value;
    const repsMax = repsMaxRaw !== '' ? parseInt(repsMaxRaw) : null;
    const weightRaw = document.getElementById('workout-exercise-weight').value;
    const weight = weightRaw !== '' ? parseFloat(weightRaw) : null;
    const order = parseInt(document.getElementById('workout-exercise-order').value) || 0;

    if (!name || !sets || !repsMin) {
        safeAlert('Exercise name, sets, and reps min are required!');
        return;
    }

    const progressionType = document.getElementById('workout-exercise-progression').value || 'none';
    const incrementRaw = document.getElementById('workout-exercise-progression-increment').value;
    const progressionRule = progressionType === 'none'
        ? { type: 'none' }
        : { type: progressionType, increment_kg: incrementRaw !== '' ? parseFloat(incrementRaw) : 2.5 };

    // Per-exercise goal override; blank ("Inherit from routine") clears it.
    const trainingGoal = document.getElementById('workout-exercise-goal').value;

    const payload = {
        variant_id: window.WorkoutEdit.variantForExercise,
        exercise_name: name,
        target_sets: sets,
        target_reps_min: repsMin,
        target_reps_max: repsMax,
        target_weight_kg: weight,
        order_index: order,
        progression_rule: progressionRule,
        training_goal: trainingGoal
    };

    let result;
    if (window.WorkoutEdit.editingExerciseId) {
        result = await apiCall(`/api/workout/exercises/update?id=${window.WorkoutEdit.editingExerciseId}`, 'PUT', payload);
    } else {
        result = await apiCall('/api/workout/exercises/create', 'POST', payload);
    }

    if (result || result === true) {
        await invalidateWorkoutCache();
        closeExerciseModal();
        loadExercisesForVariant(window.WorkoutEdit.variantForExercise, window.WorkoutEdit.exercisesContainerId);
    }
}

async function deleteExercise(exerciseId, event) {
    event.stopPropagation();
    await safeConfirm('Delete this exercise?', async (ok) => {
        if (ok) {
            await _deleteExerciseApi(exerciseId);
        }
    });
}

async function _deleteExerciseApi(id) {
    const result = await apiCall(`/api/workout/exercises/delete?id=${id}`, 'DELETE');
    if (result || result === true) {
        await invalidateWorkoutCache();
        loadExercisesForVariant(window.WorkoutEdit.variantForExercise, window.WorkoutEdit.exercisesContainerId);
    }
}

window.WorkoutExercises = {
    load: loadExercisesForVariant,
    save: saveExercise,
    openAdd: showAddExerciseModal,
    openAddFromGroup: showAddExerciseModalFromGroup,
    openEdit: showEditExerciseModal,
    close: closeExerciseModal,
    delete: deleteExercise,
    resolveVariant: resolveVariantForExercise
};
