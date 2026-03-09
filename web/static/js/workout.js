
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

let workoutControlsBound = false;

function bindWorkoutControls() {
    if (workoutControlsBound) return;
    workoutControlsBound = true;

    const bindClick = (id, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    };

    bindClick('start-adhoc-workout-btn', () => startAdHocWorkout());
    bindClick('add-workout-group-btn', () => showAddWorkoutGroupModal());
    bindClick('add-exercise-library-btn', () => showExerciseLibraryModal());

    bindClick('workout-group-cancel-btn', () => closeWorkoutGroupModal());
    bindClick('workout-group-save-btn', () => saveWorkoutGroup());
    bindClick('add-variant-btn', () => showAddVariantModal());
    bindClick('add-flat-exercise-btn', () => showAddExerciseModalFromGroup());

    bindClick('variant-cancel-btn', () => closeVariantModal());
    bindClick('variant-save-btn', () => saveVariant());
    bindClick('variant-add-exercise-btn', () => showAddExerciseModal());

    bindClick('exercise-cancel-btn', () => closeExerciseModal());
    bindClick('exercise-save-btn', () => saveExercise());

    bindClick('exercise-library-cancel-btn', () => closeExerciseLibraryModal());
    bindClick('exercise-library-save-btn', () => saveExerciseLibraryItem());

    bindClick('workout-session-delete-btn', () => deleteWorkoutSession());
    bindClick('workout-session-cancel-btn', () => closeWorkoutSessionModal());
    bindClick('workout-session-save-btn', () => saveWorkoutSessionDetails());
    bindClick('workout-session-add-exercise-btn', () => showAddExerciseToSessionModal());

    bindClick('session-add-exercise-cancel-btn', () => closeAddExerciseToSessionModal());
    bindClick('session-add-exercise-save-btn', () => saveNewSessionExercise());

    bindClick('miband-workout-cancel-btn', () => closeMiBandWorkoutModal());
    bindClick('miband-workout-save-btn', () => saveMiBandWorkout());
    bindClick('miband-workout-delete-btn', () => deleteMiBandWorkout());

    const rotatingCheckbox = document.getElementById('workout-group-rotating');
    if (rotatingCheckbox) {
        rotatingCheckbox.addEventListener('change', () => {
            toggleRotatingFields();
        });
    }

    document.querySelectorAll('#workout-group-modal .days-select span').forEach((day) => {
        day.addEventListener('click', () => {
            toggleWorkoutDay(day);
        });
    });

    const sessionExerciseName = document.getElementById('session-add-exercise-name');
    if (sessionExerciseName) {
        sessionExerciseName.addEventListener('change', () => {
            onSessionExerciseSelect();
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindWorkoutControls, { once: true });
}
bindWorkoutControls();

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
            if (!cached) container.replaceChildren();
        },
        allowNullFresh: true
    });
}

function _renderNextWorkout(container, data) {
    if (!data || !data.session) {
        container.replaceChildren();
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

    const variantId = data.variant_id || 0;
    const groupId = data.group_id || 0;
    const isRotating = data.is_rotating || false;

    const card = document.createElement('div');
    card.className = cardClass;

    const header = document.createElement('div');
    header.className = 'next-workout-header';

    const statusEl = document.createElement('div');
    statusEl.className = 'next-workout-status';
    statusEl.textContent = `${statusEmoji} ${statusText}`;

    const dateEl = document.createElement('div');
    dateEl.className = 'next-workout-date';
    dateEl.textContent = `${dateStr} at ${session.scheduled_time}`;

    header.appendChild(statusEl);
    header.appendChild(dateEl);
    card.appendChild(header);

    const info = document.createElement('div');
    info.className = 'next-workout-info';
    info.style.cursor = 'pointer';
    info.title = 'View/edit planned exercises';
    info.addEventListener('click', () => {
        openNextWorkoutEditModal(variantId, groupId);
    });

    const title = document.createElement('h3');
    title.textContent = data.group_name;
    const subtitle = document.createElement('p');
    subtitle.textContent = `${data.variant_name} • ${data.exercises_count} exercises ✏️`;
    info.appendChild(title);
    info.appendChild(subtitle);
    card.appendChild(info);

    const createButton = (label, className, onClick, styles = {}) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        Object.assign(button.style, styles);
        button.addEventListener('click', () => {
            onClick(session.id);
        });
        return button;
    };

    if (status === 'in_progress') {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '10px';
        row.style.marginTop = '12px';
        row.appendChild(createButton('🏋️ Continue', 'btn-pill', showWorkoutSessionModal, { flex: '1' }));
        row.appendChild(createButton('🛑 Stop', 'btn-pill', cancelWorkoutSession, {
            flex: '1',
            backgroundColor: '#ffebee',
            color: '#c62828',
            border: '1px solid #ef9a9a'
        }));
        card.appendChild(row);
    } else if (status === 'pre_skipped') {
        card.appendChild(createButton('↩ Cancel Skip', 'btn-pill', cancelPreSkipWorkoutSession, {
            marginTop: '12px',
            width: '100%',
            backgroundColor: 'var(--button-color, #5288c1)',
            color: 'white'
        }));
        if (isRotating) {
            card.appendChild(createButton('↻ Next Variant', 'btn-pill', nextWorkoutVariant, {
                marginTop: '8px',
                width: '100%',
                backgroundColor: 'var(--secondary-bg-color, #f0f0f0)',
                color: 'var(--text-color, #000)',
                boxShadow: 'none'
            }));
        }
    } else {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '10px';
        row.style.marginTop = '12px';
        row.appendChild(createButton('🏋️ Start Workout', 'btn-pill', startWorkoutSession, { flex: '1' }));
        row.appendChild(createButton('⏭ Skip', 'btn-pill', preSkipWorkoutSession, {
            flex: '1',
            backgroundColor: '#fff3e0',
            color: '#e65100',
            border: '1px solid #ffcc80'
        }));
        card.appendChild(row);
        if (isRotating) {
            card.appendChild(createButton('↻ Next Variant', 'btn-pill', nextWorkoutVariant, {
                marginTop: '8px',
                width: '100%',
                backgroundColor: 'var(--secondary-bg-color, #f0f0f0)',
                color: 'var(--text-color, #000)',
                boxShadow: 'none'
            }));
        }
    }

    container.replaceChildren(card);
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
            if (!cached) {
                const message = document.createElement('p');
                message.style.color = 'red';
                message.textContent = 'Error loading workout groups';
                container.replaceChildren(message);
            }
        }
    });
}

