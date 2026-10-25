// ==================== Medication modal + intake history ====================
// Extracted from app.js (Plan 2026-06-10 "finish-app-js-split", Task 1).
//
// This file owns the medication add/edit modal form helpers and the
// push-driven medication-confirm modal flow (confirm / skip / edit / log-past)
// with its optimistic-cache helpers. (The Meds History pane and its
// next-intake card are gone — the timeline in features/meds.js replaced them,
// bd med-wi09.3.) These functions remain global (script-tag
// loading) and still rely on app.js + sibling globals: apiCall, safeAlert,
// safeConfirm, withSubmit, formatDate, editingMedId, medications, loadMeds,
// loadTimeline, renderInventory, loadInventory,
// switchTab, window.DataStore, window.PushModalState, window.ModalManager,
// window.MedTrackerDB, and meds.js's timeline flip (_applyOptimisticTimeline /
// _tlPatchRows; its pending-set flip is what Today's Next up reads too). The
// optimistic helpers (_commitOptimistic / _rollbackOptimistic) are also reached by
// features/meds.js via bare name, so they stay function-scoped globals here
// rather than being privatised.
//
// Public surface is mirrored on window.MedsHistory for discoverability; the
// bare function names are the live call path used by app.js bindings and
// inline siblings.

// Refresh the meds view siblings after a mutation (confirm/skip/edit/log-past).
// loadMeds refreshes the schedule data and the `medications` array; loadTimeline
// re-reads the timeline. Inventory is re-rendered (after loadMeds resolves)
// only when it's the active sub-tab, so stock counts stay correct without
// burning the per-med last-refilled fetch when off-screen.
function refreshMedsAfterMutation() {
    const medsPromise = typeof loadMeds === 'function' ? loadMeds() : null;
    if (typeof loadTimeline === 'function') loadTimeline();
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


// Time-zone policy choices for the editor's "Time-zone changes" value row.
const MED_TZ_POLICIES = [
    { value: 'flexible', label: 'Flexible', detail: 'switch immediately or in one step' },
    { value: 'medium', label: 'Medium · 3h', detail: 'shift gradually, max 3h per dose' },
    { value: 'strict', label: 'Strict · 2h', detail: 'very gradual, max 2h per step' },
];

function showAddModal() {
    fillMedEditor(null);
}

// Fill and open the medication editor page (kit M5–M6) for a new medication
// (med = null) or an existing one. showEditModal (meds.js) routes here too.
function fillMedEditor(med) {
    const m = med || {};
    editingMedId = med ? med.id : null;
    window.ModalManager.med.open();

    setMedModalHeader(med ? 'Edit medication' : 'Medication', med ? (m.name || 'Medication') : 'New medication');

    document.getElementById('med-name').value = m.name || '';
    document.getElementById('med-dosage').value = m.dosage || '';
    document.getElementById('med-archived').checked = !!m.archived;
    document.getElementById('med-supplement').checked = !!m.supplement;
    setMedRxMatch(m.normalized_name || '', '');

    setMedDate('med-start-date', m.start_date ? m.start_date.split('T')[0] : '');
    setMedDate('med-end-date', m.end_date ? m.end_date.split('T')[0] : '');

    const hasInventory = m.inventory_count !== null && m.inventory_count !== undefined;
    document.getElementById('med-track-inventory').checked = hasInventory;
    document.getElementById('med-inventory-count').value = hasInventory ? m.inventory_count : '';
    document.getElementById('restock-history').textContent = '';
    toggleInventoryFields();
    if (med && hasInventory) loadRestockHistory(med.id);

    let sched = { type: 'daily', times: [] };
    if (med) {
        try {
            sched = JSON.parse(med.schedule);
        } catch (e) {
            sched = { type: 'daily', times: [med.schedule] }; // legacy format
        }
    }
    setScheduleType(sched.type || 'daily');

    const timeContainer = document.getElementById('time-inputs');
    timeContainer.replaceChildren();
    const times = sched.times && sched.times.length > 0 ? sched.times : [''];
    times.forEach((t) => addTimeInput(t));
    // "Reminders won't fire" under the times when notifications are off (med-ckm5.4).
    window.NotifyPermission?.renderNote(document.getElementById('med-notify-note'));

    window.MedicationUtils.setPickedDays(document.querySelector('#days-container .wg-picks'), sched.days || []);

    setMedTzPolicy(m.tz_shift_policy || 'flexible');

    // Permanent delete is offered only when the domain allows it: an archived
    // med with no history. last_taken_at is the history signal the list
    // carries; a skipped-only history still gets the domain's refusal.
    document.getElementById('med-delete-block').classList.toggle('hidden', !(med && m.archived && !m.last_taken_at));

    if (med && (m.rxcui || m.name)) checkMedRx(m.rxcui, m.normalized_name);
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
    document.getElementById('days-container').classList.toggle('hidden', type !== 'weekly');
    document.getElementById('times-container').classList.toggle('hidden', type === 'as_needed');
    syncScheduleTypePills(type);
}

function syncScheduleTypePills(activeType) {
    document.querySelectorAll('#med-modal [data-schedule-type]').forEach((opt) => {
        opt.setAttribute('aria-pressed', opt.dataset.scheduleType === activeType ? 'true' : 'false');
    });
}

function setScheduleType(type) {
    const field = document.getElementById('schedule-type');
    if (!field) return;
    field.value = type;
    toggleScheduleFields();
}

function toggleInventoryFields() {
    const track = document.getElementById('med-track-inventory').checked;
    document.getElementById('inventory-fields').classList.toggle('hidden', !track);
    // Restock history exists only for a saved medication; refills live on the Stock tab.
    document.getElementById('restock-section').classList.toggle('hidden', !(track && editingMedId));
}

// The stock stepper. It never steps below zero; a negative ("N over") count
// only steps up.
function stepMedInventory(delta) {
    const input = document.getElementById('med-inventory-count');
    const cur = parseInt(input.value, 10) || 0;
    input.value = String(delta < 0 && cur <= 0 ? cur : cur + delta);
}

async function loadRestockHistory(medId) {
    const restocks = await apiCall(`/api/medications/${medId}/restocks`);
    const desc = document.getElementById('restock-history');
    desc.textContent = (!restocks || restocks.length === 0)
        ? 'No restocks logged yet.'
        : restocks.slice(0, 3).map((r) => `+${r.quantity} on ${formatDate(r.restocked_at)}`).join(' · ');
}

// Start/End value rows: the hidden date input is only the picker the row
// opens (kit rule 7); the row shows its value.
function setMedDate(inputId, value) {
    const input = document.getElementById(inputId);
    input.value = value || '';
    input.classList.remove('wg-meds-editor__date-input--shown');
    input.setAttribute('tabindex', '-1');
    syncMedDateLabel(inputId);
}

function syncMedDateLabel(inputId) {
    const input = document.getElementById(inputId);
    const label = document.getElementById(`${inputId}-value`);
    label.textContent = input.value || label.dataset.empty;
    label.classList.toggle('wg-muted', !input.value);
    label.classList.toggle('wg-mono', !!input.value);
}

function openMedDatePicker(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    if (typeof input.showPicker === 'function') {
        try { input.showPicker(); return; } catch (_) { /* fall back below */ }
    }
    // No programmatic picker: reveal the input itself as an editable field.
    input.classList.add('wg-meds-editor__date-input--shown');
    input.removeAttribute('tabindex');
    input.focus();
}

function setMedTzPolicy(value) {
    const policy = MED_TZ_POLICIES.find((p) => p.value === value) || MED_TZ_POLICIES[0];
    document.getElementById('med-tz-policy').value = policy.value;
    document.getElementById('med-tz-policy-value').textContent = policy.label;
}

async function chooseMedTzPolicy() {
    const current = document.getElementById('med-tz-policy').value;
    const picked = await safeChoose('How doses shift when you travel across time zones.',
        MED_TZ_POLICIES.map((p) => ({ value: p.value, label: `${p.label} — ${p.detail}`, selected: p.value === current })),
        { title: 'Time-zone changes' });
    if (picked) setMedTzPolicy(picked);
}

// Rx chip + inline interaction warning (kit M5). The check runs when the name
// is committed and when an existing med opens, so the interaction shows
// before Save; saveMedication's post-save alert is only the fallback for a
// check that never resolved.
function setMedRxMatch(normalizedName, warning) {
    document.getElementById('med-rx-name').textContent = normalizedName ? `Rx · ${normalizedName}` : '';
    document.getElementById('med-rx-display').classList.toggle('hidden', !normalizedName);
    document.getElementById('med-rx-warning-text').textContent = warning || '';
    document.getElementById('med-rx-warning').classList.toggle('hidden', !warning);
}

async function checkMedRx(rxcui, knownName) {
    const nameInput = document.getElementById('med-name');
    const name = nameInput.value.trim();
    // A committed name change drops the previous drug's match up front, so a
    // failed lookup never leaves it under the new name.
    if (!name || !knownName) setMedRxMatch('', '');
    if (!name) return;
    const params = new URLSearchParams({ name });
    if (rxcui) params.set('rxcui', rxcui);
    if (editingMedId) params.set('exclude_id', String(editingMedId));
    const call = window.offlineAwareApiCall || window.apiCallDirect;
    let res;
    try {
        res = await call(`/api/medications/rx-check?${params}`, 'GET');
    } catch (_) {
        return; // offline or no lookup: no chip change, Save still works
    }
    // A newer name supersedes this answer.
    if (!res || nameInput.value.trim() !== name) return;
    setMedRxMatch(res.normalized_name || knownName || '', res.warning || '');
}

// The editor's destructive footer action; deleteMed owns the dialog + write.
async function deleteMedFromEditor() {
    const id = editingMedId;
    if (id && await deleteMed(id)) closeModal();
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

// Single source of stock wording/state for every renderer.
// Negative stock (more taken than recorded) reads "Out · N over".
function formatStock(count, med) {
    if (count < 0) return { label: `Out \u00B7 ${-count} over`, state: 'danger' };
    if (count === 0) return { label: 'Out', state: 'danger' };
    if (med && isLowOnStock(med)) return { label: `${count} left`, state: 'warn' };
    return { label: `${count} left`, state: 'ok' };
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

// One dose-time row in the editor's times list (kit M5): clock lead, the
// time input, Remove. Without a value WebKit draws the input blank, so the row
// says "Set time" (sun) until one is picked (med-fhil, kit O3): the input sits
// invisibly over that label, so a tap lands on it and opens the picker.
function addTimeInput(value = '') {
    const row = document.createElement('div');
    row.className = 'wg-row time-row';

    const lead = document.createElement('span');
    lead.className = 'wg-row__lead';
    const clock = document.createElement('i');
    clock.className = 'wg-ico';
    clock.dataset.icon = 'clock';
    lead.appendChild(clock);

    const body = document.createElement('span');
    body.className = 'wg-row__body wg-meds-editor__timebody';
    const unset = document.createElement('span');
    unset.className = 'wg-meds-editor__unset';
    const unsetTitle = document.createElement('span');
    unsetTitle.className = 'wg-row__title';
    const sun = document.createElement('span');
    sun.className = 'wg-sun';
    sun.textContent = 'Set time';
    unsetTitle.appendChild(sun);
    const unsetMeta = document.createElement('span');
    unsetMeta.className = 'wg-row__meta';
    unsetMeta.textContent = 'Tap to choose · not saved yet';
    unset.append(unsetTitle, unsetMeta);
    const input = document.createElement('input');
    input.type = 'time';
    input.className = 'med-time-input wg-meds-editor__time';
    input.setAttribute('aria-label', 'Dose time');
    input.value = value;
    const sync = () => {
        const empty = !input.value;
        row.classList.toggle('is-unset', empty);
        lead.classList.toggle('wg-row__lead--sun', empty);
    };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    // Desktop Chrome only focuses a segment on click; open the picker there.
    input.addEventListener('click', () => {
        if (input.value || typeof input.showPicker !== 'function') return;
        try { input.showPicker(); } catch (_) { /* the tap already focused it */ }
    });
    sync();
    body.append(unset, input);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'wg-btn wg-btn--ghost wg-btn--icon wg-btn--sm remove-time';
    removeButton.setAttribute('aria-label', 'Remove time');
    const x = document.createElement('i');
    x.className = 'wg-ico';
    x.dataset.icon = 'x';
    removeButton.appendChild(x);
    removeButton.addEventListener('click', () => removeTime(removeButton));

    row.append(lead, body, removeButton);
    if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(row);
    document.getElementById('time-inputs').appendChild(row);
}

function removeTime(btn) {
    btn.closest('.time-row').remove();
}

function closeMedicationConfirmModal() {
    window.ModalManager.medConfirm.close();
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

async function _commitOptimistic(handles) {
    for (const h of handles) { try { await h.commit(null); } catch (_) { /* best-effort */ } }
}

async function _rollbackOptimistic(handles) {
    for (const h of handles) { try { await h.rollback(); } catch (_) { /* best-effort */ } }
}

// The sheet's explicit occIds (bd med-wi09.2), index-aligned with its meds:
// the row's own id when the opener had one, else the slot's deterministic id
// `intake-<medId>-<slotUnix>` (the record-id convention the projection's
// forecast rows carry as occId) — an exact dose, never a guess.
function _medConfirmOccId(idx) {
    const ids = window.PushModalState.getMedConfirmIds();
    const intakeIds = window.PushModalState.getMedConfirmIntakeIds();
    if (intakeIds[idx] != null) return intakeIds[idx];
    const slotSec = Math.floor(Date.parse(window.PushModalState.getMedConfirmScheduled()) / 1000);
    return Number.isFinite(slotSec) && ids[idx] != null ? `intake-${ids[idx]}-${slotSec}` : null;
}

function _medConfirmOccIds(indices) {
    return indices.map(_medConfirmOccId).filter((id) => id != null);
}

// POST /api/doses/act — {updated, unchanged, failed, failures}. Returns true
// when every id applied; false otherwise (a falsy res means apiCall already
// surfaced the error; per-id failures are toasted here).
async function _actOnDoses(action, occIds, takenAt, extra = {}) {
    const body = { ...extra, action, occ_ids: occIds };
    if (takenAt) body.taken_at = takenAt;
    const res = await apiCall('/api/doses/act', 'POST', body);
    if (!res || typeof res !== 'object') return false;
    if (Number(res.failed) > 0) {
        safeToast(_describeIntakeUpdateFailures(res.failures), 'error');
        return false;
    }
    return true;
}

async function confirmSelectedMedications() {
    const checks = document.querySelectorAll('#med-confirm-list .med-confirm-check[aria-pressed="true"]');
    const selectedIndices = Array.from(checks).map(c => parseInt(c.dataset.index, 10));
    const ids = window.PushModalState.getMedConfirmIds();
    const selectedIds = selectedIndices.map(idx => Number(ids[idx]));
    const occIds = _medConfirmOccIds(selectedIndices);
    const scheduled = window.PushModalState.getMedConfirmScheduled();

    const btn = document.getElementById('med-confirm-action-btn');
    await withSubmit(btn, async () => {
        if (occIds.length === 0) {
            closeMedicationConfirmModal();
            return;
        }
        // "Time taken" row: sent only when the user picked a time; otherwise
        // the domain stamps now.
        const timeInput = document.getElementById('med-confirm-datetime');
        const pickedMs = timeInput && timeInput.dataset.edited ? new Date(timeInput.value).getTime() : NaN;
        const pickedIso = Number.isFinite(pickedMs) ? new Date(pickedMs).toISOString() : undefined;

        // Optimistic: flip exactly the acted rows to taken on the timeline
        // and the pending set, clear `next_intake`, so the timeline, the Meds
        // badge + Today repaint before the POST resolves.
        const takenAt = pickedIso || new Date().toISOString();
        const handles = [await _applyOptimisticTimeline(_tlPatchRows(
            new Map(occIds.map((id) => [String(id), { state: 'taken', takenAt }]))))];
        handles.push(await _applyOptimisticNextIntakeClear(scheduled, selectedIds));

        let ok;
        try {
            ok = await _actOnDoses('take', occIds, pickedIso);
        } catch (e) {
            await _rollbackOptimistic(handles);
            throw e;
        }

        if (ok) {
            await _commitOptimistic(handles);
            safeToast("Confirmed!", 'info');
            if (window.DataStore) await window.DataStore.invalidateTags(['gamification']).catch(() => {});
            refreshMedsAfterMutation();
        } else {
            await _rollbackOptimistic(handles);
        }

        closeMedicationConfirmModal();
    });
}

async function skipSelectedMedications() {
    const checks = document.querySelectorAll('#med-confirm-list .med-confirm-check[aria-pressed="true"]');
    const selectedIndices = Array.from(checks).map(c => parseInt(c.dataset.index, 10));

    if (selectedIndices.length === 0) {
        closeMedicationConfirmModal();
        return;
    }

    const btn = document.getElementById('med-confirm-skip-btn');
    await withSubmit(btn, async () => {
        const ids = window.PushModalState.getMedConfirmIds();
        const scheduled = window.PushModalState.getMedConfirmScheduled();
        const selectedMedIds = selectedIndices
            .map(idx => Number(ids[idx]))
            .filter(id => Number.isFinite(id));
        // Explicit occIds (bd med-wi09.2) — no nearest-PENDING lookup.
        const occIds = _medConfirmOccIds(selectedIndices);

        const handles = [await _applyOptimisticTimeline(_tlPatchRows(
            new Map(occIds.map((id) => [String(id), { state: 'skipped', takenAt: null }]))))];
        handles.push(await _applyOptimisticNextIntakeClear(scheduled, selectedMedIds));

        let ok;
        try {
            ok = occIds.length > 0 && await _actOnDoses('skip', occIds);
        } catch (e) {
            await _rollbackOptimistic(handles);
            throw e;
        }

        if (ok) {
            await _commitOptimistic(handles);
            // SKIPPED is a scored adherence outcome (floor + denominator change),
            // so evict the gamification rings/journey like the confirm/log-past paths.
            if (window.DataStore) await window.DataStore.invalidateTags(['gamification']).catch(() => {});
            safeToast("Skipped!", 'info');
        } else {
            await _rollbackOptimistic(handles);
        }

        refreshMedsAfterMutation();
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
    const names = window.PushModalState.getMedConfirmNames();
    const labels = [];
    for (const f of list) {
        const id = f && f.id != null ? String(f.id) : null;
        let label = null;
        if (id != null) {
            const idx = names.findIndex((_, i) => String(_medConfirmOccId(i)) === id);
            if (idx !== -1 && names[idx]) label = names[idx];
        }
        labels.push(label || ('intake ' + (id != null ? id : '?')));
    }
    if (labels.length === 0) {
        return "Couldn't update some medications. Please try again.";
    }
    return "Couldn't update: " + labels.join(', ') + ". Please try again.";
}

// Edit sheet (MT3, bd med-wi09.17): the checked doses take the segment's
// state — Taken (at the picked time), Skipped or Not taken — on their own
// occIds; unchecked doses stay as they were. Each dose's current state (the
// choice's data-state, default taken) decides the explicit actions: leaving
// taken/skipped is an undo first, then take or skip; a taken dose that stays
// taken only gets its time edited, and only once the user picked a time.
async function updateIntakeHistory() {
    const targetOpt = document.querySelector('#med-confirm-state [data-dose-state][aria-pressed="true"]');
    const target = targetOpt ? targetOpt.dataset.doseState : 'taken';
    const timeInput = document.getElementById('med-confirm-datetime');
    const takenMs = new Date(timeInput.value).getTime();
    const takenAt = Number.isFinite(takenMs) ? new Date(takenMs).toISOString() : null;
    const intakeIds = window.PushModalState.getMedConfirmIntakeIds();

    const plan = { undo: [], take: [], skip: [], edit_time: [] };
    const patches = new Map();
    document.querySelectorAll('#med-confirm-list .med-confirm-check[aria-pressed="true"]').forEach((c) => {
        const id = intakeIds[parseInt(c.dataset.index, 10)];
        if (id == null) return;
        const raw = c.dataset.state || 'taken';
        const from = raw === 'taken' || raw === 'skipped' ? raw : 'pending';
        if (from === target) {
            // A group's doses keep their own times unless the user picked one.
            if (target !== 'taken' || !takenAt || !timeInput.dataset.edited) return;
            plan.edit_time.push(id);
        } else {
            if (from !== 'pending') plan.undo.push(id);
            if (target === 'taken') plan.take.push(id);
            if (target === 'skipped') plan.skip.push(id);
        }
        patches.set(String(id), target === 'taken' ? { state: 'taken', takenAt }
            : { state: target === 'skipped' ? 'skipped' : 'due', takenAt: null });
    });

    if (patches.size === 0) {
        closeMedicationConfirmModal();
        return;
    }

    const btn = document.getElementById('med-confirm-action-btn');
    await withSubmit(btn, async () => {
        const handles = [await _applyOptimisticTimeline(_tlPatchRows(patches))];

        // Any failed id rolls the whole flip back and names the med(s) that
        // did not persist (_actOnDoses toasts); refreshMedsAfterMutation then
        // repaints authoritative state either way.
        let ok = true;
        try {
            for (const action of ['undo', 'take', 'skip', 'edit_time']) {
                const at = action === 'take' || action === 'edit_time' ? takenAt : undefined;
                if (ok && plan[action].length) ok = await _actOnDoses(action, plan[action], at);
            }
        } catch (e) {
            await _rollbackOptimistic(handles);
            throw e;
        }

        if (ok) {
            await _commitOptimistic(handles);
            safeToast("Updated!", 'info');
            if (window.DataStore) await window.DataStore.invalidateTags(['gamification']).catch(() => {});
        } else {
            await _rollbackOptimistic(handles);
        }
        refreshMedsAfterMutation();
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
        // Optimistic: a synthesised taken row joins the timeline so the user
        // sees the new entry before /log-past resolves.
        const handles = [await _applyOptimisticTimeline((rows) => [...rows, _tlManualRow(medId, takenAt)])];

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
            safeToast("Intake logged!", 'info');
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
            const timelineRows = typeof loadTimeline === 'function' ? await loadTimeline() : null;
            const newId = res && typeof res.id !== 'undefined' ? res.id : null;
            // Only run the visibility check when the timeline read actually
            // returned rows. If it failed (null), the user is offline/degraded —
            // the POST already succeeded, so don't shout "did not refresh".
            // The timeline reads a window (bd med-ry7b): a log older than its
            // first day is not in it by design.
            const inWindow = typeof _medsTimelineState === 'undefined'
                || Date.parse(takenAt) >= Date.now() - (_medsTimelineState.back + MEDS_TIMELINE_PAGE_DAYS) * 86400000;
            if (newId !== null && Array.isArray(timelineRows) && inWindow) {
                const found = timelineRows.some((r) => r && String(r.occId) === String(newId));
                if (!found) {
                    if (window.SyncDebug && typeof window.SyncDebug.warn === 'function') {
                        window.SyncDebug.warn('log-past: new intake not visible in the timeline after reload', { id: newId });
                    }
                    if (window.SyncManager && typeof window.SyncManager.showToast === 'function') {
                        window.SyncManager.showToast('Saved, but the timeline did not refresh — pull to refresh', 'error');
                    }
                }
            }
        }

        closeMedicationConfirmModal();
    });
}

// "Snooze 10m" (bd med-4j49): the checked doses get snoozed_until on their
// own occIds; the row shows "Snoozed until HH:MM" and leaves the due list
// until the snooze ends (the dose clock repaints it then).
const MED_SNOOZE_MINUTES = 10;
async function snoozeMedicationConfirm() {
    const checks = document.querySelectorAll('#med-confirm-list .med-confirm-check[aria-pressed="true"]');
    const occIds = _medConfirmOccIds(Array.from(checks).map(c => parseInt(c.dataset.index, 10)));
    if (occIds.length === 0) {
        closeMedicationConfirmModal();
        return;
    }

    const btn = document.getElementById('med-confirm-snooze-btn');
    await withSubmit(btn, async () => {
        const snoozedUntil = new Date(Date.now() + MED_SNOOZE_MINUTES * 60 * 1000).toISOString();
        const handles = [await _applyOptimisticTimeline(_tlPatchRows(
            new Map(occIds.map((id) => [String(id), { state: 'snoozed', snoozedUntil }]))))];

        let ok;
        try {
            ok = await _actOnDoses('snooze', occIds, undefined, { minutes: MED_SNOOZE_MINUTES });
        } catch (e) {
            await _rollbackOptimistic(handles);
            throw e;
        }

        if (ok) {
            await _commitOptimistic(handles);
            safeToast(`Snoozed for ${MED_SNOOZE_MINUTES} minutes`, 'info');
        } else {
            await _rollbackOptimistic(handles);
        }

        refreshMedsAfterMutation();
        closeMedicationConfirmModal();
    });
}

// Public surface mirror — bare names above are the live call path; this object
// documents the module's API and satisfies the globals allowlist.
window.MedsHistory = {
    refreshMedsAfterMutation,
    showAddModal,
    fillMedEditor,
    setMedModalHeader,
    closeModal,
    toggleScheduleFields,
    setScheduleType,
    toggleInventoryFields,
    stepMedInventory,
    loadRestockHistory,
    setMedDate,
    syncMedDateLabel,
    openMedDatePicker,
    setMedTzPolicy,
    chooseMedTzPolicy,
    setMedRxMatch,
    checkMedRx,
    deleteMedFromEditor,
    isLowOnStock,
    formatStock,
    calculateDailyUsage,
    addTimeInput,
    removeTime,
    closeMedicationConfirmModal,
    confirmSelectedMedications,
    skipSelectedMedications,
    updateIntakeHistory,
    confirmLogPast,
    snoozeMedicationConfirm
};
