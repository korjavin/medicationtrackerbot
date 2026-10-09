
// ==================== Blood Pressure Functions ====================

const BP_RANGE_STORAGE_KEY = 'mt-bp-range';
const BP_RANGE_OPTIONS = [14, 30, 60];
// Round-2, Task 2: default range changed from 60 → 14 to match the design
// reference. 14d is the most actionable window (short-term drift visible on
// the chart), and the user can still opt up to 30/60.
const BP_RANGE_DEFAULT = 14;

// Get BP category based on ISH 2020 guidelines (for users < 65 years)
function getBPCategory(sys, dia) {
    // Grade 2 Hypertension: ≥160 and/or ≥100
    // `state` is the kit chip state (WGChip): Normal=ok, High-normal=warn, HTN=danger.
    if (sys >= 160 || dia >= 100) return { label: 'Grade 2 HTN', class: 'grade2', state: 'danger' };
    // Grade 1 Hypertension: 140-159 and/or 90-99
    if (sys >= 140 || dia >= 90) return { label: 'Grade 1 HTN', class: 'grade1', state: 'danger' };
    // High-normal: 130-139 and/or 85-89
    if (sys >= 130 || dia >= 85) return { label: 'High-normal', class: 'highnormal', state: 'warn' };
    // Normal: <130 and <85
    return { label: 'Normal', class: 'normal', state: 'ok' };
}

function getActiveBPRange() {
    try {
        const raw = window.localStorage.getItem(BP_RANGE_STORAGE_KEY);
        const n = parseInt(raw, 10);
        if (BP_RANGE_OPTIONS.indexOf(n) !== -1) return n;
    } catch (_) { /* ignore */ }
    return BP_RANGE_DEFAULT;
}

function setActiveBPRange(days) {
    if (BP_RANGE_OPTIONS.indexOf(days) === -1) return;
    try { window.localStorage.setItem(BP_RANGE_STORAGE_KEY, String(days)); } catch (_) { /* ignore */ }
    if (window.AppNav) window.AppNav.syncChrome(); // Health app-bar subtitle names the range
}

// Show BP recording modal
function showBPRecordModal() {
    window.ModalManager.bp.open();
    setBPModalMode(null);

    // Set default datetime to now
    document.getElementById('bp-datetime').value = formatDateTimeLocalForInput();

    // Clear other fields
    document.getElementById('bp-systolic').value = '';
    document.getElementById('bp-diastolic').value = '';
    document.getElementById('bp-pulse').value = '';
    document.getElementById('bp-notes').value = '';
    document.getElementById('bp-site').value = 'right_arm';
    document.getElementById('bp-position').value = 'seated';

    // Focus the systolic field
    document.getElementById('bp-systolic').focus();
}

// The sheet is one form for add and edit: the reading being edited rides on
// the form's data-editing-id (no module state), and the header says which.
function setBPModalMode(editingId) {
    const form = document.getElementById('bp-form');
    if (form) {
        if (editingId) form.dataset.editingId = editingId;
        else delete form.dataset.editingId;
    }
    const eyebrow = document.getElementById('bp-modal-eyebrow');
    if (eyebrow) eyebrow.textContent = editingId ? 'Edit entry' : 'New entry';
    const save = document.getElementById('bp-modal-save-btn');
    if (save) save.textContent = editingId ? 'Save' : 'Log';
}

// Tap a history row → the BP sheet, prefilled, in edit mode (med-xso6.27).
function editBPReading(reading) {
    if (!reading || reading.id == null) return;
    // A row still mid-write has no stored id yet — nothing to update.
    if (String(reading.id).startsWith('local_')) return;
    showBPRecordModal();
    setBPModalMode(String(reading.id));
    document.getElementById('bp-datetime').value = formatDateTimeLocalForInput(new Date(reading.measured_at));
    document.getElementById('bp-systolic').value = String(reading.systolic);
    document.getElementById('bp-diastolic').value = String(reading.diastolic);
    document.getElementById('bp-pulse').value = reading.pulse != null ? String(reading.pulse) : '';
    document.getElementById('bp-notes').value = reading.notes || '';
    document.getElementById('bp-site').value = reading.site || 'right_arm';
    document.getElementById('bp-position').value = reading.position || 'seated';
}

