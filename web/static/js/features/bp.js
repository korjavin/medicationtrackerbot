
// ==================== Blood Pressure Functions ====================

const BP_RANGE_STORAGE_KEY = 'mt-bp-range';
const BP_RANGE_OPTIONS = [14, 30, 60];
const BP_RANGE_DEFAULT = 60;

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

// Close BP modal
function closeBPRecordModal() {
    window.ModalManager.bp.close();
}

// Handle BP form submission
async function handleBPSubmit(event) {
    event.preventDefault();

    const datetime = document.getElementById('bp-datetime').value;
    const systolic = parseInt(document.getElementById('bp-systolic').value);
    const diastolic = parseInt(document.getElementById('bp-diastolic').value);
    const pulse = document.getElementById('bp-pulse').value ? parseInt(document.getElementById('bp-pulse').value) : null;
    const site = document.getElementById('bp-site').value;
    const position = document.getElementById('bp-position').value;
    const notes = document.getElementById('bp-notes').value;

    if (!datetime || !systolic || !diastolic) {
        safeAlert('Please fill in all required fields');
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

    const res = await apiCall('/api/bp', 'POST', payload);

    if (res) {
        await window.DataStore.invalidateTags(['bp']);
        closeBPRecordModal();
        loadBPReadings();
    }
}

// Load BP readings from API (with offline support)
async function loadBPReadings() {
    const list = document.getElementById('bp-list');
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
            await _renderBPData(cached.readingsRes, cached.goalRes, cached.statsRes);
        },
        onFresh: async (fresh) => {
            await _renderBPData(fresh.readingsRes, fresh.goalRes, fresh.statsRes);
        },
        onError: async (e, cached) => {
            console.error('Failed to load BP data:', e);
            if (!cached) {
                list.replaceChildren(createEmptyState('No cached data \u2014 will load when online'));
            }
        }
    });
}

async function _renderBPData(readingsRes, goalRes, statsRes) {
    const list = document.getElementById('bp-list');

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

    if (allReadings.length === 0 && readingsRes === null) {
        list.replaceChildren(createEmptyState('No cached data \u2014 will load when online'));

        return;
    }

    const activeRange = getActiveBPRange();

    renderCurrentReading(pickLatestReading(allReadings));
    renderRangeSelector({
        active: activeRange,
        onChange: (days) => {
            setActiveBPRange(days);
            _renderBPData(readingsRes, goalRes, statsRes);
        }
    });
    renderBPChart(allReadings, goalRes || {});
    renderBPAverages(statsRes || {});

    // Filter list to only show last 3 days (Today, Yesterday, and Day Before)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 2);
    cutoff.setHours(0, 0, 0, 0);

    const filteredReadings = allReadings.filter(r => new Date(r.measured_at) >= cutoff);
    renderBPReadings(filteredReadings);
}

function pickLatestReading(readings) {
    if (!Array.isArray(readings) || readings.length === 0) return null;
    let latest = null;
    let latestMs = -Infinity;
    for (const r of readings) {
        const t = new Date(r.measured_at).getTime();
        if (!Number.isFinite(t)) continue;
        if (t > latestMs) { latestMs = t; latest = r; }
    }
    return latest;
}

function renderCurrentReading(reading) {
    const container = document.getElementById('bp-current-card');
    if (!container) return;
    container.replaceChildren();
    container.className = 'wg-card wg-bp-current-card';

    if (!reading) {
        const empty = document.createElement('div');
        empty.className = 'wg-bp-current-card__empty wg-muted';
        empty.textContent = 'No readings yet';
        container.appendChild(empty);
        return;
    }

    const kicker = document.createElement('div');
    kicker.className = 'wg-section-label wg-bp-current-card__kicker';
    const kickerText = document.createElement('span');
    kickerText.textContent = reading.isLocal
        ? (reading.isRejected ? 'Latest · sync failed' : 'Latest · pending sync')
        : `Latest · ${formatDate(reading.measured_at)}`;
    kicker.appendChild(kickerText);
    container.appendChild(kicker);

    const value = document.createElement('div');
    value.className = 'wg-mono-display wg-bp-current-card__value';
    const sysSpan = document.createElement('span');
    sysSpan.className = 'wg-bp-current-card__sys';
    sysSpan.textContent = String(reading.systolic);
    const diaSpan = document.createElement('span');
    diaSpan.className = 'wg-bp-current-card__dia';
    diaSpan.textContent = `/${reading.diastolic}`;
    value.appendChild(sysSpan);
    value.appendChild(diaSpan);
    container.appendChild(value);

    const meta = document.createElement('div');
    meta.className = 'wg-bp-current-card__meta';

    const category = getBPCategory(reading.systolic, reading.diastolic);
    const tag = document.createElement('span');
    tag.className = `wg-tag wg-bp-status wg-bp-status--${category.class}`;
    tag.textContent = category.label;
    meta.appendChild(tag);

    if (reading.pulse) {
        const pulse = document.createElement('span');
        pulse.className = 'wg-muted wg-bp-current-card__pulse';
        pulse.textContent = `${reading.pulse} bpm`;
        meta.appendChild(pulse);
    }
    container.appendChild(meta);

    if (reading.pulse && window.WGSparkline && typeof window.WGSparkline.render === 'function') {
        const sparkSlot = document.createElement('div');
        sparkSlot.className = 'wg-bp-current-card__spark';
        const spark = window.WGSparkline.render({
            points: [reading.pulse - 4, reading.pulse, reading.pulse - 2, reading.pulse + 2, reading.pulse],
            variant: 'sun',
            width: 120,
            height: 22
        });
        if (spark) sparkSlot.appendChild(spark);
        container.appendChild(sparkSlot);
    }
}

function renderRangeSelector(opts) {
    const container = document.getElementById('bp-range-selector');
    if (!container) return;
    const options = opts || {};
    const active = BP_RANGE_OPTIONS.indexOf(options.active) !== -1 ? options.active : BP_RANGE_DEFAULT;
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;

    container.replaceChildren();
    container.className = 'wg-gloss--inset wg-bp-range-selector';

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
        container.appendChild(btn);
    });
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
            label = dayStart.toLocaleDateString('de-DE', {
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
        const localId = parseInt(id.replace('local_', ''));
        if (window.MedTrackerDB) {
            await window.MedTrackerDB.BPStore.confirmDelete(localId);
            if (window.SyncManager) window.SyncManager.updateStatus();
        }
        loadBPReadings();
        return;
    }

    const res = await apiCall(`/api/bp/${id}`, 'DELETE');
    if (res) {
        await window.DataStore.invalidateTags(['bp']);
        // Also remove from local IndexedDB if it exists there
        if (window.MedTrackerDB) {
            try {
                // Find and delete the local record with this serverId
                const allReadings = await window.MedTrackerDB.BPStore.getAll();
                const localRecord = allReadings.find(r => r.serverId === parseInt(id));
                if (localRecord && localRecord.localId) {
                    await window.MedTrackerDB.BPStore.confirmDelete(localRecord.localId);
                    if (window.SyncManager) window.SyncManager.updateStatus();
                }
            } catch (e) {
                console.error('Failed to delete from local DB:', e);
            }
        }
        loadBPReadings();
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