function _renderWorkoutGroups(container, groups) {
    if (!container) return;
    const doc = container.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function') return;
    workoutGroups = groups || [];

    if (!groups || groups.length === 0) {
        const empty = doc.createElement('p');
        empty.style.textAlign = 'center';
        empty.style.color = 'var(--hint-color)';
        empty.style.padding = '40px';
        empty.textContent = 'No workout groups yet. Click "+ Add Workout Group" to get started!';
        container.replaceChildren(empty);
        return;
    }

    container.replaceChildren();
    groups.forEach((group) => {
        let daysArray = [];
        try {
            daysArray = JSON.parse(group.days_of_week || '[]');
        } catch (e) {
            console.error('Error parsing days_of_week:', e);
            daysArray = [];
        }
        const daysMap = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const daysText = daysArray.map((day) => daysMap[day]).join(', ');

        const card = doc.createElement('div');
        card.className = 'med-item';
        card.style.marginBottom = '15px';

        const info = doc.createElement('div');
        info.className = 'med-info';
        info.style.cursor = 'pointer';
        info.addEventListener('click', () => {
            showEditWorkoutGroupModal(group.id);
        });

        const title = doc.createElement('h4');
        const titleParts = [group.name];
        if (group.is_rotating) titleParts.push('🔄');
        if (!group.active) titleParts.push('(Inactive)');
        title.textContent = titleParts.join(' ');

        const description = doc.createElement('p');
        description.textContent = group.description || '';

        const schedule = doc.createElement('p');
        schedule.style.fontSize = '0.9em';
        schedule.style.color = '#666';
        schedule.appendChild(doc.createTextNode(`📅 ${daysText} at ${group.scheduled_time}`));
        schedule.appendChild(doc.createElement('br'));
        schedule.appendChild(doc.createTextNode(`🔔 ${group.notification_advance_minutes} min before`));

        info.appendChild(title);
        info.appendChild(description);
        info.appendChild(schedule);

        const deleteBtn = createDeleteButton((event) => {
            deleteWorkoutGroup(group.id, event);
        });

        card.appendChild(info);
        card.appendChild(deleteBtn);
        container.appendChild(card);
    });
}