// Close BP modal
function closeBPRecordModal() {
    window.ModalManager.bp.close();
}

// Handle BP form submission
let bpSubmitInFlight = false;
async function handleBPSubmit(event) {
    event.preventDefault();
    if (bpSubmitInFlight) return;

    const datetime = document.getElementById('bp-datetime').value;
    const systolic = parseInt(document.getElementById('bp-systolic').value, 10);
    const diastolic = parseInt(document.getElementById('bp-diastolic').value, 10);
    const pulse = document.getElementById('bp-pulse').value ? parseInt(document.getElementById('bp-pulse').value, 10) : null;
    const site = document.getElementById('bp-site').value;
    const position = document.getElementById('bp-position').value;
    const notes = document.getElementById('bp-notes').value;
    const form = document.getElementById('bp-form');
    const editingId = (form && form.dataset.editingId) || null;

    if (!datetime || !Number.isFinite(systolic) || !Number.isFinite(diastolic)) {
        safeAlert('Please fill in all required fields with valid numbers');
        return;
    }
    if (pulse !== null && !Number.isFinite(pulse)) {
        safeAlert('Pulse must be a valid number');
        return;
    }

    const payload = {
        measured_at: new Date(datetime).toISOString(),
        systolic,
        diastolic,
        pulse,
        site,
        position,
        notes
    };

    bpSubmitInFlight = true;
    const saveBtn = document.querySelector('#bp-modal button[form="bp-form"]');
    if (saveBtn) saveBtn.disabled = true;
    try {
        // Optimistic: prepend the new reading to the cached `bp` payload so
        // the History list + Today's tile repaint before the POST resolves.
        // The cache value is `{ readingsRes, goalRes, statsRes }`; only the
        // readings array changes locally — goal + stats are reconciled by
        // the post-commit loadBPReadings() refetch.
        const optimisticReading = {
            id: editingId || `local_optimistic_${Date.now()}`,
            measured_at: payload.measured_at,
            systolic: payload.systolic,
            diastolic: payload.diastolic,
            pulse: payload.pulse,
            site: payload.site,
            position: payload.position,
            notes: payload.notes,
            _optimistic: true
        };
        let handle = null;
        if (window.DataStore && typeof window.DataStore.applyOptimistic === 'function') {
            handle = await window.DataStore.applyOptimistic('bp', (prev) => {
                const base = prev && typeof prev === 'object' ? prev : {};
                const prevReadings = Array.isArray(base.readingsRes) ? base.readingsRes : [];
                return {
                    // Edit replaces the row in place; add prepends.
                    readingsRes: editingId
                        ? prevReadings.map((r) => (r && String(r.id) === editingId ? { ...r, ...optimisticReading } : r))
                        : [optimisticReading, ...prevReadings],
                    goalRes: base.goalRes || null,
                    statsRes: base.statsRes || null
                };
            }, ['bp']);
        }

        let res;
        try {
            res = editingId
                ? await apiCall(`/api/bp/${encodeURIComponent(editingId)}`, 'PUT', payload)
                : await apiCall('/api/bp', 'POST', payload);
        } catch (e) {
            if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
            throw e;
        }

        if (!res) {
            if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
            return;
        }

        if (handle) { try { await handle.commit(null); } catch (_) { /* best-effort */ } }
        // Invalidate so the next read fetches authoritative server data
        // (server-side id + stats/goal recompute layered on top of the
        // optimistic state).
        await window.DataStore.invalidateTags(['bp', 'gamification']);
        if (window.DataStore.clearCached) {
            await window.DataStore.clearCached('bp');
        }
        await loadBPReadings();
        closeBPRecordModal();
        // Today shortcut path: the visible tab is 'today' while the BP
        // modal is open, and loadBPReadings() only updates the hidden BP
        // screen. Refresh Today so the dashboard tile reflects the new
        // reading without waiting for a future cross-device change poll.
        if (window.AppStore && window.AppStore.get('currentTab') === 'today'
            && typeof window.loadToday === 'function') {
            window.loadToday();
        }
    } finally {
        bpSubmitInFlight = false;
        if (saveBtn) saveBtn.disabled = false;
    }
}

