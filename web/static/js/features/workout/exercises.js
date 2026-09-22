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

// Weight suggestion from the user's own logged history (med-73o). The goal
// defaults can seed every target on this form except the one that matters most
// — the weight — because that number is not a preference, it is what you
// actually lifted. GET /api/workout/exercises/suggest-target runs the same
// progression engine that advances a plan after a session over the newest
// completed log of this NAME, so the editor and the automatic progression can
// never disagree.
//
// Fill-only, exactly like the rep range: it writes only into an EMPTY field, so
// a weight the user typed — and an existing exercise's stored target on Edit —
// is never overwritten. The evidence line renders whenever there IS history,
// filled field or not: seeing "Last: 80 kg × 5 · RPE 8 · 2 RIR" is the first
// place in the app where a user's own effort ratings visibly do something.
// No history, offline, or a bodyweight-only past → null → field stays blank and
// no hint appears, i.e. exactly the behavior before this existed.
let _weightSuggestionSeq = 0; // module-state: ticket for the in-flight weight suggestion so a superseded read cannot write
async function applyWeightSuggestion(goal) {
    const nameEl = document.getElementById('workout-exercise-name');
    const weightEl = document.getElementById('workout-exercise-weight');
    const hintEl = document.getElementById('workout-exercise-weight-hint');
    if (!nameEl || !weightEl) return;
    if (hintEl) {
        hintEl.textContent = '';
        hintEl.hidden = true;
    }
    const name = nameEl.value.trim();
    if (!name) return;

    // Every call takes a ticket, and only the newest one may write. The name
    // input and the goal selector each re-ask, so two reads can be in flight at
    // once; without this an earlier response landing later would prescribe
    // Squat's weight (and Squat's evidence line) into a form that now says
    // Bench. Reads are local and fast, which makes the interleave rare — not
    // impossible, and a wrong weight is exactly the thing this feature exists
    // to prevent.
    const ticket = ++_weightSuggestionSeq;

    let suggestion = null;
    try {
        suggestion = await apiCall(
            `/api/workout/exercises/suggest-target?name=${encodeURIComponent(name)}&goal=${encodeURIComponent(goal || '')}`
        );
    } catch (error) {
        return; // bot mode 404s this route; a blank field is the old behavior
    }
    if (ticket !== _weightSuggestionSeq) return; // superseded
    if (!suggestion || suggestion.target_weight_kg == null) return;
    // Re-check emptiness: the read is async and the user may have typed a
    // weight (or switched to Edit) while it was in flight.
    if (!weightEl.value) weightEl.value = suggestion.target_weight_kg;

    const last = suggestion.last;
    if (!hintEl || !last || last.weight_kg == null) return;
    // The effort clause is omitted ENTIRELY when no work set of that log was
    // rated — never "RPE null", never a placeholder.
    const parts = [`${last.weight_kg} kg × ${last.reps}`];
    if (last.effort) parts.push(last.effort);
    hintEl.textContent = `Last: ${parts.join(' · ')}`;
    hintEl.hidden = false;
}

// Fill-only cascade: pre-fill rep-range + progression preset from the goal
// defaults, and the weight from history. Never disables editing; the user can
// still override every field. Returns the suggestion's promise so callers that
// care about the settled form (and tests) can await it.
function applyGoalCascade(goal) {
    const d = WORKOUT_GOAL_DEFAULTS[goal] || WORKOUT_GOAL_DEFAULTS.hypertrophy;
    document.getElementById('workout-exercise-reps-min').value = d.reps_min;
    document.getElementById('workout-exercise-reps-max').value = d.reps_max;
    document.getElementById('workout-exercise-progression').value = d.progression;
    return applyWeightSuggestion(goal);
}

