// ====================================
// WORKOUT TIMELINE — week-by-week list
// ====================================
//
// Renders the Timeline sub-tab (id `history`; kit screens-train-timeline.html
// WN2): manual sessions + Mi Band entries grouped by Mon–Sun week in the
// user's saved timezone, newest first. Each week: a head (count + total
// time), seven day dots, then its rows. "Show 4 earlier weeks" pages the
// already-read rows in render.

// Maps Mi Band activity_name → display label
const MIBAND_ACTIVITY_META = {
    'nordic_walking': { label: 'Nordic Walking' },
    'cycling': { label: 'Cycling' },
    'walking': { label: 'Walking' },
    'running': { label: 'Running' },
};

// The page opens with This week, Last week and one more week with rows; each
// tap adds four more. A visit (switchWorkoutTab) starts it short again; the
// refresh after a write keeps what is open.
const TIMELINE_FIRST_WEEKS = 3;
const TIMELINE_PAGE_WEEKS = 4;
const TIMELINE_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
let _timelineWeeksShown = TIMELINE_FIRST_WEEKS;
let _timelineLast = null;

async function loadWorkoutHistoryTab(opts) {
    if (opts && opts.resetWeeks) _timelineWeeksShown = TIMELINE_FIRST_WEEKS;
    const container = document.getElementById('workout-history-display');
    // Read the cached settings_bundle to get the user's saved timezone so that
    // skipped-session sort timestamps are interpreted in the same timezone the backend
    // used when scheduling, not the browser's local timezone.
    const cachedBundle = window.DataStore
        ? await window.DataStore.getCached('settings_bundle').catch(() => null)
        : null;
    let userTz = cachedBundle?.timezone || '';
    if (!userTz) {
        const fresh = await apiCall('/api/settings', 'GET').catch(() => null);
        if (fresh?.timezone) userTz = fresh.timezone;
    }
    // Cache the combined sessions + miband payload under 'workout_history' so
    // the history list renders from cache offline (matches the BP/Weight pattern).
    // Without this, the freshness chip in the section header could read
    // "Updated Nm ago" while the list beneath is empty because the raw
    // apiCall returned null.
    await window.DataStore.loadSWR({
        key: 'workout_history',
        tags: ['workout'],
        fetcher: async () => {
            // One local read of every row the Timeline can page to; paging
            // happens in render. ponytail: capped at the routes' ceilings (500
            // sessions ≈ two years at 5/week, 1000 band rows); add a before/
            // weeks param when someone pages past that.
            const [sessionsResp, mibandResp] = await Promise.all([
                apiCall('/api/workout/sessions?limit=500').catch(() => null),
                apiCall('/api/workout/miband?limit=1000').catch(() => null)
            ]);
            // Both endpoints encode no-data as `[]`, so a null response from
            // either leg means a fetch error (network/5xx with no offline
            // fallback). Throw so loadSWR's onError fires: when a combined
            // cache exists onCached already painted it and the cache is
            // preserved (fetchFresh doesn't write on throw); on first visit
            // / cache-pruned visit onError renders the explicit error state
            // instead of leaving the UI stuck on "Loading...".
            if (sessionsResp == null || mibandResp == null) {
                throw new Error('workout history fetch failed');
            }
            return {
                sessions: Array.isArray(sessionsResp) ? sessionsResp : [],
                miband: Array.isArray(mibandResp) ? mibandResp : []
            };
        },
        onCached: async (cached) => {
            _renderWorkoutHistory(container, cached.sessions || [], cached.miband || [], userTz);
        },
        onFresh: async (fresh) => {
            _renderWorkoutHistory(container, fresh.sessions || [], fresh.miband || [], userTz);
        },
        onError: async (error, cached) => {
            console.error('Error loading workout history:', error);
            if (!cached) {
                const message = document.createElement('p');
                message.className = 'text-danger';
                message.textContent = 'Error loading history';
                container.replaceChildren(message);
            }
        }
    });
}

