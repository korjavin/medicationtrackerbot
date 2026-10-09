// ==================== Medication render + modal flow ====================
// Extracted from app.js in Phase 5 Task 1. These functions remain global
// (script-tag loading) and still rely on helpers from features/medication-utils.js
// (parseMedicationSchedule, getNextScheduledDate, getMedicationScheduleText,
// getLastTakenTimeMs — reached via window.MedicationUtils.*) plus app.js
// helpers (isLowOnStock, formatDate, apiCall, withSubmit, safeAlert,
// safeConfirm, editingMedId, medications, initialAuthLoad, etc.).

// Sub-tab state (Phase 5, Task 2; revised Task 5; round-2 Task 4).
// Scoped to sessionStorage so every fresh launch lands on the History
// default (matching the Claude Design mockup). A user's in-session tab
// click still survives reloads within the same tab — it just doesn't
// leak across sessions. Legacy mt-meds-subtab localStorage values are
// cleared on boot so previously-saved "schedule"/"inventory" choices
// don't keep overriding the history default.
const MEDS_SUBTAB_STORAGE_KEY = 'mt-meds-subtab';
const MEDS_SUBTAB_OPTIONS = ['schedule', 'history', 'upcoming', 'inventory'];
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

function restoreMedsSubTab() {
    window.TabController.syncPressed('.med-tab', getActiveMedsSubTab());
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

// Tap a medication row → its editor page (meds-history.js fillMedEditor).
function showEditModal(id) {
    const med = medications.find(m => m.id === id);
    if (med) fillMedEditor(med);
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

// Schedule sub-tab render (kit v2 M1, med-xso6.18). Doses group into
// `.wg-section` buckets: missed doses (still PENDING past their slot) first,
// then one bucket per upcoming dose slot, then Scheduled (no next dose),
// As needed and Archived. A bucket head carries its action — "Log late" /
// "Take N" — and its rows are kit `.wg-row`s: tap edits, swipe / overflow
// for Edit / Delete, as-needed rows keep a per-row Log.

function _formatHourHeader(timeLabel, date, now) {
    const rel = _formatNextActionRelative(date.getTime() - now.getTime());
    return `${timeLabel} · ${rel}`;
}

function _pad2(n) {
    return String(n).padStart(2, '0');
}

// Calendar-day + wall-clock slot key: one bucket per dose instant, so a
// bucket's "Take N" confirms exactly one scheduled_at.
function _slotKey(date) {
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${_pad2(date.getHours())}:${_pad2(date.getMinutes())}`;
}

// Plan-aware dose forecast for the Schedule tab (bd med-gut.1/med-gut.2).
// GET /api/medications/upcoming runs the SAME engine Home's next-intake card
// uses (web/domain/medintake.js → planDosesWithTzPlan), so an approved tz
// transition plan, the tracked IANA timezone, and start/end dates all land in
// the buckets. Kept in module state because renderMeds() is synchronous and is
// called from four places inside loadMeds().
const MEDS_UPCOMING_DAYS = 7;
let _medsUpcomingState = { doses: [], available: false, due: [] }; // module-state: plan-aware upcoming doses + due (missed) intakes shared by the Schedule buckets and the Upcoming list

async function loadUpcomingDoses() {
    const read = (path) => Promise.resolve().then(() => apiCall(path)).catch(() => null);
    const [res, history] = await Promise.all([
        read(`/api/medications/upcoming?days=${MEDS_UPCOMING_DAYS}`),
        // Missed + overdue doses: the same 24h window the Meds tab badge
        // counts (features/app-nav.js countDueDoses).
        read('/api/history?days=1'),
    ]);
    // `available` separates "the forecast answered, and this med simply has
    // no upcoming dose" from "there is no forecast to consult" (offline /
    // route unavailable) — only the latter may fall back to the device-local
    // computation.
    _medsUpcomingState.available = Array.isArray(res);
    _medsUpcomingState.doses = Array.isArray(res) ? res : [];
    const nowMs = Date.now();
    _medsUpcomingState.due = (Array.isArray(history) ? history : []).filter((r) => r
        && r.status === 'PENDING'
        && Date.parse(r.scheduled_at) <= nowMs
        && !(r.snoozed_until && Date.parse(r.snoozed_until) > nowMs));
    return _medsUpcomingState.doses;
}

// The route returns doses ascending by scheduled_at, so the first row per
// medication is that medication's NEXT dose.
function _nextDoseByMedId() {
    const byMed = new Map();
    (_medsUpcomingState.doses || []).forEach((dose) => {
        const key = String(dose.medication_id);
        if (!byMed.has(key)) byMed.set(key, dose);
    });
    return byMed;
}

// Resolves a med's next dose to {at, key, timeLabel}, or null when it has
// none. Falls back to the device-local computation only when the forecast is
// unavailable (offline cold start, or the legacy bot server, which has no such
// route) — never when the forecast answered.
function _resolveNextDose(med, schedule, nextDoses, now) {
    const dose = nextDoses.get(String(med.id));
    if (dose && dose.scheduled_at && dose.local_date && dose.local_time) {
        const at = new Date(dose.scheduled_at);
        if (!Number.isNaN(at.getTime())) {
            return {
                at,
                key: `${dose.local_date}-${dose.local_time}`,
                timeLabel: String(dose.local_time)
            };
        }
    }
    // A forecast that simply has no row for this medication is a real answer —
    // the course ended, it starts past the horizon, or every slot inside the
    // horizon is already taken/skipped. Recomputing it device-locally would
    // resurrect exactly the wrong bucket this change removes; the med belongs
    // in the no-next-dose "Scheduled" group instead.
    if (_medsUpcomingState.available) return null;
    const at = window.MedicationUtils.getNextScheduledDate(schedule, now);
    if (!at) return null;
    return {
        at,
        key: _slotKey(at),
        timeLabel: `${_pad2(at.getHours())}:${_pad2(at.getMinutes())}`
    };
}

function _medsEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

function _medsIcon(name, extraClass) {
    const ico = _medsEl('i', extraClass ? `wg-ico ${extraClass}` : 'wg-ico');
    ico.appendChild(window.WGIcons.iconSvg(name));
    return ico;
}

// One schedule bucket: `.wg-section` with an eyebrow head, an optional head
// action and a `.wg-list` of rows. tone: 'dot' (upcoming) | 'danger' (missed).
function _buildMedsBucket(label, { tone, action, rows }) {
    const section = _medsEl('section', 'wg-section wg-meds-bucket');
    const head = _medsEl('div', 'wg-section__head');
    head.appendChild(_medsEl('span', `wg-eyebrow${tone ? ` wg-eyebrow--${tone}` : ''} wg-meds-bucket__label`, label));
    if (action) {
        const btn = _medsEl('button', `wg-btn wg-btn--sm${action.ghost ? ' wg-btn--ghost' : ''} wg-meds-bucket__action`, action.label);
        btn.type = 'button';
        btn.addEventListener('click', action.onClick);
        head.appendChild(btn);
    }
    section.appendChild(head);
    const list = _medsEl('div', 'wg-list');
    rows.forEach((row) => list.appendChild(row));
    section.appendChild(list);
    return section;
}

// Opens the take sheet for one dose slot, preselecting the bucket's meds.
// Missed rows carry their intake ids (confirm by id); upcoming slots confirm
// by scheduled_at (web/domain/medintake.js confirmSchedule).
function _openBucketTake(meds, scheduledAt, intakeIds) {
    showMedicationConfirmModal(meds.map((m) => m.id), meds.map((m) => m.name), scheduledAt, 'confirm', intakeIds || []);
}

function _buildMedsLogButton(med) {
    const btn = _medsEl('button', 'wg-btn wg-btn--sm wg-meds-row__log-btn', 'Log');
    btn.type = 'button';
    btn.addEventListener('click', () => {
        logMedicationPast(med.id, med.name);
    });
    return btn;
}

function _buildMedsInventoryTag(med) {
    // Stock chip: formatStock() already speaks the kit states (ok/warn/danger).
    const stock = formatStock(med.inventory_count, med);
    const chip = window.WGChip.create({ text: stock.label, state: stock.state, small: true });
    chip.classList.add('wg-meds-row__inventory');
    return chip;
}

// A schedule row (kit .wg-row): title "Name · dose", meta = schedule · dates ·
// Rx plus status chips. Tap edits; swipe / overflow reveals Edit and Delete.
// As-needed rows keep a per-row Log; scheduled rows log off-schedule doses
// from the overflow menu (their bucket head owns Take / Log late).
// opts.missed paints the lead in the danger tone.
function _buildMedsRow(med, parsedSchedule, opts = {}) {
    const row = _medsEl('div', 'wg-row wg-meds-row med-item');
    row.dataset.medId = String(med.id);
    if (med.archived) row.classList.add('archived', 'wg-row--muted');

    const lead = _medsEl('span', opts.missed ? 'wg-row__lead wg-row__lead--danger' : 'wg-row__lead');
    lead.appendChild(_medsIcon('pill'));
    row.appendChild(lead);

    const body = _medsEl('span', 'wg-row__body wg-meds-row__info');
    const title = _medsEl('span', 'wg-row__title wg-meds-row__title');
    title.appendChild(_medsEl('span', 'wg-meds-row__name', med.name));
    if (med.dosage) title.appendChild(document.createTextNode(` · ${med.dosage}`));
    body.appendChild(title);

    const meta = _medsEl('span', 'wg-row__meta wg-meds-row__meta');
    meta.appendChild(_medsEl('span', 'wg-meds-row__schedule',
        window.MedicationUtils.getMedicationScheduleText(med, parsedSchedule)));
    if (med.start_date || med.end_date) {
        const start = med.start_date ? formatDate(med.start_date).split(' ')[0] : 'N/A';
        const end = med.end_date ? formatDate(med.end_date).split(' ')[0] : 'N/A';
        meta.appendChild(_medsEl('span', 'wg-meds-row__dates', `${start} – ${end}`));
    }
    if (med.normalized_name) {
        meta.appendChild(_medsEl('span', 'wg-meds-row__rx', `Rx ${med.normalized_name}`));
    }
    if (med.inventory_count !== null && med.inventory_count !== undefined) {
        meta.appendChild(_buildMedsInventoryTag(med));
    }
    if (med.supplement) {
        meta.appendChild(_medsEl('span', 'wg-tag wg-meds-row__supplement', 'Supplement'));
    }
    if (med.archived) {
        const archivedChip = window.WGChip.create({ text: 'Archived', state: 'stale', small: true });
        archivedChip.classList.add('wg-meds-row__archived');
        meta.appendChild(archivedChip);
    }
    const syncChip = window.WGChip.sync(med);
    if (syncChip) meta.appendChild(syncChip);
    body.appendChild(meta);
    row.appendChild(body);

    const trail = _medsEl('span', 'wg-row__trail wg-meds-row__actions');
    const asNeeded = (parsedSchedule && parsedSchedule.type) === 'as_needed';
    if (asNeeded && !med.archived) trail.appendChild(_buildMedsLogButton(med));
    row.appendChild(trail);

    return window.WGRowActions.attach(row, {
        label: med.name,
        trail,
        tapEdits: true,
        onEdit: () => showEditModal(med.id),
        onDelete: () => deleteMed(med.id),
        extra: asNeeded || med.archived
            ? []
            : [{ label: 'Log a dose', icon: 'plus', onClick: () => logMedicationPast(med.id, med.name) }],
    });
}

function renderMeds() {
    const list = document.getElementById('med-list');
    list.replaceChildren();
    const now = new Date();

    const scheduledEntries = [];
    const asNeeded = [];
    const archived = [];

    if (medications.length === 0) {
        list.appendChild(createEmptyState({
            icon: 'pill',
            title: 'No medications yet',
            body: 'Add what you take and when. You\'ll get reminders, a dose log for your doctor, and a warning before you run out.',
            actions: [{ label: 'Add medication', icon: 'plus', variant: 'primary', onClick: () => showAddModal() }],
        }));
        syncMedsAddButton();
        return;
    }

    const nextDoses = _nextDoseByMedId();

    // Missed buckets: due PENDING intakes grouped by their exact slot. A med
    // with a missed dose shows there, not again under its next dose.
    const medById = new Map(medications.map((m) => [String(m.id), m]));
    const missedBuckets = new Map(); // scheduled_at -> { at, entries, intakeIds }
    (_medsUpcomingState.due || []).forEach((intake) => {
        const med = medById.get(String(intake.medication_id));
        const at = new Date(intake.scheduled_at);
        if (!med || med.archived || Number.isNaN(at.getTime())) return;
        const schedule = window.MedicationUtils.parseMedicationSchedule(med.schedule);
        if ((schedule?.type || 'daily') === 'as_needed') return;
        if (!missedBuckets.has(intake.scheduled_at)) {
            missedBuckets.set(intake.scheduled_at, { at, entries: [], intakeIds: [] });
        }
        const bucket = missedBuckets.get(intake.scheduled_at);
        if (bucket.entries.some((e) => e.med === med)) return;
        bucket.entries.push({ med, schedule });
        if (intake.id !== undefined && intake.id !== null) bucket.intakeIds.push(intake.id);
    });
    const missedMedIds = new Set();
    missedBuckets.forEach((b) => b.entries.forEach((e) => missedMedIds.add(e.med)));

    medications.forEach((med) => {
        const schedule = window.MedicationUtils.parseMedicationSchedule(med.schedule);
        const scheduleType = schedule?.type || 'daily';

        if (med.archived) {
            archived.push({ med, schedule, next: null });
            return;
        }

        if (scheduleType === 'as_needed') {
            asNeeded.push({ med, schedule, next: null });
            return;
        }

        if (missedMedIds.has(med)) return;

        const resolved = _resolveNextDose(med, schedule, nextDoses, now);
        scheduledEntries.push({
            med,
            schedule,
            next: resolved ? resolved.at : null,
            key: resolved ? resolved.key : null,
            timeLabel: resolved ? resolved.timeLabel : null
        });
    });

    // Bucket scheduled entries by their next dose slot. Entries with no
    // computable next dose fall into a generic "Scheduled" bucket at
    // the end of the scheduled section.
    const slotBuckets = new Map(); // key -> { at, timeLabel, entries }
    const scheduledNoNext = [];

    scheduledEntries.forEach((entry) => {
        if (!entry.next) {
            scheduledNoNext.push(entry);
            return;
        }
        if (!slotBuckets.has(entry.key)) {
            slotBuckets.set(entry.key, { at: entry.next, timeLabel: entry.timeLabel, entries: [] });
        }
        slotBuckets.get(entry.key).entries.push(entry);
    });

    const sortByTaken = (a, b) => window.MedicationUtils.getLastTakenTimeMs(b.med) - window.MedicationUtils.getLastTakenTimeMs(a.med);
    const rowsOf = (entries, opts) => entries.map(({ med, schedule }) => _buildMedsRow(med, schedule, opts));

    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    Array.from(missedBuckets.values()).sort((a, b) => a.at - b.at).forEach((bucket) => {
        const day = bucket.at.getTime() >= todayStart ? 'today' : 'yesterday';
        const label = `${_pad2(bucket.at.getHours())}:${_pad2(bucket.at.getMinutes())} · missed ${day}`;
        list.appendChild(_buildMedsBucket(label, {
            tone: 'danger',
            action: {
                label: 'Log late',
                ghost: true,
                onClick: () => _openBucketTake(bucket.entries.map((e) => e.med), bucket.at.toISOString(), bucket.intakeIds),
            },
            rows: rowsOf(bucket.entries, { missed: true }),
        }));
    });

    Array.from(slotBuckets.values()).sort((a, b) => a.at - b.at).forEach((bucket) => {
        const meds = bucket.entries.map((e) => e.med);
        list.appendChild(_buildMedsBucket(_formatHourHeader(bucket.timeLabel, bucket.at, now), {
            tone: 'dot',
            action: { label: `Take ${meds.length}`, onClick: () => _openBucketTake(meds, bucket.at.toISOString()) },
            rows: rowsOf(bucket.entries),
        }));
    });

    if (scheduledNoNext.length > 0) {
        scheduledNoNext.sort(sortByTaken);
        list.appendChild(_buildMedsBucket('Scheduled', { rows: rowsOf(scheduledNoNext) }));
    }

    if (asNeeded.length > 0) {
        asNeeded.sort(sortByTaken);
        list.appendChild(_buildMedsBucket('As needed', { rows: rowsOf(asNeeded) }));
    }

    if (archived.length > 0) {
        archived.sort(sortByTaken);
        list.appendChild(_buildMedsBucket('Archived', { rows: rowsOf(archived) }));
    }
    syncMedsAddButton();
}

// M4: while the visible Meds pane shows an empty state with its own Add, the
// app-bar Add hides so that Add is the one primary on screen. Called after
// every pane render and on sub-tab switch (app.js switchMedTab).
function syncMedsAddButton() {
    const btn = document.getElementById('add-btn');
    if (!btn) return;
    const pane = document.querySelector('#meds-view .med-tab-content.active');
    btn.hidden = !!(pane && pane.querySelector('.wg-empty .wg-btn--primary'));
}

// "Upcoming" forecast (bd med-gut.2): the next 7 days of doses grouped by day
// in the TRACKED timezone. Read-only — no take/skip actions; the Today screen
// owns those. Day labels and times come from the route (`day_offset`,
// `local_date`, `local_time`) so this renderer never touches timezone math.
// bd med-4oxj promoted it out of the Schedule list into its own sub-tab; it
// still reads the same `_medsUpcomingState` the Schedule hour buckets consume,
// so there is exactly one fetch behind both views.
function _formatUpcomingDayLabel(dose) {
    if (dose.day_offset === 0) return 'Today';
    if (dose.day_offset === 1) return 'Tomorrow';
    const parts = String(dose.local_date || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return String(dose.local_date || '');
    // Constructed from wall-clock parts, so this Date is only ever read for its
    // weekday/day/month names — never as an instant.
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function _buildUpcomingRow(dose) {
    const row = document.createElement('div');
    row.className = 'wg-card wg-meds-upcoming__row';
    row.dataset.medId = String(dose.medication_id);
    if (dose.source === 'tz_step') row.classList.add('wg-meds-upcoming__row--step');

    const time = document.createElement('span');
    time.className = 'wg-meds-upcoming__time wg-mono-display';
    time.textContent = dose.local_time || '';
    row.appendChild(time);

    const body = document.createElement('div');
    body.className = 'wg-meds-upcoming__body';

    const titleRow = document.createElement('div');
    titleRow.className = 'wg-meds-upcoming__title';
    const name = document.createElement('span');
    name.className = 'wg-meds-upcoming__name';
    name.textContent = dose.med_name || '';
    titleRow.appendChild(name);
    if (dose.dosage) {
        const dosage = document.createElement('span');
        dosage.className = 'wg-meds-upcoming__dosage';
        dosage.textContent = dose.dosage;
        titleRow.appendChild(dosage);
    }
    if (dose.source === 'tz_step' && dose.step_number) {
        const badge = document.createElement('span');
        badge.className = 'wg-tag wg-tag--mono wg-meds-upcoming__badge';
        badge.textContent = `transition step ${dose.step_number}/${dose.total_steps || dose.step_number}`;
        titleRow.appendChild(badge);
    }
    body.appendChild(titleRow);

    if (dose.note) {
        const note = document.createElement('div');
        note.className = 'wg-meds-upcoming__note';
        note.textContent = dose.note;
        body.appendChild(note);
    }

    row.appendChild(body);
    return row;
}

// Paints the Upcoming sub-tab pane from module state. Takes no argument and
// clears the pane itself, so every caller (tab switch, loadMeds refresh) gets
// a full repaint rather than an append.
function renderUpcomingDoses() {
    const list = document.getElementById('med-upcoming-list');
    if (!list) return;
    list.replaceChildren();

    const doses = _medsUpcomingState.doses || [];
    // No forecast to show (offline cold start / legacy server): the naive
    // device-local fallback is driving the Schedule hour buckets, so "nothing
    // upcoming" would be a claim this renderer cannot make. Stay silent.
    if (!_medsUpcomingState.available) { syncMedsAddButton(); return; }

    // No section label: the "Upcoming" sub-tab pill above already names the
    // pane, and repeating it inside is noise (bd med-4oxj).
    const wrap = document.createElement('div');
    wrap.className = 'wg-meds-upcoming';

    // The forecast answered with nothing — say so, so an empty window is
    // distinguishable from the block not being there at all (bd med-jr1e).
    if (doses.length === 0) {
        wrap.appendChild(createEmptyState({
            icon: 'calendar',
            title: 'Nothing scheduled',
            body: `No doses in the next ${MEDS_UPCOMING_DAYS} days. Add a medication with a schedule and its next dose shows up here.`,
            actions: [{ label: 'Add medication', icon: 'plus', variant: 'primary', onClick: () => showAddModal() }],
        }));
        list.appendChild(wrap);
        syncMedsAddButton();
        return;
    }

    let currentDay = null;
    doses.forEach((dose) => {
        if (dose.local_date !== currentDay) {
            currentDay = dose.local_date;
            const dayLabel = document.createElement('div');
            dayLabel.className = 'wg-meds-upcoming__day';
            dayLabel.textContent = _formatUpcomingDayLabel(dose);
            wrap.appendChild(dayLabel);
        }
        wrap.appendChild(_buildUpcomingRow(dose));
    });

    list.appendChild(wrap);
    syncMedsAddButton();
}

// Upcoming sub-tab loader (switchMedTab dispatch). The forecast rows already
// carry med_name/dosage, so this pane needs no medication list — just the
// shared forecast fetch and a repaint.
async function loadUpcoming() {
    await loadUpcomingDoses();
    renderUpcomingDoses();
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
// time, an edit `.wg-icon-btn`, and a WGChip status chip (ok/pending/danger).

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
    let chip;
    if (status === 'TAKEN') chip = window.WGChip.create({ text: 'Taken', state: 'ok', small: true });
    else if (status === 'PENDING') chip = window.WGChip.create({ text: 'Pending', state: 'pending', small: true });
    else chip = window.WGChip.create({ text: _titleCaseStatus(status), state: 'danger', small: true });
    chip.classList.add('wg-meds-history__status');
    return chip;
}

// 'SKIPPED' → 'Skipped'; empty → 'Missed'.
function _titleCaseStatus(status) {
    if (!status) return 'Missed';
    const s = String(status);
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
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
            row.appendChild(actions);
            return window.WGRowActions.attach(row, {
                label: 'future intake',
                trail: actions,
                onDelete: () => deleteFutureIntakes(intakeIds),
            });
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
    const idSet = new Set(intakeIds);
    await safeConfirm(msg, async (ok) => {
        if (!ok) return;

        // Optimistic: drop the to-be-deleted intake rows from every cached
        // `history_*` payload so the row disappears from the list before the
        // POST resolves. _applyOptimisticHistoryFlip is defined in app.js;
        // mutator returns null/undefined to filter.
        const handles = typeof _applyOptimisticHistoryFlip === 'function'
            ? await _applyOptimisticHistoryFlip((log) => {
                if (!log || typeof log !== 'object') return log;
                if (idSet.has(log.id)) return null;
                return log;
            })
            : [];

        let res;
        try {
            res = await apiCall('/api/medications/delete-intake', 'POST', { intake_ids: intakeIds });
        } catch (e) {
            if (typeof _rollbackOptimistic === 'function') await _rollbackOptimistic(handles);
            throw e;
        }
        if (res === null) {
            if (typeof _rollbackOptimistic === 'function') await _rollbackOptimistic(handles);
            return;
        }
        if (typeof _commitOptimistic === 'function') await _commitOptimistic(handles);
        if (window.DataStore) {
            await window.DataStore.invalidateByTag('history');
            await window.DataStore.invalidateByTag('medications');
        }
        if (typeof refreshMedsAfterMutation === 'function') {
            refreshMedsAfterMutation();
        }
        if (res && typeof res.deleted_count === 'number' && res.deleted_count < intakeIds.length) {
            safeToast(`Deleted ${res.deleted_count} of ${intakeIds.length}. Some intakes were not future PENDING doses and were skipped.`, 'info');
        }
    });
}

function renderHistory(logs) {
    const list = document.getElementById('history-list');
    list.replaceChildren();
    list.classList.add('wg-meds-history');

    if (!logs || logs.length === 0) {
        list.appendChild(createEmptyState({
            icon: 'history',
            title: 'No doses logged yet',
            body: 'Doses you take or skip show up here, ready for your doctor.',
        }));
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

// Stock sub-tab (kit v2 M3, med-xso6.18; tab id stays `inventory`). One
// `.wg-card` per medication that tracks inventory, out/low first. Each card
// shows the remaining doses, "N a day · lasts N days", the last refill
// (`/api/medications/{id}/restocks`), and a Refill button that opens preset
// `.wg-pick` chips (+30/+60/+90/Other stepper) with the primary previewing the
// new total ("Add 30 → 47"). Confirming writes through
// DataStore.applyOptimistic, then POSTs the existing `/restock` route.

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

const MEDS_REFILL_PRESETS = [30, 60, 90];

// "2 a day" for whole daily counts, else per week ("3 a week").
function _formatDailyUsage(daily) {
    if (daily >= 1 && Number.isInteger(daily)) return `${daily} a day`;
    return `${Math.max(1, Math.round(daily * 7))} a week`;
}

function _stockMeta(med) {
    const count = med.inventory_count;
    if (count < 0) return `Logged ${-count} doses beyond stock`;
    const daily = calculateDailyUsage(med);
    if (!daily) return 'As needed';
    const days = Math.floor(count / daily);
    return `${_formatDailyUsage(daily)} · lasts ${days} day${days === 1 ? '' : 's'}`;
}

// out (danger) → low (warn) → ok.
function _stockRank(med) {
    const state = formatStock(med.inventory_count, med).state;
    return state === 'danger' ? 0 : state === 'warn' ? 1 : 2;
}

// Optimistic restock: bump the cached + in-memory count, POST the existing
// route, then commit (keeping the server's count) or roll back. The card is
// only repainted in place while the POST is in flight, so withSubmit's
// disabled button keeps guarding against a second (non-idempotent) restock.
async function _refillMed(med, qty, btn) {
    const id = med.id;
    const before = med.inventory_count;
    const setCount = (list, count) => (Array.isArray(list)
        ? list.map((m) => (m && m.id === id ? { ...m, inventory_count: count } : m))
        : list);
    await withSubmit(btn, async () => {
        const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
            ? await window.DataStore.applyOptimistic('medications', (prev) => setCount(prev, before + qty), ['medications'])
            : null;
        medications = setCount(medications, before + qty);
        const countEl = btn.closest('.wg-meds-stock__card')?.querySelector('.wg-meds-stock__count');
        if (countEl && countEl.firstChild) countEl.firstChild.textContent = String(Math.max(0, before + qty));

        let res = null;
        try {
            res = await apiCall(`/api/medications/${id}/restock`, 'POST', { quantity: qty });
        } catch (_) { res = null; }
        if (!res) {
            if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
            medications = setCount(medications, before);
            renderInventory();
            return;
        }
        if (typeof res.inventory_count === 'number' && res.inventory_count !== before + qty) {
            medications = setCount(medications, res.inventory_count);
            if (handle) { try { await handle.commit(medications); } catch (_) { /* best-effort */ } }
        } else if (handle) {
            try { await handle.commit(null); } catch (_) { /* best-effort */ }
        }
        renderInventory();
    });
}

// The inline refill panel: preset picks + an "Other" stepper; the primary
// previews the resulting total.
function _buildRefillPanel(med, onCancel) {
    const panel = _medsEl('div', 'wg-vstack wg-meds-stock__refill');
    panel.hidden = true;
    panel.appendChild(_medsEl('span', 'wg-label', 'Refill · doses'));

    const picks = _medsEl('div', 'wg-picks');
    const stepper = _medsEl('div', 'wg-stepper wg-meds-stock__stepper');
    stepper.hidden = true;
    const minus = _medsEl('button', 'wg-stepper__btn');
    minus.type = 'button';
    minus.setAttribute('aria-label', 'Decrease');
    minus.appendChild(_medsIcon('minus'));
    const input = _medsEl('input', 'wg-stepper__val wg-meds-stock__qty');
    input.type = 'number';
    input.min = '1';
    input.inputMode = 'numeric';
    input.setAttribute('aria-label', 'Doses to add');
    const plus = _medsEl('button', 'wg-stepper__btn');
    plus.type = 'button';
    plus.setAttribute('aria-label', 'Increase');
    plus.appendChild(_medsIcon('plus'));
    stepper.append(minus, input, plus);

    const foot = _medsEl('div', 'wg-card__foot');
    const cancel = _medsEl('button', 'wg-btn wg-btn--ghost wg-btn--sm wg-meds-stock__cancel', 'Cancel');
    cancel.type = 'button';
    const confirm = _medsEl('button', 'wg-btn wg-btn--sm wg-meds-stock__confirm');
    confirm.type = 'button';
    foot.append(cancel, confirm);

    let qty = MEDS_REFILL_PRESETS[0];
    const paint = () => {
        const valid = Number.isInteger(qty) && qty > 0;
        confirm.disabled = !valid || confirm.hasAttribute('data-submit-in-flight');
        confirm.textContent = valid ? `Add ${qty} → ${med.inventory_count + qty}` : 'Add';
    };
    const choose = (pick, value) => {
        picks.querySelectorAll('.wg-pick').forEach((p) => p.setAttribute('aria-pressed', p === pick ? 'true' : 'false'));
        stepper.hidden = value !== null;
        if (value === null) {
            input.value = String(qty);
            try { input.focus(); } catch (_) { /* jsdom */ }
        } else {
            qty = value;
        }
        paint();
    };
    [...MEDS_REFILL_PRESETS, null].forEach((value, i) => {
        const pick = _medsEl('button', 'wg-pick', value === null ? 'Other' : `+${value}`);
        pick.type = 'button';
        pick.dataset.qty = value === null ? 'other' : String(value);
        pick.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
        pick.addEventListener('click', () => choose(pick, value));
        picks.appendChild(pick);
    });
    const step = (delta) => {
        qty = Math.max(1, (parseInt(input.value, 10) || 0) + delta);
        input.value = String(qty);
        paint();
    };
    minus.addEventListener('click', () => step(-1));
    plus.addEventListener('click', () => step(1));
    input.addEventListener('input', () => {
        qty = parseInt(input.value, 10);
        paint();
    });
    cancel.addEventListener('click', onCancel);
    confirm.addEventListener('click', () => {
        if (Number.isInteger(qty) && qty > 0) _refillMed(med, qty, confirm);
    });

    panel.append(picks, stepper, foot);
    paint();
    return panel;
}

function _buildInventoryCard(med) {
    const stock = formatStock(med.inventory_count, med);
    const card = _medsEl('div', 'wg-card wg-meds-stock__card');
    if (stock.state === 'danger') card.classList.add('wg-card--danger');
    card.dataset.medId = String(med.id);
    card.dataset.stock = stock.state;

    const head = _medsEl('div', 'wg-card__head');
    const titles = _medsEl('span', 'wg-vstack');
    titles.appendChild(_medsEl('span', 'wg-card__title wg-meds-stock__name',
        med.dosage ? `${med.name} · ${med.dosage}` : med.name));
    titles.appendChild(_medsEl('span', 'wg-meta wg-meds-stock__meta', _stockMeta(med)));
    const refilled = _medsEl('span', 'wg-meta wg-meds-stock__refilled');
    refilled.hidden = true;
    titles.appendChild(refilled);
    head.appendChild(titles);
    if (stock.state !== 'ok') {
        const chip = window.WGChip.create({ text: stock.state === 'danger' ? 'Out' : 'Low', state: stock.state });
        chip.classList.add('wg-meds-stock__chip');
        head.appendChild(chip);
    }
    card.appendChild(head);

    const row = _medsEl('div', 'wg-hstack');
    const count = _medsEl('span', 'wg-stat__value wg-meds-stock__count', String(Math.max(0, med.inventory_count)));
    count.appendChild(_medsEl('small', '', 'doses'));
    row.appendChild(count);
    row.appendChild(_medsEl('span', 'wg-spacer'));
    const refillBtn = _medsEl('button', 'wg-btn wg-btn--sm wg-meds-stock__refill-btn');
    refillBtn.type = 'button';
    refillBtn.appendChild(_medsIcon('box', 'wg-ico--sm'));
    refillBtn.appendChild(document.createTextNode('Refill'));
    row.appendChild(refillBtn);
    card.appendChild(row);

    const panel = _buildRefillPanel(med, () => {
        panel.hidden = true;
        refillBtn.hidden = false;
    });
    card.appendChild(panel);
    refillBtn.addEventListener('click', () => {
        panel.hidden = false;
        refillBtn.hidden = true;
    });

    return card;
}

function renderInventory() {
    const list = document.getElementById('med-inventory-list');
    if (!list) return;
    list.replaceChildren();
    list.classList.add('wg-meds-stock');

    const tracked = (Array.isArray(medications) ? medications : [])
        .filter((m) => m && m.inventory_count !== null && m.inventory_count !== undefined)
        .sort((a, b) => _stockRank(a) - _stockRank(b) || (a.name || '').localeCompare(b.name || ''));

    if (tracked.length === 0) {
        list.appendChild(createEmptyState({
            icon: 'box',
            title: 'No inventory tracked',
            body: 'Turn on inventory tracking when you edit a medication to get a warning before you run out.',
        }));
        syncMedsAddButton();
        return;
    }

    tracked.forEach((med) => {
        const card = _buildInventoryCard(med);
        list.appendChild(card);
        // Kick off the last-refilled fetch; fill the line in-place when it
        // resolves so the rest of the card paints immediately. If the card
        // has been detached (e.g. another render supplanted it), drop the
        // update — its querySelector would silently target a stale node.
        _fetchLastRefilledAt(med.id).then((iso) => {
            if (!card.isConnected) return;
            const line = card.querySelector('.wg-meds-stock__refilled');
            const formatted = _formatRestockedDate(iso);
            if (!line || !formatted) return;
            line.textContent = `Last refilled ${formatted}`;
            line.hidden = false;
        });
    });
    syncMedsAddButton();
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
    list.replaceChildren(createOfflineEmptyState());
    syncMedsAddButton();
}

// Logic
async function loadMeds() {
    // Refresh the plan-aware forecast before any render below reads it. In
    // cloud mode this is a local shim read (IndexedDB, no network), so it does
    // not delay the first paint; in the legacy bot server the route is absent
    // and renderMeds falls back to the device-local computation. Do NOT drop
    // this call when touching the Upcoming sub-tab: the Schedule hour buckets
    // read the same state (bd med-gut.1), and without it they silently regress
    // to device-local time math that disagrees with Home's next-intake card.
    await loadUpcomingDoses();
    // Keeps the Upcoming pane in step with every meds refresh (mutation, SSE
    // change event, sync) off the fetch we just did. No-op when that pane
    // isn't in the document.
    renderUpcomingDoses();

    if (initialAuthLoad) {
        initialAuthLoad = false;
        // `medications` already set by applyBootstrapPayload, hydrateMedicationsFromDexie,
        // or the cached-auth path; the corresponding cache write already ran with the
        // authoritative timestamp (Date.now() for bootstrap, preserved Dexie age for
        // hydration). Skip a redundant setCached/saveCache here — restamping would
        // overwrite the hydration-preserved timestamp.
        renderMeds();
        populateMedFilter();
        // Refresh in background to ensure up-to-date data. fetchFresh writes to
        // api_cache (with Date.now()) internally; we only need to mirror the
        // result into MedicationStore so subsequent cold-start hydration sees it.
        const res = await window.DataStore.fetchFresh(
            'medications',
            async () => await apiCall('/api/medications?archived=true'),
            ['medications']
        );
        if (res) {
            medications = res;
            if (window.MedTrackerDB?.MedicationStore) {
                await window.MedTrackerDB.MedicationStore.saveCache(medications);
            }
            renderMeds();
            populateMedFilter();
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
        },
        onFresh: async (fresh) => {
            renderedSomething = true;
            medications = fresh;
            if (window.MedTrackerDB?.MedicationStore) {
                await window.MedTrackerDB.MedicationStore.saveCache(medications);
            }
            renderMeds();
            populateMedFilter();
        },
        onError: async (_err, cached) => {
            if (cached) {
                renderedSomething = true;
                return;
            }
            // API failed and no ApiCache hit; fall back to offline cache
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
                }
            }
            if (!fallbackHadData) {
                renderMedsEmptyState();
            }
        }
    });

    if (!renderedSomething) {
        renderMedsEmptyState();
    }
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
        const days = window.MedicationUtils.getPickedDays(document.querySelector('#days-container .wg-picks'));

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
        // Optimistic: project the new/edited medication into the cached
        // `medications` array so the Meds Schedule list repaints before the
        // POST resolves. Edit replaces the matching row; create appends a
        // synthetic row with a `local_*` id (reconciled by the post-commit
        // loadMeds() refetch which writes authoritative server data).
        const editingId = editingMedId;
        const localId = `local_optimistic_${Date.now()}`;
        const projected = {
            id: editingId || localId,
            name: payload.name,
            dosage: payload.dosage,
            schedule: payload.schedule,
            archived: !!payload.archived,
            supplement: !!payload.supplement,
            start_date: payload.start_date,
            end_date: payload.end_date,
            inventory_count: payload.inventory_count,
            tz_shift_policy: payload.tz_shift_policy,
            _optimistic: true
        };
        const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
            ? await window.DataStore.applyOptimistic('medications', (prev) => {
                const base = Array.isArray(prev) ? prev : [];
                if (editingId) {
                    return base.map((m) => (m && m.id === editingId ? { ...m, ...projected, id: editingId } : m));
                }
                return [...base, projected];
            }, ['medications'])
            : null;

        let res;
        try {
            // (window.offlineAwareApiCall || window.apiCallDirect): routes through
            // the cloud shim when installed (see apishim.js), falling back to a
            // direct fetch in bot mode — same precedent as journey.js's load().
            // Plain apiCall() can't be used here: it swallows the error and shows
            // a generic alert, but this catch needs e.status to detect a 409
            // name+dosage duplicate and show a friendlier message.
            const directCall = window.offlineAwareApiCall || window.apiCallDirect;
            if (editingMedId) {
                res = await directCall(`/api/medications/${editingMedId}`, 'POST', payload);
            } else {
                res = await directCall('/api/medications', 'POST', payload);
            }
        } catch (e) {
            if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
            if (e.status === 409) {
                safeAlert("A medication with this name and dosage already exists. Please use a different name or dosage.");
            } else {
                safeToast("Error: " + e.message, 'error');
            }
            return;
        }

        if (res === null) {
            if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
            return;
        }

        // The interaction already showed inline before Save (kit M5); alert
        // only when that check never resolved (offline, typed then saved).
        if (res.warning && document.getElementById('med-rx-warning').classList.contains('hidden')) {
            safeAlert(res.warning);
        }

        if (handle) { try { await handle.commit(null); } catch (_) { /* best-effort */ } }

        await window.DataStore.invalidateTags(['medications', 'history', 'gamification']);
        await window.DataStore.invalidateKey('next_intake');

        closeModal();
        loadMeds();
    });
}

async function deleteMed(id) {
    const med = medications.find(m => m.id === id);
    if (!med) return;

    // Permanent delete (archived meds only) is a destructive dialog; resolves
    // true once the medication is gone.
    if (med.archived) {
        const confirmMsg = "Delete this medication permanently? This can't be undone.";
        return safeConfirm(confirmMsg, async (ok) => {
            if (!ok) return false;
            // Optimistic: drop the medication from the cached list so the
            // Schedule row vanishes before DELETE resolves.
            const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
                ? await window.DataStore.applyOptimistic('medications', (prev) => {
                    if (!Array.isArray(prev)) return prev;
                    return prev.filter((m) => !(m && m.id === id));
                }, ['medications'])
                : null;

            let res;
            try {
                res = await apiCall(`/api/medications/${id}`, 'DELETE');
            } catch (e) {
                if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
                throw e;
            }
            if (res === null) {
                if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
                return false;
            }
            if (handle) { try { await handle.commit(null); } catch (_) { /* best-effort */ } }
            await window.DataStore.invalidateTags(['medications', 'history', 'gamification']);
            await window.DataStore.invalidateKey('next_intake');
            loadMeds();
            return true;
        }, { title: 'Delete medication', confirmLabel: 'Delete', destructive: true, icon: 'trash' });
    } else {
        // Archiving is the schedule row's delete: gone at once, Undo from the
        // toast (kit rule 3). Permanent delete above stays a dialog.
        return deleteWithUndo({
            message: `${med.name} archived`,
            optimistic: [{ key: 'medications', mutator: (prev) => _medsArchived(prev, id), tags: ['medications'] }],
            remove: () => _archiveMedApi(med),
            replay: { fn: '_archiveMedById', arg: id },
        });
    }
}

function _medsArchived(prev, id) {
    if (!Array.isArray(prev)) return prev;
    return prev.map((m) => (m && m.id === id ? { ...m, archived: true, _optimistic: true } : m));
}

// Boot replay of an archive the last page never sent: the journal keeps only
// the id, so re-read the med (name/dosage stay inside the vault).
async function _archiveMedById(id) {
    const list = await apiCall('/api/medications?archived=true');
    const med = Array.isArray(list) ? list.find((m) => m && m.id === id) : null;
    if (!med || med.archived) return true;
    return _archiveMedApi(med);
}

// The archive POST. Resolves true on success.
async function _archiveMedApi(med) {
    const id = med.id;
    const payload = {
        name: med.name,
        dosage: med.dosage,
        schedule: med.schedule,
        supplement: !!med.supplement,
        archived: true
    };

    // Optimistic: flip archived=true on the cached row so the Schedule
    // tab moves the med into the archived bucket before POST resolves.
    const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
        ? await window.DataStore.applyOptimistic('medications', (prev) => _medsArchived(prev, id), ['medications'])
        : null;

    let res;
    try {
        res = await apiCall(`/api/medications/${id}`, 'POST', payload);
    } catch (e) {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        throw e;
    }
    if (res === null) {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        return false;
    }
    if (res && res.warning) {
        safeAlert(res.warning);
    }
    if (handle) { try { await handle.commit(null); } catch (_) { /* best-effort */ } }
    await window.DataStore.invalidateTags(['medications', 'history', 'gamification']);
    await window.DataStore.invalidateKey('next_intake');
    loadMeds();
    return true;
}

// Take sheet (kit M2). One sheet, three modes: confirm (primary "Take N",
// Snooze/Skip ghost actions), edit ("Update") and log_past ("Log"). Each row
// is a .wg-choice--check toggle button; `.med-confirm-check[aria-pressed]`
// is the selection the meds-history.js write handlers read.
const MED_CONFIRM_PRIMARY = { confirm: 'Take', edit: 'Update', log_past: 'Log' };
const MED_CONFIRM_EYEBROW = { confirm: 'Time for meds', edit: 'Edit intake', log_past: 'Log intake' };

function _medConfirmTimeLabel(value, isNow) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return isNow ? 'Now' : '';
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isNow) return `Now · ${hm}`;
    return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} · ${hm}`;
}

// Live count on the primary: "Take 3"; toggling a row updates it.
function _syncMedConfirmPrimary(mode) {
    const actionBtn = document.getElementById('med-confirm-action-btn');
    if (!actionBtn) return;
    actionBtn.replaceChildren(MED_CONFIRM_PRIMARY[mode] || MED_CONFIRM_PRIMARY.confirm);
    if (mode !== 'confirm') return;
    const n = document.querySelectorAll('#med-confirm-list .med-confirm-check[aria-pressed="true"]').length;
    actionBtn.append(' ', _medsEl('span', 'wg-btn__count', String(n)));
}

function _buildMedConfirmChoice(index, name, med, mode) {
    const btn = _medsEl('button', 'wg-choice wg-choice--check med-confirm-check');
    btn.type = 'button';
    btn.dataset.index = String(index);
    btn.setAttribute('aria-pressed', 'true');
    const label = _medsEl('span', '', name);
    if (med && med.dosage) label.appendChild(_medsEl('span', 'wg-choice__sub', med.dosage));
    btn.appendChild(label);
    if (med && med.inventory_count !== null && med.inventory_count !== undefined) {
        const stock = formatStock(med.inventory_count, med);
        if (stock.state !== 'ok') {
            const chip = window.WGChip.create({ text: stock.label, state: stock.state, small: true });
            chip.classList.add('wg-choice__trail');
            btn.appendChild(chip);
        }
    }
    btn.addEventListener('click', () => {
        btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
        _syncMedConfirmPrimary(mode);
    });
    return btn;
}

function showMedicationConfirmModal(ids, names, scheduledAt, mode = 'confirm', intakeIds = []) {
    window.PushModalState.openMedConfirm({
        ids,
        names,
        scheduled: scheduledAt,
        mode,
        intakeIds,
    });

    window.ModalManager.medConfirm.open();

    const eyebrowEl = document.getElementById('med-confirm-eyebrow');
    const titleEl = document.getElementById('med-confirm-title');
    const timeInput = document.getElementById('med-confirm-datetime');
    const timeValue = document.getElementById('med-confirm-time-value');
    const actionBtn = document.getElementById('med-confirm-action-btn');
    const snoozeBtn = document.getElementById('med-confirm-snooze-btn');
    const skipBtn = document.getElementById('med-confirm-skip-btn');

    let timeStr = scheduledAt;
    try {
        const d = new Date(scheduledAt);
        timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (_) { /* keep raw */ }

    // The eyebrow names the action, the title names the slot (or the med
    // being logged) — they never repeat each other.
    eyebrowEl.textContent = MED_CONFIRM_EYEBROW[mode] || MED_CONFIRM_EYEBROW.confirm;
    titleEl.textContent = mode === 'log_past' ? (names[0] || '') : String(timeStr || '');

    // "Time taken": edit / log_past start at the given time (edit = the dose's
    // taken_at), confirm starts at now and sends taken_at only once the user
    // picks a different time (dataset.edited, see onMedConfirmTimeChange).
    const timeSource = mode === 'confirm' ? new Date() : scheduledAt;
    delete timeInput.dataset.edited;
    timeInput.classList.remove('wg-med-confirm-modal__input--shown');
    timeInput.setAttribute('tabindex', '-1');
    try {
        timeInput.value = formatDateTimeLocalForInput(timeSource);
    } catch (e) {
        console.error("Error formatting date for input", e);
    }
    timeValue.textContent = _medConfirmTimeLabel(timeSource, mode === 'confirm');

    if (mode === 'edit' || mode === 'log_past') {
        actionBtn.onclick = mode === 'edit' ? updateIntakeHistory : confirmLogPast;
        snoozeBtn.classList.add('hidden');
        skipBtn.classList.add('hidden');
    } else {
        actionBtn.onclick = confirmSelectedMedications;
        // An upcoming slot with no intake yet (Schedule "Take N") can be taken
        // early, but there is nothing to snooze or skip until it materializes.
        const unmaterialized = !(intakeIds && intakeIds.length) && new Date(scheduledAt).getTime() > Date.now();
        snoozeBtn.classList.toggle('hidden', unmaterialized);
        skipBtn.classList.toggle('hidden', unmaterialized);
    }

    const medById = new Map((Array.isArray(medications) ? medications : []).map((m) => [String(m.id), m]));
    const list = document.getElementById('med-confirm-list');
    list.replaceChildren(...ids.map((id, index) => _buildMedConfirmChoice(
        index, names[index] || ('Medication ' + id), medById.get(String(id)), mode)));
    _syncMedConfirmPrimary(mode);
}

// The "Time taken" value row opens the hidden datetime picker (app.js binds).
function openMedConfirmTimePicker() {
    const input = document.getElementById('med-confirm-datetime');
    if (!input) return;
    if (typeof input.showPicker === 'function') {
        try { input.showPicker(); return; } catch (_) { /* fall back below */ }
    }
    // No programmatic picker: reveal the input itself as an editable field.
    input.classList.add('wg-med-confirm-modal__input--shown');
    input.removeAttribute('tabindex');
    input.focus();
}

function onMedConfirmTimeChange() {
    const input = document.getElementById('med-confirm-datetime');
    if (!input || !input.value) return;
    input.dataset.edited = '1';
    document.getElementById('med-confirm-time-value').textContent = _medConfirmTimeLabel(input.value, false);
}
