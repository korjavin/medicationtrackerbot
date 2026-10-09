// ====================================
// DAYS (variants) — Day page
// ====================================
//
// Owns the Day page of the plan editor (med-xso6.22, kit screens-workouts P2)
// and the Day rows on the Plan page. A Day page edits a working copy of one
// draft Day (window.WorkoutEdit.dayTarget); "Done" stages it back into the
// plan draft (groups.js) — no network write until the Plan page's Save.
// Internal ids keep the "variant" name; the UI says Day.

(function () {
    // The open Day page: { day (draft Day or null = new), work, page, onDone }.
    let _dayTarget = null;

    window.WorkoutEdit = window.WorkoutEdit || {};
    Object.defineProperty(window.WorkoutEdit, 'dayTarget', {
        get: () => _dayTarget,
        set: (v) => { _dayTarget = v || null; },
        enumerable: true,
        configurable: true
    });
})();

// A Day row on the Plan page: grip (drag) + name + exercise count; a tap opens
// the Day page; the overflow menu holds Move up/down and Delete.
function buildWorkoutDayRow(day, index, length, onMove) {
    const row = document.createElement('div');
    row.className = 'wg-row wg-workout-day-row';
    row.dataset.reorderIndex = String(index);

    const grip = _workoutIcon(document, 'grip', 'wg-grip');
    grip.setAttribute('aria-hidden', 'true');
    bindWorkoutRowDrag(grip, row, index, onMove);
    row.appendChild(grip);

    const body = document.createElement('span');
    body.className = 'wg-row__body';
    const title = document.createElement('span');
    title.className = 'wg-row__title';
    title.textContent = day.name || 'Day';
    const meta = document.createElement('span');
    meta.className = 'wg-row__meta';
    const n = day.exercises.length;
    meta.textContent = [`${n} exercise${n === 1 ? '' : 's'}`, day.description].filter(Boolean).join(' · ');
    body.append(title, meta);
    row.appendChild(body);

    return window.WGRowActions.attach(row, {
        label: day.name || 'Day',
        tapEdits: true,
        onEdit: () => openWorkoutDayPage(day, renderWorkoutPlanBody),
        extra: workoutMoveActions(index, length, onMove),
        onDelete: () => removeWorkoutPlanDay(day),
    });
}

// Staged: the Day (and, at Save, its exercises — the domain cascades) leaves
// the draft now and is deleted when the plan is saved.
async function removeWorkoutPlanDay(day) {
    const draft = window.WorkoutEdit.planDraft;
    if (!draft) return;
    const ok = await safeConfirm('Delete this day and all its exercises?', null, { title: 'Delete day', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    const i = draft.days.indexOf(day);
    if (i === -1) return;
    draft.days.splice(i, 1);
    if (day.id != null) draft.removedDays.push(day.id);
    renderWorkoutPlanBody();
}

function _cloneWorkoutDay(day) {
    return JSON.parse(JSON.stringify(day));
}

function _renderDayPageRows() {
    const t = window.WorkoutEdit.dayTarget;
    if (!t) return;
    const count = document.getElementById('workout-exercises-count');
    if (count) count.textContent = t.work.exercises.length ? `Exercises · ${t.work.exercises.length}` : 'Exercises';
    renderWorkoutExerciseRows(document.getElementById('workout-exercises-list'), t.work, _renderDayPageRows);
}

// Open the Day page for a draft Day, or a new one (day = null). onDone runs
// after "Done" staged it (re-renders the Plan page).
function openWorkoutDayPage(day, onDone) {
    const store = document.querySelector('.wg-workout-pages');
    const body = _workoutPageBody('day');
    if (!store || !body || !window.WGPage || !window.WorkoutEdit.planDraft) return null;

    const work = day ? _cloneWorkoutDay(day) : newPlanDay('', false);
    document.getElementById('workout-variant-name').value = work.name || '';
    document.getElementById('workout-variant-description').value = work.description || '';
    const target = { day, work, page: null, onDone };
    window.WorkoutEdit.dayTarget = target;
    _renderDayPageRows();

    let snapshot = '';
    const daySnapshot = () => workoutFormSnapshot(body, [work.exercises, work.removed]);
    const planName = _planName();
    target.page = window.WGPage.push({
        title: day ? (day.name || 'Day') : 'New day',
        crumb: planName,
        back: planName,
        body,
        primary: { label: 'Done', onClick: () => stageWorkoutDay() },
        onBack: () => workoutConfirmDiscard(daySnapshot() !== snapshot, 'Your changes to this day won\'t be kept.'),
        onClose: () => {
            store.appendChild(body);
            if (window.WorkoutEdit.dayTarget === target) window.WorkoutEdit.dayTarget = null;
        },
    });
    snapshot = daySnapshot();
    return target.page;
}

// "Done": fold the working copy into the plan draft and return to the Plan.
function stageWorkoutDay() {
    const t = window.WorkoutEdit.dayTarget;
    const draft = window.WorkoutEdit.planDraft;
    if (!t || !draft) return false;
    const name = document.getElementById('workout-variant-name').value.trim();
    if (!name) {
        safeAlert('Day name is required');
        return false;
    }
    t.work.name = name;
    t.work.description = document.getElementById('workout-variant-description').value.trim();
    t.work.implicit = false;
    if (t.day) Object.assign(t.day, t.work);
    else draft.days.push(t.work);
    t.page.close();
    if (typeof t.onDone === 'function') t.onDone();
    return true;
}

function addExerciseToWorkoutDay() {
    const t = window.WorkoutEdit.dayTarget;
    if (!t) return null;
    const name = document.getElementById('workout-variant-name').value.trim() || 'Day';
    return showAddExercisePage(t.work, _renderDayPageRows, name);
}

window.WorkoutVariants = {
    openAdd: () => openWorkoutDayPage(null, renderWorkoutPlanBody),
    openEdit: openWorkoutDayPage,
    done: stageWorkoutDay,
    remove: removeWorkoutPlanDay,
    addExercise: addExerciseToWorkoutDay,
};
