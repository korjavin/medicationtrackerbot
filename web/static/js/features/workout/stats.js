// ====================================
// WORKOUT STATS — sub-tab loader
// ====================================
//
// Stats sub-tab range selector state (Phase 7, Task 7). Persists the active
// range the same way `mt-bp-range` / `mt-weight-range` do, with the Workouts-
// specific storage key. Keeps the range CONSISTENT across tab switches and
// reloads.

const WORKOUTS_STATS_RANGE_KEY = 'mt-workouts-stats-range';
const WORKOUTS_STATS_RANGE_OPTIONS = ['7d', '30d', '90d', 'all'];
const WORKOUTS_STATS_RANGE_DEFAULT = 'all';

function getActiveWorkoutsStatsRange() {
    try {
        const raw = window.localStorage.getItem(WORKOUTS_STATS_RANGE_KEY);
        if (WORKOUTS_STATS_RANGE_OPTIONS.indexOf(raw) !== -1) return raw;
    } catch (_) { /* ignore */ }
    return WORKOUTS_STATS_RANGE_DEFAULT;
}

function setActiveWorkoutsStatsRange(range) {
    if (WORKOUTS_STATS_RANGE_OPTIONS.indexOf(range) === -1) return;
    try { window.localStorage.setItem(WORKOUTS_STATS_RANGE_KEY, range); } catch (_) { /* ignore */ }
}

// Body-part split (med-s5m.3). Match logged exercise names against the vendored
// static catalog (med-s5m.1) to derive a body_part label at read time — no
// migration, no stored column. Matching is client-side, so in cloud mode the
// decrypted names never leave the browser. The 913 KB asset is fetched once,
// lazily; a failed fetch is silent (no split shown) and retried next render.
let _exerciseBodyPartMapPromise = null; // module-state: single-flight cache for the catalog name->body_part map (med-s5m.3)
function _loadExerciseBodyPartMap() {
    if (!_exerciseBodyPartMapPromise) {
        _exerciseBodyPartMapPromise = fetch('/static/data/exercises-catalog.json')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('catalog ' + r.status))))
            .then((cat) => {
                const map = new Map();
                for (const e of (cat.exercises || [])) {
                    const key = String(e.name || '').toLowerCase().trim();
                    if (key && e.body_part) map.set(key, e.body_part);
                }
                return map;
            })
            .catch((err) => {
                console.error('Error loading exercise catalog:', err);
                _exerciseBodyPartMapPromise = null; // allow a later retry
                return new Map();
            });
    }
    return _exerciseBodyPartMapPromise;
}

// Aggregate a top-exercises list into a body-part distribution by session_count
// (training frequency reads better than tonnage, and stays non-zero for
// bodyweight moves). Unmatched names bucket as 'uncategorized'.
//
// ponytail: coverage is bounded by the source list — top_exercises is the
// top 8 by volume, weight-bearing only (ListExerciseStats / web/domain
// getStats). Bodyweight-heavy training is under-counted here. Upgrade path when
// it matters: aggregate over ALL logged exercises for the period instead of the
// top-8 volume slice. Matches the CEILING in bead med-s5m.3.
function _computeBodyPartSplit(topExercises, bodyPartMap) {
    const totals = new Map();
    for (const ex of (topExercises || [])) {
        const key = String(ex.exercise_name || '').toLowerCase().trim();
        const bp = bodyPartMap.get(key) || 'uncategorized';
        const count = ex.session_count || 0;
        totals.set(bp, (totals.get(bp) || 0) + count);
    }
    return Array.from(totals.entries())
        .filter(([, count]) => count > 0)
        .map(([body_part, count]) => ({ body_part, count }))
        .sort((a, b) => b.count - a.count);
}

const _BODY_PART_LABELS = {
    'upper legs': 'Upper legs', 'lower legs': 'Lower legs', 'upper arms': 'Upper arms',
    'lower arms': 'Lower arms', 'back': 'Back', 'chest': 'Chest', 'shoulders': 'Shoulders',
    'waist': 'Waist', 'neck': 'Neck', 'cardio': 'Cardio', 'uncategorized': 'Uncategorized'
};
function _bodyPartLabel(bp) {
    return _BODY_PART_LABELS[bp] || (bp.charAt(0).toUpperCase() + bp.slice(1));
}

