// ==================== Medication render + modal flow ====================
// Extracted from app.js in Phase 5 Task 1. These functions remain global
// (script-tag loading) and still rely on helpers from features/medication-utils.js
// (parseMedicationSchedule, getNextScheduledDate, getMedicationScheduleText,
// getLastTakenTimeMs — reached via window.MedicationUtils.*) plus app.js
// helpers (isLowOnStock, formatDate, apiCall, withSubmit, safeAlert,
// safeConfirm, editingMedId, medications, initialAuthLoad, etc.).

// Sub-tab state: Timeline · My meds (bd med-5uwb.2; My meds keeps the
// `schedule` id). Scoped to sessionStorage so every fresh launch lands on the
// Timeline default; an in-session tab click survives reloads within the same
// tab. Retired panes map to what replaced them — History and Upcoming to the
// timeline, Stock (`inventory`) to My meds — so a stored or passed legacy
// value never lands on nothing. Legacy mt-meds-subtab localStorage values are
// cleared on boot.
const MEDS_SUBTAB_STORAGE_KEY = 'mt-meds-subtab';
const MEDS_SUBTAB_OPTIONS = ['timeline', 'schedule'];
const MEDS_SUBTAB_DEFAULT = 'timeline';
const MEDS_SUBTAB_LEGACY = { history: 'timeline', upcoming: 'timeline', inventory: 'schedule' };

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

