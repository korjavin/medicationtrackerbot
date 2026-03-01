(function () {
    let pendingMedConfirmIds = [];
    let pendingMedConfirmScheduled = null;
    let pendingMedConfirmMode = 'confirm';
    let pendingMedConfirmIntakeIds = [];

    let medicationControlsBound = false;

    function bindMedicationControls() {
        if (medicationControlsBound) return;
        medicationControlsBound = true;

        const bindClick = (id, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', handler);
        };
        const bindChange = (id, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', handler);
        };

        bindChange('history-filter-med', () => window.loadHistory());
        bindChange('history-filter-days', () => window.loadHistory());

        bindClick('add-btn', () => showAddModal());
        bindClick('med-modal-cancel-btn', () => closeModal());
        bindClick('med-modal-save-btn', () => saveMedication());

        bindChange('schedule-type', () => toggleScheduleFields());

        bindClick('initial-remove-time-btn', () => {
            const button = document.getElementById('initial-remove-time-btn');
            if (button) removeTime(button);
        });
        bindClick('add-time-btn', () => addTimeInput());

        bindChange('med-track-inventory', () => toggleInventoryFields());
        bindClick('restock-add-btn', () => handleRestock());

        bindClick('med-confirm-dismiss-btn', () => closeMedicationConfirmModal());
        bindClick('med-confirm-snooze-btn', () => snoozeMedicationConfirm());
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindMedicationControls, { once: true });
    }
    bindMedicationControls();

    function showAddModal() {
        window.editingMedId = null;
        window.ModalManager.med.open();

        document.getElementById('med-name').value = '';
        document.getElementById('med-dosage').value = '';
        document.getElementById('med-archived').checked = false;
        document.getElementById('med-rx-display').style.display = 'none';
        document.getElementById('med-start-date').value = '';
        document.getElementById('med-end-date').value = '';

        document.getElementById('med-track-inventory').checked = false;
        document.getElementById('med-inventory-count').value = '';
        document.getElementById('inventory-fields').classList.add('hidden');
        document.getElementById('restock-section').style.display = 'none';
        document.getElementById('restock-history').replaceChildren();

        document.getElementById('schedule-type').value = 'daily';
        toggleScheduleFields();

        const timeContainer = document.getElementById('time-inputs');
        timeContainer.replaceChildren();
        addTimeInput();

        // Clear day picker
        const dayPicker = document.getElementById('med-days');
        if (dayPicker && typeof dayPicker.value !== 'undefined') {
            dayPicker.value = [];
        }
    }
    window.showAddModal = showAddModal;

    function showEditModal(id) {
        window.editingMedId = id;
        const med = window.medications.find(m => m.id === id);
        if (!med) return;

        window.ModalManager.med.open();

        document.getElementById('med-name').value = med.name;
        document.getElementById('med-dosage').value = med.dosage;
        document.getElementById('med-archived').checked = med.archived || false;

        const rxDisplay = document.getElementById('med-rx-display');
        if (med.normalized_name) {
            rxDisplay.innerText = "Rx: " + med.normalized_name;
            rxDisplay.style.display = 'block';
        } else {
            rxDisplay.style.display = 'none';
        }

        document.getElementById('med-start-date').value = med.start_date ? med.start_date.split('T')[0] : '';
        document.getElementById('med-end-date').value = med.end_date ? med.end_date.split('T')[0] : '';

        const hasInventory = med.inventory_count !== null && med.inventory_count !== undefined;
        document.getElementById('med-track-inventory').checked = hasInventory;
        document.getElementById('med-inventory-count').value = hasInventory ? med.inventory_count : '';
        if (hasInventory) {
            document.getElementById('inventory-fields').classList.remove('hidden');
            document.getElementById('restock-section').style.display = 'block';
            window.loadRestockHistory(id);
        } else {
            document.getElementById('inventory-fields').classList.add('hidden');
            document.getElementById('restock-section').style.display = 'none';
            document.getElementById('restock-history').replaceChildren();
        }

        let sched;
        try {
            sched = JSON.parse(med.schedule);
        } catch (e) {
            sched = { type: 'daily', times: [med.schedule] };
        }

        document.getElementById('schedule-type').value = sched.type;
        toggleScheduleFields();

        const timeContainer = document.getElementById('time-inputs');
        timeContainer.replaceChildren();
        if (sched.times && sched.times.length > 0) {
            sched.times.forEach(t => addTimeInput(t));
        } else {
            addTimeInput();
        }

        // Set days via day picker component
        const dayPicker = document.getElementById('med-days');
        if (dayPicker && typeof dayPicker.value !== 'undefined') {
            dayPicker.value = sched.days || [];
        }
    }
    window.showEditModal = showEditModal;

    function closeModal() {
        window.ModalManager.med.close();
    }
    window.closeModal = closeModal;

    function toggleScheduleFields() {
        const type = document.getElementById('schedule-type').value;
        const daysContainer = document.getElementById('days-container');
        const timesContainer = document.getElementById('times-container');

        if (type === 'weekly') {
            daysContainer.classList.remove('hidden');
        } else {
            daysContainer.classList.add('hidden');
        }

        if (type === 'as_needed') {
            timesContainer.classList.add('hidden');
        } else {
            timesContainer.classList.remove('hidden');
        }
    }
    window.toggleScheduleFields = toggleScheduleFields;

    function toggleInventoryFields() {
        const trackInventory = document.getElementById('med-track-inventory').checked;
        const inventoryFields = document.getElementById('inventory-fields');
        const restockSection = document.getElementById('restock-section');

        if (trackInventory) {
            inventoryFields.classList.remove('hidden');
            if (window.editingMedId) {
                restockSection.style.display = 'block';
            } else {
                restockSection.style.display = 'none';
            }
        } else {
            inventoryFields.classList.add('hidden');
        }
    }
    window.toggleInventoryFields = toggleInventoryFields;

    async function loadRestockHistory(medId) {
        const restocks = await window.apiCall(`/api/medications/${medId}/restocks`);
        const container = document.getElementById('restock-history');
        container.replaceChildren();

        if (!restocks || restocks.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'hint';
            empty.textContent = 'No restock history';
            container.appendChild(empty);
            return;
        }

        const title = document.createElement('p');
        title.className = 'hint';
        title.textContent = 'Recent restocks:';
        container.appendChild(title);

        const list = document.createElement('ul');
        restocks.slice(0, 5).forEach((r) => {
            const date = window.formatDate(r.restocked_at);
            const item = document.createElement('li');
            item.textContent = `+${r.quantity} on ${date}${r.note ? ` - ${r.note}` : ''}`;
            list.appendChild(item);
        });
        container.appendChild(list);
    }
    window.loadRestockHistory = loadRestockHistory;

    async function handleRestock() {
        if (!window.editingMedId) return;

        const qtyInput = document.getElementById('restock-qty');
        const qty = parseInt(qtyInput.value);

        if (!qty || qty <= 0) {
            window.safeAlert("Please enter a valid quantity");
            return;
        }

        const res = await window.apiCall(`/api/medications/${window.editingMedId}/restock`, 'POST', { quantity: qty });
        if (res) {
            document.getElementById('med-inventory-count').value = res.inventory_count;
            qtyInput.value = '';
            loadRestockHistory(window.editingMedId);
            window.safeAlert(`Added ${qty} units. New total: ${res.inventory_count}`);
        }
    }
    window.handleRestock = handleRestock;

    function isLowOnStock(med) {
        if (med.inventory_count === null || med.inventory_count === undefined) return false;
        const dailyUsage = calculateDailyUsage(med);
        if (dailyUsage === 0) return false;
        const daysOfStock = med.inventory_count / dailyUsage;

        if (med.end_date) {
            const daysUntilEnd = (new Date(med.end_date) - new Date()) / (1000 * 60 * 60 * 24);
            if (daysUntilEnd <= 0) return false;
            return daysOfStock < daysUntilEnd;
        }
        return daysOfStock < 7;
    }
    window.isLowOnStock = isLowOnStock;

    function calculateDailyUsage(med) {
        try {
            const sched = JSON.parse(med.schedule);
            if (sched.type === 'as_needed') return 0;
            const timesPerDay = (sched.times || []).length;
            if (sched.type === 'daily') return timesPerDay;
            if (sched.type === 'weekly') {
                return ((sched.days || []).length / 7.0) * timesPerDay;
            }
            return 0;
        } catch (e) { return 0; }
    }

    function addTimeInput(value = '') {
        const container = document.getElementById('time-inputs');
        const div = document.createElement('div');
        div.className = 'time-row';

        const input = document.createElement('input');
        input.type = 'time';
        input.className = 'med-time-input';
        input.value = value;

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'remove-time';
        removeButton.textContent = '\u00d7';
        removeButton.addEventListener('click', () => removeTime(removeButton));

        div.appendChild(input);
        div.appendChild(removeButton);
        container.appendChild(div);
    }
    window.addTimeInput = addTimeInput;

    function removeTime(btn) {
        btn.parentElement.remove();
    }
    window.removeTime = removeTime;

    async function saveMedication() {
        const name = document.getElementById('med-name').value;
        const dosage = document.getElementById('med-dosage').value;
        const type = document.getElementById('schedule-type').value;
        const archived = document.getElementById('med-archived').checked;

        const startDateRaw = document.getElementById('med-start-date').value;
        const endDateRaw = document.getElementById('med-end-date').value;

        const trackInventory = document.getElementById('med-track-inventory').checked;
        const inventoryCountRaw = document.getElementById('med-inventory-count').value;
        let inventoryCount = null;
        if (trackInventory && inventoryCountRaw !== '') {
            inventoryCount = parseInt(inventoryCountRaw);
        }

        if (!name) { window.safeAlert("Name is required!"); return; }

        const schedule = { type: type };

        if (type !== 'as_needed') {
            const times = Array.from(document.querySelectorAll('.med-time-input'))
                .map(i => i.value)
                .filter(v => v !== "");

            if (times.length === 0) {
                window.safeAlert("At least one time is required!");
                return;
            }
            schedule.times = times;
        }

        if (type === 'weekly') {
            const dayPicker = document.getElementById('med-days');
            const days = dayPicker && typeof dayPicker.value !== 'undefined'
                ? dayPicker.value
                : [];

            if (days.length === 0) {
                window.safeAlert("Select at least one day!");
                return;
            }
            schedule.days = days;
        }

        const payload = {
            name,
            dosage,
            schedule: JSON.stringify(schedule),
            archived,
            start_date: startDateRaw ? new Date(startDateRaw).toISOString() : null,
            end_date: endDateRaw ? new Date(endDateRaw).toISOString() : null,
            inventory_count: inventoryCount
        };

        let res;
        if (window.editingMedId) {
            res = await window.apiCall(`/api/medications/${window.editingMedId}`, 'POST', payload);
        } else {
            res = await window.apiCall('/api/medications', 'POST', payload);
        }

        if (res && res.warning) {
            window.safeAlert("\u26a0\ufe0f " + res.warning);
        }

        await window.DataStore.invalidateTags(['medications', 'history']);
        await window.DataStore.invalidateKey('next_intake');

        window.closeModal();
        window.loadMeds();
    }
    window.saveMedication = saveMedication;

    async function deleteMed(id) {
        const confirmMsg = "Archive this medication?";

        if (window.userInitData && window.tg && window.tg.showConfirm) {
            try {
                window.tg.showConfirm(confirmMsg, (ok) => {
                    if (ok) window._archiveMedApi(id);
                });
                return;
            } catch (e) {
                console.log("tg.showConfirm failed, falling back", e);
            }
        }

        if (confirm(confirmMsg)) {
            window._archiveMedApi(id);
        }
    }
    window.deleteMed = deleteMed;

    async function _archiveMedApi(id) {
        const med = window.medications.find(m => m.id === id);
        if (!med) return;

        const payload = {
            name: med.name,
            dosage: med.dosage,
            schedule: med.schedule,
            archived: true
        };

        const res = await window.apiCall(`/api/medications/${id}`, 'POST', payload);
        if (res && res.warning) {
            window.safeAlert("\u26a0\ufe0f " + res.warning);
        }
        await window.DataStore.invalidateTags(['medications', 'history']);
        await window.DataStore.invalidateKey('next_intake');
        window.loadMeds();
    }

    // --- Medication Confirm Modal ---

    function showMedicationConfirmModal(ids, names, scheduledAt, mode = 'confirm', intakeIds = []) {
        pendingMedConfirmIds = ids;
        pendingMedConfirmScheduled = scheduledAt;
        pendingMedConfirmMode = mode;
        pendingMedConfirmIntakeIds = intakeIds;

        window.ModalManager.medConfirm.open();

        const titleEl = document.getElementById('med-confirm-title');
        const subtitleEl = document.getElementById('med-confirm-subtitle');
        const timeEditEl = document.getElementById('med-confirm-time-edit');
        const timeInput = document.getElementById('med-confirm-datetime');
        const actionBtn = document.getElementById('med-confirm-action-btn');
        const snoozeBtn = document.getElementById('med-confirm-snooze-btn');

        if (mode === 'edit' || mode === 'log_past') {
            titleEl.innerText = mode === 'edit' ? "Edit Intake" : "Log Intake";
            subtitleEl.innerText = "";
            timeEditEl.style.display = 'block';

            try {
                timeInput.value = window.formatDateTimeLocalForInput(scheduledAt);
            } catch (e) {
                console.error("Error formatting date for input", e);
            }

            actionBtn.innerText = mode === 'edit' ? "Update" : "Log Intake";
            actionBtn.onclick = mode === 'edit' ? updateIntakeHistory : confirmLogPast;
            snoozeBtn.style.display = 'none';
        } else {
            titleEl.innerText = "Time for Meds!";
            timeEditEl.style.display = 'none';

            let timeStr = scheduledAt;
            try {
                const d = new Date(scheduledAt);
                timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            } catch (e) { }
            subtitleEl.innerText = "Scheduled for: " + timeStr;

            actionBtn.innerText = "Confirm Selected";
            actionBtn.onclick = confirmSelectedMedications;
            snoozeBtn.style.display = 'inline-block';
        }

        const list = document.getElementById('med-confirm-list');
        list.replaceChildren();

        ids.forEach((id, index) => {
            const name = names[index] || ('Medication ' + id);
            const div = document.createElement('div');
            div.className = 'form-row';
            div.style.marginBottom = '10px';

            const label = document.createElement('label');
            label.className = 'checkbox-label';
            label.style.fontWeight = '500';

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = String(id);
            input.checked = true;
            input.className = 'med-confirm-check';

            label.appendChild(input);
            label.appendChild(document.createTextNode(` ${name}`));
            div.appendChild(label);
            list.appendChild(div);
        });
    }
    window.showMedicationConfirmModal = showMedicationConfirmModal;

    function closeMedicationConfirmModal() {
        window.ModalManager.medConfirm.close();
    }
    window.closeMedicationConfirmModal = closeMedicationConfirmModal;

    async function confirmSelectedMedications() {
        const checks = document.querySelectorAll('.med-confirm-check:checked');
        const selectedIds = Array.from(checks).map(c => parseInt(c.value));

        if (selectedIds.length === 0) {
            closeMedicationConfirmModal();
            return;
        }

        try {
            const res = await window.apiCall('/api/medications/confirm-schedule', 'POST', {
                scheduled_at: pendingMedConfirmScheduled,
                medication_ids: selectedIds
            });
            if (res) {
                window.safeAlert("Confirmed!");
                window.loadMeds();
                window.loadHistory();
            }
        } catch (e) {
            console.error(e);
            window.safeAlert("Error confirming: " + e.message);
        }

        closeMedicationConfirmModal();
    }

    async function updateIntakeHistory() {
        const checks = document.querySelectorAll('.med-confirm-check');
        const selectedIds = [];
        const unselectedIds = [];

        checks.forEach(c => {
            const medId = parseInt(c.value);
            if (c.checked) selectedIds.push(medId);
            else unselectedIds.push(medId);
        });

        const timeInput = document.getElementById('med-confirm-datetime');
        const takenAt = new Date(timeInput.value).toISOString();

        const updates = [];

        selectedIds.forEach(medId => {
            const idx = pendingMedConfirmIds.indexOf(medId);
            if (idx !== -1 && pendingMedConfirmIntakeIds[idx]) {
                updates.push({ id: pendingMedConfirmIntakeIds[idx], status: 'TAKEN', taken_at: takenAt });
            }
        });

        unselectedIds.forEach(medId => {
            const idx = pendingMedConfirmIds.indexOf(medId);
            if (idx !== -1 && pendingMedConfirmIntakeIds[idx]) {
                updates.push({ id: pendingMedConfirmIntakeIds[idx], status: 'PENDING', taken_at: '' });
            }
        });

        if (updates.length === 0) {
            closeMedicationConfirmModal();
            return;
        }

        try {
            const res = await window.apiCall('/api/intakes/update', 'POST', { updates });
            if (res) {
                window.safeAlert("Updated!");
                window.loadMeds();
                window.loadHistory();
            }
        } catch (e) {
            console.error(e);
            window.safeAlert("Error updating: " + e.message);
        }

        closeMedicationConfirmModal();
    }

    async function confirmLogPast() {
        const timeInput = document.getElementById('med-confirm-datetime');
        const takenAt = new Date(timeInput.value).toISOString();
        const medId = pendingMedConfirmIds[0];

        try {
            const res = await window.apiCall('/api/medications/log-past', 'POST', {
                medication_id: medId,
                taken_at: takenAt
            });
            if (res) {
                window.safeAlert("Intake logged!");
                window.loadMeds();
                window.loadHistory();
            }
        } catch (e) {
            console.error(e);
            window.safeAlert("Error logging: " + e.message);
        }

        closeMedicationConfirmModal();
    }

    function snoozeMedicationConfirm() {
        closeMedicationConfirmModal();
    }

    function logMedicationPast(id, name) {
        window.showMedicationConfirmModal([id], [name], new Date(), 'log_past');
    }
    window.logMedicationPast = logMedicationPast;

    window.confirmSelectedMedications = confirmSelectedMedications;
    window.updateIntakeHistory = updateIntakeHistory;
    window.confirmLogPast = confirmLogPast;
    window._archiveMedApi = _archiveMedApi;
})();
