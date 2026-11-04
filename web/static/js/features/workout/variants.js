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
    // Count only (PL3): the description is edited on the Day page.
    meta.textContent = `${n} exercise${n === 1 ? '' : 's'}`;
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

// ====================================
// DAY PAGE · read (med-jqrf.3, kit screens-plans PL2)
// ====================================
//
// Opened from a Plans-tab day row. Read-only, no editor state: the full
// description, each exercise with its target and last time, Edit (opens the
// editor on this day) and the page's one sun, "Start this day".

// "last 4 × 5 · 97.5 kg" from the newest history row: its set count, the
// first set's reps, the heaviest weight. Warm-ups don't count. '' = never.
function _planDayLastText(rows) {
    const row = Array.isArray(rows) ? rows[0] : null;
    const all = row && Array.isArray(row.sets) ? row.sets : [];
    const sets = all.filter((s) => s && s.set_type !== 'warmup');
    if (!sets.length) return '';
    const kg = Math.max(...sets.map((s) => Number(s.weight_kg) || 0));
    return `last ${sets.length} × ${Number(sets[0].reps) || 0}${kg > 0 ? ` · ${kg} kg` : ''}`;
}

// "last done Wed 28.10 · 47 min"; null parts are left out.
function _planDayDoneText(day) {
    const d = _planLocalDate(day.last_completed_date);
    const parts = [];
    if (d) parts.push(`last done ${d.toLocaleDateString('en-US', { weekday: 'short' })} ${_planDDMM(d)}`);
    if (day.last_duration_min) parts.push(`${day.last_duration_min} min`);
    return parts.join(' · ');
}

// workout_plans with this plan's next day moved to `dayId` (the optimistic
// state of set-variant).
function _planWithNextDay(prev, planId, dayId) {
    if (!prev || !Array.isArray(prev.plans)) return prev;
    return {
        ...prev,
        plans: prev.plans.map((p) => (p.id !== planId ? p : {
            ...p,
            next: p.next ? { ...p.next, variant_id: dayId } : p.next,
            days: (p.days || []).map((d) => ({ ...d, is_next: d.id === dayId })),
        })),
    };
}

// This plan and day as the /api/workout/plans read has them now (it is the
// truth for "next"); the row's copy when the read failed.
async function _planDayNow(plan, day) {
    const res = await Promise.resolve(apiCall('/api/workout/plans')).catch(() => null);
    const p = (res && Array.isArray(res.plans) && res.plans.find((x) => x.id === plan.id)) || plan;
    return { res, plan: p, day: (p.days || []).find((d) => d.id === day.id) || day };
}

