// ====================================
// WORKOUT STATS — sub-tab loader
// ====================================
//
// Stats sub-tab range selector state (Phase 7, Task 7). Persists the active
// range the same way `mt-bp-range` / `mt-weight-range` do, with the Workouts-
// specific storage key. Keeps the range CONSISTENT across tab switches and
// reloads.
//
// med-904.2 adds a second strip above it: a VIEW toggle over three mental
// models of the same payload — consistency ("did I show up"), load ("how much
// work did I do"), balance ("what am I neglecting"). One /api/workout/stats
// fetch feeds all three (med-904.1 widened the payload), so switching views is
// a client-side re-render and never a refetch; only the range strip fetches.
//
// med-zte swapped the marks inside two of those views: consistency draws a
// GitHub-contribution day calendar instead of a sessions-per-week line, and
// load draws bars instead of a line. Still three pills, still one fetch.

const WORKOUTS_STATS_RANGE_KEY = 'mt-workouts-stats-range';
const WORKOUTS_STATS_RANGE_OPTIONS = ['7d', '30d', '90d', 'all'];
const WORKOUTS_STATS_RANGE_DEFAULT = 'all';

const WORKOUTS_STATS_VIEW_KEY = 'mt-workouts-stats-view';
const WORKOUTS_STATS_VIEW_OPTIONS = ['consistency', 'load', 'balance'];
const WORKOUTS_STATS_VIEW_DEFAULT = 'consistency';

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

function getActiveWorkoutsStatsView() {
    try {
        const raw = window.localStorage.getItem(WORKOUTS_STATS_VIEW_KEY);
        if (WORKOUTS_STATS_VIEW_OPTIONS.indexOf(raw) !== -1) return raw;
    } catch (_) { /* ignore */ }
    return WORKOUTS_STATS_VIEW_DEFAULT;
}

function setActiveWorkoutsStatsView(view) {
    if (WORKOUTS_STATS_VIEW_OPTIONS.indexOf(view) === -1) return;
    try { window.localStorage.setItem(WORKOUTS_STATS_VIEW_KEY, view); } catch (_) { /* ignore */ }
}

function _formatVolume(kg) {
    if (!kg || kg === 0) return '—';
    if (kg >= 1000) return `${(kg / 1000).toFixed(1)}t`;
    return `${Math.round(kg).toLocaleString()} kg`;
}

// Balance view fold: per-body-part WORKING SETS (Hevy's "set count per muscle
// group" — the volume unit the training-science literature prescribes against),
// over every exercise trained in the range.
function _computeBodyPartSets(exerciseTotals, resolveFn) {
    const totals = new Map();
    for (const ex of (exerciseTotals || [])) {
        const bp = resolveFn(ex.exercise_name) || 'uncategorized';
        totals.set(bp, (totals.get(bp) || 0) + (ex.sets || 0));
    }
    return Array.from(totals.entries())
        .filter(([, sets]) => sets > 0)
        .map(([body_part, sets]) => ({ body_part, sets }))
        .sort((a, b) => b.sets - a.sets);
}

function _bodyPartLabel(bodyPart) {
    return window.WorkoutExerciseCatalog.friendlyBodyPart(bodyPart)
        || (bodyPart.charAt(0).toUpperCase() + bodyPart.slice(1));
}

// -- Shared DOM recipes ---------------------------------------------------

function _buildStatTile(valueText, labelText) {
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
}

function _buildTileGrid(pairs) {
    const tiles = document.createElement('div');
    tiles.className = 'wg-workouts-stats__tiles';
    pairs.forEach(([value, label]) => tiles.appendChild(_buildStatTile(value, label)));
    return tiles;
}