// Wire the goal selector so changing it re-runs the cascade for the effective
// goal, and the name field so leaving it re-asks for that exercise's history
// (on open the name is still blank, so the suggestion has nothing to go on).
// Idempotent (assigns onchange, not addEventListener).
function bindGoalCascade() {
    const goalSel = document.getElementById('workout-exercise-goal');
    if (goalSel) goalSel.onchange = () => applyGoalCascade(effectiveExerciseGoal());
    const nameEl = document.getElementById('workout-exercise-name');
    // `onchange`, not `oninput`: the picker already owns `oninput` for its
    // suggestion list, and one read per finished name beats one per keystroke.
    // Returns a promise settling both refreshes, so awaiting callers (and
    // tests) observe the settled form.
    if (nameEl) nameEl.onchange = () => Promise.all([
        applyWeightSuggestion(effectiveExerciseGoal()),
        _refreshPlanEquipmentForName(nameEl.value),
    ]);
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
        safeToast('Save this plan first to add exercises.', 'info');
        return false;
    }

    const group = window.WorkoutEdit.cachedGroups.find(g => g.id === groupId);
    if (group && group.is_rotating) {
        safeToast('Open a day first to add exercises.', 'info');
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
            safeToast('Save this plan first to add exercises.', 'info');
            return false;
        }

        window.WorkoutEdit.groupForVariant = groupId;
        window.WorkoutEdit.variantForExercise = variantId;
        return true;
    } catch (error) {
        console.error('Failed to resolve variant for exercise modal:', error);
        safeToast('Failed to prepare exercise editor. Please try again.', 'error');
        return false;
    }
}

// med-niix.8: editable Equipment binding for the plan-exercise modal. The
// select mirrors the row's exercise_library_id → library item → equipment
// inventory (None = unbound); saving writes the row, so the gear applies to
// this exercise in every plan. Option fill is the shared _syncEquipmentSelect
// (library.js) — one implementation, no duplicate. The helper under the
// select shows the picked gear's step/max from the API verbatim, never
// recomputed here. Ticket-guarded and never throwing: a failed read leaves
// the helper hidden, and a failed library read marks the select unloaded so
// the save preserves the stored binding instead of unbinding it (same rule
// as the library editor).
let _equipmentHintSeq = 0; // module-state: ticket for the in-flight plan-equipment reads so a superseded read cannot write
// Synchronous reset of the plan modal's Equipment select, called before the
// first await on every entry path (open Add/Edit, picker pick, rename): the
// modal is shared, so the previous open's options/selection must not survive
// until the inventory read lands — saving inside that window would bind gear
// the user never chose. Also owns the legacy disabled state (a row without
// an exercise_library_id cannot bind) and the select's change wiring
// (idempotent assignment, like bindGoalCascade): a change only re-renders
// the step/max helper for the picked gear, it never writes.
function _resetPlanEquipmentSelect(disabled) {
    const select = document.getElementById('workout-exercise-equipment');
    if (select) {
        const doc = select.ownerDocument;
        select.replaceChildren();
        if (doc && typeof doc.createElement === 'function') {
            const none = doc.createElement('option');
            none.value = '';
            none.textContent = 'None';
            select.appendChild(none);
        }
        select.value = '';
        select.dataset.loaded = 'false';
        select.disabled = !!disabled;
        select.onchange = () => { _renderPlanEquipmentHelper(select.value).catch(() => {}); };
    }
    const hintEl = document.getElementById('workout-exercise-equipment-hint');
    if (hintEl) {
        hintEl.textContent = '';
        hintEl.hidden = true;
    }
    const scopeEl = document.getElementById('workout-exercise-equipment-scope');
    if (scopeEl) scopeEl.hidden = !!disabled;
}

// 'step X kg · max Y kg' for one inventory record; '' when there is nothing
// to show (unbound, dangling id, or gear with no step/max from the API).
function _planEquipmentHelperText(eq) {
    if (!eq) return '';
    const parts = [];
    if (eq.min_step_kg != null) parts.push(`step ${eq.min_step_kg} kg`);
    if (eq.max_kg != null) parts.push(`max ${eq.max_kg} kg`);
    return parts.join(' · ');
}

// Step/max helper text for one equipment id, resolved through the equipment
// module's shared cached list. A failed read hides the helper. Never throws.
async function _renderPlanEquipmentHelper(equipmentId) {
    const ticket = ++_equipmentHintSeq;
    const hintEl = document.getElementById('workout-exercise-equipment-hint');
    const select = document.getElementById('workout-exercise-equipment');
    if (!hintEl) return;
    hintEl.textContent = '';
    hintEl.hidden = true;
    if (equipmentId == null || equipmentId === '') return;
    let inv = [];
    try {
        if (window.WorkoutEquipment && typeof window.WorkoutEquipment.list === 'function') {
            inv = await window.WorkoutEquipment.list();
        } else {
            const raw = await apiCall('/api/workout/equipment', 'GET');
            if (Array.isArray(raw)) inv = raw;
        }
    } catch (_) { return; } // failed read leaves the helper hidden
    if (ticket !== _equipmentHintSeq) return; // superseded
    if (select && select.value !== String(equipmentId)) return; // a fill reset the select meanwhile
    const text = _planEquipmentHelperText(
        inv.find((e) => e && String(e.id) === String(equipmentId)) || null);
    if (!text) return; // dangling id reads as unbound
    hintEl.textContent = text;
    hintEl.hidden = false;
}

