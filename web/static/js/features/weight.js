
// ==================== Weight Tracking Functions ====================

// Global variable to store weight logs for ruler component
let cachedWeightLogs = [];

// Range selector constants (Phase 6, Task 4). The active range persists
// across reloads via mt-weight-range. Default is 30d, matching the
// discovery layout. Keep the array in visual (asc) order so the selector
// renders 7d/30d/90d/All from left to right.
const WEIGHT_RANGE_STORAGE_KEY = 'mt-weight-range';
const WEIGHT_RANGE_OPTIONS = ['7d', '30d', '90d', 'all'];
const WEIGHT_RANGE_DEFAULT = '30d';

function getActiveWeightRange() {
    try {
        const raw = window.localStorage.getItem(WEIGHT_RANGE_STORAGE_KEY);
        if (WEIGHT_RANGE_OPTIONS.indexOf(raw) !== -1) return raw;
    } catch (_) { /* ignore */ }
    return WEIGHT_RANGE_DEFAULT;
}

function setActiveWeightRange(range) {
    if (WEIGHT_RANGE_OPTIONS.indexOf(range) === -1) return;
    try { window.localStorage.setItem(WEIGHT_RANGE_STORAGE_KEY, String(range)); } catch (_) { /* ignore */ }
}

function renderWeightRangeSelector(opts) {
    const container = document.getElementById('weight-range-selector');
    if (!container) return;
    const options = opts || {};
    const active = WEIGHT_RANGE_OPTIONS.indexOf(options.active) !== -1
        ? options.active
        : WEIGHT_RANGE_DEFAULT;
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;

    container.replaceChildren();
    container.className = 'wg-gloss--inset wg-weight-range-selector';

    WEIGHT_RANGE_OPTIONS.forEach((range) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-gloss wg-weight-range-selector__btn';
        if (range === active) btn.classList.add('wg-gloss--sun', 'wg-weight-range-selector__btn--active');
        btn.setAttribute('data-range', range);
        btn.setAttribute('aria-pressed', range === active ? 'true' : 'false');
        btn.textContent = range === 'all' ? 'All' : range;
        btn.addEventListener('click', () => {
            if (range === active) return;
            if (onChange) onChange(range);
        });
        container.appendChild(btn);
    });
}

function showWeightModal() {
    window.ModalManager.weight.open();

    // Set default datetime to now
    document.getElementById('weight-datetime').value = formatDateTimeLocalForInput();

    // Clear notes field
    document.getElementById('weight-notes').value = '';

    // Get last logged weight and initialize ruler
    const lastWeight = cachedWeightLogs && cachedWeightLogs.length > 0
        ? cachedWeightLogs[0].weight
        : 75.0; // Default to 75kg if no history

    // Set default value
    setWeightValue(lastWeight);

    // Initialize the ruler
    initWeightRuler(lastWeight);
}

function closeWeightModal() {
    window.ModalManager.weight.close();
}

async function handleWeightSubmit(event) {
    event.preventDefault();

    const datetime = document.getElementById('weight-datetime').value;
    const weight = parseFloat(document.getElementById('weight-value').value);
    const notes = document.getElementById('weight-notes').value;

    if (!datetime || !weight) {
        safeAlert('Please fill in all required fields');
        return;
    }

    const payload = {
        measured_at: new Date(datetime).toISOString(),
        weight,
        notes
    };

    const res = await apiCall('/api/weight', 'POST', payload);

    if (res) {
        await window.DataStore.invalidateTags(['weight']);
        closeWeightModal();
        loadWeightLogs();
    }
}

// ==================== Weight Ruler Component ====================

let rulerState = {
    currentWeight: 75.0,
    isDragging: false,
    startX: 0,
    startWeight: 0,
    pixelsPerKg: 40 // How many pixels = 1 kg
};

function setWeightValue(weight) {
    // Clamp weight between min and max
    weight = Math.max(30, Math.min(300, weight));
    weight = Math.round(weight * 10) / 10; // Round to 1 decimal

    rulerState.currentWeight = weight;

    // Update input field
    document.getElementById('weight-value').value = weight.toFixed(1);
}