// WGWorkoutChart renders either an <svg> or an empty-state <div>; either way it
// carries `.wg-workout-chart` so the panel styles itself consistently.
function _buildChartPanel({ sessions, range, metric, variant }) {
    const chartPanel = document.createElement('div');
    chartPanel.className = 'wg-workouts-stats__chart-panel';
    const node = window.WGWorkoutChart && typeof window.WGWorkoutChart.render === 'function'
        ? window.WGWorkoutChart.render({ sessions, range, metric, variant })
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
    return chartPanel;
}

// Round-2, Task 6 — single-series chart legend. Documents which metric the
// trend line represents ("Sessions · per week") so the chart reads without a
// separate caption. The swatch + label stay outside the SVG so we don't
// over-complicate the chart component.
function _buildLegend(series, labelText) {
    const legend = document.createElement('div');
    legend.className = 'wg-workouts-stats__legend';
    legend.setAttribute('role', 'list');
    const legendChip = document.createElement('span');
    legendChip.className = 'wg-workouts-stats__legend-chip';
    legendChip.setAttribute('role', 'listitem');
    legendChip.dataset.series = series;
    const swatch = document.createElement('span');
    swatch.className = 'wg-workouts-stats__legend-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    const legendLabel = document.createElement('span');
    legendLabel.className = 'wg-workouts-stats__legend-label';
    legendLabel.textContent = labelText;
    legendChip.appendChild(swatch);
    legendChip.appendChild(legendLabel);
    legend.appendChild(legendChip);
    return legend;
}

function _buildSectionLabel(text) {
    const heading = document.createElement('div');
    heading.className = 'wg-section-label wg-workouts-stats__section-label';
    heading.textContent = text;
    return heading;
}

// One `.wg-card` row: mono name, right-aligned summary, sun fill bar. `--fill-pct`
// is a token, not a colour — the one sanctioned inline `.style` in this file.
function _buildBarRow({ name, summary, pct, onOpen }) {
    const row = document.createElement('li');
    row.className = 'wg-card wg-workouts-stats__top-row';
    if (onOpen) {
        row.classList.add('wg-workouts-stats__top-row--tappable');
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.addEventListener('click', onOpen);
        row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
        });
    }

    const head = document.createElement('div');
    head.className = 'wg-workouts-stats__top-row-head';

    const nameEl = document.createElement('span');
    nameEl.className = 'wg-workouts-stats__top-row-name';
    nameEl.textContent = name;

    const summaryEl = document.createElement('span');
    summaryEl.className = 'wg-workouts-stats__top-row-volume';
    summaryEl.textContent = summary;

    head.appendChild(nameEl);
    head.appendChild(summaryEl);

    const bar = document.createElement('div');
    bar.className = 'wg-workouts-stats__top-row-bar';
    const fill = document.createElement('div');
    fill.className = 'wg-workouts-stats__top-row-bar-fill';
    fill.style.setProperty('--fill-pct', `${pct}%`);
    bar.appendChild(fill);

    row.appendChild(head);
    row.appendChild(bar);
    return row;
}

// -- Consistency calendar (med-zte) ---------------------------------------
//
// GitHub-contribution-style day grid: 7 rows (Mon…Sun) × N week columns,
// oldest week leftmost, one cell per day of the ACTIVE range. It replaces the
// sessions-per-week line — a 2-vs-3 line is jagged noise, and the grid
// strictly contains the line's information (per-week totals are just a column
// read vertically) plus which days you trained.
//
// ponytail: hard cap of 53 week columns (~1 year). `range=all` on a multi-year
// history would otherwise emit thousands of cells for a strip nobody can read
// on a phone; widen (or add horizontal paging) only if someone asks for a
// multi-year wall.
const CALENDAR_MAX_WEEKS = 53;
const CALENDAR_RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };
// One initial per row, no month labels. GitHub labels Mon/Wed/Fri only and
// lets the reader interpolate, which works on a desktop-width wall; on a phone
// strip the four blank rows just read as anonymous. Single letters cost the
// same column width as "Mon" and leave no row unlabelled.
const CALENDAR_WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_MS = 86400000;