// Fill the plan modal's Equipment select for one library row: preselect the
// row's equipment_id through the shared _syncEquipmentSelect, then render
// the helper for it. A null id (unknown name, or a legacy row the caller
// disabled) fills None + inventory so gear stays pickable. Never throws: a
// failed library read marks the select unloaded so the save preserves the
// stored binding instead of unbinding it.
async function _fillPlanExerciseEquipment(libraryId, ticket = null) {
    if (ticket === null) ticket = ++_equipmentHintSeq;
    let boundId = '';
    let libraryOk = true;
    if (libraryId != null && libraryId !== '') {
        libraryOk = false;
        try {
            const items = await apiCall('/api/workout/exercise-library');
            if (ticket !== _equipmentHintSeq) return; // superseded
            const row = (Array.isArray(items) ? items : []).find((i) => i && i.id === libraryId) || null;
            const eq = row && row.equipment_id;
            boundId = (eq == null || eq === '') ? '' : String(eq);
            libraryOk = true;
        } catch (_) { libraryOk = false; } // failed lookup: the select stays unloaded below
    }
    const inventory = await _syncEquipmentSelect(boundId, 'workout-exercise-equipment', () => ticket === _equipmentHintSeq);
    if (ticket !== _equipmentHintSeq) return; // superseded
    const select = document.getElementById('workout-exercise-equipment');
    if (select && !libraryOk) select.dataset.loaded = 'false';
    const text = _planEquipmentHelperText(
        (Array.isArray(inventory) ? inventory : []).find((e) => e && boundId !== '' && String(e.id) === boundId) || null);
    if (!text) return;
    const hintEl = document.getElementById('workout-exercise-equipment-hint');
    if (hintEl) {
        hintEl.textContent = text;
        hintEl.hidden = false;
    }
}

// A hand-typed rename (no picker pick, so no change event and no onPick)
// re-resolves the select against the library row for the new name — the
// binding follows the row, and the row follows the name on save. Unknown
// name resets to None. The rename path passes its own entry ticket so
// ordering holds across the lookup fetch too.
async function _refreshPlanEquipmentForName(name) {
    _resetPlanEquipmentSelect(false);
    const ticket = ++_equipmentHintSeq;
    const clean = (name || '').trim().toLowerCase();
    let libId = null;
    if (clean) {
        try {
            const items = await apiCall('/api/workout/exercise-library');
            if (ticket !== _equipmentHintSeq) return; // superseded
            const row = (Array.isArray(items) ? items : []).find(
                (i) => String(i && i.name || '').trim().toLowerCase() === clean) || null;
            libId = row ? row.id : null;
        } catch (_) { return; } // failed lookup leaves the reset select (unloaded) alone
    }
    await _fillPlanExerciseEquipment(libId, ticket);
}

// Write the plan modal's picked gear to the library row (med-niix.8). No
// change — or unknown: legacy row, failed read — issues no library write.
// Otherwise the PUT is a full replacement built from the freshly read row,
// projected through DataStore.applyOptimistic (rule 9) with commit/rollback,
// and the library list repaints exactly as the library editor's own save.
async function _savePlanEquipmentBinding(pickedEquipmentId, libraryId) {
    if (pickedEquipmentId === null) return true; // unknown — never unbind blind
    if (libraryId == null || libraryId === '') return true; // legacy row: nothing to bind
    let rows = null;
    try {
        rows = await apiCall('/api/workout/exercise-library');
    } catch (_) { rows = null; }
    if (!Array.isArray(rows)) {
        safeAlert("Couldn't save the equipment — try again online.");
        return false;
    }
    const row = rows.find((i) => i && i.id === libraryId) || null;
    if (!row) return true; // the row is gone (deleted elsewhere): nothing to write
    const stored = (row.equipment_id == null || row.equipment_id === '') ? '' : String(row.equipment_id);
    if (stored === pickedEquipmentId) return true; // no change → no library write
    return _writePlanEquipmentBinding(libraryId, pickedEquipmentId === '' ? null : Number(pickedEquipmentId), row);
}