function initWeightRuler(initialWeight) {
    setWeightValue(initialWeight);
    renderRulerTicks(initialWeight);
    updateRulerPosition(initialWeight);
    attachRulerEventListeners();

    // Add input event listener for manual typing
    const input = document.getElementById('weight-value');
    input.addEventListener('input', (e) => {
        const value = parseFloat(e.target.value);
        if (!isNaN(value)) {
            rulerState.currentWeight = value;
            updateRulerPosition(value);
        }
    });
}

function renderRulerTicks(centerWeight) {
    const ruler = document.getElementById('weight-ruler');
    ruler.replaceChildren(); // Clear existing ticks

    const container = document.getElementById('weight-ruler-container');
    const containerWidth = container.clientWidth;
    const centerX = containerWidth / 2;

    // Generate ticks for a range around the center weight
    const range = 15; // Show ±15 kg range
    const tickSpacing = rulerState.pixelsPerKg; // pixels between each 1kg tick

    // Calculate offset to center the current weight
    const offset = -(centerWeight - Math.floor(centerWeight - range)) * tickSpacing;

    ruler.style.transform = `translateX(${centerX + offset}px)`;

    // Generate ticks
    for (let kg = Math.floor(centerWeight - range); kg <= Math.ceil(centerWeight + range); kg++) {
        const x = (kg - Math.floor(centerWeight - range)) * tickSpacing;

        // Major tick every 1 kg
        const tick = document.createElement('div');
        tick.className = kg % 5 === 0 ? 'weight-tick major' : 'weight-tick minor';
        tick.style.left = x + 'px';
        ruler.appendChild(tick);

        // Label every 1 kg
        if (kg % 1 === 0) {
            const label = document.createElement('div');
            label.className = 'weight-tick-label';
            label.textContent = kg;
            label.style.left = x + 'px';
            ruler.appendChild(label);
        }
    }
}

function attachRulerEventListeners() {
    const container = document.getElementById('weight-ruler-container');

    // Mouse events
    container.addEventListener('mousedown', handleDragStart);
    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);

    // Touch events
    container.addEventListener('touchstart', handleDragStart, { passive: false });
    document.addEventListener('touchmove', handleDragMove, { passive: false });
    document.addEventListener('touchend', handleDragEnd);
}

function handleDragStart(e) {
    rulerState.isDragging = true;
    rulerState.startWeight = rulerState.currentWeight;

    if (e.type === 'touchstart') {
        rulerState.startX = e.touches[0].clientX;
        e.preventDefault(); // Prevent scrolling while dragging
    } else {
        rulerState.startX = e.clientX;
    }
}

function handleDragMove(e) {
    if (!rulerState.isDragging) return;

    let currentX;
    if (e.type === 'touchmove') {
        currentX = e.touches[0].clientX;
        e.preventDefault(); // Prevent scrolling
    } else {
        currentX = e.clientX;
    }

    const deltaX = rulerState.startX - currentX; // Inverted: drag left = increase weight
    const deltaWeight = deltaX / rulerState.pixelsPerKg;

    const newWeight = rulerState.startWeight + deltaWeight;
    setWeightValue(newWeight);

    // Regenerate ticks and update position to keep ruler centered
    renderRulerTicks(newWeight);
}

function handleDragEnd(e) {
    if (!rulerState.isDragging) return;
    rulerState.isDragging = false;
}

function updateRulerPosition(weight) {
    // Simply regenerate the ticks centered on the new weight
    renderRulerTicks(weight);
}


// =================== Weight Current + Goal Cards (Wandergeek Phase 6) ===================

// Trend arrow glyphs — decrease / increase / flat. Used by the current-weight
// card. Delta is previous-to-latest (positive = gained).
const WEIGHT_TREND_ARROWS = { down: '\u2193', up: '\u2191', flat: '\u2192' };

// classifyWeightTrend — returns a token-group name ('good' | 'bad' | 'flat')
// relative to the user's goal direction. The caller maps this to a CSS variant
// via .wg-weight-trend--<variant>; styles.css owns the color aliases.
//   • Any zero / non-finite delta, or a missing goal direction, returns 'flat'.
//   • goal_direction === 'lose' (default): negative delta = good, positive = bad
//   • goal_direction === 'gain'          : positive delta = good, negative = bad
function classifyWeightTrend(delta, goalDirection) {
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) return 'flat';
    const dir = typeof goalDirection === 'string' ? goalDirection.toLowerCase() : '';
    if (dir !== 'lose' && dir !== 'gain') return 'flat';
    if (dir === 'lose') return d < 0 ? 'good' : 'bad';
    return d > 0 ? 'good' : 'bad';
}