function setFlatExercisesPendingSaveMessage() {
    const container = document.getElementById('workout-group-flat-exercises-list');
    if (!container) return;
    const message = document.createElement('p');
    message.style.color = 'var(--hint-color)';
    message.style.fontSize = '0.9em';
    message.textContent = 'Save this group first to add exercises.';
    container.replaceChildren(message);
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
    setFlatExercisesPendingSaveMessage();
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
            const empty = document.createElement('p');
            empty.style.color = 'var(--hint-color)';
            empty.style.fontSize = '0.9em';
            empty.textContent = 'No variants yet. Add one to get started!';
            container.replaceChildren(empty);
            return;
        }

        container.replaceChildren();
        variants.forEach((variant) => {
            const rotationText = variant.rotation_order !== null ? ` (Order: ${variant.rotation_order})` : '';

            const card = document.createElement('div');
            card.style.background = '#f8f9fa';
            card.style.padding = '10px';
            card.style.borderRadius = '6px';
            card.style.marginBottom = '8px';
            card.style.display = 'flex';
            card.style.justifyContent = 'space-between';
            card.style.alignItems = 'center';

            const info = document.createElement('div');
            info.style.cursor = 'pointer';
            info.style.flex = '1';
            info.addEventListener('click', () => {
                showEditVariantModal(variant.id);
            });

            const nameStrong = document.createElement('strong');
            nameStrong.textContent = variant.name;
            info.appendChild(nameStrong);
            if (rotationText) {
                info.appendChild(document.createTextNode(rotationText));
            }

            if (variant.description) {
                const description = document.createElement('div');
                description.style.fontSize = '0.85em';
                description.style.color = '#666';
                description.textContent = variant.description;
                info.appendChild(description);
            }

            const deleteBtn = createDeleteButton((event) => {
                deleteVariant(variant.id, event);
            });
            deleteBtn.style.position = 'static';
            deleteBtn.style.marginLeft = '10px';

            card.appendChild(info);
            card.appendChild(deleteBtn);
            container.appendChild(card);
        });
    } catch (error) {
        console.error('Error loading variants:', error);
        const message = document.createElement('p');
        message.style.color = 'red';
        message.textContent = 'Error loading variants';
        container.replaceChildren(message);
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
            const empty = document.createElement('p');
            empty.style.color = 'var(--hint-color)';
            empty.style.fontSize = '0.9em';
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
            card.style.background = '#f0f4ff';
            card.style.padding = '8px 10px';
            card.style.borderRadius = '6px';
            card.style.marginBottom = '6px';
            card.style.display = 'flex';
            card.style.justifyContent = 'space-between';
            card.style.alignItems = 'center';

            const info = document.createElement('div');
            info.style.cursor = 'pointer';
            info.style.flex = '1';
            info.addEventListener('click', () => {
                showEditExerciseModal(ex.id);
            });

            const title = document.createElement('strong');
            title.textContent = `${ex.order_index + 1}. ${ex.exercise_name}`;

            const meta = document.createElement('div');
            meta.style.fontSize = '0.85em';
            meta.style.color = '#666';
            meta.textContent = `${ex.target_sets} sets × ${repsText} reps${weightText}`;

            info.appendChild(title);
            info.appendChild(meta);

            const deleteBtn = createDeleteButton((event) => {
                deleteExercise(ex.id, event);
            });
            deleteBtn.style.position = 'static';
            deleteBtn.style.marginLeft = '10px';

            card.appendChild(info);
            card.appendChild(deleteBtn);
            container.appendChild(card);
        });
    } catch (error) {
        console.error('Error loading exercises:', error);
        const message = document.createElement('p');
        message.style.color = 'red';
        message.textContent = 'Error loading exercises';
        container.replaceChildren(message);
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
    datalist.replaceChildren();

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
    nameInput.onchange = function () {
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
            if (!cached) {
                const message = document.createElement('p');
                message.style.color = 'red';
                message.textContent = 'Error loading exercise library';
                container.replaceChildren(message);
            }
        }
    });
}

function _renderExerciseLibrary(container, items) {
    if (!items || items.length === 0) {
        const empty = document.createElement('p');
        empty.style.textAlign = 'center';
        empty.style.color = 'var(--hint-color)';
        empty.textContent = 'No exercises in library yet. Add your first exercise!';
        container.replaceChildren(empty);
        return;
    }

    const root = document.createElement('div');
    root.className = 'exercise-library-items';

    for (const item of items) {
        const repsStr = item.default_reps_max
            ? `${item.default_reps_min}-${item.default_reps_max}`
            : `${item.default_reps_min}`;
        const weightStr = item.default_weight_kg ? ` @ ${item.default_weight_kg}kg` : '';

        const card = document.createElement('div');
        card.className = 'exercise-library-item';
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
            showEditExerciseLibraryModal(item.id);
        });

        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';

        const details = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = item.name || '';

        const defaults = document.createElement('div');
        defaults.style.fontSize = '0.9em';
        defaults.style.color = 'var(--hint-color)';
        defaults.textContent = `${item.default_sets} sets x ${repsStr} reps${weightStr}`;

        details.appendChild(title);
        details.appendChild(defaults);

        if (item.notes) {
            const notes = document.createElement('div');
            notes.style.fontSize = '0.85em';
            notes.style.color = 'var(--hint-color)';
            notes.style.marginTop = '2px';
            notes.textContent = item.notes;
            details.appendChild(notes);
        }

        const deleteButton = document.createElement('button');
        deleteButton.className = 'secondary';
        deleteButton.style.padding = '4px 8px';
        deleteButton.style.fontSize = '0.85em';
        deleteButton.textContent = 'Delete';
        deleteButton.addEventListener('click', (event) => {
            deleteExerciseLibraryItem(item.id, event);
        });

        row.appendChild(details);
        row.appendChild(deleteButton);
        card.appendChild(row);
        root.appendChild(card);
    }

    container.replaceChildren(root);
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
    event?.stopPropagation?.();
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
    try {
        // Fetch both manual sessions and Mi Band outdoor workouts in parallel
        const [sessionsResp, mibandResp] = await Promise.all([
            apiCall('/api/workout/sessions?limit=50').catch(() => []),
            apiCall('/api/workout/miband?limit=100').catch(() => [])
        ]);
        _renderWorkoutHistory(container, sessionsResp || [], mibandResp || []);
    } catch (error) {
        console.error('Error loading workout history:', error);
        const message = document.createElement('p');
        message.style.color = 'red';
        message.textContent = 'Error loading history';
        container.replaceChildren(message);
    }
}