// Load BP readings from API (with offline support)
async function loadBPReadings() {
    const list = document.getElementById('bp-list');
    // Always render the range selector (with its inline +Log button) before
    // loadSWR runs. Otherwise, a first-visit user who is offline with no
    // cache and whose fetch resolves to null (apiCall returns null on 5xx /
    // network failure without throwing) would get neither onCached, onFresh,
    // nor onError \u2014 leaving the screen with no way to log a reading.
    renderRangeSelector({
        active: getActiveBPRange(),
        onChange: (days) => {
            setActiveBPRange(days);
            loadBPReadings();
        }
    });
    // Tracks whether any callback (cached / fresh / error) painted the list.
    // When all three miss \u2014 apiCall returns null silently on offline and there's
    // no api_cache row \u2014 `loadSWR` resolves without ever firing onCached,
    // onFresh, or onError. Fall back to an explicit empty-state below so the
    // user sees the same offline message the onError branch already renders.
    let renderedSomething = false;
    await window.DataStore.loadSWR({
        key: 'bp',
        tags: ['bp'],
        fetcher: async () => {
            const [readingsResult, goalResult, statsResult] = await Promise.allSettled([
                apiCall('/api/bp?days=60'),
                apiCall('/api/bp/goal'),
                apiCall('/api/bp/stats')
            ]);
            const readingsRes = readingsResult.status === 'fulfilled' ? readingsResult.value : null;
            const goalRes = goalResult.status === 'fulfilled' ? goalResult.value : null;
            const statsRes = statsResult.status === 'fulfilled' ? statsResult.value : null;
            if (readingsRes === null) return null;
            return { readingsRes, goalRes, statsRes };
        },
        onCached: async (cached) => {
            renderedSomething = true;
            await _renderBPData(cached.readingsRes, cached.goalRes, cached.statsRes);
        },
        onFresh: async (fresh) => {
            renderedSomething = true;
            await _renderBPData(fresh.readingsRes, fresh.goalRes, fresh.statsRes);
        },
        onError: async (e, cached) => {
            console.error('Failed to load BP data:', e);
            if (cached) {
                renderedSomething = true;
            } else if (list) {
                renderedSomething = true;
                list.replaceChildren(createOfflineEmptyState({ tag: 'li' }));
            }
        }
    });
    if (!renderedSomething && list) {
        list.replaceChildren(createOfflineEmptyState({ tag: 'li' }));
    }
}

async function _renderBPData(readingsRes, goalRes, statsRes) {
    const list = document.getElementById('bp-list');
    if (!list) return;

    const allReadings = readingsRes || [];

    const activeRange = getActiveBPRange();

    // Always render the range selector row so the trailing inline +Log button
    // (#add-bp-btn) is visible even when there's no cached data yet \u2014 the
    // button is the user's only affordance for logging a reading, and the
    // offline-write path works without any prior data.
    renderRangeSelector({
        active: activeRange,
        onChange: (days) => {
            setActiveBPRange(days);
            _renderBPData(readingsRes, goalRes, statsRes);
        }
    });

    if (allReadings.length === 0 && readingsRes === null) {
        list.replaceChildren(createOfflineEmptyState({ tag: 'li' }));
        return;
    }

    // Round-2, Task 2: the #bp-current-card top summary pane was removed
    // from #bp-view along with renderCurrentReading(); the inline title
    // row + range-pill + sun-gloss +Log now acts as the screen header and
    // latest-reading context lives inside the history list below.
    renderBPChart(allReadings, goalRes || {});
    renderBPAverages(statsRes || {});

    const filteredReadings = filterReadingsByRange(allReadings, activeRange);
    renderBPReadings(filteredReadings, allReadings.length);
}

function renderRangeSelector(opts) {
    const container = document.getElementById('bp-range-selector');
    if (!container) return;
    const options = opts || {};
    const active = BP_RANGE_OPTIONS.indexOf(options.active) !== -1 ? options.active : BP_RANGE_DEFAULT;
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;

    container.replaceChildren();
    container.className = 'wg-range-row';

    const track = document.createElement('div');
    track.className = 'wg-seg wg-seg--sm';
    track.setAttribute('role', 'group');
    track.setAttribute('aria-label', 'Range');

    BP_RANGE_OPTIONS.forEach((days) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-seg__opt';
        btn.setAttribute('data-range', String(days));
        btn.setAttribute('aria-pressed', days === active ? 'true' : 'false');
        btn.textContent = `${days}d`;
        btn.addEventListener('click', () => {
            if (days === active) return;
            if (onChange) onChange(days);
        });
        track.appendChild(btn);
    });

    container.appendChild(track);
    container.appendChild(buildBPInlineAddButton());
}

