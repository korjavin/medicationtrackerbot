// ==================== Medication render + modal flow ====================
// Extracted from app.js in Phase 5 Task 1. These functions remain global
// (script-tag loading) and still rely on app.js helpers (parseMedicationSchedule,
// getNextScheduledDate, getMedicationScheduleText, getLastTakenTimeMs,
// isLowOnStock, formatDate, apiCall, withSubmit, safeAlert, safeConfirm,
// editingMedId, medications, initialAuthLoad, etc.) that
// remain in app.js.

// Sub-tab state (Phase 5, Task 2; revised Task 5; round-2 Task 4).
// Scoped to sessionStorage so every fresh launch lands on the History
// default (matching the Claude Design mockup). A user's in-session tab
// click still survives reloads within the same tab — it just doesn't
// leak across sessions. Legacy mt-meds-subtab localStorage values are
// cleared on boot so previously-saved "schedule"/"inventory" choices
// don't keep overriding the history default.
const MEDS_SUBTAB_STORAGE_KEY = 'mt-meds-subtab';
const MEDS_SUBTAB_OPTIONS = ['schedule', 'history', 'inventory'];
const MEDS_SUBTAB_DEFAULT = 'history';

function getActiveMedsSubTab() {
    try {
        const raw = window.sessionStorage.getItem(MEDS_SUBTAB_STORAGE_KEY);
        if (MEDS_SUBTAB_OPTIONS.indexOf(raw) !== -1) return raw;
    } catch (_) { /* ignore */ }
    return MEDS_SUBTAB_DEFAULT;
}

function setActiveMedsSubTab(tab) {
    if (MEDS_SUBTAB_OPTIONS.indexOf(tab) === -1) return;
    try { window.sessionStorage.setItem(MEDS_SUBTAB_STORAGE_KEY, tab); } catch (_) { /* ignore */ }
}

try { window.localStorage.removeItem(MEDS_SUBTAB_STORAGE_KEY); } catch (_) { /* ignore */ }

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
    syncMedsSubTabActiveClass(getActiveMedsSubTab());
}

// On boot, sync the pill-strip active classes to the stored sub-tab so the
// strip paints in the right state the first time the Meds view is shown.
// Data loads are deferred to switchTab('meds'), which calls switchMedTab with
// the stored tab — firing a load before auth finishes would race with the
// bootstrap and emit spurious 401s.
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

    if (typeof setMedModalHeader === 'function') {
        setMedModalHeader('Edit medication', med.name || 'Medication');
    }

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