// Maps Mi Band activity_name → display label + icon
const MIBAND_ACTIVITY_META = {
    'nordic_walking': { label: 'Nordic Walking', icon: '🏔️' },
    'cycling': { label: 'Cycling', icon: '🚴' },
    'walking': { label: 'Walking', icon: '🚶' },
    'running': { label: 'Running', icon: '🏃' },
};

function _formatDuration(sec) {
    if (!sec || sec <= 0) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}h ${m}min`;
    return `${m}min`;
}

function _renderWorkoutHistory(container, sessions, mibandWorkouts) {
    // Build unified list sorted by date DESC
    const items = [];

    // Manual strength sessions
    const finalSessions = (sessions || []).filter(s =>
        s.session.status === 'completed' || s.session.status === 'skipped'
    );
    finalSessions.forEach(s => {
        let ts;
        if (s.session.started_at) {
            ts = new Date(s.session.started_at).getTime();
        } else {
            const dateStr = s.session.scheduled_date.split('T')[0];
            const timeStr = s.session.scheduled_time || '00:00';
            ts = new Date(`${dateStr}T${timeStr}:00`).getTime();
        }
        items.push({ type: 'session', ts: ts, data: s });
    });

    // Mi Band outdoor workouts
    (mibandWorkouts || []).forEach(w => {
        items.push({ type: 'miband', ts: new Date(w.start_time).getTime(), data: w });
    });

    // Sort newest first
    items.sort((a, b) => b.ts - a.ts);

    if (items.length === 0) {
        const empty = document.createElement('p');
        empty.style.textAlign = 'center';
        empty.style.color = 'var(--hint-color)';
        empty.style.padding = '40px';
        empty.textContent = 'No workout history yet';
        container.replaceChildren(empty);
        return;
    }

    const root = document.createElement('div');
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.gap = '10px';

    items.forEach(item => {
        if (item.type === 'session') {
            root.appendChild(_buildSessionCard(item.data));
        } else {
            root.appendChild(_buildMiBandCard(item.data));
        }
    });

    container.replaceChildren(root);
}

function _buildSessionCard(s) {
    const statusEmoji = {
        'completed': '✅',
        'skipped': '⏭'
    }[s.session.status] || '⏰';

    const date = new Date(s.session.scheduled_date).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
    });

    const volumeText = s.total_volume > 0
        ? `${Math.round(s.total_volume).toLocaleString()} kg total`
        : '';

    const card = document.createElement('div');
    card.style.background = '#f8f9fa';
    card.style.padding = '12px';
    card.style.borderRadius = '8px';
    card.style.cursor = 'pointer';
    card.style.transition = 'background 0.2s';
    card.addEventListener('click', () => showWorkoutSessionModal(s.session.id));
    card.addEventListener('mouseover', () => { card.style.background = '#f0f0f0'; });
    card.addEventListener('mouseout', () => { card.style.background = '#f8f9fa'; });

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'start';

    const left = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${statusEmoji} ${s.group_name}`;
    left.appendChild(title);
    left.appendChild(document.createTextNode(` - ${s.variant_name}`));

    const details = document.createElement('div');
    details.style.fontSize = '0.85em';
    details.style.color = '#666';
    details.style.marginTop = '4px';

    const timeText = s.session.started_at
        ? new Date(s.session.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : s.session.scheduled_time;
    let detailLine = `${date} at ${timeText}`;
    if (s.session.status === 'completed') {
        detailLine += ` • ${s.exercises_completed}/${s.exercises_count} exercises`;
    }
    details.appendChild(document.createTextNode(detailLine));
    if (volumeText) {
        details.appendChild(document.createElement('br'));
        const volume = document.createElement('strong');
        volume.style.color = '#667eea';
        volume.textContent = volumeText;
        details.appendChild(volume);
    }
    left.appendChild(details);

    const right = document.createElement('div');
    right.style.textAlign = 'right';
    right.style.fontSize = '0.85em';
    right.style.color = '#667eea';
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '4px';
    right.appendChild(document.createTextNode(s.session.status));
    const chevron = document.createElement('span');
    chevron.style.fontSize = '1.2em';
    chevron.textContent = '›';
    right.appendChild(chevron);

    row.appendChild(left);
    row.appendChild(right);
    card.appendChild(row);
    return card;
}