// Format helper — turns 2h / 5m / 3d into a short "... ago" phrase. Falls back
// to the local ISO stamp when the log is older than a week.
function formatWeightTimestamp(measuredAt) {
    if (!measuredAt) return '';
    const ts = new Date(measuredAt).getTime();
    if (!Number.isFinite(ts)) return '';
    const now = Date.now();
    const diff = now - ts;
    if (diff < 0) return 'just now';
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString('de-DE', {
        day: '2-digit', month: '2-digit', year: 'numeric'
    });
}

function renderWeightCurrentCard(logs, goalData) {
    const container = document.getElementById('weight-current-card');
    if (!container) return;
    container.replaceChildren();
    container.className = 'wg-card wg-weight-current-card';

    const list = Array.isArray(logs) ? logs : [];
    if (list.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'wg-weight-current-card__empty wg-muted';
        empty.textContent = 'No weight logged yet — add your first entry.';
        container.appendChild(empty);
        return;
    }

    // Logs arrive newest-first from _renderWeightData (pending prepended + server DESC).
    const latest = list[0];
    const previous = list.length > 1 ? list[1] : null;
    const latestWeight = Number(latest && latest.weight);
    const previousWeight = previous && Number(previous.weight);
    const hasPrevious = Number.isFinite(previousWeight);
    const delta = hasPrevious ? (latestWeight - previousWeight) : 0;
    const goalDirection = (goalData && typeof goalData.goal_direction === 'string')
        ? goalData.goal_direction
        : null;
    const hasGoal = !!(goalData && Number.isFinite(Number(goalData.goal)));
    const variant = hasPrevious && hasGoal
        ? classifyWeightTrend(delta, goalDirection)
        : 'flat';

    const arrowGlyph = !hasPrevious || delta === 0
        ? WEIGHT_TREND_ARROWS.flat
        : (delta < 0 ? WEIGHT_TREND_ARROWS.down : WEIGHT_TREND_ARROWS.up);

    const kicker = document.createElement('div');
    kicker.className = 'wg-section-label wg-weight-current-card__kicker';
    if (latest.isRejected) {
        kicker.textContent = 'Latest · sync failed';
    } else if (latest.isLocal) {
        kicker.textContent = 'Latest · pending sync';
    } else {
        kicker.textContent = `Latest · ${formatWeightTimestamp(latest.measured_at)}`;
    }
    container.appendChild(kicker);

    const value = document.createElement('div');
    value.className = 'wg-mono-display wg-weight-current-card__value';
    const weightSpan = document.createElement('span');
    weightSpan.className = 'wg-weight-current-card__weight';
    weightSpan.textContent = Number.isFinite(latestWeight) ? latestWeight.toFixed(1) : '—';
    const unitSpan = document.createElement('span');
    unitSpan.className = 'wg-weight-current-card__unit';
    unitSpan.textContent = 'kg';
    value.appendChild(weightSpan);
    value.appendChild(unitSpan);
    container.appendChild(value);

    const meta = document.createElement('div');
    meta.className = 'wg-weight-current-card__meta';

    const trend = document.createElement('span');
    trend.className = `wg-tag wg-weight-trend wg-weight-trend--${variant}`;
    trend.setAttribute('data-trend-variant', variant);
    const arrow = document.createElement('span');
    arrow.className = 'wg-weight-trend__arrow';
    arrow.textContent = arrowGlyph;
    const deltaSpan = document.createElement('span');
    deltaSpan.className = 'wg-weight-trend__delta';
    if (!hasPrevious) {
        deltaSpan.textContent = 'first entry';
    } else if (delta === 0) {
        deltaSpan.textContent = '0.0 kg';
    } else {
        const sign = delta > 0 ? '+' : '\u2212';
        deltaSpan.textContent = `${sign}${Math.abs(delta).toFixed(1)} kg`;
    }
    trend.appendChild(arrow);
    trend.appendChild(deltaSpan);
    meta.appendChild(trend);

    container.appendChild(meta);
}

