// ==================== Medication render + modal flow ====================
// Extracted from app.js in Phase 5 Task 1. These functions remain global
// (script-tag loading) and still rely on app.js helpers (parseMedicationSchedule,
// getNextScheduledDate, getMedicationScheduleText, getLastTakenTimeMs,
// isLowOnStock, formatDate, apiCall, withSubmit, safeAlert, safeConfirm,
// _archiveMedApi, editingMedId, medications, initialAuthLoad, etc.) that
// remain in app.js.

// Sub-tab state (Phase 5, Task 2). Mirrors the `mt-food-subtab` pattern —
// one of three values (`schedule`, `history`, `inventory`), persisted to
// localStorage so the user's choice survives reload. The default is
// `schedule` (distinct from the paper-era default of `history`).
const MEDS_SUBTAB_STORAGE_KEY = 'mt-meds-subtab';
const MEDS_SUBTAB_OPTIONS = ['schedule', 'history', 'inventory'];
const MEDS_SUBTAB_DEFAULT = 'schedule';

function getActiveMedsSubTab() {
    try {
        const raw = window.localStorage.getItem(MEDS_SUBTAB_STORAGE_KEY);
        if (MEDS_SUBTAB_OPTIONS.indexOf(raw) !== -1) return raw;
    } catch (_) { /* ignore */ }
    return MEDS_SUBTAB_DEFAULT;
}

function setActiveMedsSubTab(tab) {
    if (MEDS_SUBTAB_OPTIONS.indexOf(tab) === -1) return;
    try { window.localStorage.setItem(MEDS_SUBTAB_STORAGE_KEY, tab); } catch (_) { /* ignore */ }
}