// Convert a naive local datetime (dateStr "YYYY-MM-DD", timeStr "HH:MM") in a named
// timezone to a UTC millisecond timestamp.  Falls back to browser-local interpretation
// when tzName is empty or unrecognised.
function _naiveDatetimeToUTCMs(dateStr, timeStr, tzName) {
    const naiveUTCMs = Date.parse(`${dateStr}T${timeStr}:00Z`); // treat as UTC for TZ math
    if (!tzName) return new Date(`${dateStr}T${timeStr}:00`).getTime(); // browser-local fallback
    try {
        // Find what local time the naive-UTC instant corresponds to in tzName, then
        // compute the difference and apply it to get the true UTC ms.
        const approxDate = new Date(naiveUTCMs);
        // 'sv' locale produces "YYYY-MM-DD HH:MM:SS" — easy to re-parse as UTC.
        const localStr = approxDate.toLocaleString('sv', { timeZone: tzName }).replace(' ', 'T');
        const diff = naiveUTCMs - Date.parse(localStr + 'Z');
        return naiveUTCMs + diff;
    } catch (_) {
        return naiveUTCMs; // fall back to UTC on error
    }
}

const TIMELINE_DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function _renderWorkoutHistory(container, sessions, mibandWorkouts, userTz) {
    // Guard against a late async render firing after the environment DOM was
    // torn down (loadSWR's onFresh/onCached can resolve after the tab was
    // navigated away or, in tests, after jsdom teardown). No-op is the correct
    // behavior and prevents an unhandled `document is undefined` TypeError.
    if (typeof document === 'undefined' || !container) return;
    _timelineLast = { container, sessions, mibandWorkouts, userTz };

    // Manual strength sessions. A past-day in_progress session is a Finish
    // that never landed (med-laj4): the next-workout card only surfaces
    // today's, so the Timeline shows it as "Unfinished" instead of hiding it.
    // Today's in_progress stays out — the next-workout card owns it.
    const todayKey = _dayKeyInTz(new Date(), userTz);
    const items = [];
    (sessions || []).forEach((s) => {
        const session = s && s.session;
        if (!session) return;
        if (!(session.status === 'completed' || session.status === 'skipped' ||
            _isUnfinishedPastSession(session, todayKey))) return;
        let ts;
        let dayKey;
        if (session.started_at) {
            ts = new Date(session.started_at).getTime();
            dayKey = Number.isFinite(ts) ? _dayKeyInTz(new Date(ts), userTz) : '';
        } else {
            // Skipped sessions have no started_at. scheduled_date is the local
            // day the minting device stamped: read its prefix, never UTC parts.
            // The scheduled time in the user's zone orders it against Mi Band
            // entries, which carry absolute UTC timestamps.
            dayKey = String(session.scheduled_date || '').slice(0, 10);
            ts = _naiveDatetimeToUTCMs(dayKey, session.scheduled_time || '00:00', userTz || '');
        }
        if (Number.isFinite(ts) && TIMELINE_DAY_KEY.test(dayKey)) items.push({ type: 'session', ts, dayKey, data: s });
    });

    // Mi Band outdoor workouts
    (mibandWorkouts || []).forEach((w) => {
        const ts = new Date(w && w.start_time).getTime();
        if (Number.isFinite(ts)) items.push({ type: 'miband', ts, dayKey: _dayKeyInTz(new Date(ts), userTz), data: w });
    });

    // Newest first, within each week too.
    items.sort((a, b) => b.ts - a.ts);

    container.replaceChildren();
    container.classList.add('wg-workouts-history');

    if (items.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'wg-workouts-history__empty';
        empty.textContent = 'No workout history yet';
        container.appendChild(empty);
        return;
    }

    const weeks = _groupTimelineWeeks(items, todayKey);
    weeks.slice(0, _timelineWeeksShown).forEach((week) => {
        container.appendChild(_buildTimelineWeek(week, todayKey, userTz));
    });
    if (weeks.length > _timelineWeeksShown) {
        const more = _tlEl('button', 'wg-tl-more wg-workouts-history__more');
        more.type = 'button';
        more.append(_tlIcon('chev-d', 'wg-ico--sm'), `Show ${TIMELINE_PAGE_WEEKS} earlier weeks`);
        more.addEventListener('click', () => {
            _timelineWeeksShown += TIMELINE_PAGE_WEEKS;
            const last = _timelineLast;
            if (last) _renderWorkoutHistory(last.container, last.sessions, last.mibandWorkouts, last.userTz);
        });
        container.appendChild(more);
    }
}