// Days since the Monday of this day's week (UTC-anchored; getUTCDay 0 = Sun).
function _sinceMonday(ms) {
    return (new Date(ms).getUTCDay() + 6) % 7;
}

function _buildActivityCalendar(daily, range) {
    const entries = new Map((daily || []).map((d) => [d.date, d]));

    // Anchor "today" as a UTC midnight built from the LOCAL calendar day, so
    // every step below is plain ms arithmetic that can't drift a timezone.
    const local = new Date();
    const todayMs = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
    // Grid ends on the Sunday of the current week so the last column is whole.
    const endMs = todayMs + (6 - _sinceMonday(todayMs)) * DAY_MS;

    const days = CALENDAR_RANGE_DAYS[range];
    const oldest = daily && daily.length
        ? Date.parse(`${daily[0].date}T00:00:00Z`)
        : todayMs;
    const firstDay = days
        ? todayMs - (days - 1) * DAY_MS
        : Math.min(Number.isFinite(oldest) ? oldest : todayMs, todayMs);
    let startMs = firstDay - _sinceMonday(firstDay) * DAY_MS;
    const capStart = endMs - (CALENDAR_MAX_WEEKS * 7 - 1) * DAY_MS;
    if (startMs < capStart) startMs = capStart;
    // startMs is a Monday and endMs a Sunday, so the inclusive span is always a
    // whole number of weeks.
    const weekCount = Math.round(((endMs - startMs) / DAY_MS + 1) / 7);

    const wrap = document.createElement('div');
    wrap.className = 'wg-workouts-stats__calendar';

    const weekdays = document.createElement('div');
    weekdays.className = 'wg-workouts-stats__calendar-weekdays';
    weekdays.setAttribute('aria-hidden', 'true');
    CALENDAR_WEEKDAYS.forEach((text) => {
        const label = document.createElement('span');
        label.className = 'wg-workouts-stats__calendar-weekday';
        label.textContent = text;
        weekdays.appendChild(label);
    });
    wrap.appendChild(weekdays);

    const grid = document.createElement('div');
    grid.className = 'wg-workouts-stats__calendar-grid';
    grid.dataset.range = range || 'all';
    grid.dataset.weeks = String(weekCount);
    // Cell size is fluid (the grid divides the card's width by the column
    // count); the stylesheet needs the count to cap that growth. Deliberately
    // NOT `--wg-`-prefixed: that namespace is design tokens, which
    // architecture.design-tokens.test.js keeps CSS-only. This is a per-render
    // structural integer, so it follows `--fill-pct` / `--ring-progress` and
    // goes out unprefixed through the sanctioned `setProperty` hatch.
    grid.style.setProperty('--calendar-weeks', String(weekCount));

    // Cells stream in chronological order; the grid flows column-first over 7
    // rows, so each column is one Mon→Sun week.
    let trainedDays = 0;
    let skippedDays = 0;
    for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
        const date = new Date(ms).toISOString().slice(0, 10);
        const entry = entries.get(date);
        // Shade by STATUS, never volume: a bodyweight session logs zero
        // tonnage and would render as a rest day on a volume-shaded grid.
        let state = 'empty';
        let what = 'nothing logged';
        if (entry && entry.completed > 0) {
            state = 'done';
            what = entry.completed === 1 ? 'completed' : `${entry.completed} completed`;
            trainedDays++;
        } else if (entry && entry.skipped > 0) {
            state = 'skipped';
            what = entry.skipped === 1 ? 'skipped' : `${entry.skipped} skipped`;
            skippedDays++;
        }
        const cell = document.createElement('div');
        cell.className = `wg-workouts-stats__calendar-cell wg-workouts-stats__calendar-cell--${state}`;
        // Days past today pad the final column to a full week; they aren't a
        // rest day yet, so they get no label.
        if (ms <= todayMs) cell.title = `${date} · ${what}`;
        grid.appendChild(cell);
    }

    // The per-cell titles are tooltips, not an accessible name — screen
    // readers get one summary off the grid itself.
    grid.setAttribute('role', 'img');
    grid.setAttribute('aria-label',
        `Workout calendar, last ${weekCount} weeks: ${trainedDays} ${trainedDays === 1 ? 'day' : 'days'} trained, ${skippedDays} skipped.`);

    wrap.appendChild(grid);
    return wrap;
}