function syncMedsSubTabActiveClass(activeTab) {
    const container = document.querySelector('.wg-meds-subtabs');
    if (!container) return;
    const buttons = container.querySelectorAll('.med-tab');
    buttons.forEach((btn) => {
        const isActive = btn.dataset.tab === activeTab;
        btn.classList.toggle('wg-gloss--sun', isActive);
        btn.classList.toggle('wg-meds-subtabs__btn--active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function restoreMedsSubTab() {
    const tab = getActiveMedsSubTab();
    syncMedsSubTabActiveClass(tab);
    if (tab !== MEDS_SUBTAB_DEFAULT && typeof switchMedTab === 'function') {
        switchMedTab(tab);
    }
}

// Apply the stored sub-tab on boot so the Meds view reflects the user's
// last choice across reloads. DOMContentLoaded guarantees the strip markup
// exists (the view itself is not visible yet — switchTab('meds') will only
// activate it later — but the strip classes must already be correct so the
// strip paints in the right state the first time it becomes visible).
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restoreMedsSubTab, { once: true });
} else {
    restoreMedsSubTab();
}

function showEditModal(id) {
    editingMedId = id;
    const med = medications.find(m => m.id === id);
    if (!med) return;

    window.ModalManager.med.open();

    // Fill inputs
    document.getElementById('med-name').value = med.name;
    document.getElementById('med-dosage').value = med.dosage;
    document.getElementById('med-archived').checked = med.archived || false;
    document.getElementById('med-supplement').checked = med.supplement || false;

    // Show RxNorm
    const rxDisplay = document.getElementById('med-rx-display');
    if (med.normalized_name) {
        rxDisplay.innerText = "Rx: " + med.normalized_name;
        rxDisplay.style.display = 'block';
    } else {
        rxDisplay.style.display = 'none';
    }

    // Dates (ISO string to YYYY-MM-DD)
    document.getElementById('med-start-date').value = med.start_date ? med.start_date.split('T')[0] : '';
    document.getElementById('med-end-date').value = med.end_date ? med.end_date.split('T')[0] : '';

    // Inventory tracking
    const hasInventory = med.inventory_count !== null && med.inventory_count !== undefined;
    document.getElementById('med-track-inventory').checked = hasInventory;
    document.getElementById('med-inventory-count').value = hasInventory ? med.inventory_count : '';
    if (hasInventory) {
        document.getElementById('inventory-fields').classList.remove('hidden');
        document.getElementById('restock-section').style.display = 'block';
        loadRestockHistory(id);
    } else {
        document.getElementById('inventory-fields').classList.add('hidden');
        document.getElementById('restock-section').style.display = 'none';
        document.getElementById('restock-history').replaceChildren();
    }

    // Parse schedule
    let sched;
    try {
        sched = JSON.parse(med.schedule);
    } catch (e) {
        // Legacy format
        sched = { type: 'daily', times: [med.schedule] };
    }

    document.getElementById('schedule-type').value = sched.type;
    toggleScheduleFields();

    // Set times
    const timeContainer = document.getElementById('time-inputs');
    timeContainer.replaceChildren();
    if (sched.times && sched.times.length > 0) {
        sched.times.forEach(t => addTimeInput(t));
    } else {
        addTimeInput();
    }

    // Set days
    document.querySelectorAll('#days-container .days-select span').forEach(s => s.classList.remove('selected'));
    if (sched.days) {
        sched.days.forEach(d => {
            const span = document.querySelector(`#days-container .days-select span[data-day="${d}"]`);
            if (span) span.classList.add('selected');
        });
    }

    // Timezone adjustment policy
    document.getElementById('med-tz-policy').value = med.tz_shift_policy || 'flexible';
}

// Render
function renderMeds() {
    const list = document.getElementById('med-list');
    list.replaceChildren();
    const now = new Date();

    // Buckets
    const scheduledSoon = [];
    const recentTaken = []; // Recurring but not soon (taken today/yesterday)
    const asNeeded = [];
    const archived = [];

    medications.forEach((med) => {
        const schedule = parseMedicationSchedule(med.schedule);
        const scheduleType = schedule?.type || 'daily';

        if (med.archived) {
            archived.push({ med, schedule, next: null });
            return;
        }

        if (scheduleType === 'as_needed') {
            asNeeded.push({ med, schedule, next: null });
        } else {
            const next = getNextScheduledDate(schedule, now);
            const hoursUntil = next ? (next - new Date()) / (1000 * 60 * 60) : 999;

            if (hoursUntil < 14) {
                scheduledSoon.push({ med, schedule, next });
            } else {
                recentTaken.push({ med, schedule, next });
            }
        }
    });

    // Sort Buckets
    scheduledSoon.sort((a, b) => (a.next || 0) - (b.next || 0));

    // Recent Taken: Recent logs first
    const sortByTaken = (a, b) => {
        return getLastTakenTimeMs(b.med) - getLastTakenTimeMs(a.med);
    };

    recentTaken.sort(sortByTaken);
    asNeeded.sort(sortByTaken);
    archived.sort(sortByTaken);

    // Combine
    const sorted = [...scheduledSoon, ...recentTaken, ...asNeeded, ...archived];

    sorted.forEach(({ med, schedule: parsedSchedule }) => {
        const div = document.createElement('div');
        div.className = 'med-item';
        if (med.archived) div.classList.add('archived');

        const scheduleText = getMedicationScheduleText(med, parsedSchedule);

        const info = document.createElement('div');
        info.className = 'med-info';
        info.classList.add('cursor-pointer');
        info.addEventListener('click', () => {
            showEditModal(med.id);
        });

        const title = document.createElement('h4');
        title.textContent = `${med.name} `;
        const dosage = document.createElement('small');
        dosage.textContent = `(${med.dosage})`;
        title.appendChild(dosage);
        if (med.supplement) {
            const supplementBadge = document.createElement('small');
            supplementBadge.className = 'med-supplement-badge';
            supplementBadge.textContent = '[Supplement]';
            title.appendChild(supplementBadge);
        }
        info.appendChild(title);

        if (med.normalized_name) {
            const normalized = document.createElement('p');
            normalized.className = 'med-normalized-name';
            normalized.textContent = `Rx: ${med.normalized_name}`;
            info.appendChild(normalized);
        }

        const scheduleLine = document.createElement('p');
        scheduleLine.textContent = `Schedule: ${scheduleText}`;
        info.appendChild(scheduleLine);

        if (med.start_date || med.end_date) {
            const start = med.start_date ? formatDate(med.start_date).split(' ')[0] : 'N/A';
            const end = med.end_date ? formatDate(med.end_date).split(' ')[0] : 'N/A';
            const dates = document.createElement('p');
            dates.textContent = `Dates: ${start} - ${end}`;
            info.appendChild(dates);
        }

        if (med.inventory_count !== null && med.inventory_count !== undefined) {
            const isLow = isLowOnStock(med);
            const inventory = document.createElement('p');
            inventory.className = `inventory-badge ${isLow ? 'low' : ''}`.trim();
            inventory.textContent = `📦 ${med.inventory_count} doses${isLow ? ' ⚠️' : ''}`;
            info.appendChild(inventory);
        }

        const actions = document.createElement('div');
        actions.className = 'med-actions';
        const logBtn = document.createElement('button');
        logBtn.type = 'button';
        logBtn.className = 'btn btn-sm btn-secondary';
        logBtn.textContent = 'Log';
        logBtn.addEventListener('click', () => {
            logMedicationPast(med.id, med.name);
        });

        const editBtn = createEditButton(() => {
            showEditModal(med.id);
        });

        const deleteBtn = createDeleteButton(() => {
            deleteMed(med.id);
        });

        const actionIcons = document.createElement('div');
        actionIcons.className = 'med-action-icons';
        actionIcons.appendChild(editBtn);
        actionIcons.appendChild(deleteBtn);

        actions.appendChild(logBtn);
        actions.appendChild(actionIcons);
        div.appendChild(info);
        div.appendChild(actions);
        list.appendChild(div);
    });
}

function logMedicationPast(id, name) {
    showMedicationConfirmModal([id], [name], new Date(), 'log_past');
}


function renderHistory(logs) {
    const list = document.getElementById('history-list');
    list.replaceChildren();

    if (!logs || logs.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'med-empty-text';
        empty.textContent = 'No history yet.';
        list.appendChild(empty);
        return;
    }

    // Group logs by taken_at timestamp (formatted to minute precision)
    const groups = [];
    // Helper for European Date Format (DD.MM.YYYY HH:MM)
    /* formatDate is now global */

    logs.forEach(l => {
        let key = l.scheduled_at; // Default key
        let timeLabel = formatDate(l.scheduled_at);

        // If taken, use taken_at as grouping key
        if (l.status === 'TAKEN' && l.taken_at) {
            const d = new Date(l.taken_at);
            // Key is string to minute precision
            key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;
            timeLabel = formatDate(l.taken_at);
        }

        // Check if group exists
        let grp = groups.find(g => g.key === key && g.status === l.status);
        if (!grp) {
            grp = { key, status: l.status, timeLabel, items: [], sortTime: 0 };

            // Determine sort time
            if (l.status === 'TAKEN' && l.taken_at) {
                grp.sortTime = new Date(l.taken_at).getTime();
            } else {
                grp.sortTime = new Date(l.scheduled_at).getTime();
            }

            groups.push(grp);
        }
        grp.items.push(l);
    });

    // Sort Groups Descending (Most Recent First)
    groups.sort((a, b) => b.sortTime - a.sortTime);

    // Render Groups
    groups.forEach(g => {
        const div = document.createElement('div');
        div.className = 'history-group';

        // Make PENDING and TAKEN items clickable
        if (g.status === 'PENDING' || g.status === 'TAKEN') {
            div.classList.add('cursor-pointer');
            div.onclick = () => {
                // Collect med ids and names
                const ids = g.items.map(i => i.medication_id);
                const names = g.items.map(i => {
                    const med = medications.find(m => m.id === i.medication_id);
                    return med ? med.name : 'Unknown';
                });

                // Collect intake IDs for updating specific rows
                const intakeIds = g.items.map(i => i.id);

                // Determine mode and time
                const mode = g.status === 'TAKEN' ? 'edit' : 'confirm';
                // Use the group key (which is formatted time) or a raw timestamp if available
                // For editing, we want the actual taken time to populate the input
                let time = g.key;
                if (mode === 'edit' && g.items[0].taken_at) {
                    time = g.items[0].taken_at;
                } else if (g.items[0].scheduled_at) {
                    time = g.items[0].scheduled_at;
                }

                showMedicationConfirmModal(ids, names, time, mode, intakeIds);
            };
        }

        const statusIcon = g.status === 'TAKEN' ? '✅' : (g.status === 'PENDING' ? '⏳' : '❌');
        // Better header formatting
        let headerTime = g.timeLabel;
        if (g.status === 'TAKEN') {
            // If taken, maybe show "Taken at HH:MM"
            // But timeLabel is already formatted.
        }

        const header = document.createElement('div');
        header.className = 'history-header';
        const strong = document.createElement('strong');
        strong.textContent = `${statusIcon} ${headerTime}`;
        header.appendChild(strong);

        const items = document.createElement('div');
        items.className = 'history-items';
        g.items.forEach((l) => {
            const med = medications.find(m => m.id === l.medication_id);
            const medName = med ? med.name : 'Unknown Med';
            const subitem = document.createElement('div');
            subitem.className = 'history-subitem';
            if (l.id !== undefined && l.id !== null) {
                subitem.dataset.intakeId = String(l.id);
            }
            subitem.textContent = medName;
            items.appendChild(subitem);
        });

        div.appendChild(header);
        div.appendChild(items);
        list.appendChild(div);
    });
}

// Logic
async function loadMeds() {
    if (initialAuthLoad) {
        initialAuthLoad = false;
        // medications already set from auth; cache and render immediately
        await window.DataStore.setCached('medications', medications);
        if (window.MedTrackerDB?.MedicationStore) {
            await window.MedTrackerDB.MedicationStore.saveCache(medications);
        }
        renderMeds();
        populateMedFilter();
        // Refresh in background to ensure up-to-date data
        const res = await window.DataStore.fetchFresh(
            'medications',
            async () => await apiCall('/api/medications?archived=true'),
            ['medications']
        );
        if (res) {
            medications = res;
            await window.DataStore.setCached('medications', medications);
            if (window.MedTrackerDB?.MedicationStore) {
                await window.MedTrackerDB.MedicationStore.saveCache(medications);
            }
            renderMeds();
            populateMedFilter();
        }
        return;
    }

    await window.DataStore.loadSWR({
        key: 'medications',
        tags: ['medications'],
        fetcher: async () => await apiCall('/api/medications?archived=true'),
        onCached: async (cached) => {
            medications = cached;
            renderMeds();
            populateMedFilter();
        },
        onFresh: async (fresh) => {
            medications = fresh;
            if (window.MedTrackerDB?.MedicationStore) {
                await window.MedTrackerDB.MedicationStore.saveCache(medications);
            }
            renderMeds();
            populateMedFilter();
        },
        onError: async (_err, cached) => {
            if (cached) return;
            // API failed and no ApiCache hit; fall back to offline cache
            if (window.MedTrackerDB?.MedicationStore) {
                const offlineCached = await window.MedTrackerDB.MedicationStore.getCache();
                if (offlineCached) {
                    console.log('[Meds] Loaded from offline cache:', offlineCached.length);
                    medications = offlineCached;
                    renderMeds();
                    populateMedFilter();
                }
            }
        }
    });
}

function populateMedFilter() {
    const select = document.getElementById('history-filter-med');
    if (!select) return;
    const currentVal = select.value;

    // Keep "All Medications"
    const allOpt = document.createElement('option');
    allOpt.value = "0";
    allOpt.textContent = "All Medications";
    select.replaceChildren(allOpt);

    // Filter to only include meds taken in the last 7 days
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);

    const activeMeds = medications.filter(m => {
        if (!m.last_taken_at) return false;
        const lastTaken = new Date(m.last_taken_at);
        return lastTaken >= cutoffDate;
    });

    // Sort alphabetically
    const sorted = activeMeds.sort((a, b) => a.name.localeCompare(b.name));

    sorted.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name + (m.archived ? ' (Archived)' : '');
        select.appendChild(opt);
    });

    if (Array.from(select.options).some(o => o.value === currentVal)) {
        select.value = currentVal;
    } else {
        select.value = "0";
    }
}

