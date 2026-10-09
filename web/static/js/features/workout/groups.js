// ====================================
// WORKOUT PLANS — list + Plan page
// ====================================
//
// Owns:
//   - cached workout-groups list (window.WorkoutEdit.cachedGroups)
//   - the Plans list (one tappable row per plan)
//   - the plan editor root (med-xso6.22, kit screens-workouts P1): Plan → Day
//     → Exercise are nested WGPages. The Day page (variants.js) and the
//     Exercise page (exercises.js) stage their edits into the draft held here
//     (window.WorkoutEdit.planDraft); only the Plan page's Save writes — the
//     same routes and payloads the old three modals sent, one after another,
//     behind one DataStore.applyOptimistic.
//   - the shared page helpers the child pages use (value segs, steppers, row
//     reorder, dirty-check).

(function () {
    // Closure-private editor state — module-level mutable globals are
    // forbidden in the extracted files (architecture.no-module-state).
    let _editingGroupId = null;
    // Hydrated by loadWorkoutGroups + the SWR onFresh path.
    let _cachedGroups = [];
    // The open plan editor's draft, null while no Plan page is open:
    //   { groupId, group, page, days: [Day], removedDays: [id], daysReordered }
    //   Day = { id|null, name, description, rotation_order, orig, implicit,
    //           exercises: [{ id|null, rec, payload }], removed: [id], exReordered }
    // `rec` is the exercise as loaded, `payload` the staged edit (null = none).
    // Group fields live in the Plan page's own inputs.
    let _planDraft = null;

    window.WorkoutEdit = window.WorkoutEdit || {};
    Object.defineProperty(window.WorkoutEdit, 'editingGroupId', {
        get: () => _editingGroupId,
        set: (v) => { _editingGroupId = v; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.WorkoutEdit, 'cachedGroups', {
        get: () => _cachedGroups,
        set: (v) => { _cachedGroups = Array.isArray(v) ? v : []; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.WorkoutEdit, 'planDraft', {
        get: () => _planDraft,
        set: (v) => { _planDraft = v || null; },
        enumerable: true,
        configurable: true
    });
})();

async function loadWorkoutGroups() {
    const container = document.getElementById('workout-groups-list');
    await window.DataStore.loadSWR({
        key: 'workout_groups',
        tags: ['workout'],
        // apiCallDirect throws on offline/5xx so a post-mutation refresh
        // failure routes through onError, which renders an explicit "no
        // cached data" empty state. The legacy apiCall path returned null
        // on offline; with no `allowNullFresh` and no cached value (just
        // cleared by invalidateWorkoutCache), loadSWR would skip BOTH
        // onFresh and onError, leaving the pre-mutation DOM visible after
        // a successful save followed by a failed refresh.
        fetcher: async () => {
            if (!window.apiCallDirect) throw new Error('apiCallDirect not available');
            const res = await window.apiCallDirect('/api/workout/groups');
            return Array.isArray(res) ? res : [];
        },
        onCached: async (cached) => {
            _renderWorkoutGroups(container, cached);
        },
        onFresh: async (groups) => {
            window.WorkoutEdit.cachedGroups = groups || [];
            if (groups && window.MedTrackerDB?.WorkoutStore) {
                await window.MedTrackerDB.WorkoutStore.saveCache('groups', groups);
            }
            _renderWorkoutGroups(container, groups);
        },
        onError: async (error, cached) => {
            console.error('Error loading workout groups:', error);
            if (!cached) {
                container.replaceChildren(createOfflineEmptyState());
            }
        }
    });
}


function _renderWorkoutGroups(container, groups) {
    if (!container) return;
    const doc = container.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return;
    window.WorkoutEdit.cachedGroups = groups || [];

    container.classList.add('wg-workouts-groups');

    if (!groups || groups.length === 0) {
        container.replaceChildren(createEmptyState({
            icon: 'dumbbell',
            title: 'No plans yet',
            body: 'Add a plan to schedule your workouts, or import one someone shared.',
        }));
        return;
    }

    const list = doc.createElement('div');
    list.className = 'wg-list';
    groups.forEach((group) => {
        list.appendChild(_buildWorkoutGroupRow(doc, group));
    });
    container.replaceChildren(list);
}

// "Mon, Wed, Fri" from the group's JSON-string days_of_week. Shared by the
// Plans row and the printable plan sheet so the paper and the screen can
// never disagree about when a plan repeats.
function _workoutGroupDaysText(group) {
    let daysArray = [];
    try {
        daysArray = JSON.parse((group && group.days_of_week) || '[]');
    } catch (_) {
        daysArray = [];
    }
    const daysMap = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return (Array.isArray(daysArray) ? daysArray : [])
        .map((d) => daysMap[d]).filter(Boolean).join(', ');
}

function _workoutIcon(doc, name, extraClass) {
    const ico = doc.createElement('i');
    ico.className = extraClass ? `wg-ico ${extraClass}` : 'wg-ico';
    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        ico.appendChild(window.WGIcons.iconSvg(name, { size: 18 }));
    }
    return ico;
}

// One plan = one tappable kit row; a tap opens the Plan page, where Share /
// Print / Scan / Delete live (no per-row action strip).
function _buildWorkoutGroupRow(doc, group) {
    const row = doc.createElement('button');
    row.type = 'button';
    row.className = 'wg-row wg-workout-plan-row';
    row.dataset.groupId = String(group.id || '');

    const body = doc.createElement('span');
    body.className = 'wg-row__body';
    const title = doc.createElement('span');
    title.className = 'wg-row__title';
    title.textContent = group.name || 'Plan';
    body.appendChild(title);

    const metaParts = [];
    const daysText = _workoutGroupDaysText(group);
    if (daysText) metaParts.push(daysText);
    if (group.scheduled_time) metaParts.push(group.scheduled_time);
    if (Number.isFinite(Number(group.exercises_count)) && group.exercises_count !== null) {
        const n = Number(group.exercises_count);
        metaParts.push(`${n} exercise${n === 1 ? '' : 's'}`);
    }
    const meta = doc.createElement('span');
    meta.className = 'wg-row__meta';
    meta.textContent = metaParts.join(' · ');
    if (group.is_rotating) {
        const rot = doc.createElement('span');
        rot.className = 'wg-tag';
        rot.textContent = 'Rotating';
        meta.appendChild(rot);
    }
    if (metaParts.length || group.is_rotating) body.appendChild(meta);
    row.appendChild(body);

    if (!group.active) {
        row.appendChild(window.WGChip.create({ text: 'Inactive', state: 'stale', small: true }));
    }
    row.appendChild(_workoutIcon(doc, 'chev-r', 'wg-row__chev'));

    row.addEventListener('click', () => { openWorkoutPlanPage(group.id); });
    return row;
}

// ====================================
// SHARED PAGE HELPERS (Plan / Day / Exercise pages)
// ====================================

// Value segs: a hidden input (the value the save reads, same id as the old
// <select>) mirrored by a .wg-seg[data-seg-for=<id>] of [data-value] options.
// A tap writes the input and fires its onchange; a programmatic write is
// re-painted with workoutSegSync(root).
function workoutSegSync(root) {
    (root || document).querySelectorAll('.wg-seg[data-seg-for]').forEach((seg) => {
        const input = document.getElementById(seg.dataset.segFor);
        const value = input ? input.value : '';
        seg.querySelectorAll('.wg-seg__opt').forEach((opt) => {
            opt.setAttribute('aria-pressed', opt.dataset.value === value ? 'true' : 'false');
        });
    });
}

// Steppers: [data-step-for=<input id>][data-step=<delta>] buttons around a
// number input. Writes fire the input's onchange (the weight's re-resolves
// the auto equipment label).
function _workoutStep(btn) {
    const input = document.getElementById(btn.dataset.stepFor);
    if (!input) return;
    const step = parseFloat(btn.dataset.step) || 0;
    const min = input.min !== '' ? parseFloat(input.min) : -Infinity;
    const max = input.max !== '' ? parseFloat(input.max) : Infinity;
    const cur = input.value !== '' ? parseFloat(input.value)
        : (input.placeholder !== '' ? parseFloat(input.placeholder) || 0 : 0);
    const next = Math.min(max, Math.max(min, Math.round((cur + (input.value !== '' ? step : 0)) * 100) / 100));
    input.value = String(next);
    if (typeof input.onchange === 'function') input.onchange();
}

// One delegated click handler per page body (bound once, at boot).
function bindWorkoutPageControls(root) {
    if (!root || root.dataset.controlsBound === 'true') return;
    root.dataset.controlsBound = 'true';
    root.addEventListener('click', (e) => {
        const opt = e.target.closest('.wg-seg[data-seg-for] .wg-seg__opt');
        if (opt) {
            const input = document.getElementById(opt.closest('.wg-seg').dataset.segFor);
            if (!input) return;
            input.value = opt.dataset.value;
            workoutSegSync(root);
            if (typeof input.onchange === 'function') input.onchange();
            return;
        }
        const stepBtn = e.target.closest('[data-step-for]');
        if (stepBtn) _workoutStep(stepBtn);
    });
}

// Form state of a page body + any draft state, for the dirty check on Back.
function workoutFormSnapshot(root, extra) {
    const fields = Array.from(root.querySelectorAll('input, textarea, select'))
        .map((el) => (el.type === 'checkbox' ? el.checked : el.value));
    const picks = root.querySelector('.wg-picks[data-day-picks]');
    return JSON.stringify([fields, picks ? window.MedicationUtils.getPickedDays(picks) : null, extra || null]);
}

// Back on an editor page: leave at once when clean, else ask first.
function workoutConfirmDiscard(dirty, message) {
    if (!dirty) return true;
    return safeConfirm(message, null, { title: 'Discard changes?', confirmLabel: 'Discard', destructive: true })
        .then((ok) => !!ok);
}

function workoutMoveItem(arr, from, to) {
    if (to < 0 || to >= arr.length || from === to) return false;
    arr.splice(to, 0, arr.splice(from, 1)[0]);
    return true;
}

// Overflow-menu twins of the drag (keyboard / screen-reader path).
function workoutMoveActions(index, length, onMove) {
    const acts = [];
    if (index > 0) acts.push({ label: 'Move up', icon: 'chev-u', onClick: () => onMove(index, index - 1) });
    if (index < length - 1) acts.push({ label: 'Move down', icon: 'chev-d', onClick: () => onMove(index, index + 1) });
    return acts;
}

// Pointer drag on a row's .wg-grip: the drop target is the sibling row whose
// vertical middle the pointer ends above. Rows carry data-reorder-index.
function bindWorkoutRowDrag(grip, row, index, onMove) {
    grip.addEventListener('click', (e) => e.stopPropagation()); // never also opens the row
    grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation(); // not a swipe either
        if (typeof grip.setPointerCapture === 'function') {
            try { grip.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
        }
        row.classList.add('wg-workout-row--dragging');
        const end = (ev) => {
            grip.removeEventListener('pointerup', end);
            grip.removeEventListener('pointercancel', end);
            row.classList.remove('wg-workout-row--dragging');
            if (ev.type !== 'pointerup' || !row.parentElement) return;
            const rows = Array.from(row.parentElement.querySelectorAll(':scope > [data-reorder-index]'));
            let to = rows.findIndex((r) => {
                const b = r.getBoundingClientRect();
                return ev.clientY < b.top + b.height / 2;
            });
            if (to === -1) to = rows.length - 1;
            else if (to > index) to -= 1;
            if (to !== index) onMove(index, to);
        };
        grip.addEventListener('pointerup', end);
        grip.addEventListener('pointercancel', end);
    });
}

// A placeholder row inside an empty .wg-list.
function workoutEmptyRow(text) {
    const row = document.createElement('div');
    row.className = 'wg-row wg-row--pad';
    const body = document.createElement('span');
    body.className = 'wg-row__body';
    const meta = document.createElement('span');
    meta.className = 'wg-row__meta';
    meta.textContent = text;
    body.appendChild(meta);
    row.appendChild(body);
    return row;
}

function _workoutPageBody(name) {
    return document.querySelector(`.wg-workout-pages > [data-workout-page="${name}"]`);
}

// Static modals (share / scan) opened from a page sit earlier in the DOM than
// it, so re-append them to paint on top (MTModal.connectedCallback is
// idempotent).
function _raiseWorkoutModal(id) {
    const el = document.getElementById(id);
    if (el) document.body.appendChild(el);
}

// ====================================
// PLAN PAGE (kit P1)
// ====================================

function _planDayFromRecord(variant, exercises) {
    const sorted = [...exercises].sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
    return {
        id: variant.id,
        name: variant.name || '',
        description: variant.description || '',
        rotation_order: variant.rotation_order == null ? null : variant.rotation_order,
        orig: { name: variant.name || '', description: variant.description || '' },
        implicit: false,
        exercises: sorted.map((rec) => ({ id: rec.id, rec, payload: null })),
        removed: [],
        exReordered: false,
    };
}

function newPlanDay(name, implicit) {
    return {
        id: null, name: name || '', description: '', rotation_order: null, orig: null,
        implicit: !!implicit, exercises: [], removed: [], exReordered: false,
    };
}

// Days + exercises of a saved plan, or null when a read failed (offline/5xx).
async function _loadPlanDays(groupId) {
    const variants = await apiCall(`/api/workout/variants?group_id=${groupId}`);
    if (!Array.isArray(variants)) return null;
    const days = [];
    for (const v of variants) {
        const exercises = await apiCall(`/api/workout/exercises?variant_id=${v.id}`);
        if (!Array.isArray(exercises)) return null;
        days.push(_planDayFromRecord(v, exercises));
    }
    return days;
}

function _planName() {
    const input = document.getElementById('workout-group-name');
    return (input && input.value.trim()) || 'Plan';
}

function _planRotating() {
    const cb = document.getElementById('workout-group-rotating');
    return !!(cb && cb.checked);
}

// The single Day a non-rotating plan edits as a flat list ("Main", created on
// Save only once it holds exercises).
function _flatPlanDay(draft) {
    if (!draft.days.length) draft.days.push(newPlanDay('Main', true));
    return draft.days[0];
}

function _syncNotificationRow() {
    const input = document.getElementById('workout-group-notification');
    const value = document.getElementById('workout-group-notification-value');
    if (!input || !value) return;
    const n = parseInt(input.value, 10) || 0;
    value.textContent = n > 0 ? `${n} min before` : 'At start time';
}

async function chooseWorkoutNotification() {
    const input = document.getElementById('workout-group-notification');
    if (!input) return;
    const cur = parseInt(input.value, 10) || 0;
    const values = [0, 5, 10, 15, 30, 45, 60];
    if (!values.includes(cur)) values.push(cur);
    values.sort((a, b) => a - b);
    const picked = await safeChoose('Remind me before the workout', values.map((v) => ({
        value: String(v),
        label: v > 0 ? `${v} min before` : 'At start time',
        selected: v === cur,
    })), { title: 'Reminder' });
    if (picked === null || picked === undefined) return;
    input.value = String(picked);
    _syncNotificationRow();
}

function renderWorkoutPlanBody() {
    const draft = window.WorkoutEdit.planDraft;
    if (!draft) return;
    const rotating = _planRotating();
    const daysSection = document.getElementById('workout-variants-section');
    const flatSection = document.getElementById('workout-group-flat-exercises-section');
    if (daysSection) daysSection.hidden = !rotating;
    if (flatSection) flatSection.hidden = rotating;
    if (rotating) {
        _renderPlanDays(draft);
    } else {
        renderWorkoutExerciseRows(document.getElementById('workout-group-flat-exercises-list'),
            _flatPlanDay(draft), renderWorkoutPlanBody);
    }
    const tools = document.getElementById('workout-group-tools');
    if (tools) tools.hidden = draft.groupId == null;
    const scan = document.getElementById('workout-group-scan-btn');
    if (scan) scan.hidden = !(window.WorkoutScan && typeof window.WorkoutScan.scan === 'function');
}

function _renderPlanDays(draft) {
    const list = document.getElementById('workout-variants-list');
    const count = document.getElementById('workout-variants-count');
    if (count) count.textContent = draft.days.length ? `Days · ${draft.days.length}` : 'Days';
    if (!list) return;
    if (!draft.days.length) {
        list.replaceChildren(workoutEmptyRow('No days yet — add one to get started.'));
        return;
    }
    const onMove = (from, to) => {
        if (workoutMoveItem(draft.days, from, to)) {
            draft.daysReordered = true;
            renderWorkoutPlanBody();
        }
    };
    list.replaceChildren(...draft.days.map((day, i) => buildWorkoutDayRow(day, i, draft.days.length, onMove)));
}

// Open the Plan page for a saved plan (groupId) or a new one (null). Reads the
// plan's Days + exercises up front so the child pages edit a complete draft.
async function openWorkoutPlanPage(groupId) {
    const store = document.querySelector('.wg-workout-pages');
    const body = _workoutPageBody('plan');
    if (!store || !body || !window.WGPage) return null; // absent, or already open
    let group = null;
    if (groupId != null) {
        group = (window.WorkoutEdit.cachedGroups || []).find((g) => g.id === groupId) || null;
        if (!group) {
            // Opened from outside the Plans tab (next-workout card).
            const groups = await apiCall('/api/workout/groups');
            if (Array.isArray(groups)) {
                window.WorkoutEdit.cachedGroups = groups;
                group = groups.find((g) => g.id === groupId) || null;
            }
        }
        if (!group) {
            safeToast('Couldn\'t open this plan — try again online.', 'error');
            return null;
        }
    }
    const days = group ? await _loadPlanDays(group.id) : [];
    if (!days) {
        safeToast('Couldn\'t load this plan\'s days — try again online.', 'error');
        return null;
    }
    if (window.WorkoutEdit.planDraft || !_workoutPageBody('plan')) return null; // a second tap raced the reads

    const g = group || {};
    document.getElementById('workout-group-name').value = g.name || '';
    document.getElementById('workout-group-description').value = g.description || '';
    document.getElementById('workout-group-goal').value = g.training_goal || 'hypertrophy';
    document.getElementById('workout-group-rotating').checked = !!g.is_rotating;
    document.getElementById('workout-group-time').value = g.scheduled_time || '09:00';
    document.getElementById('workout-group-notification').value =
        g.notification_advance_minutes == null ? '15' : String(g.notification_advance_minutes);
    document.getElementById('workout-group-active').checked = group ? !!g.active : true;
    let picked = [];
    try { picked = JSON.parse(g.days_of_week || '[]'); } catch (_) { picked = []; }
    window.MedicationUtils.setPickedDays(body.querySelector('.wg-picks[data-day-picks]'), Array.isArray(picked) ? picked : []);
    workoutSegSync(body);
    _syncNotificationRow();

    const draft = { groupId: group ? group.id : null, group, page: null, days, removedDays: [], daysReordered: false };
    window.WorkoutEdit.planDraft = draft;
    window.WorkoutEdit.editingGroupId = draft.groupId;
    renderWorkoutPlanBody();

    let snapshot = '';
    const planSnapshot = () => workoutFormSnapshot(body, [draft.days, draft.removedDays]);
    draft.page = window.WGPage.push({
        title: group ? (g.name || 'Plan') : 'New plan',
        crumb: group ? 'Edit plan' : 'Add plan',
        back: 'Plans',
        body,
        primary: { label: 'Save', onClick: () => saveWorkoutGroup() },
        onBack: () => workoutConfirmDiscard(planSnapshot() !== snapshot, 'Your changes to this plan haven\'t been saved.'),
        onClose: () => {
            store.appendChild(body);
            if (window.WorkoutEdit.planDraft === draft) window.WorkoutEdit.planDraft = null;
            window.WorkoutEdit.editingGroupId = null;
        },
    });
    snapshot = planSnapshot();
    return draft.page;
}

function closeWorkoutPlanPage() {
    const draft = window.WorkoutEdit.planDraft;
    if (draft && draft.page) draft.page.close();
}

// "Rotate through days" toggle. Turning it off collapses the plan to a flat
// exercise list, which a plan with more than one Day can't do without
// stranding the extra Days' exercises — keep it on and say so (zero data loss).
function toggleRotatingFields() {
    const draft = window.WorkoutEdit.planDraft;
    const cb = document.getElementById('workout-group-rotating');
    if (!draft || !cb) return;
    if (cb.checked) {
        // An untouched implicit "Main" day is not a real Day.
        draft.days = draft.days.filter((d) => !(d.implicit && d.id == null && d.exercises.length === 0));
    } else if (draft.days.length > 1) {
        cb.checked = true;
        safeToast('Delete the extra Days first — a plan with more than one Day can\'t switch off "Rotate through days".', 'info');
    }
    renderWorkoutPlanBody();
}

function addWorkoutFlatExercise() {
    const draft = window.WorkoutEdit.planDraft;
    if (!draft) return null;
    return showAddExercisePage(_flatPlanDay(draft), renderWorkoutPlanBody, _planName());
}

function addWorkoutPlanDay() {
    if (!window.WorkoutEdit.planDraft) return null;
    return openWorkoutDayPage(null, renderWorkoutPlanBody);
}

// The exercise write for a staged payload, in the old editor's key order.
function _planExerciseBody(variantId, staged, order) {
    const body = {
        variant_id: variantId,
        exercise_name: staged.exercise_name,
        target_sets: staged.target_sets,
        target_reps_min: staged.target_reps_min,
        target_reps_max: staged.target_reps_max,
        target_weight_kg: staged.target_weight_kg,
        order_index: order,
    };
    // A reorder-only write omits the optional keys: the domain keeps the
    // stored progression rule / goal / equipment when a key is absent.
    if ('progression_rule' in staged) body.progression_rule = staged.progression_rule;
    if ('training_goal' in staged) body.training_goal = staged.training_goal;
    if ('equipment_id' in staged) body.equipment_id = staged.equipment_id;
    return body;
}

// Writes the draft in order: group, removed Days, then per Day its row and
// exercises. Each successful write is folded back into the draft, so a retry
// after a failure resumes instead of duplicating. Resolves false on the first
// failed write (apiCall's null).
async function _writePlanDraft(draft, groupPayload, active, rotating) {
    if (draft.groupId == null) {
        const created = await apiCall('/api/workout/groups/create', 'POST', groupPayload);
        if (!created || created.id == null) return false;
        draft.groupId = created.id;
        window.WorkoutEdit.editingGroupId = created.id;
    } else {
        const updated = await apiCall(`/api/workout/groups/update?id=${draft.groupId}`, 'PUT', { ...groupPayload, active });
        if (!updated) return false;
    }

    while (draft.removedDays.length) {
        const ok = await apiCall(`/api/workout/variants/delete?id=${draft.removedDays[0]}`, 'DELETE');
        if (!ok) return false;
        draft.removedDays.shift();
    }

    // An untouched implicit day of a flat plan is never created.
    const days = draft.days.filter((d) => !(d.implicit && d.id == null && d.exercises.length === 0));
    const renumber = rotating && (draft.daysReordered || days.some((d) => d.id == null));
    for (let i = 0; i < days.length; i++) {
        const day = days[i];
        let order = day.rotation_order;
        if (rotating && renumber) order = i;
        else if (!rotating && day.id == null) order = null;
        const vPayload = { group_id: draft.groupId, name: day.name, rotation_order: order, description: day.description || '' };
        if (day.id == null) {
            const created = await apiCall('/api/workout/variants/create', 'POST', vPayload);
            if (!created || created.id == null) return false;
            day.id = created.id;
        } else if (day.name !== day.orig.name || (day.description || '') !== day.orig.description || order !== day.rotation_order) {
            const ok = await apiCall(`/api/workout/variants/update?id=${day.id}`, 'PUT', vPayload);
            if (!ok) return false;
        }
        day.rotation_order = order;
        day.orig = { name: day.name, description: day.description || '' };

        while (day.removed.length) {
            const ok = await apiCall(`/api/workout/exercises/delete?id=${day.removed[0]}`, 'DELETE');
            if (!ok) return false;
            day.removed.shift();
        }
        const renumberEx = day.exReordered || day.exercises.some((e) => e.id == null);
        for (let j = 0; j < day.exercises.length; j++) {
            const entry = day.exercises[j];
            const view = { ...(entry.rec || {}), ...(entry.payload || {}) };
            const exOrder = renumberEx ? j : (Number(view.order_index) || 0);
            if (entry.id == null) {
                const body = _planExerciseBody(day.id, entry.payload, exOrder);
                const created = await apiCall('/api/workout/exercises/create', 'POST', body);
                if (!created || created.id == null) return false;
                entry.id = created.id;
                entry.rec = { ...body, ...created };
                entry.payload = null;
            } else if (entry.payload || exOrder !== entry.rec.order_index) {
                const body = entry.payload
                    ? _planExerciseBody(day.id, entry.payload, exOrder)
                    : _planExerciseBody(day.id, {
                        exercise_name: entry.rec.exercise_name,
                        target_sets: entry.rec.target_sets,
                        target_reps_min: entry.rec.target_reps_min,
                        target_reps_max: entry.rec.target_reps_max,
                        target_weight_kg: entry.rec.target_weight_kg,
                    }, exOrder);
                const ok = await apiCall(`/api/workout/exercises/update?id=${entry.id}`, 'PUT', body);
                if (!ok) return false;
                entry.rec = { ...entry.rec, ...body };
                entry.payload = null;
            }
        }
        day.exReordered = false;
    }
    draft.daysReordered = false;
    return true;
}

// The Plan page's Save — the only write in the plan editor. The group row's
// new fields land in the workout_groups cache optimistically (CLAUDE.md rule
// 9); the handle commits once every write landed, else rolls back and the
// page stays open with the draft intact for a retry.
async function saveWorkoutGroup() {
    const draft = window.WorkoutEdit.planDraft;
    if (!draft || draft.saving) return;
    const body = document.querySelector('[data-workout-page="plan"]');
    const name = document.getElementById('workout-group-name').value.trim();
    const description = document.getElementById('workout-group-description').value.trim();
    const isRotating = document.getElementById('workout-group-rotating').checked;
    const time = document.getElementById('workout-group-time').value;
    const notification = parseInt(document.getElementById('workout-group-notification').value);
    const trainingGoal = document.getElementById('workout-group-goal').value;
    const active = document.getElementById('workout-group-active').checked;

    if (!name) {
        safeAlert('Plan name is required!');
        return;
    }

    if (!time) {
        safeAlert('Scheduled time is required!');
        return;
    }

    const days = window.MedicationUtils.getPickedDays(body.querySelector('.wg-picks[data-day-picks]'));

    const payload = {
        name,
        description,
        is_rotating: isRotating,
        days_of_week: JSON.stringify(days),
        scheduled_time: time,
        notification_advance_minutes: notification,
        training_goal: trainingGoal
    };

    draft.saving = true;
    if (draft.page) draft.page.setPrimaryEnabled(false);
    const groupId = draft.groupId;
    let handle = null;
    let ok = false;
    try {
        handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
            ? await window.DataStore.applyOptimistic('workout_groups', (prev) => {
                if (!Array.isArray(prev) || groupId == null) return prev;
                return prev.map((g) => (g && g.id === groupId ? { ...g, ...payload, active } : g));
            }, ['workout'])
            : null;
        ok = await _writePlanDraft(draft, payload, active, isRotating);
    } catch (e) {
        console.error('[workout] plan save failed', e);
        ok = false;
    }
    draft.saving = false;
    if (draft.page) draft.page.setPrimaryEnabled(true);
    if (!ok) {
        try { if (handle) await handle.rollback(); } catch (_) { /* best-effort */ }
        safeToast('Couldn\'t save the plan — your changes are still here. Try again.', 'error');
        return;
    }
    try { if (handle) await handle.commit(null); } catch (_) { /* the reload below covers it */ }
    await invalidateWorkoutCache();
    if (draft.page) draft.page.close();
    loadWorkoutGroups();
}

function _openPlanGroup() {
    const draft = window.WorkoutEdit.planDraft;
    if (!draft || draft.groupId == null) return null;
    return (window.WorkoutEdit.cachedGroups || []).find((g) => g.id === draft.groupId) || draft.group;
}

// Plan page bottom rows (saved plans only). Share / Scan open static modals,
// raised above the page first.
function shareOpenWorkoutPlan() {
    const group = _openPlanGroup();
    if (!group) return;
    _raiseWorkoutModal('workout-share-modal');
    window.WorkoutShare.share(group);
}

function printOpenWorkoutPlan() {
    const group = _openPlanGroup();
    if (group) window.WorkoutGroups.print(group);
}

function scanOpenWorkoutPlan() {
    const group = _openPlanGroup();
    if (!group || !window.WorkoutScan || typeof window.WorkoutScan.scan !== 'function') return;
    _raiseWorkoutModal('workout-scan-modal');
    window.WorkoutScan.scan(group);
}

async function deleteOpenWorkoutPlan() {
    const draft = window.WorkoutEdit.planDraft;
    if (!draft || draft.groupId == null) return;
    const ok = await safeConfirm('Delete this plan?', null, { title: 'Delete plan', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    const groupId = draft.groupId;
    if (draft.page) draft.page.close();
    await _deleteWorkoutGroupApi(groupId);
}

async function deleteWorkoutGroup(groupId, event) {
    if (event) event.stopPropagation();

    await safeConfirm('Delete this plan?', async (ok) => {
        if (ok) {
            await _deleteWorkoutGroupApi(groupId);
        }
    });
}

// _deleteWorkoutGroupApi deletes the plan, honouring CLAUDE.md rule 9: the
// row leaves the workout_groups cache optimistically and the handle commits
// on success or rolls back on failure/cancel, instead of a blind
// invalidate+reload on a write.
//
// bd med-qop3: the first attempt is a plain delete (no flag). When the plan
// still has open sessions the domain refuses with a precondition_failed
// carrying openSessionCount (apiCall rethrows that code instead of swallowing
// it to null — core/api.js), and the flow offers a second, count-naming
// confirm before retrying with cancel_sessions=true. A null result is the
// swallowed path (bot-mode server 4xx, offline/5xx) — the delete's own
// suppressWriteAlert silenced apiCall's toast, so say so here (round-1
// review) and leave the plan in place.
async function _deleteWorkoutGroupApi(groupId, opts) {
    const cancelSessions = !!(opts && opts.cancelSessions);
    const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
        ? await window.DataStore.applyOptimistic('workout_groups', (prev) => {
            if (!prev || !Array.isArray(prev)) return prev;
            return prev.filter((g) => g && g.id !== groupId);
        }, ['workout'])
        : null;
    const settle = async (ok) => {
        try {
            if (ok) {
                if (handle) await handle.commit(null);
                await invalidateWorkoutCache();
                loadWorkoutGroups();
            } else if (handle) {
                await handle.rollback();
            }
        } catch (_) { /* cache settle is best-effort; the reload covers it */ }
    };
    let result;
    try {
        const url = `/api/workout/groups/delete?id=${groupId}${cancelSessions ? '&cancel_sessions=true' : ''}`;
        result = await apiCall(url, 'DELETE', null, { suppressWriteAlert: true });
    } catch (e) {
        const openCount = e && e.code === 'precondition_failed' ? e.openSessionCount : 0;
        if (!cancelSessions && Number.isInteger(openCount) && openCount > 0) {
            await settle(false);
            await safeConfirm(`This plan has ${openCount} pending/active session${openCount === 1 ? '' : 's'}. Cancel them and delete the plan?`, async (confirmOk) => {
                if (confirmOk) {
                    await _deleteWorkoutGroupApi(groupId, { cancelSessions: true });
                }
            });
            return;
        }
        await settle(false);
        safeAlert('Error: ' + (e && e.message ? e.message : e));
        return;
    }
    if (result === null) {
        await settle(false);
        safeAlert("Couldn't delete the plan — try again online.");
        return;
    }
    await settle(!!result);
}

// ====================================
// PRINTABLE PLAN SHEET (bd med-ac5h)
// ====================================
//
// One Plan on one sheet of paper, to carry into the gym and fill in by hand.
// Exactly the machinery the doctor brief uses (features/brief.js, med-5k6t.2):
// build ONE standalone HTML string and hand it to web/cloud/js/print-doc.js,
// which prints it through an offscreen iframe — the document itself, never
// the app chrome — and adopts the CSS as a constructed stylesheet because
// this origin's `style-src 'self'` refuses the inline <style>.
//
// Nothing leaves the device: the reads are the same cloud-routed
// /api/workout/* endpoints the screen already uses, and the document is a
// string printed in-process. No privacy-manifest entry, by design.

const WORKOUT_PLAN_GOAL_LABELS = {
    strength: 'Strength',
    hypertrophy: 'Hypertrophy',
    endurance: 'Endurance',
    general: 'General',
};

const WORKOUT_PLAN_ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Local rather than window.escapeHtml: that one returns '' for any falsy
// input, which would silently blank a Plan or exercise literally named "0".
function _workoutPlanEsc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => WORKOUT_PLAN_ESC_MAP[c]);
}

// ponytail: the literal colors below are intentional — this document renders
// OUTSIDE the app, where --wg-* tokens do not exist, and it is printed on
// white paper. Same precedent as brief.js DOC_CSS and buildKitDocument in
// web/cloud/js/signup.js. Dark theme is therefore irrelevant here.
//
// ponytail: one-page fit is CSS only — A4, small type, Day blocks in two
// columns that never break mid-block. A 7-Day × 12-exercise plan legitimately
// runs onto a second sheet; the browser's own print dialog already offers
// "scale". No JS measure-and-shrink loop. Upgrade path if the owner ever
// wants a hard guarantee: a fit-to-page transform on a measured wrapper.
const WORKOUT_PLAN_DOC_CSS = `
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font: 10.5px/1.35 system-ui, -apple-system, sans-serif; color: #111; background: #fff;
         margin: 0; font-variant-numeric: tabular-nums; }
  header { border-bottom: 2px solid #111; padding-bottom: 3mm; margin-bottom: 4mm; }
  h1 { font-size: 16px; margin: 0 0 1mm; }
  .meta { color: #444; font-size: 9.5px; margin: 0; }
  .days { column-gap: 8mm; }
  .days--cols { columns: 2; }
  .day { break-inside: avoid; page-break-inside: avoid; margin: 0 0 4mm; }
  h2 { font-size: 11px; margin: 0 0 1mm; text-transform: uppercase; letter-spacing: 0.06em;
       border-bottom: 1px solid #111; padding-bottom: 0.5mm; }
  .desc { color: #555; font-size: 9.5px; margin: 0 0 1.5mm; }
  ol { margin: 0; padding-left: 5mm; }
  li { margin: 0 0 2mm; break-inside: avoid; page-break-inside: avoid; }
  .ex { font-weight: 700; }
  .tgt { color: #333; }
  .cells { display: flex; gap: 1.5mm; margin-top: 1mm; }
  .cell { flex: 1 1 0; border: 1px solid #999; border-radius: 1mm; height: 7mm;
          color: #bbb; font-size: 7.5px; padding: 0.5mm 1mm; }
  .setno { color: #111; font-weight: 700; }
  .qrrow { display: flex; align-items: flex-end; gap: 4mm; }
  .qrrow .head { flex: 1 1 auto; }
  .qr { flex: 0 0 auto; text-align: center; }
  .qr svg { width: 24mm; height: 24mm; }
  .qr figcaption { color: #555; font-size: 8px; margin-top: 1mm; }
  footer { margin-top: 5mm; padding-top: 2mm; border-top: 1px solid #ddd;
           color: #555; font-size: 8.5px; }`;

// ponytail: appended to the sheet stylesheet only when at least one plate
// glyph renders, so plans without bound equipment stay byte-identical to
// today (med-niix.6). Same standalone-document rule as above: literal
// monochrome values, no --wg-* tokens, no app classes.
const WORKOUT_PLAN_LOAD_CSS = `
  .plates { display: block; margin-top: 1mm; }
  .plates svg { display: block; height: 11mm; width: auto; }
  .platestxt { display: block; color: #555; font-size: 8.5px; margin-top: 0.5mm; }`;

function _workoutPlanWeightClause(kg, unit) {
    // core/utils.js owns the single KG_PER_LB; targets are stored in kg, so an
    // lb user must not be handed a kg number on paper.
    const fmt = (typeof formatWeight === 'function')
        ? formatWeight
        : (v, u) => ({ value: Number(v), label: u });
    const w = fmt(kg, unit);
    return Number.isFinite(w.value) ? ` @ ${w.value} ${w.label}` : '';
}


function _workoutPlanR1(v) {
    return Math.round(Number(v) * 10) / 10;
}

function _workoutPlanR2(v) {
    return Math.round(Number(v) * 100) / 100;
}

// _workoutPlateLayout computes the plate-glyph geometry shared by the print
// sheet (med-niix.6, serialized with literal attributes below) and the
// active-session chip (med-v75c.2, built as classed DOM via
// _workoutPlateSvgElement): a sleeve line plus one rect per plate per side
// (mirrored), rect height ∝ kg, kg label under each rect. Coordinates are
// rounded exactly as the print path always rounded them, so
// _workoutPlanLoadingSvg's output is byte-identical to before.
function _workoutPlateLayout(perSide, sides) {
    const list = Array.isArray(perSide) ? perSide : [];
    const n = list.length;
    const pw = 7;
    const gap = 3;
    const inner = 5;
    const margin = 2;
    const heights = list.map((kg) => Math.min(56, 10 + 2 * Number(kg)));
    const maxH = Math.max.apply(null, heights.concat([0]));
    const midY = margin + maxH / 2;
    const half = n * pw + Math.max(0, n - 1) * gap;
    const cx = margin + inner + half;
    const W = _workoutPlanR1(cx + half + inner + margin);
    const H = _workoutPlanR1(margin * 2 + maxH + 12);
    const plates = [];
    for (let side = 0; side < 2; side += 1) {
        // A sides:1 implement (plate-loaded kettlebell) loads one sleeve:
        // drawing both would picture double the printed load.
        if (sides === 1 && side === 0) continue;
        for (let i = 0; i < n; i += 1) {
            const h = heights[i];
            const x = side === 0
                ? cx - inner - ((i + 1) * pw) - (i * gap)
                : cx + inner + (i * (pw + gap));
            plates.push({
                x: _workoutPlanR1(x),
                y: _workoutPlanR1(midY - h / 2),
                w: pw,
                h: _workoutPlanR1(h),
                labelX: _workoutPlanR1(x + pw / 2),
                labelY: _workoutPlanR1(midY + maxH / 2 + 9),
                kg: list[i]
            });
        }
    }
    return {
        W: W,
        H: H,
        sleeve: {
            x1: margin,
            y1: _workoutPlanR1(midY),
            x2: _workoutPlanR1(W - margin),
            y2: _workoutPlanR1(midY)
        },
        plates: plates
    };
}

// Monochrome presentation attributes only — no CSS, no tokens: the svg must
// survive the print iframe as-is. The sleeve is a <line> so every <rect> in
// the glyph is a plate.
function _workoutPlanLoadingSvg(perSide, sides) {
    const L = _workoutPlateLayout(perSide, sides);
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.W} ${L.H}" role="img">`;
    s += `<line x1="${L.sleeve.x1}" y1="${L.sleeve.y1}" x2="${L.sleeve.x2}" y2="${L.sleeve.y2}" stroke="#111" stroke-width="1.5"/>`;
    for (const p of L.plates) {
        s += `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="#fff" stroke="#111" stroke-width="1.5"/>`;
        s += `<text x="${p.labelX}" y="${p.labelY}" font-size="7" text-anchor="middle" fill="#111">${_workoutPlanEsc(p.kg)}</text>`;
    }
    return `${s}</svg>`;
}

// _workoutPlateSvgElement builds the same glyph as classed DOM for the app
// (med-v75c.2): geometry stays as x/y/width/height attributes (layout, not
// color) while all paint resolves via .wg-plates* CSS classes — no
// fill/stroke attributes, so the app-DOM token rule stays green.
function _workoutPlateSvgElement(perSide, sides) {
    const NS = 'http://www.w3.org/2000/svg';
    const L = _workoutPlateLayout(perSide, sides);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'wg-plates__glyph');
    svg.setAttribute('viewBox', `0 0 ${L.W} ${L.H}`);
    svg.setAttribute('role', 'img');
    const sleeve = document.createElementNS(NS, 'line');
    sleeve.setAttribute('class', 'wg-plates__sleeve');
    sleeve.setAttribute('x1', String(L.sleeve.x1));
    sleeve.setAttribute('y1', String(L.sleeve.y1));
    sleeve.setAttribute('x2', String(L.sleeve.x2));
    sleeve.setAttribute('y2', String(L.sleeve.y2));
    svg.appendChild(sleeve);
    for (const p of L.plates) {
        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('class', 'wg-plates__plate');
        rect.setAttribute('x', String(p.x));
        rect.setAttribute('y', String(p.y));
        rect.setAttribute('width', String(p.w));
        rect.setAttribute('height', String(p.h));
        svg.appendChild(rect);
        const label = document.createElementNS(NS, 'text');
        label.setAttribute('class', 'wg-plates__label');
        label.setAttribute('x', String(p.labelX));
        label.setAttribute('y', String(p.labelY));
        label.textContent = String(p.kg);
        svg.appendChild(label);
    }
    return svg;
}

