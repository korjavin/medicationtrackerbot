// ====================================
// EXERCISES — Exercise page (within a Day)
// ====================================
//
// Owns the Exercise page of the plan editor (med-xso6.22, kit
// screens-workouts P3) and the exercise rows on the Day page / a flat plan's
// Plan page. "Done" builds the same payload the old exercise modal saved and
// stages it on the draft Day (window.WorkoutEdit.exerciseTarget); the Plan
// page's Save writes it (groups.js _writePlanDraft).

(function () {
    // The open Exercise page: { day, entry (null = new), onStaged, page }.
    let _exerciseTarget = null;

    window.WorkoutEdit = window.WorkoutEdit || {};
    Object.defineProperty(window.WorkoutEdit, 'exerciseTarget', {
        get: () => _exerciseTarget,
        set: (v) => { _exerciseTarget = v || null; },
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

// The plan's goal, used to resolve a "From plan" exercise goal to a concrete
// one. While the Plan page is open its live #workout-group-goal is the source
// of truth — it reflects an unsaved goal change that cachedGroups (only
// refreshed on save) wouldn't yet see. Otherwise that input holds a stale
// value, so fall back to the saved cachedGroups goal.
function routineGoalForExercise() {
    const draft = window.WorkoutEdit.planDraft;
    const liveGoal = document.getElementById('workout-group-goal');
    if (draft && liveGoal && liveGoal.value) return liveGoal.value;
    const groupId = draft ? draft.groupId : window.WorkoutEdit.editingGroupId;
    const group = (window.WorkoutEdit.cachedGroups || []).find(g => g.id === groupId);
    return (group && group.training_goal) || 'hypertrophy';
}

// Effective goal for the cascade: the per-exercise override if picked, else the
// plan's goal ("" in the selector = From plan).
function effectiveExerciseGoal() {
    return document.getElementById('workout-exercise-goal').value || routineGoalForExercise();
}

// The suggestion card's Apply shows only while the field holds something
// other than the suggested target.
function _syncSuggestApply() {
    const card = document.getElementById('workout-exercise-suggest-card');
    const apply = document.getElementById('workout-exercise-suggest-apply');
    const weightEl = document.getElementById('workout-exercise-weight');
    if (!card || !apply || !weightEl) return;
    const kg = card.dataset.weight;
    apply.hidden = card.hidden || kg === undefined || kg === '' || parseFloat(weightEl.value) === parseFloat(kg);
}

function applySuggestedWeight() {
    const card = document.getElementById('workout-exercise-suggest-card');
    const weightEl = document.getElementById('workout-exercise-weight');
    if (!card || !weightEl || !card.dataset.weight) return;
    weightEl.value = card.dataset.weight;
    if (typeof weightEl.onchange === 'function') weightEl.onchange();
    _syncSuggestApply();
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
// is never overwritten; the suggestion card's Apply is the explicit path. The
// evidence line renders whenever there IS history, filled field or not: seeing
// "Last: 80 kg × 5 · RPE 8 · 2 RIR" is the first place in the app where a
// user's own effort ratings visibly do something. No history, offline, or a
// bodyweight-only past → null → field stays blank and no card appears, i.e.
// exactly the behavior before this existed.
let _weightSuggestionSeq = 0; // module-state: ticket for the in-flight weight suggestion so a superseded read cannot write
async function applyWeightSuggestion(goal) {
    const nameEl = document.getElementById('workout-exercise-name');
    const weightEl = document.getElementById('workout-exercise-weight');
    const hintEl = document.getElementById('workout-exercise-weight-hint');
    const card = document.getElementById('workout-exercise-suggest-card');
    if (!nameEl || !weightEl) return;
    if (hintEl) {
        hintEl.textContent = '';
        hintEl.hidden = true;
    }
    if (card) {
        card.hidden = true;
        delete card.dataset.weight;
    }
    _syncSuggestApply();
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
    if (!weightEl.value) {
        weightEl.value = suggestion.target_weight_kg;
        // A programmatic write fires no change event: re-resolve the
        // weight-dependent equipment auto label (med-ni2j) explicitly.
        if (typeof weightEl.onchange === 'function') weightEl.onchange();
    }
    if (card) {
        card.dataset.weight = String(suggestion.target_weight_kg);
        const title = document.getElementById('workout-exercise-suggest-title');
        if (title) title.textContent = `Try ${suggestion.target_weight_kg} kg`;
        card.hidden = false;
        _syncSuggestApply();
    }

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
    workoutSegSync(document.querySelector('[data-workout-page="exercise"]'));
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

// The exercise as the rows and the editor see it: the loaded record with any
// staged edit on top.
function workoutExerciseView(entry) {
    return { ...(entry.rec || {}), ...(entry.payload || {}) };
}

// A duplicate of an exercise as a new staged row (Copy).
function _copyExercisePayload(view) {
    const payload = {
        exercise_name: view.exercise_name,
        target_sets: view.target_sets,
        target_reps_min: view.target_reps_min,
        target_reps_max: view.target_reps_max == null ? null : view.target_reps_max,
        target_weight_kg: view.target_weight_kg == null ? null : view.target_weight_kg,
        progression_rule: view.progression_rule || { type: 'none' },
        training_goal: view.training_goal || '',
    };
    if (view.equipment_id != null && view.equipment_id !== '') payload.equipment_id = Number(view.equipment_id);
    return payload;
}

// Exercise rows of one draft Day (Day page, or a flat plan's Plan page): grip
// (drag), a tap opens the Exercise page, swipe → Copy / Remove (staged).
function renderWorkoutExerciseRows(container, day, rerender) {
    if (!container || !day) return;
    if (!day.exercises.length) {
        container.replaceChildren(workoutEmptyRow('No exercises yet — add one.'));
        return;
    }
    const onMove = (from, to) => {
        if (workoutMoveItem(day.exercises, from, to)) {
            day.exReordered = true;
            rerender();
        }
    };
    const back = day.name || _planName();
    container.replaceChildren(...day.exercises.map((entry, i) => {
        const ex = workoutExerciseView(entry);
        const repsText = ex.target_reps_max && ex.target_reps_max !== ex.target_reps_min
            ? `${ex.target_reps_min}–${ex.target_reps_max}`
            : `${ex.target_reps_min}`;
        const weightText = ex.target_weight_kg ? ` · ${ex.target_weight_kg} kg` : '';

        const row = document.createElement('div');
        row.className = 'wg-row wg-workout-exercise-row';
        row.dataset.reorderIndex = String(i);
        const grip = _workoutIcon(document, 'grip', 'wg-grip');
        grip.setAttribute('aria-hidden', 'true');
        bindWorkoutRowDrag(grip, row, i, onMove);
        const body = document.createElement('span');
        body.className = 'wg-row__body';
        const title = document.createElement('span');
        title.className = 'wg-row__title';
        title.textContent = ex.exercise_name || 'Exercise';
        const meta = document.createElement('span');
        meta.className = 'wg-row__meta';
        meta.textContent = `${ex.target_sets} × ${repsText}${weightText}`;
        body.append(title, meta);
        row.append(grip, body);

        const copy = {
            label: 'Copy', icon: 'copy', onClick: () => {
                day.exercises.splice(i + 1, 0, { id: null, rec: null, payload: _copyExercisePayload(ex) });
                rerender();
            }
        };
        const remove = {
            label: 'Remove', icon: 'trash', danger: true, onClick: () => {
                day.exercises.splice(i, 1);
                if (entry.id != null) day.removed.push(entry.id);
                rerender();
            }
        };
        return window.WGRowActions.attach(row, {
            label: ex.exercise_name,
            tapEdits: true,
            onEdit: () => showEditExercisePage(day, entry, rerender, back),
            extra: [...workoutMoveActions(i, day.exercises.length, onMove), copy, remove],
            swipe: [copy, remove],
        });
    }));
}

// med-3gln: per-plan-row Equipment override for the Exercise page. The
// select binds the row's own equipment_id (preselected when set); blank means
// "no override" and falls back to the library row's binding, shown as the
// blank option's label ('from library: <name>', else 'None'). Works for rows
// with or without a library link. Done stages it on the plan row (the Plan Save writes it) — never
// the library (the library editor owns that binding). Option fill is the
// shared _syncEquipmentSelect (library.js) — one implementation, no
// duplicate. The helper under the select shows the effective gear's step/max
// from the API verbatim, never recomputed here. Ticket-guarded and never
// throwing: a failed inventory read leaves the select unloaded so the save
// omits the key and preserves the stored override (same rule as the library
// editor); a failed library read only loses the inherited label.
let _equipmentHintSeq = 0; // module-state: ticket for the in-flight plan-equipment reads so a superseded read cannot write
// The row's stored override ('<id>' or '') at page open, and the inherited
// library binding ({ id, name } | null) from the last fill: refills (picker
// pick, rename) keep displaying the stored override while re-resolving the
// inherited label, and the save compares the pick against the stored value so
// a stale inventory can never clear it blind.
let _planRowEquipmentId = ''; // module-state: the Exercise page's stored row-equipment override from open, for refills + the save's blind-clear guard
let _planInheritedEquipment = null; // module-state: the Exercise page's inherited library binding ({ id, name }) from the last fill, for the blank label + helper
// med-ni2j: with no library binding (not even a dangling one), blank means
// "auto-match from the inventory" (domain autoEquipmentForExercise on the
// modal's live name + target weight). Label + helper only: auto is computed
// on every fill/weight change and never written — blank still saves unbound.
let _planAutoEligible = false; // module-state: the last fill found no library binding, so a blank pick auto-matches
let _planAutoEquipment = null; // module-state: the auto-matched inventory item for the blank label + helper
// The selection a name-driven refill (picker pick, rename) must keep showing:
// the live pick when the select holds a real inventory read, else the stored
// override from page open. Without this a refill would restore the open-time
// value and silently discard an unsaved pick made before the rename.
function _currentPlanEquipmentPick() {
    const select = document.getElementById('workout-exercise-equipment');
    if (select && select.dataset.loaded === 'true') return select.value || '';
    return _planRowEquipmentId || '';
}
// Synchronous reset of the Exercise page's Equipment select, called before the
// first await on every entry path (open Add/Edit, picker pick, rename): the
// page body is reused, so the previous open's options/selection must not survive
// until the inventory read lands — saving inside that window would bind gear
// the user never chose. The select is always enabled (rows with or without a
// library link bind the same way) and owns the select's change wiring
// (idempotent assignment, like bindGoalCascade): a change only re-renders
// the step/max helper for the picked gear, it never writes.
function _resetPlanEquipmentSelect() {
    // Invalidate in-flight fills synchronously: every entry path resets
    // before its first await, so a previous open's fill cannot land in this
    // modal (later takes its own ticket for the reads that follow).
    ++_equipmentHintSeq;
    _planInheritedEquipment = null;
    _planAutoEligible = false;
    _planAutoEquipment = null;
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
        select.disabled = false;
        select.onchange = () => { _syncPlanEquipmentRow(); _renderPlanEquipmentHelper(select.value).catch(() => {}); };
    }
    _syncPlanEquipmentRow();
    // The target weight changes the auto pick: re-resolve the blank label +
    // helper once the select holds a real inventory read with blank picked.
    const weightEl = document.getElementById('workout-exercise-weight');
    if (weightEl) {
        weightEl.onchange = () => {
            _syncSuggestApply();
            const s = document.getElementById('workout-exercise-equipment');
            if (!s || s.dataset.loaded !== 'true' || s.value !== '') return Promise.resolve();
            return _renderPlanEquipmentHelper('').catch(() => {});
        };
    }
    const hintEl = document.getElementById('workout-exercise-equipment-hint');
    if (hintEl) {
        hintEl.textContent = '';
        hintEl.hidden = true;
    }
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

// Re-resolve the auto-matched item for the modal's live name + target weight
// and label the blank option 'auto: <name>' (else 'None'). Only when the last
// fill found no library binding; a missing/failed domain import reads as None.
// Ticket-guarded, never throws, never writes.
async function _relabelPlanAutoEquipment(list, ticket) {
    let item = null;
    if (_planAutoEligible && Array.isArray(list) && list.length > 0) {
        const nameEl = document.getElementById('workout-exercise-name');
        const weightEl = document.getElementById('workout-exercise-weight');
        try {
            const domain = await window.WorkoutGroups.loadEquipmentDomain();
            if (domain && typeof domain.equipmentForExercise === 'function') {
                // med-8j5w.2: the shared location-aware rule at the active gym
                // (auto-match only gear available there). Eligible means no
                // binding is honored here, so the row resolves unbound.
                const location = window.WorkoutEquipment && typeof window.WorkoutEquipment.locationScope === 'function'
                    ? await window.WorkoutEquipment.locationScope() : null;
                const name = nameEl ? nameEl.value : '';
                const hit = domain.equipmentForExercise({ equipment_id: null, exercise_name: name }, null,
                    list, weightEl ? parseFloat(weightEl.value) : NaN, location);
                item = hit && hit.auto ? hit.item : null;
            }
        } catch (_) { item = null; }
    }
    if (ticket !== _equipmentHintSeq) return; // superseded
    _planAutoEquipment = item;
    const select = document.getElementById('workout-exercise-equipment');
    if (select && select.options.length > 0 && select.options[0].value === '' && !_planInheritedEquipment) {
        select.options[0].textContent = item ? `auto: ${item.name || `Equipment ${item.id}`}` : 'None';
    }
    _syncPlanEquipmentRow();
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
    // Blank means "inherit": the helper shows the inherited gear's step/max
    // (what the row actually resolves to) rather than hiding — or, with no
    // library binding, the auto-matched gear's (med-ni2j).
    const fromSelect = !(equipmentId == null || equipmentId === '');
    const effectiveId = fromSelect
        ? equipmentId
        : (_planInheritedEquipment ? _planInheritedEquipment.id : '');
    const wantAuto = !fromSelect && effectiveId === '' && _planAutoEligible;
    if ((effectiveId == null || effectiveId === '') && !wantAuto) return;
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
    if (fromSelect && select && select.value !== String(effectiveId)) return; // a fill reset the select meanwhile
    if (wantAuto) {
        await _relabelPlanAutoEquipment(inv, ticket);
        if (ticket !== _equipmentHintSeq) return; // superseded
    }
    const text = _planEquipmentHelperText(wantAuto ? _planAutoEquipment
        : (inv.find((e) => e && String(e.id) === String(effectiveId)) || null));
    if (!text) return; // dangling id reads as unbound
    hintEl.textContent = text;
    hintEl.hidden = false;
}

// Fill the Exercise page's Equipment select: preselect the row's own override
// through the shared _syncEquipmentSelect, and label the blank option with
// the inherited library binding ('from library: <name>', else 'None'). A null
// library id (unknown name, or a row without a library link) labels blank as
// None — the override still preselects and saves, because the binding is
// row-scoped now. Never throws: a failed library read only loses the
// inherited label, while a failed inventory read marks the select unloaded so
// the save preserves the stored override instead of clearing it.
async function _fillPlanExerciseEquipment(rowEquipmentId, libraryId, ticket = null) {
    if (ticket === null) ticket = ++_equipmentHintSeq;
    const rowId = (rowEquipmentId == null || rowEquipmentId === '') ? '' : String(rowEquipmentId);
    let inheritedId = '';
    let libraryKnown = true; // a failed library read must not guess "unbound" into an auto label
    if (libraryId != null && libraryId !== '') {
        let items = null;
        try {
            items = await apiCall('/api/workout/exercise-library');
        } catch (_) { items = null; }
        if (ticket !== _equipmentHintSeq) return; // superseded
        // apiCall resolves null (not a throw) on a failed GET — only a real
        // list resolves the inherited binding; anything else labels blank as
        // None without touching the select's loaded state.
        if (Array.isArray(items)) {
            const row = items.find((i) => i && i.id === libraryId) || null;
            const eq = row && row.equipment_id;
            inheritedId = (eq == null || eq === '') ? '' : String(eq);
        } else {
            libraryKnown = false;
        }
    }
    const inventory = await _syncEquipmentSelect(rowId, 'workout-exercise-equipment', () => ticket === _equipmentHintSeq);
    if (ticket !== _equipmentHintSeq) return; // superseded
    const list = Array.isArray(inventory) ? inventory : [];
    let inherited = inheritedId !== ''
        ? list.find((e) => e && String(e.id) === inheritedId) || null
        : null;
    // med-8j5w.2: the effective preview follows the location-aware rule at the
    // active gym — a library binding to gear at ANOTHER gym is not honored
    // there and falls through to auto-match, so label it as such. (An explicit
    // pick of any gym's gear stays selectable in the select itself.)
    let inheritedOffGym = false;
    if (inherited) {
        try {
            const location = window.WorkoutEquipment && typeof window.WorkoutEquipment.locationScope === 'function'
                ? await window.WorkoutEquipment.locationScope() : null;
            const domain = location ? await window.WorkoutGroups.loadEquipmentDomain() : null;
            if (domain && typeof domain.inventoryAt === 'function'
                && domain.inventoryAt(list, location.locationId, location.liveLocationIds).indexOf(inherited) === -1) {
                inheritedOffGym = true;
            }
        } catch (_) { inheritedOffGym = false; }
        if (ticket !== _equipmentHintSeq) return; // superseded
        if (inheritedOffGym) inherited = null;
    }
    _planInheritedEquipment = inherited
        ? { id: inheritedId, name: inherited.name || `Equipment ${inheritedId}` }
        : null;
    const select = document.getElementById('workout-exercise-equipment');
    if (select && select.options.length > 0 && select.options[0].value === '') {
        select.options[0].textContent = _planInheritedEquipment
            ? `from library: ${_planInheritedEquipment.name}` : 'None';
    }
    _syncPlanEquipmentRow();
    // No library binding at all (a dangling one stays unbound, like the
    // domain rule): a blank pick auto-matches — label it (med-ni2j).
    // A dangling stored row override is explicit too: the save preserves it
    // and the domain resolves it to no gear, so it never auto-matches.
    const storedRow = _planRowEquipmentId || '';
    const rowDangling = storedRow !== '' && !list.some((e) => e && String(e.id) === storedRow);
    _planAutoEligible = libraryKnown && (inheritedId === '' || inheritedOffGym) && !rowDangling;
    if (_planAutoEligible && select && select.dataset.loaded === 'true' && select.value === '') {
        await _relabelPlanAutoEquipment(list, ticket);
        if (ticket !== _equipmentHintSeq) return; // superseded
    }
    // Helper for the effective gear (override, else inherited, else auto).
    const effective = (select && select.value !== '') ? select.value : (inheritedOffGym ? '' : inheritedId);
    const text = _planEquipmentHelperText(effective === '' ? _planAutoEquipment
        : (list.find((e) => e && String(e.id) === String(effective)) || null));
    if (!text) return;
    const hintEl = document.getElementById('workout-exercise-equipment-hint');
    if (hintEl) {
        hintEl.textContent = text;
        hintEl.hidden = false;
    }
}

// A hand-typed rename (no picker pick, so no change event and no onPick)
// re-resolves the inherited label against the library row for the new name —
// the live pick itself is name-independent and stays selected. Unknown
// name labels blank as None. The rename path passes its own entry ticket so
// ordering holds across the lookup fetch too.
async function _refreshPlanEquipmentForName(name) {
    const live = _currentPlanEquipmentPick();
    _resetPlanEquipmentSelect();
    const ticket = ++_equipmentHintSeq;
    const clean = (name || '').trim().toLowerCase();
    let libId = null;
    if (clean) {
        let items = null;
        try {
            items = await apiCall('/api/workout/exercise-library');
        } catch (_) { return; } // failed lookup leaves the reset select (unloaded) alone
        if (ticket !== _equipmentHintSeq) return; // superseded
        if (!Array.isArray(items)) return; // failed lookup (null, not a throw): same, no verified None
        const row = items.find(
            (i) => String(i && i.name || '').trim().toLowerCase() === clean) || null;
        libId = row ? row.id : null;
    }
    await _fillPlanExerciseEquipment(live, libId, ticket);
}

// The Equipment value row mirrors the hidden select (the data the save reads).
function _syncPlanEquipmentRow() {
    const select = document.getElementById('workout-exercise-equipment');
    const value = document.getElementById('workout-exercise-equipment-value');
    if (!select || !value) return;
    const opt = select.options[select.selectedIndex] || select.options[0];
    value.textContent = opt ? opt.textContent : 'None';
}

async function chooseWorkoutExerciseEquipment() {
    const select = document.getElementById('workout-exercise-equipment');
    if (!select) return;
    const picked = await safeChoose('Gear for this plan row', Array.from(select.options).map((o) => ({
        value: o.value,
        label: o.textContent,
        selected: o.value === select.value,
    })), { title: 'Equipment' });
    if (picked === null || picked === undefined) return;
    select.value = picked;
    _syncPlanEquipmentRow();
    if (typeof select.onchange === 'function') select.onchange();
}

// Push the Exercise page (body moved in from the store). Returns the target,
// or null when the page can't open (already open, or no WGPage).
function _pushExercisePage(target, title, back) {
    const store = document.querySelector('.wg-workout-pages');
    const body = _workoutPageBody('exercise');
    if (!store || !body || !window.WGPage) return null;
    window.WorkoutEdit.exerciseTarget = target;
    target.page = window.WGPage.push({
        title,
        crumb: back,
        back: back || 'Day',
        body,
        primary: { label: 'Done', onClick: () => stageExercise() },
        onBack: () => workoutConfirmDiscard(workoutFormSnapshot(body) !== target.snapshot, 'Your changes to this exercise won\'t be kept.'),
        onClose: () => {
            store.appendChild(body);
            if (window.WorkoutEdit.exerciseTarget === target) window.WorkoutEdit.exerciseTarget = null;
        },
    });
    return target;
}

function _markExercisePageClean(target) {
    const body = document.querySelector('[data-workout-page="exercise"]');
    if (target && body) target.snapshot = workoutFormSnapshot(body);
}

// Add an exercise to a draft Day. onStaged re-renders the caller's rows.
async function showAddExercisePage(day, onStaged, back) {
    const target = _pushExercisePage({ day: day || null, entry: null, onStaged, page: null, snapshot: '' }, 'New exercise', back);
    if (!target) return null;
    // Clear every field synchronously, before any await, so the previous
    // exercise's values can never paint into the Add form while the
    // picker/inventory reads are in flight (a Done in that window would
    // otherwise duplicate the old row, and typing would be wiped by a late
    // reset).
    document.getElementById('workout-exercise-name').value = '';
    document.getElementById('workout-exercise-sets').value = '';
    document.getElementById('workout-exercise-reps-min').value = '';
    document.getElementById('workout-exercise-reps-max').value = '';
    document.getElementById('workout-exercise-weight').value = '';
    document.getElementById('workout-exercise-progression').value = 'none';
    document.getElementById('workout-exercise-progression-increment').value = '';
    document.getElementById('workout-exercise-goal').value = '';
    workoutSegSync(document.querySelector('[data-workout-page="exercise"]'));
    // New exercise: no stored row yet, so the select starts blank (a picked
    // gear rides the staged payload as the row override). The reset runs
    // synchronously so no stale selection survives; the picker binds before
    // the inventory fill so its library prefetch keeps its long-standing
    // order ahead of it.
    _planRowEquipmentId = '';
    _resetPlanEquipmentSelect();
    bindGoalCascade();
    // Shared inline suggestion list (med-prk.3, med-max): library + catalog
    // names under the field, no native <datalist> popup over the keyboard.
    await window.WorkoutLibrary.bindExercisePicker({
        input: document.getElementById('workout-exercise-name'),
        mount: document.getElementById('workout-exercise-suggest'),
        onPick: onPlanExercisePicked
    });
    await _fillPlanExerciseEquipment('', null);

    // A new exercise inherits the plan goal; seed the rep-range + progression
    // defaults for it (all still editable).
    await applyGoalCascade(routineGoalForExercise());
    _markExercisePageClean(target);
    return target;
}

// A row was tapped in the suggestion list. Catalog-only rows carry no id and
// no defaults, so there is nothing to pre-fill from them.
function onPlanExercisePicked(item) {
    // The picker assigns input.value directly, which fires no `change` event —
    // so the name-driven weight suggestion has to be re-asked here. Runs for
    // catalog-only rows too (med-73o): a name with no library row can still
    // have ad-hoc logs behind it, and that history is the whole point.
    const suggested = applyWeightSuggestion(effectiveExerciseGoal());
    // Fire-and-forget, like the hint before it.
    const live = _currentPlanEquipmentPick();
    _resetPlanEquipmentSelect();
    // A library pick re-resolves the inherited label from that row; a
    // catalog-only pick (no row yet) labels blank as None. The live pick
    // stays selected either way. Each fill takes its own ticket, so an
    // in-flight fill cannot paint over a newer pick.
    if (item && item.id != null) _fillPlanExerciseEquipment(live, item.id).catch(() => {});
    else _fillPlanExerciseEquipment(live, null).catch(() => {});
    if (!item || item.id == null) return suggested;
    if (!document.getElementById('workout-exercise-sets').value && item.default_sets)
        document.getElementById('workout-exercise-sets').value = item.default_sets;
    // In the Add flow reps are goal-cascade-seeded on open, so a bare `!value`
    // guard would never let a picked library exercise's own saved reps through
    // — a named pick is explicit, its reps win over the seed. The picker is
    // bound only in showAddExercisePage but stays wired to the shared name
    // input into a later Edit open, where the reps fields hold the user's
    // stored targets (no seed); keep the `!value` guard there so a rename
    // doesn't clobber them.
    const target = window.WorkoutEdit.exerciseTarget;
    const isAdd = !target || !target.entry;
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

// Edit a draft Day's exercise (its loaded record with any staged edit on top).
async function showEditExercisePage(day, entry, onStaged, back) {
    if (!entry) return null;
    const exercise = workoutExerciseView(entry);
    const target = _pushExercisePage({ day: day || null, entry, onStaged, page: null, snapshot: '' },
        exercise.exercise_name || 'Exercise', back);
    if (!target) return null;
    // Clear synchronously, before the first await: the page body is shared,
    // and the weight suggestion below awaits a read first. A stale select must
    // never survive into the fill window — staging from it would bind gear
    // the user never chose.
    _planRowEquipmentId = '';
    _resetPlanEquipmentSelect();

    document.getElementById('workout-exercise-name').value = exercise.exercise_name || '';
    document.getElementById('workout-exercise-sets').value = exercise.target_sets;
    document.getElementById('workout-exercise-reps-min').value = exercise.target_reps_min;
    document.getElementById('workout-exercise-reps-max').value = exercise.target_reps_max || '';
    document.getElementById('workout-exercise-weight').value = exercise.target_weight_kg || '';

    const rule = exercise.progression_rule || { type: 'none' };
    document.getElementById('workout-exercise-progression').value = rule.type || 'none';
    document.getElementById('workout-exercise-progression-increment').value =
        rule.increment_kg != null ? rule.increment_kg : '';

    // Show the stored override (blank = From plan); the stored rep-range +
    // progression above are kept as-is — the cascade only fires on a change.
    document.getElementById('workout-exercise-goal').value = exercise.training_goal || '';
    workoutSegSync(document.querySelector('[data-workout-page="exercise"]'));
    bindGoalCascade();
    // Not a cascade — the stored rep-range/progression above stay as-is. This
    // only clears any card left over from a previous open and re-renders the
    // "Last: …" evidence for this exercise; the stored target above already
    // filled the weight field, so the fill-only guard leaves it alone.
    await applyWeightSuggestion(effectiveExerciseGoal());
    // Row-scoped override (med-3gln): preselect the row's own binding; blank
    // inherits the library row's binding, shown as the blank label. Rows with
    // or without a library link bind the same way.
    _planRowEquipmentId = (exercise.equipment_id == null || exercise.equipment_id === '')
        ? '' : String(exercise.equipment_id);
    _resetPlanEquipmentSelect();
    await _fillPlanExerciseEquipment(_planRowEquipmentId, exercise.exercise_library_id ?? null);
    _markExercisePageClean(target);
    return target;
}

function closeExercisePage() {
    const target = window.WorkoutEdit.exerciseTarget;
    if (target && target.page) target.page.close();
}

// The exercise payload from the page's fields — the old editor's save body
// minus variant_id / order_index, which the Plan save adds per Day. null (with
// an alert) when a required field is missing.
function buildExercisePayload() {
    const name = document.getElementById('workout-exercise-name').value.trim();
    const sets = parseInt(document.getElementById('workout-exercise-sets').value);
    const repsMin = parseInt(document.getElementById('workout-exercise-reps-min').value);
    const repsMaxRaw = document.getElementById('workout-exercise-reps-max').value;
    const repsMax = repsMaxRaw !== '' ? parseInt(repsMaxRaw) : null;
    const weightRaw = document.getElementById('workout-exercise-weight').value;
    const weight = weightRaw !== '' ? parseFloat(weightRaw) : null;

    if (!name || !sets || !repsMin) {
        safeAlert('Exercise name, sets, and reps min are required!');
        return null;
    }

    const progressionType = document.getElementById('workout-exercise-progression').value || 'none';
    const incrementRaw = document.getElementById('workout-exercise-progression-increment').value;
    const progressionRule = progressionType === 'none'
        ? { type: 'none' }
        : { type: progressionType, increment_kg: incrementRaw !== '' ? parseFloat(incrementRaw) : 2.5 };

    // Per-exercise goal override; blank ("From plan") clears it.
    const trainingGoal = document.getElementById('workout-exercise-goal').value;

    // med-3gln: the Equipment select binds the plan row's own equipment_id.
    // A loaded '' clears the override (falls back to the library); an
    // UNLOADED select (no real inventory read) omits the key so the stored
    // override survives, same rule as the library editor.
    const planEquipmentSelect = document.getElementById('workout-exercise-equipment');
    const planEquipmentLoaded = !!planEquipmentSelect
        && planEquipmentSelect.dataset.loaded === 'true';
    const pickedPlanEquipmentId = planEquipmentLoaded ? planEquipmentSelect.value : null;
    // The select's own option values at save time (sync DOM read): a stored
    // override the options lack (stale inventory, dangling id) makes blank
    // ambiguous — omit the key then, never clear blind.
    const planEquipmentOptions = planEquipmentSelect
        ? Array.from(planEquipmentSelect.options).map((o) => o.value) : [];

    const payload = {
        exercise_name: name,
        target_sets: sets,
        target_reps_min: repsMin,
        target_reps_max: repsMax,
        target_weight_kg: weight,
        progression_rule: progressionRule,
        training_goal: trainingGoal
    };
    if (pickedPlanEquipmentId !== null) {
        const stored = _planRowEquipmentId || '';
        if (pickedPlanEquipmentId === '') {
            // Blank clears a stored override (falls back to the library);
            // blank with nothing stored omits the key — the domain treats
            // omit and null identically here, and the untouched payload
            // stays byte-identical to before this bead. A stored override
            // the options lack (stale inventory, dangling id) also omits —
            // never clear blind.
            if (stored !== '' && planEquipmentOptions.includes(stored)) {
                payload.equipment_id = null;
            }
        } else {
            payload.equipment_id = Number(pickedPlanEquipmentId);
        }
    }
    return payload;
}

// "Done": stage the payload on the draft Day and return to it. A re-edit
// merges over the earlier staged edit, so a key the second pass omits (an
// untouched equipment select) keeps the first pass's value.
function stageExercise() {
    const payload = buildExercisePayload();
    if (!payload) return null;
    const target = window.WorkoutEdit.exerciseTarget;
    if (target && target.day) {
        if (target.entry) target.entry.payload = { ...(target.entry.payload || {}), ...payload };
        else target.day.exercises.push({ id: null, rec: null, payload });
    }
    if (target && target.page) target.page.close();
    if (target && typeof target.onStaged === 'function') target.onStaged();
    return payload;
}

window.WorkoutExercises = {
    openAdd: showAddExercisePage,
    openEdit: showEditExercisePage,
    close: closeExercisePage,
    done: stageExercise,
    buildPayload: buildExercisePayload,
    renderRows: renderWorkoutExerciseRows,
    chooseEquipment: chooseWorkoutExerciseEquipment,
    applySuggestion: applySuggestedWeight,
};