async function saveMedication() {
    const name = document.getElementById('med-name').value;
    const dosage = document.getElementById('med-dosage').value;
    const type = document.getElementById('schedule-type').value;
    const archived = document.getElementById('med-archived').checked;
    const supplement = document.getElementById('med-supplement').checked;

    const startDateRaw = document.getElementById('med-start-date').value;
    const endDateRaw = document.getElementById('med-end-date').value;

    // Inventory tracking
    const trackInventory = document.getElementById('med-track-inventory').checked;
    const inventoryCountRaw = document.getElementById('med-inventory-count').value;
    let inventoryCount = null;
    if (trackInventory && inventoryCountRaw !== '') {
        inventoryCount = parseInt(inventoryCountRaw);
    }

    if (!name) { safeAlert("Name is required!"); return; }

    const schedule = { type: type };

    if (type !== 'as_needed') {
        const times = Array.from(document.querySelectorAll('.med-time-input'))
            .map(i => i.value)
            .filter(v => v !== "");

        if (times.length === 0) {
            safeAlert("At least one time is required!");
            return;
        }
        schedule.times = times;
    }

    if (type === 'weekly') {
        const days = Array.from(document.querySelectorAll('.days-select span.selected'))
            .map(s => parseInt(s.dataset.day));

        if (days.length === 0) {
            safeAlert("Select at least one day!");
            return;
        }
        schedule.days = days;
    }

    const tzShiftPolicy = document.getElementById('med-tz-policy').value || 'flexible';

    const payload = {
        name,
        dosage,
        schedule: JSON.stringify(schedule),
        archived,
        supplement,
        start_date: startDateRaw ? new Date(startDateRaw).toISOString() : null,
        end_date: endDateRaw ? new Date(endDateRaw).toISOString() : null,
        inventory_count: inventoryCount,
        tz_shift_policy: tzShiftPolicy
    };

    const btn = document.getElementById('med-modal-save-btn');
    await withSubmit(btn, async () => {
        let res;
        try {
            if (editingMedId) {
                res = await apiCallDirect(`/api/medications/${editingMedId}`, 'POST', payload);
            } else {
                res = await apiCallDirect('/api/medications', 'POST', payload);
            }
        } catch (e) {
            if (e.status === 409) {
                safeAlert("A medication with this name and dosage already exists. Please use a different name or dosage.");
            } else {
                safeAlert("Error: " + e.message);
            }
            return;
        }

        if (res === null) return; // offline or error — apiCall already showed alert

        if (res.warning) {
            safeAlert("⚠️ " + res.warning);
        }

        await window.DataStore.invalidateTags(['medications', 'history']);
        await window.DataStore.invalidateKey('next_intake');

        closeModal();
        loadMeds();
    });
}