// Relative-time formatter shared between the Schedule hour-header rows and
// the Today dashboard. Round-2 Task 4 dropped the Schedule-tab next-action
// card (it duplicated the History/Today next-intake surface), so this helper
// is no longer invoked from a card — it still backs `_formatHourHeader`.
function _formatNextActionRelative(diffMs) {
    if (diffMs <= 0) return 'overdue';
    const totalMinutes = Math.round(diffMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `in ${hours}h ${minutes}m`;
    if (hours > 0) return `in ${hours}h`;
    return `in ${minutes}m`;
}

// Schedule sub-tab render (Phase 5, Task 4). Scheduled meds group by
// hour-of-day under `.wg-section-label` headers, then fall back to
// As-needed and Archived buckets rendered as separate sections. Each
// row is a `.wg-card` with the med name (mono), dosage, schedule
// summary, optional inventory tag, and a trailing icon cluster
// (Log / Edit / Delete). Existing `.med-item` / `.icon-action-btn` /
// `.btn-sm` classes are preserved on the new nodes so legacy tests
// that walk the row with those selectors still pass.

function _formatHourHeader(date, now) {
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const rel = _formatNextActionRelative(date.getTime() - now.getTime());
    return `${hh}:${mm} · ${rel}`;
}

function _hourKey(date) {
    // Calendar-day + hour-of-day key so doses that fall on the next
    // day's 08:00 do not collapse into today's 08:00 group.
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
}

function _buildMedsSectionLabel(text) {
    const el = document.createElement('div');
    el.className = 'wg-section-label wg-meds-section-label';
    const span = document.createElement('span');
    span.textContent = text;
    el.appendChild(span);
    return el;
}

function _buildMedsLogButton(med) {
    // `.btn-sm` is kept on the Log button so the existing UI tests that
    // click `.btn-sm` on a row still find it (see
    // tests/app.medication-history.test.js). Visually it reads as a
    // mono-label `.wg-gloss` pill alongside the icon cluster.
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-sm wg-gloss wg-meds-row__log-btn';
    btn.textContent = 'Log';
    btn.addEventListener('click', () => {
        logMedicationPast(med.id, med.name);
    });
    return btn;
}

function _buildMedsInventoryTag(med) {
    // Renders both the OK and LOW state as a `.wg-tag--mono` pill; the
    // low-stock variant also carries `.wg-tag--alert` so the alert color
    // tokens apply. The emoji `⚠️` is kept inside the label because
    // existing tests grep for it to confirm low-stock rendering.
    const isLow = isLowOnStock(med);
    const tag = document.createElement('span');
    tag.className = 'wg-tag wg-tag--mono inventory-badge wg-meds-row__inventory';
    if (isLow) {
        tag.classList.add('wg-tag--alert');
        tag.classList.add('low');
        tag.textContent = `${med.inventory_count} left ⚠️`;
    } else {
        tag.classList.add('wg-tag--normal');
        tag.textContent = `${med.inventory_count} left`;
    }
    return tag;
}

function _buildMedsRow(med, parsedSchedule) {
    const row = document.createElement('div');
    row.className = 'wg-card wg-meds-row med-item';
    row.dataset.medId = String(med.id);
    if (med.archived) row.classList.add('archived');

    const info = document.createElement('div');
    info.className = 'wg-meds-row__info med-info cursor-pointer';
    info.addEventListener('click', () => showEditModal(med.id));

    const titleRow = document.createElement('div');
    titleRow.className = 'wg-meds-row__title';
    const name = document.createElement('span');
    name.className = 'wg-meds-row__name wg-mono-display';
    name.textContent = med.name;
    titleRow.appendChild(name);
    if (med.dosage) {
        const dosage = document.createElement('span');
        dosage.className = 'wg-meds-row__dosage';
        dosage.textContent = med.dosage;
        titleRow.appendChild(dosage);
    }
    if (med.supplement) {
        const supplementBadge = document.createElement('span');
        supplementBadge.className = 'wg-tag wg-tag--mono wg-meds-row__supplement med-supplement-badge';
        supplementBadge.textContent = 'Supplement';
        titleRow.appendChild(supplementBadge);
    }
    info.appendChild(titleRow);

    const scheduleLine = document.createElement('div');
    scheduleLine.className = 'wg-meds-row__schedule';
    scheduleLine.textContent = getMedicationScheduleText(med, parsedSchedule);
    info.appendChild(scheduleLine);

    if (med.normalized_name) {
        const normalized = document.createElement('div');
        normalized.className = 'wg-meds-row__rx med-normalized-name';
        normalized.textContent = `Rx: ${med.normalized_name}`;
        info.appendChild(normalized);
    }

    if (med.start_date || med.end_date) {
        const start = med.start_date ? formatDate(med.start_date).split(' ')[0] : 'N/A';
        const end = med.end_date ? formatDate(med.end_date).split(' ')[0] : 'N/A';
        const dates = document.createElement('div');
        dates.className = 'wg-meds-row__dates';
        dates.textContent = `${start} – ${end}`;
        info.appendChild(dates);
    }

    if (med.inventory_count !== null && med.inventory_count !== undefined) {
        info.appendChild(_buildMedsInventoryTag(med));
    }

    const actions = document.createElement('div');
    actions.className = 'wg-meds-row__actions med-actions';
    actions.appendChild(_buildMedsLogButton(med));

    const actionIcons = document.createElement('div');
    actionIcons.className = 'wg-meds-row__action-icons med-action-icons';
    actionIcons.appendChild(createEditButton(() => showEditModal(med.id)));
    actionIcons.appendChild(createDeleteButton(() => deleteMed(med.id)));
    actions.appendChild(actionIcons);

    row.appendChild(info);
    row.appendChild(actions);
    return row;
}

function renderMeds() {
    const list = document.getElementById('med-list');
    list.replaceChildren();
    const now = new Date();

    const scheduledEntries = [];
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
            return;
        }

        const next = getNextScheduledDate(schedule, now);
        scheduledEntries.push({ med, schedule, next });
    });

    // Bucket scheduled entries by hour of next dose. Entries with no
    // computable next dose fall into a generic "Scheduled" bucket at
    // the end of the scheduled section.
    const hourBuckets = new Map(); // key -> { date, label, entries }
    const scheduledNoNext = [];

    scheduledEntries.forEach((entry) => {
        if (!entry.next) {
            scheduledNoNext.push(entry);
            return;
        }
        const key = _hourKey(entry.next);
        if (!hourBuckets.has(key)) {
            const hourStart = new Date(entry.next);
            hourStart.setMinutes(0, 0, 0);
            hourBuckets.set(key, {
                hourStart,
                earliest: entry.next,
                entries: []
            });
        }
        const bucket = hourBuckets.get(key);
        if (entry.next < bucket.earliest) bucket.earliest = entry.next;
        bucket.entries.push(entry);
    });

    const sortedBuckets = Array.from(hourBuckets.values())
        .sort((a, b) => a.earliest - b.earliest);

    const sortByTaken = (a, b) => getLastTakenTimeMs(b.med) - getLastTakenTimeMs(a.med);

    sortedBuckets.forEach((bucket) => {
        bucket.entries.sort((a, b) => (a.next || 0) - (b.next || 0));
        const headerText = _formatHourHeader(bucket.earliest, now);
        list.appendChild(_buildMedsSectionLabel(headerText));
        bucket.entries.forEach(({ med, schedule }) => {
            list.appendChild(_buildMedsRow(med, schedule));
        });
    });

    if (scheduledNoNext.length > 0) {
        scheduledNoNext.sort(sortByTaken);
        list.appendChild(_buildMedsSectionLabel('Scheduled'));
        scheduledNoNext.forEach(({ med, schedule }) => {
            list.appendChild(_buildMedsRow(med, schedule));
        });
    }

    if (asNeeded.length > 0) {
        asNeeded.sort(sortByTaken);
        list.appendChild(_buildMedsSectionLabel('As needed'));
        asNeeded.forEach(({ med, schedule }) => {
            list.appendChild(_buildMedsRow(med, schedule));
        });
    }

    if (archived.length > 0) {
        archived.sort(sortByTaken);
        list.appendChild(_buildMedsSectionLabel('Archived'));
        archived.forEach(({ med, schedule }) => {
            list.appendChild(_buildMedsRow(med, schedule));
        });
    }
}