function _buildHint(text) {
    const p = document.createElement('p');
    p.className = 'text-center text-hint wg-workouts-stats__empty';
    p.textContent = text;
    return p;
}

// Top Exercises — `.wg-section-label` heading, then a list of `.wg-card` rows
// each carrying a mono name, volume summary, and a sun-coloured fill bar.
// Tapping a row opens the per-exercise detail view (records + est-1RM /
// top-weight graphs, Phase 3 epic med-qj4).
function _appendTopExercises(section, exercises) {
    if (!exercises || exercises.length === 0) return;
    section.appendChild(_buildSectionLabel('Top Exercises · Volume'));

    const maxVol = exercises[0].total_volume_kg || 1;
    const list = document.createElement('ul');
    list.className = 'wg-workouts-stats__top-exercises';

    exercises.forEach((ex) => {
        const pct = maxVol > 0 ? (ex.total_volume_kg / maxVol * 100).toFixed(1) : 0;
        const maxW = ex.max_weight_kg > 0 ? `${ex.max_weight_kg} kg max` : '';
        list.appendChild(_buildBarRow({
            name: ex.exercise_name,
            summary: `${_formatVolume(ex.total_volume_kg)}${maxW ? ` · ${maxW}` : ''}`,
            pct,
            onOpen: () => {
                if (window.WorkoutExerciseDetail && typeof window.WorkoutExerciseDetail.open === 'function') {
                    window.WorkoutExerciseDetail.open(ex.exercise_name);
                }
            },
        }));
    });

    section.appendChild(list);
}

// -- The three views ------------------------------------------------------

// 1. Consistency — "did I show up". med-zte swapped the sessions-per-week line
// for the day calendar above; the tiles and Top Exercises are unchanged. The
// body-part split moved out entirely — the Balance view owns it now, and
// rendering it in both was leftover duplication.
function _renderConsistencyView(section, stats, range) {
    section.appendChild(_buildActivityCalendar(stats.daily_activity, range));

    // Every tile except Streak is scoped to the active range (the domain
    // computes them from the `range` query param); Streak is whole-history by
    // design — consecutive weeks holding ≥1 completed session, so one skipped
    // workout inside a trained week doesn't break it.
    section.appendChild(_buildTileGrid([
        [`${stats.current_streak_weeks || 0} wk`, 'Streak'],
        [String(stats.total_sessions || 0), 'Sessions'],
        [`${Math.round(stats.completion_rate || 0)}%`, 'Done'],
        [String(stats.skipped_sessions || 0), 'Skipped'],
    ]));

    _appendTopExercises(section, stats.top_exercises);
}

