
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
    if (sys >= 160 || dia >= 100) return { label: 'Grade 2 HTN', class: 'grade2' };
    // Grade 1 Hypertension: 140-159 and/or 90-99
    if (sys >= 140 || dia >= 90) return { label: 'Grade 1 HTN', class: 'grade1' };
    // High-normal: 130-139 and/or 85-89
    if (sys >= 130 || dia >= 85) return { label: 'High-normal', class: 'highnormal' };
    // Normal: <130 and <85
    return { label: 'Normal', class: 'normal' };
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
}

// Show BP recording modal
function showBPRecordModal() {
    window.ModalManager.bp.open();
    setBPModalEyebrow('New entry');

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

function setBPModalEyebrow(text) {
    const el = document.getElementById('bp-modal-eyebrow');
    if (el) el.textContent = text;
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
        const res = await apiCall('/api/bp', 'POST', payload);

        if (res) {
            await window.DataStore.invalidateTags(['bp']);
            // Belt-and-suspenders: tagToKeys is in-memory, so if bootstrap
            // was skipped (cached-auth fast path, or bootstrap fetch failed)
            // the 'bp' key isn't registered and invalidateTags silently
            // no-ops. Today's presence check then sees the stale IndexedDB
            // snapshot, treats it as fresh, and skips the refetch — zeroing
            // the BP tile after a new reading. Clearing by key guarantees
            // eviction regardless of map state.
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
            await renderBPStaleBadge();
        },
        onFresh: async (fresh) => {
            renderedSomething = true;
            await _renderBPData(fresh.readingsRes, fresh.goalRes, fresh.statsRes);
            await renderBPStaleBadge();
        },
        onError: async (e, cached) => {
            console.error('Failed to load BP data:', e);
            if (cached) {
                renderedSomething = true;
            } else if (list) {
                renderedSomething = true;
                list.replaceChildren(createEmptyState('No cached data \u2014 will load when online'));
            }
            await renderBPStaleBadge();
        }
    });
    if (!renderedSomething && list) {
        list.replaceChildren(createEmptyState('No cached data \u2014 will load when online'));
        await renderBPStaleBadge();
    }
}

// Mounts the wg-stale-badge into the BP section header from the api_cache
// 'bp' timestamp (warmed by /api/bootstrap and refreshed by loadBPReadings).
// Mirrors the Food / Today wiring from Task 5; tone is offline whenever
// navigator.onLine is false so users can tell stale-cache from fresh data.
async function renderBPStaleBadge() {
    const slot = document.getElementById('bp-stale-badge');
    if (!slot) return;
    const api = (typeof window !== 'undefined') ? window.WGStaleBadge : null;
    if (!api || typeof api.mountFromKey !== 'function') {
        slot.replaceChildren();
        slot.classList.add('hidden');
        return;
    }
    await api.mountFromKey({ slot, key: 'bp' });
}

async function _renderBPData(readingsRes, goalRes, statsRes) {
    const list = document.getElementById('bp-list');
    if (!list) return;

    // Merge server data with pending local writes
    let allReadings = readingsRes || [];
    if (window.MedTrackerDB) {
        try {
            const pendingReadings = await window.MedTrackerDB.BPStore.getPending();
            const pendingFormatted = pendingReadings.map(r => ({
                id: `local_${r.localId}`,
                localId: r.localId,
                measured_at: r.measured_at,
                systolic: r.systolic,
                diastolic: r.diastolic,
                pulse: r.pulse,
                site: r.site,
                position: r.position,
                notes: r.notes,
                isLocal: true
            }));
            const rejectedReadings = await window.MedTrackerDB.BPStore.getRejected();
            const rejectedFormatted = rejectedReadings.map(r => ({
                id: `local_${r.localId}`,
                localId: r.localId,
                measured_at: r.measured_at,
                systolic: r.systolic,
                diastolic: r.diastolic,
                pulse: r.pulse,
                site: r.site,
                position: r.position,
                notes: r.notes,
                isLocal: true,
                isRejected: true,
                errorMessage: r.errorMessage
            }));
            allReadings = [...pendingFormatted, ...rejectedFormatted, ...allReadings];
        } catch (e) {
            console.error('Failed to get pending BP readings:', e);
        }
    }

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
        list.replaceChildren(createEmptyState('No cached data \u2014 will load when online'));
        return;
    }

    // Round-2, Task 2: the #bp-current-card top summary pane was removed
    // from #bp-view along with renderCurrentReading(); the inline title
    // row + range-pill + sun-gloss +Log now acts as the screen header and
    // latest-reading context lives inside the history list below.
    renderBPChart(allReadings, goalRes || {});
    renderBPAverages(statsRes || {});

    const filteredReadings = filterReadingsByRange(allReadings, activeRange);
    renderBPReadings(filteredReadings);
}