function openWorkoutPlanDayPage(plan, day) {
    if (!plan || !day || !window.WGPage || document.querySelector('.wg-page[data-plan-day-page]')) return null;
    const doc = document;
    const days = plan.days || [];
    const k = days.findIndex((d) => d.id === day.id) + 1;
    const body = _planEl(doc, 'div', 'wg-vstack');
    if (day.description) body.appendChild(_planEl(doc, 'p', 'wg-pl__desc', day.description));
    const section = _planEl(doc, 'section', 'wg-section');
    const head = _planEl(doc, 'div', 'wg-section__head');
    const count = _planEl(doc, 'span', 'wg-eyebrow', 'Exercises');
    head.appendChild(count);
    const done = _planDayDoneText(day);
    if (done) head.appendChild(_planEl(doc, 'span', 'wg-meta', done));
    const list = _planEl(doc, 'div', 'wg-list');
    list.setAttribute('aria-busy', 'true'); // until every row's "last" has landed
    section.append(head, list);
    body.appendChild(section);

    const page = window.WGPage.push({
        title: day.name || 'Day',
        crumb: `${plan.name || 'Plan'} · day ${k} of ${days.length}`,
        back: 'Plans',
        body,
        primary: { label: 'Edit', ghost: true, onClick: () => editPlanDay() },
    });
    page.el.dataset.planDayPage = String(day.id);

    // Edit: leave the read page for the editor, opened on this day.
    async function editPlanDay() {
        page.close();
        if (!(await openWorkoutPlanPage(plan.id))) return;
        const draft = window.WorkoutEdit.planDraft;
        const d = draft && draft.days.find((x) => x.id === day.id);
        if (d) openWorkoutDayPage(d, renderWorkoutPlanBody);
    }

    // One plan-day switch at a time across every day page AND the Timeline's
    // WN7 sheet (next-card.js runPlanDaySwitch).
    const startPlanDay = (btn) => runPlanDaySwitch(() => switchAndStart(btn));
    async function switchAndStart(btn) {
        btn.disabled = true;
        try {
            // Re-read at tap time: another switch may have moved "next" since
            // the page opened.
            const fresh = await _planDayNow(plan, day);
            if (!(fresh.plan.next && fresh.plan.next.session_id)) return;
            // The plan's OWN next session: set-variant refuses a day of another plan.
            const sid = fresh.plan.next.session_id;
            if (!fresh.day.is_next) {
                const handle = await window.DataStore.applyOptimistic('workout_plans',
                    (prev) => _planWithNextDay(prev, fresh.plan.id, fresh.day.id), ['workout']);
                let ok = false;
                try {
                    ok = (await apiCall(`/api/workout/sessions/${sid}/set-variant`, 'POST', { variant_id: fresh.day.id },
                        { suppressWriteAlert: true })) != null;
                } catch (error) {
                    console.error('Error setting plan day:', error);
                }
                if (!ok) {
                    await handle.rollback();
                    safeToast("Couldn't switch the day. Please try again.", 'error');
                    return;
                }
                await handle.commit(null);
                await invalidateWorkoutCache();
                loadWorkoutGroups();
                loadNextWorkout();
            }
            page.close();
            await startWorkoutSession(sid);
        } finally {
            btn.disabled = false;
        }
    }

    (async () => {
        const [exercises, fresh] = await Promise.all([
            Promise.resolve(apiCall(`/api/workout/exercises?variant_id=${day.id}`)).catch(() => null),
            _planDayNow(plan, day),
        ]);
        if (!page.el.isConnected) return;
        const rows = (Array.isArray(exercises) ? exercises : [])
            .slice().sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
        count.textContent = `Exercises · ${rows.length}`;
        const reads = [];
        list.replaceChildren(...(rows.length ? rows.map((ex) => {
            const name = ex.exercise_name || 'Exercise';
            const target = _planExerciseMeta(ex);
            const row = _planRow(doc, {
                title: name,
                meta: target,
                onClick: () => {
                    // The exercise's history page, pushed over this one.
                    const detail = _planEl(doc, 'div');
                    window.WGPage.push({ title: name, back: day.name || 'Day', body: detail });
                    window.WorkoutExerciseDetail.open(name, detail);
                },
            });
            // Targets paint first; each "last" lands on its own read.
            reads.push(Promise.resolve(apiCall(`/api/workout/exercises/history?name=${encodeURIComponent(name)}&limit=1`))
                .then((hist) => {
                    const last = _planDayLastText(hist);
                    if (last) row.querySelector('.wg-row__meta').textContent = `${target} · ${last}`;
                }, () => {}));
            return row;
        }) : [workoutEmptyRow('No exercises yet.')]));
        Promise.all(reads).then(() => list.removeAttribute('aria-busy'));

        if ((fresh.res && fresh.res.active_session_id) || !(fresh.plan.next && fresh.plan.next.session_id)) return;
        const foot = _planEl(doc, 'footer', 'wg-pagefoot');
        const btn = _planEl(doc, 'button', 'wg-btn wg-btn--primary wg-btn--block', fresh.day.is_next ? 'Start workout' : 'Start this day');
        btn.type = 'button';
        btn.dataset.action = 'start-plan-day';
        btn.addEventListener('click', () => startPlanDay(btn));
        foot.appendChild(btn);
        page.el.appendChild(foot);
    })();
    return page;
}

window.WorkoutVariants = {
    openAdd: () => openWorkoutDayPage(null, renderWorkoutPlanBody),
    openEdit: openWorkoutDayPage,
    done: stageWorkoutDay,
    remove: removeWorkoutPlanDay,
    addExercise: addExerciseToWorkoutDay,
};