// Append the body-part split section to an already-built stats root. Async
// because it awaits the catalog; fire-and-forget from _renderWorkoutStats.
async function _renderBodyPartSplit(root, topExercises) {
    if (!topExercises || topExercises.length === 0) return;
    const map = await _loadExerciseBodyPartMap();
    if (map.size === 0) return; // catalog unavailable — skip rather than show an all-uncategorized split
    const split = _computeBodyPartSplit(topExercises, map);
    if (split.length === 0) return;

    const heading = document.createElement('div');
    heading.className = 'wg-section-label wg-workouts-stats__section-label';
    heading.textContent = 'Body-part Split · Sessions';
    root.appendChild(heading);

    const maxCount = split[0].count || 1;
    const list = document.createElement('ul');
    list.className = 'wg-workouts-stats__top-exercises wg-workouts-stats__body-split';

    split.forEach(({ body_part, count }) => {
        const pct = maxCount > 0 ? (count / maxCount * 100).toFixed(1) : 0;
        const row = document.createElement('li');
        row.className = 'wg-card wg-workouts-stats__top-row';

        const head = document.createElement('div');
        head.className = 'wg-workouts-stats__top-row-head';

        const name = document.createElement('span');
        name.className = 'wg-workouts-stats__top-row-name';
        name.textContent = _bodyPartLabel(body_part);

        const value = document.createElement('span');
        value.className = 'wg-workouts-stats__top-row-volume';
        value.textContent = count === 1 ? '1 session' : `${count} sessions`;

        head.appendChild(name);
        head.appendChild(value);

        const bar = document.createElement('div');
        bar.className = 'wg-workouts-stats__top-row-bar';
        const fill = document.createElement('div');
        fill.className = 'wg-workouts-stats__top-row-bar-fill';
        fill.style.setProperty('--fill-pct', `${pct}%`);
        bar.appendChild(fill);

        row.appendChild(head);
        row.appendChild(bar);
        list.appendChild(row);
    });

    root.appendChild(list);
}

async function loadWorkoutStatsTab() {
    const container = document.getElementById('workout-stats-display');
    await window.DataStore.loadSWR({
        key: 'workout_stats',
        tags: ['workout'],
        // apiCallDirect throws on offline/5xx so a post-mutation refresh
        // failure routes through onError. The legacy apiCall path returned
        // null on offline; with no `allowNullFresh` and no cached value
        // (just cleared by invalidateWorkoutCache), loadSWR would skip
        // BOTH onFresh and onError, leaving the previously-rendered stats
        // DOM visible after a successful save followed by a failed refresh.
        fetcher: async () => {
            if (!window.apiCallDirect) throw new Error('apiCallDirect not available');
            return await window.apiCallDirect('/api/workout/stats');
        },
        onCached: async (cached) => {
            _renderWorkoutStats(container, cached);
        },
        onFresh: async (stats) => {
            _renderWorkoutStats(container, stats);
        },
        onError: async (error, cached) => {
            console.error('Error loading stats:', error);
            if (!cached) {
                const message = document.createElement('p');
                message.className = 'text-hint';
                message.textContent = 'No cached data — will load when online';
                container.replaceChildren(message);
            }
        }
    });
}

