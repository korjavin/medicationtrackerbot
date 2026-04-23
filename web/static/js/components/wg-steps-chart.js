// Wandergeek Steps chart — deterministic SVG renderer for the 7d / 30d steps
// bar view. Ports the bespoke renderStepsChart from features/health.js under
// the shared component conventions:
//
//   • No inline stroke=/fill= on rects or text. Every visual value resolves
//     via a CSS class on the SVG child element
//     (`.wg-steps-chart__bar`, `__count-label`, `__count-label--inside`,
//     `__guide`, `__axis-label`, `__day-label`).
//
// API:
//   WGStepsChart.render({ stats, range, width, height }) → Element
//
//   stats  — Array<{ day: 'YYYY-MM-DD' (or date), steps: number }>. Empty /
//            invalid input returns an empty-state card element.
//   range  — '7d' | '30d' | 'all' (default 'all'); filters entries to the
//            most recent N days, anchored on Date.now(). Forwarded in the
//            dataset only; bar layout does not otherwise change.
//   width  — coord-space width (default 358; SVG scales to container).
//   height — coord-space height (default 240 — tall variant).
//
// Empty-state returns a <div class="wg-steps-chart wg-steps-chart--empty">
// carrying the "No step data yet" copy. The data path returns an
// <svg class="wg-steps-chart"> directly.

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
    const Y_AXIS_STEPS = 4;
    const DAYS_MAP = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const INSIDE_LABEL_THRESHOLD = 40;
    const RANGE_DAYS = {
        '7d': 7,
        '30d': 30,
    };

    function finiteOrDefault(value, fallback) {
        return Number.isFinite(value) ? value : fallback;
    }

    function toDate(src) {
        if (src instanceof Date) return src;
        if (typeof src === 'string') {
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
        const dateSrc = raw.day != null ? raw.day : raw.date;
        const date = toDate(dateSrc);
        if (!date || Number.isNaN(date.getTime())) return null;
        const steps = Number(raw.steps);
        if (!Number.isFinite(steps)) return null;
        return { date, steps };
    }

    function filterByRange(data, range) {
        if (!range || range === 'all') return data;
        const days = RANGE_DAYS[range];
        if (!days) return data;
        if (data.length === 0) return data;
        const now = Date.now();
        const cutoff = now - days * 86400000;
        return data.filter((d) => {
            const t = d.date.getTime();
            return t >= cutoff && t <= now;
        });
    }

    function makeEmptyCard(range) {
        const card = document.createElement('div');
        card.classList.add('wg-steps-chart', 'wg-steps-chart--empty');
        card.dataset.stepsRange = range || 'all';
        const msg = document.createElement('span');
        msg.classList.add('wg-steps-chart__empty-msg');
        msg.textContent = 'No step data yet';
        card.appendChild(msg);
        return card;
    }

    function makeBar(x, y, w, h) {
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', x.toFixed(1));
        rect.setAttribute('y', y.toFixed(1));
        rect.setAttribute('width', w.toFixed(1));
        rect.setAttribute('height', h.toFixed(1));
        rect.setAttribute('rx', '3');
        rect.classList.add('wg-steps-chart__bar');
        return rect;
    }

    function makeText(x, y, cls, value, { anchor = 'middle', transform = null } = {}) {
        const el = document.createElementNS(SVG_NS, 'text');
        el.setAttribute('x', String(x));
        el.setAttribute('y', String(y));
        el.setAttribute('text-anchor', anchor);
        el.classList.add(cls);
        if (transform) el.setAttribute('transform', transform);
        el.textContent = String(value);
        return el;
    }

    function makeAxisLabel(x, y, value) {
        const el = document.createElementNS(SVG_NS, 'text');
        el.setAttribute('x', String(x));
        el.setAttribute('y', String(y));
        el.setAttribute('text-anchor', 'end');
        el.classList.add('wg-steps-chart__axis-label');
        el.textContent = String(value);
        return el;
    }

    function makeGuide(x1, x2, y) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', String(x1));
        line.setAttribute('x2', String(x2));
        line.setAttribute('y1', y.toFixed(1));
        line.setAttribute('y2', y.toFixed(1));
        line.classList.add('wg-steps-chart__guide');
        return line;
    }

    function formatAxisLabel(value) {
        return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
    }

    function renderStepsChart(opts) {
        const options = opts || {};
        const range = typeof options.range === 'string' ? options.range : 'all';
        const rawStats = Array.isArray(options.stats) ? options.stats : [];
        if (rawStats.length === 0) return makeEmptyCard(range);

        const normalized = rawStats.map(normalize).filter(Boolean);
        if (normalized.length === 0) return makeEmptyCard(range);

        normalized.sort((a, b) => a.date - b.date);
        const data = filterByRange(normalized, range);
        if (data.length === 0) return makeEmptyCard(range);

        const width = finiteOrDefault(options.width, DEFAULT_WIDTH);
        const height = finiteOrDefault(options.height, DEFAULT_HEIGHT);
        const plotW = width - PAD_L - PAD_R;
        const plotH = height - PAD_T - PAD_B;

        const maxSteps = Math.max(1000, ...data.map((d) => d.steps || 0));
        const yMax = maxSteps * 1.1;
        const barWidth = Math.min((plotW / data.length) * BAR_FILL_RATIO, MAX_BAR_WIDTH);
        const spacing = (plotW - (barWidth * data.length)) / (data.length || 1);

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', 'auto');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('wg-steps-chart');
        svg.dataset.stepsRange = range;
        svg.dataset.stepsPointCount = String(data.length);

        // Y-axis labels + inner guide grid. Skip outermost grid lines to avoid
        // box feel, matching the sleep + vitals chart convention.
        const innerTickCount = Math.max(0, Y_AXIS_STEPS - 1);
        svg.dataset.stepsTickCount = String(innerTickCount);
        for (let i = 0; i <= Y_AXIS_STEPS; i++) {
            const val = Math.round((i / Y_AXIS_STEPS) * yMax);
            const y = PAD_T + plotH - (i / Y_AXIS_STEPS) * plotH;
            svg.appendChild(makeAxisLabel(PAD_L - 8, y + 4, formatAxisLabel(val)));
            if (i > 0 && i < Y_AXIS_STEPS) {
                svg.appendChild(makeGuide(PAD_L, PAD_L + plotW, y));
            }
        }

        data.forEach((dayStat, i) => {
            const xCenter = PAD_L + (spacing / 2) + (i * (barWidth + spacing)) + barWidth / 2;
            const xLeft = xCenter - barWidth / 2;
            const h = Math.max((dayStat.steps / yMax) * plotH, 2);
            const yTop = PAD_T + plotH - h;
            svg.appendChild(makeBar(xLeft, yTop, barWidth, h));

            if (dayStat.steps > 0) {
                const inside = h > INSIDE_LABEL_THRESHOLD;
                const textY = inside ? yTop + 8 : yTop - 4;
                const textAnchor = inside ? 'end' : 'start';
                const labelX = xCenter + 3;
                const label = makeText(
                    labelX,
                    textY,
                    'wg-steps-chart__count-label',
                    dayStat.steps.toLocaleString(),
                    {
                        anchor: textAnchor,
                        transform: `rotate(-90 ${labelX} ${textY})`,
                    },
                );
                label.classList.add(inside
                    ? 'wg-steps-chart__count-label--inside'
                    : 'wg-steps-chart__count-label--outside');
                svg.appendChild(label);
            }

            const dayName = (i === data.length - 1)
                ? 'Today'
                : DAYS_MAP[dayStat.date.getDay()];
            svg.appendChild(makeText(
                xCenter,
                PAD_T + plotH + 15,
                'wg-steps-chart__day-label',
                dayName,
            ));
        });

        return svg;
    }

    window.WGStepsChart = {
        render: renderStepsChart,
        DEFAULT_WIDTH,
        DEFAULT_HEIGHT,
    };
})();
