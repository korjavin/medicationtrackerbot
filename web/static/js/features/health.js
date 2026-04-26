// --- Health Overview (extracted from app.js, upgraded with chart-utils) ---

// Sub-tab state (Phase 8, Task 2). Mirrors the `mt-meds-subtab` /
// `mt-food-subtab` / `mt-workouts-subtab` pattern — one of two values
// (`overview`, `notes`), persisted to localStorage so the user's choice
// survives reload. Default is `overview`.
const HEALTH_SUBTAB_STORAGE_KEY = 'mt-health-subtab';
const HEALTH_SUBTAB_OPTIONS = ['overview', 'notes'];
const HEALTH_SUBTAB_DEFAULT = 'overview';

function getActiveHealthSubTab() {
    try {
        const raw = window.localStorage.getItem(HEALTH_SUBTAB_STORAGE_KEY);
        if (HEALTH_SUBTAB_OPTIONS.indexOf(raw) !== -1) return raw;
    } catch (_) { /* ignore */ }
    return HEALTH_SUBTAB_DEFAULT;
}

function setActiveHealthSubTab(tab) {
    if (HEALTH_SUBTAB_OPTIONS.indexOf(tab) === -1) return;
    try { window.localStorage.setItem(HEALTH_SUBTAB_STORAGE_KEY, tab); } catch (_) { /* ignore */ }
}

