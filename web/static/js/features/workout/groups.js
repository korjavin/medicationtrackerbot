// ====================================
// WORKOUT GROUPS — CRUD
// ====================================
//
// Owns:
//   - cached workout-groups list (window.WorkoutEdit.cachedGroups)
//   - "currently editing group id" form state (closure-private,
//     read/written via window.WorkoutEdit.editingGroupId getter/setter)
//   - the group-create / group-edit / group-delete flows
//
// Cross-file coupling: variants.js + exercises.js consult
// window.WorkoutEdit.editingGroupId / .cachedGroups to drive variant /
// exercise modal openings without needing direct access to this file's
// closure.

(function () {
    // Closure-private "currently editing group" state. Plan Task 1 forbids
    // module-level mutable globals in the extracted files — the equivalent of
    // the original `let currentEditingGroupId = null` is held in this IIFE.
    let _editingGroupId = null;
    // Cached workout groups list. Hydrated by loadWorkoutGroups + the SWR
    // onFresh path; consumed by showEditWorkoutGroupModal / showAddVariantModal
    // / resolveVariantForExercise. Exposed via WorkoutEdit.cachedGroups.
    let _cachedGroups = [];

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
            await renderWorkoutGroupsStaleBadge();
        },
        onFresh: async (groups) => {
            window.WorkoutEdit.cachedGroups = groups || [];
            if (groups && window.MedTrackerDB?.WorkoutStore) {
                await window.MedTrackerDB.WorkoutStore.saveCache('groups', groups);
            }
            _renderWorkoutGroups(container, groups);
            await renderWorkoutGroupsStaleBadge();
        },
        onError: async (error, cached) => {
            console.error('Error loading workout groups:', error);
            if (!cached) {
                const message = document.createElement('p');
                message.className = 'text-hint';
                message.textContent = 'No cached data — will load when online';
                container.replaceChildren(message);
            }
            await renderWorkoutGroupsStaleBadge();
        }
    });
}

// Mounts the wg-stale-badge into the Workouts Groups subtab from the
// 'workout_groups' api_cache timestamp.
async function renderWorkoutGroupsStaleBadge() {
    const slot = (typeof document !== 'undefined') ? document.getElementById('workout-groups-stale-badge') : null;
    if (!slot) return;
    const api = (typeof window !== 'undefined') ? window.WGStaleBadge : null;
    if (!api || typeof api.mountFromKey !== 'function') {
        slot.replaceChildren();
        slot.classList.add('hidden');
        return;
    }
    await api.mountFromKey({ slot, key: 'workout_groups' });
}

