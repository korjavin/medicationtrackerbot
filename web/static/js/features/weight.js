
// ==================== Weight Tracking Functions ====================

// Cached server logs (plus pending/rejected locals) — used by showWeightModal
// to seed the input with the most recent weight.
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

// Range selector row. Round-2 Task 12 (defect #15): the top "Latest" pane was
// deleted and `#add-weight-btn` moved inline next to the 7d/30d/90d/All pills
// — mirrors BP's buildBPInlineAddButton pattern. The outer container is a
// plain flex row; the inset gloss wraps only the range-pill track so the
// trailing primary-toolbar button sits on the stage.
function renderWeightRangeSelector(opts) {
    const container = document.getElementById('weight-range-selector');
    if (!container) return;
    const options = opts || {};
    const active = WEIGHT_RANGE_OPTIONS.indexOf(options.active) !== -1
        ? options.active
        : WEIGHT_RANGE_DEFAULT;
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;

    container.replaceChildren();
    container.className = 'wg-weight-range-selector';

    const track = document.createElement('div');
    track.className = 'wg-gloss--inset wg-weight-range-selector__track';

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
        track.appendChild(btn);
    });

    container.appendChild(track);
    container.appendChild(buildWeightInlineAddButton());
}

// Build the inline +Log button that sits at the end of the range-selector
// row. Round-2 Task 12 (defect #15): replaces the paper-era header-row CTA.
// Kept as `#add-weight-btn` so offline-ui's disabled-state sweep still finds
// it and existing bindings (sync.js, showWeightModal wiring) keep working.
function buildWeightInlineAddButton() {
    const btn = document.createElement('button');
    btn.id = 'add-weight-btn';
    btn.type = 'button';
    btn.className = 'wg-toolbar-btn wg-toolbar-btn--primary';
    btn.setAttribute('aria-label', 'Log weight');

    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        const icon = window.WGIcons.iconSvg('plus', { size: 14 });
        if (icon) btn.appendChild(icon);
    }
    const label = document.createElement('span');
    label.className = 'wg-toolbar-btn__label';
    label.textContent = 'Log';
    btn.appendChild(label);

    btn.addEventListener('click', () => {
        if (typeof window.showWeightModal === 'function') {
            window.showWeightModal();
        } else if (typeof showWeightModal === 'function') {
            showWeightModal();
        }
    });
    return btn;
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
// Bumped on every showWeightModal() call so a late-resolving async seed from a
// prior open can't land on a subsequent one.
let weightModalOpenGen = 0;

function showWeightModal() {
    editingWeightLog = null;
    // Bump on every open so any in-flight async seed from a prior session
    // (even one where cachedWeightLogs is now populated and the fallback
    // branch below is skipped) can't overwrite the current input.
    const openGen = ++weightModalOpenGen;
    window.ModalManager.weight.open();
    setWeightModalEyebrow('New entry');

    document.getElementById('weight-datetime').value = formatDateTimeLocalForInput();
    document.getElementById('weight-notes').value = '';

    resetWeightUnitToggle();

    // Seed the weight input with the user's most recent logged weight so the
    // common case (log a value close to yesterday's) is one tap away. Users
    // who open the modal via the Today shortcut may not have visited the
    // Weight tab yet — cachedWeightLogs is empty then, so we fall back to
    // the DataStore / IndexedDB cache asynchronously and re-seed if the
    // user hasn't typed anything in the meantime.
    const sync = cachedWeightLogs && cachedWeightLogs.length > 0
        ? cachedWeightLogs[0].weight
        : 75.0;
    setWeightValue(sync);
    if (!cachedWeightLogs || cachedWeightLogs.length === 0) {
        const input = document.getElementById('weight-value');
        const baseline = input ? input.value : '';
        readCachedLatestWeightKg().then((kg) => {
            if (!Number.isFinite(kg)) return;
            // Caller (editWeightLog) sets editingWeightLog AFTER showWeightModal
            // returns, and the edited row's weight may coincidentally equal the
            // default 75.0 — bypassing the baseline guard. Skip the seed in
            // edit mode, and also skip if the modal was closed/reopened.
            if (editingWeightLog) return;
            if (openGen !== weightModalOpenGen) return;
            if (!input || input.value !== baseline) return;
            setWeightValue(kg);
        }).catch(() => {});
    }

    attachWeightUnitToggleHandlers();
    focusWeightModalInput();
}