async function deleteMed(id) {
    const med = medications.find(m => m.id === id);
    if (!med) return;

    if (med.archived) {
        const confirmMsg = "Delete this medication permanently?";
        await safeConfirm(confirmMsg, async (ok) => {
            if (ok) {
                const res = await apiCall(`/api/medications/${id}`, 'DELETE');
                if (res !== null) { // Success
                    await window.DataStore.invalidateTags(['medications', 'history']);
                    await window.DataStore.invalidateKey('next_intake');
                    loadMeds();
                } else {
                    // It returns null on error and safeAlert is already handled by apiCall
                    // However, we can add a specific catch-all just in case, or trust apiCall.
                    // Let's trust apiCall since it already alerts the error message.
                }
            }
        });
    } else {
        const confirmMsg = "Archive this medication?";
        await safeConfirm(confirmMsg, async (ok) => {
            if (ok) await _archiveMedApi(id);
        });
    }
}

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

    // UI based on mode
    if (mode === 'edit' || mode === 'log_past') {
        titleEl.innerText = mode === 'edit' ? "Edit Intake" : "Log Intake";
        subtitleEl.innerText = "";
        timeEditEl.style.display = 'block';

        // Set time input (handling both ISO strings and formatted strings if parsable)
        try {
            timeInput.value = formatDateTimeLocalForInput(scheduledAt);
        } catch (e) {
            console.error("Error formatting date for input", e);
        }

        actionBtn.innerText = mode === 'edit' ? "Update" : "Log Intake";
        actionBtn.onclick = mode === 'edit' ? updateIntakeHistory : confirmLogPast;
        snoozeBtn.style.display = 'none';

    } else {

        // Confirm Mode
        titleEl.innerText = "Time for Meds!";
        timeEditEl.style.display = 'none';

        // Format time display
        let timeStr = scheduledAt;
        try {
            const d = new Date(scheduledAt);
            timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) { }
        subtitleEl.innerText = "Scheduled for: " + timeStr;

        actionBtn.innerText = "Confirm Selected";
        actionBtn.onclick = confirmSelectedMedications;
        snoozeBtn.style.display = 'inline-block';

        // Show skip button only for PENDING intakes
        const skipBtn = document.getElementById('med-confirm-skip-btn');
        if (skipBtn) {
            skipBtn.style.display = 'inline-block';
        }
    }

    // Hide skip button if we're not in 'confirm' mode
    if (mode !== 'confirm') {
        const skipBtn = document.getElementById('med-confirm-skip-btn');
        if (skipBtn) {
            skipBtn.style.display = 'none';
        }
    }

    const list = document.getElementById('med-confirm-list');
    list.replaceChildren();

    ids.forEach((id, index) => {
        const name = names[index] || ('Medication ' + id);

        const div = document.createElement('div');
        div.className = 'form-row';
        div.classList.add('mb-sm');

        const label = document.createElement('label');
        label.className = 'checkbox-label';
        label.classList.add('fw-medium');

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = String(index);
        input.checked = true;
        input.className = 'med-confirm-check';

        label.appendChild(input);
        label.appendChild(document.createTextNode(` ${name}`));
        div.appendChild(label);
        list.appendChild(div);
    });
}
