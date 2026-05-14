// ====================================
// WORKOUT HISTORY — list + grouping
// ====================================
//
// Renders the History sub-tab: combined manual sessions + Mi Band outdoor
// entries grouped by local day. Pulls timezone from the cached settings
// bundle so skipped-session sort timestamps match the backend.

// Maps Mi Band activity_name → display label + icon
const MIBAND_ACTIVITY_META = {
    'nordic_walking': { label: 'Nordic Walking', icon: '🏔️' },
    'cycling': { label: 'Cycling', icon: '🚴' },
    'walking': { label: 'Walking', icon: '🚶' },
    'running': { label: 'Running', icon: '🏃' },
};

async function loadWorkoutHistoryTab() {
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
            const [sessionsResp, mibandResp] = await Promise.all([
                apiCall('/api/workout/sessions?limit=50').catch(() => null),
                apiCall('/api/workout/miband?limit=100').catch(() => null)
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
            await renderWorkoutHistoryStaleBadge();
        },
        onFresh: async (fresh) => {
            _renderWorkoutHistory(container, fresh.sessions || [], fresh.miband || [], userTz);
            await renderWorkoutHistoryStaleBadge();
        },
        onError: async (error, cached) => {
            console.error('Error loading workout history:', error);
            if (!cached) {
                const message = document.createElement('p');
                message.className = 'text-danger';
                message.textContent = 'Error loading history';
                container.replaceChildren(message);
            }
            await renderWorkoutHistoryStaleBadge();
        }
    });
}

