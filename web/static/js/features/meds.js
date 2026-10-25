// ==================== Medication render + modal flow ====================
// Extracted from app.js in Phase 5 Task 1. These functions remain global
// (script-tag loading) and still rely on helpers from features/medication-utils.js
// (parseMedicationSchedule, getNextScheduledDate, getMedicationScheduleText,
// getLastTakenTimeMs — reached via window.MedicationUtils.*) plus app.js
// helpers (isLowOnStock, formatDate, apiCall, withSubmit, safeAlert,
// safeConfirm, editingMedId, medications, initialAuthLoad, etc.).

// Sub-tab state: Timeline · Schedule · Stock (bd med-wi09.3; Stock keeps its
// `inventory` id). Scoped to sessionStorage so every fresh launch lands on the
// Timeline default; an in-session tab click survives reloads within the same
// tab. The retired History and Upcoming panes map to the timeline that
// replaced them, so a stored or passed legacy value never lands on nothing.
// Legacy mt-meds-subtab localStorage values are cleared on boot.
const MEDS_SUBTAB_STORAGE_KEY = 'mt-meds-subtab';
const MEDS_SUBTAB_OPTIONS = ['timeline', 'schedule', 'inventory'];
const MEDS_SUBTAB_DEFAULT = 'timeline';
const MEDS_SUBTAB_LEGACY = { history: 'timeline', upcoming: 'timeline' };

function _normalizeMedsSubTab(tab) {
    const mapped = MEDS_SUBTAB_LEGACY[tab] || tab;
    return MEDS_SUBTAB_OPTIONS.indexOf(mapped) !== -1 ? mapped : null;
}

function getActiveMedsSubTab() {
    try {
        const tab = _normalizeMedsSubTab(window.sessionStorage.getItem(MEDS_SUBTAB_STORAGE_KEY));
        if (tab) return tab;
    } catch (_) { /* ignore */ }
    return MEDS_SUBTAB_DEFAULT;
}