function logMedicationPast(id, name) {
    showMedicationConfirmModal([id], [name], new Date(), 'log_past');
}


// Meds history render (Phase 5, Task 5). Logs are grouped twice — first by
// minute-precision cluster (so simultaneous intakes collapse into a single
// card that can be edited/confirmed in one action, matching the legacy
// group-click contract), then those clusters are bucketed by local day so
// each day can carry its own `.wg-section-label` header. Each cluster is a
// `.wg-card` row with the med names (mono-display), the trailing ISO-local
// time, an edit `.wg-icon-btn`, and a `.wg-tag--mono` status pill. The
// status emoji stays in the pill label so existing tests grepping for `✅`
// continue to pass.

function _buildHistoryClusters(logs) {
    const clusters = [];
    logs.forEach((l) => {
        let key = l.scheduled_at;
        let timeSource = l.scheduled_at;
        if (l.status === 'TAKEN' && l.taken_at) {
            const d = new Date(l.taken_at);
            key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;
            timeSource = l.taken_at;
        }
        let cluster = clusters.find((c) => c.key === key && c.status === l.status);
        if (!cluster) {
            cluster = {
                key,
                status: l.status,
                items: [],
                sortTime: new Date(timeSource).getTime(),
                timeSource
            };
            clusters.push(cluster);
        }
        cluster.items.push(l);
    });
    clusters.sort((a, b) => b.sortTime - a.sortTime);
    return clusters;
}

function _buildHistoryDayLabel(dateMs, todayMs, yesterdayMs) {
    const d = new Date(dateMs);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (dayStart === todayMs) return 'Today';
    if (dayStart === yesterdayMs) return 'Yesterday';
    return d.toLocaleDateString(undefined, {
        weekday: 'short',
        day: '2-digit',
        month: '2-digit'
    });
}

