
// ====================================
// WORKOUT MANAGEMENT - CRUD Interface
// ====================================

// State
let workoutGroups = [];
let currentEditingGroupId = null;
let currentEditingVariantId = null;
let currentEditingExerciseId = null;
let currentGroupForVariant = null;
let currentVariantForExercise = null;

// ====================================
// TAB SWITCHING
// ====================================

function switchWorkoutTab(tab) {
    const activated = activateTabGroup(tab, {
        buttonSelector: '.workout-tab',
        contentSelector: '.workout-tab-content',
        contentIdFromTab: (tabName) => `workout-${tabName}-tab`
    });
    if (!activated) return;

    if (tab === 'groups') { loadWorkoutGroups(); }
    else if (tab === 'history') { loadNextWorkout(); loadWorkoutHistoryTab(); }
    else if (tab === 'exercises') { loadExerciseLibrary(); }
    else if (tab === 'stats') { loadWorkoutStatsTab(); }
}

bindTabGroup({
    container: document.querySelector('.workout-tabs'),
    buttonSelector: '.workout-tab',
    onTabSelect: switchWorkoutTab
});

// Main load function called when switching to workouts tab
function loadWorkouts() {
    switchWorkoutTab('history');
}

// ====================================
// NEXT WORKOUT CARD
// ====================================

async function loadNextWorkout() {
    const container = document.getElementById('next-workout-card');
    await window.DataStore.loadSWR({
        key: 'workout_next',
        tags: ['workout'],
        fetcher: async () => await apiCall('/api/workout/sessions/next'),
        onCached: async (cached) => {
            _renderNextWorkout(container, cached);
        },
        onFresh: async (fresh) => {
            _renderNextWorkout(container, fresh);
        },
        onError: async (error, cached) => {
            console.error('Error loading next workout:', error);
            if (!cached) container.innerHTML = '';
        },
        allowNullFresh: true
    });
}

function _renderNextWorkout(container, data) {
    if (!data || !data.session) {
        container.innerHTML = '';
        return;
    }

    const session = data.session;
    const status = session.status;
    const isSnoozed = session.is_snoozed || false;
    const date = new Date(session.scheduled_date);
    const today = new Date();

    // Properly compare dates (year, month, day only)
    const isToday = date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate();

    // Determine card styling based on status
    let cardClass = 'next-workout-card';
    let statusEmoji = '📅';
    let statusText = 'Upcoming';

    if (isSnoozed) {
        cardClass += ' notified';
        statusEmoji = '⏰';
        statusText = 'Snoozed';
    } else if (status === 'in_progress') {
        cardClass += ' in-progress';
        statusEmoji = '🏋️';
        statusText = 'In Progress';
    } else if (status === 'notified') {
        cardClass += ' notified';
        statusEmoji = '🔔';
        statusText = 'Ready to Start';
    } else if (status === 'pre_skipped') {
        cardClass += ' pre-skipped';
        statusEmoji = '⏭';
        statusText = 'To Be Skipped';
    } else if (isToday) {
        cardClass += ' today';
        statusText = 'Today';
    }

    const dateStr = isToday ? 'Today' : date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        weekday: 'short'
    });

    // Show appropriate buttons based on status
    const isRotating = data.is_rotating || false;
    let actionButtons = '';
    if (status === 'in_progress') {
        actionButtons = `
                <div style="display: flex; gap: 10px; margin-top: 12px;">
                    <button onclick="showWorkoutSessionModal(${session.id})" class="primary" style="flex: 1;">🏋️ Continue</button>
                    <button onclick="cancelWorkoutSession(${session.id})" class="secondary" style="flex: 1; background-color: #ffebee; color: #c62828; border: 1px solid #ef9a9a;">🛑 Stop</button>
                </div>
            `;
    } else if (status === 'pre_skipped') {
        actionButtons = `<button onclick="cancelPreSkipWorkoutSession(${session.id})" class="btn-pill" style="margin-top: 12px; width: 100%; background-color: var(--button-color, #5288c1); color: white;">↩ Cancel Skip</button>`;
        if (isRotating) {
            actionButtons += `<button onclick="nextWorkoutVariant(${session.id})" class="secondary" style="margin-top: 8px; width: 100%;">↻ Next Variant</button>`;
        }
    } else {
        actionButtons = `
                <div style="display: flex; gap: 10px; margin-top: 12px;">
                    <button onclick="startWorkoutSession(${session.id})" class="btn-pill" style="flex: 1;">🏋️ Start Workout</button>
                    <button onclick="preSkipWorkoutSession(${session.id})" class="secondary" style="flex: 1; background-color: #fff3e0; color: #e65100; border: 1px solid #ffcc80;">⏭ Skip</button>
                </div>
            `;
        if (isRotating) {
            actionButtons += `<button onclick="nextWorkoutVariant(${session.id})" class="secondary" style="margin-top: 8px; width: 100%;">↻ Next Variant</button>`;
        }
    }

    const variantId = data.variant_id || 0;
    const groupId = data.group_id || 0;

    container.innerHTML = `
            <div class="${cardClass}">
                <div class="next-workout-header">
                    <div class="next-workout-status">${statusEmoji} ${statusText}</div>
                    <div class="next-workout-date">${dateStr} at ${session.scheduled_time}</div>
                </div>
                <div class="next-workout-info" onclick="openNextWorkoutEditModal(${variantId}, ${groupId})" style="cursor: pointer;" title="View/edit planned exercises">
                    <h3>${escapeHtml(data.group_name)}</h3>
                    <p>${escapeHtml(data.variant_name)} • ${data.exercises_count} exercises ✏️</p>
                </div>
                ${actionButtons}
            </div>
        `;
}

// ====================================
// NEXT WORKOUT EDIT MODAL
// ====================================

async function openNextWorkoutEditModal(variantId, groupId) {
    if (!variantId || !groupId) return;
    currentGroupForVariant = groupId;
    await showEditVariantModal(variantId);
}

async function nextWorkoutVariant(sessionId) {
    try {
        await apiCall(`/api/workout/sessions/${sessionId}/next-variant`, 'POST');
        await loadNextWorkout();
    } catch (error) {
        console.error('Error switching to next variant:', error);
        alert('Failed to switch variant. Please try again.');
    }
}

// ====================================
// LOAD WORKOUT GROUPS
// ====================================

async function loadWorkoutGroups() {
    const container = document.getElementById('workout-groups-list');
    await window.DataStore.loadSWR({
        key: 'workout_groups',
        tags: ['workout'],
        fetcher: async () => await apiCall('/api/workout/groups'),
        onCached: async (cached) => {
            _renderWorkoutGroups(container, cached);
        },
        onFresh: async (groups) => {
            workoutGroups = groups || [];
            if (groups && window.MedTrackerDB?.WorkoutStore) {
                await window.MedTrackerDB.WorkoutStore.saveCache('groups', groups);
            }
            _renderWorkoutGroups(container, groups);
        },
        onError: async (error, cached) => {
            console.error('Error loading workout groups:', error);
            if (!cached) container.innerHTML = '<p style="color: red;">Error loading workout groups</p>';
        }
    });
}