function setActiveMedsSubTab(tab) {
    tab = _normalizeMedsSubTab(tab);
    if (!tab) return;
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
let _medsUpcomingState = { doses: [], available: false, due: [] }; // module-state: plan-aware upcoming doses + due (pending) intakes behind the Schedule buckets

async function loadUpcomingDoses() {
    const read = (path) => Promise.resolve().then(() => apiCall(path)).catch(() => null);
    const nowMs = Date.now();
    const [res, doses] = await Promise.all([
        read(`/api/medications/upcoming?days=${MEDS_UPCOMING_DAYS}`),
        // Missed + overdue doses: the occurrence projection's `due` rows over
        // the same 24h window the Meds tab badge counts (features/app-nav.js
        // countDueDoses) — the projection owns the rule.
        read(`/api/doses?from=${new Date(nowMs - 24 * 60 * 60 * 1000).toISOString()}&to=${new Date(nowMs).toISOString()}`),
    ]);
    // `available` separates "the forecast answered, and this med simply has
    // no upcoming dose" from "there is no forecast to consult" (offline /
    // route unavailable) — only the latter may fall back to the device-local
    // computation.
    _medsUpcomingState.available = Array.isArray(res);
    _medsUpcomingState.doses = Array.isArray(res) ? res : [];
    _medsUpcomingState.due = (Array.isArray(doses) ? doses : []).filter((r) => r && r.state === 'due');
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
// action and a `.wg-list` of rows. tone: 'dot' (upcoming); pending: a due
// slot, labelled with a Pending chip (no "missed" state — owner, med-wi09).
function _buildMedsBucket(label, { tone, pending, action, rows }) {
    const section = _medsEl('section', 'wg-section wg-meds-bucket');
    const head = _medsEl('div', 'wg-section__head');
    const eyebrow = _medsEl('span', `wg-eyebrow${tone ? ` wg-eyebrow--${tone}` : ''} wg-meds-bucket__label`, label);
    if (pending) {
        const stack = _medsEl('span', 'wg-hstack');
        stack.appendChild(eyebrow);
        stack.appendChild(window.WGChip.create({ text: 'Pending', state: 'pending', small: true }));
        head.appendChild(stack);
    } else {
        head.appendChild(eyebrow);
    }
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
// Missed rows carry their occIds; an upcoming slot's occId is its
// deterministic slot id, derived by the take sheet (meds-history.js
// _medConfirmOccId) — POST /api/doses/act either way.
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

// Course dates as row copy: "since Sep 12", "until Oct 1", "Sep 12 – Oct 1";
// '' when open on both ends. The editor stores a picked day as UTC midnight
// and reads it back via split('T')[0], so format that date part as a
// wall-clock day, never the instant (med-aec1).
function _formatMedDay(iso) {
    const parts = String(iso || '').split('T')[0].split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return '';
    return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function _formatMedDateRange(startIso, endIso) {
    const start = _formatMedDay(startIso);
    const end = _formatMedDay(endIso);
    if (start && end) return `${start} – ${end}`;
    if (start) return `since ${start}`;
    if (end) return `until ${end}`;
    return '';
}

// A schedule row (kit .wg-row): title "Name · dose", meta = schedule · dates ·
// Rx plus status chips. Tap edits; swipe / overflow reveals Edit and Delete.
// As-needed rows keep a per-row Log; scheduled rows log off-schedule doses
// from the overflow menu (their bucket head owns Take / Log late).
// opts.missed (a due dose) paints the lead in the pending tone.
function _buildMedsRow(med, parsedSchedule, opts = {}) {
    const row = _medsEl('div', 'wg-row wg-meds-row med-item');
    row.dataset.medId = String(med.id);
    if (med.archived) row.classList.add('archived', 'wg-row--muted');

    const lead = _medsEl('span', opts.missed ? 'wg-row__lead wg-row__lead--sky' : 'wg-row__lead');
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
    const dates = _formatMedDateRange(med.start_date, med.end_date);
    if (dates) meta.appendChild(_medsEl('span', 'wg-meds-row__dates', `· ${dates}`));
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
    (_medsUpcomingState.due || []).forEach((dose) => {
        const med = medById.get(String(dose.medId));
        const at = new Date(dose.plannedAt);
        if (!med || med.archived || Number.isNaN(at.getTime())) return;
        const schedule = window.MedicationUtils.parseMedicationSchedule(med.schedule);
        if ((schedule?.type || 'daily') === 'as_needed') return;
        if (!missedBuckets.has(dose.plannedAt)) {
            missedBuckets.set(dose.plannedAt, { at, entries: [], intakeIds: [] });
        }
        const bucket = missedBuckets.get(dose.plannedAt);
        if (bucket.entries.some((e) => e.med === med)) return;
        bucket.entries.push({ med, schedule });
        if (dose.occId !== undefined && dose.occId !== null) bucket.intakeIds.push(dose.occId);
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
        const time = `${_pad2(bucket.at.getHours())}:${_pad2(bucket.at.getMinutes())}`;
        const label = bucket.at.getTime() >= todayStart ? time : `${time} · yesterday`;
        list.appendChild(_buildMedsBucket(label, {
            pending: true,
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

// ==================== Timeline sub-tab (kit v2 TL1–TL4, bd med-ry7b) ====================
// One pane in time order (screens-meds-timeline-v2.html): the future on top,
// folded to one "Planned" row per day under "Show 3 more days ahead"; Today,
// led by the focus card (the one pending dose to act on + the next dose due
// today); History, Yesterday and the day before, over "Show 3 earlier days".
// Every row is the occurrence projection's own (GET /api/doses), so it is the
// dose — id, time, state — Telegram and the notifications show. Rows act on
// their own occIds (data-occ-ids, bd med-wi09.17): a pending row has Take /
// Skip and a tap opens the take sheet (M2); a taken or skipped row opens it in
// edit mode (MT3); a past day with pending doses gets "Mark all taken" /
// "Skip all", undone from the toast (MT4). Every write is POST /api/doses/act
// through _tlAct / the sheet handlers, flipped in place first (applyOptimistic
// on MEDS_TIMELINE_KEY and MEDS_TIMELINE_PENDING_KEY).
//
// Two reads, both local in cloud mode: the display window (one /api/doses
// range that widens with the "Show 3 …" rows, read a page beyond what is
// shown so a tap renders at once) and the pending-only read the focus card
// picks from (status=due,snoozed up to now), so no pending dose is ever out of
// sight — at worst it is the card while its own day lies beyond the loaded
// History. No "missed": a dose stays pending until it is taken or skipped.
//
// Rows group by (localDate, localTime, tz, state) exactly as the projection
// stamped them, never by the device clock: a row keeps its own date across a
// zone change, the same local time in two zones never merges, and a group
// whose meds are in different states splits (Pending vs Done).
const MEDS_TIMELINE_AHEAD_DAYS = 1; // future days on open (Tomorrow)
const MEDS_TIMELINE_BACK_DAYS = 2; // past days on open (Yesterday + the day before)
const MEDS_TIMELINE_PAGE_DAYS = 3; // days per "Show 3 …" tap
const MEDS_TIMELINE_MAX_AHEAD_DAYS = 30; // the projection's forecast horizon
const MEDS_TIMELINE_LEAD = {
    upcoming: ['', 'pill'],
    due: ['wg-row__lead--sky', 'clock'],
    snoozed: ['wg-row__lead--sky', 'clock'],
    taken: ['wg-row__lead--ok', 'check'],
    skipped: ['wg-row__lead--stale', 'minus'],
};
const MEDS_TIMELINE_KEY = 'doses_timeline'; // DataStore key of the window's projection rows
const MEDS_TIMELINE_PENDING_KEY = 'doses_pending'; // DataStore key of the pending-only read
// Window rows, pending rows, the shown window (days ahead / back, reset on
// every visit), unfolded planned days, the latest read's sequence number +
// the read queue, the MT6 note.
let _medsTimelineState = { rows: null, pending: null, ahead: MEDS_TIMELINE_AHEAD_DAYS, back: MEDS_TIMELINE_BACK_DAYS, open: new Set(), seq: 0, chain: null, ctx: null, outOfDate: null }; // module-state: the timeline's rows, window and read queue

// 'YYYY-MM-DD' of an instant on the tracked zone's calendar.
function _tlDatePart(ms, tz) {
    const opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
    try { return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: tz }).format(new Date(ms)); }
    catch (_) { return new Intl.DateTimeFormat('en-CA', opts).format(new Date(ms)); }
}

// 'HH:MM' of an instant on the tracked zone's clock.
function _tlClock(iso, tz) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const opts = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    try { return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz }).format(d); }
    catch (_) { return `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`; }
}

// Calendar arithmetic on a 'YYYY-MM-DD' label (UTC, so no DST drift).
function _tlDayMs(ymd) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}

function _tlShiftDate(ymd, days) {
    return new Date(_tlDayMs(ymd) + days * 86400000).toISOString().slice(0, 10);
}

// 'Fri 23.10'
function _tlDayName(ymd) {
    const at = new Date(_tlDayMs(ymd));
    const weekday = at.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
    return `${weekday} ${_pad2(at.getUTCDate())}.${_pad2(at.getUTCMonth() + 1)}`;
}

function _tlZoneCity(tz) {
    return String(tz || '').split('/').pop().replace(/_/g, ' ');
}

function _tlAgo(ms) {
    const minutes = Math.max(0, Math.round(ms / 60000));
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const _TL_STATE_ORDER = { due: 0, snoozed: 1, upcoming: 2, taken: 3, skipped: 4 };

// Groups ascending by planned instant; same instant → pending before done.
function _tlGroups(rows) {
    const byKey = new Map();
    rows.forEach((r) => {
        const key = `${r.localDate}|${r.localTime}|${r.tz}|${r.state}`;
        if (!byKey.has(key)) {
            byKey.set(key, { localDate: r.localDate, localTime: r.localTime, tz: r.tz, state: r.state, at: Date.parse(r.plannedAt), rows: [] });
        }
        byKey.get(key).rows.push(r);
    });
    return Array.from(byKey.values()).sort((a, b) => (a.at - b.at) || (_TL_STATE_ORDER[a.state] - _TL_STATE_ORDER[b.state]));
}

// Name from the medications list (String ids — a vault can hold a number on
// one side and a string on the other, bd med-wi09.15), else the row's own.
function _tlMedLabel(r, ctx) {
    const med = ctx.medById.get(String(r.medId));
    const name = (med && med.name) || r.name || 'Medication';
    const dosage = (med && med.dosage) || r.dosage || '';
    return dosage ? `${name} ${dosage}` : name;
}

function _tlChip(group, ctx) {
    const first = group.rows[0];
    switch (group.state) {
    case 'upcoming':
        return window.WGChip.create({ text: _formatNextActionRelative(group.at - ctx.nowMs), state: 'pending', small: true });
    case 'due':
        return window.WGChip.create({
            text: group.localDate === ctx.todayDate ? `Due ${_tlAgo(ctx.nowMs - group.at)}` : 'Due',
            state: 'pending',
            small: true,
        });
    case 'snoozed':
        return window.WGChip.create({ text: `Snoozed until ${_tlClock(first.snoozedUntil, ctx.tz)}`, state: 'pending', small: true });
    case 'taken': {
        const takenAt = group.rows.map((r) => r.takenAt).filter(Boolean).sort()[0];
        return window.WGChip.create({ text: takenAt ? `Taken ${_tlClock(takenAt, ctx.tz)}` : 'Taken', state: 'ok', small: true });
    }
    case 'skipped':
        return window.WGChip.create({ text: 'Skipped', state: 'stale', small: true });
    default:
        return null;
    }
}

const _tlIsPending = (g) => g.state === 'due' || g.state === 'snoozed';
const _tlIsDone = (g) => g.state === 'taken' || g.state === 'skipped';

// A row tap opens the take sheet on exactly the group's occIds: a pending
// group in confirm mode (Take at a time, Skip, Snooze — M2), a taken or
// skipped one in edit mode (Taken / Skipped / Not taken + the time — MT3).
function _tlOpenSheet(group, ctx) {
    const rows = group.rows;
    const medIds = rows.map((r) => r.medId);
    const names = rows.map((r) => {
        const med = ctx.medById.get(String(r.medId));
        return (med && med.name) || r.name || 'Medication';
    });
    const occIds = rows.map((r) => r.occId);
    if (_tlIsPending(group)) {
        showMedicationConfirmModal(medIds, names, rows[0].plannedAt, 'confirm', occIds);
        return;
    }
    const takenAt = rows.map((r) => r.takenAt).filter(Boolean).sort()[0];
    showMedicationConfirmModal(medIds, names, takenAt || rows[0].plannedAt, 'edit', occIds, rows.map((r) => r.state));
}

function _tlRowButton(label, ghost, onClick) {
    const btn = _medsEl('button', `wg-btn wg-btn--sm${ghost ? ' wg-btn--ghost' : ''}`, label);
    btn.type = 'button';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
    });
    return btn;
}

// One group = one kit row. Upcoming rows are read-only (Schedule's Take N
// takes them early); every other row is a button that opens the sheet.
// readOnly (an unfolded planned day): no sheet, no buttons, whatever the state.
function _tlRow(group, ctx, { chip = true, readOnly = false } = {}) {
    const row = _medsEl('div', 'wg-row wg-timeline__row');
    row.dataset.state = group.state;
    row.dataset.localDate = group.localDate;
    row.dataset.occIds = group.rows.map((r) => String(r.occId)).join(' ');
    row.dataset.medIds = group.rows.map((r) => String(r.medId)).join(' ');
    if (group.state !== 'upcoming' && !readOnly) {
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.addEventListener('click', () => _tlOpenSheet(group, ctx));
        row.addEventListener('keydown', (e) => {
            if (e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            _tlOpenSheet(group, ctx);
        });
    }

    const [leadMod, icon] = MEDS_TIMELINE_LEAD[group.state] || MEDS_TIMELINE_LEAD.upcoming;
    const lead = _medsEl('span', leadMod ? `wg-row__lead ${leadMod}` : 'wg-row__lead');
    lead.appendChild(_medsIcon(icon));
    row.appendChild(lead);

    const body = _medsEl('span', 'wg-row__body');
    // A zone shows only when it differs from the tracked one ("08:20 · Berlin"),
    // with the time here as meta.
    const otherZone = group.tz && group.tz !== ctx.tz;
    body.appendChild(_medsEl('span', 'wg-row__title wg-row__title--mono',
        otherZone ? `${group.localTime} · ${_tlZoneCity(group.tz)}` : group.localTime));
    const names = group.rows.map((r) => _tlMedLabel(r, ctx)).join(' · ');
    const meta = _medsEl('span', 'wg-row__meta',
        otherZone ? `${_tlClock(group.rows[0].plannedAt, ctx.tz)} here · ${names}` : names);
    const first = group.rows[0];
    if (first.source === 'tz_step' && first.stepNumber) {
        meta.appendChild(_medsEl('span', 'wg-tag', `Step ${first.stepNumber} of ${first.totalSteps || first.stepNumber}`));
    }
    const chipEl = chip ? _tlChip(group, ctx) : null;
    if (chipEl) meta.appendChild(chipEl);
    body.appendChild(meta);
    row.appendChild(body);
    // Pending rows keep Take / Skip for the odd one out (MT4); Take stamps now.
    if (_tlIsPending(group) && !readOnly) {
        const occIds = group.rows.map((r) => r.occId);
        const trail = _medsEl('span', 'wg-row__trail');
        trail.appendChild(_tlRowButton('Skip', true, () => _tlAct('skip', [{ occIds }])));
        trail.appendChild(_tlRowButton('Take', false, () => _tlAct('take', [{ occIds }])));
        row.appendChild(trail);
    }
    return row;
}

// rows.map that merges patches[occId] into the matching rows.
function _tlPatchRows(patches) {
    return (rows) => rows.map((r) => (r && patches.has(String(r.occId)) ? { ...r, ...patches.get(String(r.occId)) } : r));
}

// The optimistic row of a past log (no plan behind it) until the re-read.
function _tlManualRow(medId, takenAt) {
    const tz = (_medsTimelineState.ctx && _medsTimelineState.ctx.tz) || Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
        occId: `local_optimistic_${Date.now()}`,
        medId: String(medId),
        plannedAt: takenAt,
        tz,
        localDate: _tlDatePart(Date.parse(takenAt), tz),
        localTime: _tlClock(takenAt, tz),
        source: 'manual',
        state: 'taken',
        takenAt,
    };
}

// Optimistic timeline write: the cached projection rows (MEDS_TIMELINE_KEY and
// the pending-only MEDS_TIMELINE_PENDING_KEY, what loadTimeline reads while
// the write is pending) and the rows on screen all take mutator(rows) at once.
// Returns an applyOptimistic handle whose rollback also restores the screen.
async function _applyOptimisticTimeline(mutator) {
    const state = _medsTimelineState;
    const prior = { rows: state.rows, pending: state.pending };
    const apply = (rows) => (Array.isArray(rows) ? mutator(rows) : rows);
    const handles = [await window.DataStore.applyOptimistic(MEDS_TIMELINE_KEY, apply, ['history'])];
    try {
        handles.push(await window.DataStore.applyOptimistic(MEDS_TIMELINE_PENDING_KEY, apply, ['history']));
    } catch (e) {
        // A half-applied write would leave the first key pending forever.
        await handles[0].rollback();
        throw e;
    }
    if (Array.isArray(prior.rows)) {
        state.rows = apply(prior.rows);
        state.pending = apply(prior.pending);
        renderTimeline();
    }
    return {
        commit: (payload) => Promise.all(handles.map((h) => h.commit(payload))),
        async rollback() {
            await Promise.all(handles.map((h) => h.rollback()));
            if (Array.isArray(prior.rows)) {
                state.rows = prior.rows;
                state.pending = prior.pending;
                renderTimeline();
            }
        },
    };
}

// The timeline's own writes (row Take / Skip, bulk, the bulk Undo): flip the
// rows in place, POST /api/doses/act once per batch ({occIds, takenAt?} — one
// taken_at each), then commit, or roll back on any failure. Resolves true
// when every id applied.
async function _tlAct(action, batches) {
    const nowIso = new Date().toISOString();
    const patch = (takenAt) => ({
        take: { state: 'taken', takenAt: takenAt || nowIso },
        skip: { state: 'skipped', takenAt: null },
        undo: { state: 'due', takenAt: null },
    }[action]);
    const patches = new Map();
    batches.forEach((b) => b.occIds.forEach((id) => patches.set(String(id), patch(b.takenAt))));
    if (!patches.size) return false;

    const handles = [await _applyOptimisticTimeline(_tlPatchRows(patches))];
    if (action !== 'undo') handles.push(await _applyOptimisticDueClear((row) => patches.has(String(row.occId))));
    let ok = true;
    try {
        for (const b of batches) {
            const body = { action, occ_ids: b.occIds };
            if (b.takenAt) body.taken_at = b.takenAt;
            const res = await apiCall('/api/doses/act', 'POST', body);
            if (!res || typeof res !== 'object') { ok = false; break; }
            if (Number(res.failed) > 0) {
                ok = false;
                safeToast("Couldn't update some doses. Please try again.", 'error');
                break;
            }
        }
    } catch (_) {
        ok = false;
    }
    if (ok) {
        await _commitOptimistic(handles);
        if (window.DataStore) await window.DataStore.invalidateTags(['gamification']).catch(() => {});
    } else {
        await _rollbackOptimistic(handles);
    }
    refreshMedsAfterMutation();
    return ok;
}

// MT4 · pile-up: one bulk pair per earlier day that still has pending doses.
// Acts only on that day's pending occIds at the moment of the tap (so a
// repeat tap finds nothing left to do); "Mark all taken" writes each dose's
// planned time. No dialog — the toast's Undo restores exactly those doses.
async function _tlBulk(action, date) {
    const pending = (_medsTimelineState.rows || []).filter((r) => r.localDate === date && (r.state === 'due' || r.state === 'snoozed'));
    if (!pending.length) return false;
    const batches = [];
    if (action === 'take') {
        const byPlanned = new Map();
        pending.forEach((r) => {
            if (!byPlanned.has(r.plannedAt)) byPlanned.set(r.plannedAt, []);
            byPlanned.get(r.plannedAt).push(r.occId);
        });
        byPlanned.forEach((occIds, takenAt) => batches.push({ occIds, takenAt }));
    } else {
        batches.push({ occIds: pending.map((r) => r.occId) });
    }
    if (!await _tlAct(action, batches)) return false;
    const n = pending.length;
    const occIds = pending.map((r) => r.occId);
    safeToast(`${n} dose${n === 1 ? '' : 's'} ${action === 'take' ? 'marked taken' : 'skipped'}`, 'success', {
        detail: _tlDayName(date),
        action: { label: 'Undo', onClick: () => _tlAct('undo', [{ occIds }]) },
        duration: 8000,
    });
    return true;
}

function _tlBulkActions(date) {
    const bar = _medsEl('div', 'wg-hstack wg-timeline__bulk');
    const take = _medsEl('button', 'wg-btn wg-btn--sm wg-spacer');
    take.type = 'button';
    take.append(_medsIcon('check', 'wg-ico--sm'), 'Mark all taken');
    take.addEventListener('click', () => _tlBulk('take', date));
    const skip = _medsEl('button', 'wg-btn wg-btn--ghost wg-btn--sm wg-spacer', 'Skip all');
    skip.type = 'button';
    skip.addEventListener('click', () => _tlBulk('skip', date));
    bar.append(take, skip);
    return bar;
}

function _tlHead(text, { tag = 'eyebrow', dot = false, meta } = {}) {
    const head = _medsEl('div', 'wg-section__head');
    head.appendChild(_medsEl('span', tag === 'label' ? 'wg-label' : `wg-eyebrow${dot ? ' wg-eyebrow--dot' : ''}`, text));
    if (meta) head.appendChild(_medsEl('span', 'wg-meta', meta));
    return head;
}

function _tlList(groups, ctx, opts) {
    const list = _medsEl('div', 'wg-list');
    groups.forEach((g) => list.appendChild(_tlRow(g, ctx, opts)));
    return list;
}

function _tlSkeletonList() {
    const list = _medsEl('div', 'wg-list');
    list.appendChild(_medsEl('span', 'wg-skel wg-skel--row'));
    list.appendChild(_medsEl('span', 'wg-skel wg-skel--row'));
    return list;
}

// "Show 3 more days ahead" / "Show 3 earlier days" (.wg-tl-more).
function _tlMoreButton(label, icon, onClick) {
    const btn = _medsEl('button', 'wg-tl-more');
    btn.type = 'button';
    btn.append(_medsIcon(icon, 'wg-ico--sm'), label);
    btn.addEventListener('click', onClick);
    return btn;
}

// A "Show 3 …" tap: the window is read a page beyond what is shown, so the
// new days render at once from rows already here; the re-read then widens the
// window for the next tap. No spinner, nothing loads by itself.
function _tlPage(change) {
    change(_medsTimelineState);
    renderTimeline();
    loadTimeline();
}

// "Yesterday" / "3 days ago" for a past day.
function _tlDaysAgo(date, ctx) {
    const days = Math.round((_tlDayMs(ctx.todayDate) - _tlDayMs(date)) / 86400000);
    return days === 1 ? 'Yesterday' : `${days} days ago`;
}

// TL1 / TL2 · the future: "Show 3 more days ahead" at the very top, then one
// folded, dashed "Planned" row per day, farthest first ("3 doses · first
// 08:20"). A tap unfolds that day's doses underneath, still planned: no
// buttons, no sheet. Fold state lasts the visit.
function _tlFutureSection(groups, ctx) {
    const state = _medsTimelineState;
    const section = _medsEl('section', 'wg-section wg-tl-planned wg-timeline__future');
    // The projection forecasts 30 days (medintake.js MAX_FORECAST_DAYS).
    if (state.ahead < MEDS_TIMELINE_MAX_AHEAD_DAYS) {
        section.appendChild(_tlMoreButton('Show 3 more days ahead', 'chev-u', () => _tlPage((s) => { s.ahead += MEDS_TIMELINE_PAGE_DAYS; })));
    }
    const list = _medsEl('div', 'wg-list');
    for (let i = state.ahead; i >= 1; i--) {
        const date = _tlShiftDate(ctx.todayDate, i);
        const day = groups.filter((g) => g.localDate === date);
        if (!day.length) continue;
        const open = state.open.has(date);
        const row = _medsEl('div', 'wg-row wg-tl-day');
        row.dataset.localDate = date;
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.setAttribute('aria-expanded', String(open));
        const lead = _medsEl('span', 'wg-row__lead');
        lead.appendChild(_medsIcon('calendar'));
        const body = _medsEl('span', 'wg-row__body');
        body.appendChild(_medsEl('span', 'wg-row__title', i === 1 ? `Tomorrow · ${_tlDayName(date)}` : _tlDayName(date)));
        body.appendChild(_medsEl('span', 'wg-row__meta', `${day.length} dose${day.length === 1 ? '' : 's'} · first ${day[0].localTime}`));
        row.append(lead, body, _medsEl('span', 'wg-tag', 'Planned'), _medsIcon(open ? 'chev-u' : 'chev-d', 'wg-row__chev'));
        const toggle = () => {
            if (open) state.open.delete(date);
            else state.open.add(date);
            renderTimeline();
            const again = document.querySelector(`#med-timeline-list .wg-tl-day[data-local-date="${date}"]`);
            if (again) again.focus();
        };
        row.addEventListener('click', toggle);
        row.addEventListener('keydown', (e) => {
            if (e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            toggle();
        });
        list.appendChild(row);
        if (open) day.forEach((g) => list.appendChild(_tlRow(g, ctx, { chip: false, readOnly: true })));
    }
    if (list.children.length) section.appendChild(list);
    return section;
}

// The focus card's pending dose: the latest of every pending dose — the
// pending-only read, overlaid by the window's rows (fresher where they meet:
// a dose taken from the sheet drops out at once) — ties due before snoozed.
// { focus: group | null, more: how many other pending doses }.
function _tlFocus(rows, pending, ctx) {
    const byOcc = new Map();
    (Array.isArray(pending) ? pending : []).forEach((r) => byOcc.set(String(r.occId), r));
    rows.forEach((r) => {
        const id = String(r.occId);
        if (byOcc.has(id) || r.state === 'due' || r.state === 'snoozed') byOcc.set(id, r);
    });
    const all = Array.from(byOcc.values())
        .filter((r) => (r.state === 'due' || r.state === 'snoozed') && Date.parse(r.plannedAt) <= ctx.nowMs);
    // Exactly one dose, never its slot mates: latest, due before snoozed,
    // then a stable order by occId.
    const [first] = all.slice().sort((a, b) => (Date.parse(b.plannedAt) - Date.parse(a.plannedAt))
        || (_TL_STATE_ORDER[a.state] - _TL_STATE_ORDER[b.state])
        || String(a.occId).localeCompare(String(b.occId), undefined, { numeric: true }));
    return { focus: first ? _tlGroups([first])[0] : null, more: Math.max(0, all.length - 1) };
}

function _tlFocusLabel(text, meta) {
    const label = _medsEl('div', 'wg-tl-focus__label');
    label.appendChild(_medsEl('span', 'wg-label', text));
    if (meta) label.appendChild(_medsEl('span', 'wg-meta', meta));
    return label;
}

// TL1 / TL4 · the focus card, the one accent card: exactly one pending dose
// (a day chip when it isn't today's) whose Take is the sun, "+N more pending"
// as a count only, then the next dose due today with a raised Take. TL3 ·
// nothing pending and nothing left today: no accent, no buttons, the next dose.
function _tlFocusCard({ focus, more, next, upcoming }, ctx) {
    const card = _medsEl('section', 'wg-card wg-tl-focus');
    card.setAttribute('aria-label', 'Now');
    if (!focus && !next) {
        card.classList.add('wg-tl-focus--done');
        const stack = _medsEl('div', 'wg-hstack');
        const lead = _medsEl('span', 'wg-row__lead wg-row__lead--ok');
        lead.appendChild(_medsIcon('check'));
        const text = _medsEl('span', 'wg-vstack wg-spacer');
        text.appendChild(_medsEl('span', 'wg-row__title', 'All done for today'));
        if (upcoming) {
            const day = upcoming.localDate === _tlShiftDate(ctx.todayDate, 1) ? 'tomorrow' : _tlDayName(upcoming.localDate);
            const n = upcoming.rows.length;
            text.appendChild(_medsEl('span', 'wg-meta', `Next: ${day} ${upcoming.localTime} · ${n} med${n === 1 ? '' : 's'}`));
        }
        stack.append(lead, text);
        card.appendChild(stack);
        return card;
    }
    card.classList.add('wg-card--accent');
    if (focus) {
        card.appendChild(_tlFocusLabel('Pending', more ? `+${more} more pending` : ''));
        const today = focus.localDate === ctx.todayDate;
        const row = _tlRow(focus, ctx, { chip: today });
        if (!today) row.querySelector('.wg-row__meta').appendChild(window.WGChip.create({ text: _tlDaysAgo(focus.localDate, ctx), state: 'pending', small: true }));
        row.querySelector('.wg-row__trail .wg-btn:not(.wg-btn--ghost)').classList.add('wg-btn--primary');
        card.appendChild(row);
    }
    if (next) {
        card.appendChild(_tlFocusLabel('Next today'));
        const row = _tlRow(next, ctx);
        const occIds = next.rows.map((r) => r.occId);
        const trail = _medsEl('span', 'wg-row__trail');
        trail.appendChild(_tlRowButton(occIds.length > 1 ? `Take ${occIds.length}` : 'Take', false, () => _tlAct('take', [{ occIds }])));
        row.appendChild(trail);
        card.appendChild(row);
    }
    return card;
}

function _tlBlock(section, label, groups, ctx, meta) {
    if (!groups.length) return;
    section.appendChild(_tlHead(label, { tag: 'label', meta }));
    section.appendChild(_tlList(groups, ctx));
}

// Today: the focus card first, then today's other doses — Pending, Later
// today, Done. The card's doses are not repeated here.
function _tlTodaySection(groups, ctx, card) {
    const section = _medsEl('section', 'wg-section wg-timeline__day wg-timeline__today');
    section.dataset.localDate = ctx.todayDate;
    section.appendChild(_tlHead(`Today · ${_tlDayName(ctx.todayDate)}`, {
        dot: true,
        meta: _tlClock(new Date(ctx.nowMs).toISOString(), ctx.tz),
    }));
    // The tracked zone is the clock every time here is on; say so whenever the
    // device sits in another zone (no history needed — Phase 1).
    if (ctx.deviceTz && ctx.tz && ctx.deviceTz !== ctx.tz) {
        const note = _medsEl('div', 'wg-note wg-note--info wg-timeline__zone');
        note.appendChild(_medsIcon('globe'));
        const body = _medsEl('div', 'wg-note__body');
        const text = _medsEl('span');
        text.appendChild(_medsEl('b', '', `Times are ${_tlZoneCity(ctx.tz)} time.`));
        body.appendChild(text);
        note.appendChild(body);
        section.appendChild(note);
    }
    section.appendChild(_tlFocusCard(card, ctx));
    const today = groups.filter((g) => g.localDate === ctx.todayDate);
    _tlBlock(section, 'Pending', today.filter(_tlIsPending), ctx);
    _tlBlock(section, 'Later today', today.filter((g) => g.state === 'upcoming'), ctx);
    _tlBlock(section, 'Done', today.filter(_tlIsDone).reverse(), ctx);
    return section;
}

// One History day, newest dose first. The header counts every dose of the day
// (so a day whose pending dose is up in the focus card says "1 pending"); the
// list leaves out the card's doses.
function _tlPastSection(date, groups, occ, ctx) {
    const pending = occ.filter((r) => r.state === 'due' || r.state === 'snoozed').length;
    const taken = occ.filter((r) => r.state === 'taken').length;
    const section = _medsEl('section', 'wg-section wg-timeline__day');
    section.dataset.localDate = date;
    const label = date === _tlShiftDate(ctx.todayDate, -1) ? `Yesterday · ${_tlDayName(date)}` : _tlDayName(date);
    const meta = !occ.length ? 'No doses' : pending ? `${pending} pending` : `${taken} of ${occ.length} taken`;
    section.appendChild(_tlHead(label, { meta }));
    // The bulk pair only for 2+ listed pending doses: one row has its own
    // Take / Skip, and the card's dose is not listed here (Iris 5020).
    const listed = groups.reduce((n, g) => n + (g.state === 'due' || g.state === 'snoozed' ? g.rows.length : 0), 0);
    if (listed >= 2) section.appendChild(_tlBulkActions(date));
    if (groups.length) {
        section.appendChild(_tlList(groups.slice().sort((a, b) => (b.at - a.at) || (_TL_STATE_ORDER[a.state] - _TL_STATE_ORDER[b.state])), ctx));
    }
    return section;
}

function renderTimeline({ anchor = false } = {}) {
    const list = document.getElementById('med-timeline-list');
    if (!list) return;
    const state = _medsTimelineState;
    list.replaceChildren();

    const meds = Array.isArray(medications) ? medications : [];
    const all = Array.isArray(state.rows) ? state.rows : [];
    if (meds.length === 0 && all.length === 0) {
        const card = _medsEl('div', 'wg-card wg-card--flush');
        card.appendChild(createEmptyState({
            icon: 'pill',
            title: 'No medications yet',
            body: 'Add what you take and when. Planned, due and taken doses all show up here.',
            actions: [{ label: 'Add medication', icon: 'plus', variant: 'primary', onClick: () => showAddModal() }],
        }));
        list.appendChild(card);
        syncMedsAddButton();
        return;
    }

    const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Every row is planned on the tracked zone; the newest (a forecast row)
    // names the current one.
    const tz = all.length ? all[all.length - 1].tz : deviceTz;
    const nowMs = Date.now();
    const ctx = { tz, deviceTz, nowMs, todayDate: _tlDatePart(nowMs, tz), medById: new Map(meds.map((m) => [String(m.id), m])) };
    state.ctx = ctx;
    // The shown days only: the read runs a page wider on each side.
    const first = _tlShiftDate(ctx.todayDate, -state.back);
    const last = _tlShiftDate(ctx.todayDate, state.ahead);
    const rows = all.filter((r) => r.localDate >= first && r.localDate <= last);
    const groups = _tlGroups(rows);
    const { focus, more } = _tlFocus(rows, state.pending, ctx);
    const next = groups.find((g) => g.localDate === ctx.todayDate && g.state === 'upcoming' && g.at > nowMs) || null;
    // The TL3 "Next:" line may lie past the shown days: any read row will do.
    const upcoming = _tlGroups(all.filter((r) => r.state === 'upcoming' && Date.parse(r.plannedAt) > nowMs))[0] || null;
    const inCard = new Set([focus, next].filter(Boolean).flatMap((g) => g.rows.map((r) => String(r.occId))));
    const listGroups = _tlGroups(rows.filter((r) => !inCard.has(String(r.occId))));

    if (state.outOfDate) list.appendChild(_tlOutOfDateNote(state.outOfDate, ctx));
    list.appendChild(_tlFutureSection(listGroups.filter((g) => g.localDate > ctx.todayDate), ctx));
    const todaySection = _tlTodaySection(listGroups, ctx, { focus, more, next, upcoming });
    list.appendChild(todaySection);
    let lastDay = null;
    for (let i = 1; i <= state.back; i++) {
        const date = _tlShiftDate(ctx.todayDate, -i);
        lastDay = _tlPastSection(date, listGroups.filter((g) => g.localDate === date), rows.filter((r) => r.localDate === date), ctx);
        list.appendChild(lastDay);
    }
    if (lastDay) lastDay.appendChild(_tlMoreButton('Show 3 earlier days', 'chev-d', () => _tlPage((s) => { s.back += MEDS_TIMELINE_PAGE_DAYS; })));

    // A visit opens at the page's top — or, under an MT6 note, on that med's
    // first pending row in Today, else its first row there (nothing selected).
    if (anchor) {
        const medId = state.outOfDate && state.outOfDate.medId;
        const medRows = medId ? Array.from(todaySection.querySelectorAll('.wg-timeline__row'))
            .filter((r) => r.dataset.medIds.split(' ').includes(medId)) : [];
        const medRow = medRows.find((r) => r.dataset.state === 'due' || r.dataset.state === 'snoozed') || medRows[0];
        const target = medRow || document.getElementById('meds-view') || list;
        if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: medRow ? 'center' : 'start' });
    }
    syncMedsAddButton();
}

// MT6: a reminder tap that no longer matches a dose. Quotes the reminder's
// own time and zone; picks nothing, logs nothing — the user taps the row.
function _tlOutOfDateNote(info, ctx) {
    const tz = info.tz || ctx.tz;
    const note = _medsEl('div', 'wg-note wg-note--warn wg-timeline__stale');
    note.appendChild(_medsIcon('bell'));
    const body = _medsEl('div', 'wg-note__body');
    const text = _medsEl('span');
    text.append(_medsEl('b', '', `Reminder for ${_tlClock(info.scheduled, tz)} ${_tlZoneCity(tz)} is out of date.`), ' Pick the dose you mean.');
    const dismiss = _medsEl('button', 'wg-btn wg-btn--ghost wg-btn--sm', 'Dismiss');
    dismiss.type = 'button';
    dismiss.addEventListener('click', () => {
        _medsTimelineState.outOfDate = null;
        note.remove();
    });
    body.append(text, dismiss);
    note.appendChild(body);
    return note;
}

// The landing an out-of-date reminder tap deep-links to (bd med-wi09.4):
// Meds → Timeline under the MT6 note, scrolled to the med. {medId, scheduled
// (the reminder's ISO instant), tz (the zone it was planned in)}.
function showMedsReminderOutOfDate({ medId, scheduled, tz } = {}) {
    _medsTimelineState.outOfDate = { medId: String(medId), scheduled, tz };
    switchTab('meds');
    switchMedTab('timeline');
}

// Timeline loader (switchMedTab / reloadCurrentTab / refreshMedsAfterMutation).
// Two projection reads, local shim calls in cloud mode: the display window
// (the shown days plus one page each side, so a "Show 3 …" tap renders at
// once) and every pending dose up to now (status=due,snoozed; the route bounds
// it) for the focus card. A visit ({anchor}) starts short again. Resolves the
// window rows (null when the route did not answer). Cached under
// MEDS_TIMELINE_KEY / MEDS_TIMELINE_PENDING_KEY: while a write's optimistic
// flip is pending fetchFresh yields null and the flipped rows are read back
// instead of the pre-write projection.
async function loadTimeline({ anchor = false } = {}) {
    const list = document.getElementById('med-timeline-list');
    if (!list) return null;
    const state = _medsTimelineState;
    if (anchor) {
        state.ahead = MEDS_TIMELINE_AHEAD_DAYS;
        state.back = MEDS_TIMELINE_BACK_DAYS;
        state.open = new Set();
    }
    const seq = ++state.seq;
    if (state.rows === null) {
        list.replaceChildren();
        const section = _medsEl('section', 'wg-section wg-timeline__day');
        section.appendChild(_tlHead('Today', { dot: true }));
        section.appendChild(_tlSkeletonList());
        list.appendChild(section);
    }
    // One read at a time: fetchFresh shares an in-flight read per key, so a
    // widened window asked for mid-read would get the narrower answer.
    const run = (state.chain || Promise.resolve()).then(() => _tlRead(list, seq, anchor));
    state.chain = run.catch(() => null);
    return run;
}

async function _tlRead(list, seq, anchor) {
    const state = _medsTimelineState;
    if (!Array.isArray(medications) || medications.length === 0) await loadMeds();
    const nowMs = Date.now();
    const iso = (days) => new Date(nowMs + days * 86400000).toISOString();
    const read = async (key, path) => {
        const fetchRows = () => Promise.resolve().then(() => apiCall(path)).catch(() => null);
        const fresh = await window.DataStore.fetchFresh(key, fetchRows, ['history']).catch(() => null);
        return Array.isArray(fresh) ? fresh : window.DataStore.getCached(key).catch(() => null);
    };
    const [rows, pending] = await Promise.all([
        // Ahead: at least 8 days, so TL3's "Next:" finds a weekly dose too.
        read(MEDS_TIMELINE_KEY, `/api/doses?from=${iso(-(state.back + MEDS_TIMELINE_PAGE_DAYS + 1))}&to=${iso(Math.max(state.ahead + MEDS_TIMELINE_PAGE_DAYS + 1, 8))}`),
        read(MEDS_TIMELINE_PENDING_KEY, `/api/doses?status=due,snoozed&to=${iso(0)}`),
    ]);
    // A newer read (a later tap or refresh) owns the screen; a page torn down
    // meanwhile has none.
    if (seq !== state.seq || !document || !list.isConnected) return Array.isArray(rows) ? rows : null;
    if (!Array.isArray(rows)) {
        if (state.rows === null) {
            list.replaceChildren(createOfflineEmptyState());
            syncMedsAddButton();
        }
        return null;
    }
    state.rows = rows;
    state.pending = Array.isArray(pending) ? pending : null;
    renderTimeline({ anchor });
    return rows;
}

function logMedicationPast(id, name) {
    showMedicationConfirmModal([id], [name], new Date(), 'log_past');
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
    // this call: the Schedule hour buckets read this state (bd med-gut.1), and
    // without it they silently regress to device-local time math that
    // disagrees with Home's next-intake card.
    await loadUpcomingDoses();

    if (initialAuthLoad) {
        initialAuthLoad = false;
        // `medications` already set by applyBootstrapPayload, hydrateMedicationsFromDexie,
        // or the cached-auth path; the corresponding cache write already ran with the
        // authoritative timestamp (Date.now() for bootstrap, preserved Dexie age for
        // hydration). Skip a redundant setCached/saveCache here — restamping would
        // overwrite the hydration-preserved timestamp.
        renderMeds();
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
        },
        onFresh: async (fresh) => {
            renderedSomething = true;
            medications = fresh;
            if (window.MedTrackerDB?.MedicationStore) {
                await window.MedTrackerDB.MedicationStore.saveCache(medications);
            }
            renderMeds();
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
        // unless that exact warning is on screen (a check that never resolved,
        // or a stale one for a since-renamed med, still alerts).
        if (res.warning && document.getElementById('med-rx-warning-text').textContent !== res.warning) {
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
    // Edit counts only a group ("Update 2", MT3 · group).
    if (mode === 'log_past' || (mode === 'edit' && document.querySelectorAll('#med-confirm-list .med-confirm-check').length < 2)) return;
    const n = document.querySelectorAll('#med-confirm-list .med-confirm-check[aria-pressed="true"]').length;
    actionBtn.append(' ', _medsEl('span', 'wg-btn__count', String(n)));
}

// Edit mode's "This dose was" segment (MT3): the time row shows only for Taken.
function _setMedConfirmTarget(target) {
    document.querySelectorAll('#med-confirm-state [data-dose-state]').forEach((opt) => {
        opt.setAttribute('aria-pressed', opt.dataset.doseState === target ? 'true' : 'false');
    });
    document.getElementById('med-confirm-time-edit').classList.toggle('hidden', target !== 'taken');
}

function _buildMedConfirmChoice(index, name, med, mode, state) {
    const btn = _medsEl('button', 'wg-choice wg-choice--check med-confirm-check');
    btn.type = 'button';
    btn.dataset.index = String(index);
    if (state) btn.dataset.state = state;
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

// Every confirm acts only on the sheet's own checked doses by explicit occId
// (bd med-wi09.2); an unchecked or absent slot-mate is never touched.
// states (edit mode): each dose's current projection state, index-aligned —
// the segment starts on the first one's (default taken).
function showMedicationConfirmModal(ids, names, scheduledAt, mode = 'confirm', intakeIds = [], states = []) {
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
        index, names[index] || ('Medication ' + id), medById.get(String(id)), mode, states[index])));
    // The RD3 hint belongs to one reminder-opened sheet (app.js handlePushAction).
    document.getElementById('med-confirm-hint')?.replaceChildren();
    _syncMedConfirmPrimary(mode);

    document.getElementById('med-confirm-state').classList.toggle('hidden', mode !== 'edit');
    document.querySelectorAll('#med-confirm-state [data-dose-state]').forEach((opt) => {
        opt.onclick = () => _setMedConfirmTarget(opt.dataset.doseState);
    });
    const first = states[0] === 'due' || states[0] === 'snoozed' ? 'pending' : states[0];
    _setMedConfirmTarget(mode === 'edit' ? (first || 'taken') : 'taken');
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