function syncHealthSubTabActiveClass(activeTab) {
    const container = document.querySelector('.wg-health-subtabs');
    if (!container) return;
    const buttons = container.querySelectorAll('.health-tab');
    buttons.forEach((btn) => {
        const isActive = btn.dataset.tab === activeTab;
        btn.classList.toggle('wg-gloss--sun', isActive);
        btn.classList.toggle('wg-health-subtabs__btn--active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function restoreHealthSubTab() {
    syncHealthSubTabActiveClass(getActiveHealthSubTab());
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restoreHealthSubTab, { once: true });
} else {
    restoreHealthSubTab();
}

// Range selector state (Phase 8, Task 3). Presentation-only toggle between
// the 7d and 30d averages the backend already returns from
// /api/health/overview — persists via mt-health-range, default 7d.
const HEALTH_RANGE_STORAGE_KEY = 'mt-health-range';
const HEALTH_RANGE_OPTIONS = ['7d', '30d'];
const HEALTH_RANGE_DEFAULT = '7d';

function getActiveHealthRange() {
    try {
        const raw = window.localStorage.getItem(HEALTH_RANGE_STORAGE_KEY);
        if (HEALTH_RANGE_OPTIONS.indexOf(raw) !== -1) return raw;
    } catch (_) { /* ignore */ }
    return HEALTH_RANGE_DEFAULT;
}

function setActiveHealthRange(range) {
    if (HEALTH_RANGE_OPTIONS.indexOf(range) === -1) return;
    try { window.localStorage.setItem(HEALTH_RANGE_STORAGE_KEY, String(range)); } catch (_) { /* ignore */ }
}

function renderHealthRangeSelector(opts) {
    const options = opts || {};
    const active = HEALTH_RANGE_OPTIONS.indexOf(options.active) !== -1
        ? options.active
        : HEALTH_RANGE_DEFAULT;
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;

    const container = document.createElement('div');
    container.id = 'health-range-selector';
    container.className = 'wg-gloss--inset wg-health-range-selector';

    HEALTH_RANGE_OPTIONS.forEach((range) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-gloss wg-health-range-selector__btn';
        if (range === active) btn.classList.add('wg-gloss--sun', 'wg-health-range-selector__btn--active');
        btn.setAttribute('data-range', range);
        btn.setAttribute('aria-pressed', range === active ? 'true' : 'false');
        btn.textContent = range;
        btn.addEventListener('click', () => {
            if (range === active) return;
            if (onChange) onChange(range);
        });
        container.appendChild(btn);
    });
    return container;
}

// Per-vital "good direction" classifier (Phase 8, Task 3). Given the active
// and opposite range averages for a vital, returns one of:
//   • 'sun'     — movement is in the vital's good direction
//   • 'alert'   — movement is in the vital's bad direction
//   • 'neutral' — no meaningful change (equal averages) or unknown
// Direction arrow (↑/↓/·) is independent of variant; it reflects the sign of
// (active - other). The variant flips per vital:
//   steps/spo2: up = sun, down = alert
//   stress:     down = sun, up   = alert
//   sleep:      toward 8h = sun, away from 8h = alert
//   hr:         active avg inside [50,90] = sun, else = alert
function classifyHealthTrend(vital, active, other) {
    if (active == null || other == null) return 'neutral';
    const delta = active - other;
    switch (vital) {
        case 'steps':
        case 'spo2':
            if (delta > 0) return 'sun';
            if (delta < 0) return 'alert';
            return 'neutral';
        case 'stress':
            if (delta < 0) return 'sun';
            if (delta > 0) return 'alert';
            return 'neutral';
        case 'sleep': {
            const distActive = Math.abs(active - 8);
            const distOther = Math.abs(other - 8);
            if (distActive < distOther) return 'sun';
            if (distActive > distOther) return 'alert';
            return 'neutral';
        }
        case 'hr':
            // Lower resting HR is better (fitness goal); delta-based like steps/spo2
            if (delta < 0) return 'sun';
            if (delta > 0) return 'alert';
            return 'neutral';
        default:
            return 'neutral';
    }
}

function trendArrowGlyph(active, other) {
    if (active == null || other == null) return '';
    if (active > other) return '\u2191'; // ↑
    if (active < other) return '\u2193'; // ↓
    return '\u00B7'; // ·
}

const HEALTH_SUMMARY_VITALS = [
    { vital: 'sleep',  label: 'SLEEP',  unit: 'h',     activeKey7: 'average_sleep_hours_7d', activeKey30: 'average_sleep_hours_30d' },
    { vital: 'steps',  label: 'STEPS',  unit: '',      activeKey7: 'average_steps_7d',       activeKey30: 'average_steps_30d' },
    { vital: 'hr',     label: 'HR',     unit: 'bpm',   activeKey7: 'average_heart_rate_7d',  activeKey30: 'average_heart_rate_30d' },
    { vital: 'spo2',   label: 'SPO2',   unit: '%',     activeKey7: 'average_spo2_7d',        activeKey30: 'average_spo2_30d' },
    { vital: 'stress', label: 'STRESS', unit: '/100',  activeKey7: 'average_stress_7d',      activeKey30: 'average_stress_30d' }
];

function formatSummaryValue(vital, value) {
    if (value == null || Number.isNaN(value)) return '\u2014';
    if (vital === 'sleep') return Number(value).toFixed(1);
    if (vital === 'steps') return Number(value).toLocaleString();
    return String(Math.round(value));
}

function renderHealthSummaryTiles(data, range) {
    const safeRange = HEALTH_RANGE_OPTIONS.indexOf(range) !== -1 ? range : HEALTH_RANGE_DEFAULT;
    const wrapper = document.createElement('div');
    wrapper.className = 'wg-card wg-health-summary';
    wrapper.setAttribute('data-range', safeRange);

    HEALTH_SUMMARY_VITALS.forEach((spec) => {
        const tile = document.createElement('div');
        tile.className = 'wg-health-summary__tile';
        tile.setAttribute('data-vital', spec.vital);

        const activeRaw = safeRange === '7d' ? data?.[spec.activeKey7] : data?.[spec.activeKey30];
        const otherRaw = safeRange === '7d' ? data?.[spec.activeKey30] : data?.[spec.activeKey7];
        const hasActive = activeRaw != null && typeof activeRaw === 'number' && !Number.isNaN(activeRaw);
        const hasOther = otherRaw != null && typeof otherRaw === 'number' && !Number.isNaN(otherRaw);

        const valueEl = document.createElement('div');
        valueEl.className = 'wg-mono-display wg-health-summary__value';
        if (!hasActive) tile.classList.add('wg-health-summary__tile--empty');
        const valueText = hasActive ? formatSummaryValue(spec.vital, activeRaw) : '\u2014';
        const unitSuffix = hasActive && spec.unit ? ` ${spec.unit}` : '';
        valueEl.textContent = valueText + unitSuffix;
        tile.appendChild(valueEl);

        const labelEl = document.createElement('div');
        labelEl.className = 'wg-section-label wg-health-summary__label';
        labelEl.textContent = spec.label;
        tile.appendChild(labelEl);

        const trendEl = document.createElement('div');
        trendEl.className = 'wg-health-summary__trend';
        if (hasActive && hasOther) {
            const variant = classifyHealthTrend(spec.vital, activeRaw, otherRaw);
            const glyph = trendArrowGlyph(activeRaw, otherRaw);
            trendEl.classList.add(`wg-health-summary__trend--${variant}`);
            trendEl.setAttribute('data-variant', variant);
            trendEl.textContent = glyph;
        } else {
            trendEl.classList.add('wg-health-summary__trend--empty');
            trendEl.setAttribute('data-variant', 'empty');
            trendEl.textContent = '';
        }
        tile.appendChild(trendEl);

        wrapper.appendChild(tile);
    });

    return wrapper;
}

const HEALTH_SLEEP_LEGEND = [
    { variant: 'deep', label: 'Deep' },
    { variant: 'light', label: 'Light' },
    { variant: 'rem', label: 'REM' },
    { variant: 'awake', label: 'Awake' },
    { variant: 'hr', label: 'HR', line: true }
];

function buildSleepLegend() {
    const legend = document.createElement('div');
    legend.className = 'wg-health-legend wg-sleep-card__legend';
    HEALTH_SLEEP_LEGEND.forEach((entry) => {
        const item = document.createElement('div');
        item.className = 'wg-health-legend__item';
        const badge = document.createElement('span');
        const classes = ['wg-health-legend__badge', `wg-health-legend__badge--${entry.variant}`];
        if (entry.line) classes.push('wg-health-legend__badge--line');
        badge.className = classes.join(' ');
        item.appendChild(badge);
        item.appendChild(document.createTextNode(entry.label));
        legend.appendChild(item);
    });
    return legend;
}

function renderSleepCard(data, activeRange) {
    const range = HEALTH_RANGE_OPTIONS.indexOf(activeRange) !== -1 ? activeRange : HEALTH_RANGE_DEFAULT;
    const card = document.createElement('div');
    card.className = 'wg-card wg-sleep-card';
    card.setAttribute('data-range', range);

    const header = document.createElement('div');
    header.className = 'wg-sleep-card__header wg-mono-display';
    header.textContent = 'Sleep';
    card.appendChild(header);

    const statsKey = range === '30d' ? 'sleep_stats_30d' : 'sleep_stats_7d';
    const stats = Array.isArray(data?.[statsKey]) ? data[statsKey] : [];
    const chartEl = window.WGSleepChart
        ? window.WGSleepChart.render({ stats, range, prefiltered: true })
        : null;

    if (chartEl && !chartEl.classList.contains('wg-sleep-chart--empty')) {
        card.appendChild(chartEl);
        card.appendChild(buildSleepLegend());

        const avg7Raw = data?.average_sleep_hours_7d;
        const avg30Raw = data?.average_sleep_hours_30d;
        const avg7Text = avg7Raw != null && Number.isFinite(Number(avg7Raw)) ? Number(avg7Raw).toFixed(1) : '\u2014';
        const avg30Text = avg30Raw != null && Number.isFinite(Number(avg30Raw)) ? Number(avg30Raw).toFixed(1) : '\u2014';
        const statDiv = document.createElement('div');
        statDiv.className = 'wg-section-label wg-sleep-card__stat';
        statDiv.textContent = `${avg7Text} hrs (7d avg) \u00B7 ${avg30Text} hrs (30d avg)`;
        card.appendChild(statDiv);
    } else {
        const empty = chartEl || (() => {
            const el = document.createElement('div');
            el.className = 'wg-sleep-chart wg-sleep-chart--empty';
            const msg = document.createElement('span');
            msg.className = 'wg-sleep-chart__empty-msg';
            msg.textContent = 'No sleep data yet';
            el.appendChild(msg);
            return el;
        })();
        card.appendChild(empty);
    }

    return card;
}

function renderStepsCard(data, activeRange) {
    const range = HEALTH_RANGE_OPTIONS.indexOf(activeRange) !== -1 ? activeRange : HEALTH_RANGE_DEFAULT;
    const card = document.createElement('div');
    card.className = 'wg-card wg-steps-card';
    card.setAttribute('data-range', range);

    const header = document.createElement('div');
    header.className = 'wg-steps-card__header wg-mono-display';
    header.textContent = 'Steps';
    card.appendChild(header);

    const statsKey = range === '30d' ? 'step_stats_30d' : 'step_stats_7d';
    const stats = Array.isArray(data?.[statsKey]) ? data[statsKey] : [];
    const chartEl = window.WGStepsChart
        ? window.WGStepsChart.render({ stats, range, prefiltered: true })
        : null;

    if (chartEl && !chartEl.classList.contains('wg-steps-chart--empty')) {
        card.appendChild(chartEl);

        const avg7Raw = data?.average_steps_7d;
        const avg30Raw = data?.average_steps_30d;
        const avg7Text = avg7Raw != null && Number.isFinite(Number(avg7Raw)) ? Math.round(avg7Raw).toLocaleString() : '\u2014';
        const avg30Text = avg30Raw != null && Number.isFinite(Number(avg30Raw)) ? Math.round(avg30Raw).toLocaleString() : '\u2014';
        const statDiv = document.createElement('div');
        statDiv.className = 'wg-section-label wg-steps-card__stat';
        statDiv.textContent = `${avg7Text} steps (7d avg) \u00B7 ${avg30Text} steps (30d avg)`;
        card.appendChild(statDiv);
    } else {
        const empty = chartEl || (() => {
            const el = document.createElement('div');
            el.className = 'wg-steps-chart wg-steps-chart--empty';
            const msg = document.createElement('span');
            msg.className = 'wg-steps-chart__empty-msg';
            msg.textContent = 'No step data yet';
            el.appendChild(msg);
            return el;
        })();
        card.appendChild(empty);
    }

    return card;
}

const HEALTH_VITAL_SPECS = {
    hr:     { title: 'Heart Rate',   historyKey7: 'heart_rate_history_7d', historyKey30: 'heart_rate_history_30d', avg7Key: 'average_heart_rate_7d', avg30Key: 'average_heart_rate_30d', unit: 'bpm',   emptyLabel: 'heart rate' },
    spo2:   { title: 'SpO2',         historyKey7: 'spo2_history_7d',       historyKey30: 'spo2_history_30d',       avg7Key: 'average_spo2_7d',       avg30Key: 'average_spo2_30d',       unit: '%',     emptyLabel: 'SpO2' },
    stress: { title: 'Stress Level', historyKey7: 'stress_history_7d',     historyKey30: 'stress_history_30d',     avg7Key: 'average_stress_7d',     avg30Key: 'average_stress_30d',     unit: '/ 100', emptyLabel: 'stress' }
};

function formatVitalAvg(value) {
    if (value == null || !Number.isFinite(Number(value))) return '\u2014';
    return String(Math.round(Number(value)));
}

function renderVitalCard(vital, data, activeRange) {
    const spec = HEALTH_VITAL_SPECS[vital];
    if (!spec) return null;
    const range = HEALTH_RANGE_OPTIONS.indexOf(activeRange) !== -1 ? activeRange : HEALTH_RANGE_DEFAULT;
    const card = document.createElement('div');
    card.className = `wg-card wg-vitals-card wg-vitals-card--${vital}`;
    card.setAttribute('data-range', range);
    card.setAttribute('data-vital', vital);

    const header = document.createElement('div');
    header.className = 'wg-vitals-card__header wg-mono-display';
    header.textContent = spec.title;
    card.appendChild(header);

    const historyKey = range === '30d' ? spec.historyKey30 : spec.historyKey7;
    const history = Array.isArray(data?.[historyKey]) ? data[historyKey] : [];
    const chartEl = window.WGVitalsChart
        ? window.WGVitalsChart.render({ history, range, vital, prefiltered: true })
        : null;

    if (chartEl && !chartEl.classList.contains('wg-vitals-chart--empty')) {
        card.appendChild(chartEl);

        const avg7Text = formatVitalAvg(data?.[spec.avg7Key]);
        const avg30Text = formatVitalAvg(data?.[spec.avg30Key]);
        const statDiv = document.createElement('div');
        statDiv.className = 'wg-section-label wg-vitals-card__stat';
        statDiv.textContent = `${avg7Text} ${spec.unit} (7d avg) \u00B7 ${avg30Text} ${spec.unit} (30d avg)`;
        card.appendChild(statDiv);
    } else {
        const empty = chartEl || (() => {
            const el = document.createElement('div');
            el.className = `wg-vitals-chart wg-vitals-chart--empty wg-vitals-chart--${vital}`;
            const msg = document.createElement('span');
            msg.className = 'wg-vitals-chart__empty-msg';
            msg.textContent = `No ${spec.emptyLabel} data yet`;
            el.appendChild(msg);
            return el;
        })();
        card.appendChild(empty);
    }

    return card;
}

function renderHealthOverviewContent(content, data) {
    content.replaceChildren();

    const activeRange = getActiveHealthRange();

    content.appendChild(renderHealthSummaryTiles(data, activeRange));

    const rangeSelector = renderHealthRangeSelector({
        active: activeRange,
        onChange: (r) => {
            setActiveHealthRange(r);
            renderHealthOverviewContent(content, data);
        }
    });
    content.appendChild(rangeSelector);

    content.appendChild(renderSleepCard(data, activeRange));
    content.appendChild(renderStepsCard(data, activeRange));

    content.appendChild(renderVitalCard('hr', data, activeRange));
    content.appendChild(renderVitalCard('spo2', data, activeRange));
    content.appendChild(renderVitalCard('stress', data, activeRange));

    const disclaimer = document.createElement('p');
    disclaimer.className = 'wg-section-label wg-health-disclaimer';
    disclaimer.textContent = 'DATA SOURCE \u00B7 .nxk backups';
    content.appendChild(disclaimer);
}

function renderHealthOverviewError(content) {
    const errP = document.createElement('p');
    errP.className = 'text-hint';
    errP.textContent = 'No cached data \u2014 will load when online';
    content.replaceChildren(errP);
    content.classList.remove('hidden');
}

async function loadHealthOverview() {
    const content = document.getElementById('health-overview-content');
    const loading = document.getElementById('health-overview-loading');
    if (!content || !loading) return;
    loading.style.display = 'block';

    if (window.DataStore) {
        const hoKey = window.healthOverviewCacheKey();
        await window.DataStore.loadSWR({
            key: hoKey,
            tags: ['health'],
            fetcher: async () => {
                const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
                const tzOffset = new Date().getTimezoneOffset();
                const tzParams = tzName
                    ? `?tz=${encodeURIComponent(tzName)}`
                    : `?tz_offset=${tzOffset}`;
                return await window.apiCall(`/api/health/overview${tzParams}`, 'GET');
            },
            allowNullFresh: true,
            onCached: async (cached) => {
                if (!cached) return;
                renderHealthOverviewContent(content, cached);
                loading.style.display = 'none';
                content.classList.remove('hidden');
            },
            onFresh: async (fresh, cached) => {
                loading.style.display = 'none';
                if (!fresh) {
                    if (!cached) renderHealthOverviewError(content);
                    return;
                }
                renderHealthOverviewContent(content, fresh);
                content.classList.remove('hidden');
            },
            onError: async (e, cached) => {
                console.error('Failed to load health overview:', e);
                loading.style.display = 'none';
                if (!cached) renderHealthOverviewError(content);
            }
        });
    } else {
        loading.style.display = 'none';
        renderHealthOverviewError(content);
    }
}

// ---- Diary Notes ----
// Folded out of app.js in Phase 8, Task 1 to match the feature-module pattern
// (bp.js / food.js / meds.js / today.js / weight.js / workout.js / health.js).

const NOTES_PAGE_SIZE = 50;
// Keyset cursor: ID of the last note currently shown. 0 means page 1 not yet loaded.
let _notesCursor = 0;
// In-flight guard to prevent concurrent load-more requests.
let _notesLoadingMore = false;
// True once the user has clicked "Load more" at least once in the current view.
let _notesHasLoadedMore = false;
// Incremented each time loadNotes() starts a fresh load; lets stale loadMoreNotes() calls self-cancel.
let _notesGeneration = 0;
// Fresh page-1 data parked while _notesHasLoadedMore is true. Applied if load-more fails so the
// page-1 view stays consistent with the latest server state.
let _notesPendingFresh = null;

async function loadNotes() {
    const list = document.getElementById('notes-list');
    const loading = document.getElementById('notes-loading');
    if (!list) return;

    _notesCursor = 0;
    _notesLoadingMore = false;
    _notesHasLoadedMore = false;
    _notesPendingFresh = null;
    _notesGeneration++;
    // Capture the generation at call time. The onFresh callback closes over this
    // value so that a stale in-flight response (from before a write invalidated
    // the cache) cannot repaint the list after a newer loadNotes() has started.
    const myGeneration = _notesGeneration;

    if (loading) loading.style.display = 'block';

    await window.DataStore.loadSWR({
        key: 'diary_notes',
        tags: ['notes', 'health-notes'],
        fetcher: async () => await apiCall(`/api/notes?limit=${NOTES_PAGE_SIZE}`, 'GET'),
        allowNullFresh: true,
        onCached: async (cached) => {
            if (!cached) return;
            renderNotes(list, cached);
            if (cached.length > 0) _notesCursor = cached[cached.length - 1].id;
            if (loading) loading.style.display = 'none';
        },
        onFresh: async (fresh) => {
            if (loading) loading.style.display = 'none';
            // Discard the result if a newer loadNotes() call has already taken
            // over (e.g. the user added/deleted a note while this fetch was in
            // flight and the post-write refresh incremented _notesGeneration).
            if (myGeneration !== _notesGeneration) return;
            if (!fresh) return;
            // Only replace page 1 if the user has not yet clicked "Load more".
            // When _notesHasLoadedMore is true, the list contains pages 2+ that we
            // must not wipe; a full reload requires an explicit loadNotes() call anyway.
            if (!_notesHasLoadedMore) {
                const page1LastID = fresh.length > 0 ? fresh[fresh.length - 1].id : 0;
                renderNotes(list, fresh);
                _notesCursor = page1LastID;
            } else {
                // Page-2 fetch is in flight. Stash the fresh page-1 data so we can
                // apply it if that fetch fails and no page was actually appended.
                _notesPendingFresh = { data: fresh, generation: _notesGeneration };
            }
        },
        onError: async (e, cached) => {
            console.error('Failed to load notes:', e);
            if (loading) loading.style.display = 'none';
            if (!cached) {
                const list = document.getElementById('notes-list');
                if (list) {
                    list.replaceChildren();
                    list.appendChild(buildNotesEmptyCard('No cached data \u2014 will load when online'));
                }
            }
        }
    });

    const saveBtn = document.getElementById('notes-save-btn');
    if (saveBtn && !saveBtn._noteHandlerAttached) {
        saveBtn._noteHandlerAttached = true;
        saveBtn.addEventListener('click', addNote);
    }
    bindNotesComposer();
}

// Note-tag composer (Phase 8 / Task 7). Backend enum is SLEEP | STRESS | HR |
// SPO2 | STEPS | NOTE; unknown values are sanitized to NULL server-side, but
// the composer only lets the user pick from this list. `null` means no tag.
const VALID_NOTE_TAGS = ['SLEEP', 'STRESS', 'HR', 'SPO2', 'STEPS', 'NOTE'];
const _notesCompose = { selectedTag: null };

function setNotesComposerTag(tag) {
    const next = VALID_NOTE_TAGS.indexOf(tag) !== -1 ? tag : null;
    _notesCompose.selectedTag = next;
    syncNotesComposerTagClasses();
}

function syncNotesComposerTagClasses() {
    const container = document.getElementById('notes-compose-tags');
    if (!container) return;
    const active = _notesCompose.selectedTag;
    container.querySelectorAll('.wg-health-notes-compose__tag').forEach((btn) => {
        const on = btn.getAttribute('data-tag') === active;
        btn.classList.toggle('wg-tag--sun', on);
        btn.classList.toggle('wg-health-notes-compose__tag--active', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
}

function syncNotesComposerCount() {
    const textarea = document.getElementById('notes-textarea');
    const count = document.getElementById('notes-compose-count');
    const save = document.getElementById('notes-save-btn');
    if (!textarea) return;
    const len = textarea.value.length;
    if (count) count.textContent = len > 0 ? `${len} chars` : 'empty';
    if (save) {
        const hasContent = textarea.value.trim().length > 0;
        if (hasContent) {
            save.removeAttribute('disabled');
        } else {
            save.setAttribute('disabled', 'disabled');
        }
    }
}

function bindNotesComposer() {
    const container = document.getElementById('notes-compose-tags');
    if (container && !container._wgBound) {
        container._wgBound = true;
        container.addEventListener('click', (ev) => {
            const btn = ev.target.closest('.wg-health-notes-compose__tag');
            if (!btn || !container.contains(btn)) return;
            const tag = btn.getAttribute('data-tag');
            if (_notesCompose.selectedTag === tag) {
                setNotesComposerTag(null);
            } else {
                setNotesComposerTag(tag);
            }
        });
    }
    const textarea = document.getElementById('notes-textarea');
    if (textarea && !textarea._wgBound) {
        textarea._wgBound = true;
        textarea.addEventListener('input', syncNotesComposerCount);
    }
    syncNotesComposerTagClasses();
    syncNotesComposerCount();
}

async function loadMoreNotes() {
    if (_notesLoadingMore) return;
    const list = document.getElementById('notes-list');
    if (!list) return;

    const myGeneration = _notesGeneration;
    _notesLoadingMore = true;
    // Set immediately so that any in-flight onFresh callback from the initial
    // loadNotes() SWR call does not replace page 1 while we are fetching page 2.
    _notesHasLoadedMore = true;
    // Snapshot the page-1 end cursor so we can later tell whether fresh page-1
    // data represents a real change or is just an identical revalidation response.
    const page1EndCursor = _notesCursor;
    try {
        const url = _notesCursor > 0
            ? `/api/notes?limit=${NOTES_PAGE_SIZE}&before_id=${_notesCursor}`
            : `/api/notes?limit=${NOTES_PAGE_SIZE}`;
        const notes = await apiCall(url, 'GET');
        if (!notes) {
            // Fetch failed — no page 2 was actually appended. Only roll back for
            // the current generation to avoid clobbering a newer loadMoreNotes().
            if (myGeneration === _notesGeneration) {
                _notesHasLoadedMore = false;
                // Apply the deferred fresh page-1 data that onFresh skipped while
                // the flag was set, so the UI shows the latest server state.
                if (_notesPendingFresh && _notesPendingFresh.generation === myGeneration) {
                    const pending = _notesPendingFresh.data;
                    _notesPendingFresh = null;
                    renderNotes(list, pending);
                    _notesCursor = pending && pending.length > 0 ? pending[pending.length - 1].id : 0;
                }
            }
            return;
        }

        // Bail out if loadNotes() started a fresh load while this fetch was in-flight.
        if (myGeneration !== _notesGeneration) return;

        // Remove existing load-more button before appending.
        const existing = list.querySelector('.wg-health-notes__load-more');
        if (existing) existing.remove();
        if (notes.length === 0 && _notesPendingFresh && _notesPendingFresh.generation === myGeneration) {
            // Server returned an empty page 2 — the dataset no longer extends past
            // page 1 (e.g. notes were deleted since caching). Apply the deferred
            // fresh page-1 data to show the correct current state.
            _notesHasLoadedMore = false;
            const pending = _notesPendingFresh.data;
            _notesPendingFresh = null;
            const freshLastID = pending && pending.length > 0 ? pending[pending.length - 1].id : 0;
            if (freshLastID !== page1EndCursor) {
                // Page-1 boundary shifted while we were fetching page 2. The empty
                // page-2 response was relative to the old boundary; rows may now
                // sit on a different page. Reload for a contiguous, accurate list.
                loadNotes();
                return;
            }
            // Boundary unchanged and server proved no older rows exist — render
            // the pending page-1 data and suppress Load more. Bypass renderNotes
            // so _notesHasMore is not re-set from pending.length.
            _notesAll = Array.isArray(pending) ? pending.slice() : [];
            _notesHasMore = false;
            paintNotes(list);
            syncNotesRowTagActive(list);
            bindNotesTagFilterDelegation(list);
            _notesCursor = freshLastID;
            return;
        }
        if (notes.length > 0) _notesCursor = notes[notes.length - 1].id;
        // Page 2 was appended successfully.
        if (_notesPendingFresh && _notesPendingFresh.generation === myGeneration) {
            const freshData = _notesPendingFresh.data;
            const freshLastID = freshData && freshData.length > 0 ? freshData[freshData.length - 1].id : 0;
            _notesPendingFresh = null;
            if (freshLastID !== page1EndCursor) {
                // Page-1 actually changed on the server (e.g. a new note was added
                // that shifted the cursor boundary). The page-2 we just fetched may
                // now overlap or have a gap, so trigger a full reload for a
                // contiguous, accurate list.
                loadNotes();
                return;
            }
            // The page-1 boundary (last ID) is unchanged, so page-2 is still
            // contiguous. However, page-1 content may have changed in the middle
            // (e.g. a note was deleted and a new one added with the same resulting
            // boundary). Re-render page-1 from the fresh server data, then fall
            // through to append page-2 so both pages are up-to-date.
            renderNotes(list, freshData);
            // Do not update _notesCursor here — it was already advanced to the
            // last page-2 ID before the deferred page-1 replay ran. Overwriting
            // with freshLastID (page-1 boundary) would cause the next
            // "load more" to re-fetch page-2.
            // renderNotes may have added a "Load more" button at the end of page-1;
            // remove it before appending the page-2 items below.
            list.querySelector('.wg-health-notes__load-more')?.remove();
        }
        _notesPendingFresh = null;
        appendNotes(list, notes);
    } finally {
        // Only clear the guard for the current generation. An old-generation
        // request finishing after loadNotes() reset and a new loadMoreNotes()
        // set the guard must not clobber the new generation's in-flight state.
        if (myGeneration === _notesGeneration) {
            _notesLoadingMore = false;
        }
    }
}

// Day-grouped notes render (Phase 8, Task 7). Each day is a `<li>` with a
// `.wg-section-label` header (e.g. "22.04.2026 · Tue") and a list of
// `.wg-card` rows. Each row carries a mono timestamp eyebrow, the note body,
// and a trailing `.wg-icon-btn` cluster (edit + delete). Offline-pending +
// rejected states surface as `.wg-tag--mono` badges. Pagination is a
// full-width `.wg-gloss` "Load more" footer button.
// Round-2 Task 5: module-level cache so the tag-chip filter can repaint the
// list from memory without refetching. `renderNotes` resets it; `appendNotes`
// extends it. `_notesFilterTag` is null when no filter is active.
// `_notesHasMore` tracks whether the last server response returned a full
// page — it must be based on the unfiltered fetch, not the filtered visible
// count, or tag-filtered views would drop the Load-more control prematurely.
let _notesAll = [];
let _notesFilterTag = null;
let _notesHasMore = false;

function getNotesFilterTag() {
    return _notesFilterTag;
}

function setNotesFilterTag(tag) {
    const next = (tag && VALID_NOTE_TAGS.indexOf(tag) !== -1) ? tag : null;
    if (_notesFilterTag === next) return;
    _notesFilterTag = next;
    const list = document.getElementById('notes-list');
    if (!list) return;
    paintNotes(list);
    syncNotesRowTagActive(list);
    bindNotesTagFilterDelegation(list);
}

function filterNotesByActiveTag(notes) {
    if (!Array.isArray(notes)) return [];
    if (!_notesFilterTag) return notes;
    return notes.filter((n) => n && n.tag === _notesFilterTag);
}

function paintNotes(list) {
    list.replaceChildren();
    const visible = filterNotesByActiveTag(_notesAll);
    if (!visible || visible.length === 0) {
        const msg = _notesFilterTag
            ? `No notes tagged ${_notesFilterTag}`
            : 'No notes yet \u2014 write your first one.';
        list.appendChild(buildNotesEmptyCard(msg));
    } else {
        paintNotesGroups(list, visible);
    }
    appendLoadMoreIfNeeded(list);
}

function renderNotes(list, notes) {
    _notesAll = Array.isArray(notes) ? notes.slice() : [];
    _notesHasMore = _notesAll.length === NOTES_PAGE_SIZE;
    paintNotes(list);
    syncNotesRowTagActive(list);
    bindNotesTagFilterDelegation(list);
}

function appendNotes(list, notes) {
    if (!notes || notes.length === 0) {
        // Server proved no more rows exist; clear the flag so a later
        // paintNotes() (e.g. tag-filter toggle) does not re-add Load more.
        _notesHasMore = false;
        return;
    }
    _notesAll = _notesAll.concat(notes);
    _notesHasMore = notes.length === NOTES_PAGE_SIZE;

    // With a filter active, raw appends would reveal non-matching rows next
    // to filtered ones \u2014 repaint the whole list from the cache instead.
    if (_notesFilterTag) {
        paintNotes(list);
        syncNotesRowTagActive(list);
        bindNotesTagFilterDelegation(list);
        return;
    }
    paintNotesGroups(list, notes);
    appendLoadMoreIfNeeded(list);
    syncNotesRowTagActive(list);
    bindNotesTagFilterDelegation(list);
}

function appendLoadMoreIfNeeded(list) {
    if (!list || !_notesHasMore) return;
    if (list.querySelector('.wg-health-notes__load-more')) return;
    list.appendChild(buildNotesLoadMore());
}

function paintNotesGroups(list, notes) {
    const groups = groupNotesByDay(notes);
    groups.forEach((group, idx) => {
        // If the first group of an appended page shares its calendar day with
        // the last existing group (e.g. a busy day straddled a 50-row server
        // page boundary), merge the new rows into the existing group instead
        // of rendering a duplicate header.
        if (idx === 0) {
            const existingGroups = list.querySelectorAll('.wg-health-notes__group');
            const lastGroup = existingGroups[existingGroups.length - 1];
            if (lastGroup && lastGroup.dataset.notesDayKey === String(group.sortKey)) {
                const rowList = lastGroup.querySelector('.wg-health-notes__rows');
                if (rowList) {
                    group.notes.forEach((note) => rowList.appendChild(buildNoteRow(note)));
                    return;
                }
            }
        }
        const groupItem = buildNotesDayGroup(group.label, group.notes);
        if (groupItem) {
            groupItem.dataset.notesDayKey = String(group.sortKey);
            list.appendChild(groupItem);
        }
    });
}

function syncNotesRowTagActive(list) {
    if (!list) return;
    const active = _notesFilterTag;
    list.querySelectorAll('.wg-health-notes-row__tag').forEach((chip) => {
        const matches = active != null && chip.getAttribute('data-tag') === active;
        chip.classList.toggle('wg-health-notes-row__tag--active', matches);
    });
}

function bindNotesTagFilterDelegation(list) {
    if (!list || list._wgNotesTagFilterBound) return;
    list._wgNotesTagFilterBound = true;
    list.addEventListener('click', (ev) => {
        const chip = ev.target.closest('.wg-health-notes-row__tag');
        if (!chip || !list.contains(chip)) return;
        const tag = chip.getAttribute('data-tag');
        if (VALID_NOTE_TAGS.indexOf(tag) === -1) return;
        ev.preventDefault();
        ev.stopPropagation();
        setNotesFilterTag(_notesFilterTag === tag ? null : tag);
    });
}

const NOTES_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function groupNotesByDay(notes) {
    const buckets = new Map();
    const order = [];

    notes.forEach((note) => {
        const d = new Date(note.created_at);
        if (!Number.isFinite(d.getTime())) return;
        const dayStart = new Date(d);
        dayStart.setHours(0, 0, 0, 0);
        const dayMs = dayStart.getTime();
        const key = String(dayMs);
        if (!buckets.has(key)) {
            const label = formatNotesDayLabel(dayStart);
            buckets.set(key, { label, sortKey: dayMs, notes: [] });
            order.push(key);
        }
        buckets.get(key).notes.push(note);
    });

    return order.map((k) => buckets.get(k));
}

function formatNotesDayLabel(dayStart) {
    const datePart = dayStart.toLocaleDateString(undefined, {
        day: '2-digit', month: '2-digit', year: 'numeric'
    });
    const dayName = NOTES_DAY_NAMES[dayStart.getDay()];
    return `${datePart} \u00B7 ${dayName}`;
}

function buildNotesDayGroup(label, notes) {
    if (!notes || notes.length === 0) return null;

    const groupItem = document.createElement('li');
    groupItem.className = 'wg-health-notes__group';

    const header = document.createElement('div');
    header.className = 'wg-section-label wg-health-notes__group-label';
    const headerText = document.createElement('span');
    headerText.textContent = label;
    header.appendChild(headerText);
    groupItem.appendChild(header);

    const rowList = document.createElement('ul');
    rowList.className = 'list-reset wg-health-notes__rows';
    notes.forEach((note) => rowList.appendChild(buildNoteRow(note)));
    groupItem.appendChild(rowList);

    return groupItem;
}

function buildNoteRow(note) {
    const item = document.createElement('li');
    item.className = 'wg-card wg-health-notes-row';
    if (note.isLocal) item.classList.add('wg-health-notes-row--pending');
    if (note.isRejected) item.classList.add('wg-health-notes-row--rejected');
    item.setAttribute('data-note-id', String(note.id));

    const body = document.createElement('div');
    body.className = 'wg-health-notes-row__body';

    const meta = document.createElement('div');
    meta.className = 'wg-health-notes-row__meta';

    if (typeof note.tag === 'string' && VALID_NOTE_TAGS.indexOf(note.tag) !== -1) {
        const tagEl = document.createElement('span');
        tagEl.className = 'wg-tag wg-tag--high wg-health-notes-row__tag';
        tagEl.setAttribute('data-tag', note.tag);
        tagEl.textContent = note.tag;
        meta.appendChild(tagEl);
    }

    const time = document.createElement('span');
    time.className = 'wg-mono-display wg-health-notes-row__time';
    const d = new Date(note.created_at);
    time.textContent = Number.isFinite(d.getTime())
        ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : '';
    meta.appendChild(time);

    if (note.isRejected) {
        meta.appendChild(buildNotesSyncTag('rejected', 'Failed', note.errorMessage));
    } else if (note.isLocal) {
        meta.appendChild(buildNotesSyncTag('pending', 'Pending'));
    }

    body.appendChild(meta);

    const content = document.createElement('div');
    content.className = 'wg-health-notes-row__content';
    content.textContent = note.content;
    body.appendChild(content);

    item.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'wg-health-notes-row__actions';
    actions.appendChild(buildNoteRowEditButton(note));
    actions.appendChild(buildNoteRowDeleteButton(note));
    item.appendChild(actions);

    return item;
}

function buildNotesSyncTag(kind, label, tooltip) {
    const tag = document.createElement('span');
    tag.className = `wg-tag wg-tag--mono wg-tag--${kind} wg-health-notes-row__sync`;
    tag.textContent = label;
    if (tooltip) tag.title = tooltip;
    return tag;
}

function buildNoteRowEditButton(note) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wg-icon-btn wg-health-notes-row__edit';
    btn.setAttribute('aria-label', 'Edit note');

    const gloss = document.createElement('span');
    gloss.className = 'wg-gloss';
    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        gloss.appendChild(window.WGIcons.iconSvg('pencil', { size: 16 }));
    }
    btn.appendChild(gloss);

    btn.addEventListener('click', () => {
        if (typeof window.editNote === 'function') {
            window.editNote(note);
        }
    });
    return btn;
}

function buildNoteRowDeleteButton(note) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wg-icon-btn wg-health-notes-row__delete';
    btn.setAttribute('aria-label', 'Delete note');

    const gloss = document.createElement('span');
    gloss.className = 'wg-gloss';
    if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
        gloss.appendChild(window.WGIcons.iconSvg('trash', { size: 16 }));
    }
    btn.appendChild(gloss);

    btn.addEventListener('click', () => deleteNote(note.id));
    return btn;
}