function _renderWorkoutGroups(container, groups) {
    if (!container) return;
    const doc = container.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return;
    window.WorkoutEdit.cachedGroups = groups || [];

    container.classList.add('wg-workouts-groups');

    if (!groups || groups.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'wg-workouts-groups__empty';
        empty.textContent = 'No plans yet — tap Add to create one.';
        container.replaceChildren(empty);
        return;
    }

    const list = doc.createElement('ul');
    list.className = 'list-reset wg-workouts-groups__list';

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

function _buildWorkoutGroupRow(doc, group) {
    const slot = getRotationSlot(group.name || '');
    const slotMod = _slotTagModifier(slot);

    const card = doc.createElement('li');
    card.className = 'wg-card wg-workouts-groups-row';
    card.dataset.groupId = String(group.id || '');
    card.dataset.slot = slot;
    if (group.is_rotating) card.classList.add('wg-workouts-groups-row--rotating');
    if (!group.active) card.classList.add('wg-workouts-groups-row--inactive');

    const body = doc.createElement('div');
    body.className = 'wg-workouts-groups-row__body';

    const title = doc.createElement('div');
    title.className = 'wg-workouts-groups-row__title';

    const slotTag = doc.createElement('span');
    slotTag.className = `wg-workouts-slot-tag wg-workouts-slot-tag--${slotMod} wg-workouts-groups-row__slot`;
    slotTag.textContent = slot;
    title.appendChild(slotTag);

    const name = doc.createElement('span');
    name.className = 'wg-workouts-groups-row__name';
    name.textContent = group.name || 'Plan';
    title.appendChild(name);

    body.appendChild(title);

    const meta = doc.createElement('div');
    meta.className = 'wg-workouts-groups-row__meta';

    const daysText = _workoutGroupDaysText(group);

    if (daysText) {
        const days = doc.createElement('span');
        days.className = 'wg-workouts-groups-row__days';
        days.textContent = daysText;
        meta.appendChild(days);
    }

    if (group.scheduled_time) {
        const time = doc.createElement('span');
        time.className = 'wg-workouts-groups-row__time';
        time.textContent = group.scheduled_time;
        meta.appendChild(time);
    }

    if (Number.isFinite(Number(group.exercises_count))) {
        const count = doc.createElement('span');
        count.className = 'wg-workouts-groups-row__count';
        const n = Number(group.exercises_count);
        count.textContent = `${n} exercise${n === 1 ? '' : 's'}`;
        meta.appendChild(count);
    }

    if (group.is_rotating) {
        const rot = doc.createElement('span');
        rot.className = 'wg-tag wg-tag--mono wg-tag--normal wg-workouts-groups-row__rotating';
        rot.textContent = 'Rotating';
        meta.appendChild(rot);
    }

    if (!group.active) {
        const inactive = doc.createElement('span');
        inactive.className = 'wg-tag wg-tag--mono wg-tag--skipped wg-workouts-groups-row__inactive';
        inactive.textContent = 'Inactive';
        meta.appendChild(inactive);
    }

    if (meta.childNodes.length > 0) body.appendChild(meta);

    card.appendChild(body);

    const actions = doc.createElement('div');
    actions.className = 'wg-workouts-groups-row__actions';
    actions.appendChild(_buildGroupsIconBtn(doc, 'print', 'Print plan', 'printer', () => {
        // Via the namespace so the print-doc handoff stays stubbable in tests.
        window.WorkoutGroups.print(group);
    }));
    actions.appendChild(_buildGroupsIconBtn(doc, 'edit', 'Edit plan', 'pencil', () => {
        showEditWorkoutGroupModal(group.id);
    }));
    actions.appendChild(_buildGroupsIconBtn(doc, 'delete', 'Delete plan', 'trash', (event) => {
        deleteWorkoutGroup(group.id, event);
    }));
    card.appendChild(actions);

    card.addEventListener('click', (e) => {
        if (e.target.closest('.wg-workouts-groups-row__actions')) return;
        showEditWorkoutGroupModal(group.id);
    });

    return card;
}

function _buildGroupsIconBtn(doc, kind, ariaLabel, iconName, handler) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `wg-icon-btn wg-workouts-groups-row__${kind}`;
    btn.setAttribute('aria-label', ariaLabel);
    const gloss = doc.createElement('span');
    gloss.className = 'wg-gloss';
    if (typeof window !== 'undefined' && window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        gloss.appendChild(window.WGIcons.iconSvg(iconName, { size: 16 }));
    }
    btn.appendChild(gloss);
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handler(e);
    });
    return btn;
}

function setFlatExercisesPendingSaveMessage() {
    const container = document.getElementById('workout-group-flat-exercises-list');
    if (!container) return;
    const message = document.createElement('p');
    message.className = 'workout-pending-msg';
    message.textContent = 'Save this plan first to add exercises.';
    container.replaceChildren(message);
}

// ====================================
// WORKOUT GROUP MODAL
// ====================================

