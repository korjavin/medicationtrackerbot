// Wandergeek Sleep chart — deterministic SVG renderer for the 7d / 30d sleep
// stacked-bar view with an HR line overlay. Ports the bespoke renderSleepChart
// from features/health.js under the shared component conventions:
//
//   • No inline stroke=/fill= on paths, rects or circles. Every visual value
//     comes from a CSS token via a class on the SVG child element
//     (`.wg-sleep-chart__stage--{deep|light|rem|awake}`, `__hr-line`,
//     `__hr-dot`, `__hr-label`, `__guide`, `__axis-label`, `__bar-label`,
//     `__day-label`).
//   • Reuses window.ChartUtils.animateLine when available for the HR
//     overlay path animation.
//
// API:
//   WGSleepChart.render({ stats, range, width, height }) → Element
//
//   stats  — Array<{
//              date: 'YYYY-MM-DD' (or Date),
//              total_mins, deep_mins, light_mins, rem_mins, awake_mins,
//              heart_rate_avg?
//            }>. Empty / invalid input returns an empty-state card element.
//   range  — '7d' | '30d' | 'all' (default 'all'); filters entries to the
//            most recent N days, anchored on Date.now(). Forwarded in the
//            dataset only; stacked-bar layout does not otherwise change.
//   width  — coord-space width (default 358; SVG scales to container).
//   height — coord-space height (default 240 — tall variant).
//
// Empty-state returns a <div class="wg-sleep-chart wg-sleep-chart--empty">
// carrying the "No sleep data yet" copy. The data path returns an
// <svg class="wg-sleep-chart"> directly. Consumers style either via the
// shared `.wg-sleep-chart` class plus modifiers.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const DEFAULT_WIDTH = 358;
    const DEFAULT_HEIGHT = 240;
    const PAD_L = 35;
    const PAD_R = 20;
    const PAD_T = 20;
    const PAD_B = 30;
    const MAX_BAR_WIDTH = 40;
    const BAR_FILL_RATIO = 0.8;
    const Y_AXIS_HOURS = [1, 3, 5, 8, 10];
    const DAYS_MAP = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const HR_DOT_OUTER = 4;
    const HR_DOT_INNER = 2;
    const RANGE_DAYS = {
        '7d': 7,
        '30d': 30,
    };

    function finiteOrDefault(value, fallback) {
        return Number.isFinite(value) ? value : fallback;
    }

    function isToday(date) {
        const now = new Date();
        return date.getFullYear() === now.getFullYear()
            && date.getMonth() === now.getMonth()
            && date.getDate() === now.getDate();
    }

    function toDate(src) {
        if (src instanceof Date) return src;
        if (typeof src === 'string') {
            // "YYYY-MM-DD" → pin to mid-day local so getDay() is stable
            // regardless of the renderer's TZ.
            if (/^\d{4}-\d{2}-\d{2}$/.test(src)) {
                return new Date(`${src}T12:00:00`);
            }
            return new Date(src);
        }
        if (typeof src === 'number') return new Date(src);
        return null;
    }

    function normalize(raw) {
        if (!raw) return null;
        const dateSrc = raw.date != null ? raw.date : raw.day;
        const date = toDate(dateSrc);
        if (!date || Number.isNaN(date.getTime())) return null;
        const total = Number(raw.total_mins);
        if (!Number.isFinite(total)) return null;
        return {
            date,
            total_mins: total,
            deep_mins: Number.isFinite(Number(raw.deep_mins)) ? Number(raw.deep_mins) : 0,
            light_mins: Number.isFinite(Number(raw.light_mins)) ? Number(raw.light_mins) : 0,
            rem_mins: Number.isFinite(Number(raw.rem_mins)) ? Number(raw.rem_mins) : 0,
            awake_mins: Number.isFinite(Number(raw.awake_mins)) ? Number(raw.awake_mins) : 0,
            heart_rate_avg: Number.isFinite(Number(raw.heart_rate_avg)) ? Number(raw.heart_rate_avg) : 0,
        };
    }

    function filterByRange(data, range) {
        if (!range || range === 'all') return data;
        const days = RANGE_DAYS[range];
        if (!days) return data;
        if (data.length === 0) return data;
        // Calendar-day window: the last N days ending at today (inclusive),
        // computed against local midnight boundaries so wall-clock time within
        // the day doesn't shift which entries pass.
        const now = new Date();
        const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
        const cutoff = todayEnd - days * 86400000;
        return data.filter((d) => {
            const t = d.date.getTime();
            return t >= cutoff && t < todayEnd;
        });
    }

    function makeEmptyCard(range) {
        const card = document.createElement('div');
        card.classList.add('wg-sleep-chart', 'wg-sleep-chart--empty');
        card.dataset.sleepRange = range || 'all';
        const msg = document.createElement('span');
        msg.classList.add('wg-sleep-chart__empty-msg');
        msg.textContent = 'No sleep data yet';
        card.appendChild(msg);
        return card;
    }

    function makeRect(x, y, w, h, stage) {
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', x.toFixed(1));
        rect.setAttribute('y', y.toFixed(1));
        rect.setAttribute('width', w.toFixed(1));
        rect.setAttribute('height', h.toFixed(1));
        rect.classList.add('wg-sleep-chart__stage', `wg-sleep-chart__stage--${stage}`);
        return rect;
    }

    function makeText(x, y, cls, value) {
        const el = document.createElementNS(SVG_NS, 'text');
        el.setAttribute('x', String(x));
        el.setAttribute('y', String(y));
        el.setAttribute('text-anchor', 'middle');
        el.classList.add(cls);
        el.textContent = String(value);
        return el;
    }

    function makeAxisLabel(x, y, value) {
        const el = document.createElementNS(SVG_NS, 'text');
        el.setAttribute('x', String(x));
        el.setAttribute('y', String(y));
        el.setAttribute('text-anchor', 'end');
        el.classList.add('wg-sleep-chart__axis-label');
        el.textContent = String(value);
        return el;
    }

    function makeGuide(x1, x2, y) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', String(x1));
        line.setAttribute('x2', String(x2));
        line.setAttribute('y1', y.toFixed(1));
        line.setAttribute('y2', y.toFixed(1));
        line.classList.add('wg-sleep-chart__guide');
        return line;
    }

    function makeTickMark(x1, x2, y) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', String(x1));
        line.setAttribute('x2', String(x2));
        line.setAttribute('y1', y.toFixed(1));
        line.setAttribute('y2', y.toFixed(1));
        line.classList.add('wg-sleep-chart__tick');
        return line;
    }

    function renderSleepChart(opts) {
        const options = opts || {};
        const range = typeof options.range === 'string' ? options.range : 'all';
        const rawStats = Array.isArray(options.stats) ? options.stats : [];
        if (rawStats.length === 0) return makeEmptyCard(range);

        const normalized = rawStats.map(normalize).filter(Boolean);
        if (normalized.length === 0) return makeEmptyCard(range);

        normalized.sort((a, b) => a.date - b.date);
        const data = options.prefiltered ? normalized : filterByRange(normalized, range);
        if (data.length === 0) return makeEmptyCard(range);

        const width = finiteOrDefault(options.width, DEFAULT_WIDTH);
        const height = finiteOrDefault(options.height, DEFAULT_HEIGHT);
        const plotW = width - PAD_L - PAD_R;
        const plotH = height - PAD_T - PAD_B;

        const maxMins = Math.max(1, ...data.map((d) => d.total_mins || 0));
        const hrValues = data.map((d) => d.heart_rate_avg).filter((v) => v > 0);
        const minHR = hrValues.length ? Math.min(...hrValues) - 5 : 40;
        const maxHR = hrValues.length ? Math.max(...hrValues) + 5 : 100;
        const hrRange = Math.max(maxHR - minHR, 1);

        const barWidth = Math.min((plotW / data.length) * BAR_FILL_RATIO, MAX_BAR_WIDTH);
        const spacing = (plotW - (barWidth * data.length)) / (data.length || 1);

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', 'auto');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('wg-sleep-chart');
        svg.dataset.sleepRange = range;
        svg.dataset.sleepPointCount = String(data.length);

        // Y-axis labels + guide grid + tick marks.
        const visibleLabels = Y_AXIS_HOURS.filter((h) => h * 60 <= maxMins + 60);
        svg.dataset.sleepTickCount = String(Math.max(0, visibleLabels.length - 2));
        visibleLabels.forEach((h, idx) => {
            const mins = h * 60;
            const y = PAD_T + plotH - (mins / maxMins) * plotH;
            svg.appendChild(makeAxisLabel(PAD_L - 8, y + 4, `${h}h`));
            svg.appendChild(makeTickMark(PAD_L, PAD_L - 3, y));
            // Skip outermost grid lines to avoid box feel.
            if (idx > 0 && idx < visibleLabels.length - 1) {
                svg.appendChild(makeGuide(PAD_L, PAD_L + plotW, y));
            }
        });

        const hrPoints = [];
        data.forEach((dayStat, i) => {
            const xCenter = PAD_L + (spacing / 2) + (i * (barWidth + spacing)) + barWidth / 2;
            const xLeft = xCenter - barWidth / 2;
            let currentY = PAD_T + plotH;

            const drawSegment = (mins, stage) => {
                if (!mins || mins <= 0) return;
                const h = (mins / maxMins) * plotH;
                svg.appendChild(makeRect(xLeft, currentY - h, barWidth, h, stage));
                currentY -= h;
            };
            drawSegment(dayStat.deep_mins, 'deep');
            drawSegment(dayStat.awake_mins, 'awake');
            drawSegment(dayStat.light_mins, 'light');
            drawSegment(dayStat.rem_mins, 'rem');

            if (dayStat.total_mins > 0) {
                const hrs = Math.floor(dayStat.total_mins / 60);
                const ms = dayStat.total_mins % 60;
                const label = `${hrs}:${ms.toString().padStart(2, '0')}`;
                svg.appendChild(makeText(xCenter, currentY - 5, 'wg-sleep-chart__bar-label', label));
            }

            const dayName = isToday(dayStat.date)
                ? 'Today'
                : DAYS_MAP[dayStat.date.getDay()];
            svg.appendChild(makeText(
                xCenter,
                PAD_T + plotH + 15,
                'wg-sleep-chart__day-label',
                dayName,
            ));

            if (dayStat.heart_rate_avg > 0) {
                const yHR = PAD_T + plotH - ((dayStat.heart_rate_avg - minHR) / hrRange) * plotH;
                hrPoints.push({ x: xCenter, y: yHR, val: dayStat.heart_rate_avg });
            }
        });

        if (hrPoints.length > 1) {
            const path = document.createElementNS(SVG_NS, 'path');
            const d = hrPoints
                .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)},${p.y.toFixed(1)}`)
                .join(' ');
            path.setAttribute('d', d);
            path.classList.add('wg-sleep-chart__hr-line');
            svg.appendChild(path);
            if (window.ChartUtils && typeof window.ChartUtils.animateLine === 'function') {
                window.ChartUtils.animateLine(path);
            }
        }

        hrPoints.forEach((p) => {
            const outer = document.createElementNS(SVG_NS, 'circle');
            outer.setAttribute('cx', p.x.toFixed(1));
            outer.setAttribute('cy', p.y.toFixed(1));
            outer.setAttribute('r', String(HR_DOT_OUTER));
            outer.classList.add('wg-sleep-chart__hr-dot-outer');
            svg.appendChild(outer);

            const inner = document.createElementNS(SVG_NS, 'circle');
            inner.setAttribute('cx', p.x.toFixed(1));
            inner.setAttribute('cy', p.y.toFixed(1));
            inner.setAttribute('r', String(HR_DOT_INNER));
            inner.classList.add('wg-sleep-chart__hr-dot');
            svg.appendChild(inner);

            svg.appendChild(makeText(p.x, p.y - 8, 'wg-sleep-chart__hr-label', p.val));
        });

        return svg;
    }

    window.WGSleepChart = {
        render: renderSleepChart,
        DEFAULT_WIDTH,
        DEFAULT_HEIGHT,
    };
})();