function buildNotesLoadMore() {
    const li = document.createElement('li');
    li.className = 'wg-health-notes__load-more';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wg-gloss wg-health-notes__load-more-btn';
    btn.textContent = 'Load more';
    btn.addEventListener('click', loadMoreNotes);
    li.appendChild(btn);
    return li;
}

function buildNotesEmptyCard(message) {
    const li = document.createElement('li');
    li.className = 'wg-card wg-health-notes__empty';
    const text = document.createElement('span');
    text.className = 'wg-health-notes__empty-msg';
    text.textContent = message;
    li.appendChild(text);
    return li;
}

async function addNote() {
    const textarea = document.getElementById('notes-textarea');
    if (!textarea) return;
    const content = textarea.value.trim();
    if (!content) return;
    // Backend counts runes (utf8.RuneCountInString); JS .length counts UTF-16
    // code units, which double-counts astral-plane chars (most emoji, CJK
    // extension). Iterate to get code-point length so client and server agree.
    if ([...content].length > 10000) {
        safeAlert('Note is too long (max 10,000 characters).');
        return;
    }

    const body = { content };
    if (_notesCompose.selectedTag) body.tag = _notesCompose.selectedTag;

    const res = await apiCall('/api/notes', 'POST', body);
    if (res) {
        textarea.value = '';
        setNotesComposerTag(null);
        syncNotesComposerCount();
        await window.DataStore.invalidateTags(['health-notes']);
        loadNotes();
    }
}