function _formatHistoryRowTime(dateMs) {
    const d = new Date(dateMs);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

function _buildHistoryStatusTag(status) {
    const tag = document.createElement('span');
    tag.className = 'wg-tag wg-tag--mono wg-meds-history__status';
    if (status === 'TAKEN') {
        tag.classList.add('wg-tag--normal');
        tag.textContent = '✅ Taken';
    } else if (status === 'PENDING') {
        tag.classList.add('wg-tag--high');
        tag.textContent = '⏳ Pending';
    } else {
        tag.classList.add('wg-tag--alert');
        tag.textContent = `❌ ${status || 'Missed'}`;
    }
    return tag;
}

function _buildHistoryClusterRow(cluster, medsList) {
    const row = document.createElement('div');
    row.className = 'wg-card wg-meds-history__row history-group';
    row.dataset.status = cluster.status || '';

    if (cluster.status === 'PENDING' || cluster.status === 'TAKEN') {
        row.classList.add('cursor-pointer');
        const clickHandler = () => {
            const ids = cluster.items.map((i) => i.medication_id);
            const names = cluster.items.map((i) => {
                const med = medsList.find((m) => m.id === i.medication_id);
                return med ? med.name : 'Unknown';
            });
            const intakeIds = cluster.items.map((i) => i.id);
            const mode = cluster.status === 'TAKEN' ? 'edit' : 'confirm';
            let time = cluster.key;
            if (mode === 'edit' && cluster.items[0].taken_at) {
                time = cluster.items[0].taken_at;
            } else if (cluster.items[0].scheduled_at) {
                time = cluster.items[0].scheduled_at;
            }
            showMedicationConfirmModal(ids, names, time, mode, intakeIds);
        };
        row.onclick = clickHandler;
    }

    const main = document.createElement('div');
    main.className = 'wg-meds-history__row-main';

    const namesWrap = document.createElement('div');
    namesWrap.className = 'wg-meds-history__names history-items';
    cluster.items.forEach((l) => {
        const med = medsList.find((m) => m.id === l.medication_id);
        const medName = med ? med.name : 'Unknown Med';
        const nameEl = document.createElement('span');
        nameEl.className = 'wg-meds-history__name wg-mono-display history-subitem';
        if (l.id !== undefined && l.id !== null) {
            nameEl.dataset.intakeId = String(l.id);
        }
        nameEl.textContent = medName;
        namesWrap.appendChild(nameEl);
    });
    main.appendChild(namesWrap);

    const meta = document.createElement('div');
    meta.className = 'wg-meds-history__meta';
    const timeEl = document.createElement('span');
    timeEl.className = 'wg-meds-history__time';
    timeEl.textContent = _formatHistoryRowTime(cluster.sortTime);
    meta.appendChild(timeEl);
    main.appendChild(meta);

    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'wg-meds-history__actions';
    actions.appendChild(_buildHistoryStatusTag(cluster.status));

    if (cluster.status === 'PENDING' && cluster.sortTime > Date.now()) {
        const intakeIds = cluster.items
            .map((i) => i.id)
            .filter((id) => id !== undefined && id !== null);
        if (intakeIds.length > 0) {
            const delBtn = createDeleteButton((event) => {
                event.stopPropagation();
                deleteFutureIntakes(intakeIds);
            });
            delBtn.title = 'Delete future intake';
            delBtn.setAttribute('aria-label', 'Delete future intake');
            actions.appendChild(delBtn);
        }
    }

    row.appendChild(actions);

    return row;
}

async function deleteFutureIntakes(intakeIds) {
    if (!Array.isArray(intakeIds) || intakeIds.length === 0) return;
    const msg = intakeIds.length === 1
        ? 'Delete this scheduled intake? It will be recreated on the regular schedule.'
        : `Delete ${intakeIds.length} scheduled intakes? They will be recreated on the regular schedule.`;
    await safeConfirm(msg, async (ok) => {
        if (!ok) return;
        const res = await apiCall('/api/medications/delete-intake', 'POST', { intake_ids: intakeIds });
        if (res === null) return;
        if (window.DataStore) {
            await window.DataStore.invalidateByTag('history');
            await window.DataStore.invalidateByTag('medications');
        }
        if (typeof refreshMedsAfterMutation === 'function') {
            refreshMedsAfterMutation();
        }
        if (res && typeof res.deleted_count === 'number' && res.deleted_count < intakeIds.length) {
            safeAlert(`Deleted ${res.deleted_count} of ${intakeIds.length}. Some intakes were not future PENDING doses and were skipped.`);
        }
    });
}

function renderHistory(logs) {
    const list = document.getElementById('history-list');
    list.replaceChildren();
    list.classList.add('wg-meds-history');

    if (!logs || logs.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'wg-meds-history__empty med-empty-text';
        empty.textContent = 'No history yet.';
        list.appendChild(empty);
        return;
    }

    const medsList = Array.isArray(medications) ? medications : [];
    const clusters = _buildHistoryClusters(logs);

    const now = new Date();
    const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    // DST-safe: construct yesterday's local midnight instead of subtracting 24h,
    // which drifts by ±1h on spring-forward / fall-back days and would break
    // the dayMs === yesterdayMs match.
    const yesterdayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();

    const days = [];
    clusters.forEach((cluster) => {
        const d = new Date(cluster.sortTime);
        const dayMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        let day = days.find((x) => x.dayMs === dayMs);
        if (!day) {
            day = { dayMs, clusters: [] };
            days.push(day);
        }
        day.clusters.push(cluster);
    });
    days.sort((a, b) => b.dayMs - a.dayMs);

    days.forEach((day) => {
        const dayWrap = document.createElement('div');
        dayWrap.className = 'wg-meds-history__day';

        const header = document.createElement('div');
        header.className = 'wg-section-label wg-meds-history__day-label';
        const headerText = document.createElement('span');
        headerText.textContent = _buildHistoryDayLabel(day.dayMs, todayMs, yesterdayMs);
        header.appendChild(headerText);
        dayWrap.appendChild(header);

        const rows = document.createElement('div');
        rows.className = 'wg-meds-history__rows';
        day.clusters.forEach((cluster) => {
            rows.appendChild(_buildHistoryClusterRow(cluster, medsList));
        });
        dayWrap.appendChild(rows);

        list.appendChild(dayWrap);
    });
}

// Inventory sub-tab (Phase 5, Task 6). Renders one `.wg-card` per
// medication that tracks inventory (i.e. `med.inventory_count !== null`).
// Each card carries the med name (mono), a large mono count, an optional
// low-stock `.wg-tag--alert` pill, the last-refilled date (resolved via
// the existing `/api/medications/{id}/restocks` endpoint), and a trailing
// `.wg-gloss--sun` Refill button that toggles an inline quantity input.
// Confirming the refill POSTs to the existing `/restock` endpoint and
// re-renders with the updated count. A muted placeholder renders when
// no meds track inventory.

function _formatRestockedDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
}