function _renderWorkoutGroups(container, groups) {
    workoutGroups = groups || [];

    if (!groups || groups.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--hint-color); padding: 40px;">No workout groups yet. Click "+ Add Workout Group" to get started!</p>';
        return;
    }

    let html = '';
    groups.forEach(group => {
        const daysArray = JSON.parse(group.days_of_week || '[]');
        const daysMap = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const daysText = daysArray.map(d => daysMap[d]).join(', ');

        html += `
                <div class="med-item" style="margin-bottom: 15px;">
                    <div class="med-info" onclick="showEditWorkoutGroupModal(${group.id})" style="cursor: pointer;">
                        <h4>${escapeHtml(group.name)} ${group.is_rotating ? '🔄' : ''} ${!group.active ? '(Inactive)' : ''}</h4>
                        <p>${escapeHtml(group.description || '')}</p>
                        <p style="font-size: 0.9em; color: #666;">
                            📅 ${daysText} at ${group.scheduled_time}
                            <br>🔔 ${group.notification_advance_minutes} min before
                        </p>
                    </div>
                    <button class="delete-btn" onclick="deleteWorkoutGroup(${group.id}, event)">&times;</button>
                </div>
            `;
    });

    container.innerHTML = html;
}

// ====================================
// WORKOUT GROUP MODAL
// ====================================

function showAddWorkoutGroupModal() {
    currentEditingGroupId = null;
    currentGroupForVariant = null;
    currentVariantForExercise = null;
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
    document.getElementById('workout-group-flat-exercises-list').innerHTML = '<p style="color: var(--hint-color); font-size: 0.9em;">Save this group first to add exercises.</p>';
}

async function showEditWorkoutGroupModal(groupId) {
    currentEditingGroupId = groupId;
    currentGroupForVariant = groupId;
    currentVariantForExercise = null;
    const group = workoutGroups.find(g => g.id === groupId);
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
        let variants = await apiCall(`/api/workout/variants?group_id=${groupId}`);
        if (!variants || variants.length === 0) {
            const newVariant = await apiCall('/api/workout/variants/create', 'POST', {
                group_id: groupId,
                name: 'Main',
                rotation_order: null,
                description: ''
            });
            variants = [newVariant];
        }

        const defaultVariantId = variants[0].id;
        currentGroupForVariant = groupId;
        currentVariantForExercise = defaultVariantId;
        await loadExercisesForVariant(defaultVariantId, 'workout-group-flat-exercises-list');
    }
}

function closeWorkoutGroupModal() {
    window.ModalManager.workoutGroup.close();
    currentEditingGroupId = null;
    currentGroupForVariant = null;
    currentVariantForExercise = null;
}