function _buildMiBandCard(w) {
    const meta = MIBAND_ACTIVITY_META[w.activity_name] || { label: w.activity_name, icon: '🏅' };
    const startDate = new Date(w.start_time);
    const dateStr = startDate.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
    });
    const timeStr = startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const distKm = w.distance_m >= 1000
        ? `${(w.distance_m / 1000).toFixed(1)} km`
        : `${Math.round(w.distance_m)} m`;
    const duration = _formatDuration(w.duration_sec);

    // Stats chips
    const chips = [];
    chips.push(`📏 ${distKm}`);
    chips.push(`⏱ ${duration}`);
    if (w.steps > 0) chips.push(`👣 ${w.steps.toLocaleString()}`);
    if (w.heart_rate_avg > 0) chips.push(`❤️ ${w.heart_rate_avg} bpm`);
    if (w.calories > 0) chips.push(`🔥 ${w.calories} kcal`);

    const card = document.createElement('div');
    card.style.background = '#f0f7f0';
    card.style.padding = '12px';
    card.style.borderRadius = '8px';
    card.style.borderLeft = '3px solid #4caf50';

    // Title row
    const titleRow = document.createElement('div');
    titleRow.style.display = 'flex';
    titleRow.style.justifyContent = 'space-between';
    titleRow.style.alignItems = 'center';

    const titleLeft = document.createElement('strong');
    titleLeft.textContent = `${meta.icon} ${meta.label}`;

    const badge = document.createElement('span');
    badge.textContent = 'Mi Band';
    badge.style.fontSize = '0.7em';
    badge.style.padding = '2px 7px';
    badge.style.borderRadius = '10px';
    badge.style.background = '#e8f5e9';
    badge.style.color = '#388e3c';
    badge.style.border = '1px solid #a5d6a7';
    badge.style.fontWeight = '600';
    badge.style.letterSpacing = '0.03em';

    titleRow.appendChild(titleLeft);
    titleRow.appendChild(badge);
    card.appendChild(titleRow);

    // Date line
    const dateEl = document.createElement('div');
    dateEl.style.fontSize = '0.82em';
    dateEl.style.color = '#666';
    dateEl.style.marginTop = '2px';
    dateEl.textContent = `${dateStr} at ${timeStr}`;
    card.appendChild(dateEl);

    // Stats chips
    const chipsEl = document.createElement('div');
    chipsEl.style.display = 'flex';
    chipsEl.style.flexWrap = 'wrap';
    chipsEl.style.gap = '6px';
    chipsEl.style.marginTop = '8px';
    chips.forEach(text => {
        const chip = document.createElement('span');
        chip.textContent = text;
        chip.style.fontSize = '0.82em';
        chip.style.padding = '2px 8px';
        chip.style.borderRadius = '12px';
        chip.style.background = '#e8f5e9';
        chip.style.color = '#2e7d32';
        chipsEl.appendChild(chip);
    });
    card.appendChild(chipsEl);

    card.style.cursor = 'pointer';
    card.style.transition = 'background 0.2s';
    card.addEventListener('mouseover', () => { card.style.background = '#e8f5e9'; });
    card.addEventListener('mouseout', () => { card.style.background = '#f0f7f0'; });
    card.addEventListener('click', () => showMiBandWorkoutModal(w));

    return card;
}

// ====================================
// MI BAND WORKOUT EDIT/DELETE
// ====================================

let currentMiBandWorkout = null;

function showMiBandWorkoutModal(w) {
    currentMiBandWorkout = w;
    document.getElementById('miband-workout-id').value = w.id;
    document.getElementById('miband-workout-steps').value = w.steps || 0;
    document.getElementById('miband-workout-distance').value = w.distance_m || 0;
    document.getElementById('miband-workout-duration').value = w.duration_sec || 0;
    document.getElementById('miband-workout-calories').value = w.calories || 0;
    document.getElementById('miband-workout-hr').value = w.heart_rate_avg || 0;
    document.getElementById('miband-workout-spo2').value = w.spo2_avg || 0;

    window.ModalManager.mibandWorkout.open();
}

function closeMiBandWorkoutModal() {
    currentMiBandWorkout = null;
    window.ModalManager.mibandWorkout.close();
}

async function saveMiBandWorkout() {
    if (!currentMiBandWorkout) return;

    const id = currentMiBandWorkout.id;
    const payload = {};

    const steps = parseInt(document.getElementById('miband-workout-steps').value) || 0;
    const distance = parseFloat(document.getElementById('miband-workout-distance').value) || 0;
    const duration = parseInt(document.getElementById('miband-workout-duration').value) || 0;
    const calories = parseInt(document.getElementById('miband-workout-calories').value) || 0;
    const hr = parseInt(document.getElementById('miband-workout-hr').value) || 0;
    const spo2 = parseInt(document.getElementById('miband-workout-spo2').value) || 0;

    if (steps !== currentMiBandWorkout.steps) payload.steps = steps;
    if (distance !== currentMiBandWorkout.distance_m) payload.distance_m = distance;
    if (duration !== currentMiBandWorkout.duration_sec) payload.duration_sec = duration;
    if (calories !== currentMiBandWorkout.calories) payload.calories = calories;
    if (hr !== currentMiBandWorkout.heart_rate_avg) payload.heart_rate_avg = hr;
    if (spo2 !== currentMiBandWorkout.spo2_avg) payload.spo2_avg = spo2;

    if (Object.keys(payload).length === 0) {
        closeMiBandWorkoutModal();
        return;
    }

    try {
        const result = await apiCall(`/api/workout/miband/${id}`, 'PATCH', payload);
        if (result || result === true) {
            closeMiBandWorkoutModal();
            loadWorkoutHistoryTab();
        } else {
            throw new Error('API returned false/null');
        }
    } catch (err) {
        console.error('Error updating Mi Band workout:', err);
        safeAlert('Failed to update workout. Please try again.');
    }
}