async function _writePlanEquipmentBinding(libraryId, nextEquipmentId, row) {
    const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
        ? await window.DataStore.applyOptimistic('exercise_library', (prev) => {
            if (!Array.isArray(prev)) return prev;
            return prev.map((r) => (r && r.id === libraryId ? { ...r, equipment_id: nextEquipmentId } : r));
        }, ['exercise_library'])
        : null;
    // Full replacement from the freshly read row (updateLibraryItem has no
    // patch semantics). Every field rides along explicitly — notably
    // body_part, which the update overwrites rather than preserves, so a
    // spread of the read shape (which omits unset keys) would wipe it.
    const payload = {
        name: row.name,
        default_sets: row.default_sets ?? 0,
        default_reps_min: row.default_reps_min ?? 0,
        default_reps_max: row.default_reps_max ?? null,
        default_weight_kg: row.default_weight_kg ?? null,
        notes: row.notes ?? '',
        body_part: row.body_part ?? '',
        equipment_id: nextEquipmentId,
    };
    let apiResult = null;
    try {
        apiResult = await apiCall(`/api/workout/exercise-library/update?id=${libraryId}`, 'PUT', payload, { suppressWriteAlert: true });
    } catch (e) {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        safeAlert('Error: ' + (e && e.message ? e.message : e));
        return false;
    }
    if (apiResult || apiResult === true) {
        // Reconcile against an authoritative list read — the PUT returns
        // true, not the record (same pattern as the equipment editor's save).
        let fresh = null;
        try {
            fresh = await apiCall('/api/workout/exercise-library', 'GET', null, { suppressWriteAlert: true });
        } catch (_) { /* commit keeps the optimistic row; the next load reconciles */ }
        if (handle) {
            try { await handle.commit(Array.isArray(fresh) ? fresh : null); }
            catch (_) { /* the repaint below covers it */ }
        }
        // Repaint the library list exactly as the library editor's own save
        // does, so the Exercises tab shows the new binding.
        if (typeof window.loadExerciseLibrary === 'function') {
            try { await window.loadExerciseLibrary(); } catch (_) { /* best-effort */ }
        }
        return true;
    }
    if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
    safeAlert("Couldn't save the equipment — try again online.");
    return false;
}

async function showAddExerciseModal() {
    const canOpen = await resolveVariantForExercise();
    if (!canOpen) return;

    window.WorkoutEdit.editingExerciseId = null;
    document.getElementById('workout-exercise-modal-title').textContent = 'Add Exercise';
    window.ModalManager.workoutExercise.open();
    // New exercise: no library row yet, so the select starts at None (still
    // enabled — a picked gear binds the promoted row on save). The reset runs
    // synchronously so no stale selection survives; the picker binds before
    // the inventory fill so its library prefetch keeps its long-standing
    // order ahead of it.
    _resetPlanEquipmentSelect(false);
    // Shared inline suggestion list (med-prk.3, med-max): library + catalog
    // names under the field, no native <datalist> popup over the keyboard.
    await window.WorkoutLibrary.bindExercisePicker({
        input: document.getElementById('workout-exercise-name'),
        mount: document.getElementById('workout-exercise-suggest'),
        onPick: onPlanExercisePicked
    });
    await _fillPlanExerciseEquipment(null);

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
    await applyGoalCascade(routineGoalForExercise());

}