// Build the inline +Log button that sits at the end of the range-selector
// row (Phase 5, Task 5); kit v2 `.wg-btn--primary.wg-btn--sm` (med-xso6.27). Kept as `#add-bp-btn` so offline-ui's
// disabled-state sweep still finds it, and so existing tests / bindings
// keep working.
function buildBPInlineAddButton() {
    const btn = document.createElement('button');
    btn.id = 'add-bp-btn';
    btn.type = 'button';
    btn.className = 'wg-btn wg-btn--primary wg-btn--sm';
    btn.setAttribute('aria-label', 'Log blood pressure');

    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        const icon = window.WGIcons.iconSvg('plus', { size: 14 });
        if (icon) btn.appendChild(icon);
    }
    const label = document.createElement('span');
    label.textContent = 'Log';
    btn.appendChild(label);

    btn.addEventListener('click', () => {
        if (typeof window.showBPRecordModal === 'function') {
            window.showBPRecordModal();
        } else if (typeof showBPRecordModal === 'function') {
            showBPRecordModal();
        }
    });
    return btn;
}

// Render BP Chart — delegates to WGBpChart for the Wandergeek SVG and filters
// the input to the user's active range (14 / 30 / 60 days). Empty input swaps
// in a short muted message so the card height doesn't collapse.
function renderBPChart(readings, goalData) {
    const container = document.getElementById('bpChart');
    if (!container) return;

    container.replaceChildren();
    container.classList.add('wg-bp-chart-card');

    const activeRange = getActiveBPRange();
    container.setAttribute('data-bp-range', String(activeRange));

    const filtered = filterReadingsByRange(readings, activeRange);

    if (!filtered || filtered.length === 0) {
        container.appendChild(createEmptyState({
            icon: 'chart', inline: true,
            title: 'No readings in this range',
            body: 'Pick a longer range or log a reading.',
        }));
        return;
    }

    if (!window.WGBpChart || typeof window.WGBpChart.render !== 'function') {
        container.appendChild(createErrorState('Chart unavailable'));
        return;
    }

    const svg = window.WGBpChart.render({
        readings: filtered,
        goal: goalData || {},
        range: activeRange
    });
    if (svg) container.appendChild(svg);
}

function filterReadingsByRange(readings, days) {
    if (!Array.isArray(readings) || readings.length === 0) return [];
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return readings.filter((r) => {
        const t = new Date(r.measured_at).getTime();
        return Number.isFinite(t) && t >= cutoff;
    });
}

// Render BP averages as a 3-up grid of Wandergeek gloss cards (14d/30d/60d).
// Values come from the backend-calculated daily-weighted stats payload; missing
// periods render as "—" so the 3-up layout never collapses.
function renderBPAverages(stats) {
    const container = document.getElementById('bp-averages');
    if (!container) return;

    container.replaceChildren();
    container.className = 'wg-bp-averages';

    const periods = [
        { key: 'stats_14', label: '14 days', days: 14 },
        { key: 'stats_30', label: '30 days', days: 30 },
        { key: 'stats_60', label: '60 days', days: 60 }
    ];

    periods.forEach((period) => {
        const stat = stats && stats[period.key] ? stats[period.key] : null;
        container.appendChild(buildBPAverageCard(period, stat));
    });
}