// Dedupe in-flight restocks fetches per medication id. `loadInventory()`
// renders twice — once eagerly from cache, once after `loadMeds()` — so
// without this map each tab open would fire 2×N GETs. Cleared on resolve so
// a subsequent render (e.g. after a refill mutation) re-fetches fresh data.
const _lastRefilledInflight = new Map();

async function _fetchLastRefilledAt(medId) {
    const inflight = _lastRefilledInflight.get(medId);
    if (inflight) return inflight;
    const promise = (async () => {
        try {
            const restocks = await apiCall(`/api/medications/${medId}/restocks`);
            if (!Array.isArray(restocks) || restocks.length === 0) return null;
            // Restocks come back newest-first from the server; guard by sorting
            // defensively in case a client mutates order.
            const sorted = restocks.slice().sort((a, b) => {
                return new Date(b.restocked_at).getTime() - new Date(a.restocked_at).getTime();
            });
            return sorted[0].restocked_at;
        } catch (_) {
            return null;
        } finally {
            _lastRefilledInflight.delete(medId);
        }
    })();
    _lastRefilledInflight.set(medId, promise);
    return promise;
}

function _buildInventoryCard(med) {
    const card = document.createElement('div');
    card.className = 'wg-card wg-meds-inventory__card';
    card.dataset.medId = String(med.id);

    const main = document.createElement('div');
    main.className = 'wg-meds-inventory__main';

    const title = document.createElement('div');
    title.className = 'wg-meds-inventory__title';
    const name = document.createElement('span');
    name.className = 'wg-meds-inventory__name wg-mono-display';
    name.textContent = med.name;
    title.appendChild(name);
    if (med.dosage) {
        const dosage = document.createElement('span');
        dosage.className = 'wg-meds-inventory__dosage';
        dosage.textContent = med.dosage;
        title.appendChild(dosage);
    }
    main.appendChild(title);

    const countWrap = document.createElement('div');
    countWrap.className = 'wg-meds-inventory__count-wrap';
    const count = document.createElement('span');
    count.className = 'wg-meds-inventory__count wg-mono-display';
    count.textContent = String(med.inventory_count);
    countWrap.appendChild(count);
    const countLabel = document.createElement('span');
    countLabel.className = 'wg-meds-inventory__count-label';
    countLabel.textContent = 'left';
    countWrap.appendChild(countLabel);
    if (isLowOnStock(med)) {
        const low = document.createElement('span');
        low.className = 'wg-tag wg-tag--mono wg-tag--alert wg-meds-inventory__low';
        low.textContent = '⚠️ Low stock';
        countWrap.appendChild(low);
    }
    main.appendChild(countWrap);

    const refilled = document.createElement('div');
    refilled.className = 'wg-meds-inventory__refilled';
    refilled.textContent = 'Last refilled: —';
    main.appendChild(refilled);

    card.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'wg-meds-inventory__actions';
    const refillBtn = document.createElement('button');
    refillBtn.type = 'button';
    refillBtn.className = 'wg-gloss wg-gloss--sun wg-meds-inventory__refill-btn';
    refillBtn.textContent = 'Refill';
    actions.appendChild(refillBtn);
    card.appendChild(actions);

    const form = document.createElement('div');
    form.className = 'wg-meds-inventory__refill-form';
    form.hidden = true;

    const inputWrap = document.createElement('label');
    inputWrap.className = 'wg-gloss--inset wg-meds-inventory__refill-input-wrap';
    const inputLabel = document.createElement('span');
    inputLabel.className = 'wg-meds-inventory__refill-input-label';
    inputLabel.textContent = 'Add';
    inputWrap.appendChild(inputLabel);
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.placeholder = '30';
    input.className = 'wg-meds-inventory__refill-input';
    inputWrap.appendChild(input);
    form.appendChild(inputWrap);

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'wg-gloss wg-gloss--sun wg-meds-inventory__refill-confirm';
    confirmBtn.textContent = 'Confirm';
    form.appendChild(confirmBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'wg-gloss wg-meds-inventory__refill-cancel';
    cancelBtn.textContent = 'Cancel';
    form.appendChild(cancelBtn);

    card.appendChild(form);

    refillBtn.addEventListener('click', () => {
        form.hidden = false;
        refillBtn.hidden = true;
        try { input.focus(); } catch (_) { /* jsdom */ }
    });

    cancelBtn.addEventListener('click', () => {
        form.hidden = true;
        refillBtn.hidden = false;
        input.value = '';
    });

    confirmBtn.addEventListener('click', () => {
        const qty = parseInt(input.value, 10);
        if (!qty || qty <= 0) {
            safeAlert('Please enter a valid quantity');
            return;
        }
        // withSubmit disables the button for the duration of the request so a
        // rapid second tap can't fire a duplicate /restock POST (which would
        // double-increment inventory).
        withSubmit(confirmBtn, async () => {
            const res = await apiCall(`/api/medications/${med.id}/restock`, 'POST', { quantity: qty });
            if (!res) return;
            // Update local medications list so the next render reflects the
            // new count without waiting for a full SWR refresh.
            if (typeof res.inventory_count === 'number') {
                const m = medications.find((x) => x.id === med.id);
                if (m) m.inventory_count = res.inventory_count;
            }
            await window.DataStore.invalidateTags(['medications']);
            renderInventory();
        });
    });

    return card;
}

function renderInventory() {
    const list = document.getElementById('med-inventory-list');
    if (!list) return;
    list.replaceChildren();
    list.classList.add('wg-meds-inventory');

    const tracked = (Array.isArray(medications) ? medications : [])
        .filter((m) => m && m.inventory_count !== null && m.inventory_count !== undefined)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (tracked.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'wg-meds-inventory__empty';
        empty.textContent = 'No medications track inventory — enable tracking in the edit modal.';
        list.appendChild(empty);
        return;
    }

    tracked.forEach((med) => {
        const card = _buildInventoryCard(med);
        list.appendChild(card);
        // Kick off the last-refilled fetch; fill the row in-place when it
        // resolves so the rest of the card paints immediately. If the card
        // has been detached (e.g. another render supplanted it), drop the
        // update — its querySelector would silently target a stale node.
        _fetchLastRefilledAt(med.id).then((iso) => {
            if (!card.isConnected) return;
            const row = card.querySelector('.wg-meds-inventory__refilled');
            if (!row) return;
            const formatted = _formatRestockedDate(iso);
            row.textContent = formatted ? `Last refilled: ${formatted}` : 'Last refilled: —';
        });
    });
}

async function loadInventory() {
    // Render eagerly from whatever's in memory or the DataStore cache so the
    // Inventory pane is never blank while loadMeds() is awaiting its network
    // refresh. loadSWR does not resolve until fetchFresh completes, and its
    // onCached handler only repaints the Schedule tab — without this
    // pre-render the Inventory list would stay empty on a slow/offline first
    // open even when cached medications are already available.
    if (!Array.isArray(medications) || medications.length === 0) {
        const cached = window.DataStore ? await window.DataStore.getCached('medications') : null;
        if (Array.isArray(cached)) {
            medications = cached;
        }
    }
    renderInventory();
    // Fall through to a full refresh so the pane picks up mutations from
    // polling / another device (DataStore cache may be stale).
    await loadMeds();
    renderInventory();
}

function renderMedsEmptyState() {
    const list = document.getElementById('med-list');
    if (!list) return;
    list.replaceChildren(createEmptyState('No cached data — will load when online', { tag: 'div' }));
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
        await renderMedsScheduleStaleBadge();
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
            await renderMedsScheduleStaleBadge();
        }
        return;
    }

    // Tracks whether any callback (cached / fresh / offline-fallback) painted
    // a list. When all three miss — apiCall returns null silently on offline,
    // no api_cache, no MedicationStore — `loadSWR` resolves without ever
    // firing onCached/onFresh/onError, leaving the list blank. We fall back
    // to an explicit empty-state below so the user sees the same offline
    // message BP/Weight surface.
    let renderedSomething = false;

    await window.DataStore.loadSWR({
        key: 'medications',
        tags: ['medications'],
        fetcher: async () => await apiCall('/api/medications?archived=true'),
        onCached: async (cached) => {
            // Render even when cached is an empty array so the SWR refresh
            // can later swap in a fresh list without a flash of stale UI.
            renderedSomething = true;
            medications = Array.isArray(cached) ? cached : [];
            renderMeds();
            populateMedFilter();
            await renderMedsScheduleStaleBadge();
        },
        onFresh: async (fresh) => {
            renderedSomething = true;
            medications = fresh;
            if (window.MedTrackerDB?.MedicationStore) {
                await window.MedTrackerDB.MedicationStore.saveCache(medications);
            }
            renderMeds();
            populateMedFilter();
            await renderMedsScheduleStaleBadge();
        },
        onError: async (_err, cached) => {
            if (cached) {
                renderedSomething = true;
                await renderMedsScheduleStaleBadge();
                return;
            }
            // API failed and no ApiCache hit; fall back to offline cache
            let fallbackFetchedAt = null;
            let fallbackHadData = false;
            if (window.MedTrackerDB?.MedicationStore) {
                const offlineCached = await window.MedTrackerDB.MedicationStore.getCache();
                if (offlineCached) {
                    console.log('[Meds] Loaded from offline cache:', offlineCached.length);
                    fallbackHadData = true;
                    renderedSomething = true;
                    medications = offlineCached;
                    renderMeds();
                    populateMedFilter();
                    // Surface the MedicationStore's saved-at timestamp so the
                    // badge shows "Offline · Xh old" instead of falsely
                    // claiming "no cache" while real meds are on screen.
                    try {
                        const rec = await window.MedTrackerDB.db?.medication_cache?.get('medications_list');
                        if (rec && Number.isFinite(rec.timestamp)) {
                            fallbackFetchedAt = rec.timestamp;
                        }
                    } catch (_) { /* best-effort cache read */ }
                }
            }
            if (!fallbackHadData) {
                renderMedsEmptyState();
            }
            await renderMedsScheduleStaleBadge({ fallbackFetchedAt });
        }
    });

    if (!renderedSomething) {
        renderMedsEmptyState();
        await renderMedsScheduleStaleBadge();
    }
}