function showAddWorkoutGroupModal() {
    window.WorkoutEdit.editingGroupId = null;
    window.WorkoutEdit.groupForVariant = null;
    window.WorkoutEdit.variantForExercise = null;
    document.getElementById('workout-group-modal-title').textContent = 'Add Plan';
    window.ModalManager.workoutGroup.open();

    // Reset fields
    document.getElementById('workout-group-name').value = '';
    document.getElementById('workout-group-description').value = '';
    document.getElementById('workout-group-rotating').checked = false;
    document.getElementById('workout-group-time').value = '09:00';
    document.getElementById('workout-group-notification').value = '15';
    document.getElementById('workout-group-goal').value = 'hypertrophy';
    document.getElementById('workout-group-active').checked = true;

    // Clear days
    document.querySelectorAll('#workout-group-modal .days-select span').forEach(s => s.classList.remove('selected'));

    // Show/hide sections based on default "Rotating" state (unchecked)
    document.getElementById('workout-variants-section').style.display = 'none';
    document.getElementById('workout-group-flat-exercises-section').style.display = 'block';
    setFlatExercisesPendingSaveMessage();
}

async function showEditWorkoutGroupModal(groupId) {
    window.WorkoutEdit.editingGroupId = groupId;
    window.WorkoutEdit.groupForVariant = groupId;
    window.WorkoutEdit.variantForExercise = null;
    const group = window.WorkoutEdit.cachedGroups.find(g => g.id === groupId);
    if (!group) return;

    document.getElementById('workout-group-modal-title').textContent = 'Edit Plan';
    window.ModalManager.workoutGroup.open();

    // Fill fields
    document.getElementById('workout-group-name').value = group.name;
    document.getElementById('workout-group-description').value = group.description || '';
    document.getElementById('workout-group-rotating').checked = group.is_rotating;
    document.getElementById('workout-group-time').value = group.scheduled_time;
    document.getElementById('workout-group-notification').value = group.notification_advance_minutes;
    document.getElementById('workout-group-goal').value = group.training_goal || 'hypertrophy';
    document.getElementById('workout-group-active').checked = group.active;

    // Set days
    const daysArray = JSON.parse(group.days_of_week || '[]');
    document.querySelectorAll('#workout-group-modal .days-select span').forEach(s => {
        const day = parseInt(s.dataset.day);
        if (daysArray.includes(day)) {
            s.classList.add('selected');
        } else {
            s.classList.remove('selected');
        }
    });

    // Show variants or flat exercises based on rotation
    if (group.is_rotating) {
        document.getElementById('workout-variants-section').style.display = 'block';
        document.getElementById('workout-group-flat-exercises-section').style.display = 'none';
        await loadVariantsForGroup(groupId);
    } else {
        document.getElementById('workout-variants-section').style.display = 'none';
        document.getElementById('workout-group-flat-exercises-section').style.display = 'block';

        // Fetch variants. If none exists, create a default one for non-rotating groups.
        // Creating a variant is a workout mutation that can flip workout_next
        // eligibility for the group, so invalidate the workout-tagged caches
        // before continuing — even if the user cancels the modal afterwards.
        let variants = await apiCall(`/api/workout/variants?group_id=${groupId}`);
        if (!variants || variants.length === 0) {
            const newVariant = await apiCall('/api/workout/variants/create', 'POST', {
                group_id: groupId,
                name: 'Main',
                rotation_order: null,
                description: ''
            });
            if (newVariant) {
                await invalidateWorkoutCache();
                variants = [newVariant];
            } else {
                variants = [];
            }
        }

        if (variants.length === 0) {
            setFlatExercisesPendingSaveMessage();
            return;
        }

        const defaultVariantId = variants[0].id;
        window.WorkoutEdit.groupForVariant = groupId;
        window.WorkoutEdit.variantForExercise = defaultVariantId;
        await loadExercisesForVariant(defaultVariantId, 'workout-group-flat-exercises-list');
    }
}

function closeWorkoutGroupModal() {
    window.ModalManager.workoutGroup.close();
    window.WorkoutEdit.editingGroupId = null;
    window.WorkoutEdit.groupForVariant = null;
    window.WorkoutEdit.variantForExercise = null;
}