function _renderWorkoutStats(container, stats) {
    if (!stats) {
        const empty = document.createElement('p');
        empty.className = 'text-center text-hint wg-workouts-stats__empty';
        empty.textContent = 'No statistics available yet';
        container.replaceChildren(empty);
        return;
    }

    const formatVolume = (kg) => {
        if (!kg || kg === 0) return '—';
        if (kg >= 1000) return `${(kg / 1000).toFixed(1)}t`;
        return `${Math.round(kg).toLocaleString()} kg`;
    };

    const root = document.createElement('div');
    root.className = 'wg-workouts-stats';

    // Range selector — gloss-inset strip with four pills; active state via
    // `.wg-gloss--sun`. Clicking a button persists the range and re-renders
    // the chart in place without re-fetching.
    const activeRange = getActiveWorkoutsStatsRange();
    const rangeStrip = document.createElement('div');
    rangeStrip.className = 'wg-gloss--inset wg-workouts-stats__range';
    rangeStrip.setAttribute('role', 'tablist');
    const rangeLabels = { '7d': '7d', '30d': '30d', '90d': '90d', 'all': 'All' };
    const rangeButtons = new Map();
    WORKOUTS_STATS_RANGE_OPTIONS.forEach((range) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-gloss wg-workouts-stats__range-btn';
        btn.dataset.range = range;
        btn.textContent = rangeLabels[range];
        if (range === activeRange) {
            btn.classList.add('wg-gloss--sun', 'wg-workouts-stats__range-btn--active');
            btn.setAttribute('aria-pressed', 'true');
        } else {
            btn.setAttribute('aria-pressed', 'false');
        }
        btn.addEventListener('click', () => {
            setActiveWorkoutsStatsRange(range);
            rangeButtons.forEach((b, key) => {
                const isActive = key === range;
                b.classList.toggle('wg-gloss--sun', isActive);
                b.classList.toggle('wg-workouts-stats__range-btn--active', isActive);
                b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
            });
            renderChartInto(range);
        });
        rangeButtons.set(range, btn);
        rangeStrip.appendChild(btn);
    });
    root.appendChild(rangeStrip);

    // Chart panel — WGWorkoutChart renders either an <svg> or an empty-state
    // <div>; either way it carries `.wg-workout-chart` so the panel styles
    // itself consistently.
    const chartPanel = document.createElement('div');
    chartPanel.className = 'wg-workouts-stats__chart-panel';
    const renderChartInto = (range) => {
        chartPanel.replaceChildren();
        const sessions = Array.isArray(stats.weekly_activity) ? stats.weekly_activity : [];
        const node = window.WGWorkoutChart && typeof window.WGWorkoutChart.render === 'function'
            ? window.WGWorkoutChart.render({ sessions, range })
            : null;
        if (node) {
            chartPanel.appendChild(node);
        } else {
            const empty = document.createElement('div');
            empty.className = 'wg-workout-chart wg-workout-chart--empty';
            const msg = document.createElement('span');
            msg.className = 'wg-workout-chart__empty-msg';
            msg.textContent = 'No workout sessions yet';
            empty.appendChild(msg);
            chartPanel.appendChild(empty);
        }
    };
    renderChartInto(activeRange);
    root.appendChild(chartPanel);

    // Round-2, Task 6 — single-series chart legend. Documents which metric
    // the trend line represents ("Sessions · per week") so the chart reads
    // without a separate caption. Mirrors the axis-tick work in
    // wg-workout-chart.js and keeps the swatch + label outside the SVG so
    // we don't over-complicate the chart component.
    const legend = document.createElement('div');
    legend.className = 'wg-workouts-stats__legend';
    legend.setAttribute('role', 'list');
    const legendChip = document.createElement('span');
    legendChip.className = 'wg-workouts-stats__legend-chip';
    legendChip.setAttribute('role', 'listitem');
    legendChip.dataset.series = 'sessions';
    const swatch = document.createElement('span');
    swatch.className = 'wg-workouts-stats__legend-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    const legendLabel = document.createElement('span');
    legendLabel.className = 'wg-workouts-stats__legend-label';
    legendLabel.textContent = 'Sessions · per week';
    legendChip.appendChild(swatch);
    legendChip.appendChild(legendLabel);
    legend.appendChild(legendChip);
    root.appendChild(legend);

    // Stat tiles — 2×2 `.wg-card` grid. Labels mirror the existing API
    // semantics: Active Weeks / 30-Day Sessions / Done / Skipped.
    const tiles = document.createElement('div');
    tiles.className = 'wg-workouts-stats__tiles';
    const buildTile = (valueText, labelText) => {
        const card = document.createElement('div');
        card.className = 'wg-card wg-workouts-stats__tile';

        const value = document.createElement('div');
        value.className = 'wg-workouts-stats__tile-value wg-mono-display';
        value.textContent = valueText;

        const label = document.createElement('div');
        label.className = 'wg-workouts-stats__tile-label';
        label.textContent = labelText;

        card.appendChild(value);
        card.appendChild(label);
        return card;
    };

    tiles.appendChild(buildTile(String(stats.active_weeks || 0), 'Active Weeks'));
    tiles.appendChild(buildTile(String(stats.total_sessions || 0), '30-Day Sessions'));
    tiles.appendChild(buildTile(String(stats.completed_sessions || 0), 'Done'));
    tiles.appendChild(buildTile(String(stats.skipped_sessions || 0), 'Skipped'));
    root.appendChild(tiles);

    // Top Exercises — optional. `.wg-section-label` heading, then a list of
    // `.wg-card` rows each carrying a mono name, volume summary, and a
    // sun-coloured fill bar.
    if (stats.top_exercises && stats.top_exercises.length > 0) {
        const heading = document.createElement('div');
        heading.className = 'wg-section-label wg-workouts-stats__section-label';
        heading.textContent = 'Top Exercises · Volume';
        root.appendChild(heading);

        const maxVol = stats.top_exercises[0].total_volume_kg || 1;
        const list = document.createElement('ul');
        list.className = 'wg-workouts-stats__top-exercises';

        stats.top_exercises.forEach((ex) => {
            const pct = maxVol > 0 ? (ex.total_volume_kg / maxVol * 100).toFixed(1) : 0;
            const maxW = ex.max_weight_kg > 0 ? `${ex.max_weight_kg} kg max` : '';

            const row = document.createElement('li');
            row.className = 'wg-card wg-workouts-stats__top-row';

            const head = document.createElement('div');
            head.className = 'wg-workouts-stats__top-row-head';

            const name = document.createElement('span');
            name.className = 'wg-workouts-stats__top-row-name';
            name.textContent = ex.exercise_name;

            const volume = document.createElement('span');
            volume.className = 'wg-workouts-stats__top-row-volume';
            volume.textContent = `${formatVolume(ex.total_volume_kg)}${maxW ? ` · ${maxW}` : ''}`;

            head.appendChild(name);
            head.appendChild(volume);

            const bar = document.createElement('div');
            bar.className = 'wg-workouts-stats__top-row-bar';
            const fill = document.createElement('div');
            fill.className = 'wg-workouts-stats__top-row-bar-fill';
            fill.style.setProperty('--fill-pct', `${pct}%`);
            bar.appendChild(fill);

            row.appendChild(head);
            row.appendChild(bar);
            list.appendChild(row);
        });

        root.appendChild(list);
    }

    // Body-part split (med-s5m.3) — appended asynchronously once the static
    // catalog resolves; root is already mounted by then.
    _renderBodyPartSplit(root, stats.top_exercises);

    container.replaceChildren(root);
}

window.WorkoutStats = {
    load: loadWorkoutStatsTab,
    getRange: getActiveWorkoutsStatsRange,
    setRange: setActiveWorkoutsStatsRange
};
