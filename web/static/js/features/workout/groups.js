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
        empty.textContent = 'No workout groups yet — tap Add to create one.';
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
    name.textContent = group.name || 'Workout group';
    title.appendChild(name);

    body.appendChild(title);

    const meta = doc.createElement('div');
    meta.className = 'wg-workouts-groups-row__meta';

    let daysArray = [];
    try {
        daysArray = JSON.parse(group.days_of_week || '[]');
    } catch (_) {
        daysArray = [];
    }
    const daysMap = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const daysText = daysArray.map((d) => daysMap[d]).filter(Boolean).join(', ');

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
    actions.appendChild(_buildGroupsIconBtn(doc, 'edit', 'Edit group', 'pencil', () => {
        showEditWorkoutGroupModal(group.id);
    }));
    actions.appendChild(_buildGroupsIconBtn(doc, 'delete', 'Delete group', 'trash', (event) => {
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
    message.textContent = 'Save this group first to add exercises.';
    container.replaceChildren(message);
}

// ====================================
// WORKOUT GROUP MODAL
// ====================================

function showAddWorkoutGroupModal() {
    window.WorkoutEdit.editingGroupId = null;
    window.WorkoutEdit.groupForVariant = null;
    window.WorkoutEdit.variantForExercise = null;
    document.getElementById('workout-group-modal-title').textContent = 'Add Workout Group';
    window.ModalManager.workoutGroup.open();

    // Reset fields
    document.getElementById('workout-group-name').value = '';
    document.getElementById('workout-group-description').value = '';
    document.getElementById('workout-group-rotating').checked = false;
    document.getElementById('workout-group-time').value = '09:00';
    document.getElementById('workout-group-notification').value = '15';
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

    document.getElementById('workout-group-modal-title').textContent = 'Edit Workout Group';
    window.ModalManager.workoutGroup.open();

    // Fill fields
    document.getElementById('workout-group-name').value = group.name;
    document.getElementById('workout-group-description').value = group.description || '';
    document.getElementById('workout-group-rotating').checked = group.is_rotating;
    document.getElementById('workout-group-time').value = group.scheduled_time;
    document.getElementById('workout-group-notification').value = group.notification_advance_minutes;
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
    const isRotating = document.getElementById('workout-group-rotating').checked;
    if (isRotating) {
        document.getElementById('workout-variants-section').style.display = 'block';
        document.getElementById('workout-group-flat-exercises-section').style.display = 'none';
        if (window.WorkoutEdit.editingGroupId) {
            await loadVariantsForGroup(window.WorkoutEdit.editingGroupId);
        }
    } else {
        document.getElementById('workout-variants-section').style.display = 'none';
        document.getElementById('workout-group-flat-exercises-section').style.display = 'block';
        if (window.WorkoutEdit.editingGroupId) {
            // Re-run the logic to fetch/create default variant and load exercises.
            // The variant POST is a workout mutation, so invalidate the
            // workout-tagged caches if the implicit create succeeds.
            let variants = await apiCall(`/api/workout/variants?group_id=${window.WorkoutEdit.editingGroupId}`);
            if (!variants || variants.length === 0) {
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
                    variants = [];
                }
            }
            if (variants.length === 0) {
                setFlatExercisesPendingSaveMessage();
                return;
            }
            const defaultVariantId = variants[0].id;
            window.WorkoutEdit.groupForVariant = window.WorkoutEdit.editingGroupId;
            window.WorkoutEdit.variantForExercise = defaultVariantId;
            await loadExercisesForVariant(defaultVariantId, 'workout-group-flat-exercises-list');
        } else {
            // New group, just show message
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
    const active = document.getElementById('workout-group-active').checked;

    if (!name) {
        safeAlert('Group name is required!');
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
        notification_advance_minutes: notification
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

    await safeConfirm('Delete this workout group?', async (ok) => {
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

window.WorkoutGroups = {
    load: loadWorkoutGroups,
    save: saveWorkoutGroup,
    openAdd: showAddWorkoutGroupModal,
    openEdit: showEditWorkoutGroupModal,
    close: closeWorkoutGroupModal,
    delete: deleteWorkoutGroup,
    toggleRotating: toggleRotatingFields,
    toggleDay: toggleWorkoutDay
};