async function deleteMiBandWorkout() {
    if (!currentMiBandWorkout) return;
    if (!confirm('Delete this workout?')) return;

    try {
        const result = await apiCall(`/api/workout/miband/${currentMiBandWorkout.id}`, 'DELETE');
        if (result || result === true) {
            closeMiBandWorkoutModal();
            loadWorkoutHistoryTab();
        } else {
            throw new Error('API returned false/null');
        }
    } catch (err) {
        console.error('Error deleting Mi Band workout:', err);
        safeAlert('Failed to delete workout. Please try again.');
    }
}

let currentSessionLogs = [];
let currentSessionData = null;
let originalSessionStatus = null;

function renderWorkoutSessionInfo(infoContainer, session) {
    const root = document.createElement('div');
    root.style.display = 'flex';
    root.style.justifyContent = 'space-between';
    root.style.alignItems = 'center';
    root.style.marginBottom = '10px';

    const left = document.createElement('div');
    const time = document.createElement('strong');
    time.textContent = session.started_at
        ? new Date(session.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : (session.scheduled_time || '');
    left.appendChild(time);
    left.appendChild(document.createTextNode(' • '));
    left.appendChild(document.createTextNode(new Date(session.scheduled_date).toLocaleDateString()));

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '8px';

    const label = document.createElement('label');
    label.style.fontSize = '0.9em';
    label.style.color = '#666';
    label.style.margin = '0';
    label.textContent = 'Status:';

    const select = document.createElement('select');
    select.id = 'session-status-select';
    select.style.padding = '4px 8px';
    select.style.borderRadius = '4px';
    select.style.border = '1px solid #ddd';

    const statusOptions = [
        { value: 'in_progress', label: '🏋️ In Progress' },
        { value: 'completed', label: '✅ Completed' },
        { value: 'skipped', label: '⏭ Skipped' }
    ];

    statusOptions.forEach((opt) => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        option.selected = session.status === opt.value;
        select.appendChild(option);
    });

    right.appendChild(label);
    right.appendChild(select);

    root.appendChild(left);
    root.appendChild(right);
    infoContainer.replaceChildren(root);
}

function renderWorkoutSessionLogs(logsContainer) {
    if (!Array.isArray(currentSessionLogs) || currentSessionLogs.length === 0) {
        const empty = document.createElement('p');
        empty.style.textAlign = 'center';
        empty.style.color = '#888';
        empty.textContent = 'No exercises logged';
        logsContainer.replaceChildren(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    currentSessionLogs.forEach((log, index) => {
        const isUnsaved = !log.id || log.id === 0;

        const entry = document.createElement('div');
        entry.className = 'exercise-log-entry';
        entry.id = `exercise-log-${index}`;
        entry.style.position = 'relative';
        if (isUnsaved && !log._dirty) {
            entry.style.opacity = '0.6';
        }

        const headerRow = document.createElement('div');
        headerRow.style.display = 'flex';
        headerRow.style.justifyContent = 'space-between';
        headerRow.style.alignItems = 'center';

        const title = document.createElement('h4');
        title.style.margin = '0';
        title.textContent = log.exercise_name || '';

        const deleteButton = document.createElement('button');
        deleteButton.title = 'Remove exercise';
        deleteButton.style.background = 'none';
        deleteButton.style.border = 'none';
        deleteButton.style.cursor = 'pointer';
        deleteButton.style.fontSize = '1.2em';
        deleteButton.style.padding = '4px 8px';
        deleteButton.style.color = '#c62828';
        deleteButton.textContent = '🗑️';
        deleteButton.addEventListener('click', () => {
            deleteExerciseLog(index);
        });

        headerRow.appendChild(title);
        headerRow.appendChild(deleteButton);
        entry.appendChild(headerRow);

        if (isUnsaved && !log._dirty) {
            const hint = document.createElement('div');
            hint.className = 'exercise-log-unsaved-hint';
            hint.style.fontSize = '0.75em';
            hint.style.color = '#888';
            hint.style.marginBottom = '4px';
            hint.textContent = 'Not yet logged — edit to include';
            entry.appendChild(hint);
        }

        const inputRow = document.createElement('div');
        inputRow.className = 'log-input-row';

        const createNumberInputGroup = (labelText, value, field, min, max, step, inputmode) => {
            const group = document.createElement('div');
            group.className = 'log-input-group';

            const label = document.createElement('label');
            label.textContent = labelText;

            const input = document.createElement('input');
            input.type = 'number';
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(value);
            input.setAttribute('inputmode', inputmode);
            input.addEventListener('change', () => {
                updateLocalLog(index, field, input.value);
            });

            group.appendChild(label);
            group.appendChild(input);
            return group;
        };

        inputRow.appendChild(createNumberInputGroup('Sets', log.sets_completed || 0, 'sets_completed', 0, 20, 1, 'numeric'));
        inputRow.appendChild(createNumberInputGroup('Reps', log.reps_completed || 0, 'reps_completed', 0, 100, 1, 'numeric'));
        inputRow.appendChild(createNumberInputGroup('Weight (kg)', log.weight_kg || 0, 'weight_kg', 0, 500, 0.5, 'decimal'));
        entry.appendChild(inputRow);

        const notesGroup = document.createElement('div');
        notesGroup.className = 'log-input-group';

        const notesLabel = document.createElement('label');
        notesLabel.textContent = 'Notes';

        const notesInput = document.createElement('input');
        notesInput.type = 'text';
        notesInput.value = log.notes || '';
        notesInput.placeholder = 'Add notes...';
        notesInput.maxLength = 200;
        notesInput.addEventListener('change', () => {
            updateLocalLog(index, 'notes', notesInput.value);
        });

        notesGroup.appendChild(notesLabel);
        notesGroup.appendChild(notesInput);
        entry.appendChild(notesGroup);

        fragment.appendChild(entry);
    });

    logsContainer.replaceChildren(fragment);
}

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

        renderWorkoutSessionInfo(infoContainer, data.session);
        renderWorkoutSessionLogs(logsContainer);

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
    if (!currentSessionLogs[index]) return;

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
        const hint = el.querySelector('.exercise-log-unsaved-hint');
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
    const logsContainer = document.getElementById('workout-session-logs');
    renderWorkoutSessionLogs(logsContainer);
}

async function deleteWorkoutSession() {
    if (!currentSessionData) return;
    if (!confirm('Delete this workout session?')) return;

    const result = await apiCall(`/api/workout/sessions/delete?id=${currentSessionData.id}`, 'DELETE');
    if (result || result === true) {
        closeWorkoutSessionModal();
        loadWorkoutHistoryTab();
    }
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
            if (!cached) {
                const message = document.createElement('p');
                message.style.color = 'red';
                message.textContent = 'Error loading statistics';
                container.replaceChildren(message);
            }
        }
    });
}