async function deleteNote(id) {
    await safeConfirm('Delete this note?', async (ok) => {
        if (!ok) return;

        // Local/rejected rows carry `local_<n>` ids synthesized by the
        // offline read path. The server DELETE handler only accepts numeric
        // ids (400 otherwise), so purge via IndexedDB — mirrors the edit
        // path below.
        const isLocalId = typeof id === 'string' && id.startsWith('local_');
        if (isLocalId) {
            const localId = parseInt(id.replace('local_', ''), 10);
            if (window.MedTrackerDB && window.MedTrackerDB.NotesStore
                && typeof window.MedTrackerDB.NotesStore.confirmDelete === 'function'
                && Number.isFinite(localId)) {
                try {
                    await window.MedTrackerDB.NotesStore.confirmDelete(localId);
                    if (window.SyncManager && typeof window.SyncManager.updateStatus === 'function') {
                        window.SyncManager.updateStatus();
                    }
                } catch (e) {
                    console.error('Failed to purge local note delete:', e);
                }
            }
            await window.DataStore.invalidateTags(['health-notes']);
            loadNotes();
            return;
        }

        const res = await apiCall(`/api/notes/${id}`, 'DELETE');
        if (res !== null) {
            await window.DataStore.invalidateTags(['health-notes']);
            loadNotes();
        }
    });
}