function renderRangeSelector(opts) {
    const container = document.getElementById('bp-range-selector');
    if (!container) return;
    const options = opts || {};
    const active = BP_RANGE_OPTIONS.indexOf(options.active) !== -1 ? options.active : BP_RANGE_DEFAULT;
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;

    container.replaceChildren();
    container.className = 'wg-bp-range-selector';

    const track = document.createElement('div');
    track.className = 'wg-gloss--inset wg-bp-range-selector__track';

    BP_RANGE_OPTIONS.forEach((days) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-gloss wg-bp-range-selector__btn';
        if (days === active) btn.classList.add('wg-gloss--sun', 'wg-bp-range-selector__btn--active');
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
// row (Phase 5, Task 5). Round-2 Task 5 (defect #8): migrated to the shared
// `.wg-toolbar-btn .wg-toolbar-btn--primary` so the pill matches the
// 14/30/60d range-toggle height. Kept as `#add-bp-btn` so offline-ui's
// disabled-state sweep still finds it, and so existing tests / bindings
// keep working.
function buildBPInlineAddButton() {
    const btn = document.createElement('button');
    btn.id = 'add-bp-btn';
    btn.type = 'button';
    btn.className = 'wg-toolbar-btn wg-toolbar-btn--primary';
    btn.setAttribute('aria-label', 'Log blood pressure');

    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        const icon = window.WGIcons.iconSvg('plus', { size: 14 });
        if (icon) btn.appendChild(icon);
    }
    const label = document.createElement('span');
    label.className = 'wg-toolbar-btn__label';
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
        const noDataSpan = document.createElement('span');
        noDataSpan.className = 'no-data-msg';
        noDataSpan.textContent = 'No data available';
        container.appendChild(noDataSpan);
        return;
    }

    if (!window.WGBpChart || typeof window.WGBpChart.render !== 'function') {
        const noDataSpan = document.createElement('span');
        noDataSpan.className = 'no-data-msg';
        noDataSpan.textContent = 'Chart unavailable';
        container.appendChild(noDataSpan);
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
// Preserves offline-pending and rejected states via .wg-tag--mono variants;
// delete action is a .wg-icon-btn trailing cluster that reuses the existing
// deleteBPReading handler.
function renderBPReadings(readings) {
    const list = document.getElementById('bp-list');
    if (!list) return;
    list.replaceChildren();
    list.className = 'wg-bp-history';

    if (!readings || readings.length === 0) {
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
    if (reading.isLocal) item.classList.add('wg-bp-reading-row--pending');
    if (reading.isRejected) item.classList.add('wg-bp-reading-row--rejected');
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
    const statusTag = document.createElement('span');
    statusTag.className = `wg-tag wg-bp-status wg-bp-status--${category.class}`;
    statusTag.textContent = category.label;
    meta.appendChild(statusTag);

    if (reading.isRejected) {
        meta.appendChild(buildBPSyncTag('rejected', 'Failed', reading.errorMessage));
    } else if (reading.isLocal) {
        meta.appendChild(buildBPSyncTag('pending', 'Pending'));
    }

    body.appendChild(meta);
    item.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'wg-bp-reading-row__actions';
    actions.appendChild(buildBPReadingDeleteButton(reading));
    item.appendChild(actions);

    return item;
}

function buildBPSyncTag(kind, label, tooltip) {
    const tag = document.createElement('span');
    tag.className = `wg-tag wg-tag--mono wg-tag--${kind} wg-bp-reading-row__sync`;
    tag.textContent = label;
    if (tooltip) tag.title = tooltip;
    return tag;
}

function buildBPReadingDeleteButton(reading) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wg-icon-btn wg-bp-reading-row__delete';
    btn.setAttribute('aria-label', 'Delete reading');

    const gloss = document.createElement('span');
    gloss.className = 'wg-gloss';
    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        gloss.appendChild(window.WGIcons.iconSvg('trash', { size: 16 }));
    }
    btn.appendChild(gloss);

    btn.addEventListener('click', () => deleteBPReading(String(reading.id)));
    return btn;
}

// Delete a BP reading
async function deleteBPReading(id) {
    const confirmMsg = 'Delete this blood pressure reading?';

    await safeConfirm(confirmMsg, async (ok) => {
        if (ok) await _deleteBPApi(id);
    });
}

async function _deleteBPApi(id) {
    // Check if this is a local-only reading
    if (typeof id === 'string' && id.startsWith('local_')) {
        const localId = parseInt(id.replace('local_', ''), 10);
        if (window.MedTrackerDB) {
            await window.MedTrackerDB.BPStore.confirmDelete(localId);
            if (window.SyncManager) window.SyncManager.updateStatus();
        }
        await loadBPReadings();
        return;
    }

    const res = await apiCall(`/api/bp/${id}`, 'DELETE');
    if (res) {
        await window.DataStore.invalidateTags(['bp']);
        if (window.DataStore.clearCached) {
            await window.DataStore.clearCached('bp');
        }
        // Also remove from local IndexedDB if it exists there
        if (window.MedTrackerDB) {
            try {
                // Find and delete the local record with this serverId
                const allReadings = await window.MedTrackerDB.BPStore.getAll();
                const localRecord = allReadings.find(r => r.serverId === parseInt(id, 10));
                if (localRecord && localRecord.localId) {
                    await window.MedTrackerDB.BPStore.confirmDelete(localRecord.localId);
                    if (window.SyncManager) window.SyncManager.updateStatus();
                }
            } catch (e) {
                console.error('Failed to delete from local DB:', e);
            }
        }
        await loadBPReadings();
    }
}

// Export BP data to CSV
async function exportBPCSV() {
    try {
        const response = await fetch('/api/bp/export', {
            method: 'GET',
            headers: {
                'Authorization': `tma ${userInitData}`
            }
        });

        if (!response.ok) {
            safeAlert('Failed to generate export');
            return;
        }

        const blob = await response.blob();
        downloadBlobAsFile(blob, 'blood_pressure_export.csv');
    } catch (err) {
        console.error('Export error:', err);
        safeAlert('Failed to export data');
    }
}