async function toggleRotatingFields() {
    // The >1-Day off-guard below runs async (it fetches the Day count). Mark the
    // guard in-flight so saveWorkoutGroup can refuse to save while the checkbox
    // hasn't yet been settled — otherwise a Save click racing this fetch would
    // post the still-false checkbox and slip past the guard (Task 4).
    // Count in-flight handlers rather than a bool: the change event is
    // fire-and-forget, so a rapid off/on/off can overlap handlers, and an
    // earlier one clearing a shared bool would open the guard while a later
    // off-check is still pending. Guard stays closed until the last one settles.
    window.WorkoutEdit.rotatingGuardPending = (window.WorkoutEdit.rotatingGuardPending || 0) + 1;
    try {
        await toggleRotatingFieldsInner();
    } finally {
        window.WorkoutEdit.rotatingGuardPending -= 1;
    }
}

async function toggleRotatingFieldsInner() {
    const isRotating = document.getElementById('workout-group-rotating').checked;
    if (isRotating) {
        document.getElementById('workout-variants-section').style.display = 'block';
        document.getElementById('workout-group-flat-exercises-section').style.display = 'none';
        if (window.WorkoutEdit.editingGroupId) {
            await loadVariantsForGroup(window.WorkoutEdit.editingGroupId);
        }
    } else {
        if (window.WorkoutEdit.editingGroupId) {
            // Re-run the logic to fetch/create default variant and load exercises.
            // The variant POST is a workout mutation, so invalidate the
            // workout-tagged caches if the implicit create succeeds.
            let variants = await apiCall(`/api/workout/variants?group_id=${window.WorkoutEdit.editingGroupId}`);
            // A failed read (offline/5xx) returns null. Don't fall open to []:
            // that would skip the >1-Day guard below and flatten a genuinely
            // multi-Day plan, stranding the extra Days' exercises. Treat unknown
            // Day count as "can't collapse" — keep rotation on and bail.
            if (!Array.isArray(variants)) {
                document.getElementById('workout-group-rotating').checked = true;
                document.getElementById('workout-variants-section').style.display = 'block';
                document.getElementById('workout-group-flat-exercises-section').style.display = 'none';
                safeAlert('Couldn\'t check this plan\'s Days — try again when back online.');
                return;
            }

            // Guard (Task 4): a Plan with more than one Day can't switch rotation
            // off — collapsing to a single flat list would strand the extra Days'
            // exercises. Keep the toggle on + Days editor visible; user deletes
            // the extras first. Zero data loss.
            if (variants.length > 1) {
                document.getElementById('workout-group-rotating').checked = true;
                document.getElementById('workout-variants-section').style.display = 'block';
                document.getElementById('workout-group-flat-exercises-section').style.display = 'none';
                safeAlert('Delete the extra Days first — a plan with more than one Day can\'t switch off "Rotate through days".');
                return;
            }

            document.getElementById('workout-variants-section').style.display = 'none';
            document.getElementById('workout-group-flat-exercises-section').style.display = 'block';
            if (variants.length === 0) {
                const newVariant = await apiCall('/api/workout/variants/create', 'POST', {
                    group_id: window.WorkoutEdit.editingGroupId,
                    name: 'Main',
                    rotation_order: null,
                    description: ''
                });
                if (newVariant) {
                    await invalidateWorkoutCache();
                    variants = [newVariant];
                } else {
                    setFlatExercisesPendingSaveMessage();
                    return;
                }
            }
            const defaultVariantId = variants[0].id;
            window.WorkoutEdit.groupForVariant = window.WorkoutEdit.editingGroupId;
            window.WorkoutEdit.variantForExercise = defaultVariantId;
            await loadExercisesForVariant(defaultVariantId, 'workout-group-flat-exercises-list');
        } else {
            // New group, just show message
            document.getElementById('workout-variants-section').style.display = 'none';
            document.getElementById('workout-group-flat-exercises-section').style.display = 'block';
            setFlatExercisesPendingSaveMessage();
        }
    }
}

function toggleWorkoutDay(el) {
    el.classList.toggle('selected');
}