// Edit-note modal (Phase 8, Task 8). The notes API exposes only POST + DELETE,
// so an edit POSTs the replacement first and only DELETEs the original after
// the new row lands — a failed POST therefore leaves the original intact, and
// a failed DELETE leaves a duplicate (visible + fixable from the list) rather
// than data loss.
let editingNote = null;

function editNote(note) {
    if (!note) return;
    editingNote = note;
    const textarea = document.getElementById('note-modal-textarea');
    if (textarea) textarea.value = typeof note.content === 'string' ? note.content : '';
    const title = document.getElementById('note-modal-title');
    if (title) title.textContent = 'Edit note';
    if (window.ModalManager && window.ModalManager.note) {
        window.ModalManager.note.open();
    }
}

function closeEditNoteModal() {
    editingNote = null;
    if (window.ModalManager && window.ModalManager.note) {
        window.ModalManager.note.close();
    }
}

async function handleEditNoteSubmit(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const textarea = document.getElementById('note-modal-textarea');
    if (!textarea) return;
    const content = textarea.value.trim();
    if (!content) {
        safeAlert('Note cannot be empty.');
        return;
    }
    if ([...content].length > 10000) {
        safeAlert('Note is too long (max 10,000 characters).');
        return;
    }
    if (!editingNote || editingNote.id == null) {
        closeEditNoteModal();
        return;
    }
    if (content === editingNote.content) {
        closeEditNoteModal();
        return;
    }

    const original = editingNote;
    const postBody = { content };
    if (typeof original.tag === 'string' && original.tag) {
        postBody.tag = original.tag;
    }
    const postRes = await apiCall('/api/notes', 'POST', postBody);
    if (!postRes) return;

    const isLocalId = typeof original.id === 'string' && original.id.startsWith('local_');
    if (isLocalId) {
        const localId = parseInt(String(original.id).replace('local_', ''), 10);
        if (window.MedTrackerDB && window.MedTrackerDB.NotesStore
            && typeof window.MedTrackerDB.NotesStore.confirmDelete === 'function'
            && Number.isFinite(localId)) {
            try {
                await window.MedTrackerDB.NotesStore.confirmDelete(localId);
                if (window.SyncManager && typeof window.SyncManager.updateStatus === 'function') {
                    window.SyncManager.updateStatus();
                }
            } catch (e) {
                console.error('Failed to purge local note edit:', e);
            }
        }
    } else {
        await apiCall(`/api/notes/${original.id}`, 'DELETE');
    }

    await window.DataStore.invalidateTags(['health-notes']);
    closeEditNoteModal();
    loadNotes();
}

function bindEditNoteModalControls() {
    const cancel = document.getElementById('note-modal-cancel-btn');
    if (cancel && !cancel._wgBound) {
        cancel._wgBound = true;
        cancel.addEventListener('click', () => closeEditNoteModal());
    }
    const form = document.getElementById('note-form');
    if (form && !form._wgBound) {
        form._wgBound = true;
        form.addEventListener('submit', handleEditNoteSubmit);
    }
}

// Called from dynamically-built edit buttons in notes rows
window.editNote = editNote;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEditNoteModalControls, { once: true });
} else {
    bindEditNoteModalControls();
}