// Reads the latest logged weight (kg) from the combined DataStore bootstrap
// cache (server logs) + IndexedDB WeightStore (pending/rejected local writes).
// The two sources can diverge — e.g. an offline log added via the Today
// shortcut lives only in IndexedDB until sync — so we merge them and pick the
// newest by measured_at rather than trusting whichever is populated first.
// Returns NaN when nothing is available. Errors are swallowed — the caller
// only uses the result when it's a finite number.
async function readCachedLatestWeightKg() {
    const pickLatestKg = (arr) => {
        if (!Array.isArray(arr) || arr.length === 0) return NaN;
        const sorted = arr.slice().sort((a, b) => {
            const ta = new Date(a && a.measured_at).getTime();
            const tb = new Date(b && b.measured_at).getTime();
            return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
        });
        const top = sorted[0];
        const w = top && Number(top.weight);
        return Number.isFinite(w) ? w : NaN;
    };

    const combined = [];

    try {
        if (window.DataStore && typeof window.DataStore.getCached === 'function') {
            const cached = await window.DataStore.getCached('weight');
            if (cached && Array.isArray(cached.logsRes)) combined.push(...cached.logsRes);
        }
    } catch (_) { /* best-effort */ }

    try {
        if (window.MedTrackerDB && window.MedTrackerDB.WeightStore
            && typeof window.MedTrackerDB.WeightStore.getAll === 'function') {
            const all = await window.MedTrackerDB.WeightStore.getAll();
            if (Array.isArray(all)) combined.push(...all);
        }
    } catch (_) { /* best-effort */ }

    return pickLatestKg(combined);
}

function focusWeightModalInput() {
    const input = document.getElementById('weight-value');
    if (!input) return;
    try { input.focus(); } catch (_) { /* jsdom may throw on hidden inputs */ }
    try { if (typeof input.select === 'function') input.select(); } catch (_) { /* numeric inputs can reject select() */ }
}

function closeWeightModal() {
    editingWeightLog = null;
    window.ModalManager.weight.close();
}

function setWeightModalEyebrow(text) {
    const el = document.getElementById('weight-modal-eyebrow');
    if (el) el.textContent = text;
}

function getPreferredWeightUnit() {
    return (typeof window !== 'undefined' && window.weightUnitPreference === 'lb') ? 'lb' : 'kg';
}