function _renderWorkoutStats(container, stats) {
    if (!stats) {
        const empty = document.createElement('p');
        empty.style.textAlign = 'center';
        empty.style.color = 'var(--hint-color)';
        empty.textContent = 'No statistics available yet';
        container.replaceChildren(empty);
        return;
    }

    const formatVolume = (kg) => {
        if (!kg || kg === 0) return '—';
        if (kg >= 1000) return `${(kg / 1000).toFixed(1)}t`;
        return `${Math.round(kg).toLocaleString()} kg`;
    };

    const root = document.createElement('div');

    const topGrid = document.createElement('div');
    topGrid.style.display = 'grid';
    topGrid.style.gridTemplateColumns = 'repeat(3, 1fr)';
    topGrid.style.gap = '10px';
    topGrid.style.marginBottom = '12px';

    const buildHeroCard = (background, valueText, labelText) => {
        const card = document.createElement('div');
        card.style.background = background;
        card.style.color = 'white';
        card.style.padding = '18px 8px';
        card.style.borderRadius = '12px';
        card.style.textAlign = 'center';

        const value = document.createElement('div');
        value.style.fontSize = '2.4em';
        value.style.fontWeight = 'bold';
        value.style.lineHeight = '1.1';
        value.textContent = valueText;

        const label = document.createElement('div');
        label.style.fontSize = '0.78em';
        label.style.opacity = '0.92';
        label.style.marginTop = '5px';
        label.textContent = labelText;

        card.appendChild(value);
        card.appendChild(label);
        return card;
    };

    topGrid.appendChild(buildHeroCard('linear-gradient(135deg, #667eea 0%, #764ba2 100%)', String(stats.current_streak), '🔥 Streak'));
    topGrid.appendChild(buildHeroCard('linear-gradient(135deg, #f093fb 0%, #f5576c 100%)', String(stats.longest_streak), '🏆 Best'));
    topGrid.appendChild(buildHeroCard('linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)', `${Math.round(stats.completion_rate)}%`, '💪 30-Day'));
    root.appendChild(topGrid);

    const totalsGrid = document.createElement('div');
    totalsGrid.style.display = 'grid';
    totalsGrid.style.gridTemplateColumns = 'repeat(3, 1fr)';
    totalsGrid.style.gap = '10px';

    const buildTotalsCard = (background, borderColor, valueColor, valueText, labelText) => {
        const card = document.createElement('div');
        card.style.background = background;
        card.style.padding = '14px 8px';
        card.style.borderRadius = '8px';
        card.style.textAlign = 'center';
        card.style.border = `1.5px solid ${borderColor}`;

        const value = document.createElement('div');
        value.style.fontSize = '1.7em';
        value.style.fontWeight = 'bold';
        value.style.color = valueColor;
        value.textContent = valueText;

        const label = document.createElement('div');
        label.style.fontSize = '0.78em';
        label.style.color = 'var(--hint-color)';
        label.style.marginTop = '2px';
        label.textContent = labelText;

        card.appendChild(value);
        card.appendChild(label);
        return card;
    };

    totalsGrid.appendChild(buildTotalsCard('var(--secondary-bg-color, #f0fff4)', '#28a745', '#28a745', String(stats.completed_sessions), 'Done'));
    totalsGrid.appendChild(buildTotalsCard('var(--secondary-bg-color, #fffbf0)', '#ffc107', '#ffc107', String(stats.skipped_sessions), 'Skipped'));
    totalsGrid.appendChild(buildTotalsCard('var(--secondary-bg-color, #f5f0ff)', '#764ba2', '#764ba2', formatVolume(stats.total_volume_kg), 'Lifted'));
    root.appendChild(totalsGrid);

    if (stats.top_exercises && stats.top_exercises.length > 0) {
        const maxVol = stats.top_exercises[0].total_volume_kg || 1;
        const medals = ['🥇', '🥈', '🥉'];
        const section = document.createElement('div');
        section.style.marginTop = '20px';

        const heading = document.createElement('div');
        heading.style.fontSize = '0.75em';
        heading.style.fontWeight = '600';
        heading.style.textTransform = 'uppercase';
        heading.style.letterSpacing = '1px';
        heading.style.color = 'var(--hint-color)';
        heading.style.marginBottom = '10px';
        heading.textContent = 'Top Exercises · Volume';
        section.appendChild(heading);

        stats.top_exercises.forEach((ex, i) => {
            const pct = maxVol > 0 ? (ex.total_volume_kg / maxVol * 100).toFixed(1) : 0;
            const medal = medals[i] || `${i + 1}.`;
            const maxW = ex.max_weight_kg > 0 ? `${ex.max_weight_kg} kg max` : '';

            const row = document.createElement('div');
            row.style.marginBottom = '10px';

            const labels = document.createElement('div');
            labels.style.display = 'flex';
            labels.style.justifyContent = 'space-between';
            labels.style.alignItems = 'baseline';
            labels.style.marginBottom = '4px';

            const name = document.createElement('span');
            name.style.fontSize = '0.9em';
            name.style.fontWeight = '500';
            name.textContent = `${medal} ${ex.exercise_name}`;

            const meta = document.createElement('span');
            meta.style.fontSize = '0.8em';
            meta.style.color = 'var(--hint-color)';
            meta.textContent = `${formatVolume(ex.total_volume_kg)}${maxW ? ` · ${maxW}` : ''}`;

            labels.appendChild(name);
            labels.appendChild(meta);

            const barTrack = document.createElement('div');
            barTrack.style.background = 'var(--secondary-bg-color, rgba(0,0,0,0.07))';
            barTrack.style.borderRadius = '4px';
            barTrack.style.height = '5px';
            barTrack.style.overflow = 'hidden';

            const barFill = document.createElement('div');
            barFill.style.background = 'linear-gradient(90deg, #667eea, #764ba2)';
            barFill.style.width = `${pct}%`;
            barFill.style.height = '100%';
            barFill.style.borderRadius = '4px';
            barFill.style.transition = 'width 0.4s';

            barTrack.appendChild(barFill);
            row.appendChild(labels);
            row.appendChild(barTrack);
            section.appendChild(row);
        });

        root.appendChild(section);
    }

    if (stats.weekly_activity && stats.weekly_activity.length > 0) {
        const section = document.createElement('div');
        section.style.marginTop = '20px';

        const heading = document.createElement('div');
        heading.style.fontSize = '0.75em';
        heading.style.fontWeight = '600';
        heading.style.textTransform = 'uppercase';
        heading.style.letterSpacing = '1px';
        heading.style.color = 'var(--hint-color)';
        heading.style.marginBottom = '10px';
        heading.textContent = '12-Week Activity';
        section.appendChild(heading);

        const squares = document.createElement('div');
        squares.style.display = 'flex';
        squares.style.flexWrap = 'wrap';
        squares.style.gap = '4px';

        stats.weekly_activity.forEach((w) => {
            const total = w.completed + w.skipped;
            let bg;
            if (total === 0) bg = 'var(--secondary-bg-color, #e8e8e8)';
            else if (w.completed === 0) bg = '#e05c5c';
            else if (w.completed >= total) bg = '#28a745';
            else if (w.completed / total >= 0.5) bg = '#85c17e';
            else bg = '#ffc107';

            const d = new Date(w.week + 'T00:00:00');
            const label = d.toLocaleDateString('en', { month: 'short', day: 'numeric' });

            const square = document.createElement('div');
            square.title = `${label}: ${w.completed} done, ${w.skipped} skipped`;
            square.style.width = '26px';
            square.style.height = '26px';
            square.style.borderRadius = '4px';
            square.style.background = bg;
            square.style.flexShrink = '0';
            squares.appendChild(square);
        });

        const legend = document.createElement('div');
        legend.style.display = 'flex';
        legend.style.gap = '12px';
        legend.style.marginTop = '8px';
        legend.style.fontSize = '0.72em';
        legend.style.color = 'var(--hint-color)';

        const createLegendItem = (color, text) => {
            const item = document.createElement('span');
            const swatch = document.createElement('span');
            swatch.style.display = 'inline-block';
            swatch.style.width = '10px';
            swatch.style.height = '10px';
            swatch.style.borderRadius = '2px';
            swatch.style.background = color;
            swatch.style.verticalAlign = 'middle';
            swatch.style.marginRight = '3px';
            item.appendChild(swatch);
            item.appendChild(document.createTextNode(text));
            return item;
        };

        legend.appendChild(createLegendItem('#28a745', 'All done'));
        legend.appendChild(createLegendItem('#85c17e', 'Partial'));
        legend.appendChild(createLegendItem('#e05c5c', 'Skipped'));

        section.appendChild(squares);
        section.appendChild(legend);
        root.appendChild(section);
    }

    container.replaceChildren(root);
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
    datalist.replaceChildren();

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
