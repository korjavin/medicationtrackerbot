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
            if (active >= 50 && active <= 90) return 'sun';
            return 'alert';
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
    if (value == null || Number.isNaN(value) || value === 0) return '\u2014';
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
        const hasActive = typeof activeRaw === 'number' && !Number.isNaN(activeRaw) && activeRaw !== 0;
        const hasOther = typeof otherRaw === 'number' && !Number.isNaN(otherRaw) && otherRaw !== 0;

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

    const stats = Array.isArray(data?.sleep_stats_7d) ? data.sleep_stats_7d : [];
    const chartOpts = { stats, range };
    const chartEl = window.WGSleepChart
        ? window.WGSleepChart.render(chartOpts)
        : null;

    if (chartEl && !chartEl.classList.contains('wg-sleep-chart--empty')) {
        card.appendChild(chartEl);
        card.appendChild(buildSleepLegend());

        const avg7 = Number(data?.average_sleep_hours_7d);
        const avg30 = Number(data?.average_sleep_hours_30d);
        const avg7Text = Number.isFinite(avg7) ? avg7.toFixed(1) : '\u2014';
        const avg30Text = Number.isFinite(avg30) ? avg30.toFixed(1) : '\u2014';
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

    const stats = Array.isArray(data?.step_stats_7d) ? data.step_stats_7d : [];
    const chartOpts = { stats, range };
    const chartEl = window.WGStepsChart
        ? window.WGStepsChart.render(chartOpts)
        : null;

    if (chartEl && !chartEl.classList.contains('wg-steps-chart--empty')) {
        card.appendChild(chartEl);

        const avg7 = Number(data?.average_steps_7d);
        const avg30 = Number(data?.average_steps_30d);
        const avg7Text = Number.isFinite(avg7) && avg7 > 0 ? Math.round(avg7).toLocaleString() : '\u2014';
        const avg30Text = Number.isFinite(avg30) && avg30 > 0 ? Math.round(avg30).toLocaleString() : '\u2014';
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
    hr:     { title: 'Heart Rate',   historyKey: 'heart_rate_history_7d', avg7Key: 'average_heart_rate_7d', avg30Key: 'average_heart_rate_30d', unit: 'bpm',   emptyLabel: 'heart rate' },
    spo2:   { title: 'SpO2',         historyKey: 'spo2_history_7d',       avg7Key: 'average_spo2_7d',       avg30Key: 'average_spo2_30d',       unit: '%',     emptyLabel: 'SpO2' },
    stress: { title: 'Stress Level', historyKey: 'stress_history_7d',     avg7Key: 'average_stress_7d',     avg30Key: 'average_stress_30d',     unit: '/ 100', emptyLabel: 'stress' }
};

function formatVitalAvg(value) {
    if (value == null || !Number.isFinite(Number(value)) || Number(value) === 0) return '\u2014';
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

    const history = Array.isArray(data?.[spec.historyKey]) ? data[spec.historyKey] : [];
    const chartEl = window.WGVitalsChart
        ? window.WGVitalsChart.render({ history, range, vital })
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
        await window.DataStore.loadSWR({
            key: 'health_overview',
            tags: ['health'],
            fetcher: async () => await window.apiCall('/api/health/overview', 'GET'),
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
    }
}

function renderSleepChart(stats) {
    const container = document.getElementById('sleepChartContainer');
    if (!container) return;
    const totalWidth = container.clientWidth;
    const leftPadding = 35, rightPadding = 20, topPadding = 20, bottomPadding = 30;
    const chartWidth = totalWidth - leftPadding - rightPadding;
    const chartHeight = container.clientHeight - topPadding - bottomPadding;
    if (chartWidth <= 0 || chartHeight <= 0) return;
    const maxMins = Math.max(...stats.map(d => d.total_mins || 0), 1);
    const hrValues = stats.map(d => d.heart_rate_avg || 0).filter(v => v > 0);
    const minHR = hrValues.length ? Math.min(...hrValues) - 5 : 40;
    const maxHR = hrValues.length ? Math.max(...hrValues) + 5 : 100;
    const hrRange = Math.max(maxHR - minHR, 1);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", `0 0 ${totalWidth} ${container.clientHeight}`);
    svg.classList.add('svg-chart');
    const barWidth = Math.min((chartWidth / stats.length) * 0.8, 40);
    const spacing = (chartWidth - (barWidth * stats.length)) / (stats.length || 1);
    const colors = { deep: '#5a2d9c', light: '#2481cc', rem: '#c161d9', awake: '#e5b220' };
    const yAxisLabels = [1, 3, 5, 8, 10];
    const visibleLabels = yAxisLabels.filter(h => h * 60 <= maxMins + 60);
    visibleLabels.forEach((h, idx) => {
        const mins = h * 60;
        const y = topPadding + chartHeight - (mins / maxMins) * chartHeight;
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", leftPadding - 8); text.setAttribute("y", y + 4);
        text.setAttribute("text-anchor", "end"); text.setAttribute("fill", "var(--hint-color)");
        text.setAttribute("font-size", "10px"); text.textContent = h + "h";
        svg.appendChild(text);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", leftPadding); line.setAttribute("y1", y); line.setAttribute("x2", leftPadding - 3); line.setAttribute("y2", y);
        line.setAttribute("stroke", "var(--hint-color)"); svg.appendChild(line);
        // Skip outermost grid lines to avoid box feel
        if (idx > 0 && idx < visibleLabels.length - 1) {
            const gridLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
            gridLine.setAttribute("x1", leftPadding); gridLine.setAttribute("y1", y); gridLine.setAttribute("x2", leftPadding + chartWidth); gridLine.setAttribute("y2", y);
            gridLine.setAttribute("class", "chart-grid-refined"); svg.appendChild(gridLine);
        }
    });
    const daysMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let hrPoints = [];
    stats.forEach((dayStat, i) => {
        const xCenter = leftPadding + (spacing / 2) + (i * (barWidth + spacing)) + barWidth / 2;
        const xLeft = xCenter - barWidth / 2;
        let currentY = topPadding + chartHeight;
        const drawSegment = (mins, color) => {
            if (!mins) return;
            const h = (mins / maxMins) * chartHeight;
            const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            rect.setAttribute("x", xLeft); rect.setAttribute("y", currentY - h); rect.setAttribute("width", barWidth); rect.setAttribute("height", h);
            rect.setAttribute("fill", color); svg.appendChild(rect); currentY -= h;
        };
        drawSegment(dayStat.deep_mins, colors.deep); drawSegment(dayStat.awake_mins, colors.awake); drawSegment(dayStat.light_mins, colors.light); drawSegment(dayStat.rem_mins, colors.rem);
        if (dayStat.total_mins > 0) {
            const hrs = Math.floor(dayStat.total_mins / 60), ms = dayStat.total_mins % 60;
            const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
            lbl.setAttribute("x", xCenter); lbl.setAttribute("y", currentY - 5); lbl.setAttribute("text-anchor", "middle");
            lbl.setAttribute("fill", "var(--text-color)"); lbl.setAttribute("font-size", "11px"); lbl.textContent = `${hrs}:${ms.toString().padStart(2, '0')}`;
            svg.appendChild(lbl);
        }
        const dateObj = new Date(dayStat.date + 'T12:00:00'); let dayName = daysMap[dateObj.getDay()]; if (i === stats.length - 1) dayName = "Today";
        const xLbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        xLbl.setAttribute("x", xCenter); xLbl.setAttribute("y", topPadding + chartHeight + 15); xLbl.setAttribute("text-anchor", "middle");
        xLbl.setAttribute("fill", "var(--hint-color)"); xLbl.setAttribute("font-size", "11px"); xLbl.textContent = dayName; svg.appendChild(xLbl);
        if (dayStat.heart_rate_avg > 0) {
            const yHR = topPadding + chartHeight - ((dayStat.heart_rate_avg - minHR) / hrRange) * chartHeight;
            hrPoints.push({ x: xCenter, y: yHR, val: dayStat.heart_rate_avg });
        }
    });
    if (hrPoints.length > 1) {
        const pathLine = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const pathData = hrPoints.map((p, i) => (i === 0 ? `M ${p.x},${p.y}` : `L ${p.x},${p.y}`)).join(" ");
        pathLine.setAttribute("d", pathData); pathLine.setAttribute("fill", "none"); pathLine.setAttribute("stroke", "#ff3b30"); pathLine.setAttribute("stroke-width", "2");
        svg.appendChild(pathLine);
        window.ChartUtils.animateLine(pathLine);
    }
    hrPoints.forEach(p => {
        const cOut = document.createElementNS("http://www.w3.org/2000/svg", "circle"); cOut.setAttribute("cx", p.x); cOut.setAttribute("cy", p.y); cOut.setAttribute("r", "4"); cOut.setAttribute("fill", "var(--bg-color)"); svg.appendChild(cOut);
        const cIn = document.createElementNS("http://www.w3.org/2000/svg", "circle"); cIn.setAttribute("cx", p.x); cIn.setAttribute("cy", p.y); cIn.setAttribute("r", "2"); cIn.setAttribute("fill", "#ff3b30"); svg.appendChild(cIn);
        const bg = document.createElementNS("http://www.w3.org/2000/svg", "text"); bg.setAttribute("x", p.x); bg.setAttribute("y", p.y - 8); bg.setAttribute("text-anchor", "middle"); bg.setAttribute("stroke", "var(--bg-color)"); bg.setAttribute("stroke-width", "3"); bg.setAttribute("font-size", "10px"); bg.setAttribute("font-weight", "bold"); bg.textContent = p.val; svg.appendChild(bg);
        const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text"); lbl.setAttribute("x", p.x); lbl.setAttribute("y", p.y - 8); lbl.setAttribute("text-anchor", "middle"); lbl.setAttribute("fill", "#ff3b30"); lbl.setAttribute("font-size", "10px"); lbl.setAttribute("font-weight", "bold"); lbl.textContent = p.val; svg.appendChild(lbl);
    });
    container.appendChild(svg);
}

function renderStepsChart(stats) {
    const container = document.getElementById('stepsChartContainer');
    if (!container) return;
    const totalWidth = container.clientWidth;
    const leftPadding = 35, rightPadding = 20, topPadding = 20, bottomPadding = 30;
    const chartWidth = totalWidth - leftPadding - rightPadding;
    const chartHeight = container.clientHeight - topPadding - bottomPadding;
    if (chartWidth <= 0 || chartHeight <= 0) return;
    const maxSteps = Math.max(...stats.map(d => d.steps || 0), 1000);
    const yMax = maxSteps * 1.1;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", `0 0 ${totalWidth} ${container.clientHeight}`);
    svg.classList.add('svg-chart');
    const barWidth = Math.min((chartWidth / stats.length) * 0.8, 40);
    const spacing = (chartWidth - (barWidth * stats.length)) / (stats.length || 1);
    const stepColor = '#34c759';
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
        const val = Math.round((i / ySteps) * yMax);
        const y = topPadding + chartHeight - (i / ySteps) * chartHeight;
        let valStr = val >= 1000 ? Math.round(val / 1000) + 'k' : val.toString();
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", leftPadding - 8); text.setAttribute("y", y + 4); text.setAttribute("text-anchor", "end");
        text.setAttribute("fill", "var(--hint-color)"); text.setAttribute("font-size", "10px"); text.textContent = valStr;
        svg.appendChild(text);
        // Skip outermost grid lines to avoid box feel
        if (i > 0 && i < ySteps) {
            const gridLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
            gridLine.setAttribute("x1", leftPadding); gridLine.setAttribute("y1", y); gridLine.setAttribute("x2", leftPadding + chartWidth); gridLine.setAttribute("y2", y);
            gridLine.setAttribute("class", "chart-grid-refined");
            svg.appendChild(gridLine);
        }
    }
    const daysMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    stats.forEach((dayStat, i) => {
        const xCenter = leftPadding + (spacing / 2) + (i * (barWidth + spacing)) + barWidth / 2;
        const xLeft = xCenter - barWidth / 2;
        const h = Math.max((dayStat.steps / yMax) * chartHeight, 2);
        const yTop = topPadding + chartHeight - h;
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", xLeft); rect.setAttribute("y", yTop); rect.setAttribute("width", barWidth); rect.setAttribute("height", h);
        rect.setAttribute("fill", stepColor); rect.setAttribute("rx", "3"); svg.appendChild(rect);
        if (dayStat.steps > 0) {
            const stepLbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
            let textY = (h > 40) ? yTop + 8 : yTop - 4;
            let textFill = (h > 40) ? "#ffffff" : "var(--text-color)";
            let textAnchor = (h > 40) ? "end" : "start";
            stepLbl.setAttribute("x", xCenter + 3); stepLbl.setAttribute("y", textY);
            stepLbl.setAttribute("text-anchor", textAnchor); stepLbl.setAttribute("fill", textFill);
            stepLbl.setAttribute("font-size", "11px"); stepLbl.setAttribute("font-weight", "500");
            stepLbl.setAttribute("transform", `rotate(-90 ${xCenter + 3} ${textY})`);
            stepLbl.textContent = dayStat.steps.toLocaleString(); svg.appendChild(stepLbl);
        }
        const dateObj = new Date(dayStat.day + 'T12:00:00'); let dayName = daysMap[dateObj.getDay()]; if (i === stats.length - 1) dayName = "Today";
        const xLbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        xLbl.setAttribute("x", xCenter); xLbl.setAttribute("y", topPadding + chartHeight + 15); xLbl.setAttribute("text-anchor", "middle");
        xLbl.setAttribute("fill", "var(--hint-color)"); xLbl.setAttribute("font-size", "11px"); xLbl.textContent = dayName; svg.appendChild(xLbl);
    });
    container.appendChild(svg);
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
        tags: ['notes'],
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
                if (list) list.replaceChildren(createEmptyState('No cached data \u2014 will load when online'));
            }
        }
    });

    const saveBtn = document.getElementById('notes-save-btn');
    if (saveBtn && !saveBtn._noteHandlerAttached) {
        saveBtn._noteHandlerAttached = true;
        saveBtn.addEventListener('click', addNote);
    }
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
        const existing = list.querySelector('.notes-load-more');
        if (existing) existing.remove();
        if (notes.length === 0 && _notesPendingFresh && _notesPendingFresh.generation === myGeneration) {
            // Server returned an empty page 2 — the dataset no longer extends past
            // page 1 (e.g. notes were deleted since caching). Apply the deferred
            // fresh page-1 data to show the correct current state.
            _notesHasLoadedMore = false;
            const pending = _notesPendingFresh.data;
            _notesPendingFresh = null;
            renderNotes(list, pending);
            _notesCursor = pending && pending.length > 0 ? pending[pending.length - 1].id : 0;
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
            // Do not update _notesCursor here — it was already advanced to the last
            // page-2 ID at line 3170. Overwriting with freshLastID (page-1 boundary)
            // would cause the next "load more" to re-fetch page-2.
            // renderNotes may have added a "Load more" button at the end of page-1;
            // remove it before appending the page-2 items below.
            list.querySelector('.notes-load-more')?.remove();
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

function renderNotes(list, notes) {
    list.replaceChildren();
    if (!notes || notes.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'notes-empty';
        empty.textContent = 'No notes yet.';
        list.appendChild(empty);
        return;
    }
    appendNotes(list, notes);
}

function appendNotes(list, notes) {
    notes.forEach(note => {
        const li = document.createElement('li');
        li.className = 'notes-item';

        const meta = document.createElement('div');
        meta.className = 'notes-meta';
        const d = new Date(note.created_at);
        meta.textContent = d.toLocaleString();

        const content = document.createElement('div');
        content.className = 'notes-content';
        content.textContent = note.content;

        const delBtn = createDeleteButton(() => deleteNote(note.id));

        li.appendChild(meta);
        li.appendChild(content);
        li.appendChild(delBtn);
        list.appendChild(li);
    });

    if (notes.length === NOTES_PAGE_SIZE) {
        const li = document.createElement('li');
        li.className = 'notes-load-more';
        const btn = document.createElement('button');
        btn.textContent = 'Load more';
        btn.addEventListener('click', loadMoreNotes);
        li.appendChild(btn);
        list.appendChild(li);
    }
}

async function addNote() {
    const textarea = document.getElementById('notes-textarea');
    if (!textarea) return;
    const content = textarea.value.trim();
    if (!content) return;
    if (content.length > 10000) {
        safeAlert('Note is too long (max 10,000 characters).');
        return;
    }

    const res = await apiCall('/api/notes', 'POST', { content });
    if (res) {
        textarea.value = '';
        await window.DataStore.invalidateTags(['notes']);
        loadNotes();
    }
}

async function deleteNote(id) {
    await safeConfirm('Delete this note?', async (ok) => {
        if (ok) {
            const res = await apiCall(`/api/notes/${id}`, 'DELETE');
            if (res !== null) {
                await window.DataStore.invalidateTags(['notes']);
                loadNotes();
            }
        }
    });
}