function renderWeightGoalCard(logs, goalData) {
    const container = document.getElementById('weight-goal-card');
    if (!container) return;
    container.replaceChildren();
    container.className = 'wg-weight-goal-card';

    const goalValue = goalData && Number(goalData.goal);
    if (!Number.isFinite(goalValue)) {
        container.hidden = true;
        return;
    }
    container.hidden = false;
    container.classList.add('wg-card', 'wg-card--inset');

    const list = Array.isArray(logs) ? logs : [];
    const latestWeight = list.length > 0 ? Number(list[0].weight) : null;
    const hasLatest = Number.isFinite(latestWeight);
    const goalDirection = (goalData && typeof goalData.goal_direction === 'string')
        ? goalData.goal_direction.toLowerCase()
        : 'lose';

    const label = document.createElement('div');
    label.className = 'wg-section-label wg-weight-goal-card__label';
    label.textContent = 'GOAL';
    container.appendChild(label);

    const value = document.createElement('div');
    value.className = 'wg-mono-display wg-weight-goal-card__value';
    value.textContent = `${goalValue.toFixed(1)} kg`;
    container.appendChild(value);

    // Progress bar. Uses the gloss-inset track primitive and a neutral
    // fill-pct custom property (same convention as WGMacroBar).
    const track = document.createElement('div');
    track.className = 'wg-gloss--inset wg-weight-goal-card__track';
    const fill = document.createElement('div');
    fill.className = 'wg-weight-goal-card__fill';

    // Compute progress. For lose: start from goalData.highest_weight (fallback
    // to latest + |delta| when absent). For gain: start from goalData.lowest_weight
    // if present, else from 0 relative to goal. Clamp to [0, 100].
    let pct = 0;
    if (hasLatest) {
        if (goalDirection === 'lose') {
            const start = Number(goalData.highest_weight);
            if (Number.isFinite(start) && start > goalValue) {
                const total = start - goalValue;
                const done = start - latestWeight;
                pct = (done / total) * 100;
            } else if (latestWeight <= goalValue) {
                pct = 100;
            }
        } else {
            const start = Number(goalData.lowest_weight);
            if (Number.isFinite(start) && start < goalValue) {
                const total = goalValue - start;
                const done = latestWeight - start;
                pct = (done / total) * 100;
            } else if (latestWeight >= goalValue) {
                pct = 100;
            }
        }
    }
    if (!Number.isFinite(pct)) pct = 0;
    pct = Math.max(0, Math.min(100, pct));
    fill.style.setProperty('--fill-pct', `${pct}%`);
    track.appendChild(fill);
    container.appendChild(track);

    const delta = document.createElement('div');
    delta.className = 'wg-weight-goal-card__delta wg-muted';
    if (!hasLatest) {
        delta.textContent = 'Log a weight to see progress';
    } else {
        const diff = latestWeight - goalValue;
        if (Math.abs(diff) < 0.05) {
            delta.textContent = 'At goal';
        } else {
            const sign = diff > 0 ? '+' : '\u2212';
            delta.textContent = `${sign}${Math.abs(diff).toFixed(1)} kg to goal`;
        }
    }
    container.appendChild(delta);
}

// =================== Helper Functions for Enhanced Weight Chart ===================

// Linear regression for trend calculation
function linearRegression(dataPoints) {
    if (dataPoints.length < 2) return null;

    const n = dataPoints.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    dataPoints.forEach(point => {
        const x = point.x; // Time in days
        const y = point.y; // Weight
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
    });

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    return { slope, intercept };
}

// catmullRomSpline and calculateYAxisTicks moved to core/chart-utils.js