// _workoutPlateText formats the loading line shared by the print sheet and
// the session chip: bar + per-side plates, "/ side" for two-sleeve gear, and
// "(kg)" when rendering for an lb preference (plates are kg while the target
// weight shows in lb).
function _workoutPlateText(barKg, perSide, sides, unit) {
    const plates = (Array.isArray(perSide) ? perSide : []).join(' \u00b7 ');
    const base = sides === 1
        ? `${barKg} + ${plates}`
        : `${barKg} + ${plates} / side`;
    return unit === 'lb' ? `${base} (kg)` : base;
}

// med-x295: an auto-matched item (no explicit binding) names itself ahead of
// the plate text — text only, the glyph stays byte-identical.
function _workoutPlanAutoPrefix(ld) {
    return (ld && typeof ld.auto === 'string' && ld.auto) ? `auto: ${ld.auto} \u2014 ` : '';
}

function _workoutPlanLoadingHtml(ld, unit) {
    // Escaping the joined line equals escaping the parts: the joiners and
    // suffixes (+, ·, /, parens, spaces) contain no escapable characters.
    const txt = _workoutPlanEsc(_workoutPlanAutoPrefix(ld) + _workoutPlateText(ld.bar_kg, ld.per_side, ld.sides, unit));
    const note = (ld && typeof ld.note === 'string' && ld.note)
        ? `<span class="platestxt">${_workoutPlanEsc(ld.note)}</span>` : '';
    return `<span class="plates">${_workoutPlanLoadingSvg(ld.per_side, ld.sides)}<span class="platestxt">${txt}</span>${note}</span>`;
}