// 2. Load — "how much work did I do". Volume load = sets × reps × weight, the
// cross-app table stake (Hevy/JEFIT/Alpha Progression all lead with it).
function _renderLoadView(section, stats, range) {
    const totals = stats.totals || {};
    const easySets = totals.easy_sets || 0;
    // Guard on "did you log any working set at all", not on hard_sets alone —
    // since med-vov a range of rated-but-easy sets has hard_sets 0, and telling
    // that user "no logged sets" would be a lie about work they did log.
    if (!totals.hard_sets && !easySets) {
        section.appendChild(_buildHint('No logged sets in this range'));
        return;
    }

    const weekly = Array.isArray(stats.weekly_volume) ? stats.weekly_volume : [];
    // WGWorkoutChart's `volume` metric reads `volume` / `total_volume_kg` off
    // each entry, so map the payload's `volume_kg` onto that rather than
    // teaching the chart a fourth field name. Bars, not a line (med-zte):
    // weekly tonnage is a set of discrete buckets, and a spline through them
    // implies a continuous quantity that was never measured between Mondays.
    section.appendChild(_buildChartPanel({
        sessions: weekly.map((w) => ({ week: w.week, volume: w.volume_kg })),
        range,
        metric: 'volume',
        variant: 'bars',
    }));
    section.appendChild(_buildLegend('volume', 'Volume · per week'));

    section.appendChild(_buildTileGrid([
        [_formatVolume(totals.volume_kg), 'Volume'],
        // A hard set is one taken near failure (RPE ≥ 6); an unrated set counts
        // as hard. The excluded rated-easy sets ride in the tile's own label
        // rather than silently vanishing from a number users already saw.
        [String(totals.hard_sets || 0), easySets ? `Hard sets · ${easySets} easy` : 'Hard sets'],
        [String(totals.reps || 0), 'Reps'],
        [String(totals.pr_count || 0), 'PRs'],
    ]));

    // exercise_totals carries the same per-exercise rows with warm-ups excluded
    // and per-set weights honoured, so the list adds up to the Volume tile above
    // it. top_exercises is its top-8 slice since med-7pq (before that it carried
    // the inflated derived-scalar math), so the fallback path only differs for a
    // payload cached before med-904.1.
    _appendTopExercises(section, (stats.exercise_totals || stats.top_exercises || []).slice(0, 8));
}

// 3. Balance — "what am I neglecting". Sets per body part plus, crucially, the
// body parts with ZERO sets in the range (JEFIT's BodyMap framing: absence is
// the insight nobody else surfaces).
async function _renderBalanceView(section, stats) {
    const exercises = stats.exercise_totals || [];
    if (exercises.length === 0) {
        section.appendChild(_buildHint('No exercises logged in this range'));
        return;
    }

    const map = await window.WorkoutExerciseCatalog.load();
    if (map.size === 0) {
        // Same skip-rather-than-mislead posture as the consistency split: with
        // no catalog every exercise would resolve to 'uncategorized'.
        section.appendChild(_buildHint('Body-part catalog unavailable'));
        return;
    }

    const split = _computeBodyPartSets(exercises, window.WorkoutExerciseCatalog.resolveBodyPart);
    const totalSets = split.reduce((sum, s) => sum + s.sets, 0);
    if (totalSets === 0) {
        section.appendChild(_buildHint('No logged sets in this range'));
        return;
    }

    section.appendChild(_buildSectionLabel('Sets per Body Part'));
    const maxSets = split[0].sets || 1;
    const list = document.createElement('ul');
    list.className = 'wg-workouts-stats__top-exercises wg-workouts-stats__body-split';
    split.forEach(({ body_part, sets }) => {
        const share = Math.round(sets / totalSets * 100);
        list.appendChild(_buildBarRow({
            name: _bodyPartLabel(body_part),
            summary: `${sets} ${sets === 1 ? 'set' : 'sets'} · ${share}%`,
            pct: (sets / maxSets * 100).toFixed(1),
        }));
    });
    section.appendChild(list);

    // Every body part the catalog knows about, minus the ones trained.
    const trained = new Set(split.map((s) => s.body_part));
    const untrained = [...new Set(map.values())]
        .filter((bp) => !trained.has(bp))
        .map(_bodyPartLabel)
        .sort();
    if (untrained.length === 0) return;

    section.appendChild(_buildSectionLabel('Not Trained'));
    const chips = document.createElement('div');
    chips.className = 'wg-workouts-stats__untrained';
    untrained.forEach((label) => {
        const chip = document.createElement('span');
        chip.className = 'wg-workouts-stats__untrained-chip';
        chip.textContent = label;
        chips.appendChild(chip);
    });
    section.appendChild(chips);
}

// -- Loader + shell -------------------------------------------------------