// "YYYY-MM-DD" for `date` in the user's timezone (browser local when unset
// or unrecognised) — the same day frame as scheduled_date.
function _dayKeyInTz(date, userTz) {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: userTz || undefined,
            year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(date);
    } catch (_) {
        return new Intl.DateTimeFormat('en-CA', {
            year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(date);
    }
}

function _isUnfinishedPastSession(session, todayKey) {
    if (!session || session.status !== 'in_progress' || !session.scheduled_date) return false;
    return String(session.scheduled_date).slice(0, 10) < todayKey;
}

// Calendar arithmetic on "YYYY-MM-DD" keys (UTC dates, so DST never shifts a day).
function _shiftDayKey(dayKey, days) {
    const [y, m, d] = dayKey.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// 0 = Monday … 6 = Sunday.
function _weekdayIndex(dayKey) {
    const [y, m, d] = dayKey.split('-').map(Number);
    return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// Weeks newest first: This week and Last week always (their dots carry
// today), then every older week that has rows — so each "Show 4 earlier
// weeks" tap adds weeks with something in them.
function _groupTimelineWeeks(items, todayKey) {
    const thisWeek = _shiftDayKey(todayKey, -_weekdayIndex(todayKey));
    const lastWeek = _shiftDayKey(thisWeek, -7);
    const byWeek = new Map([[thisWeek, []], [lastWeek, []]]);
    items.forEach((item) => {
        const start = _shiftDayKey(item.dayKey, -_weekdayIndex(item.dayKey));
        if (!byWeek.has(start)) byWeek.set(start, []);
        byWeek.get(start).push(item);
    });
    return Array.from(byWeek, ([start, rows]) => ({
        start,
        rows,
        label: _timelineWeekLabel(start, thisWeek, lastWeek, todayKey),
    })).sort((a, b) => (a.start < b.start ? 1 : -1));
}

// "This week · 02–08.11" / "Last week · 26.10–01.11" / "19–25.10"; a week
// ending in another year than today's carries it (".2025").
function _timelineWeekLabel(start, thisWeek, lastWeek, todayKey) {
    const end = _shiftDayKey(start, 6);
    const [, sm, sd] = start.split('-');
    const [ey, em, ed] = end.split('-');
    let range = sm === em ? `${sd}–${ed}.${em}` : `${sd}.${sm}–${ed}.${em}`;
    if (ey !== todayKey.slice(0, 4)) range += `.${ey}`;
    if (start === thisWeek) return `This week · ${range}`;
    if (start === lastWeek) return `Last week · ${range}`;
    return range;
}

// A trained entry: a completed session or a band activity (they fill the
// day's dot and count in the week head).
function _isTimelineTrained(item) {
    return item.type === 'miband' || item.data.session.status === 'completed';
}

function _timelineItemMinutes(item) {
    if (item.type === 'miband') return Math.round((Number(item.data.duration_sec) || 0) / 60);
    return _computeSessionDurationMinutes(item.data.session);
}

function _buildTimelineWeek(week, todayKey, userTz) {
    const section = _tlEl('section', 'wg-section wg-workouts-history__week');
    section.dataset.week = week.start;

    const trained = week.rows.filter(_isTimelineTrained);
    const minutes = trained.reduce((sum, item) => sum + _timelineItemMinutes(item), 0);
    let metaText = 'No workouts';
    if (trained.length) {
        metaText = `${trained.length} workout${trained.length === 1 ? '' : 's'}`;
        if (minutes > 0) metaText += ` · ${_formatTimelineDuration(minutes)}`;
    }
    const head = _tlEl('div', 'wg-section__head');
    head.append(
        _tlEl('span', 'wg-eyebrow wg-workouts-history__week-label', week.label),
        _tlEl('span', 'wg-meta wg-workouts-history__week-meta', metaText)
    );

    const list = _tlEl('div', 'wg-list');
    list.appendChild(_buildTimelineDots(week, todayKey));
    week.rows.forEach((entry) => {
        list.appendChild(entry.type === 'session'
            ? _buildSessionCard(entry.data, entry.dayKey, userTz)
            : _buildMiBandCard(entry.data, entry.dayKey, userTz));
    });
    section.append(head, list);
    return section;
}

// Seven dots Mon–Sun: filled = trained, dashed = a skipped plan day (never
// red), ring = today, faded = later this week.
function _buildTimelineDots(week, todayKey) {
    const wk = _tlEl('div', 'wg-wk');
    const dots = _tlEl('div', 'wg-dots');
    const labels = _tlEl('div', 'wg-dots');
    labels.setAttribute('aria-hidden', 'true');
    let trainedDays = 0;
    for (let i = 0; i < 7; i++) {
        const day = _shiftDayKey(week.start, i);
        const rows = week.rows.filter((r) => r.dayKey === day);
        const dot = _tlEl('span', 'wg-dot');
        dot.dataset.day = day;
        if (rows.some(_isTimelineTrained)) {
            dot.classList.add('wg-dot--hit');
            trainedDays++;
        } else if (rows.some((r) => r.type === 'session' && r.data.session.status === 'skipped')) {
            dot.classList.add('wg-dot--rest');
        } else if (day > todayKey) {
            dot.classList.add('wg-dot--future');
        }
        if (day === todayKey) dot.classList.add('wg-dot--today');
        dots.appendChild(dot);
        labels.appendChild(_tlEl('span', 'wg-dots__lbl', 'MTWTFSS'[i]));
    }
    dots.setAttribute('role', 'img');
    dots.setAttribute('aria-label', `Trained ${trainedDays} of 7 days`);
    wk.append(dots, labels);
    return wk;
}

function _formatHistoryDuration(minutes) {
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    if (m <= 0) return '—';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

// Kit timeline duration: "52 min", "1h 05m".
function _formatTimelineDuration(minutes) {
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function _timelineClock(ms, userTz) {
    const opts = { hour: '2-digit', minute: '2-digit' };
    try {
        return new Date(ms).toLocaleTimeString([], { ...opts, timeZone: userTz || undefined });
    } catch (_) {
        return new Date(ms).toLocaleTimeString([], opts);
    }
}

function _tlEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

function _tlIcon(name, extraClass) {
    const ico = _tlEl('i', extraClass ? `wg-ico ${extraClass}` : 'wg-ico');
    ico.appendChild(window.WGIcons.iconSvg(name));
    return ico;
}

// One "·"-separated piece of a row's meta line (the separator is CSS).
function _tlMetaPart(meta, className, text) {
    meta.appendChild(_tlEl('span', `wg-workouts-history-row__part ${className}`, text));
}

// Row tap / Enter opens it; taps on the trail (overflow, Finish) do not.
function _bindTimelineRowOpen(row, open) {
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.addEventListener('click', (e) => {
        if (e.target.closest('.wg-workouts-history-row__actions')) return;
        open();
    });
    row.addEventListener('keydown', (e) => {
        if (e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        open();
    });
}

function _buildSessionCard(s, dayKey, userTz) {
    const session = s.session || {};
    const isAdHoc = session.group_id === -1;
    const status = session.status || 'unknown';
    const skipped = status === 'skipped';
    const unfinished = status === 'in_progress';

    const card = _tlEl('div', `wg-row wg-workouts-history-row wg-workouts-history-row--${status}`);
    if (s.isLocal) card.classList.add('wg-workouts-history-row--pending');
    if (s.isRejected) card.classList.add('wg-workouts-history-row--rejected');
    card.dataset.sessionId = String(session.id || '');

    let tone = 'ok';
    if (skipped) tone = 'stale';
    else if (unfinished) tone = 'warn';
    const lead = _tlEl('span', `wg-row__lead wg-row__lead--${tone}`);
    // An off-plan entry with no exercises (a Telegram/voice "walk") is an
    // activity, not a lift.
    let icon = 'dumbbell';
    if (skipped) icon = 'skip';
    else if (isAdHoc && !s.exercises_count) icon = 'activity';
    lead.appendChild(_tlIcon(icon));
    card.appendChild(lead);

    const body = _tlEl('span', 'wg-row__body wg-workouts-history-row__body');
    // Off-plan sessions (group_id === -1, e.g. Telegram `/workout walk` or a
    // voice log) store their free-text label in session.notes: that is the
    // title. Otherwise the row is named by its plan day ("Bench technique").
    const adhocLabel = (isAdHoc && session.notes) ? String(session.notes).trim() : '';
    const name = isAdHoc
        ? (adhocLabel || s.variant_name || 'Workout')
        : (s.variant_name || s.group_name || 'Workout');
    body.appendChild(_tlEl('span', 'wg-row__title wg-workouts-history-row__name', name));

    const meta = _tlEl('span', 'wg-row__meta wg-workouts-history-row__meta');
    const weekday = dayKey ? TIMELINE_WEEKDAYS[_weekdayIndex(dayKey)] : '';
    if (skipped) {
        if (weekday) _tlMetaPart(meta, 'wg-workouts-history-row__time', weekday);
        _tlMetaPart(meta, 'wg-workouts-history-row__status', 'skipped');
    } else {
        const clock = session.started_at
            ? _timelineClock(session.started_at, userTz)
            : (session.scheduled_time || '');
        const when = `${weekday} ${clock}`.trim();
        if (when) _tlMetaPart(meta, 'wg-workouts-history-row__time', when);
        const durationMinutes = _computeSessionDurationMinutes(session);
        if (durationMinutes > 0) {
            _tlMetaPart(meta, 'wg-workouts-history-row__duration', _formatTimelineDuration(durationMinutes));
        }
        if (unfinished && s.exercises_completed > 0) {
            const n = s.exercises_completed;
            _tlMetaPart(meta, 'wg-workouts-history-row__count', `${n} exercise${n === 1 ? '' : 's'}`);
        }
        if (s.total_volume > 0) {
            _tlMetaPart(meta, 'wg-workouts-history-row__volume', `${Math.round(s.total_volume).toLocaleString()} kg`);
        }
        // med-8j5w.2: where it happened — the session's gym snapshot, which
        // survives a later rename/delete of the gym.
        if (session.location_name) {
            _tlMetaPart(meta, 'wg-workouts-history-row__gym', `@ ${session.location_name}`);
        }
    }
    if (unfinished) {
        const chip = window.WGChip.create({ text: 'Unfinished', state: 'pending', small: true });
        chip.classList.add('wg-workouts-history-row__unfinished');
        meta.appendChild(chip);
    }
    const syncChip = window.WGChip.sync(s);
    if (syncChip) meta.appendChild(syncChip);
    body.appendChild(meta);
    card.appendChild(body);

    if (isAdHoc) card.appendChild(_tlEl('span', 'wg-tag wg-workouts-history-row__tag', 'Off plan'));

    const actions = _tlEl('span', 'wg-row__trail wg-workouts-history-row__actions');
    if (unfinished) {
        // med-laj4's late Finish, one tap: completeWorkoutSession confirms
        // and projects through DataStore.applyOptimistic.
        const finish = _tlEl('button', 'wg-btn wg-btn--sm wg-workouts-history-row__finish', 'Finish');
        finish.type = 'button';
        finish.addEventListener('click', (e) => {
            e.stopPropagation();
            completeWorkoutSession(session.id);
        });
        actions.appendChild(finish);
    }
    card.appendChild(actions);

    _bindTimelineRowOpen(card, () => showWorkoutSessionModal(session.id));
    return window.WGRowActions.attach(card, {
        label: 'session',
        trail: actions,
        onEdit: () => showWorkoutSessionModal(session.id),
        onDelete: () => deleteWorkoutSessionById(session.id),
    });
}

// Delete a history session: gone at once, Undo from the toast (kit rule 3).
function deleteWorkoutSessionById(sessionId) {
    if (!sessionId) return null;
    return deleteWithUndo({
        message: 'Workout deleted',
        optimistic: [{
            key: 'workout_history',
            mutator: (prev) => (prev && Array.isArray(prev.sessions)
                ? { ...prev, sessions: prev.sessions.filter((x) => !(x && x.session && String(x.session.id) === String(sessionId))) }
                : prev),
            tags: ['workout'],
        }],
        remove: () => _deleteWorkoutSessionApi(sessionId),
        replay: { fn: '_deleteWorkoutSessionApi', arg: sessionId },
    });
}

// The session DELETE. Resolves true on success.
async function _deleteWorkoutSessionApi(sessionId) {
    const result = await apiCall(`/api/workout/sessions/delete?id=${sessionId}`, 'DELETE');
    if (!result) return false;
    await invalidateWorkoutCache();
    loadWorkoutHistoryTab();
    return true;
}

function _computeSessionDurationMinutes(session) {
    if (!session) return 0;
    if (Number.isFinite(Number(session.duration_minutes))) {
        return Math.max(0, Math.round(Number(session.duration_minutes)));
    }
    if (session.started_at && session.completed_at) {
        const diff = new Date(session.completed_at).getTime() - new Date(session.started_at).getTime();
        if (Number.isFinite(diff) && diff > 0) return Math.round(diff / 60000);
    }
    return 0;
}

// A band row: the activity is the title, "Band" (or its import source) the tag.
function _buildMiBandCard(w, dayKey, userTz) {
    const label = (MIBAND_ACTIVITY_META[w.activity_name] || { label: w.activity_name || 'Activity' }).label;

    const card = _tlEl('div', 'wg-row wg-workouts-history-row wg-workouts-history-row--miband');
    card.dataset.mibandId = String(w.id || '');

    const lead = _tlEl('span', 'wg-row__lead wg-row__lead--ok');
    lead.appendChild(_tlIcon('route'));
    card.appendChild(lead);

    const body = _tlEl('span', 'wg-row__body wg-workouts-history-row__body');
    body.appendChild(_tlEl('span', 'wg-row__title wg-workouts-history-row__name', label));

    const meta = _tlEl('span', 'wg-row__meta wg-workouts-history-row__meta');
    const weekday = dayKey ? TIMELINE_WEEKDAYS[_weekdayIndex(dayKey)] : '';
    _tlMetaPart(meta, 'wg-workouts-history-row__time', `${weekday} ${_timelineClock(w.start_time, userTz)}`.trim());
    const minutes = Math.round((Number(w.duration_sec) || 0) / 60);
    if (minutes > 0) _tlMetaPart(meta, 'wg-workouts-history-row__duration', _formatTimelineDuration(minutes));
    if (w.distance_m > 0) {
        _tlMetaPart(meta, 'wg-workouts-history-row__count', w.distance_m >= 1000
            ? `${(w.distance_m / 1000).toFixed(1)} km`
            : `${Math.round(w.distance_m)} m`);
    }
    body.appendChild(meta);
    card.appendChild(body);

    let source = 'Band';
    if (w.source === 'manual') source = 'Manual';
    else if (w.source === 'apple_health') source = 'Apple Health';
    card.appendChild(_tlEl('span', 'wg-tag wg-workouts-history-row__tag', source));

    const actions = _tlEl('span', 'wg-row__trail wg-workouts-history-row__actions');
    card.appendChild(actions);

    _bindTimelineRowOpen(card, () => showMiBandWorkoutModal(w));
    return window.WGRowActions.attach(card, {
        label: 'workout',
        trail: actions,
        onEdit: () => showMiBandWorkoutModal(w),
        onDelete: () => deleteMiBandWorkoutById(w.id),
    });
}

window.WorkoutHistory = {
    load: loadWorkoutHistoryTab,
    deleteSession: deleteWorkoutSessionById
};
