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

    container.replaceChildren(root);
}

window.WorkoutStats = {
    load: loadWorkoutStatsTab,
    getRange: getActiveWorkoutsStatsRange,
    setRange: setActiveWorkoutsStatsRange
};