function buildBPAverageCard(period, stat) {
    const card = document.createElement('div');
    card.className = 'wg-card wg-bp-average-card';
    card.setAttribute('data-period', String(period.days));

    const label = document.createElement('div');
    label.className = 'wg-section-label wg-bp-average-card__label';
    const labelText = document.createElement('span');
    labelText.textContent = period.label;
    label.appendChild(labelText);
    card.appendChild(label);

    const value = document.createElement('div');
    value.className = 'wg-mono-display wg-bp-average-card__value';
    if (stat && Number.isFinite(stat.systolic) && Number.isFinite(stat.diastolic)) {
        value.textContent = `${Math.round(stat.systolic)}/${Math.round(stat.diastolic)}`;
    } else {
        value.textContent = '\u2014';
        value.classList.add('wg-bp-average-card__value--empty');
    }
    card.appendChild(value);

    const unit = document.createElement('div');
    unit.className = 'wg-muted wg-bp-average-card__unit';
    unit.textContent = 'mmHg';
    card.appendChild(unit);

    if (stat && Number.isFinite(stat.readings) && stat.readings > 0) {
        const meta = document.createElement('div');
        meta.className = 'wg-muted wg-bp-average-card__meta';
        const readingsWord = stat.readings === 1 ? 'reading' : 'readings';
        meta.textContent = `${stat.readings} ${readingsWord}`;
        card.appendChild(meta);
    }

    return card;
}

// Render BP readings grouped by date as Wandergeek gloss cards.
// Status and offline-pending/rejected sync state render as WGChip chips;
// row actions (swipe + overflow menu, WGRowActions) reuse the existing
// deleteBPReading handler.
function renderBPReadings(readings, totalCount = 0) {
    const list = document.getElementById('bp-list');
    if (!list) return;
    list.replaceChildren();
    list.className = 'wg-bp-history';

    if (!readings || readings.length === 0) {
        // totalCount > 0: readings exist, just none inside the active range.
        list.appendChild(createEmptyState(totalCount > 0 ? {
            tag: 'li', icon: 'history',
            title: 'No readings in this range',
            body: 'Pick a longer range to see older readings.',
        } : {
            tag: 'li', icon: 'heart',
            title: 'No readings yet',
            body: 'Log your first blood pressure reading. Averages appear after 3 days.',
            actions: [{ label: 'Log reading', icon: 'plus', onClick: () => document.getElementById('add-bp-btn')?.click() }],
        }));
        return;
    }

    const groups = groupBPReadingsByDay(readings);
    groups.forEach((group) => {
        const groupItem = buildBPHistoryGroup(group.label, group.readings);
        if (groupItem) list.appendChild(groupItem);
    });
}

function groupBPReadingsByDay(readings) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const buckets = new Map(); // key -> { label, sortKey, readings }
    const ensureBucket = (key, label, sortKey) => {
        if (!buckets.has(key)) buckets.set(key, { label, sortKey, readings: [] });
        return buckets.get(key);
    };

    readings.forEach((r) => {
        const d = new Date(r.measured_at);
        if (!Number.isFinite(d.getTime())) return;
        const dayStart = new Date(d);
        dayStart.setHours(0, 0, 0, 0);
        const dayMs = dayStart.getTime();

        let key;
        let label;
        if (dayMs === today.getTime()) {
            key = 'today';
            label = 'Today';
        } else if (dayMs === yesterday.getTime()) {
            key = 'yesterday';
            label = 'Yesterday';
        } else {
            key = String(dayMs);
            label = dayStart.toLocaleDateString(undefined, {
                day: '2-digit', month: '2-digit', year: 'numeric'
            });
        }
        ensureBucket(key, label, dayMs).readings.push(r);
    });

    return Array.from(buckets.values()).sort((a, b) => b.sortKey - a.sortKey);
}

function buildBPHistoryGroup(label, readings) {
    if (!readings || readings.length === 0) return null;

    const sorted = [...readings].sort(
        (a, b) => new Date(b.measured_at) - new Date(a.measured_at)
    );

    const groupItem = document.createElement('li');
    groupItem.className = 'wg-bp-history__group';

    const header = document.createElement('div');
    header.className = 'wg-section-label wg-bp-history__group-label';
    const headerText = document.createElement('span');
    headerText.textContent = label;
    header.appendChild(headerText);
    groupItem.appendChild(header);

    const rowList = document.createElement('ul');
    rowList.className = 'list-reset wg-bp-history__rows';
    sorted.forEach((r) => rowList.appendChild(buildBPReadingRow(r)));
    groupItem.appendChild(rowList);

    return groupItem;
}