// Calculate weight statistics
function calculateWeightStats(logs, goalData) {
    if (!logs || logs.length === 0) {
        return null;
    }

    const stats = {};

    // Trend weight from most recent entry
    const mostRecent = logs[0]; // Already sorted DESC by API
    stats.trendWeight = mostRecent.weight_trend || mostRecent.weight;
    stats.currentWeight = mostRecent.weight;

    // Calculate weekly rate using linear regression on last 4 weeks
    const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
    const recentLogs = logs
        .filter(l => new Date(l.measured_at) >= fourWeeksAgo)
        .reverse(); // Oldest first for regression

    if (recentLogs.length >= 2) {
        const now = new Date();
        const regressionData = recentLogs.map(l => {
            const date = new Date(l.measured_at);
            const daysAgo = (now - date) / (1000 * 60 * 60 * 24);
            return { x: -daysAgo, y: l.weight }; // Negative days ago (so slope is positive for weight loss)
        });

        const regression = linearRegression(regressionData);
        if (regression) {
            stats.weeklyRate = regression.slope * 7; // Convert daily rate to weekly
        }
    }

    // Calculate forecasted goal date
    if (goalData && goalData.goal && stats.weeklyRate && stats.weeklyRate < 0) {
        const weightToLose = stats.currentWeight - goalData.goal;
        const weeksNeeded = weightToLose / Math.abs(stats.weeklyRate);
        if (weeksNeeded > 0 && weeksNeeded < 520) { // Max 10 years
            const forecastDate = new Date(Date.now() + weeksNeeded * 7 * 24 * 60 * 60 * 1000);
            stats.forecastDate = forecastDate;
        }
    }

    // Current diff from goal
    if (goalData && goalData.goal) {
        stats.goalWeight = goalData.goal;
        stats.deltaFromGoal = stats.currentWeight - goalData.goal;
    }

    return stats;
}

// Render weight chart — delegates to WGWeightChart for the Wandergeek SVG,
// honours the active range (7d / 30d / 90d / all) from localStorage, and
// renders the goal overlay when a goal is set. Empty input or no match in
// the active window falls back to the component's empty-state card.
function renderWeightChart(logs, goalData) {
    const container = document.getElementById('weightChart');
    if (!container) return;

    container.replaceChildren();
    container.classList.add('wg-weight-chart-panel');

    const activeRange = getActiveWeightRange();
    container.setAttribute('data-weight-range', activeRange);

    if (!window.WGWeightChart || typeof window.WGWeightChart.render !== 'function') {
        const noDataSpan = document.createElement('span');
        noDataSpan.className = 'no-data-msg';
        noDataSpan.textContent = 'Chart unavailable';
        container.appendChild(noDataSpan);
        return;
    }

    const node = window.WGWeightChart.render({
        logs: Array.isArray(logs) ? logs : [],
        range: activeRange,
        goal: goalData || null,
    });
    if (node) container.appendChild(node);
}



async function loadWeightLogs() {
    const list = document.getElementById('weight-list');
    await window.DataStore.loadSWR({
        key: 'weight',
        tags: ['weight'],
        fetcher: async () => {
            const [logsResult, goalResult] = await Promise.allSettled([
                apiCall('/api/weight?days=35'),
                apiCall('/api/weight/goal')
            ]);
            const logsRes = logsResult.status === 'fulfilled' ? logsResult.value : null;
            const goalRes = goalResult.status === 'fulfilled' ? goalResult.value : null;
            if (logsRes === null) return null;
            return { logsRes, goalRes };
        },
        onCached: async (cached) => {
            await _renderWeightData(cached.logsRes, cached.goalRes);
        },
        onFresh: async (fresh) => {
            await _renderWeightData(fresh.logsRes, fresh.goalRes);
        },
        onError: async (e, cached) => {
            console.error('Failed to load weight data:', e);
            if (!cached) {
                list.replaceChildren(createEmptyState('No cached data \u2014 will load when online'));
            }
        }
    });
}

async function _renderWeightData(logsRes, goalRes) {
    const list = document.getElementById('weight-list');

    // Merge server data with pending local writes
    let allLogs = logsRes || [];
    if (window.MedTrackerDB) {
        try {
            const pendingLogs = await window.MedTrackerDB.WeightStore.getPending();
            const pendingFormatted = pendingLogs.map(l => ({
                id: `local_${l.localId}`,
                localId: l.localId,
                measured_at: l.measured_at,
                weight: l.weight,
                notes: l.notes,
                isLocal: true
            }));
            const rejectedLogs = await window.MedTrackerDB.WeightStore.getRejected();
            const rejectedFormatted = rejectedLogs.map(l => ({
                id: `local_${l.localId}`,
                localId: l.localId,
                measured_at: l.measured_at,
                weight: l.weight,
                notes: l.notes,
                isLocal: true,
                isRejected: true,
                errorMessage: l.errorMessage
            }));
            allLogs = [...pendingFormatted, ...rejectedFormatted, ...allLogs];
        } catch (e) {
            console.error('Failed to get pending weight logs:', e);
        }
    }

    if (allLogs.length === 0 && logsRes === null) {
        list.replaceChildren(createEmptyState('No cached data \u2014 will load when online'));

        return;
    }

    // Cache logs globally for ruler component
    cachedWeightLogs = allLogs;

    const goalData = goalRes || {};
    renderWeightCurrentCard(allLogs, goalData);
    renderWeightGoalCard(allLogs, goalData);
    renderWeightRangeSelector({
        active: getActiveWeightRange(),
        onChange: (range) => {
            setActiveWeightRange(range);
            _renderWeightData(logsRes, goalRes);
        }
    });
    renderWeightLogs(allLogs);
    renderWeightChart(allLogs, goalData);
}