function _formatDuration(sec) {
    if (!sec || sec <= 0) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}h ${m}min`;
    return `${m}min`;
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

function _renderWorkoutHistory(container, sessions, mibandWorkouts, userTz) {
    // Build unified list sorted by date DESC
    const items = [];

    // Manual strength sessions
    const finalSessions = (sessions || []).filter(s =>
        s.session.status === 'completed' || s.session.status === 'skipped'
    );
    finalSessions.forEach(s => {
        let ts;
        if (s.session.started_at) {
            ts = new Date(s.session.started_at).getTime();
        } else {
            // Skipped sessions have no started_at; interpret the scheduled time in the
            // user's saved timezone (same as the backend uses) so that sort order is
            // consistent with Mi Band entries that carry absolute UTC timestamps.
            const dateStr = s.session.scheduled_date.split('T')[0];
            const timeStr = s.session.scheduled_time || '00:00';
            ts = _naiveDatetimeToUTCMs(dateStr, timeStr, userTz || '');
        }
        items.push({ type: 'session', ts: ts, data: s });
    });

    // Mi Band outdoor workouts
    (mibandWorkouts || []).forEach(w => {
        items.push({ type: 'miband', ts: new Date(w.start_time).getTime(), data: w });
    });

    // Sort newest first
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

    // Group by local day for section-labeled clusters (mirrors Phase 6 weight
    // history pattern). Use the user's stored timezone so day boundaries line
    // up with the backend-interpreted scheduled times of skipped sessions.
    const groups = _groupWorkoutHistoryByDay(items, userTz);
    const list = document.createElement('ul');
    list.className = 'list-reset wg-workouts-history__list';
    groups.forEach((group) => {
        list.appendChild(_buildWorkoutHistoryGroup(group));
    });
    container.appendChild(list);
}

function _groupWorkoutHistoryByDay(items, userTz) {
    // Compute day keys in the user's stored timezone so section headers agree
    // with the backend-scheduled day for skipped sessions (see
    // _naiveDatetimeToUTCMs above). Falls back to browser local when tzName is
    // empty/unrecognised.
    const tzName = userTz || undefined;
    let keyFmt;
    let labelFmt;
    try {
        keyFmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: tzName,
            year: 'numeric', month: '2-digit', day: '2-digit'
        });
        labelFmt = new Intl.DateTimeFormat(undefined, {
            timeZone: tzName,
            day: '2-digit', month: '2-digit', year: 'numeric'
        });
    } catch (_) {
        keyFmt = new Intl.DateTimeFormat('en-CA', {
            year: 'numeric', month: '2-digit', day: '2-digit'
        });
        labelFmt = new Intl.DateTimeFormat(undefined, {
            day: '2-digit', month: '2-digit', year: 'numeric'
        });
    }

    const now = new Date();
    const todayKey = keyFmt.format(now);
    // Decrement via UTC calendar arithmetic so DST transitions (23h/25h
    // local days) don't shift yesterdayKey to the wrong calendar date.
    const [ty, tm, td] = todayKey.split('-').map(Number);
    const yUTC = new Date(Date.UTC(ty, tm - 1, td) - 86400000);
    const yesterdayKey = `${yUTC.getUTCFullYear()}-${String(yUTC.getUTCMonth() + 1).padStart(2, '0')}-${String(yUTC.getUTCDate()).padStart(2, '0')}`;

    const buckets = new Map();
    items.forEach((item) => {
        const d = new Date(item.ts);
        if (!Number.isFinite(d.getTime())) return;
        const dayKey = keyFmt.format(d);

        let key;
        let label;
        if (dayKey === todayKey) { key = 'today'; label = 'Today'; }
        else if (dayKey === yesterdayKey) { key = 'yesterday'; label = 'Yesterday'; }
        else {
            key = dayKey;
            label = labelFmt.format(d);
        }
        // Sort-key uses the ISO-like key so chronological ordering stays
        // correct even when the browser's timezone differs from userTz.
        const sortKey = Date.parse(dayKey + 'T00:00:00Z');
        if (!buckets.has(key)) buckets.set(key, { label, sortKey, items: [] });
        buckets.get(key).items.push(item);
    });
    return Array.from(buckets.values()).sort((a, b) => b.sortKey - a.sortKey);
}

function _buildWorkoutHistoryGroup(group) {
    const groupItem = document.createElement('li');
    groupItem.className = 'wg-workouts-history__group';

    const header = document.createElement('div');
    header.className = 'wg-section-label wg-workouts-history__group-label';
    const headerText = document.createElement('span');
    headerText.textContent = group.label;
    header.appendChild(headerText);
    groupItem.appendChild(header);

    const rowList = document.createElement('ul');
    rowList.className = 'list-reset wg-workouts-history__rows';
    group.items.forEach((entry) => {
        const row = entry.type === 'session'
            ? _buildSessionCard(entry.data)
            : _buildMiBandCard(entry.data);
        rowList.appendChild(row);
    });
    groupItem.appendChild(rowList);
    return groupItem;
}

function _formatHistoryDuration(minutes) {
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    if (m <= 0) return '—';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

function _buildSessionCard(s) {
    const session = s.session || {};
    const slot = getRotationSlot(s.variant_name || '');
    const slotMod = _slotTagModifier(slot);

    const card = document.createElement('li');
    card.className = 'wg-card wg-workouts-history-row';
    card.classList.add(`wg-workouts-history-row--${session.status || 'unknown'}`);
    if (s.isLocal) card.classList.add('wg-workouts-history-row--pending');
    if (s.isRejected) card.classList.add('wg-workouts-history-row--rejected');
    card.dataset.sessionId = String(session.id || '');
    card.dataset.slot = slot;

    const body = document.createElement('div');
    body.className = 'wg-workouts-history-row__body';

    const title = document.createElement('div');
    title.className = 'wg-workouts-history-row__title';

    const slotTag = document.createElement('span');
    slotTag.className = `wg-workouts-slot-tag wg-workouts-slot-tag--${slotMod} wg-workouts-history-row__slot`;
    slotTag.textContent = slot;
    title.appendChild(slotTag);

    const name = document.createElement('span');
    name.className = 'wg-workouts-history-row__name';
    name.textContent = s.group_name || 'Workout';
    title.appendChild(name);

    body.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'wg-workouts-history-row__meta';

    const timeText = session.started_at
        ? new Date(session.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : (session.scheduled_time || '');
    if (timeText) {
        const time = document.createElement('span');
        time.className = 'wg-workouts-history-row__time';
        time.textContent = timeText;
        meta.appendChild(time);
    }

    if (session.status === 'completed') {
        const count = document.createElement('span');
        count.className = 'wg-workouts-history-row__count';
        const done = s.exercises_completed || 0;
        const total = s.exercises_count || done;
        count.textContent = `${done}/${total} exercises`;
        meta.appendChild(count);
    } else if (session.status === 'skipped') {
        const skipped = document.createElement('span');
        skipped.className = 'wg-tag wg-tag--mono wg-tag--skipped wg-workouts-history-row__status';
        skipped.textContent = 'Skipped';
        meta.appendChild(skipped);
    }

    const durationMinutes = _computeSessionDurationMinutes(session);
    if (durationMinutes > 0) {
        const duration = document.createElement('span');
        duration.className = 'wg-workouts-history-row__duration';
        duration.textContent = _formatHistoryDuration(durationMinutes);
        meta.appendChild(duration);
    }

    if (s.total_volume > 0) {
        const volume = document.createElement('span');
        volume.className = 'wg-workouts-history-row__volume';
        volume.textContent = `${Math.round(s.total_volume).toLocaleString()} kg`;
        meta.appendChild(volume);
    }

    if (s.isRejected) {
        meta.appendChild(_buildHistorySyncTag('rejected', 'Failed', s.errorMessage));
    } else if (s.isLocal) {
        meta.appendChild(_buildHistorySyncTag('pending', 'Pending'));
    }

    body.appendChild(meta);
    card.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'wg-workouts-history-row__actions';
    actions.appendChild(_buildHistoryIconBtn('view', 'View session', 'chevronRight', () => {
        showWorkoutSessionModal(session.id);
    }));
    actions.appendChild(_buildHistoryIconBtn('edit', 'Edit session', 'pencil', () => {
        showWorkoutSessionModal(session.id);
    }));
    actions.appendChild(_buildHistoryIconBtn('delete', 'Delete session', 'trash', () => {
        deleteWorkoutSessionById(session.id);
    }, { isWrite: true }));
    card.appendChild(actions);

    card.addEventListener('click', (e) => {
        // Ignore clicks originating from icon-btns — they dispatch their own
        // action and shouldn't also fall through to the detail view.
        if (e.target.closest('.wg-workouts-history-row__actions')) return;
        showWorkoutSessionModal(session.id);
    });
    return card;
}

async function deleteWorkoutSessionById(sessionId) {
    if (!sessionId) return;
    await safeConfirm('Delete this workout session?', async (ok) => {
        if (!ok) return;
        const result = await apiCall(`/api/workout/sessions/delete?id=${sessionId}`, 'DELETE');
        if (result || result === true) {
            await invalidateWorkoutCache();
            loadWorkoutHistoryTab();
        }
    });
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

function _buildHistorySyncTag(kind, label, tooltip) {
    const tag = document.createElement('span');
    tag.className = `wg-tag wg-tag--mono wg-tag--${kind} wg-workouts-history-row__sync`;
    tag.textContent = label;
    if (tooltip) tag.title = tooltip;
    return tag;
}

function _buildHistoryIconBtn(kind, ariaLabel, iconName, handler, opts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    let className = `wg-icon-btn wg-workouts-history-row__${kind}`;
    const isWrite = !!(opts && opts.isWrite);
    if (isWrite) {
        // Share the sync.js offline-toggling pathway used by modal-level
        // workout action buttons so DELETE-only controls stay disabled when
        // offline.
        className += ' workout-action-btn';
    }
    btn.className = className;
    btn.setAttribute('aria-label', ariaLabel);
    const gloss = document.createElement('span');
    gloss.className = 'wg-gloss';
    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        gloss.appendChild(window.WGIcons.iconSvg(iconName, { size: 16 }));
    }
    btn.appendChild(gloss);
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handler();
    });
    if (isWrite && typeof window !== 'undefined' && window.SyncManager && window.SyncManager.isOnline === false) {
        btn.classList.add('offline-disabled');
        btn.setAttribute('data-offline-disabled', 'true');
        btn.disabled = true;
    }
    return btn;
}

function _buildMiBandCard(w) {
    const meta = MIBAND_ACTIVITY_META[w.activity_name] || { label: w.activity_name || 'Activity', icon: '🏅' };
    const startDate = new Date(w.start_time);
    const timeStr = startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const distKm = w.distance_m >= 1000
        ? `${(w.distance_m / 1000).toFixed(1)} km`
        : `${Math.round(w.distance_m)} m`;
    const duration = _formatDuration(w.duration_sec);

    const card = document.createElement('li');
    card.className = 'wg-card wg-workouts-history-row wg-workouts-history-row--miband';
    card.dataset.mibandId = String(w.id || '');
    card.dataset.slot = 'AD-HOC';

    const body = document.createElement('div');
    body.className = 'wg-workouts-history-row__body';

    const title = document.createElement('div');
    title.className = 'wg-workouts-history-row__title';

    const slotTag = document.createElement('span');
    slotTag.className = 'wg-workouts-slot-tag wg-workouts-slot-tag--adhoc wg-workouts-history-row__slot';
    slotTag.textContent = meta.label.toUpperCase();
    title.appendChild(slotTag);

    const name = document.createElement('span');
    name.className = 'wg-workouts-history-row__name';
    name.textContent = w.source === 'manual' ? 'Manual entry' : 'Mi Band';
    title.appendChild(name);

    body.appendChild(title);

    const metaRow = document.createElement('div');
    metaRow.className = 'wg-workouts-history-row__meta';

    if (timeStr) {
        const t = document.createElement('span');
        t.className = 'wg-workouts-history-row__time';
        t.textContent = timeStr;
        metaRow.appendChild(t);
    }

    const dist = document.createElement('span');
    dist.className = 'wg-workouts-history-row__count';
    dist.textContent = distKm;
    metaRow.appendChild(dist);

    if (w.duration_sec > 0) {
        const dur = document.createElement('span');
        dur.className = 'wg-workouts-history-row__duration';
        dur.textContent = duration;
        metaRow.appendChild(dur);
    }

    if (w.heart_rate_avg > 0) {
        const hr = document.createElement('span');
        hr.className = 'wg-workouts-history-row__volume';
        hr.textContent = `${w.heart_rate_avg} bpm`;
        metaRow.appendChild(hr);
    }

    body.appendChild(metaRow);
    card.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'wg-workouts-history-row__actions';
    actions.appendChild(_buildHistoryIconBtn('view', 'View workout', 'chevronRight', () => {
        showMiBandWorkoutModal(w);
    }));
    card.appendChild(actions);

    card.addEventListener('click', (e) => {
        if (e.target.closest('.wg-workouts-history-row__actions')) return;
        showMiBandWorkoutModal(w);
    });
    return card;
}

window.WorkoutHistory = {
    load: loadWorkoutHistoryTab,
    deleteSession: deleteWorkoutSessionById
};