// "in 2h 5m" / "overdue": the timeline's next-dose chip.
function _formatNextActionRelative(diffMs) {
    if (diffMs <= 0) return 'overdue';
    const totalMinutes = Math.round(diffMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `in ${hours}h ${minutes}m`;
    if (hours > 0) return `in ${hours}h`;
    return `in ${minutes}m`;
}

function _pad2(n) {
    return String(n).padStart(2, '0');
}

// The pending set (bd med-ry7b.4): every due or snoozed dose up to now, of
// any day since the ledger start (the route defaults from to 0 when status is
// set). One read, cached under MEDS_TIMELINE_PENDING_KEY: the timeline's focus
// card + "+N more pending", the Meds tab badge + app-bar sub
// (features/app-nav.js) and Today's Next up
// (features/today-loader.js, bd med-ry7b.7) all count it. While a write's
// optimistic flip is pending fetchFresh yields null and the flipped rows are
// read back instead of the pre-write projection.
async function readPendingDoses(nowMs = Date.now()) {
    const path = `/api/doses?status=due,snoozed&to=${new Date(nowMs).toISOString()}`;
    const fetchRows = () => Promise.resolve().then(() => apiCall(path)).catch(() => null);
    const fresh = await window.DataStore.fetchFresh(MEDS_TIMELINE_PENDING_KEY, fetchRows, ['history']).catch(() => null);
    return Array.isArray(fresh) ? fresh : readCachedPendingDoses();
}

// The cached pending set, no fetch: Today's first paint.
function readCachedPendingDoses() {
    return Promise.resolve().then(() => window.DataStore.getCached(MEDS_TIMELINE_PENDING_KEY)).catch(() => null);
}

// "08:00" / "08:00 · yesterday" / "08:00 · 3 days ago": a pending dose's slot
// (Today's Next up).
function pendingSlotLabel(at, now = new Date()) {
    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const time = `${_pad2(at.getHours())}:${_pad2(at.getMinutes())}`;
    const daysAgo = Math.round((day(now) - day(at)) / 86400000);
    return daysAgo <= 0 ? time : daysAgo === 1 ? `${time} · yesterday` : `${time} · ${daysAgo} days ago`;
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

// One list group: `.wg-section` with an eyebrow head (none for the Archived
// fold) and a `.wg-list` of rows; data-group names the My meds group.
function _buildMedsBucket(label, { rows, group }) {
    const section = _medsEl('section', 'wg-section wg-meds-bucket');
    if (group) section.dataset.group = group;
    if (label) {
        const head = _medsEl('div', 'wg-section__head');
        head.appendChild(_medsEl('span', 'wg-eyebrow wg-meds-bucket__label', label));
        section.appendChild(head);
    }
    const list = _medsEl('div', 'wg-list');
    rows.forEach((row) => list.appendChild(row));
    section.appendChild(list);
    return section;
}

function _medsButton(className, label, onClick) {
    const btn = _medsEl('button', `wg-btn wg-btn--sm ${className}`, label);
    btn.type = 'button';
    btn.addEventListener('click', onClick);
    return btn;
}

function _buildMedsLogButton(med) {
    return _medsButton('wg-meds-row__log-btn', 'Log', () => logMedicationPast(med.id, med.name));
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

// My meds row meta (kit MY1). When: daily "08:20, 21:30"; weekly one day
// "Sundays 08:20", several "Mon, Wed, Fri 08:20"; as-needed "When needed".
const MEDS_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MEDS_WEEKDAYS_LONG = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

function _myMedsWhen(med, schedule) {
    const type = schedule && schedule.type;
    if (type === 'as_needed') return 'When needed';
    if (type !== 'daily' && type !== 'weekly') return String(med.schedule || '');
    const times = (Array.isArray(schedule.times) ? schedule.times : []).join(', ');
    if (type === 'daily') return times;
    const days = Array.isArray(schedule.days) ? schedule.days : [];
    const names = days.length === 1 ? MEDS_WEEKDAYS_LONG[days[0]] : days.map((d) => MEDS_WEEKDAYS[d]).join(', ');
    return [names, times].filter(Boolean).join(' ');
}

const _medsTracked = (med) => med.inventory_count !== null && med.inventory_count !== undefined;

// "17 left · lasts 8 days" / "stock not tracked"; '' at Out (its chip says it).
function _myMedsStock(med, schedule) {
    if (!_medsTracked(med)) return 'stock not tracked';
    if ((schedule && schedule.type) === 'as_needed') return med.inventory_count > 0 ? `${med.inventory_count} left` : '';
    return _stockMeta(med);
}

// "N left", or Out's own label ("Out", "Out · 3 over") with no chip.
function _myMedsLeft(med) {
    return med.inventory_count > 0 ? `${med.inventory_count} left` : formatStock(med.inventory_count, med).label;
}

// "today" / "yesterday" / "N days ago", by calendar day.
function _myMedsAgo(iso, now) {
    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const n = Math.round((day(now) - day(new Date(iso))) / 86400000);
    return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
}

// Not in use: "Ended 2 Oct" for a course that ended, else "Last N days ago",
// else "Never taken"; "· N left" when tracked.
function _myMedsIdleMeta(med, now) {
    const end = String(med.end_date || '').split('T')[0];
    const ended = end && end < `${now.getFullYear()}-${_pad2(now.getMonth() + 1)}-${_pad2(now.getDate())}`;
    const head = ended ? `Ended ${_formatMedDay(med.end_date)}`
        : med.last_taken_at ? `Last ${_myMedsAgo(med.last_taken_at, now)}` : 'Never taken';
    return _medsTracked(med) ? `${head} · ${_myMedsLeft(med)}` : head;
}

// A My meds row (kit .wg-row): title "Name · dose", meta = opts.meta (default:
// when the med is taken), opts.chip, then the tags — course dates, Rx, EU,
// Supplement, Archived, sync. opts.trail: the row's own buttons. Tap edits;
// swipe / the ⋯ More button carry Edit / Delete (+ "Log a dose" on live rows
// without their own Log button). opts.more false drops the More button.
function _buildMedsRow(med, parsedSchedule, opts = {}) {
    const row = _medsEl('div', 'wg-row wg-meds-row med-item');
    row.dataset.medId = String(med.id);
    if (med.archived) row.classList.add('archived', 'wg-row--muted');

    const lead = _medsEl('span', 'wg-row__lead');
    lead.appendChild(_medsIcon('pill'));
    row.appendChild(lead);

    const body = _medsEl('span', 'wg-row__body wg-meds-row__info');
    const title = _medsEl('span', 'wg-row__title wg-meds-row__title');
    title.appendChild(_medsEl('span', 'wg-meds-row__name', med.name));
    if (med.dosage) title.appendChild(document.createTextNode(` · ${med.dosage}`));
    body.appendChild(title);

    const meta = _medsEl('span', 'wg-row__meta wg-meds-row__meta');
    const text = opts.meta !== undefined ? opts.meta : _myMedsWhen(med, parsedSchedule);
    if (text) meta.appendChild(_medsEl('span', 'wg-meds-row__schedule', text));
    if (opts.chip) meta.appendChild(opts.chip);
    const dates = opts.dates !== false && _formatMedDateRange(med.start_date, med.end_date);
    if (dates) meta.appendChild(_medsEl('span', 'wg-meds-row__dates', dates));
    if (med.normalized_name) {
        meta.appendChild(_medsEl('span', 'wg-meds-row__rx', `Rx ${med.normalized_name}`));
    }
    // The saved EU register match (kit ER13, bd med-3u28.10), from the record:
    // no register load, works offline; only while it was saved for this name.
    if (med.ema && med.ema.for_name === med.name) {
        meta.appendChild(_medsEl('span', 'wg-meds-row__eu',
            `EU ${String(med.ema.substances).split('|').map((s) => s.trim()).filter(Boolean).join(' + ')}`));
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
    (opts.trail || []).forEach((btn) => trail.appendChild(btn));
    const ownLog = !!trail.querySelector('.wg-meds-row__log-btn');
    row.appendChild(trail);

    return window.WGRowActions.attach(row, {
        label: med.name,
        trail,
        tapEdits: true,
        more: opts.more,
        onEdit: () => showEditModal(med.id),
        onDelete: () => deleteMed(med.id),
        // Every live med can be logged: from its own Log button, else the
        // overflow (an as-needed med in Needs a refill included).
        extra: ownLog || med.archived
            ? []
            : [{ label: 'Log a dose', icon: 'plus', onClick: () => logMedicationPast(med.id, med.name) }],
    });
}

// My meds' When needed group, in its order: what Today's Log → Med (kit LS2)
// lists, and whether that kind shows at all.
function asNeededMeds() {
    return window.MedicationUtils.groupMyMeds(medications, {
        stockState: (m) => formatStock(m.inventory_count, m).state,
    }).asNeeded;
}

// My meds (kit MY1, MY1 · end; bd med-5uwb.1): one row per med in exactly one
// group (MedicationUtils.groupMyMeds) — Needs a refill, Scheduled, When
// needed, Not in use, the Archived fold — then a neutral Add medication.
// Taking scheduled doses lives on the Timeline.
function renderMeds() {
    // A page torn down while loadMeds awaited its reads has nothing to paint.
    const list = document && document.getElementById('med-list');
    if (!list) return;
    list.replaceChildren();
    const now = new Date();

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

    const g = window.MedicationUtils.groupMyMeds(medications, {
        now,
        stockState: (m) => formatStock(m.inventory_count, m).state,
    });
    const parse = (m) => window.MedicationUtils.parseMedicationSchedule(m.schedule);
    const whenStock = (m, s) => [_myMedsWhen(m, s), _myMedsStock(m, s)].filter(Boolean).join(' · ');
    const add = (label, group, meds, opts) => {
        const rows = meds.map((m) => { const s = parse(m); return _buildMedsRow(m, s, opts(m, s)); });
        if (rows.length) list.appendChild(_buildMedsBucket(label, { group, rows }));
    };

    add('Needs a refill', 'refill', g.refill, (m, s) => ({
        meta: whenStock(m, s),
        chip: _stockChip(m),
        trail: [_medsButton('wg-meds-stock__update', 'Update', () => openStockSheet(m))],
    }));
    add('Scheduled', 'scheduled', g.scheduled, (m, s) => ({ meta: whenStock(m, s) }));
    add('When needed', 'as-needed', g.asNeeded, (m) => ({
        meta: [m.last_taken_at && `Last ${_myMedsAgo(m.last_taken_at, now)}`, _medsTracked(m) && _myMedsLeft(m)].filter(Boolean).join(' · '),
        trail: [_buildMedsLogButton(m)],
    }));
    // Not in use (Iris, MY1 review): no ⋯ More — the row tap opens the editor
    // (Archived switch, Delete) — and no course tag: the meta says "Ended …".
    // One button per row (Iris): an idle as-needed med logs (no Timeline slot;
    // Track stock lives in the editor); an ended course offers Stop tracking.
    add('Not in use', 'not-in-use', g.notInUse, (m, s) => ({
        meta: _myMedsIdleMeta(m, now),
        dates: false,
        more: false,
        trail: (s && s.type) === 'as_needed' ? [_buildMedsLogButton(m)]
            : _medsTracked(m) ? [_medsButton('wg-btn--ghost wg-meds-row__stop', 'Stop tracking', () => stopTrackingMed(m.id))]
                : [],
    }));
    // Archived rows show no dose times (they read as live reminders): just
    // "Last <date>" when known, beside the Archived chip.
    if (g.archived.length) {
        list.appendChild(_buildArchivedFold(g.archived.map((m) => _buildMedsRow(m, parse(m), {
            meta: m.last_taken_at
                ? `Last ${new Date(m.last_taken_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '',
        }))));
    }

    const addBtn = _medsEl('button', 'wg-btn wg-btn--block wg-meds-add');
    addBtn.type = 'button';
    addBtn.append(_medsIcon('plus', 'wg-ico--sm'), 'Add medication');
    addBtn.addEventListener('click', () => showAddModal());
    list.appendChild(addBtn);
    syncMedsAddButton();
}

// Archived (kit MY1 · end): one folded row, "N meds", collapsed on every
// render; a tap unfolds the archived rows underneath.
function _buildArchivedFold(rows) {
    const section = _buildMedsBucket('', { group: 'archived', rows: [] });
    const fold = _medsEl('div', 'wg-row wg-meds-fold');
    fold.setAttribute('role', 'button');
    fold.tabIndex = 0;
    const lead = _medsEl('span', 'wg-row__lead');
    lead.appendChild(_medsIcon('archive'));
    const body = _medsEl('span', 'wg-row__body');
    body.append(_medsEl('span', 'wg-row__title', 'Archived'),
        _medsEl('span', 'wg-row__meta', rows.length === 1 ? '1 med' : `${rows.length} meds`));
    let chev = _medsEl('i');
    fold.append(lead, body, chev);
    section.querySelector('.wg-list').appendChild(fold);
    const list = _medsEl('div', 'wg-list wg-meds-archived');
    rows.forEach((row) => list.appendChild(row));
    section.appendChild(list);
    const set = (open) => {
        fold.setAttribute('aria-expanded', String(open));
        list.hidden = !open;
        const next = _medsIcon(open ? 'chev-d' : 'chev-r', 'wg-row__chev');
        chev.replaceWith(next);
        chev = next;
    };
    set(false);
    const toggle = () => set(list.hidden);
    fold.addEventListener('click', toggle);
    fold.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        toggle();
    });
    return section;
}

// M4: while the visible Meds pane shows an empty state with its own Add, the
// app-bar Add hides so that Add is the one primary on screen. Called after
// every pane render and on sub-tab switch (app.js switchMedTab).
function syncMedsAddButton() {
    const btn = document.getElementById('add-btn');
    if (!btn) return;
    const pane = document.querySelector('#meds-view .med-tab-content.active');
    btn.hidden = !!(pane && pane.querySelector('.wg-empty .wg-btn--primary'));
    if (window.AppNav) window.AppNav.syncMedsSub();
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
let _medsTimelineState = { rows: null, pending: null, ahead: MEDS_TIMELINE_AHEAD_DAYS, back: MEDS_TIMELINE_BACK_DAYS, open: new Set(), seq: 0, chain: null, ctx: null, outOfDate: null, intakeFloor: undefined }; // module-state: the timeline's rows, window and read queue

// The paging floor: the first day History can show anything real on. The
// earliest of every medication's start_date ?? created_at (archived included)
// and the earliest stored intake (state.intakeFloor: undefined until read, so
// nothing is hidden yet; pending rows count too). start_date is a picked
// calendar date stored as UTC midnight, so its date is the UTC one;
// created_at is an instant, read on the tracked zone. Undated medications are
// skipped (the intake floor covers their stored rows); null when nothing dates
// the ledger.
function _tlFloor(meds, pending, tz, intakeFloor) {
    const dates = [];
    for (const m of meds) {
        if (!m) continue;
        const start = Date.parse(m.start_date || '');
        if (Number.isFinite(start)) { dates.push(new Date(start).toISOString().slice(0, 10)); continue; }
        const made = Date.parse(m.created_at || '');
        if (Number.isFinite(made)) dates.push(_tlDatePart(made, tz));
    }
    if (!dates.length) return null;
    (Array.isArray(pending) ? pending : []).forEach((r) => dates.push(r.localDate));
    if (intakeFloor) dates.push(intakeFloor);
    return dates.reduce((a, b) => (b < a ? b : a));
}

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

// Groups latest first, the page's one order (future on top, and inside a day
// the later dose above the earlier, bd med-5y49); same instant → pending
// before done. Min-based reads (the next dose, "first 08:20") take the last.
function _tlGroups(rows) {
    const byKey = new Map();
    rows.forEach((r) => {
        const key = `${r.localDate}|${r.localTime}|${r.tz}|${r.state}`;
        if (!byKey.has(key)) {
            byKey.set(key, { localDate: r.localDate, localTime: r.localTime, tz: r.tz, state: r.state, at: Date.parse(r.plannedAt), rows: [] });
        }
        byKey.get(key).rows.push(r);
    });
    return Array.from(byKey.values()).sort((a, b) => (b.at - a.at) || (_TL_STATE_ORDER[a.state] - _TL_STATE_ORDER[b.state]));
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

// "Next today" outside this window before its slot opens the take sheet
// instead of taking in one tap (bd med-wt2q: a 01:40 tap took the 08:20 doses).
const MEDS_NEXT_TAKE_WINDOW_MS = 60 * 60 * 1000;

// "Next today" ahead of the window: the take sheet on the group's occIds with
// "Due at 08:20. Mark taken now?" above the actions. Its Take works as ever;
// a dose not due yet has nothing to snooze or skip.
function _tlOpenEarlySheet(group, ctx) {
    const rows = group.rows;
    const names = rows.map((r) => {
        const med = ctx.medById.get(String(r.medId));
        return (med && med.name) || r.name || 'Medication';
    });
    showMedicationConfirmModal(rows.map((r) => r.medId), names, rows[0].plannedAt, 'confirm', rows.map((r) => r.occId));
    document.getElementById('med-confirm-snooze-btn').classList.add('hidden');
    document.getElementById('med-confirm-skip-btn').classList.add('hidden');
    const note = _medsEl('p', 'wg-hint', `Due at ${group.localTime}. Mark taken now?`);
    note.dataset.earlyTake = '';
    document.getElementById('med-confirm-hint').replaceChildren(note);
}

// One group = one kit row. Upcoming rows are read-only (Schedule's Take N
// takes them early); every other row is a button that opens the sheet.
// readOnly (an unfolded planned day): no sheet, no buttons, whatever the state.
// open: what a tap does instead (the early "Next today" row).
function _tlRow(group, ctx, { chip = true, readOnly = false, open = null } = {}) {
    const row = _medsEl('div', 'wg-row wg-timeline__row');
    row.dataset.state = group.state;
    row.dataset.localDate = group.localDate;
    row.dataset.occIds = group.rows.map((r) => String(r.occId)).join(' ');
    row.dataset.medIds = group.rows.map((r) => String(r.medId)).join(' ');
    const opener = open || (group.state !== 'upcoming' && !readOnly ? () => _tlOpenSheet(group, ctx) : null);
    if (opener) {
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.addEventListener('click', opener);
        row.addEventListener('keydown', (e) => {
            if (e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            opener();
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
        trail.appendChild(_tlRowButton(occIds.length > 1 ? `Take ${occIds.length}` : 'Take', false, () => _tlAct('take', [{ occIds }])));
        row.appendChild(trail);
    }
    return row;
}

// rows.map that merges patches[occId] into the matching rows. .restore(ids)
// is the inverse for just those ids: each row as this patch first saw it, so
// a partly refused write returns only the refused doses (bd med-2l38).
function _tlPatchRows(patches) {
    const before = new Map();
    const mutate = (rows) => rows.map((r) => {
        const id = r && String(r.occId);
        if (!r || !patches.has(id)) return r;
        if (!before.has(id)) before.set(id, r);
        return { ...r, ...patches.get(id) };
    });
    mutate.restore = (ids) => (rows) => rows.map((r) => {
        const id = r && String(r.occId);
        return id && ids.has(id) && before.has(id) ? before.get(id) : r;
    });
    mutate.ids = new Set(patches.keys());
    return mutate;
}

// The timeline's rows (window ∪ pending) for these occIds, as
// {occId, medId, plannedAt, name}; unknown ids are left out.
function _tlDoses(occIds) {
    const state = _medsTimelineState;
    const byOcc = new Map([...(state.pending || []), ...(state.rows || [])].filter(Boolean).map((r) => [String(r.occId), r]));
    return occIds.map((id) => byOcc.get(String(id))).filter(Boolean)
        .map((r) => ({ occId: String(r.occId), medId: r.medId, plannedAt: r.plannedAt, name: r.name }));
}

// A dose's medication name off the timeline's rows, or null.
function _tlDoseName(occId) {
    const [dose] = _tlDoses([occId]);
    if (!dose) return null;
    const med = Array.isArray(medications) ? medications.find((m) => String(m.id) === String(dose.medId)) : null;
    return (med && med.name) || dose.name || null;
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
    // The pending set first: the first key's datastore:changed already
    // repaints the Meds badge and Today, which read only that key — flipped
    // first, they read it from cache instead of re-fetching the pre-write set.
    const handles = [await window.DataStore.applyOptimistic(MEDS_TIMELINE_PENDING_KEY, apply, ['history'])];
    try {
        handles.push(await window.DataStore.applyOptimistic(MEDS_TIMELINE_KEY, apply, ['history']));
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
// rows in place (a take or skip also clears the dose from Today's
// next-intake card), POST /api/doses/act once per batch ({occIds, takenAt?} —
// one taken_at each), then settle: the doses that landed stay, only refused
// ones go back, named in a toast (bd med-2l38). Resolves true when every id
// applied. doses ({occId, medId, plannedAt}): the caller's own rows for the
// next-intake clear, for a caller (Today) whose doses the timeline may not
// have read yet.
async function _tlAct(action, batches, doses = null) {
    const nowIso = new Date().toISOString();
    const patch = (takenAt) => ({
        take: { state: 'taken', takenAt: takenAt || nowIso },
        skip: { state: 'skipped', takenAt: null },
        undo: { state: 'due', takenAt: null },
    }[action]);
    const patches = new Map();
    batches.forEach((b) => b.occIds.forEach((id) => patches.set(String(id), patch(b.takenAt))));
    if (!patches.size) return false;

    const mutate = _tlPatchRows(patches);
    const handles = [await _applyOptimisticTimeline(mutate)];
    const next = action === 'undo' ? null : await _optimisticNextIntake(doses || _tlDoses([...patches.keys()]));
    const failed = new Set();
    for (const b of batches) {
        let refused;
        try {
            refused = await _actOnDoses(action, b.occIds, b.takenAt);
        } catch (_) {
            refused = b.occIds;
        }
        refused.forEach((id) => failed.add(String(id)));
    }
    await _settleDoseWrite(handles, mutate, failed, next);
    if (failed.size < patches.size && window.DataStore) await window.DataStore.invalidateTags(['gamification']).catch(() => {});
    refreshMedsAfterMutation();
    return failed.size === 0;
}

// MT4 · pile-up: one bulk pair per earlier day that still has pending doses.
// Acts only on that day's pending occIds at the moment of the tap (so a
// repeat tap finds nothing left to do); "Mark all taken" writes each dose's
// planned time. No dialog — the toast's Undo restores exactly those doses.
// The bulk write's batches over rows ({occId, plannedAt}): a take is one
// batch per planned instant stamped with it, a skip one batch. Today's
// missed fold builds its Mark all taken / Skip all from it too.
function _tlBulkBatches(action, rows) {
    if (action !== 'take') return [{ occIds: rows.map((r) => r.occId) }];
    const byPlanned = new Map();
    rows.forEach((r) => {
        if (!byPlanned.has(r.plannedAt)) byPlanned.set(r.plannedAt, []);
        byPlanned.get(r.plannedAt).push(r.occId);
    });
    return [...byPlanned].map(([takenAt, occIds]) => ({ occIds, takenAt }));
}

async function _tlBulk(action, date) {
    const pending = (_medsTimelineState.rows || []).filter((r) => r.localDate === date && (r.state === 'due' || r.state === 'snoozed'));
    if (!pending.length) return false;
    if (!await _tlAct(action, _tlBulkBatches(action, pending))) return false;
    const n = pending.length;
    const occIds = pending.map((r) => r.occId);
    safeToast(`${n} dose${n === 1 ? '' : 's'} ${action === 'take' ? 'marked taken' : 'skipped'}`, 'success', {
        detail: _tlDayName(date),
        action: { label: 'Undo', onClick: () => _tlAct('undo', [{ occIds }]) },
        duration: 8000,
    });
    return true;
}

// The bulk pair; act(action) runs on a tap ('take' | 'skip').
function _tlBulkActions(act) {
    const bar = _medsEl('div', 'wg-hstack wg-timeline__bulk');
    const take = _medsEl('button', 'wg-btn wg-btn--sm wg-spacer');
    take.type = 'button';
    take.append(_medsIcon('check', 'wg-ico--sm'), 'Mark all taken');
    take.addEventListener('click', () => act('take'));
    const skip = _medsEl('button', 'wg-btn wg-btn--ghost wg-btn--sm wg-spacer', 'Skip all');
    skip.type = 'button';
    skip.addEventListener('click', () => act('skip'));
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
        if (day.length) _tlFoldedDay(list, date, i === 1 ? `Tomorrow · ${_tlDayName(date)}` : _tlDayName(date), day, ctx);
    }
    if (list.children.length) section.appendChild(list);
    return section;
}

// One folded, dashed "Planned" row ("2 doses · first 08:20"; `day` runs
// latest first) whose tap unfolds those doses underneath, read-only. Keyed by
// date in the visit's fold state: a future day, or Today's "Later today".
function _tlFoldedDay(list, date, title, day, ctx) {
    const state = _medsTimelineState;
    const open = state.open.has(date);
    const row = _medsEl('div', 'wg-row wg-tl-day');
    row.dataset.localDate = date;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('aria-expanded', String(open));
    const lead = _medsEl('span', 'wg-row__lead');
    lead.appendChild(_medsIcon('calendar'));
    const body = _medsEl('span', 'wg-row__body');
    body.appendChild(_medsEl('span', 'wg-row__title', title));
    // "first" only when there is a second (Iris 17218): "1 dose · 21:00".
    const firstAt = day[day.length - 1].localTime;
    body.appendChild(_medsEl('span', 'wg-row__meta', day.length === 1 ? `1 dose · ${firstAt}` : `${day.length} doses · first ${firstAt}`));
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

// The focus card's pending slot: the slot of the latest pending dose — the
// pending-only read, overlaid by the window's rows (fresher where they meet:
// a dose taken from the sheet drops out at once) — ties due before snoozed.
// { focus: group | null, more: how many pending doses outside that slot }.
function _tlFocus(rows, pending, ctx) {
    const byOcc = new Map();
    (Array.isArray(pending) ? pending : []).forEach((r) => byOcc.set(String(r.occId), r));
    rows.forEach((r) => {
        const id = String(r.occId);
        if (byOcc.has(id) || r.state === 'due' || r.state === 'snoozed') byOcc.set(id, r);
    });
    const all = Array.from(byOcc.values())
        .filter((r) => (r.state === 'due' || r.state === 'snoozed') && Date.parse(r.plannedAt) <= ctx.nowMs);
    // The latest dose (due before snoozed, then a stable order by occId) picks
    // the slot; the card holds every pending dose of it (bd med-ry7b.8).
    const [first] = all.slice().sort((a, b) => (Date.parse(b.plannedAt) - Date.parse(a.plannedAt))
        || (_TL_STATE_ORDER[a.state] - _TL_STATE_ORDER[b.state])
        || String(a.occId).localeCompare(String(b.occId), undefined, { numeric: true }));
    if (!first) return { focus: null, more: 0 };
    const focus = _tlGroups(all).find((g) => g.rows.includes(first));
    return { focus, more: all.length - focus.rows.length };
}

function _tlFocusLabel(text, meta) {
    const label = _medsEl('div', 'wg-tl-focus__label');
    label.appendChild(_medsEl('span', 'wg-label', text));
    if (meta) label.appendChild(_medsEl('span', 'wg-meta', meta));
    return label;
}

// TL1 / TL4 · the focus card, the one accent card, later on top (Iris 17054):
// the next dose due today with a raised Take (only within
// MEDS_NEXT_TAKE_WINDOW_MS of its slot; earlier a tap opens the sheet), then
// the whole latest pending slot (a day chip when it isn't today's) whose
// Take (Take N) is the sun, "+N more pending" as a count only. TL3 ·
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
    if (next) {
        card.appendChild(_tlFocusLabel('Next today'));
        const ahead = next.at - ctx.nowMs;
        if (ahead > MEDS_NEXT_TAKE_WINDOW_MS) {
            // Too early for one tap: no button, "in 6 h", a tap opens the sheet.
            const row = _tlRow(next, ctx, { chip: false, open: () => _tlOpenEarlySheet(next, ctx) });
            const mins = Math.round(ahead / 60000);
            row.querySelector('.wg-row__meta').appendChild(window.WGChip.create({
                text: mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)} h`, state: 'pending', small: true,
            }));
            card.appendChild(row);
        } else {
            const row = _tlRow(next, ctx);
            const occIds = next.rows.map((r) => r.occId);
            const trail = _medsEl('span', 'wg-row__trail');
            trail.appendChild(_tlRowButton(occIds.length > 1 ? `Take ${occIds.length}` : 'Take', false, () => _tlAct('take', [{ occIds }])));
            row.appendChild(trail);
            card.appendChild(row);
        }
    }
    if (focus) {
        card.appendChild(_tlFocusLabel('Pending', more ? `+${more} more pending` : ''));
        const today = focus.localDate === ctx.todayDate;
        const row = _tlRow(focus, ctx, { chip: today });
        if (!today) row.querySelector('.wg-row__meta').appendChild(window.WGChip.create({ text: _tlDaysAgo(focus.localDate, ctx), state: 'pending', small: true }));
        row.querySelector('.wg-row__trail .wg-btn:not(.wg-btn--ghost)').classList.add('wg-btn--primary');
        card.appendChild(row);
    }
    return card;
}

function _tlBlock(section, label, groups, ctx, meta) {
    if (!groups.length) return;
    section.appendChild(_tlHead(label, { tag: 'label', meta }));
    section.appendChild(_tlList(groups, ctx));
}

// Today: a folded "Later today" row, the focus card, then today's other
// doses — Pending, Done. The card's doses are not repeated here.
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
    const today = groups.filter((g) => g.localDate === ctx.todayDate);
    // Later today sits above the card (later on top), folded like a future
    // day so it costs one row and never pushes the overdue Take down (Iris 17139).
    const later = today.filter((g) => g.state === 'upcoming');
    if (later.length) {
        const planned = _medsEl('div', 'wg-tl-planned wg-timeline__later');
        const list = _medsEl('div', 'wg-list');
        _tlFoldedDay(list, ctx.todayDate, 'Later today', later, ctx);
        planned.appendChild(list);
        section.appendChild(planned);
    }
    section.appendChild(_tlFocusCard(card, ctx));
    _tlBlock(section, 'Pending', today.filter(_tlIsPending), ctx);
    _tlBlock(section, 'Done', today.filter(_tlIsDone), ctx);
    return section;
}

// One History day, newest dose first. The header counts every dose of the day
// (so a day whose only pending slot is up in the focus card says "N pending");
// the list leaves out the card's doses.
function _tlPastSection(date, groups, occ, ctx) {
    const pending = occ.filter((r) => r.state === 'due' || r.state === 'snoozed').length;
    const taken = occ.filter((r) => r.state === 'taken').length;
    const section = _medsEl('section', 'wg-section wg-timeline__day');
    section.dataset.localDate = date;
    const label = date === _tlShiftDate(ctx.todayDate, -1) ? `Yesterday · ${_tlDayName(date)}` : _tlDayName(date);
    const meta = !occ.length ? 'No doses' : pending ? `${pending} pending` : `${taken} of ${occ.length} taken`;
    section.appendChild(_tlHead(label, { meta }));
    // The bulk pair only for 2+ listed pending doses: one row has its own
    // Take / Skip, and the card's slot is not listed here (Iris 5020).
    const listed = groups.reduce((n, g) => n + (g.state === 'due' || g.state === 'snoozed' ? g.rows.length : 0), 0);
    if (listed >= 2) section.appendChild(_tlBulkActions((action) => _tlBulk(action, date)));
    if (groups.length) section.appendChild(_tlList(groups, ctx));
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
    // Groups run latest first: the earliest is the last.
    const next = groups.filter((g) => g.localDate === ctx.todayDate && g.state === 'upcoming' && g.at > nowMs).pop() || null;
    // The TL3 "Next:" line may lie past the shown days: any read row will do.
    const upcoming = _tlGroups(all.filter((r) => r.state === 'upcoming' && Date.parse(r.plannedAt) > nowMs)).pop() || null;
    const inCard = new Set([focus, next].filter(Boolean).flatMap((g) => g.rows.map((r) => String(r.occId))));
    const listGroups = _tlGroups(rows.filter((r) => !inCard.has(String(r.occId))));

    if (state.outOfDate) list.appendChild(_tlOutOfDateNote(state.outOfDate, ctx));
    list.appendChild(_tlFutureSection(listGroups.filter((g) => g.localDate > ctx.todayDate), ctx));
    // MT6 lands on the med's rows in Today: unfold Later today when it holds one.
    const mt6Med = anchor && state.outOfDate && state.outOfDate.medId;
    if (mt6Med && listGroups.some((g) => g.localDate === ctx.todayDate && g.state === 'upcoming' && g.rows.some((r) => String(r.medId) === mt6Med))) {
        state.open.add(ctx.todayDate);
    }
    const todaySection = _tlTodaySection(listGroups, ctx, { focus, more, next, upcoming });
    list.appendChild(todaySection);
    let lastDay = null;
    for (let i = 1; i <= state.back; i++) {
        const date = _tlShiftDate(ctx.todayDate, -i);
        lastDay = _tlPastSection(date, listGroups.filter((g) => g.localDate === date), rows.filter((r) => r.localDate === date), ctx);
        list.appendChild(lastDay);
    }
    // Until the intake floor is read (undefined) nothing is hidden.
    const floor = state.intakeFloor === undefined ? null : _tlFloor(meds, state.pending, tz, state.intakeFloor);
    if (lastDay && !(floor &&_tlShiftDate(ctx.todayDate, -(state.back + 1)) < floor)) lastDay.appendChild(_tlMoreButton('Show 3 earlier days', 'chev-d', () => _tlPage((s) => { s.back += MEDS_TIMELINE_PAGE_DAYS; })));

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

// The same landing for a Telegram tap drained in the background (bd
// med-wi09.4): never switch the app away from what the user is doing. The
// MT6 note waits for the next Meds → Timeline open, and a toast offers it now.
function queueMedsReminderOutOfDate(info = {}) {
    _medsTimelineState.outOfDate = { medId: String(info.medId), scheduled: info.scheduled, tz: info.tz };
    // Scoped to the unmatched doses: the same tap may have logged its others.
    const count = Number(info.count) || 1;
    const med = Array.isArray(medications) ? medications.find((m) => String(m.id) === String(info.medId)) : null;
    const text = count > 1
        ? `Telegram reminder out of date for ${count} medications: log them in the app.`
        : med && med.name
            ? `Telegram reminder out of date for ${med.name}: log it in the app.`
            : 'A Telegram reminder was out of date — log that dose in the app.';
    safeToast(text, 'info', {
        action: { label: 'Open', onClick: () => showMedsReminderOutOfDate(info) },
        duration: 8000,
    });
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

// The earliest stored intake day before the medications' own floor, so an
// archived or backdated med keeps its history reachable. Read once per visit
// (anchor) or until first answered, never per page tap or write refresh. Cost:
// one /api/doses projection over [ledger start, the meds' floor day], i.e. the
// days before the earliest medication, normally none; a cheaper raw-record
// min(scheduled_at) would need a new domain port, deliberately not added here.
// A failed read keeps the previous value. Resolves true when the floor changed.
// ponytail: a log-past row older than the floor shows up from the next visit.
async function _tlReadIntakeFloor(rows, anchor) {
    const state = _medsTimelineState;
    if (!anchor && state.intakeFloor !== undefined) return false;
    const meds = Array.isArray(medications) ? medications : [];
    const tz = rows.length ? rows[rows.length - 1].tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const medFloor = _tlFloor(meds, null, tz, null);
    if (!medFloor) return false;
    const to = new Date(_tlDayMs(medFloor) + 86400000).toISOString();
    const old = await Promise.resolve().then(() => apiCall(`/api/doses?status=taken,skipped&from=${new Date(0).toISOString()}&to=${to}`)).catch(() => null);
    if (!Array.isArray(old)) return false;
    const next = old.length ? old.reduce((a, r) => (r.localDate < a ? r.localDate : a), old[0].localDate) : null;
    const changed = next !== state.intakeFloor;
    state.intakeFloor = next;
    return changed;
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
        readPendingDoses(nowMs),
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
    // Paint first; the floor re-renders only when it changed (no scroll anchor).
    if (await _tlReadIntakeFloor(rows, anchor) && seq === state.seq && list.isConnected) renderTimeline();
    return rows;
}

function logMedicationPast(id, name) {
    showMedicationConfirmModal([id], [name], new Date(), 'log_past');
}


// Stock helpers and the Update stock sheet (ST1–ST3, bd med-wi09.13), opened
// from My meds' Needs a refill rows and the editor (the Stock sub-tab merged
// into My meds, bd med-5uwb.2). The count is the domain's derived stock
// (inventory_count on the wire: the last count + refills since − doses taken
// since); `med.stock` carries that ledger for the sheet's history.

const MEDS_REFILL_PRESETS = [30, 60, 90];

// "2 a day" for whole daily counts, else per week ("3 a week").
function _formatDailyUsage(daily) {
    if (daily >= 1 && Number.isInteger(daily)) return `${daily} a day`;
    return `${Math.max(1, Math.round(daily * 7))} a week`;
}

function _stockDay(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Row meta: "17 left · lasts 8 days"; an as-needed med says so instead.
function _stockMeta(med) {
    const count = med.inventory_count;
    const daily = calculateDailyUsage(med);
    const parts = [];
    if (count > 0) parts.push(`${count} left`);
    if (!daily) parts.push('As needed');
    else if (count > 0) {
        const days = Math.floor(count / daily);
        parts.push(`lasts ${days} day${days === 1 ? '' : 's'}`);
    }
    return parts.join(' · ');
}

// Sheet summary after "App has N": " · 2 a day · lasts 8 days".
function _stockUsage(med) {
    const daily = calculateDailyUsage(med);
    if (!daily) return ' · as needed';
    const days = Math.max(0, Math.floor(med.inventory_count / daily));
    return ` · ${_formatDailyUsage(daily)} · lasts ${days} day${days === 1 ? '' : 's'}`;
}

// Out (with "N over" when negative) or Low; none when fine.
function _stockChip(med) {
    const stock = formatStock(med.inventory_count, med);
    if (stock.state === 'ok') return null;
    const chip = window.WGChip.create({
        text: stock.state === 'danger' ? stock.label : 'Low',
        state: stock.state,
        small: true,
        icon: stock.state === 'warn' ? 'alert' : undefined,
    });
    chip.classList.add('wg-meds-stock__chip');
    return chip;
}

// The medication after a stock write: the new count, and the ledger the
// sheet's history reads.
function _stockAfter(med, mode, value, count) {
    const at = new Date().toISOString();
    const prev = med.stock || { counted: med.inventory_count, counted_at: null, seed: true, refills: [], taken: 0 };
    const stock = mode === 'counted'
        ? { counted: value, counted_at: at, seed: false, refills: [], taken: 0 }
        : { ...prev, refills: [{ n: value, at }, ...(prev.refills || [])] };
    return { ...med, inventory_count: count, stock };
}

// Optimistic stock write (CLAUDE.md rule 9): patch the cached + in-memory med,
// POST the ledger route (Added → /restock, Counted → /stock-audit), then
// commit with the domain's derived count or roll back. Resolves the updated
// med, or null when the write failed.
async function _writeStock(med, mode, value) {
    const before = (Array.isArray(medications) ? medications : []).find((m) => m && m.id === med.id) || med;
    const expected = mode === 'counted' ? value : before.inventory_count + value;
    const patch = (list, next) => (Array.isArray(list) ? list.map((m) => (m && m.id === med.id ? next(m) : m)) : list);
    const handle = window.DataStore && typeof window.DataStore.applyOptimistic === 'function'
        ? await window.DataStore.applyOptimistic('medications', (prev) => patch(prev, (m) => _stockAfter(m, mode, value, expected)), ['medications'])
        : null;
    medications = patch(medications, (m) => _stockAfter(m, mode, value, expected));
    let res = null;
    try {
        res = mode === 'counted'
            ? await apiCall(`/api/medications/${med.id}/stock-audit`, 'POST', { count: value })
            : await apiCall(`/api/medications/${med.id}/restock`, 'POST', { quantity: value });
    } catch (_) { res = null; }
    if (!res) {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        medications = patch(medications, () => before);
        renderMeds();
        return null;
    }
    if (typeof res.inventory_count === 'number' && res.inventory_count !== expected) {
        medications = patch(medications, (m) => ({ ...m, inventory_count: res.inventory_count }));
        if (handle) { try { await handle.commit(medications); } catch (_) { /* best-effort */ } }
    } else if (handle) {
        try { await handle.commit(null); } catch (_) { /* best-effort */ }
    }
    renderMeds();
    return medications.find((m) => m && m.id === med.id) || null;
}

// The read-only ledger under the form (ST3), newest first: doses taken since
// the starting point as one summary row, the refills, then the starting point.
function _buildStockHistory(med) {
    const s = med.stock;
    const section = _medsEl('section', 'wg-section wg-meds-stock__history');
    const head = _medsEl('div', 'wg-section__head');
    head.append(_medsEl('span', 'wg-eyebrow', 'History'), _medsEl('span', 'wg-meta', 'newest first'));
    const list = _medsEl('div', 'wg-list');
    const row = (icon, title, meta) => {
        const r = _medsEl('div', 'wg-row wg-row--pad');
        const lead = _medsEl('span', 'wg-row__lead');
        lead.appendChild(_medsIcon(icon));
        const body = _medsEl('span', 'wg-row__body');
        body.append(_medsEl('span', 'wg-row__title', title), _medsEl('span', 'wg-row__meta', meta));
        r.append(lead, body);
        list.appendChild(r);
    };
    const since = s.counted_at ? _stockDay(s.counted_at) : '';
    if (s.taken > 0) {
        const daily = calculateDailyUsage(med);
        row('pill', since ? `−${s.taken} taken since ${since}` : `−${s.taken} taken`,
            daily ? `${_formatDailyUsage(daily)} · from the dose log` : 'From the dose log');
    }
    (s.refills || []).forEach((f) => row('box', `+${f.n} · ${_stockDay(f.at)}`, 'Added'));
    const start = s.seed ? `${s.counted} in stock` : `Counted ${s.counted}`;
    row('check', since ? `${start} · ${since}` : start, "Starting point for today's number");
    section.append(head, list, _medsEl('p', 'wg-hint', "Something wrong? Add a new count. History isn't edited."));
    return section;
}

// The Update stock sheet (kit ST1–ST3): one sheet, an Added | Counted switch
// (Added is the default). Added: "+1 pack (N)" first when the med has a pack
// size, presets +30/+60/+90 and a stepper for any other amount — one value;
// the primary previews "Add 30 → 47". Counted: the stepper prefilled with the
// app's number, the primary says "Set to 45 (app had 47)". opts.onDone(med)
// runs after a write landed (the editor repaints its stock row).
let _stockSheetClose = null; // module-state: closer of the one open Update stock sheet, so a reopen replaces it
function openStockSheet(med, opts = {}) {
    if (_stockSheetClose) _stockSheetClose();
    const modal = _medsEl('mt-modal', 'wg-modal wg-sheet wg-meds-stocksheet');
    modal.id = 'stock-sheet';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const backdrop = _medsEl('div', 'mt-confirm-backdrop wg-sheet-backdrop');
    const head = window.WGSheet.header({
        eyebrow: med.dosage ? `${med.name} · ${med.dosage}` : med.name,
        title: 'Update stock',
        actions: [{ label: 'Close', icon: 'x' }],
    });

    const body = _medsEl('div', 'wg-sheet__body');
    const seg = _medsEl('div', 'wg-seg wg-seg--accent wg-meds-stocksheet__mode');
    const modeBtn = (mode, label) => {
        const b = _medsEl('button', 'wg-seg__opt', label);
        b.type = 'button';
        b.dataset.mode = mode;
        seg.appendChild(b);
        return b;
    };
    const addedBtn = modeBtn('added', 'Added');
    const countedBtn = modeBtn('counted', 'Counted');

    const summary = _medsEl('div', 'wg-hstack');
    const has = _medsEl('span', 'wg-meta wg-meds-stocksheet__has');
    has.append('App has ', _medsEl('b', 'wg-dim', String(med.inventory_count)), _stockUsage(med));
    summary.append(has, _medsEl('span', 'wg-spacer'));
    const chip = _stockChip(med);
    if (chip) summary.appendChild(chip);

    const picksField = _medsEl('div', 'wg-field');
    picksField.appendChild(_medsEl('span', 'wg-label', 'How many did you get?'));
    const picks = _medsEl('div', 'wg-picks');
    picks.setAttribute('data-single', '');
    const presets = [...(med.pack_size ? [{ value: med.pack_size, pack: true }] : []), ...MEDS_REFILL_PRESETS.map((value) => ({ value }))];
    presets.forEach((p) => {
        const pick = _medsEl('button', 'wg-pick wg-meds-stocksheet__pick');
        pick.type = 'button';
        pick.dataset.qty = String(p.value);
        if (p.pack) {
            pick.dataset.pack = '';
            pick.append(_medsIcon('box', 'wg-ico--sm'), '+1 pack ', _medsEl('small', '', `(${p.value})`));
        } else {
            pick.textContent = `+${p.value}`;
        }
        picks.appendChild(pick);
    });
    picksField.appendChild(picks);

    const stepField = _medsEl('div', 'wg-field');
    const stepLabel = _medsEl('span', 'wg-label');
    const stepper = _medsEl('div', 'wg-stepper');
    const minus = _medsEl('button', 'wg-stepper__btn');
    minus.type = 'button';
    minus.setAttribute('aria-label', 'Decrease');
    minus.appendChild(_medsIcon('minus'));
    // The value is the input itself, as in the editor's steppers
    // (input.wg-stepper__val: centred, no native spin buttons).
    const input = _medsEl('input', 'wg-stepper__val wg-meds-stock__qty');
    input.type = 'number';
    input.min = '0';
    input.inputMode = 'numeric';
    input.setAttribute('aria-label', 'Doses');
    const plus = _medsEl('button', 'wg-stepper__btn');
    plus.type = 'button';
    plus.setAttribute('aria-label', 'Increase');
    plus.appendChild(_medsIcon('plus'));
    // The unit sits under the value, as the kit's small (ST1/ST2).
    const unit = _medsEl('small', 'wg-meds-stocksheet__unit');
    const val = _medsEl('div', 'wg-meds-stocksheet__val');
    val.append(input, unit);
    stepper.append(minus, val, plus);
    stepField.append(stepLabel, stepper);

    const hint = _medsEl('p', 'wg-hint', "Count what's in the pack. Doses you log from now on are taken off this number.");
    body.append(seg, summary, picksField, stepField, hint);
    if (med.stock) body.appendChild(_buildStockHistory(med));

    const foot = _medsEl('div', 'wg-sheet__foot');
    const primary = _medsEl('button', 'wg-btn wg-btn--primary wg-meds-stocksheet__save');
    primary.type = 'button';
    foot.appendChild(primary);
    modal.append(_medsEl('div', 'wg-sheet__grab'), head.el, body, foot);

    let mode = 'added';
    const value = { added: MEDS_REFILL_PRESETS[0], counted: Math.max(0, med.inventory_count) };
    const valid = () => Number.isInteger(value[mode]) && (mode === 'counted' ? value[mode] >= 0 : value[mode] > 0);
    const paint = () => {
        addedBtn.setAttribute('aria-pressed', String(mode === 'added'));
        countedBtn.setAttribute('aria-pressed', String(mode === 'counted'));
        picksField.hidden = mode !== 'added';
        hint.hidden = mode !== 'counted';
        stepLabel.textContent = mode === 'added' ? 'Other amount' : 'How many do you have now?';
        if (document.activeElement !== input) input.value = Number.isInteger(value[mode]) ? String(value[mode]) : '';
        unit.textContent = value[mode] === 1 ? 'dose' : 'doses';
        // One value: the chip matching the amount is pressed (the pack chip
        // wins a tie with an equal preset).
        const pressed = presets.findIndex((x) => x.value === value.added);
        picks.querySelectorAll('.wg-pick').forEach((p, i) => p.setAttribute('aria-pressed', String(i === pressed)));
        const v = value[mode];
        if (!valid()) primary.textContent = mode === 'added' ? 'Add' : 'Set';
        else if (mode === 'added') primary.textContent = `Add ${v} → ${med.inventory_count + v}`;
        else primary.textContent = `Set to ${v} (app had ${med.inventory_count})`;
        primary.disabled = !valid() || primary.hasAttribute('data-submit-in-flight');
    };
    addedBtn.addEventListener('click', () => { mode = 'added'; paint(); });
    countedBtn.addEventListener('click', () => { mode = 'counted'; paint(); });
    picks.querySelectorAll('.wg-pick').forEach((p) => p.addEventListener('click', () => {
        value.added = Number(p.dataset.qty);
        paint();
    }));
    const step = (d) => {
        const cur = Number.isInteger(value[mode]) ? value[mode] : 0;
        value[mode] = Math.max(mode === 'added' ? 1 : 0, cur + d);
        paint();
    };
    minus.addEventListener('click', () => step(-1));
    plus.addEventListener('click', () => step(1));
    input.addEventListener('input', () => {
        value[mode] = input.value === '' ? NaN : Number(input.value);
        paint();
    });

    function close() {
        if (_stockSheetClose !== close) return false;
        _stockSheetClose = null;
        window.ModalManager.close(modal.id);
        window.ModalManager.register(modal.id, null);
        modal.remove();
        backdrop.remove();
        return true;
    }
    primary.addEventListener('click', () => withSubmit(primary, async () => {
        if (!valid()) return;
        const updated = await _writeStock(med, mode, value[mode]);
        if (!updated) {
            safeToast("Stock wasn't updated. Try again.", 'error');
            return;
        }
        close();
        if (typeof opts.onDone === 'function') opts.onDone(updated);
    }));
    head.buttons[0].addEventListener('click', close);
    backdrop.addEventListener('click', close);

    _stockSheetClose = close;
    document.body.append(backdrop, modal);
    window.ModalManager.register(modal.id, close);
    window.ModalManager.open(modal.id);
    paint();
    return close;
}

function renderMedsEmptyState() {
    const list = document.getElementById('med-list');
    if (!list) return;
    list.replaceChildren(createOfflineEmptyState());
    syncMedsAddButton();
}

// Logic
async function loadMeds() {
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
        pack_size: trackInventory ? (parseInt(document.getElementById('med-pack-size').value, 10) || null) : null,
        tz_shift_policy: tzShiftPolicy
    };
    // The EU card picked with "Use this" (bd med-3u28.10): only its key; the
    // domain resolves it against the register and never blocks the Save.
    const euPick = medEuPickFor(name.trim());
    if (euPick) payload.ema_substances = euPick;

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
            pack_size: payload.pack_size || undefined,
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

// The FULL update body for POST /api/medications/:id, built from the med row
// (bd med-h1wk). The domain update replaces the record: an omitted
// start_date/end_date clears it, an omitted tz_shift_policy resets to
// "flexible", an omitted inventory_count stops stock tracking
// (web/domain/medications.js update). So a write that changes one field
// sends every field saveMedication sends, with `overrides` on top. A tracked
// count is ignored by the domain (stock moves only through the ledger).
function _medUpdatePayload(med, overrides = {}) {
    return {
        name: med.name,
        dosage: med.dosage || '',
        schedule: med.schedule,
        archived: !!med.archived,
        supplement: !!med.supplement,
        start_date: med.start_date || null,
        end_date: med.end_date || null,
        inventory_count: _medsTracked(med) ? med.inventory_count : null,
        pack_size: med.pack_size || null,
        tz_shift_policy: med.tz_shift_policy || 'flexible',
        ...overrides,
    };
}

// My meds "Stop tracking" (kit MY1 · end): one tap, no confirm, no undo.
// Tracking off through the full update; the stock ledger stays, so the
// editor's Track stock restarts it with an audit. Optimistic (rule 9).
async function stopTrackingMed(id) {
    const med = (Array.isArray(medications) ? medications : []).find((m) => m && m.id === id);
    if (!med) return false;
    const off = { inventory_count: null, pack_size: null };
    const patch = (list, next) => (Array.isArray(list) ? list.map((m) => (m && m.id === id ? next(m) : m)) : list);
    const untracked = (m) => ({ ...m, ...off, stock: undefined, _optimistic: true });
    const handle = await window.DataStore.applyOptimistic('medications', (prev) => patch(prev, untracked), ['medications']);
    medications = patch(medications, untracked);
    renderMeds();
    let res = null;
    try {
        res = await apiCall(`/api/medications/${id}`, 'POST', _medUpdatePayload(med, off));
    } catch (_) { res = null; }
    if (!res) {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        medications = patch(medications, () => med);
        renderMeds();
        return false;
    }
    if (handle) { try { await handle.commit(null); } catch (_) { /* best-effort */ } }
    await window.DataStore.invalidateTags(['medications']);
    loadMeds();
    return true;
}

// The archive POST. Resolves true on success.
async function _archiveMedApi(med) {
    const id = med.id;
    const payload = _medUpdatePayload(med, { archived: true });

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