function renderWeightLogs(logs) {
    const list = document.getElementById('weight-list');
    list.replaceChildren();

    if (!logs || logs.length === 0) {
        return;
    }

    // Limit to 30 most recent
    if (logs.length > 30) {
        logs = logs.slice(0, 30);
    }

    logs.forEach(w => {
        const dateStr = formatDate(w.measured_at);
        const trendDiff = w.weight_trend ? (w.weight - w.weight_trend).toFixed(1) : '0.0';
        const trendIcon = trendDiff > 0 ? '📈' : (trendDiff < 0 ? '📉' : '➡️');
        const pendingClass = w.isLocal ? ' pending-sync' : '';
        const listItem = document.createElement('li');
        listItem.className = `weight-item${pendingClass}`;

        const data = document.createElement('div');
        data.className = 'weight-data';

        const value = document.createElement('div');
        value.className = 'weight-value';
        value.appendChild(document.createTextNode(`${w.weight.toFixed(1)} kg `));
        if (w.isRejected) {
            value.appendChild(createSyncRejectedBadge(w.errorMessage));
        } else if (w.isLocal) {
            value.appendChild(createSyncBadge());
        }

        const trend = document.createElement('div');
        trend.className = 'weight-trend';
        trend.textContent = `${trendIcon} Trend: ${w.weight_trend ? w.weight_trend.toFixed(1) : w.weight.toFixed(1)} kg`;

        const meta = document.createElement('div');
        meta.className = 'weight-meta';
        meta.textContent = dateStr;

        data.appendChild(value);
        data.appendChild(trend);
        data.appendChild(meta);

        listItem.appendChild(data);
        listItem.appendChild(createDeleteButton(() => deleteWeightLog(String(w.id))));
        list.appendChild(listItem);
    });
}

async function deleteWeightLog(id) {
    const confirmMsg = 'Delete this weight log?';

    await safeConfirm(confirmMsg, async (ok) => {
        if (ok) await _deleteWeightApi(id);
    });
}

async function _deleteWeightApi(id) {
    // Check if this is a local-only log
    if (typeof id === 'string' && id.startsWith('local_')) {
        const localId = parseInt(id.replace('local_', ''));
        if (window.MedTrackerDB) {
            await window.MedTrackerDB.WeightStore.confirmDelete(localId);
            if (window.SyncManager) window.SyncManager.updateStatus();
        }
        loadWeightLogs();
        return;
    }

    const res = await apiCall(`/api/weight/${id}`, 'DELETE');
    if (res) {
        await window.DataStore.invalidateTags(['weight']);
        // Also remove from local IndexedDB if it exists there
        if (window.MedTrackerDB) {
            try {
                // Find and delete the local record with this serverId
                const allLogs = await window.MedTrackerDB.WeightStore.getAll();
                const localRecord = allLogs.find(l => l.serverId === parseInt(id));
                if (localRecord && localRecord.localId) {
                    await window.MedTrackerDB.WeightStore.confirmDelete(localRecord.localId);
                    if (window.SyncManager) window.SyncManager.updateStatus();
                }
            } catch (e) {
                console.error('Failed to delete from local DB:', e);
            }
        }
        loadWeightLogs();
    }
}

async function exportWeightCSV() {
    try {
        const response = await fetch('/api/weight/export', {
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
        downloadBlobAsFile(blob, 'weight_export.csv');
    } catch (err) {
        console.error('Export error:', err);
        safeAlert('Failed to export data');
    }
}