async function saveWorkoutGroup() {
    const name = document.getElementById('workout-group-name').value.trim();
    const description = document.getElementById('workout-group-description').value.trim();
    const isRotating = document.getElementById('workout-group-rotating').checked;
    const time = document.getElementById('workout-group-time').value;
    const notification = parseInt(document.getElementById('workout-group-notification').value);
    const trainingGoal = document.getElementById('workout-group-goal').value;
    const active = document.getElementById('workout-group-active').checked;

    // Don't save while the rotation off-guard (toggleRotatingFields) is still
    // fetching the Day count — the checkbox may not reflect the guarded value
    // yet, so posting now could slip is_rotating:false past the >1-Day guard.
    if (window.WorkoutEdit.rotatingGuardPending > 0) {
        safeAlert('Still checking this plan\'s Days — try again in a moment.');
        return;
    }

    if (!name) {
        safeAlert('Plan name is required!');
        return;
    }

    if (!time) {
        safeAlert('Scheduled time is required!');
        return;
    }

    const days = Array.from(document.querySelectorAll('#workout-group-modal .days-select span.selected'))
        .map(s => parseInt(s.dataset.day));


    const payload = {
        name,
        description,
        is_rotating: isRotating,
        days_of_week: JSON.stringify(days),
        scheduled_time: time,
        notification_advance_minutes: notification,
        training_goal: trainingGoal
    };

    let result;
    if (window.WorkoutEdit.editingGroupId) {
        // Update
        payload.active = active;
        result = await apiCall(`/api/workout/groups/update?id=${window.WorkoutEdit.editingGroupId}`, 'PUT', payload);
    } else {
        // Create
        result = await apiCall('/api/workout/groups/create', 'POST', payload);
    }

    if (result || result === true) {
        await invalidateWorkoutCache();
        closeWorkoutGroupModal();
        loadWorkoutGroups();
    }
}

async function deleteWorkoutGroup(groupId, event) {
    event.stopPropagation();

    await safeConfirm('Delete this plan?', async (ok) => {
        if (ok) {
            await _deleteWorkoutGroupApi(groupId);
        }
    });
}