async function toggleRotatingFields() {
    const isRotating = document.getElementById('workout-group-rotating').checked;
    if (isRotating) {
        document.getElementById('workout-variants-section').style.display = 'block';
        document.getElementById('workout-group-flat-exercises-section').style.display = 'none';
        if (currentEditingGroupId) {
            await loadVariantsForGroup(currentEditingGroupId);
        }
    } else {
        document.getElementById('workout-variants-section').style.display = 'none';
        document.getElementById('workout-group-flat-exercises-section').style.display = 'block';
        if (currentEditingGroupId) {
            // Re-run the logic to fetch/create default variant and load exercises
            let variants = await apiCall(`/api/workout/variants?group_id=${currentEditingGroupId}`);
            if (!variants || variants.length === 0) {
                const newVariant = await apiCall('/api/workout/variants/create', 'POST', {
                    group_id: currentEditingGroupId,
                    name: 'Main',
                    rotation_order: null,
                    description: ''
                });
                variants = [newVariant];
            }
            const defaultVariantId = variants[0].id;
            currentGroupForVariant = currentEditingGroupId;
            currentVariantForExercise = defaultVariantId;
            await loadExercisesForVariant(defaultVariantId, 'workout-group-flat-exercises-list');
        } else {
            // New group, just show message
            document.getElementById('workout-group-flat-exercises-list').innerHTML = '<p style="color: var(--hint-color); font-size: 0.9em;">Save this group first to add exercises.</p>';
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
    if (currentEditingGroupId) {
        // Update
        payload.active = active;
        result = await apiCall(`/api/workout/groups/update?id=${currentEditingGroupId}`, 'PUT', payload);
    } else {
        // Create
        result = await apiCall('/api/workout/groups/create', 'POST', payload);
    }

    if (result || result === true) {
        closeWorkoutGroupModal();
        loadWorkoutGroups();
    }
}

async function deleteWorkoutGroup(groupId, event) {
    event.stopPropagation();

    if (confirm('Delete this workout group?')) {
        const result = await apiCall(`/api/workout/groups/delete?id=${groupId}`, 'DELETE');
        if (result || result === true) {
            loadWorkoutGroups();
        }
    }
}

// ====================================
// VARIANTS
// ====================================

async function loadVariantsForGroup(groupId) {
    currentGroupForVariant = groupId;
    const container = document.getElementById('workout-variants-list');

    try {
        const variants = await apiCall(`/api/workout/variants?group_id=${groupId}`);

        if (!variants || variants.length === 0) {
            container.innerHTML = '<p style="color: var(--hint-color); font-size: 0.9em;">No variants yet. Add one to get started!</p>';
            return;
        }

        let html = '';
        variants.forEach(variant => {
            const rotationText = variant.rotation_order !== null ? ` (Order: ${variant.rotation_order})` : '';
            html += `
                <div style="background: #f8f9fa; padding: 10px; border-radius: 6px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                    <div onclick="showEditVariantModal(${variant.id})" style="cursor: pointer; flex: 1;">
                        <strong>${escapeHtml(variant.name)}</strong>${rotationText}
                        ${variant.description ? `<div style="font-size: 0.85em; color: #666;">${escapeHtml(variant.description)}</div>` : ''}
                    </div>
                    <button class="delete-btn" onclick="deleteVariant(${variant.id}, event)" style="position: static; margin-left: 10px;">&times;</button>
                </div>
            `;
        });

        container.innerHTML = html;
    } catch (error) {
        console.error('Error loading variants:', error);
        container.innerHTML = '<p style="color: red;">Error loading variants</p>';
    }
}

function showAddVariantModal() {
    const groupId = currentGroupForVariant || currentEditingGroupId;
    if (!groupId) {
        safeAlert('Save this workout group first to add variants.');
        return;
    }

    currentGroupForVariant = groupId;

    currentEditingVariantId = null;
    document.getElementById('workout-variant-modal-title').textContent = 'Add Variant';
    window.ModalManager.workoutVariant.open();

    document.getElementById('workout-variant-name').value = '';
    document.getElementById('workout-variant-description').value = '';
    document.getElementById('workout-variant-rotation').value = '';

    // Show/hide rotation field based on group
    const group = workoutGroups.find(g => g.id === currentGroupForVariant);
    if (group && group.is_rotating) {
        document.getElementById('workout-variant-rotation-field').style.display = 'block';
    } else {
        document.getElementById('workout-variant-rotation-field').style.display = 'none';
    }

    document.getElementById('workout-exercises-section').style.display = 'none';
}

async function showEditVariantModal(variantId) {
    currentEditingVariantId = variantId;

    const variants = await apiCall(`/api/workout/variants?group_id=${currentGroupForVariant}`);
    const variant = variants.find(v => v.id === variantId);
    if (!variant) return;

    document.getElementById('workout-variant-modal-title').textContent = 'Edit Variant';
    window.ModalManager.workoutVariant.open();

    document.getElementById('workout-variant-name').value = variant.name;
    document.getElementById('workout-variant-description').value = variant.description || '';
    document.getElementById('workout-variant-rotation').value = variant.rotation_order !== null ? variant.rotation_order : '';

    const group = workoutGroups.find(g => g.id === currentGroupForVariant);
    if (group && group.is_rotating) {
        document.getElementById('workout-variant-rotation-field').style.display = 'block';
    } else {
        document.getElementById('workout-variant-rotation-field').style.display = 'none';
    }

    document.getElementById('workout-exercises-section').style.display = 'block';
    await loadExercisesForVariant(variantId);
}

function closeVariantModal() {
    window.ModalManager.workoutVariant.close();
    currentEditingVariantId = null;
}

async function saveVariant() {
    const name = document.getElementById('workout-variant-name').value.trim();
    const description = document.getElementById('workout-variant-description').value.trim();
    const rotationRaw = document.getElementById('workout-variant-rotation').value;
    const rotation = rotationRaw !== '' ? parseInt(rotationRaw) : null;

    if (!name) {
        safeAlert('Variant name is required!');
        return;
    }

    const payload = {
        group_id: currentGroupForVariant,
        name,
        rotation_order: rotation,
        description
    };

    let result;
    if (currentEditingVariantId) {
        // Update
        result = await apiCall(`/api/workout/variants/update?id=${currentEditingVariantId}`, 'PUT', payload);
    } else {
        result = await apiCall('/api/workout/variants/create', 'POST', payload);
    }

    if (result || result === true) {
        closeVariantModal();
        loadVariantsForGroup(currentGroupForVariant);
    }
}

async function deleteVariant(variantId, event) {
    event.stopPropagation();
    if (confirm('Delete this variant and all its exercises?')) {
        const result = await apiCall(`/api/workout/variants/delete?id=${variantId}`, 'DELETE');
        if (result || result === true) {
            loadVariantsForGroup(currentGroupForVariant);
        }
    }
}

// ====================================
// EXERCISES
// ====================================

let currentExercisesContainerId = 'workout-exercises-list';

async function loadExercisesForVariant(variantId, containerId = 'workout-exercises-list') {
    currentVariantForExercise = variantId;
    currentExercisesContainerId = containerId;
    const container = document.getElementById(containerId);

    try {
        const exercises = await apiCall(`/api/workout/exercises?variant_id=${variantId}`);

        if (!exercises || exercises.length === 0) {
            container.innerHTML = '<p style="color: var(--hint-color); font-size: 0.9em;">No exercises yet. Add one!</p>';
            return;
        }

        // Sort by order
        exercises.sort((a, b) => a.order_index - b.order_index);

        let html = '';
        exercises.forEach(ex => {
            const repsText = ex.target_reps_max
                ? `${ex.target_reps_min}-${ex.target_reps_max}`
                : `${ex.target_reps_min}`;
            const weightText = ex.target_weight_kg ? ` @ ${ex.target_weight_kg}kg` : '';

            html += `
                <div style="background: #f0f4ff; padding: 8px 10px; border-radius: 6px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
                    <div onclick="showEditExerciseModal(${ex.id})" style="cursor: pointer; flex: 1;">
                        <strong>${ex.order_index + 1}. ${escapeHtml(ex.exercise_name)}</strong>
                        <div style="font-size: 0.85em; color: #666;">
                            ${ex.target_sets} sets × ${repsText} reps${weightText}
                        </div>
                    </div>
                    <button class="delete-btn" onclick="deleteExercise(${ex.id}, event)" style="position: static; margin-left: 10px;">&times;</button>
                </div>
            `;
        });

        container.innerHTML = html;
    } catch (error) {
        console.error('Error loading exercises:', error);
        container.innerHTML = '<p style="color: red;">Error loading exercises</p>';
    }
}

async function resolveVariantForExercise() {
    if (currentVariantForExercise) return true;

    const groupId = currentGroupForVariant || currentEditingGroupId;
    if (!groupId) {
        safeAlert('Save this workout group first to add exercises.');
        return false;
    }

    const group = workoutGroups.find(g => g.id === groupId);
    if (group && group.is_rotating) {
        safeAlert('Open a variant first to add exercises.');
        return false;
    }

    try {
        let variants = await apiCall(`/api/workout/variants?group_id=${groupId}`);
        if (!variants || variants.length === 0) {
            const createdVariant = await apiCall('/api/workout/variants/create', 'POST', {
                group_id: groupId,
                name: 'Main',
                rotation_order: null,
                description: ''
            });
            variants = createdVariant ? [createdVariant] : [];
        }

        const variantId = variants[0]?.id;
        if (!variantId) {
            safeAlert('Save this workout group first to add exercises.');
            return false;
        }

        currentGroupForVariant = groupId;
        currentVariantForExercise = variantId;
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

    currentEditingExerciseId = null;
    document.getElementById('workout-exercise-modal-title').textContent = 'Add Exercise';
    window.ModalManager.workoutExercise.open();

    document.getElementById('workout-exercise-name').value = '';
    document.getElementById('workout-exercise-sets').value = '';
    document.getElementById('workout-exercise-reps-min').value = '';
    document.getElementById('workout-exercise-reps-max').value = '';
    document.getElementById('workout-exercise-weight').value = '';
    document.getElementById('workout-exercise-order').value = '0';

    // Load exercise library for autocomplete
    let datalist = document.getElementById('exercise-library-datalist');
    if (!datalist) {
        datalist = document.createElement('datalist');
        datalist.id = 'exercise-library-datalist';
        document.body.appendChild(datalist);
        document.getElementById('workout-exercise-name').setAttribute('list', 'exercise-library-datalist');
    }
    datalist.innerHTML = '';

    try {
        const items = await apiCall('/api/workout/exercise-library');
        if (items && items.length > 0) {
            items.forEach(item => {
                const option = document.createElement('option');
                option.value = item.name;
                option.dataset.sets = item.default_sets || '';
                option.dataset.repsMin = item.default_reps_min || '';
                option.dataset.repsMax = item.default_reps_max || '';
                option.dataset.weight = item.default_weight_kg || '';
                datalist.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading exercise library for autocomplete:', error);
    }

    // Add change handler to pre-fill defaults from library
    const nameInput = document.getElementById('workout-exercise-name');
    nameInput.onchange = function() {
        const option = Array.from(datalist.options).find(o => o.value === nameInput.value);
        if (option) {
            if (!document.getElementById('workout-exercise-sets').value && option.dataset.sets)
                document.getElementById('workout-exercise-sets').value = option.dataset.sets;
            if (!document.getElementById('workout-exercise-reps-min').value && option.dataset.repsMin)
                document.getElementById('workout-exercise-reps-min').value = option.dataset.repsMin;
            if (!document.getElementById('workout-exercise-reps-max').value && option.dataset.repsMax)
                document.getElementById('workout-exercise-reps-max').value = option.dataset.repsMax;
            if (!document.getElementById('workout-exercise-weight').value && option.dataset.weight)
                document.getElementById('workout-exercise-weight').value = option.dataset.weight;
        }
    };
}

async function showAddExerciseModalFromGroup() {
    // It's the same modal, we just use the default variant already set in currentVariantForExercise
    await showAddExerciseModal();
}

async function showEditExerciseModal(exerciseId) {
    currentEditingExerciseId = exerciseId;

    const exercises = await apiCall(`/api/workout/exercises?variant_id=${currentVariantForExercise}`);
    const exercise = exercises.find(e => e.id === exerciseId);
    if (!exercise) return;

    document.getElementById('workout-exercise-modal-title').textContent = 'Edit Exercise';
    window.ModalManager.workoutExercise.open();

    document.getElementById('workout-exercise-name').value = exercise.exercise_name;
    document.getElementById('workout-exercise-sets').value = exercise.target_sets;
    document.getElementById('workout-exercise-reps-min').value = exercise.target_reps_min;
    document.getElementById('workout-exercise-reps-max').value = exercise.target_reps_max || '';
    document.getElementById('workout-exercise-weight').value = exercise.target_weight_kg || '';
    document.getElementById('workout-exercise-order').value = exercise.order_index;
}

function closeExerciseModal() {
    window.ModalManager.workoutExercise.close();
    currentEditingExerciseId = null;
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

    const payload = {
        variant_id: currentVariantForExercise,
        exercise_name: name,
        target_sets: sets,
        target_reps_min: repsMin,
        target_reps_max: repsMax,
        target_weight_kg: weight,
        order_index: order
    };

    let result;
    if (currentEditingExerciseId) {
        result = await apiCall(`/api/workout/exercises/update?id=${currentEditingExerciseId}`, 'PUT', payload);
    } else {
        result = await apiCall('/api/workout/exercises/create', 'POST', payload);
    }

    if (result || result === true) {
        closeExerciseModal();
        loadExercisesForVariant(currentVariantForExercise, currentExercisesContainerId);
    }
}

async function deleteExercise(exerciseId, event) {
    event.stopPropagation();
    if (confirm('Delete this exercise?')) {
        const result = await apiCall(`/api/workout/exercises/delete?id=${exerciseId}`, 'DELETE');
        if (result || result === true) {
            loadExercisesForVariant(currentVariantForExercise, currentExercisesContainerId);
        }
    }
}

// ====================================
// EXERCISE LIBRARY
// ====================================

let currentEditingLibraryItemId = null;

async function loadExerciseLibrary() {
    const container = document.getElementById('exercise-library-list');
    await window.DataStore.loadSWR({
        key: 'exercise_library',
        tags: ['exercise_library'],
        fetcher: async () => await apiCall('/api/workout/exercise-library'),
        onCached: async (cached) => {
            _renderExerciseLibrary(container, cached);
        },
        onFresh: async (fresh) => {
            _renderExerciseLibrary(container, fresh);
        },
        onError: async (error, cached) => {
            console.error('Error loading exercise library:', error);
            if (!cached) container.innerHTML = '<p style="color: red;">Error loading exercise library</p>';
        }
    });
}

function _renderExerciseLibrary(container, items) {
    if (!items || items.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--hint-color);">No exercises in library yet. Add your first exercise!</p>';
        return;
    }

    let html = '<div class="exercise-library-items">';
    for (const item of items) {
        const repsStr = item.default_reps_max
            ? `${item.default_reps_min}-${item.default_reps_max}`
            : `${item.default_reps_min}`;
        const weightStr = item.default_weight_kg ? ` @ ${item.default_weight_kg}kg` : '';
        const notesStr = item.notes ? `<div style="font-size: 0.85em; color: var(--hint-color); margin-top: 2px;">${_escapeHtml(item.notes)}</div>` : '';

        html += `
            <div class="exercise-library-item" onclick="showEditExerciseLibraryModal(${item.id})" style="cursor: pointer;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <strong>${_escapeHtml(item.name)}</strong>
                        <div style="font-size: 0.9em; color: var(--hint-color);">
                            ${item.default_sets} sets x ${repsStr} reps${weightStr}
                        </div>
                        ${notesStr}
                    </div>
                    <button onclick="deleteExerciseLibraryItem(${item.id}, event)" class="secondary" style="padding: 4px 8px; font-size: 0.85em;">Delete</button>
                </div>
            </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
}

function _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showExerciseLibraryModal(id) {
    currentEditingLibraryItemId = null;
    document.getElementById('exercise-library-modal-title').textContent = 'Add Exercise';
    window.ModalManager.exerciseLibrary.open();

    document.getElementById('exercise-library-name').value = '';
    document.getElementById('exercise-library-sets').value = '';
    document.getElementById('exercise-library-reps-min').value = '';
    document.getElementById('exercise-library-reps-max').value = '';
    document.getElementById('exercise-library-weight').value = '';
    document.getElementById('exercise-library-notes').value = '';
}

async function showEditExerciseLibraryModal(id) {
    const items = await apiCall('/api/workout/exercise-library');
    const item = items && items.find(i => i.id === id);
    if (!item) return;

    currentEditingLibraryItemId = id;
    document.getElementById('exercise-library-modal-title').textContent = 'Edit Exercise';
    window.ModalManager.exerciseLibrary.open();

    document.getElementById('exercise-library-name').value = item.name;
    document.getElementById('exercise-library-sets').value = item.default_sets || '';
    document.getElementById('exercise-library-reps-min').value = item.default_reps_min || '';
    document.getElementById('exercise-library-reps-max').value = item.default_reps_max || '';
    document.getElementById('exercise-library-weight').value = item.default_weight_kg || '';
    document.getElementById('exercise-library-notes').value = item.notes || '';
}

function closeExerciseLibraryModal() {
    window.ModalManager.exerciseLibrary.close();
    currentEditingLibraryItemId = null;
}

async function saveExerciseLibraryItem() {
    const name = document.getElementById('exercise-library-name').value.trim();
    const sets = parseInt(document.getElementById('exercise-library-sets').value) || 0;
    const repsMin = parseInt(document.getElementById('exercise-library-reps-min').value) || 0;
    const repsMaxRaw = document.getElementById('exercise-library-reps-max').value;
    const repsMax = repsMaxRaw !== '' ? parseInt(repsMaxRaw) : null;
    const weightRaw = document.getElementById('exercise-library-weight').value;
    const weight = weightRaw !== '' ? parseFloat(weightRaw) : null;
    const notes = document.getElementById('exercise-library-notes').value.trim();

    if (!name) {
        safeAlert('Exercise name is required!');
        return;
    }

    const payload = {
        name: name,
        default_sets: sets,
        default_reps_min: repsMin,
        default_reps_max: repsMax,
        default_weight_kg: weight,
        notes: notes
    };

    let result;
    if (currentEditingLibraryItemId) {
        result = await apiCall(`/api/workout/exercise-library/update?id=${currentEditingLibraryItemId}`, 'PUT', payload);
    } else {
        result = await apiCall('/api/workout/exercise-library/create', 'POST', payload);
    }

    if (result || result === true) {
        closeExerciseLibraryModal();
        loadExerciseLibrary();
    }
}

async function deleteExerciseLibraryItem(id, event) {
    event.stopPropagation();
    if (confirm('Delete this exercise from library?')) {
        const result = await apiCall(`/api/workout/exercise-library/delete?id=${id}`, 'DELETE');
        if (result || result === true) {
            loadExerciseLibrary();
        }
    }
}

// ====================================
// HISTORY & STATS TABS
// ====================================

async function loadWorkoutHistoryTab() {
    const container = document.getElementById('workout-history-display');
    await window.DataStore.loadSWR({
        key: 'workout_history',
        tags: ['workout'],
        fetcher: async () => await apiCall('/api/workout/sessions?limit=30'),
        onCached: async (cached) => {
            _renderWorkoutHistory(container, cached);
        },
        onFresh: async (response) => {
            if (response && window.MedTrackerDB?.WorkoutStore) {
                await window.MedTrackerDB.WorkoutStore.saveCache('sessions', response);
            }
            _renderWorkoutHistory(container, response);
        },
        onError: async (error, cached) => {
            console.error('Error loading history:', error);
            if (!cached) container.innerHTML = '<p style="color: red;">Error loading history</p>';
        }
    });
}

function _renderWorkoutHistory(container, response) {
    if (!response || response.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--hint-color); padding: 40px;">No workout history yet</p>';
        return;
    }

    const finalSessions = response.filter(s => s.session.status === 'completed' || s.session.status === 'skipped');

    if (finalSessions.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--hint-color); padding: 40px;">No workout history yet</p>';
        return;
    }

    let html = '<div style="display: flex; flex-direction: column; gap: 10px;">';
    finalSessions.forEach(s => {
        const statusEmoji = {
            'completed': '✅',
            'skipped': '⏭'
        }[s.session.status] || '⏰';

        const date = new Date(s.session.scheduled_date).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });

        const volumeText = s.total_volume > 0
            ? `${Math.round(s.total_volume).toLocaleString()} kg total`
            : '';

        html += `
                <div onclick="showWorkoutSessionModal(${s.session.id})" style="background: #f8f9fa; padding: 12px; border-radius: 8px; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#f0f0f0'" onmouseout="this.style.background='#f8f9fa'">
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div>
                            <strong>${statusEmoji} ${escapeHtml(s.group_name)}</strong> - ${escapeHtml(s.variant_name)}
                            <div style="font-size: 0.85em; color: #666; margin-top: 4px;">
                                ${date} at ${s.session.started_at ? new Date(s.session.started_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : s.session.scheduled_time}
                                ${s.session.status === 'completed' ? ` • ${s.exercises_completed}/${s.exercises_count} exercises` : ''}
                                ${volumeText ? `<br><strong style="color: #667eea;">${volumeText}</strong>` : ''}
                            </div>
                        </div>
                        <div style="text-align: right; font-size: 0.85em; color: #667eea; display: flex; align-items: center; gap: 4px;">
                            ${s.session.status} <span style="font-size: 1.2em;">›</span>
                        </div>
                    </div>
                </div>
            `;
    });
    html += '</div>';

    container.innerHTML = html;
}

let currentSessionLogs = [];
let currentSessionData = null;
let originalSessionStatus = null;

async function showWorkoutSessionModal(sessionId) {
    const logsContainer = document.getElementById('workout-session-logs');
    const infoContainer = document.getElementById('workout-session-info');
    const overlay = document.getElementById('modal-overlay');

    try {
        const data = await apiCall(`/api/workout/sessions/details?id=${sessionId}`);
        if (!data) return;

        currentSessionLogs = data.logs || [];
        currentSessionData = data.session;
        originalSessionStatus = data.session.status;

        if (currentSessionData && currentSessionData.variant_id > 0) {
            try {
                const plannedExercises = await apiCall(`/api/workout/exercises?variant_id=${currentSessionData.variant_id}`);
                if (Array.isArray(plannedExercises) && plannedExercises.length > 0) {
                    const existingByExerciseID = new Map();
                    currentSessionLogs.forEach(log => {
                        if (log.exercise_id && !existingByExerciseID.has(log.exercise_id)) {
                            existingByExerciseID.set(log.exercise_id, true);
                        }
                    });

                    const plannedMissingLogs = plannedExercises
                        .filter(ex => !existingByExerciseID.has(ex.id))
                        .map(ex => ({
                            id: 0,
                            exercise_id: ex.id,
                            exercise_name: ex.exercise_name,
                            sets_completed: ex.target_sets || 0,
                            reps_completed: ex.target_reps_min || 0,
                            weight_kg: ex.target_weight_kg || 0,
                            notes: '',
                            status: 'completed',
                            _dirty: false  // NOT saved unless user actually edits
                        }));

                    currentSessionLogs = [...currentSessionLogs, ...plannedMissingLogs];
                }
            } catch (prefillError) {
                console.error('Error pre-filling planned exercises:', prefillError);
            }
        }

        // Build info section with status dropdown
        const statusOptions = [
            { value: 'in_progress', label: '🏋️ In Progress' },
            { value: 'completed', label: '✅ Completed' },
            { value: 'skipped', label: '⏭ Skipped' }
        ];

        const statusDropdown = statusOptions.map(opt =>
            `<option value="${opt.value}" ${data.session.status === opt.value ? 'selected' : ''}>${opt.label}</option>`
        ).join('');

        infoContainer.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <div>
                    <strong>${data.session.started_at ? new Date(data.session.started_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : escapeHtml(data.session.scheduled_time)}</strong> •
                    ${new Date(data.session.scheduled_date).toLocaleDateString()}
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <label style="font-size: 0.9em; color: #666; margin: 0;">Status:</label>
                    <select id="session-status-select" style="padding: 4px 8px; border-radius: 4px; border: 1px solid #ddd;">
                        ${statusDropdown}
                    </select>
                </div>
            </div>
        `;

        let html = '';
        currentSessionLogs.forEach((log, index) => {
            const isUnsaved = !log.id || log.id === 0;
            const dimStyle = isUnsaved && !log._dirty ? 'opacity: 0.6;' : '';
            html += `
                <div class="exercise-log-entry" id="exercise-log-${index}" style="position: relative; ${dimStyle}">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <h4 style="margin: 0;">${escapeHtml(log.exercise_name)}</h4>
                        <button onclick="deleteExerciseLog(${index})" title="Remove exercise" style="background: none; border: none; cursor: pointer; font-size: 1.2em; padding: 4px 8px; color: #c62828;">🗑️</button>
                    </div>
                    ${isUnsaved && !log._dirty ? '<div style="font-size: 0.75em; color: #888; margin-bottom: 4px;">Not yet logged — edit to include</div>' : ''}
                    <div class="log-input-row">
                        <div class="log-input-group">
                            <label>Sets</label>
                            <input type="number" min="0" max="20" step="1" value="${log.sets_completed || 0}" onchange="updateLocalLog(${index}, 'sets_completed', this.value)" inputmode="numeric">
                        </div>
                        <div class="log-input-group">
                            <label>Reps</label>
                            <input type="number" min="0" max="100" step="1" value="${log.reps_completed || 0}" onchange="updateLocalLog(${index}, 'reps_completed', this.value)" inputmode="numeric">
                        </div>
                        <div class="log-input-group">
                            <label>Weight (kg)</label>
                            <input type="number" min="0" max="500" step="0.5" value="${log.weight_kg || 0}" onchange="updateLocalLog(${index}, 'weight_kg', this.value)" inputmode="decimal">
                        </div>
                    </div>
                    <div class="log-input-group">
                        <label>Notes</label>
                        <input type="text" value="${escapeHtml(log.notes || '')}" onchange="updateLocalLog(${index}, 'notes', this.value)" placeholder="Add notes..." maxlength="200">
                    </div>
                </div>
            `;
        });

        logsContainer.innerHTML = html || '<p style="text-align: center; color: #888;">No exercises logged</p>';

        window.ModalManager.workoutSession.open();

        // Add click handler to overlay to close modal
        overlay.onclick = function (e) {
            if (e.target === overlay) {
                closeWorkoutSessionModal();
            }
        };
    } catch (error) {
        console.error('Error loading session details:', error);
        safeAlert('Error loading session details');
    }
}

function updateLocalLog(index, field, value) {
    if (field === 'notes') {
        currentSessionLogs[index][field] = value;
    } else if (field === 'sets_completed' || field === 'reps_completed') {
        // Sets and reps must be integers
        currentSessionLogs[index][field] = Math.max(0, Math.round(parseFloat(value) || 0));
    } else {
        // Weight can be decimal
        currentSessionLogs[index][field] = Math.max(0, parseFloat(value) || 0);
    }
    // Mark as dirty so it gets saved
    currentSessionLogs[index]._dirty = true;
    // Update visual state — remove dim styling
    const el = document.getElementById(`exercise-log-${index}`);
    if (el) {
        el.style.opacity = '1';
        const hint = el.querySelector('div[style*="Not yet logged"]');
        if (hint) hint.remove();
    }
}

async function deleteExerciseLog(index) {
    const log = currentSessionLogs[index];
    if (!log) return;

    if (!confirm(`Remove ${log.exercise_name} from this workout?`)) return;

    // If it has an ID (already saved in DB), delete from backend
    if (log.id && log.id > 0) {
        try {
            await apiCall(`/api/workout/sessions/logs/delete?id=${log.id}`, 'DELETE');
        } catch (error) {
            console.error('Error deleting exercise log:', error);
            safeAlert('Failed to delete exercise log');
            return;
        }
    }

    // Remove from local array and re-render
    currentSessionLogs.splice(index, 1);
    // Re-render the logs in the modal
    const logsContainer = document.getElementById('workout-session-logs');
    let html = '';
    currentSessionLogs.forEach((log, i) => {
        const isUnsaved = !log.id || log.id === 0;
        const dimStyle = isUnsaved && !log._dirty ? 'opacity: 0.6;' : '';
        html += `
            <div class="exercise-log-entry" id="exercise-log-${i}" style="position: relative; ${dimStyle}">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <h4 style="margin: 0;">${escapeHtml(log.exercise_name)}</h4>
                    <button onclick="deleteExerciseLog(${i})" title="Remove exercise" style="background: none; border: none; cursor: pointer; font-size: 1.2em; padding: 4px 8px; color: #c62828;">🗑️</button>
                </div>
                ${isUnsaved && !log._dirty ? '<div style="font-size: 0.75em; color: #888; margin-bottom: 4px;">Not yet logged — edit to include</div>' : ''}
                <div class="log-input-row">
                    <div class="log-input-group">
                        <label>Sets</label>
                        <input type="number" min="0" max="20" step="1" value="${log.sets_completed || 0}" onchange="updateLocalLog(${i}, 'sets_completed', this.value)" inputmode="numeric">
                    </div>
                    <div class="log-input-group">
                        <label>Reps</label>
                        <input type="number" min="0" max="100" step="1" value="${log.reps_completed || 0}" onchange="updateLocalLog(${i}, 'reps_completed', this.value)" inputmode="numeric">
                    </div>
                    <div class="log-input-group">
                        <label>Weight (kg)</label>
                        <input type="number" min="0" max="500" step="0.5" value="${log.weight_kg || 0}" onchange="updateLocalLog(${i}, 'weight_kg', this.value)" inputmode="decimal">
                    </div>
                </div>
                <div class="log-input-group">
                    <label>Notes</label>
                    <input type="text" value="${escapeHtml(log.notes || '')}" onchange="updateLocalLog(${i}, 'notes', this.value)" placeholder="Add notes..." maxlength="200">
                </div>
            </div>
        `;
    });
    logsContainer.innerHTML = html || '<p style="text-align: center; color: #888;">No exercises logged</p>';
}

function closeWorkoutSessionModal() {
    const overlay = document.getElementById('modal-overlay');
    overlay.onclick = null; // Remove click handler
    window.ModalManager.workoutSession.close();
    currentSessionData = null;
    originalSessionStatus = null;
}

async function saveWorkoutSessionDetails() {
    const saveButton = document.querySelector('#workout-session-modal .actions .primary');
    const originalText = saveButton.textContent;

    try {
        // Disable button and show loading state
        saveButton.disabled = true;
        saveButton.textContent = 'Saving...';
        saveButton.style.opacity = '0.6';

        // Check if status has changed
        const statusSelect = document.getElementById('session-status-select');
        const newStatus = statusSelect ? statusSelect.value : originalSessionStatus;
        const statusChanged = newStatus !== originalSessionStatus;

        // Validate all logs before saving
        for (const log of currentSessionLogs) {
            if (log.sets_completed < 0 || log.reps_completed < 0 || log.weight_kg < 0) {
                throw new Error('Values cannot be negative');
            }
            if (log.sets_completed > 20 || log.reps_completed > 100 || log.weight_kg > 500) {
                throw new Error('Values exceed maximum allowed');
            }
        }

        // Save status if changed
        if (statusChanged && currentSessionData) {
            await apiCall(`/api/workout/sessions/status?id=${currentSessionData.id}`, 'PUT', {
                status: newStatus
            });
        }

        // Save each log — only save new entries that the user actually edited (_dirty)
        for (const log of currentSessionLogs) {
            if (log.id && log.id > 0) {
                // Existing log — always update
                await apiCall('/api/workout/sessions/logs/update', 'POST', {
                    id: log.id,
                    sets_completed: Math.round(log.sets_completed),
                    reps_completed: Math.round(log.reps_completed),
                    weight_kg: parseFloat(log.weight_kg),
                    notes: log.notes || ''
                });
            } else if (log._dirty) {
                // New log that user actually edited — create it
                await apiCall('/api/workout/sessions/logs/create', 'POST', {
                    session_id: currentSessionData.id,
                    exercise_id: log.exercise_id,
                    exercise_name: log.exercise_name,
                    target_sets: Math.round(log.sets_completed),
                    target_reps_min: Math.round(log.reps_completed),
                    target_weight_kg: parseFloat(log.weight_kg),
                    status: 'completed',
                    notes: log.notes || ''
                });
            }
            // Skip: id===0 && !_dirty — pre-filled but untouched, don't save
        }

        closeWorkoutSessionModal();
        loadWorkoutHistoryTab();
    } catch (error) {
        console.error('Error saving workout details:', error);
        const message = error.message || 'Error saving workout details. Please try again.';
        safeAlert('❌ ' + message);
    } finally {
        // Re-enable button
        saveButton.disabled = false;
        saveButton.textContent = originalText;
        saveButton.style.opacity = '1';
    }
}

async function loadWorkoutStatsTab() {
    const container = document.getElementById('workout-stats-display');
    await window.DataStore.loadSWR({
        key: 'workout_stats',
        tags: ['workout'],
        fetcher: async () => await apiCall('/api/workout/stats'),
        onCached: async (cached) => {
            _renderWorkoutStats(container, cached);
        },
        onFresh: async (stats) => {
            _renderWorkoutStats(container, stats);
        },
        onError: async (error, cached) => {
            console.error('Error loading stats:', error);
            if (!cached) container.innerHTML = '<p style="color: red;">Error loading statistics</p>';
        }
    });
}

function _renderWorkoutStats(container, stats) {
    if (!stats) {
        container.innerHTML = '<p style="text-align: center; color: var(--hint-color);">No statistics available yet</p>';
        return;
    }

    const formatVolume = (kg) => {
        if (!kg || kg === 0) return '—';
        if (kg >= 1000) return `${(kg / 1000).toFixed(1)}t`;
        return `${Math.round(kg).toLocaleString()} kg`;
    };

    // Top exercises section
    let topExercisesHtml = '';
    if (stats.top_exercises && stats.top_exercises.length > 0) {
        const maxVol = stats.top_exercises[0].total_volume_kg || 1;
        const medals = ['🥇', '🥈', '🥉'];
        topExercisesHtml = `
                <div style="margin-top: 20px;">
                    <div style="font-size: 0.75em; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--hint-color); margin-bottom: 10px;">Top Exercises · Volume</div>
                    ${stats.top_exercises.map((ex, i) => {
            const pct = maxVol > 0 ? (ex.total_volume_kg / maxVol * 100).toFixed(1) : 0;
            const medal = medals[i] || `${i + 1}.`;
            const maxW = ex.max_weight_kg > 0 ? `${ex.max_weight_kg} kg max` : '';
            return `
                            <div style="margin-bottom: 10px;">
                                <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;">
                                    <span style="font-size: 0.9em; font-weight: 500;">${medal} ${ex.exercise_name}</span>
                                    <span style="font-size: 0.8em; color: var(--hint-color);">${formatVolume(ex.total_volume_kg)}${maxW ? ' · ' + maxW : ''}</span>
                                </div>
                                <div style="background: var(--secondary-bg-color, rgba(0,0,0,0.07)); border-radius: 4px; height: 5px; overflow: hidden;">
                                    <div style="background: linear-gradient(90deg, #667eea, #764ba2); width: ${pct}%; height: 100%; border-radius: 4px; transition: width 0.4s;"></div>
                                </div>
                            </div>`;
        }).join('')}
                </div>`;
    }

    // 12-week heatmap
    let heatmapHtml = '';
    if (stats.weekly_activity && stats.weekly_activity.length > 0) {
        const squares = stats.weekly_activity.map(w => {
            const total = w.completed + w.skipped;
            let bg;
            if (total === 0) bg = 'var(--secondary-bg-color, #e8e8e8)';
            else if (w.completed === 0) bg = '#e05c5c';
            else if (w.completed >= total) bg = '#28a745';
            else if (w.completed / total >= 0.5) bg = '#85c17e';
            else bg = '#ffc107';

            const d = new Date(w.week + 'T00:00:00');
            const label = d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
            return `<div title="${label}: ${w.completed} done, ${w.skipped} skipped"
                             style="width: 26px; height: 26px; border-radius: 4px; background: ${bg}; flex-shrink: 0;"></div>`;
        }).join('');

        heatmapHtml = `
                <div style="margin-top: 20px;">
                    <div style="font-size: 0.75em; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--hint-color); margin-bottom: 10px;">12-Week Activity</div>
                    <div style="display: flex; flex-wrap: wrap; gap: 4px;">${squares}</div>
                    <div style="display: flex; gap: 12px; margin-top: 8px; font-size: 0.72em; color: var(--hint-color);">
                        <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#28a745;vertical-align:middle;margin-right:3px;"></span>All done</span>
                        <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#85c17e;vertical-align:middle;margin-right:3px;"></span>Partial</span>
                        <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#e05c5c;vertical-align:middle;margin-right:3px;"></span>Skipped</span>
                    </div>
                </div>`;
    }

    container.innerHTML = `
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 12px;">
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 18px 8px; border-radius: 12px; text-align: center;">
                    <div style="font-size: 2.4em; font-weight: bold; line-height: 1.1;">${stats.current_streak}</div>
                    <div style="font-size: 0.78em; opacity: 0.92; margin-top: 5px;">🔥 Streak</div>
                </div>
                <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 18px 8px; border-radius: 12px; text-align: center;">
                    <div style="font-size: 2.4em; font-weight: bold; line-height: 1.1;">${stats.longest_streak}</div>
                    <div style="font-size: 0.78em; opacity: 0.92; margin-top: 5px;">🏆 Best</div>
                </div>
                <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); color: white; padding: 18px 8px; border-radius: 12px; text-align: center;">
                    <div style="font-size: 2.4em; font-weight: bold; line-height: 1.1;">${Math.round(stats.completion_rate)}%</div>
                    <div style="font-size: 0.78em; opacity: 0.92; margin-top: 5px;">💪 30-Day</div>
                </div>
            </div>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;">
                <div style="background: var(--secondary-bg-color, #f0fff4); padding: 14px 8px; border-radius: 8px; text-align: center; border: 1.5px solid #28a745;">
                    <div style="font-size: 1.7em; font-weight: bold; color: #28a745;">${stats.completed_sessions}</div>
                    <div style="font-size: 0.78em; color: var(--hint-color); margin-top: 2px;">Done</div>
                </div>
                <div style="background: var(--secondary-bg-color, #fffbf0); padding: 14px 8px; border-radius: 8px; text-align: center; border: 1.5px solid #ffc107;">
                    <div style="font-size: 1.7em; font-weight: bold; color: #ffc107;">${stats.skipped_sessions}</div>
                    <div style="font-size: 0.78em; color: var(--hint-color); margin-top: 2px;">Skipped</div>
                </div>
                <div style="background: var(--secondary-bg-color, #f5f0ff); padding: 14px 8px; border-radius: 8px; text-align: center; border: 1.5px solid #764ba2;">
                    <div style="font-size: 1.7em; font-weight: bold; color: #764ba2;">${formatVolume(stats.total_volume_kg)}</div>
                    <div style="font-size: 0.78em; color: var(--hint-color); margin-top: 2px;">Lifted</div>
                </div>
            </div>
            ${topExercisesHtml}
            ${heatmapHtml}
        `;
}

// ====================================
// START WORKOUT SESSION
// ====================================

// ====================================
// AD-HOC WORKOUT
// ====================================

async function startAdHocWorkout() {
    try {
        // Create ad-hoc workout session via API
        const result = await apiCall('/api/workout/sessions/adhoc', 'POST');

        if (result && result.session) {
            // Immediately open the session modal to start logging exercises
            await showWorkoutSessionModal(result.session.id);

            // Refresh the next workout card
            await loadNextWorkout();
        } else {
            safeAlert('Failed to start ad-hoc workout');
        }
    } catch (error) {
        console.error('Error starting ad-hoc workout:', error);
        safeAlert('Error starting ad-hoc workout: ' + error.message);
    }
}

// ====================================
// WORKOUT SESSION MANAGEMENT
// ====================================

async function startWorkoutSession(sessionId) {
    if (!confirm('Start this workout now?')) {
        return;
    }

    try {
        await apiCall(`/api/workout/sessions/${sessionId}/start`, 'POST');

        // Show success message
        safeAlert('✅ Workout started! You can now log exercises.');

        // Refresh the next workout card
        loadNextWorkout();

        // Optionally open the session details to log exercises

    } catch (error) {
        console.error('Error starting workout:', error);
        safeAlert('❌ Failed to start workout. Please try again.');
    }
}

async function cancelWorkoutSession(sessionId) {
    if (confirm('Finish this workout now? It will be marked as completed.')) {
        try {
            await apiCall(`/api/workout/sessions/status?id=${sessionId}`, 'PUT', { status: 'completed' });
            loadNextWorkout();
            loadWorkoutHistoryTab(); // Refresh history if visible
        } catch (e) {
            console.error(e);
            safeAlert('Failed to finish workout');
        }
    }
}

async function preSkipWorkoutSession(sessionId) {
    if (!confirm('Mark this workout as to-be-skipped? No notification will be sent and it will be automatically skipped at the scheduled time.')) {
        return;
    }

    try {
        await apiCall(`/api/workout/sessions/${sessionId}/preskip`, 'POST');
        loadNextWorkout();
    } catch (error) {
        console.error('Error pre-skipping workout:', error);
        safeAlert('❌ Failed to mark workout as skipped. Please try again.');
    }
}

async function cancelPreSkipWorkoutSession(sessionId) {
    try {
        await apiCall(`/api/workout/sessions/${sessionId}/cancel-preskip`, 'POST');
        loadNextWorkout();
    } catch (error) {
        console.error('Error cancelling pre-skip:', error);
        safeAlert('❌ Failed to cancel skip. Please try again.');
    }
}

// ====================================
// ADD EXERCISE TO SESSION
// ====================================

async function showAddExerciseToSessionModal() {
    if (!currentSessionData) return;

    // Reset fields
    document.getElementById('session-add-exercise-name').value = '';
    document.getElementById('session-add-exercise-id').value = '';
    document.getElementById('session-add-exercise-sets').value = '';
    document.getElementById('session-add-exercise-reps').value = '';
    document.getElementById('session-add-exercise-weight').value = '';
    document.getElementById('session-add-exercise-notes').value = '';

    // Load unique exercises
    const datalist = document.getElementById('unique-exercises-list');
    datalist.innerHTML = '';

    try {
        const exercises = await apiCall('/api/workout/exercise-library');
        if (exercises && exercises.length > 0) {
            exercises.forEach(ex => {
                const option = document.createElement('option');
                option.value = ex.name;
                option.dataset.id = ex.id;
                option.dataset.sets = ex.default_sets;
                option.dataset.reps = ex.default_reps_min;
                option.dataset.weight = ex.default_weight_kg || '';
                datalist.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading unique exercises:', error);
    }

    window.ModalManager.workoutAddExerciseToSession.open();

    // Ensure overlay closes this modal too
    const overlay = document.getElementById('modal-overlay');
    overlay.onclick = function (e) {
        if (e.target === overlay) {
            closeAddExerciseToSessionModal();
        }
    };
}

function closeAddExerciseToSessionModal() {
    window.ModalManager.workoutAddExerciseToSession.close();

    // Revert overlay onclick to close session modal
    const overlay = document.getElementById('modal-overlay');
    overlay.onclick = function (e) {
        if (e.target === overlay) {
            closeWorkoutSessionModal();
        }
    };
}

function onSessionExerciseSelect() {
    const input = document.getElementById('session-add-exercise-name');
    const datalist = document.getElementById('unique-exercises-list');
    const hiddenId = document.getElementById('session-add-exercise-id');

    const val = input.value;
    const option = Array.from(datalist.options).find(o => o.value === val);

    if (option) {
        hiddenId.value = option.dataset.id;
        // Autofill if empty
        if (!document.getElementById('session-add-exercise-sets').value)
            document.getElementById('session-add-exercise-sets').value = option.dataset.sets;
        if (!document.getElementById('session-add-exercise-reps').value)
            document.getElementById('session-add-exercise-reps').value = option.dataset.reps;
        if (!document.getElementById('session-add-exercise-weight').value && option.dataset.weight)
            document.getElementById('session-add-exercise-weight').value = option.dataset.weight;
    } else {
        hiddenId.value = '';
    }
}

async function saveNewSessionExercise() {
    if (!currentSessionData) return;

    const name = document.getElementById('session-add-exercise-name').value.trim();
    let exerciseId = document.getElementById('session-add-exercise-id').value;
    const sets = parseInt(document.getElementById('session-add-exercise-sets').value);
    const reps = parseInt(document.getElementById('session-add-exercise-reps').value);
    const weightRaw = document.getElementById('session-add-exercise-weight').value;
    const weight = weightRaw !== '' ? parseFloat(weightRaw) : null;
    const notes = document.getElementById('session-add-exercise-notes').value.trim();

    if (!name || !sets || !reps) {
        safeAlert('Name, sets, and reps are required');
        return;
    }

    if (!exerciseId) {
        // Try to find in datalist again
        const datalist = document.getElementById('unique-exercises-list');
        const option = Array.from(datalist.options).find(o => o.value === name);
        if (option) {
            exerciseId = option.dataset.id;
        } else {
            safeAlert('Please select an existing exercise from the list. Adding new unknown exercises to a session is not supported yet.');
            return;
        }
    }

    try {
        await apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: currentSessionData.id,
            exercise_id: parseInt(exerciseId),
            exercise_name: name,
            target_sets: sets,
            target_reps_min: reps,
            target_weight_kg: weight,
            status: 'completed',
            notes: notes
        });

        closeAddExerciseToSessionModal();
        // Refresh session modal
        showWorkoutSessionModal(currentSessionData.id);
    } catch (error) {
        console.error(error);
        safeAlert('Failed to add exercise');
    }
}