async function loadWorkoutStatsTab() {
    const container = document.getElementById('workout-stats-display');
    const range = getActiveWorkoutsStatsRange();
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
            return await window.apiCallDirect(`/api/workout/stats?range=${encodeURIComponent(range)}`);
        },
        onCached: async (cached) => {
            // One cache key holds whichever range was fetched last. Painting a
            // different range's numbers under freshly-switched pills reads as a
            // bug, so skip the cached paint and wait for the fetch (local-first:
            // it resolves in ms).
            if (cached && cached.range && cached.range !== range) return;
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

// Build one `.wg-gloss--inset` segmented strip. Active pill = `.wg-gloss--sun`
// + aria-pressed; `onPick` fires after the active class has moved.
function _buildSegmentedStrip({ block, options, labels, active, onPick }) {
    const strip = document.createElement('div');
    strip.className = `wg-gloss--inset wg-workouts-stats__${block}`;
    strip.setAttribute('role', 'tablist');
    const buttons = new Map();
    options.forEach((value) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `wg-gloss wg-workouts-stats__${block}-btn`;
        btn.dataset[block] = value;
        btn.textContent = labels[value];
        const isActive = value === active;
        btn.classList.toggle('wg-gloss--sun', isActive);
        btn.classList.toggle(`wg-workouts-stats__${block}-btn--active`, isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        btn.addEventListener('click', () => {
            buttons.forEach((b, key) => {
                const on = key === value;
                b.classList.toggle('wg-gloss--sun', on);
                b.classList.toggle(`wg-workouts-stats__${block}-btn--active`, on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            onPick(value);
        });
        buttons.set(value, btn);
        strip.appendChild(btn);
    });
    return strip;
}

function _renderWorkoutStats(container, stats) {
    if (!stats) {
        const empty = document.createElement('p');
        empty.className = 'text-center text-hint wg-workouts-stats__empty';
        empty.textContent = 'No statistics available yet';
        container.replaceChildren(empty);
        return;
    }

    const root = document.createElement('div');
    root.className = 'wg-workouts-stats';

    let activeRange = getActiveWorkoutsStatsRange();
    let activeView = getActiveWorkoutsStatsView();

    // Each render swaps in a FRESH section element, so an async body-part
    // append from the view we just left cannot land in the live one.
    let section = document.createElement('div');
    const renderView = () => {
        const next = document.createElement('div');
        next.className = 'wg-workouts-stats__view-body';
        if (activeView === 'load') _renderLoadView(next, stats, activeRange);
        else if (activeView === 'balance') _renderBalanceView(next, stats);
        else _renderConsistencyView(next, stats, activeRange);
        root.replaceChild(next, section);
        section = next;
    };

    root.appendChild(_buildSegmentedStrip({
        block: 'view',
        options: WORKOUTS_STATS_VIEW_OPTIONS,
        labels: { consistency: 'Consistency', load: 'Load', balance: 'Balance' },
        active: activeView,
        onPick: (view) => {
            setActiveWorkoutsStatsView(view);
            activeView = view;
            // No refetch: every view reads the payload already in hand.
            renderView();
        },
    }));

    root.appendChild(_buildSegmentedStrip({
        block: 'range',
        options: WORKOUTS_STATS_RANGE_OPTIONS,
        labels: { '7d': '7d', '30d': '30d', '90d': '90d', 'all': 'All' },
        active: activeRange,
        onPick: (range) => {
            setActiveWorkoutsStatsRange(range);
            activeRange = range;
            // Repaint from the payload we already hold (instant); the reload
            // swaps in the numbers for the new window, which only the domain
            // can compute.
            renderView();
            loadWorkoutStatsTab();
        },
    }));

    root.appendChild(section);
    renderView();

    container.replaceChildren(root);
}

window.WorkoutStats = {
    load: loadWorkoutStatsTab,
    getRange: getActiveWorkoutsStatsRange,
    setRange: setActiveWorkoutsStatsRange,
    getView: getActiveWorkoutsStatsView,
    setView: setActiveWorkoutsStatsView
};