async function _deleteWorkoutGroupApi(groupId) {
    const result = await apiCall(`/api/workout/groups/delete?id=${groupId}`, 'DELETE');
    if (result || result === true) {
        await invalidateWorkoutCache();
        loadWorkoutGroups();
    }
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
  footer { margin-top: 5mm; padding-top: 2mm; border-top: 1px solid #ddd;
           color: #555; font-size: 8.5px; }`;

function _workoutPlanWeightClause(kg, unit) {
    // core/utils.js owns the single KG_PER_LB; targets are stored in kg, so an
    // lb user must not be handed a kg number on paper.
    const fmt = (typeof formatWeight === 'function')
        ? formatWeight
        : (v, u) => ({ value: Number(v), label: u });
    const w = fmt(kg, unit);
    return Number.isFinite(w.value) ? ` @ ${w.value} ${w.label}` : '';
}

function _workoutPlanExerciseItem(ex, unit) {
    const reps = (ex.target_reps_max)
        ? `${ex.target_reps_min}–${ex.target_reps_max}`
        : `${ex.target_reps_min}`;
    const weight = ex.target_weight_kg ? _workoutPlanWeightClause(ex.target_weight_kg, unit) : '';
    const sets = Math.max(1, Number(ex.target_sets) || 1);
    // The hand-logging boxes are the point of the sheet — the one thing a
    // screenshot could not give. Floor 3 so a single-set entry still leaves
    // room to write; cap 6 so a 10-set entry does not squeeze the row flat.
    const cellCount = Math.min(6, Math.max(3, sets));
    const cell = `<span class="cell">${_workoutPlanEsc(unit)} × reps</span>`;
    return `<li><span class="ex">${_workoutPlanEsc(ex.exercise_name)}</span> `
        + `<span class="tgt">${sets} × ${reps}${_workoutPlanEsc(weight)}</span>`
        + `<span class="cells">${new Array(cellCount).fill(cell).join('')}</span></li>`;
}

function _workoutPlanDayBlock(day, unit, showHeading) {
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
        ? `<ol>${exercises.map((ex) => _workoutPlanExerciseItem(ex, unit)).join('')}</ol>`
        : '<p class="desc">No exercises yet.</p>';
    return `<section class="day">${heading}${desc}${body}</section>`;
}

// buildWorkoutPlanDocument(group, days, { unit, printedOn }) → a standalone
// HTML string. Pure: no DOM, no clock beyond the injectable `printedOn`, so
// the test can assert what reaches paper without opening a print dialog.
// `days` is [{ variant, exercises }], one entry per variant.
function buildWorkoutPlanDocument(group, days, opts) {
    const o = opts || {};
    const g = group || {};
    const unit = o.unit === 'lb' ? 'lb' : 'kg';
    const printedOn = o.printedOn || new Date().toISOString().slice(0, 10);
    const rotating = !!g.is_rotating;

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

    const description = g.description ? `<p class="meta">${_workoutPlanEsc(g.description)}</p>` : '';
    const blocks = ordered.map((d) => _workoutPlanDayBlock(d, unit, rotating)).join('');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${_workoutPlanEsc(g.name || 'Workout plan')}</title>
<style>${WORKOUT_PLAN_DOC_CSS}
</style>
</head>
<body>
<header>
<h1>${_workoutPlanEsc(g.name || 'Workout plan')}</h1>
<p class="meta">${_workoutPlanEsc(meta.join(' · '))}</p>
${description}</header>
<div class="days${ordered.length > 1 ? ' days--cols' : ''}">${blocks}</div>
<footer>Printed ${_workoutPlanEsc(printedOn)} · Generated on this device — nothing was sent to a server.</footer>
</body>
</html>`;
}

// ponytail: no memoization — import() already caches by specifier. The
// indirection is the test seam (same shape as brief.js loadPrintDoc).
function loadWorkoutPrintDoc() { return import('/js/print-doc.js'); }

// `group` is the row's own cached group record — the Plans list was just
// rendered from it, so re-fetching /api/workout/groups would only re-read
// what we already hold.
async function printWorkoutPlan(group) {
    const g = group || {};
    // N+1 per Day is fine: in cloud mode apishim.js answers these from the
    // local vault. Do NOT add an aggregate endpoint for this.
    const variants = await apiCall(`/api/workout/variants?group_id=${g.id}`);
    if (!Array.isArray(variants)) {
        safeAlert('Couldn\'t load the plan — try again online.');
        return;
    }
    if (variants.length === 0) {
        safeAlert('Add some exercises to this plan first.');
        return;
    }

    const days = [];
    for (const variant of variants) {
        const exercises = await apiCall(`/api/workout/exercises?variant_id=${variant.id}`);
        // A partial read would print a Day with its exercises silently
        // missing, which is worse than not printing at all.
        if (!Array.isArray(exercises)) {
            safeAlert('Couldn\'t load the plan — try again online.');
            return;
        }
        days.push({ variant, exercises });
    }

    const unit = (typeof readWeightUnitPreference === 'function') ? readWeightUnitPreference() : 'kg';
    const html = window.WorkoutGroups.buildDocument(g, days, { unit });
    const mod = await window.WorkoutGroups.loadPrintDoc();
    mod.printDoc(document, html, 'wg-print-frame', WORKOUT_PLAN_DOC_CSS);
}

window.WorkoutGroups = {
    load: loadWorkoutGroups,
    save: saveWorkoutGroup,
    openAdd: showAddWorkoutGroupModal,
    openEdit: showEditWorkoutGroupModal,
    close: closeWorkoutGroupModal,
    delete: deleteWorkoutGroup,
    toggleRotating: toggleRotatingFields,
    toggleDay: toggleWorkoutDay,
    print: printWorkoutPlan,
    buildDocument: buildWorkoutPlanDocument,
    loadPrintDoc: loadWorkoutPrintDoc
};
