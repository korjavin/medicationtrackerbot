// ====================================
// VARIANTS — CRUD
// ====================================
//
// Owns:
//   - "currently editing variant id" + "currently active group for variant"
//     form state (closure-private; read/written via WorkoutEdit getters).
//
// Both fields are initialised inside this file's IIFE — the variant modal
// flow is the only path that mutates them; groups.js / exercises.js /
// next-card.js read/write via window.WorkoutEdit.* getters.

(function () {
    let _editingVariantId = null;
    let _groupForVariant = null;

    window.WorkoutEdit = window.WorkoutEdit || {};
    Object.defineProperty(window.WorkoutEdit, 'editingVariantId', {
        get: () => _editingVariantId,
        set: (v) => { _editingVariantId = v; },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(window.WorkoutEdit, 'groupForVariant', {
        get: () => _groupForVariant,
        set: (v) => { _groupForVariant = v; },
        enumerable: true,
        configurable: true
    });
})();

async function loadVariantsForGroup(groupId) {
    window.WorkoutEdit.groupForVariant = groupId;
    const container = document.getElementById('workout-variants-list');

    try {
        const variants = await apiCall(`/api/workout/variants?group_id=${groupId}`);

        if (!variants || variants.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'workout-pending-msg';
            empty.textContent = 'No variants yet. Add one to get started!';
            container.replaceChildren(empty);
            return;
        }

        container.replaceChildren();
        variants.forEach((variant) => {
            const rotationText = variant.rotation_order !== null ? ` (Order: ${variant.rotation_order})` : '';

            const card = document.createElement('div');
            card.className = 'workout-variant-card';

            const info = document.createElement('div');
            info.className = 'cursor-pointer flex-1';
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
                description.className = 'workout-variant-desc';
                description.textContent = variant.description;
                info.appendChild(description);
            }

            const deleteBtn = createDeleteButton((event) => {
                deleteVariant(variant.id, event);
            });
            deleteBtn.classList.add('workout-delete-btn-inline');

            card.appendChild(info);
            card.appendChild(deleteBtn);
            container.appendChild(card);
        });
    } catch (error) {
        console.error('Error loading variants:', error);
        const message = document.createElement('p');
        message.className = 'text-danger';
        message.textContent = 'Error loading variants';
        container.replaceChildren(message);
    }
}

function showAddVariantModal() {
    const groupId = window.WorkoutEdit.groupForVariant || window.WorkoutEdit.editingGroupId;
    if (!groupId) {
        safeAlert('Save this workout group first to add variants.');
        return;
    }

    window.WorkoutEdit.groupForVariant = groupId;

    window.WorkoutEdit.editingVariantId = null;
    document.getElementById('workout-variant-modal-title').textContent = 'Add Variant';
    window.ModalManager.workoutVariant.open();

    document.getElementById('workout-variant-name').value = '';
    document.getElementById('workout-variant-description').value = '';
    document.getElementById('workout-variant-rotation').value = '';

    // Show/hide rotation field based on group
    const group = window.WorkoutEdit.cachedGroups.find(g => g.id === window.WorkoutEdit.groupForVariant);
    if (group && group.is_rotating) {
        document.getElementById('workout-variant-rotation-field').style.display = 'block';
    } else {
        document.getElementById('workout-variant-rotation-field').style.display = 'none';
    }

    document.getElementById('workout-exercises-section').style.display = 'none';
}

async function showEditVariantModal(variantId) {
    window.WorkoutEdit.editingVariantId = variantId;

    const variants = await apiCall(`/api/workout/variants?group_id=${window.WorkoutEdit.groupForVariant}`);
    const variant = variants && variants.find(v => v.id === variantId);
    if (!variant) return;

    document.getElementById('workout-variant-modal-title').textContent = 'Edit Variant';
    window.ModalManager.workoutVariant.open();

    document.getElementById('workout-variant-name').value = variant.name;
    document.getElementById('workout-variant-description').value = variant.description || '';
    document.getElementById('workout-variant-rotation').value = variant.rotation_order !== null ? variant.rotation_order : '';

    const group = window.WorkoutEdit.cachedGroups.find(g => g.id === window.WorkoutEdit.groupForVariant);
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
    window.WorkoutEdit.editingVariantId = null;
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
        group_id: window.WorkoutEdit.groupForVariant,
        name,
        rotation_order: rotation,
        description
    };

    let result;
    if (window.WorkoutEdit.editingVariantId) {
        // Update
        result = await apiCall(`/api/workout/variants/update?id=${window.WorkoutEdit.editingVariantId}`, 'PUT', payload);
    } else {
        result = await apiCall('/api/workout/variants/create', 'POST', payload);
    }

    if (result || result === true) {
        await invalidateWorkoutCache();
        closeVariantModal();
        loadVariantsForGroup(window.WorkoutEdit.groupForVariant);
    }
}

async function deleteVariant(variantId, event) {
    event.stopPropagation();
    await safeConfirm('Delete this variant and all its exercises?', async (ok) => {
        if (ok) {
            await _deleteVariantApi(variantId);
        }
    });
}

async function _deleteVariantApi(variantId) {
    const result = await apiCall(`/api/workout/variants/delete?id=${variantId}`, 'DELETE');
    if (result || result === true) {
        await invalidateWorkoutCache();
        loadVariantsForGroup(window.WorkoutEdit.groupForVariant);
    }
}

window.WorkoutVariants = {
    load: loadVariantsForGroup,
    save: saveVariant,
    openAdd: showAddVariantModal,
    openEdit: showEditVariantModal,
    close: closeVariantModal,
    delete: deleteVariant
};
