
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

// ==================== Weight Modal (Wandergeek Phase 6, Task 6) ====================
//
// State for the edit-weight modal. Tracked outside the DOM so the unit-toggle
// round-trip (kg → lb → kg) preserves the original kg value without drift from
// display rounding. editingWeightLog carries the log being edited when the user
// opened the modal via the history-row edit button; null when adding a new
// entry.

const WEIGHT_KG_PER_LB = 0.45359237;
let weightModalUnit = 'kg';
let editingWeightLog = null;

function showWeightModal() {
    editingWeightLog = null;
    window.ModalManager.weight.open();
    setWeightModalTitle('New weight');

    document.getElementById('weight-datetime').value = formatDateTimeLocalForInput();
    document.getElementById('weight-notes').value = '';

    resetWeightUnitToggle();

    const lastWeight = cachedWeightLogs && cachedWeightLogs.length > 0
        ? cachedWeightLogs[0].weight
        : 75.0;
    setWeightValue(lastWeight);

    attachWeightUnitToggleHandlers();
}

function closeWeightModal() {
    editingWeightLog = null;
    window.ModalManager.weight.close();
}

function setWeightModalTitle(text) {
    const el = document.getElementById('weight-modal-title');
    if (el) el.textContent = text;
}

function resetWeightUnitToggle() {
    weightModalUnit = 'kg';
    const toggle = document.querySelector('#weight-modal .wg-weight-modal__unit-toggle');
    if (!toggle) return;
    toggle.querySelectorAll('.wg-weight-modal__unit-btn').forEach((btn) => {
        const isActive = btn.getAttribute('data-unit') === 'kg';
        btn.classList.toggle('wg-weight-modal__unit-btn--active', isActive);
        btn.classList.toggle('wg-gloss--sun', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function attachWeightUnitToggleHandlers() {
    const toggle = document.querySelector('#weight-modal .wg-weight-modal__unit-toggle');
    if (!toggle || toggle.dataset.wgBound === '1') return;
    toggle.dataset.wgBound = '1';
    toggle.addEventListener('click', (e) => {
        const btn = e.target.closest('.wg-weight-modal__unit-btn');
        if (!btn) return;
        const unit = btn.getAttribute('data-unit');
        if (unit !== 'kg' && unit !== 'lb') return;
        setWeightModalUnit(unit);
    });
}

function setWeightModalUnit(unit) {
    if (unit !== 'kg' && unit !== 'lb') return;
    if (unit === weightModalUnit) return;

    const input = document.getElementById('weight-value');
    const raw = input ? parseFloat(input.value) : NaN;
    const prevUnit = weightModalUnit;
    weightModalUnit = unit;

    const toggle = document.querySelector('#weight-modal .wg-weight-modal__unit-toggle');
    if (toggle) {
        toggle.querySelectorAll('.wg-weight-modal__unit-btn').forEach((btn) => {
            const isActive = btn.getAttribute('data-unit') === unit;
            btn.classList.toggle('wg-weight-modal__unit-btn--active', isActive);
            btn.classList.toggle('wg-gloss--sun', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    }

    if (!input || !Number.isFinite(raw)) return;
    let kg;
    if (prevUnit === 'kg') kg = raw;
    else kg = raw * WEIGHT_KG_PER_LB;

    if (unit === 'kg') {
        input.min = '30';
        input.max = '300';
        input.value = kg.toFixed(1);
    } else {
        input.min = '66';
        input.max = '660';
        const lb = kg / WEIGHT_KG_PER_LB;
        input.value = lb.toFixed(1);
    }
}

function readWeightModalKg() {
    const raw = parseFloat(document.getElementById('weight-value').value);
    if (!Number.isFinite(raw)) return NaN;
    return weightModalUnit === 'lb' ? raw * WEIGHT_KG_PER_LB : raw;
}

async function handleWeightSubmit(event) {
    event.preventDefault();

    const datetime = document.getElementById('weight-datetime').value;
    const weight = readWeightModalKg();
    const notes = document.getElementById('weight-notes').value;

    if (!datetime || !Number.isFinite(weight) || weight <= 0) {
        safeAlert('Please fill in all required fields');
        return;
    }

    const payload = {
        measured_at: new Date(datetime).toISOString(),
        weight: Math.round(weight * 10) / 10,
        notes
    };

    const res = await apiCall('/api/weight', 'POST', payload);

    if (res) {
        await window.DataStore.invalidateTags(['weight']);
        closeWeightModal();
        loadWeightLogs();
    }
}

function setWeightValue(weight) {
    // Clamp weight between min and max (kg), then round to 1 decimal. Always
    // stores the value back into the weight-value input in the active unit.
    let kg = Math.max(30, Math.min(300, Number(weight)));
    if (!Number.isFinite(kg)) kg = 75;
    kg = Math.round(kg * 10) / 10;

    const input = document.getElementById('weight-value');
    if (!input) return;
    if (weightModalUnit === 'lb') {
        const lb = kg / WEIGHT_KG_PER_LB;
        input.value = lb.toFixed(1);
    } else {
        input.value = kg.toFixed(1);
    }
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

// Render weight logs grouped by day as Wandergeek gloss cards (Phase 6, Task 5).
// Mirrors renderBPReadings: each group is a .wg-weight-history__group <li>
// with a .wg-section-label header and a list of .wg-card rows. Offline +
// rejected states surface as .wg-tag--mono variants. Each row carries a
// trailing .wg-icon-btn cluster (edit + delete).
function renderWeightLogs(logs) {
    const list = document.getElementById('weight-list');
    if (!list) return;
    list.replaceChildren();
    list.classList.add('wg-weight-history');

    if (!logs || logs.length === 0) {
        return;
    }

    // Limit to 30 most recent entries for the history panel.
    const capped = logs.length > 30 ? logs.slice(0, 30) : logs;

    const groups = groupWeightLogsByDay(capped);
    groups.forEach((group) => {
        const groupItem = buildWeightHistoryGroup(group.label, group.logs);
        if (groupItem) list.appendChild(groupItem);
    });
}

function groupWeightLogsByDay(logs) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const buckets = new Map();
    const ensureBucket = (key, label, sortKey) => {
        if (!buckets.has(key)) buckets.set(key, { label, sortKey, logs: [] });
        return buckets.get(key);
    };

    logs.forEach((w) => {
        const d = new Date(w.measured_at);
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
        ensureBucket(key, label, dayMs).logs.push(w);
    });

    return Array.from(buckets.values()).sort((a, b) => b.sortKey - a.sortKey);
}

function buildWeightHistoryGroup(label, logs) {
    if (!logs || logs.length === 0) return null;

    const sorted = [...logs].sort(
        (a, b) => new Date(b.measured_at) - new Date(a.measured_at)
    );

    const groupItem = document.createElement('li');
    groupItem.className = 'wg-weight-history__group';

    const header = document.createElement('div');
    header.className = 'wg-section-label wg-weight-history__group-label';
    const headerText = document.createElement('span');
    headerText.textContent = label;
    header.appendChild(headerText);
    groupItem.appendChild(header);

    const rowList = document.createElement('ul');
    rowList.className = 'list-reset wg-weight-history__rows';
    sorted.forEach((w) => rowList.appendChild(buildWeightHistoryRow(w)));
    groupItem.appendChild(rowList);

    return groupItem;
}

function buildWeightHistoryRow(log) {
    const item = document.createElement('li');
    item.className = 'wg-card wg-weight-history-row';
    if (log.isLocal) item.classList.add('wg-weight-history-row--pending');
    if (log.isRejected) item.classList.add('wg-weight-history-row--rejected');
    item.setAttribute('data-weight-id', String(log.id));

    const body = document.createElement('div');
    body.className = 'wg-weight-history-row__body';

    const value = document.createElement('div');
    value.className = 'wg-mono-display wg-weight-history-row__value';
    const weightSpan = document.createElement('span');
    weightSpan.className = 'wg-weight-history-row__weight';
    const weightNum = Number(log.weight);
    weightSpan.textContent = Number.isFinite(weightNum) ? weightNum.toFixed(1) : '—';
    const unitSpan = document.createElement('span');
    unitSpan.className = 'wg-weight-history-row__unit';
    unitSpan.textContent = 'kg';
    value.appendChild(weightSpan);
    value.appendChild(unitSpan);
    body.appendChild(value);

    const meta = document.createElement('div');
    meta.className = 'wg-weight-history-row__meta';

    const [, timeStr = ''] = formatDate(log.measured_at).split(' ');
    if (timeStr) {
        const time = document.createElement('span');
        time.className = 'wg-weight-history-row__time';
        time.textContent = timeStr;
        meta.appendChild(time);
    }

    if (log.isRejected) {
        meta.appendChild(buildWeightSyncTag('rejected', 'Failed', log.errorMessage));
    } else if (log.isLocal) {
        meta.appendChild(buildWeightSyncTag('pending', 'Pending'));
    }

    body.appendChild(meta);
    item.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'wg-weight-history-row__actions';
    actions.appendChild(buildWeightRowEditButton(log));
    actions.appendChild(buildWeightRowDeleteButton(log));
    item.appendChild(actions);

    return item;
}

function buildWeightSyncTag(kind, label, tooltip) {
    const tag = document.createElement('span');
    tag.className = `wg-tag wg-tag--mono wg-tag--${kind} wg-weight-history-row__sync`;
    tag.textContent = label;
    if (tooltip) tag.title = tooltip;
    return tag;
}

function buildWeightRowEditButton(log) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wg-icon-btn wg-weight-history-row__edit';
    btn.setAttribute('aria-label', 'Edit weight');

    const gloss = document.createElement('span');
    gloss.className = 'wg-gloss';
    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        gloss.appendChild(window.WGIcons.iconSvg('pencil', { size: 16 }));
    }
    btn.appendChild(gloss);

    btn.addEventListener('click', () => {
        if (typeof window.editWeightLog === 'function') {
            window.editWeightLog(log);
        }
    });
    return btn;
}

function buildWeightRowDeleteButton(log) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wg-icon-btn wg-weight-history-row__delete';
    btn.setAttribute('aria-label', 'Delete weight');

    const gloss = document.createElement('span');
    gloss.className = 'wg-gloss';
    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        gloss.appendChild(window.WGIcons.iconSvg('trash', { size: 16 }));
    }
    btn.appendChild(gloss);

    btn.addEventListener('click', () => deleteWeightLog(String(log.id)));
    return btn;
}

// Edit a weight log — prefill the edit-weight modal with the selected log's
// values and open it. The save path still POSTs a new entry via
// handleWeightSubmit; this Phase 6 change updates the header to "Edit weight"
// so the UI reflects the user's intent even though the backend contract is
// preserved.
function editWeightLog(log) {
    if (!log) return;
    if (typeof window.showWeightModal === 'function') {
        window.showWeightModal();
    }
    editingWeightLog = log;
    setWeightModalTitle('Edit weight');
    resetWeightUnitToggle();
    const valueInput = document.getElementById('weight-value');
    const dtInput = document.getElementById('weight-datetime');
    const notesInput = document.getElementById('weight-notes');
    const weightNum = Number(log.weight);
    if (valueInput && Number.isFinite(weightNum)) {
        valueInput.value = weightNum.toFixed(1);
    }
    if (dtInput && log.measured_at) {
        const d = new Date(log.measured_at);
        if (Number.isFinite(d.getTime())) {
            const pad = (n) => String(n).padStart(2, '0');
            dtInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
    }
    if (notesInput) {
        notesInput.value = typeof log.notes === 'string' ? log.notes : '';
    }
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