function buildBPReadingRow(reading) {
    const item = document.createElement('li');
    item.className = 'wg-card wg-bp-reading-row';
    item.setAttribute('data-reading-id', String(reading.id));

    const body = document.createElement('div');
    body.className = 'wg-bp-reading-row__body';

    const value = document.createElement('div');
    value.className = 'wg-mono-display wg-bp-reading-row__value';
    const sysSpan = document.createElement('span');
    sysSpan.className = 'wg-bp-reading-row__sys';
    sysSpan.textContent = String(reading.systolic);
    const diaSpan = document.createElement('span');
    diaSpan.className = 'wg-bp-reading-row__dia';
    diaSpan.textContent = `/${reading.diastolic}`;
    value.appendChild(sysSpan);
    value.appendChild(diaSpan);
    body.appendChild(value);

    const meta = document.createElement('div');
    meta.className = 'wg-bp-reading-row__meta';

    const [, timeStr = ''] = formatDate(reading.measured_at).split(' ');
    if (timeStr) {
        const time = document.createElement('span');
        time.className = 'wg-bp-reading-row__time';
        time.textContent = timeStr;
        meta.appendChild(time);
    }

    if (reading.pulse) {
        const pulse = document.createElement('span');
        pulse.className = 'wg-tag wg-tag--mono wg-bp-reading-row__pulse';
        pulse.textContent = `${reading.pulse} bpm`;
        meta.appendChild(pulse);
    }

    const category = getBPCategory(reading.systolic, reading.diastolic);
    const statusChip = window.WGChip.create({ text: category.label, state: category.state, small: true });
    statusChip.dataset.bpCategory = category.class;
    meta.appendChild(statusChip);

    const syncChip = window.WGChip.sync(reading);
    if (syncChip) meta.appendChild(syncChip);

    body.appendChild(meta);
    item.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'wg-bp-reading-row__actions';
    item.appendChild(actions);

    return window.WGRowActions.attach(item, {
        label: `reading ${reading.systolic}/${reading.diastolic}`,
        trail: actions,
        tapEdits: true,
        onEdit: () => editBPReading(reading),
        onDelete: () => deleteBPReading(String(reading.id)),
    });
}

// Drop one reading from the cached `bp` payload. Keeps goalRes/statsRes
// (the post-delete loadBPReadings refetch recomputes them).
function _bpWithoutReading(prev, id) {
    if (!prev || typeof prev !== 'object') return prev;
    const numericId = parseInt(id, 10);
    const prevReadings = Array.isArray(prev.readingsRes) ? prev.readingsRes : [];
    return {
        readingsRes: prevReadings.filter((r) => r && r.id !== numericId && r.id !== id),
        goalRes: prev.goalRes || null,
        statsRes: prev.statsRes || null
    };
}

// Delete a BP reading: gone at once, Undo from the toast (kit rule 3).
function deleteBPReading(id) {
    return deleteWithUndo({
        message: 'Reading deleted',
        optimistic: [{ key: 'bp', mutator: (prev) => _bpWithoutReading(prev, id), tags: ['bp'] }],
        remove: () => _deleteBPApi(id),
        replay: { fn: '_deleteBPApi', arg: id },
    });
}

async function _deleteBPApi(id) {
    // Local-only ids (DataStore optimistic rows) never reach the server —
    // just re-render from the cache.
    if (typeof id === 'string' && id.startsWith('local_')) {
        await loadBPReadings();
        return true;
    }

    // Optimistic: drop the reading from the cached `bp` payload before
    // awaiting the DELETE so the list + Today tile update immediately. The
    // mutator preserves `goalRes`/`statsRes` (those are recomputed by the
    // post-commit loadBPReadings refetch).
    let handle = null;
    if (window.DataStore && typeof window.DataStore.applyOptimistic === 'function') {
        handle = await window.DataStore.applyOptimistic('bp', (prev) => _bpWithoutReading(prev, id), ['bp']);
    }

    let res;
    try {
        res = await apiCall(`/api/bp/${id}`, 'DELETE');
    } catch (e) {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        throw e;
    }

    if (!res) {
        if (handle) { try { await handle.rollback(); } catch (_) { /* best-effort */ } }
        return false;
    }

    if (handle) { try { await handle.commit(null); } catch (_) { /* best-effort */ } }
    await window.DataStore.invalidateTags(['bp', 'gamification']);
    if (window.DataStore.clearCached) {
        await window.DataStore.clearCached('bp');
    }
    await loadBPReadings();
    return true;
}