function _workoutPlanExerciseItem(ex, unit, loadCtx) {
    const reps = (ex.target_reps_max)
        ? `${ex.target_reps_min}–${ex.target_reps_max}`
        : `${ex.target_reps_min}`;
    const weight = ex.target_weight_kg ? _workoutPlanWeightClause(ex.target_weight_kg, unit) : '';
    const sets = Math.max(1, Number(ex.target_sets) || 1);
    // The hand-logging boxes are the point of the sheet — the one thing a
    // screenshot could not give. Floor 3 so a single-set entry still leaves
    // room to write; cap 6 so a 10-set entry does not squeeze the row flat.
    const cellCount = Math.min(6, Math.max(3, sets));
    // Numbered boxes (bd med-qj4.9): the scan-back reads "box N holds set N",
    // so each cell carries its 1-based set number ahead of the unit label.
    const cells = [];
    for (let i = 1; i <= cellCount; i += 1) {
        cells.push(`<span class="cell"><span class="setno">${i}</span> ${_workoutPlanEsc(unit)} × reps</span>`);
    }
    let loading = '';
    if (loadCtx && loadCtx.loadings) {
        const ld = loadCtx.loadings[ex && ex.id];
        if (ld && Number.isFinite(Number(ld.bar_kg)) && Array.isArray(ld.per_side) && ld.per_side.length > 0) {
            loadCtx.hadLoading = true;
            loading = _workoutPlanLoadingHtml(
                {
                    bar_kg: Number(ld.bar_kg), per_side: ld.per_side, sides: ld.sides === 1 ? 1 : 2, note: ld.note, auto: ld.auto,
                }, unit);
        } else if (ld && typeof ld.note === 'string' && ld.note) {
            // Text-only note (med-3gln): below-bar, bare nearest, or fixed
            // "nearest: N kg" — no glyph, but the sheet still needs the plate
            // stylesheet for the .platestxt line.
            loadCtx.hadLoading = true;
            loading = `<span class="plates"><span class="platestxt">${_workoutPlanEsc(_workoutPlanAutoPrefix(ld) + ld.note)}</span></span>`;
        }
    }
    return `<li><span class="ex">${_workoutPlanEsc(ex.exercise_name)}</span> `
        + `<span class="tgt">${sets} × ${reps}${_workoutPlanEsc(weight)}</span>`
        + `${loading}<span class="cells">${cells.join('')}</span></li>`;
}

