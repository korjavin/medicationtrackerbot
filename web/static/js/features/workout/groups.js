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
                const message = document.createElement('p');
                message.className = 'text-hint';
                message.textContent = 'No cached data — will load when online';
                container.replaceChildren(message);
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
    const card = doc.createElement('li');
    card.className = 'wg-card wg-workouts-groups-row';
    card.dataset.groupId = String(group.id || '');
    if (group.is_rotating) card.classList.add('wg-workouts-groups-row--rotating');
    if (!group.active) card.classList.add('wg-workouts-groups-row--inactive');

    const body = doc.createElement('div');
    body.className = 'wg-workouts-groups-row__body';

    const title = doc.createElement('div');
    title.className = 'wg-workouts-groups-row__title';

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
    actions.appendChild(_buildGroupsIconBtn(doc, 'share', 'Share plan', 'share', () => {
        // Via the namespace so the share-modal handoff stays stubbable in tests.
        window.WorkoutShare.share(group);
    }));
    actions.appendChild(_buildGroupsIconBtn(doc, 'print', 'Print plan', 'printer', () => {
        // Via the namespace so the print-doc handoff stays stubbable in tests.
        window.WorkoutGroups.print(group);
    }));
    // Scan-back (bd med-qj4.9) needs the browser-direct vision path
    // (window.CloudWorkoutSheetAI); hidden when that seam is absent.
    if (window.WorkoutScan && typeof window.WorkoutScan.scan === 'function') {
        actions.appendChild(_buildGroupsIconBtn(doc, 'scan', 'Scan filled sheet', 'camera', () => {
            window.WorkoutScan.scan(group);
        }));
    }
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
                safeToast('Couldn\'t check this plan\'s Days — try again when back online.', 'error');
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
                safeToast('Delete the extra Days first — a plan with more than one Day can\'t switch off "Rotate through days".', 'info');
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
        safeToast('Still checking this plan\'s Days — try again in a moment.', 'info');
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
    openAdd: showAddWorkoutGroupModal,
    openEdit: showEditWorkoutGroupModal,
    close: closeWorkoutGroupModal,
    delete: deleteWorkoutGroup,
    toggleRotating: toggleRotatingFields,
    toggleDay: toggleWorkoutDay,
    print: printWorkoutPlan,
    buildDocument: buildWorkoutPlanDocument,
    loadPrintDoc: loadWorkoutPrintDoc,
    loadEquipmentDomain: loadWorkoutEquipmentDomain,
    plateSvg: _workoutPlateSvgElement,
    plateText: _workoutPlateText,
    makePlanQr: makePlanQrSvg
};