function resetWeightUnitToggle() {
    const preferred = getPreferredWeightUnit();
    weightModalUnit = preferred;
    // Restore the input bounds so a previous lb/kg toggle doesn't leak stale
    // min/max across modal close/reopen — setWeightModalUnit() would no-op
    // when weightModalUnit already matches the preferred unit.
    const input = document.getElementById('weight-value');
    if (input) {
        if (preferred === 'kg') {
            input.min = '30';
            input.max = '300';
        } else {
            input.min = '66';
            input.max = '660';
        }
    }
    const toggle = document.querySelector('#weight-modal .wg-weight-modal__unit-toggle');
    if (!toggle) return;
    toggle.querySelectorAll('.wg-weight-modal__unit-btn').forEach((btn) => {
        const isActive = btn.getAttribute('data-unit') === preferred;
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

    if (!input) return;
    if (unit === 'kg') {
        input.min = '30';
        input.max = '300';
    } else {
        input.min = '66';
        input.max = '660';
    }
    if (!Number.isFinite(raw)) return;
    const kg = prevUnit === 'kg' ? raw : raw * WEIGHT_KG_PER_LB;
    input.value = unit === 'kg' ? kg.toFixed(1) : (kg / WEIGHT_KG_PER_LB).toFixed(1);
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

    // Edit path: POST the replacement first so a failed POST leaves the
    // original row intact. Only after the replacement lands do we remove the
    // original — a DELETE failure at that point leaves a duplicate (surfaced
    // to the user and fixable from the history list) rather than data loss.
    // Server-backed originals are removed over the network; local
    // (pending/rejected) originals are purged from IndexedDB directly.
    //
    // When editing a server-backed log, pass ?replaces=<id> so the server's
    // weight_trend EMA skips the soon-to-be-deleted row. Without this, the
    // new trend is smoothed against a disappearing value and drifts on every
    // latest-entry edit — a drift that leaks into CSV export and MCP output.
    const editing = editingWeightLog;
    let postUrl = '/api/weight';
    if (editing && editing.id != null && !(typeof editing.id === 'string' && editing.id.startsWith('local_'))) {
        postUrl = `/api/weight?replaces=${encodeURIComponent(editing.id)}`;
    }
    const res = await apiCall(postUrl, 'POST', payload);
    if (!res) return;

    if (editing && editing.id != null) {
        if (typeof editing.id === 'string' && editing.id.startsWith('local_')) {
            const localId = parseInt(editing.id.replace('local_', ''), 10);
            if (window.MedTrackerDB && Number.isFinite(localId)) {
                try {
                    await window.MedTrackerDB.WeightStore.confirmDelete(localId);
                    if (window.SyncManager) window.SyncManager.updateStatus();
                } catch (e) {
                    console.error('Failed to purge local edit:', e);
                }
            }
        } else {
            await apiCall(`/api/weight/${editing.id}`, 'DELETE');
        }
        editingWeightLog = null;
    }

    // Smart unit-preference inference: if the user submitted in a different
    // unit than their saved preference, persist the new unit so the next open
    // (and other surfaces — Today tile, history) honors it. Stays best-effort:
    // if the PATCH fails the local write still succeeded. Skip entirely when
    // offline — PATCH has no offline fallback in sync.js, so it would surface
    // a confusing "needs internet" alert immediately after the weight POST
    // succeeded via the offline-write path.
    //
    // Route through window.setWeightUnitPreference (app.js) rather than issuing
    // an inline PATCH so this modal-side write shares the Settings serial queue.
    // Two consequences: (a) a Settings click whose PATCH is still in flight no
    // longer races this one — the server sees PATCHes in click order; (b) the
    // helper performs the post-cache re-commit that protects window.weightUnitPreference
    // / weightUnitLastCommitted from a stale loadSettings() hydration landing in
    // the await window. We pass reload:false because the modal already calls
    // loadWeightLogs() (and conditionally loadToday()) after closing.
    const submittedUnit = weightModalUnit;
    const isOffline = window.SyncManager && window.SyncManager.isOnline === false;
    if ((submittedUnit === 'kg' || submittedUnit === 'lb')
        && submittedUnit !== getPreferredWeightUnit()
        && !isOffline) {
        if (typeof window.setWeightUnitPreference === 'function') {
            await window.setWeightUnitPreference(submittedUnit, { reload: false });
        } else {
            // Early-boot fallback: helper hasn't loaded yet. Direct PATCH only;
            // the queue and post-cache re-commit aren't available pre-app.js.
            const patchRes = await apiCall('/api/settings/weight-unit', 'PATCH', { unit: submittedUnit });
            if (patchRes) window.weightUnitPreference = submittedUnit;
        }
    }

    await window.DataStore.invalidateTags(['weight']);
    // Belt-and-suspenders: tagToKeys is in-memory, so if bootstrap was
    // skipped (cached-auth fast path, or bootstrap fetch failed) the
    // 'weight' key isn't registered and invalidateTags silently no-ops.
    // Today's presence check then sees the stale IndexedDB snapshot,
    // treats it as fresh, and skips the refetch — zeroing the weight
    // tile after a new log. Clearing the key directly guarantees
    // eviction regardless of map state.
    if (window.DataStore.clearCached) {
        await window.DataStore.clearCached('weight');
    }
    closeWeightModal();
    loadWeightLogs();
    // Today shortcut path: the visible tab is 'today' while the weight modal
    // is open, and loadWeightLogs() only updates the hidden weight screen.
    // Refresh Today so the dashboard tile reflects the new reading.
    if (window.AppStore && window.AppStore.get('currentTab') === 'today'
        && typeof window.loadToday === 'function') {
        window.loadToday();
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

// =================== Weight Goal Card (Wandergeek Phase 6) ===================
// Round-2 Task 12 (defect #15): the Latest-weight pane at the top of the
// Weight section was deleted. renderWeightCurrentCard, classifyWeightTrend,
// WEIGHT_TREND_ARROWS, and formatWeightTimestamp went with it — the value
// surfaces on Today's weight tile, the chart below, and the history list.


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
    const preferredUnit = getPreferredWeightUnit();
    const goalDisplay = formatWeight(goalValue, preferredUnit);
    value.textContent = `${goalDisplay.value.toFixed(1)} ${goalDisplay.label}`;
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
            const diffDisplay = formatWeight(Math.abs(diff), preferredUnit);
            delta.textContent = `${sign}${diffDisplay.value.toFixed(1)} ${diffDisplay.label} to goal`;
        }
    }
    container.appendChild(delta);
}

// Linear regression on the last N logs (default 14). Returns a slope in
// kg/day. NaN/Infinity safe — returns null when there isn't enough data or
// when the regression denominator is zero (all timestamps equal). Consumers
// must guard against a null return.
function computeWeightTrendPerDay(logs, n) {
    if (!Array.isArray(logs) || logs.length === 0) return null;
    const cleaned = [];
    for (const l of logs) {
        if (!l || l.measured_at == null) continue;
        const t = new Date(l.measured_at).getTime();
        const w = Number(l.weight);
        if (!Number.isFinite(t) || !Number.isFinite(w)) continue;
        cleaned.push({ t, w });
    }
    if (cleaned.length < 2) return null;
    // Logs arrive newest-first from _renderWeightData. Sort ascending so the
    // regression runs over the chronological ordering the user expects.
    cleaned.sort((a, b) => a.t - b.t);
    const limit = Math.min(Number.isFinite(n) && n > 0 ? n : 14, cleaned.length);
    const slice = cleaned.slice(cleaned.length - limit);
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    const base = slice[0].t;
    for (const p of slice) {
        const x = (p.t - base) / 86400000;
        sumX += x;
        sumY += p.w;
        sumXY += x * p.w;
        sumXX += x * x;
    }
    const denom = slice.length * sumXX - sumX * sumX;
    if (denom === 0) return null;
    const slope = (slice.length * sumXY - sumX * sumY) / denom;
    return Number.isFinite(slope) ? slope : null;
}

// Render the chart legend — Actual / Plan / Goal swatches. Mirrors the design
// reference: shown only when the goal is set (otherwise Plan/Goal are
// meaningless and we hide the row entirely).
function renderWeightChartLegend(goalData) {
    const container = document.getElementById('weight-chart-legend');
    if (!container) return;
    const goalValue = goalData != null ? Number(goalData.goal) : NaN;
    if (!Number.isFinite(goalValue)) {
        container.hidden = true;
        container.replaceChildren();
        return;
    }
    container.hidden = false;
    container.replaceChildren();

    const goalDisplay = formatWeight(goalValue, getPreferredWeightUnit());
    const items = [
        { label: 'Actual', swatch: 'actual' },
        { label: 'Plan', swatch: 'plan' },
        { label: `Goal ${goalDisplay.value.toFixed(1)} ${goalDisplay.label}`, swatch: 'goal' },
    ];
    items.forEach((item) => {
        const li = document.createElement('span');
        li.className = 'wg-weight-chart-legend__item';
        const swatch = document.createElement('span');
        swatch.className = `wg-weight-chart-legend__swatch wg-weight-chart-legend__swatch--${item.swatch}`;
        li.appendChild(swatch);
        const label = document.createElement('span');
        label.className = 'wg-weight-chart-legend__label';
        label.textContent = item.label;
        li.appendChild(label);
        container.appendChild(li);
    });
}

// Render the goal-prognosis card — "days to goal" + weekly trend. Hidden
// when no goal is set. All numeric outputs guard against NaN/Infinity and
// fall back to "—" so users never see a literal "NaN" on screen.
function renderWeightPrognosisCard(logs, goalData) {
    const container = document.getElementById('weight-prognosis-card');
    if (!container) return;
    container.replaceChildren();

    const goalValue = goalData != null ? Number(goalData.goal) : NaN;
    if (!Number.isFinite(goalValue)) {
        container.hidden = true;
        return;
    }
    container.hidden = false;

    const list = Array.isArray(logs) ? logs : [];
    const currentRaw = list.length > 0 ? Number(list[0].weight) : NaN;
    const current = Number.isFinite(currentRaw) ? currentRaw : null;
    const slopePerDay = computeWeightTrendPerDay(list, 14);

    // Days-to-goal projection. We want the slope to point TOWARDS the goal
    // (losing when above, gaining when below). If the slope is flat, zero,
    // or NaN, or points away from the goal, we fall back to "—".
    let daysToGoal = Infinity;
    if (current != null && slopePerDay != null && slopePerDay !== 0) {
        const diff = goalValue - current;
        const projected = diff / slopePerDay;
        if (Number.isFinite(projected) && projected > 0) {
            daysToGoal = projected;
        }
    }

    const leftCol = document.createElement('div');
    leftCol.className = 'wg-weight-prognosis-card__col wg-weight-prognosis-card__col--days';
    const leftLabel = document.createElement('div');
    leftLabel.className = 'wg-weight-prognosis-card__label';
    leftLabel.textContent = 'Time to goal';
    leftCol.appendChild(leftLabel);
    const leftValue = document.createElement('div');
    leftValue.className = 'wg-weight-prognosis-card__value';
    if (current != null && Math.abs(current - goalValue) < 0.05) {
        leftValue.textContent = 'At goal';
    } else if (Number.isFinite(daysToGoal)) {
        const rounded = Math.round(daysToGoal);
        leftValue.textContent = `in ${rounded} day${rounded === 1 ? '' : 's'}`;
    } else {
        leftValue.textContent = '—';
    }
    leftCol.appendChild(leftValue);
    container.appendChild(leftCol);

    const rightCol = document.createElement('div');
    rightCol.className = 'wg-weight-prognosis-card__col wg-weight-prognosis-card__col--trend';
    const rightLabel = document.createElement('div');
    rightLabel.className = 'wg-weight-prognosis-card__label';
    rightLabel.textContent = 'Trend';
    rightCol.appendChild(rightLabel);
    const rightValue = document.createElement('div');
    const perWeek = slopePerDay != null ? slopePerDay * 7 : NaN;
    let variant = 'flat';
    if (Number.isFinite(perWeek) && Math.abs(perWeek) >= 0.05) {
        const goalDir = (goalData && typeof goalData.goal_direction === 'string')
            ? goalData.goal_direction.toLowerCase()
            : (current != null && current > goalValue ? 'lose' : 'gain');
        if (goalDir === 'lose') variant = perWeek < 0 ? 'good' : 'bad';
        else variant = perWeek > 0 ? 'good' : 'bad';
    }
    rightValue.className = `wg-weight-prognosis-card__trend-value wg-weight-prognosis-card__trend-value--${variant}`;
    if (Number.isFinite(perWeek)) {
        const sign = perWeek > 0 ? '+' : (perWeek < 0 ? '−' : '');
        const perWeekDisplay = formatWeight(Math.abs(perWeek), getPreferredWeightUnit());
        rightValue.textContent = `${sign}${perWeekDisplay.value.toFixed(1)} ${perWeekDisplay.label}/week`;
    } else {
        rightValue.textContent = '—';
    }
    rightCol.appendChild(rightValue);
    container.appendChild(rightCol);
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

    const list = Array.isArray(logs) ? logs : [];
    const current = buildWeightChartCurrentBadge(list);
    if (current) container.appendChild(current);

    if (!window.WGWeightChart || typeof window.WGWeightChart.render !== 'function') {
        const noDataSpan = document.createElement('span');
        noDataSpan.className = 'no-data-msg';
        noDataSpan.textContent = 'Chart unavailable';
        container.appendChild(noDataSpan);
        return;
    }

    const node = window.WGWeightChart.render({
        logs: list,
        range: activeRange,
        goal: goalData || null,
        unit: getPreferredWeightUnit(),
    });
    if (node) container.appendChild(node);
}

// Current-weight badge shown at the top of the chart panel. The old Latest
// pane above the chart was removed in Round-2 Task 12 (#15) — but the value
// is still useful to surface right where users scan for trend context, so
// we inline it inside the chart card instead of resurrecting the old pane.
// Returns null when no valid entry is available so the chart still works on
// an empty dataset.
function buildWeightChartCurrentBadge(logs) {
    if (!Array.isArray(logs) || logs.length === 0) return null;
    const top = logs[0];
    const weight = top ? Number(top.weight) : NaN;
    if (!Number.isFinite(weight)) return null;

    const wrap = document.createElement('div');
    wrap.className = 'wg-weight-chart-panel__current';

    const label = document.createElement('span');
    label.className = 'wg-weight-chart-panel__current-label';
    label.textContent = 'Current';
    wrap.appendChild(label);

    const display = formatWeight(weight, getPreferredWeightUnit());
    const value = document.createElement('span');
    value.className = 'wg-weight-chart-panel__current-value';
    value.textContent = display.value.toFixed(1);

    const unit = document.createElement('span');
    unit.className = 'wg-weight-chart-panel__current-unit';
    unit.textContent = display.label;
    value.appendChild(unit);

    wrap.appendChild(value);
    return wrap;
}



async function loadWeightLogs() {
    const list = document.getElementById('weight-list');
    // Mirrors loadBPReadings: when offline with no api_cache row, apiCall
    // returns null silently and the SWR fetcher resolves to null, so none of
    // onCached / onFresh / onError fire. Track whether any callback painted
    // the list and fall back to the explicit empty state below.
    let renderedSomething = false;
    await window.DataStore.loadSWR({
        key: 'weight',
        tags: ['weight'],
        fetcher: async () => {
            // days=0 disables the server's since filter; limit=1000 overrides
            // the 100-row default so the 90d / All range-selector options can
            // actually plot older history for long-term users.
            const [logsResult, goalResult] = await Promise.allSettled([
                apiCall('/api/weight?days=0&limit=1000'),
                apiCall('/api/weight/goal')
            ]);
            const logsRes = logsResult.status === 'fulfilled' ? logsResult.value : null;
            const goalRes = goalResult.status === 'fulfilled' ? goalResult.value : null;
            if (logsRes === null) return null;
            return { logsRes, goalRes };
        },
        onCached: async (cached) => {
            renderedSomething = true;
            await _renderWeightData(cached.logsRes, cached.goalRes);
            await renderWeightStaleBadge();
        },
        onFresh: async (fresh) => {
            renderedSomething = true;
            await _renderWeightData(fresh.logsRes, fresh.goalRes);
            await renderWeightStaleBadge();
        },
        onError: async (e, cached) => {
            console.error('Failed to load weight data:', e);
            if (cached) {
                renderedSomething = true;
            } else if (list) {
                renderedSomething = true;
                list.replaceChildren(createEmptyState('No cached data \u2014 will load when online'));
            }
            await renderWeightStaleBadge();
        }
    });
    if (!renderedSomething && list) {
        list.replaceChildren(createEmptyState('No cached data \u2014 will load when online'));
        await renderWeightStaleBadge();
    }
}

// Mounts the wg-stale-badge into the Weight section header from the
// api_cache 'weight' timestamp (warmed by /api/bootstrap and refreshed by
// loadWeightLogs). Tone flips to offline whenever navigator.onLine is false.
async function renderWeightStaleBadge() {
    const slot = document.getElementById('weight-stale-badge');
    if (!slot) return;
    const api = (typeof window !== 'undefined') ? window.WGStaleBadge : null;
    if (!api || typeof api.mountFromKey !== 'function') {
        slot.replaceChildren();
        slot.classList.add('hidden');
        return;
    }
    await api.mountFromKey({ slot, key: 'weight' });
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

    // Sort by measured_at DESC so downstream renderers (current card, seed
    // for new-entry modal) see a true newest-first order even when the user
    // backdates an offline entry. The history grouping re-sorts within days,
    // and the chart has its own filter, so their output is unaffected.
    allLogs.sort((a, b) => {
        const ta = new Date(a && a.measured_at).getTime();
        const tb = new Date(b && b.measured_at).getTime();
        const va = Number.isFinite(ta) ? ta : 0;
        const vb = Number.isFinite(tb) ? tb : 0;
        return vb - va;
    });

    cachedWeightLogs = allLogs;

    const goalData = goalRes || {};
    renderWeightGoalCard(allLogs, goalData);
    renderWeightRangeSelector({
        active: getActiveWeightRange(),
        onChange: (range) => {
            setActiveWeightRange(range);
            _renderWeightData(logsRes, goalRes);
        }
    });
    renderWeightChart(allLogs, goalData);
    renderWeightChartLegend(goalData);
    renderWeightPrognosisCard(allLogs, goalData);

    if (allLogs.length === 0 && logsRes === null) {
        list.replaceChildren(createEmptyState('No cached data \u2014 will load when online'));
        return;
    }

    renderWeightLogs(allLogs, getActiveWeightRange());
}

// Filter logs to entries inside the active range so the history list tracks
// the same window the chart shows. Anchor on Date.now() (not the newest
// log) so "7d" means "last 7 days from today" — matching the BP range
// selector's semantics and what a user expects from the label. 'all'
// returns unfiltered input.
const WEIGHT_RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

function filterWeightLogsByRange(logs, range) {
    if (!logs || logs.length === 0) return logs || [];
    if (!range || range === 'all') return logs;
    const days = WEIGHT_RANGE_DAYS[range];
    if (!days) return logs;
    // Cap upper bound at Date.now() so a mistyped future-dated entry does
    // not slip into "last N days" views. The chart filter applies the same
    // cap — keep the two in sync.
    const now = Date.now();
    const cutoff = now - days * 86400000;
    return logs.filter((l) => {
        const t = new Date(l && l.measured_at).getTime();
        return Number.isFinite(t) && t >= cutoff && t <= now;
    });
}

// Render weight logs grouped by day as Wandergeek gloss cards (Phase 6, Task 5).
// Mirrors renderBPReadings: each group is a .wg-weight-history__group <li>
// with a .wg-section-label header and a list of .wg-card rows. Offline +
// rejected states surface as .wg-tag--mono variants. Each row carries a
// trailing .wg-icon-btn cluster (edit + delete).
function renderWeightLogs(logs, range) {
    const list = document.getElementById('weight-list');
    if (!list) return;
    list.replaceChildren();
    list.classList.add('wg-weight-history');

    const filtered = filterWeightLogsByRange(logs || [], range);
    if (filtered.length === 0) {
        return;
    }

    // The server fetch (loadWeightLogs) caps at 1000 rows — that bound is the
    // only truncation; the history list shows every fetched entry so "All"
    // really means every fetched entry and older rows stay editable.
    const groups = groupWeightLogsByDay(filtered);
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
    const display = formatWeight(weightNum, getPreferredWeightUnit());
    weightSpan.textContent = Number.isFinite(display.value) ? display.value.toFixed(1) : '—';
    const unitSpan = document.createElement('span');
    unitSpan.className = 'wg-weight-history-row__unit';
    unitSpan.textContent = display.label;
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
    setWeightModalEyebrow('Edit entry');
    resetWeightUnitToggle();
    const valueInput = document.getElementById('weight-value');
    const dtInput = document.getElementById('weight-datetime');
    const notesInput = document.getElementById('weight-notes');
    const weightNum = Number(log.weight);
    if (valueInput && Number.isFinite(weightNum)) {
        // Stored weight is always kg; route through setWeightValue so the
        // displayed value is converted into the user's preferred unit when
        // the modal opens in lb.
        setWeightValue(weightNum);
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
        const localId = parseInt(id.replace('local_', ''), 10);
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
        if (window.DataStore.clearCached) {
            await window.DataStore.clearCached('weight');
        }
        // Also remove from local IndexedDB if it exists there
        if (window.MedTrackerDB) {
            try {
                // Find and delete the local record with this serverId
                const allLogs = await window.MedTrackerDB.WeightStore.getAll();
                const localRecord = allLogs.find(l => l.serverId === parseInt(id, 10));
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