function _workoutPlanDayBlock(day, unit, showHeading, loadCtx) {
    const variant = (day && day.variant) || {};
    const exercises = [...((day && day.exercises) || [])]
        .sort((a, b) => (Number(a.order_index) || 0) - (Number(b.order_index) || 0));
    // A flat plan's single variant is an auto-created implementation detail
    // that the app never labels (docs/features.md) — so paper never labels it
    // either.
    const heading = showHeading ? `<h2>${_workoutPlanEsc(variant.name || 'Day')}</h2>` : '';
    const desc = (showHeading && variant.description)
        ? `<p class="desc">${_workoutPlanEsc(variant.description)}</p>` : '';
    const body = exercises.length > 0
        ? `<ol>${exercises.map((ex) => _workoutPlanExerciseItem(ex, unit, loadCtx)).join('')}</ol>`
        : '<p class="desc">No exercises yet.</p>';
    return `<section class="day">${heading}${desc}${body}</section>`;
}

// buildWorkoutPlanDocument(group, days, { unit, printedOn, qrSvg,
// loadingByExerciseId }) → a standalone HTML string. Pure: no DOM, no fetch,
// no clock beyond the injectable `printedOn`, so the test can assert what
// reaches paper without opening a print dialog.
// `days` is [{ variant, exercises }], one entry per variant. Plate-loading
// diagrams (med-niix.6) are DRAWN here but never COMPUTED here: the caller
// precomputes `loadingByExerciseId` ({ [exerciseId]: { bar_kg, per_side,
// sides, note? } }) with the domain `loadingFor` (+ `nearestLoads` fallback,
// med-3gln) and hands it in — an absent map, a missing/null entry, or an
// empty per_side draws nothing, exactly as before. The optional `note` is an
// extra text line under the glyph (nearest-achievable delta); a note-only
// entry draws text with no glyph (below-bar, bare nearest, fixed gear).
function buildWorkoutPlanDocument(group, days, opts) {
    const o = opts || {};
    const g = group || {};
    const unit = o.unit === 'lb' ? 'lb' : 'kg';
    const printedOn = o.printedOn || new Date().toISOString().slice(0, 10);
    const rotating = !!g.is_rotating;
    // Plate-loading diagrams (med-niix.6): precomputed by the caller, drawn
    // here. Anything but an id-keyed object means no glyphs.
    const loadings = (o.loadingByExerciseId && typeof o.loadingByExerciseId === 'object'
        && !Array.isArray(o.loadingByExerciseId)) ? o.loadingByExerciseId : null;
    const loadCtx = loadings ? { loadings, hadLoading: false } : null;

    // rotation_order asc; anything unset sinks to the end in list order
    // (Array#sort is stable), which is the order the Days editor shows.
    const ordered = [...(days || [])].sort((a, b) => {
        const ro = (d) => {
            const n = Number(d && d.variant && d.variant.rotation_order);
            return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
        };
        return ro(a) - ro(b);
    });

    const meta = [];
    const goal = WORKOUT_PLAN_GOAL_LABELS[g.training_goal];
    if (goal) meta.push(goal);
    const daysText = _workoutGroupDaysText(g);
    if (daysText) {
        meta.push(`Repeats on ${daysText}${g.scheduled_time ? ` · ${g.scheduled_time}` : ''}`);
    } else if (g.scheduled_time) {
        meta.push(g.scheduled_time);
    }
    if (rotating) meta.push(`Rotates through ${ordered.length} day${ordered.length === 1 ? '' : 's'}`);
    if (!g.active) meta.push('Inactive');
    // med-8j5w.2: the gym the plate diagrams were resolved at.
    if (o.locationName) meta.push(`Gym: ${o.locationName}`);

    const description = g.description ? `<p class="meta">${_workoutPlanEsc(g.description)}</p>` : '';
    const blocks = ordered.map((d) => _workoutPlanDayBlock(d, unit, rotating, loadCtx)).join('');
    // Glyph stylesheet only when a glyph rendered: plans without bound
    // equipment stay byte-identical to today.
    const loadCss = (loadCtx && loadCtx.hadLoading) ? WORKOUT_PLAN_LOAD_CSS : '';
    // QR anchor (bd med-qj4.9): identifies the plan when its filled sheet is
    // photographed for scan-back. Injected (never built here) so the pure
    // builder stays DOM- and import-free; empty when generation failed, in
    // which case the sheet still prints and logs by hand as before.
    const qrSvg = (o.qrSvg && typeof o.qrSvg === 'string') ? o.qrSvg : '';
    const qrId = (g.id !== null && g.id !== undefined && g.id !== '') ? `Plan #${_workoutPlanEsc(g.id)}` : '';
    const qr = qrSvg
        ? `<figure class="qr">${qrSvg}<figcaption>Scan to log${qrId ? ` · ${qrId}` : ''}</figcaption></figure>`
        : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${_workoutPlanEsc(g.name || 'Workout plan')}</title>
<style>${WORKOUT_PLAN_DOC_CSS}${loadCss}
</style>
</head>
<body>
<header>
<div class="qrrow"><div class="head">
<h1>${_workoutPlanEsc(g.name || 'Workout plan')}</h1>
<p class="meta">${_workoutPlanEsc(meta.join(' · '))}</p>
${description}</div>${qr}</div></header>
<div class="days${ordered.length > 1 ? ' days--cols' : ''}">${blocks}</div>
<footer>Printed ${_workoutPlanEsc(printedOn)} · Generated on this device — nothing was sent to a server.</footer>
</body>
</html>`;
}

// ponytail: no memoization — import() already caches by specifier. The
// indirection is the test seam (same shape as brief.js loadPrintDoc).
function loadWorkoutPrintDoc() { return import('/js/print-doc.js'); }

// Domain plate math for the sheet glyphs (med-niix.6). Same convention as
// loadWorkoutPrintDoc: the indirection is the test seam, so tests stub the
// namespace function and the harness never resolves the URL.
function loadWorkoutEquipmentDomain() { return import('/domain/equipment.js'); }

// QR svg for the printed sheet (bd med-qj4.9). Dynamic imports keep the
// classic-script Plans list free of module load order: the QR text format
// lives in web/domain/workoutsheet.js and rendering in the vendored
// web/cloud/vendor/qrcode.mjs (same module signup.js uses for the
// emergency kit). Via the namespace so tests can stub the whole step.
async function makePlanQrSvg(groupId) {
    const [{ buildSheetQrText }, { qrcode }] = await Promise.all([
        import('/domain/workoutsheet.js'),
        import('/vendor/qrcode.mjs'),
    ]);
    const qr = qrcode(0, 'M');
    qr.addData(buildSheetQrText(groupId));
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true, title: 'Workout plan code' });
}

// `group` is the row's own cached group record — the Plans list was just
// rendered from it, so re-fetching /api/workout/groups would only re-read
// what we already hold.
async function printWorkoutPlan(group) {
    const g = group || {};
    // N+1 per Day is fine: in cloud mode apishim.js answers these from the
    // local vault. Do NOT add an aggregate endpoint for this.
    const variants = await apiCall(`/api/workout/variants?group_id=${g.id}`);
    if (!Array.isArray(variants)) {
        safeToast('Couldn\'t load the plan — try again online.', 'error');
        return;
    }
    if (variants.length === 0) {
        safeToast('Add some exercises to this plan first.', 'info');
        return;
    }

    const days = [];
    for (const variant of variants) {
        const exercises = await apiCall(`/api/workout/exercises?variant_id=${variant.id}`);
        // A partial read would print a Day with its exercises silently
        // missing, which is worse than not printing at all.
        if (!Array.isArray(exercises)) {
            safeToast('Couldn\'t load the plan — try again online.', 'error');
            return;
        }
        days.push({ variant, exercises });
    }

    // Plate-loading diagrams (med-niix.6, med-3gln): resolve each row's
    // equipment — the row's own override, else the library binding
    // (equipmentIdForExercise, the shared rule) — then decompose the target
    // with the domain loadingFor. An unreachable target falls back to the
    // nearest achievable loading exactly like the session chip (nearestLoads,
    // tie → below via pickNearestLoad) with its delta printed; below-bar and
    // non-stocked fixed loads print a text-only note. Best-effort: a failed
    // read or import prints the sheet exactly as before, without glyphs.
    let loadingByExerciseId = null;
    let printLocationName = null;
    try {
        const lib = await apiCall('/api/workout/exercise-library');
        let inv = null;
        try {
            if (window.WorkoutEquipment && typeof window.WorkoutEquipment.list === 'function') {
                inv = await window.WorkoutEquipment.list();
            }
        } catch (_) {
            inv = null;
        }
        if (!Array.isArray(inv)) inv = await apiCall('/api/workout/equipment', 'GET');
        const { loadingFor, nearestLoads, equipmentForExercise, pickNearestLoad } =
            await window.WorkoutGroups.loadEquipmentDomain();
        if (Array.isArray(lib) && Array.isArray(inv) && typeof loadingFor === 'function'
            && typeof nearestLoads === 'function' && typeof equipmentForExercise === 'function'
            && typeof pickNearestLoad === 'function') {
            const libById = {};
            for (const r of lib) {
                if (r && r.id !== null && r.id !== undefined) libById[r.id] = r;
            }
            // med-8j5w.1/.2: the sheet is for the next visit — resolve at the
            // active gym, from ONE gym snapshot that also labels the sheet
            // (no gyms / failed read / no active gym = whole inventory).
            let location = null;
            try {
                if (window.WorkoutEquipment && typeof window.WorkoutEquipment.locations === 'function') {
                    const gyms = await window.WorkoutEquipment.locations();
                    if (gyms.locations.length > 0) {
                        location = { locationId: gyms.activeId, liveLocationIds: gyms.locations.map((l) => l.id) };
                        const active = gyms.locations.find((l) => String(l.id) === String(gyms.activeId));
                        if (active) printLocationName = active.name || null;
                    }
                }
            } catch (_) {
                location = null;
            }
            loadingByExerciseId = {};
            for (const d of days) {
                for (const ex of (d.exercises || [])) {
                    if (!ex || ex.id === null || ex.id === undefined) continue;
                    const w = Number(ex.target_weight_kg);
                    if (!Number.isFinite(w) || w <= 0) continue;
                    const row = libById[ex.exercise_library_id] || null;
                    // Explicit binding (row, else library) wins; unbound rows
                    // auto-match the inventory by implement + weight (med-x295).
                    const hit = equipmentForExercise(ex, row, inv, w, location);
                    if (!hit) continue;
                    const eq = hit.item;
                    if (eq.kind === 'plated') {
                        const sides = eq.sides === 1 ? 1 : 2;
                        const ld = loadingFor(eq, w);
                        if (ld && Array.isArray(ld.per_side) && ld.per_side.length > 0) {
                            loadingByExerciseId[ex.id] = {
                                bar_kg: ld.bar_kg, per_side: ld.per_side, sides,
                            };
                        } else if (ld) {
                            // Exact bare-bar target: nothing to load, as before.
                        } else {
                            // Below the bar nothing is achievable: say so instead
                            // of suggesting the bare bar as a "nearest" rung.
                            const bar = Number(eq.bar_kg);
                            if (Number.isFinite(bar) && w < bar) {
                                loadingByExerciseId[ex.id] = { note: `below bar (${_workoutPlanR2(bar)} kg)` };
                            } else {
                                const near = nearestLoads(eq.loads_kg, w);
                                const chosen = pickNearestLoad(near.below, near.above, w);
                                if (chosen === null || chosen === undefined) continue;
                                const best = loadingFor(eq, chosen);
                                if (!best) continue;
                                const delta = _workoutPlanR2(chosen - w);
                                const sign = delta > 0 ? '+' : '';
                                const note = `${_workoutPlanR2(chosen)} kg (${sign}${delta} kg)`;
                                loadingByExerciseId[ex.id] = (best.per_side && best.per_side.length > 0)
                                    ? {
                                        bar_kg: best.bar_kg, per_side: best.per_side, sides, note,
                                    }
                                    : { note };
                            }
                        }
                    } else if (eq.kind === 'fixed') {
                        const loads = (Array.isArray(eq.loads_kg) ? eq.loads_kg : [])
                            .map(Number).filter((n) => Number.isFinite(n) && n > 0);
                        if (loads.indexOf(w) !== -1) continue;
                        const near = nearestLoads(loads, w);
                        const chosen = pickNearestLoad(near.below, near.above, w);
                        if (chosen === null || chosen === undefined) continue;
                        loadingByExerciseId[ex.id] = { note: `nearest: ${_workoutPlanR2(chosen)} kg` };
                    }
                    if (hit.auto && loadingByExerciseId[ex.id]) loadingByExerciseId[ex.id].auto = eq.name;
                }
            }
        }
    } catch (_) {
        loadingByExerciseId = null;
    }
    const unit = (typeof readWeightUnitPreference === 'function') ? readWeightUnitPreference() : 'kg';
    // QR anchor is best-effort: a sheet without it still prints and logs by
    // hand exactly as before (bd med-qj4.9).
    let qrSvg = '';
    try {
        qrSvg = await window.WorkoutGroups.makePlanQr(g.id);
    } catch (_) {
        qrSvg = '';
    }
    const html = window.WorkoutGroups.buildDocument(g, days, {
        unit, qrSvg, loadingByExerciseId, locationName: loadingByExerciseId ? printLocationName : null,
    });
    const mod = await window.WorkoutGroups.loadPrintDoc();
    // The adopted stylesheet is the only CSS that lands in the print frame
    // (CSP refuses the inline <style>): include the glyph rules exactly when
    // a glyph rendered, so plain sheets adopt byte-identical CSS.
    const css = html.includes('class="plates"')
        ? WORKOUT_PLAN_DOC_CSS + WORKOUT_PLAN_LOAD_CSS
        : WORKOUT_PLAN_DOC_CSS;
    mod.printDoc(document, html, 'wg-print-frame', css);
}

window.WorkoutGroups = {
    load: loadWorkoutGroups,
    save: saveWorkoutGroup,
    openAdd: () => openWorkoutPlanPage(null),
    openEdit: openWorkoutPlanPage,
    close: closeWorkoutPlanPage,
    delete: deleteWorkoutGroup,
    toggleRotating: toggleRotatingFields,
    addDay: addWorkoutPlanDay,
    addFlatExercise: addWorkoutFlatExercise,
    render: renderWorkoutPlanBody,
    share: shareOpenWorkoutPlan,
    printOpen: printOpenWorkoutPlan,
    scanOpen: scanOpenWorkoutPlan,
    deleteOpen: deleteOpenWorkoutPlan,
    chooseNotification: chooseWorkoutNotification,
    print: printWorkoutPlan,
    buildDocument: buildWorkoutPlanDocument,
    loadPrintDoc: loadWorkoutPrintDoc,
    loadEquipmentDomain: loadWorkoutEquipmentDomain,
    plateSvg: _workoutPlateSvgElement,
    plateText: _workoutPlateText,
    makePlanQr: makePlanQrSvg
};