// Mounts the wg-stale-badge into the Meds Schedule subtab from the api_cache
// 'medications' timestamp (warmed by /api/bootstrap and refreshed by
// loadMeds). Mirrors the BP/Weight Task 6 pattern. When the api_cache
// entry is missing but a separate offline-only cache (MedicationStore)
// has data, the caller can pass `fallbackFetchedAt` so the chip still
// reflects the real freshness instead of "Offline · no cache".
async function renderMedsScheduleStaleBadge(opts = {}) {
    const slot = document.getElementById('meds-schedule-stale-badge');
    if (!slot) return;
    const api = (typeof window !== 'undefined') ? window.WGStaleBadge : null;
    if (!api || typeof api.mountFromKey !== 'function') {
        slot.replaceChildren();
        slot.classList.add('hidden');
        return;
    }
    await api.mountFromKey({
        slot,
        key: 'medications',
        fallbackFetchedAt: opts.fallbackFetchedAt
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
        inventoryCount = parseInt(inventoryCountRaw, 10);
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
            .map(s => parseInt(s.dataset.day, 10));

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
            if (ok) {
                const payload = {
                    name: med.name,
                    dosage: med.dosage,
                    schedule: med.schedule,
                    supplement: !!med.supplement,
                    archived: true
                };

                const res = await apiCall(`/api/medications/${id}`, 'POST', payload);
                if (res === null) return;
                if (res && res.warning) {
                    safeAlert("⚠️ " + res.warning);
                }
                await window.DataStore.invalidateTags(['medications', 'history']);
                await window.DataStore.invalidateKey('next_intake');
                loadMeds();
            }
        });
    }
}

