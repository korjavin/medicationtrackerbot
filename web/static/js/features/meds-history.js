// ==================== Medication modal + intake history ====================
// Extracted from app.js (Plan 2026-06-10 "finish-app-js-split", Task 1).
//
// This file owns the medication add/edit modal form helpers, the Meds →
// History sub-tab (history load + next-intake card), and the push-driven
// medication-confirm modal flow (confirm / skip / edit / log-past) with its
// optimistic-cache helpers. These functions remain global (script-tag
// loading) and still rely on app.js + sibling globals: apiCall, safeAlert,
// safeConfirm, withSubmit, formatDate, editingMedId, medications, loadMeds,
// populateMedFilter, renderInventory, renderHistory, loadInventory,
// switchTab, window.DataStore, window.PushModalState, window.ModalManager,
// window.MedTrackerDB, window.WGStaleBadge. The optimistic helpers
// (_applyOptimisticHistoryFlip / _commitOptimistic / _rollbackOptimistic) are
// also reached by features/meds.js via bare name + typeof guards, so they
// stay function-scoped globals here rather than being privatised.
//
// Public surface is mirrored on window.MedsHistory for discoverability; the
// bare function names are the live call path used by app.js bindings and
// inline siblings.

// Refresh the meds view siblings after a mutation (confirm/skip/edit/log-past).
// loadMeds refreshes the schedule data and the `medications` array; loadHistory
// refreshes the history list. Inventory is re-rendered (after loadMeds resolves)
// only when it's the active sub-tab, so stock counts stay correct without
// burning the per-med last-refilled fetch when off-screen.
function refreshMedsAfterMutation() {
    const medsPromise = typeof loadMeds === 'function' ? loadMeds() : null;
    if (typeof loadHistory === 'function') loadHistory();
    if (medsPromise && typeof medsPromise.then === 'function') {
        medsPromise.then(() => {
            const activeMedTab = document.querySelector('.med-tab.active');
            if (activeMedTab && activeMedTab.dataset.tab === 'inventory' &&
                typeof renderInventory === 'function') {
                renderInventory();
            }
        });
    }
}


function showAddModal() {
    editingMedId = null;
    window.ModalManager.med.open();

    setMedModalHeader('Medication', 'New medication');

    // Reset inputs
    document.getElementById('med-name').value = '';
    document.getElementById('med-dosage').value = '';
    document.getElementById('med-archived').checked = false;
    document.getElementById('med-supplement').checked = false;
    document.getElementById('med-rx-display').style.display = 'none';
    // showAddModal updates
    document.getElementById('med-start-date').value = '';
    document.getElementById('med-end-date').value = '';

    // Reset inventory fields
    document.getElementById('med-track-inventory').checked = false;
    document.getElementById('med-inventory-count').value = '';
    document.getElementById('inventory-fields').classList.add('hidden');
    document.getElementById('restock-section').style.display = 'none';
    document.getElementById('restock-history').replaceChildren();

    // Default: Daily, 1 time input
    document.getElementById('schedule-type').value = 'daily';
    document.getElementById('med-tz-policy').value = 'flexible';
    toggleScheduleFields();

    const timeContainer = document.getElementById('time-inputs');
    timeContainer.replaceChildren();
    addTimeInput(); // One empty input

    // Clear days
    document.querySelectorAll('#days-container .days-select span').forEach(s => s.classList.remove('selected'));
}

function setMedModalHeader(eyebrow, title) {
    const eyebrowEl = document.getElementById('med-modal-eyebrow');
    const titleEl = document.getElementById('med-modal-title');
    if (eyebrowEl) eyebrowEl.textContent = eyebrow;
    if (titleEl) titleEl.textContent = title;
}

function closeModal() {
    window.ModalManager.med.close();
}

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

    syncScheduleTypePills(type);
}