// A row was tapped in the plan modal's suggestion list. Catalog-only rows carry
// no id and no defaults, so there is nothing to pre-fill from them.
function onPlanExercisePicked(item) {
    // The picker assigns input.value directly, which fires no `change` event —
    // so the name-driven weight suggestion has to be re-asked here. Runs for
    // catalog-only rows too (med-73o): a name with no library row can still
    // have ad-hoc logs behind it, and that history is the whole point.
    const suggested = applyWeightSuggestion(effectiveExerciseGoal());
    // Fire-and-forget, like the hint before it.
    _resetPlanEquipmentSelect(false);
    // A library pick preselects that row's gear; a catalog-only pick (no row
    // yet) fills None + inventory. Each fill takes its own ticket, so an
    // in-flight fill cannot paint over a newer pick.
    if (item && item.id != null) _fillPlanExerciseEquipment(item.id).catch(() => {});
    else _fillPlanExerciseEquipment(null).catch(() => {});
    if (!item || item.id == null) return suggested;
    if (!document.getElementById('workout-exercise-sets').value && item.default_sets)
        document.getElementById('workout-exercise-sets').value = item.default_sets;
    // In the Add flow reps are goal-cascade-seeded on open, so a bare `!value`
    // guard would never let a picked library exercise's own saved reps through
    // — a named pick is explicit, its reps win over the seed. The picker is
    // bound only in showAddExerciseModal but stays wired to the shared name
    // input into a later Edit open, where the reps fields hold the user's
    // stored targets (no seed); keep the `!value` guard there so a rename
    // doesn't clobber them.
    const isAdd = !window.WorkoutEdit.editingExerciseId;
    const repsMinEl = document.getElementById('workout-exercise-reps-min');
    const repsMaxEl = document.getElementById('workout-exercise-reps-max');
    if (item.default_reps_min && (isAdd || !repsMinEl.value))
        repsMinEl.value = item.default_reps_min;
    if (item.default_reps_max && (isAdd || !repsMaxEl.value))
        repsMaxEl.value = item.default_reps_max;
    // The library item's own saved default lands first (it is synchronous); the
    // in-flight suggestion then sees a filled field and only renders its hint.
    if (!document.getElementById('workout-exercise-weight').value && item.default_weight_kg)
        document.getElementById('workout-exercise-weight').value = item.default_weight_kg;
    return suggested;
}

async function showAddExerciseModalFromGroup() {
    // It's the same modal, we just use the default variant already set in WorkoutEdit.variantForExercise
    await showAddExerciseModal();
}

async function showEditExerciseModal(exerciseId) {
    window.WorkoutEdit.editingExerciseId = exerciseId;
    // Clear synchronously, before the first await: the modal is shared, and
    // the resolve below awaits the weight suggestion's network read first. A
    // stale select must never survive into the fill window — saving from it
    // would bind gear the user never chose.
    _resetPlanEquipmentSelect(false);

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
    // Not a cascade — the stored rep-range/progression above stay as-is. This
    // only clears any hint left over from a previous open and re-renders the
    // "Last: …" evidence for this exercise; the stored target above already
    // filled the weight field, so the fill-only guard leaves it alone.
    await applyWeightSuggestion(effectiveExerciseGoal());
    // Editable binding (med-niix.8): preselect the row's gear. A legacy row
    // without a library link keeps a disabled select and no helper.
    const planLibraryId = exercise.exercise_library_id;
    _resetPlanEquipmentSelect(planLibraryId == null || planLibraryId === '');
    await _fillPlanExerciseEquipment(planLibraryId);
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

    // med-niix.8: the Equipment select mirrors the library row's binding.
    // '' = None (unbind); null = unknown (legacy row without a library link,
    // or no real inventory read) — the library write is skipped so a failed
    // read can never silently unbind, same rule as the library editor.
    const planEquipmentSelect = document.getElementById('workout-exercise-equipment');
    const planEquipmentLoaded = !!planEquipmentSelect && !planEquipmentSelect.disabled
        && planEquipmentSelect.dataset.loaded === 'true';
    const pickedPlanEquipmentId = planEquipmentLoaded ? planEquipmentSelect.value : null;

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
        // med-niix.8: write the picked gear to the library row when it
        // differs. An edit-rename relinks the row by name, so the current
        // library link is re-read; a create carries the promoted id in its
        // response. The exercise write above already succeeded, so a failed
        // binding write alerts but still closes (re-saving an Add would
        // duplicate the exercise).
        if (window.WorkoutEdit.editingExerciseId) {
            let planLibraryId = null;
            try {
                const exercises = await apiCall(`/api/workout/exercises?variant_id=${window.WorkoutEdit.variantForExercise}`);
                const updated = (Array.isArray(exercises) ? exercises : [])
                    .find((e) => e && e.id === window.WorkoutEdit.editingExerciseId);
                planLibraryId = updated ? updated.exercise_library_id : null;
            } catch (_) { planLibraryId = null; }
            await _savePlanEquipmentBinding(pickedPlanEquipmentId, planLibraryId);
        } else {
            // Add path: only a picked gear binds the promoted row — None
            // leaves it alone, so a name matching an already-bound row keeps
            // its binding when the user never touched the select.
            const promotedId = result && result.exercise_library_id != null ? result.exercise_library_id : null;
            if (pickedPlanEquipmentId) await _savePlanEquipmentBinding(pickedPlanEquipmentId, promotedId);
        }
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