function showMedicationConfirmModal(ids, names, scheduledAt, mode = 'confirm', intakeIds = []) {
    pendingMedConfirmIds = ids;
    pendingMedConfirmScheduled = scheduledAt;
    pendingMedConfirmMode = mode;
    pendingMedConfirmIntakeIds = intakeIds;

    window.ModalManager.medConfirm.open();

    const eyebrowEl = document.getElementById('med-confirm-eyebrow');
    const titleEl = document.getElementById('med-confirm-title');
    const subtitleEl = document.getElementById('med-confirm-subtitle');
    const timeEditEl = document.getElementById('med-confirm-time-edit');
    const timeInput = document.getElementById('med-confirm-datetime');
    const actionBtn = document.getElementById('med-confirm-action-btn');
    const snoozeBtn = document.getElementById('med-confirm-snooze-btn');
    const skipBtn = document.getElementById('med-confirm-skip-btn');

    let timeStr = scheduledAt;
    try {
        const d = new Date(scheduledAt);
        timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (_) { /* keep raw */ }

    if (mode === 'edit' || mode === 'log_past') {
        if (eyebrowEl) eyebrowEl.textContent = mode === 'edit' ? 'Edit intake' : 'Log intake';
        titleEl.innerText = mode === 'edit' ? "Edit Intake" : "Log Intake";
        subtitleEl.textContent = "";
        timeEditEl.classList.remove('hidden');

        try {
            timeInput.value = formatDateTimeLocalForInput(scheduledAt);
        } catch (e) {
            console.error("Error formatting date for input", e);
        }

        actionBtn.innerText = mode === 'edit' ? "Update" : "Log Intake";
        actionBtn.onclick = mode === 'edit' ? updateIntakeHistory : confirmLogPast;
        snoozeBtn.classList.add('hidden');
        if (skipBtn) skipBtn.classList.add('hidden');
    } else {
        if (eyebrowEl) eyebrowEl.textContent = 'Time for meds';
        titleEl.innerText = "Time for Meds!";
        timeEditEl.classList.add('hidden');

        subtitleEl.textContent = "Scheduled for: " + timeStr;

        actionBtn.innerText = "Confirm Selected";
        actionBtn.onclick = confirmSelectedMedications;
        snoozeBtn.classList.remove('hidden');
        if (skipBtn) skipBtn.classList.remove('hidden');
    }

    const list = document.getElementById('med-confirm-list');
    list.replaceChildren();

    ids.forEach((id, index) => {
        const name = names[index] || ('Medication ' + id);

        const row = document.createElement('label');
        row.className = 'wg-med-confirm-modal__row wg-med-confirm-modal__row--on';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = String(index);
        input.checked = true;
        input.className = 'med-confirm-check wg-med-confirm-modal__row-input';
        input.addEventListener('change', () => {
            row.classList.toggle('wg-med-confirm-modal__row--on', input.checked);
        });

        const check = document.createElement('span');
        check.className = 'wg-med-confirm-modal__check';
        check.setAttribute('aria-hidden', 'true');

        const body = document.createElement('span');
        body.className = 'wg-med-confirm-modal__row-body';

        const nameEl = document.createElement('span');
        nameEl.className = 'wg-med-confirm-modal__row-name';
        nameEl.textContent = name;
        body.appendChild(nameEl);

        row.append(input, check, body);
        list.appendChild(row);
    });
}