function syncScheduleTypePills(activeType) {
    const pills = document.querySelectorAll('.wg-meds-modal__pill');
    pills.forEach((pill) => {
        const isActive = pill.dataset.scheduleType === activeType;
        pill.classList.toggle('wg-gloss--sun', isActive);
        pill.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function setScheduleType(type) {
    const select = document.getElementById('schedule-type');
    if (!select) return;
    if (select.value !== type) select.value = type;
    toggleScheduleFields();
}

function toggleDay(el) {
    el.classList.toggle('selected');
}

function toggleInventoryFields() {
    const trackInventory = document.getElementById('med-track-inventory').checked;
    const inventoryFields = document.getElementById('inventory-fields');
    const restockSection = document.getElementById('restock-section');

    if (trackInventory) {
        inventoryFields.classList.remove('hidden');
        // Only show restock section when editing existing med
        if (editingMedId) {
            restockSection.style.display = 'block';
        } else {
            restockSection.style.display = 'none';
        }
    } else {
        inventoryFields.classList.add('hidden');
    }
}

async function loadRestockHistory(medId) {
    const restocks = await apiCall(`/api/medications/${medId}/restocks`);
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
        const date = formatDate(r.restocked_at);
        const item = document.createElement('li');
        item.textContent = `+${r.quantity} on ${date}${r.note ? ` - ${r.note}` : ''}`;
        list.appendChild(item);
    });

    container.appendChild(list);
}

async function handleRestock() {
    if (!editingMedId) return;

    const qtyInput = document.getElementById('restock-qty');
    const qty = parseInt(qtyInput.value);

    if (!qty || qty <= 0) {
        safeAlert("Please enter a valid quantity");
        return;
    }

    const res = await apiCall(`/api/medications/${editingMedId}/restock`, 'POST', { quantity: qty });
    if (res) {
        // Update displayed count
        document.getElementById('med-inventory-count').value = res.inventory_count;
        qtyInput.value = '';
        loadRestockHistory(editingMedId);
        safeAlert(`Added ${qty} units. New total: ${res.inventory_count}`);
    }
}

// Calculate if medication is low on stock considering end date
function isLowOnStock(med) {
    if (med.inventory_count === null || med.inventory_count === undefined) {
        return false;
    }

    // Calculate daily usage from schedule
    const dailyUsage = calculateDailyUsage(med);
    if (dailyUsage === 0) {
        return false; // Can't calculate for as-needed
    }

    const daysOfStock = med.inventory_count / dailyUsage;

    // If medication has an end date, check if we have enough until then
    if (med.end_date) {
        const endDate = new Date(med.end_date);
        const now = new Date();
        const daysUntilEnd = (endDate - now) / (1000 * 60 * 60 * 24);

        if (daysUntilEnd <= 0) {
            return false; // Already ended
        }

        return daysOfStock < daysUntilEnd;
    }

    // No end date: use 7-day threshold
    return daysOfStock < 7;
}

// Calculate how many doses per day based on schedule
function calculateDailyUsage(med) {
    try {
        const sched = JSON.parse(med.schedule);

        if (sched.type === 'as_needed') {
            return 0;
        }

        const timesPerDay = (sched.times || []).length;

        if (sched.type === 'daily') {
            return timesPerDay;
        }

        if (sched.type === 'weekly') {
            const daysPerWeek = (sched.days || []).length;
            return (daysPerWeek / 7.0) * timesPerDay;
        }

        return 0;
    } catch (e) {
        return 0;
    }
}

function addTimeInput(value = '') {
    const container = document.getElementById('time-inputs');
    const div = document.createElement('div');
    div.className = 'time-row wg-meds-modal__time-row';

    const wrap = document.createElement('div');
    wrap.className = 'wg-gloss--inset wg-meds-modal__input-wrap wg-meds-modal__time-wrap';

    const input = document.createElement('input');
    input.type = 'time';
    input.className = 'med-time-input wg-meds-modal__input';
    input.value = value;
    wrap.appendChild(input);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'wg-icon-btn remove-time wg-meds-modal__remove-time';
    removeButton.setAttribute('aria-label', 'Remove time');
    removeButton.textContent = '×';
    removeButton.addEventListener('click', () => {
        removeTime(removeButton);
    });

    div.appendChild(wrap);
    div.appendChild(removeButton);
    container.appendChild(div);
}

function removeTime(btn) {
    btn.parentElement.remove();
}

async function loadHistory() {
    // Ensure medications are loaded for name resolution
    // populateMedFilter() is called inside loadMeds(), so only call it explicitly
    // when loadMeds() is skipped (medications pre-loaded from bootstrap)
    if (medications.length === 0) await loadMeds();
    else populateMedFilter();

    const days = document.getElementById('history-filter-days').value;
    const medId = document.getElementById('history-filter-med').value;

    const cacheKey = `history_${days}_${medId}`;

    const result = await window.DataStore.loadSWR({
        key: cacheKey,
        tags: ['history'],
        fetcher: async () => await apiCall(`/api/history?days=${days}&med_id=${medId}`),
        allowNullFresh: true,
        onCached: async (cached) => {
            renderHistory(cached);
            await renderMedsHistoryStaleBadge(cacheKey);
        },
        onFresh: async (fresh) => {
            if (fresh && window.MedTrackerDB?.IntakeHistoryStore) {
                await window.MedTrackerDB.IntakeHistoryStore.saveCache(cacheKey, fresh);
            }
            renderHistory(fresh || []);
            await renderMedsHistoryStaleBadge(cacheKey);
        },
        onError: async (_err, cached) => {
            if (!cached) renderHistory([]);
            await renderMedsHistoryStaleBadge(cacheKey);
        }
    });
    renderNextIntakeTrigger();
    return result;
}

// Mounts the wg-stale-badge into the Meds History subtab from the active
// `history_<days>_<medId>` api_cache key. Re-runs whenever the user flips the
// filters because the cache key shifts with them. Mirrors the BP/Weight Task 6
// pattern.
async function renderMedsHistoryStaleBadge(cacheKey) {
    const slot = document.getElementById('meds-history-stale-badge');
    if (!slot) return;
    const api = (typeof window !== 'undefined') ? window.WGStaleBadge : null;
    if (!api || typeof api.mountFromKey !== 'function') {
        slot.replaceChildren();
        slot.classList.add('hidden');
        return;
    }
    await api.mountFromKey({ slot, key: cacheKey });
}

// module-state: holds the next-intake countdown setInterval handle so a
// re-render clears the prior timer before starting a new one.
let _medsHistoryState = { nextIntakeTimer: null }; // module-state: next-intake countdown interval handle

function _formatCountdown(ms) {
    if (ms <= 0) return '0:00';
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}`;
}

async function renderNextIntakeTrigger() {
    const container = document.getElementById('next-intake-trigger');
    if (!container) return;

    if (_medsHistoryState.nextIntakeTimer) {
        clearInterval(_medsHistoryState.nextIntakeTimer);
        _medsHistoryState.nextIntakeTimer = null;
    }

    try {
        // Kick off a refresh as a side-effect. fetchFresh returns null for
        // both "no data" and "superseded by a concurrent invalidation", so we
        // can't use its return value to decide between "render empty" and
        // "leave the card alone". Instead, read the cache afterwards — it
        // reflects whichever fetch most recently won. This avoids wiping a
        // correctly-rendered card when an older, invalidated fetch resolves
        // after a newer one has already populated the cache.
        await window.DataStore.fetchFresh(
            'next_intake',
            fetchNextIntakePayload,
            ['history', 'medications']
        );

        const res = await window.DataStore.getCached('next_intake');

        if (!res || !res.scheduled_at) {
            container.replaceChildren();
            return;
        }

        const nextTime = new Date(res.scheduled_at);
        const medNamesStr = res.medication_names.join(', ');

        // Format the next time
        const timeStr = nextTime.toLocaleString('de-DE', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });

        // Round-2 Task 8 (#11b): restyled to match the Today "Next up" card —
        // elevated-teal surface + muted-uppercase kicker + display-numeric
        // countdown + secondary meta line + shared toolbar-btn primary CTA.
        const card = document.createElement('div');
        card.className = 'wg-meds-next-intake-card';

        const body = document.createElement('div');
        body.className = 'wg-meds-next-intake-card__text';

        const title = document.createElement('div');
        title.className = 'wg-meds-next-intake-card__kicker';
        title.textContent = 'Next scheduled intake';

        const countdown = document.createElement('div');
        countdown.className = 'wg-meds-next-intake-card__time';
        function updateCountdown() {
            countdown.textContent = _formatCountdown(nextTime - Date.now());
        }
        updateCountdown();
        _medsHistoryState.nextIntakeTimer = setInterval(updateCountdown, 30000);

        const details = document.createElement('div');
        details.className = 'wg-meds-next-intake-card__meta';
        details.textContent = `${medNamesStr} at ${timeStr}`;
        body.appendChild(title);
        body.appendChild(countdown);
        body.appendChild(details);

        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'wg-toolbar-btn wg-toolbar-btn--primary wg-meds-next-intake-card__cta';
        const actionLabel = document.createElement('span');
        actionLabel.className = 'wg-toolbar-btn__label';
        actionLabel.textContent = 'Take Now';
        action.appendChild(actionLabel);
        action.addEventListener('click', () => {
            triggerNextIntake();
        });

        card.appendChild(body);
        card.appendChild(action);
        container.replaceChildren(card);
    } catch (e) {
        console.error("Error fetching next intake:", e);
        container.replaceChildren();
    }
}

async function triggerNextIntake() {
    const res = await apiCall('/api/medications/trigger-next-intake', 'POST');
    if (res && res.status === 'confirmed') {
        await window.DataStore.invalidateTags(['history', 'medications', 'gamification']);
        await window.DataStore.invalidateKey('next_intake');
        const medNamesStr = res.medication_names ? res.medication_names.join(', ') : `${res.medication_count} medication(s)`;
        safeAlert(`✅ Confirmed: ${medNamesStr}\n\nScheduled for: ${formatDate(res.scheduled_at)}\nTaken at: ${formatDate(res.taken_at)}`);
        await loadHistory();
    }
}

function closeMedicationConfirmModal() {
    window.ModalManager.medConfirm.close();
}

// Apply `mutator(log) → log|null` against every cached `history_*` payload so
// intake-status mutations (confirm/skip/edit/log-past/delete-future) repaint
// the meds History list synchronously before the POST resolves. Returns an
// array of applyOptimistic handles the caller settles on success/failure.
// Returning `null` from the mutator drops the log (used by deleteFutureIntakes).
async function _applyOptimisticHistoryFlip(mutator) {
    const handles = [];
    if (!window.DataStore || typeof window.DataStore.applyOptimistic !== 'function') {
        return handles;
    }
    const apiCache = window.MedTrackerDB && window.MedTrackerDB.ApiCache;
    if (!apiCache || typeof apiCache.keys !== 'function') return handles;

    let keys = [];
    try { keys = await apiCache.keys('history_'); } catch (_) { keys = []; }
    if (!Array.isArray(keys) || keys.length === 0) return handles;

    for (const key of keys) {
        const handle = await window.DataStore.applyOptimistic(key, (prev) => {
            if (!Array.isArray(prev)) return prev;
            const next = [];
            for (const log of prev) {
                const mapped = mutator(log);
                if (mapped) next.push(mapped);
            }
            return next;
        }, ['history']);
        handles.push(handle);
    }
    return handles;
}

// Patch `next_intake` cache when the just-confirmed/skipped scheduled time
// matches the cached "next" tile. Removes the selected medications from the
// grouped tile by ID — filtering by name would over-evict when two meds share
// the same display name but have different dosages (the backend allows
// duplicate names with distinct dosages and surfaces both in `medication_ids`
// + `medication_names`). If no meds remain at that scheduled time, the tile
// clears entirely (scheduled_at -> null). Without this selectivity, a partial
// confirm of a grouped dose would hide the remaining meds the user still owes.
// Returns a handle (no-op handle if nothing cached or mismatch).
async function _applyOptimisticNextIntakeClear(scheduledAt, selectedIds = []) {
    if (!window.DataStore || typeof window.DataStore.applyOptimistic !== 'function') {
        return { commit: async () => {}, rollback: async () => {} };
    }
    const selectedIdSet = new Set(
        (Array.isArray(selectedIds) ? selectedIds : [])
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id))
    );
    return window.DataStore.applyOptimistic('next_intake', (prev) => {
        if (!prev || typeof prev !== 'object') return prev;
        if (!scheduledAt || prev.scheduled_at !== scheduledAt) return prev;
        const allIds = Array.isArray(prev.medication_ids) ? prev.medication_ids : [];
        const allNames = Array.isArray(prev.medication_names) ? prev.medication_names : [];
        // No ID list to filter (legacy payload missing medication_ids) — fall
        // back to the wholesale clear so the tile doesn't pin a now-actioned
        // dose. Same fallback when the caller didn't supply selectedIds.
        if (allIds.length === 0 || selectedIdSet.size === 0) {
            return { scheduled_at: null, medication_ids: [], medication_names: [] };
        }
        const remainingIds = [];
        const remainingNames = [];
        for (let i = 0; i < allIds.length; i++) {
            const id = Number(allIds[i]);
            if (selectedIdSet.has(id)) continue;
            remainingIds.push(allIds[i]);
            if (i < allNames.length) remainingNames.push(allNames[i]);
        }
        if (remainingIds.length === 0) {
            return { scheduled_at: null, medication_ids: [], medication_names: [] };
        }
        return { ...prev, medication_ids: remainingIds, medication_names: remainingNames };
    }, ['medications', 'history']);
}

// Prepend a freshly-synthesised log into every cached `history_*` payload
// whose filter (range + medId) would include it. Used by confirmLogPast where
// no prior log row exists. `medId` matches the per-med filter; the "0" / "all"
// medId always matches. Range filter is not strictly enforced — the next
// loadHistory() refetch reconciles against authoritative server data.
async function _applyOptimisticHistoryAdd(log, medId) {
    const handles = [];
    if (!window.DataStore || typeof window.DataStore.applyOptimistic !== 'function') {
        return handles;
    }
    const apiCache = window.MedTrackerDB && window.MedTrackerDB.ApiCache;
    if (!apiCache || typeof apiCache.keys !== 'function') return handles;

    let keys = [];
    try { keys = await apiCache.keys('history_'); } catch (_) { keys = []; }
    if (!Array.isArray(keys) || keys.length === 0) return handles;

    for (const key of keys) {
        const parts = key.split('_');
        const keyMedId = parts[2] === undefined || parts[2] === '' ? 0 : Number(parts[2]);
        if (keyMedId !== 0 && keyMedId !== medId) continue;
        const handle = await window.DataStore.applyOptimistic(key, (prev) => {
            const base = Array.isArray(prev) ? prev : [];
            return [log, ...base];
        }, ['history']);
        handles.push(handle);
    }
    return handles;
}

async function _commitOptimistic(handles) {
    for (const h of handles) { try { await h.commit(null); } catch (_) { /* best-effort */ } }
}

async function _rollbackOptimistic(handles) {
    for (const h of handles) { try { await h.rollback(); } catch (_) { /* best-effort */ } }
}

async function confirmSelectedMedications() {
    const checks = document.querySelectorAll('.med-confirm-check:checked');
    const selectedIndices = Array.from(checks).map(c => parseInt(c.value, 10));
    const ids = window.PushModalState.getMedConfirmIds();
    const intakeIds = window.PushModalState.getMedConfirmIntakeIds();
    const selectedIds = selectedIndices.map(idx => Number(ids[idx]));
    const selectedIntakeIds = selectedIndices
        .map(idx => intakeIds[idx])
        .filter(id => id != null);

    const btn = document.getElementById('med-confirm-action-btn');
    await withSubmit(btn, async () => {
        const body = {
            scheduled_at: window.PushModalState.getMedConfirmScheduled(),
            medication_ids: selectedIds
        };
        if (selectedIntakeIds.length > 0) {
            body.intake_ids = selectedIntakeIds;
        }

        // Optimistic: flip the matched intake_log entries to TAKEN in every
        // cached `history_*` payload and clear `next_intake` so the meds
        // History list + Today's next-intake tile repaint before the POST
        // resolves. Mutator runs against each enumerated cache key so users
        // see the green check immediately instead of after the round-trip.
        const takenAt = new Date().toISOString();
        const handles = await _applyOptimisticHistoryFlip((log) => {
            if (!log || typeof log !== 'object') return log;
            const isSelectedIntake = selectedIntakeIds.indexOf(log.id) !== -1;
            const isSelectedMed = selectedIds.indexOf(log.medication_id) !== -1
                && log.status === 'PENDING'
                && log.scheduled_at === body.scheduled_at;
            if (isSelectedIntake || isSelectedMed) {
                return { ...log, status: 'TAKEN', taken_at: takenAt, _optimistic: true };
            }
            return log;
        });
        handles.push(await _applyOptimisticNextIntakeClear(body.scheduled_at, selectedIds));

        let res;
        try {
            res = await apiCall('/api/medications/confirm-schedule', 'POST', body);
        } catch (e) {
            await _rollbackOptimistic(handles);
            throw e;
        }

        if (res) {
            await _commitOptimistic(handles);
            safeAlert("Confirmed!");
            if (window.DataStore) await window.DataStore.invalidateTags(['gamification']).catch(() => {});
            refreshMedsAfterMutation();
        } else {
            await _rollbackOptimistic(handles);
        }

        closeMedicationConfirmModal();
    });
}

async function skipSelectedMedications() {
    const checks = document.querySelectorAll('.med-confirm-check:checked');
    const selectedIndices = Array.from(checks).map(c => parseInt(c.value, 10));

    if (selectedIndices.length === 0) {
        closeMedicationConfirmModal();
        return;
    }

    const btn = document.getElementById('med-confirm-skip-btn');
    await withSubmit(btn, async () => {
        let hasErrors = false;
        const ids = window.PushModalState.getMedConfirmIds();
        const intakeIds = window.PushModalState.getMedConfirmIntakeIds();
        const scheduled = window.PushModalState.getMedConfirmScheduled();
        const selectedMedIds = selectedIndices
            .map(idx => Number(ids[idx]))
            .filter(id => Number.isFinite(id));

        // Resolve intake_ids up-front (from PushModalState or via /api/history
        // fallback for push-notification entries) so we can apply the optimistic
        // SKIPPED flip in one pass before issuing the skip POSTs.
        const resolvedIntakeIds = [];
        const skipRequests = [];
        for (const idx of selectedIndices) {
            const medId = Number(ids[idx]);
            let intakeId = intakeIds[idx];

            if (!intakeId) {
                const pendingLogs = await apiCall(`/api/history?days=1`);
                if (pendingLogs && pendingLogs.length > 0) {
                    const scheduledTime = new Date(scheduled).getTime();
                    const log = pendingLogs.find(l =>
                        l.medication_id === medId &&
                        l.status === 'PENDING' &&
                        Math.abs(new Date(l.scheduled_at).getTime() - scheduledTime) < 60000
                    );
                    if (log) {
                        intakeId = log.id;
                    }
                }
            }

            if (intakeId) {
                resolvedIntakeIds.push(intakeId);
                skipRequests.push(intakeId);
            } else {
                hasErrors = true;
            }
        }

        const handles = await _applyOptimisticHistoryFlip((log) => {
            if (!log || typeof log !== 'object') return log;
            if (resolvedIntakeIds.indexOf(log.id) !== -1) {
                return { ...log, status: 'SKIPPED', _optimistic: true };
            }
            return log;
        });
        handles.push(await _applyOptimisticNextIntakeClear(scheduled, selectedMedIds));

        try {
            for (const intakeId of skipRequests) {
                const res = await apiCall('/api/medications/skip', 'POST', { intake_id: intakeId });
                if (!res) {
                    hasErrors = true;
                }
            }
        } catch (e) {
            await _rollbackOptimistic(handles);
            throw e;
        }

        if (hasErrors) {
            await _rollbackOptimistic(handles);
        } else {
            await _commitOptimistic(handles);
            // SKIPPED is a scored adherence outcome (floor + denominator change),
            // so evict the gamification rings/journey like the confirm/log-past paths.
            if (window.DataStore) await window.DataStore.invalidateTags(['gamification']).catch(() => {});
        }

        refreshMedsAfterMutation();
        if (!hasErrors) {
            safeAlert("Skipped!");
        } else {
            safeAlert("Error skipping some medications.");
        }
        closeMedicationConfirmModal();
    });
}

// Build a user-facing error message for /api/intakes/update partial failures by
// mapping each failed intake id back to its medication name via the modal's
// index-aligned intakeIds/names (PushModalState). Falls back to the raw id when
// the name is unknown. Used by updateIntakeHistory when the handler reports
// `failed > 0` so the user sees *which* med could not be reverted instead of a
// bogus "Updated!".
function _describeIntakeUpdateFailures(failures) {
    const list = Array.isArray(failures) ? failures : [];
    const intakeIds = window.PushModalState.getMedConfirmIntakeIds();
    const names = window.PushModalState.getMedConfirmNames();
    const labels = [];
    for (const f of list) {
        const id = f && f.id != null ? Number(f.id) : null;
        let label = null;
        if (id != null) {
            const idx = intakeIds.findIndex((iid) => Number(iid) === id);
            if (idx !== -1 && names[idx]) label = names[idx];
        }
        labels.push(label || ('intake ' + (id != null ? id : '?')));
    }
    if (labels.length === 0) {
        return "Couldn't update some medications. Please try again.";
    }
    return "Couldn't update: " + labels.join(', ') + ". Please try again.";
}

async function updateIntakeHistory() {
    const checks = document.querySelectorAll('.med-confirm-check');
    const selectedIndices = [];
    const unselectedIndices = [];

    checks.forEach(c => {
        const idx = parseInt(c.value, 10);
        if (c.checked) {
            selectedIndices.push(idx);
        } else {
            unselectedIndices.push(idx);
        }
    });

    const timeInput = document.getElementById('med-confirm-datetime');
    const takenAt = new Date(timeInput.value).toISOString();

    const updates = [];
    const intakeIds = window.PushModalState.getMedConfirmIntakeIds();

    // For selected items (TAKEN)
    selectedIndices.forEach(idx => {
        if (intakeIds[idx]) {
            updates.push({
                id: intakeIds[idx],
                status: 'TAKEN',
                taken_at: takenAt
            });
        }
    });

    // For unselected items (PENDING - Reverting)
    unselectedIndices.forEach(idx => {
        if (intakeIds[idx]) {
            updates.push({
                id: intakeIds[idx],
                status: 'PENDING',
                taken_at: '' // Backend handles null/empty
            });
        }
    });

    if (updates.length === 0) {
        closeMedicationConfirmModal();
        return;
    }

    const btn = document.getElementById('med-confirm-action-btn');
    await withSubmit(btn, async () => {
        // Optimistic: apply each TAKEN/PENDING flip across cached history payloads
        // so the History list reflects the user's choice before the round-trip.
        const updatesById = new Map();
        for (const u of updates) updatesById.set(u.id, u);
        const handles = await _applyOptimisticHistoryFlip((log) => {
            if (!log || typeof log !== 'object') return log;
            const upd = updatesById.get(log.id);
            if (!upd) return log;
            const next = { ...log, status: upd.status, _optimistic: true };
            if (upd.status === 'TAKEN') {
                next.taken_at = upd.taken_at;
            } else {
                next.taken_at = null;
            }
            return next;
        });

        let res;
        try {
            res = await apiCall('/api/intakes/update', 'POST', { updates });
        } catch (e) {
            await _rollbackOptimistic(handles);
            throw e;
        }

        // Interpret the structured response from handleUpdateIntake:
        // `{ updated, failed, failures:[{id, reason}] }`. A legacy empty-body
        // 200 (apiCall coerces it to `true` during a rolling deploy) and a body
        // with `failed === 0` both mean every update persisted. `failed > 0`
        // means at least one revert/confirm did not stick — we must NOT show
        // "Updated!" and must roll the optimistic flip back so the affected rows
        // repaint to their true server status instead of silently lying.
        const isObjRes = res && typeof res === 'object';
        const failed = isObjRes ? (Number(res.failed) || 0) : 0;
        if (res === true || (isObjRes && failed === 0)) {
            await _commitOptimistic(handles);
            safeAlert("Updated!");
            if (window.DataStore) await window.DataStore.invalidateTags(['gamification']).catch(() => {});
            refreshMedsAfterMutation();
        } else if (isObjRes && failed > 0) {
            // Partial/total failure: roll back the optimistic flip, name the
            // medication(s) that did not persist, then refresh from the server
            // so the list shows authoritative status (not the rolled-back guess).
            await _rollbackOptimistic(handles);
            safeAlert(_describeIntakeUpdateFailures(res.failures));
            refreshMedsAfterMutation();
        } else {
            // res is falsy (null = apiCall handled an error internally) — roll
            // back without claiming success.
            await _rollbackOptimistic(handles);
        }
        closeMedicationConfirmModal();
    });
}

async function confirmLogPast() {
    const timeInput = document.getElementById('med-confirm-datetime');
    const takenAt = new Date(timeInput.value).toISOString();

    // In log_past mode, we only support one med at a time for simplicity in this UI
    const medId = window.PushModalState.getMedConfirmIds()[0];

    const btn = document.getElementById('med-confirm-action-btn');
    await withSubmit(btn, async () => {
        // Optimistic: prepend a synthesised TAKEN log into every cached
        // `history_<range>_<medId>` payload that should contain it (the
        // "all meds" filter and the per-med filter for this medId) so the
        // user sees the new entry before /log-past resolves.
        const optimisticLog = {
            id: `local_optimistic_${Date.now()}`,
            medication_id: Number(medId),
            scheduled_at: takenAt,
            taken_at: takenAt,
            status: 'TAKEN',
            _optimistic: true
        };
        const handles = await _applyOptimisticHistoryAdd(optimisticLog, Number(medId));

        let res;
        try {
            res = await apiCall('/api/medications/log-past', 'POST', {
                medication_id: medId,
                taken_at: takenAt
            });
        } catch (e) {
            await _rollbackOptimistic(handles);
            throw e;
        }

        if (!res) {
            await _rollbackOptimistic(handles);
            closeMedicationConfirmModal();
            return;
        }
        await _commitOptimistic(handles);

        if (res) {
            safeAlert("Intake logged!");
            if (window.DataStore) {
                await window.DataStore.invalidateByTag('history');
                await window.DataStore.invalidateByTag('medications');
                await window.DataStore.invalidateByTag('gamification');
            }
            await loadMeds();
            const activeMedTab = document.querySelector('.med-tab.active');
            if (activeMedTab && activeMedTab.dataset.tab === 'inventory' &&
                typeof renderInventory === 'function') {
                renderInventory();
            }
            const historyResult = await loadHistory();
            const newId = res && typeof res.id !== 'undefined' ? res.id : null;
            // Only run the visibility check when the history fetch actually
            // returned an array. If it failed (historyResult.error set or
            // fresh is null), the user is offline/degraded — the POST already
            // succeeded, so don't shout "history did not refresh" at them.
            if (newId !== null && historyResult && Array.isArray(historyResult.fresh)) {
                const found = historyResult.fresh.some((l) => l && typeof l.id === 'number' && l.id === newId);
                if (!found) {
                    if (window.SyncDebug && typeof window.SyncDebug.warn === 'function') {
                        window.SyncDebug.warn('log-past: new intake not visible in history after reload', { id: newId });
                    }
                    if (window.SyncManager && typeof window.SyncManager.showToast === 'function') {
                        window.SyncManager.showToast('Saved, but history did not refresh — pull to refresh', 'error');
                    }
                }
            }
        }

        closeMedicationConfirmModal();
    });
}

function snoozeMedicationConfirm() {
    closeMedicationConfirmModal();
}

// Public surface mirror — bare names above are the live call path; this object
// documents the module's API and satisfies the globals allowlist.
window.MedsHistory = {
    refreshMedsAfterMutation,
    showAddModal,
    setMedModalHeader,
    closeModal,
    toggleScheduleFields,
    setScheduleType,
    toggleDay,
    toggleInventoryFields,
    loadRestockHistory,
    handleRestock,
    isLowOnStock,
    calculateDailyUsage,
    addTimeInput,
    removeTime,
    loadHistory,
    renderMedsHistoryStaleBadge,
    renderNextIntakeTrigger,
    triggerNextIntake,
    closeMedicationConfirmModal,
    confirmSelectedMedications,
    skipSelectedMedications,
    updateIntakeHistory,
    confirmLogPast,
    snoozeMedicationConfirm
};
