// Today dashboard — pure aggregation contract.
//
// aggregateToday(bootstrap, swrCaches, now) returns a flat object where each
// field is `{ value, deeplink, status }`.  The renderer decides how to display
// each field from `status` alone, so state derivation stays out of the view.
//
// Status values:
//   'ok'       — data present and fresh
//   'missing'  — feature enabled, but no data to show yet
//   'stale'    — cached data older than the freshness window
//   'overdue'  — a scheduled event has passed without being acted on
//   'disabled' — the feature is disabled; caller should omit the card
//
// The function is pure and synchronous.  Date.now() is injected as the third
// argument to keep tests deterministic.

(function () {
    const FRESHNESS_MS = 60 * 60 * 1000; // 1h — base freshness window (SWR offline banner)
    const BP_STALE_MS = 24 * 60 * 60 * 1000; // a BP reading older than a day is stale
    const WEIGHT_STALE_MS = 7 * 24 * 60 * 60 * 1000; // weight is stale after a week
    const SLEEP_RECENT_MS = 2 * 24 * 60 * 60 * 1000; // sleep entry older than ~2d is stale
    const OVERDUE_GRACE_MS = 5 * 60 * 1000; // next med treated as overdue after 5 min
    const MIN_TREND_POINTS = 2;

    function cell(value, deeplink, status) {
        return { value, deeplink, status };
    }

    function greetingFor(now) {
        const hour = now.getHours();
        if (hour < 5) return 'Good night';
        if (hour < 12) return 'Good morning';
        if (hour < 18) return 'Good afternoon';
        return 'Good evening';
    }

    function pickFeature(features, key) {
        if (!features || typeof features !== 'object') return true; // default-on
        return features[key] !== false;
    }

    function latestOf(list, pickTime) {
        if (!Array.isArray(list) || list.length === 0) return null;
        let latest = null;
        let latestMs = -Infinity;
        for (const row of list) {
            const t = Date.parse(pickTime(row));
            if (!Number.isFinite(t)) continue;
            if (t > latestMs) {
                latestMs = t;
                latest = row;
            }
        }
        return latest ? { row: latest, ms: latestMs } : null;
    }

    function trendDirection(first, last) {
        const delta = last - first;
        const epsilon = Math.max(Math.abs(first), Math.abs(last)) * 0.005;
        if (Math.abs(delta) <= epsilon) return 'flat';
        return delta > 0 ? 'up' : 'down';
    }

    // Returns the two anchor points for a 7-day comparison: oldest within the
    // 7-day window and the most recent.  Returns null when fewer than
    // MIN_TREND_POINTS usable samples exist.
    function sevenDayAnchors(list, pickTime, pickValue, nowMs) {
        if (!Array.isArray(list)) return null;
        const cutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
        const pts = [];
        for (const row of list) {
            const t = Date.parse(pickTime(row));
            if (!Number.isFinite(t)) continue;
            const v = pickValue(row);
            if (!Number.isFinite(v)) continue;
            pts.push({ t, v });
        }
        if (pts.length < MIN_TREND_POINTS) return null;
        pts.sort((a, b) => a.t - b.t);
        const recent = pts.filter((p) => p.t >= cutoff);
        if (recent.length < MIN_TREND_POINTS) return null;
        return {
            first: recent[0],
            last: recent[recent.length - 1],
            points: recent.map((p) => p.v)
        };
    }

    function nextMedCell(bootstrap, nowMs, enabled) {
        if (!enabled) return cell(null, 'meds', 'disabled');
        const nx = bootstrap && bootstrap.next_intake;
        if (!nx || !nx.scheduled_at) return cell(null, 'meds', 'missing');
        const at = Date.parse(nx.scheduled_at);
        if (!Number.isFinite(at)) return cell(null, 'meds', 'missing');
        const names = Array.isArray(nx.medication_names) ? nx.medication_names : [];
        const value = { scheduledAt: nx.scheduled_at, names };
        const status = at + OVERDUE_GRACE_MS < nowMs ? 'overdue' : 'ok';
        return cell(value, 'meds', status);
    }

    function bpLatestCell(bootstrap, nowMs, enabled) {
        if (!enabled) return cell(null, 'bp', 'disabled');
        const readings = bootstrap && bootstrap.bp && bootstrap.bp.readings;
        const latest = latestOf(readings, (r) => r.measured_at);
        if (!latest) return cell(null, 'bp', 'missing');
        const value = {
            systolic: latest.row.systolic,
            diastolic: latest.row.diastolic,
            measured_at: latest.row.measured_at
        };
        const status = nowMs - latest.ms > BP_STALE_MS ? 'stale' : 'ok';
        return cell(value, 'bp', status);
    }

    function bpTrendCell(bootstrap, nowMs, enabled) {
        if (!enabled) return cell(null, 'bp', 'disabled');
        const readings = bootstrap && bootstrap.bp && bootstrap.bp.readings;
        const sys = sevenDayAnchors(readings, (r) => r.measured_at, (r) => r.systolic, nowMs);
        const dia = sevenDayAnchors(readings, (r) => r.measured_at, (r) => r.diastolic, nowMs);
        if (!sys || !dia) return cell(null, 'bp', 'missing');
        const value = {
            systolicDirection: trendDirection(sys.first.v, sys.last.v),
            systolicDelta: Math.round((sys.last.v - sys.first.v) * 10) / 10,
            diastolicDirection: trendDirection(dia.first.v, dia.last.v),
            diastolicDelta: Math.round((dia.last.v - dia.first.v) * 10) / 10,
            systolicPoints: sys.points
        };
        return cell(value, 'bp', 'ok');
    }

    function weightLatestCell(bootstrap, nowMs, enabled) {
        if (!enabled) return cell(null, 'weight', 'disabled');
        const logs = bootstrap && bootstrap.weight && bootstrap.weight.logs;
        const latest = latestOf(logs, (r) => r.measured_at);
        if (!latest) return cell(null, 'weight', 'missing');
        const value = {
            weight: latest.row.weight,
            measured_at: latest.row.measured_at
        };
        const status = nowMs - latest.ms > WEIGHT_STALE_MS ? 'stale' : 'ok';
        return cell(value, 'weight', status);
    }

    function weightTrendCell(bootstrap, nowMs, enabled) {
        if (!enabled) return cell(null, 'weight', 'disabled');
        const logs = bootstrap && bootstrap.weight && bootstrap.weight.logs;
        const anchors = sevenDayAnchors(logs, (r) => r.measured_at, (r) => r.weight, nowMs);
        if (!anchors) return cell(null, 'weight', 'missing');
        const value = {
            direction: trendDirection(anchors.first.v, anchors.last.v),
            delta: Math.round((anchors.last.v - anchors.first.v) * 10) / 10,
            points: anchors.points
        };
        return cell(value, 'weight', 'ok');
    }

    function caloriesTodayCell(bootstrap, swrCaches, nowMs, enabled) {
        if (!enabled) return cell(null, 'food', 'disabled');
        const food = swrCaches && swrCaches.food_today;
        if (!food || !Array.isArray(food.groups) || food.groups.length === 0) {
            return cell(0, 'food', 'missing');
        }
        let cals = 0;
        for (const g of food.groups) {
            if (Number.isFinite(g.calories)) cals += g.calories;
        }
        return cell(Math.round(cals), 'food', 'ok');
    }

    function caloriesTargetCell(bootstrap, enabled) {
        if (!enabled) return cell(null, 'food', 'disabled');
        const t = bootstrap && bootstrap.settings && bootstrap.settings.food_targets;
        if (!t || !Number.isFinite(t.calories) || t.calories <= 0) {
            return cell(null, 'food', 'missing');
        }
        return cell(t.calories, 'food', 'ok');
    }

    function macrosTodayCell(swrCaches, enabled) {
        if (!enabled) return cell(null, 'food', 'disabled');
        const food = swrCaches && swrCaches.food_today;
        if (!food || !Array.isArray(food.groups) || food.groups.length === 0) {
            return cell({ protein: 0, carbs: 0, fat: 0 }, 'food', 'missing');
        }
        let protein = 0, carbs = 0, fat = 0;
        for (const g of food.groups) {
            if (Number.isFinite(g.protein)) protein += g.protein;
            if (Number.isFinite(g.carbs)) carbs += g.carbs;
            if (Number.isFinite(g.fat)) fat += g.fat;
        }
        return cell({
            protein: Math.round(protein),
            carbs: Math.round(carbs),
            fat: Math.round(fat)
        }, 'food', 'ok');
    }

    function macrosTargetCell(bootstrap, enabled) {
        if (!enabled) return cell(null, 'food', 'disabled');
        const t = bootstrap && bootstrap.settings && bootstrap.settings.food_targets;
        if (!t) return cell(null, 'food', 'missing');
        const protein = Number.isFinite(t.protein) && t.protein > 0 ? t.protein : null;
        const carbs = Number.isFinite(t.carbs) && t.carbs > 0 ? t.carbs : null;
        const fat = Number.isFinite(t.fat) && t.fat > 0 ? t.fat : null;
        if (protein == null && carbs == null && fat == null) {
            return cell(null, 'food', 'missing');
        }
        return cell({ protein, carbs, fat }, 'food', 'ok');
    }

    function nextWorkoutCell(swrCaches, enabled) {
        if (!enabled) return cell(null, 'workouts', 'disabled');
        const data = swrCaches && swrCaches.workout_next;
        const session = data && data.session;
        if (!session) return cell(null, 'workouts', 'missing');
        // Real API shape places group_name at the top level of the /workout/sessions/next
        // response; test fixtures historically placed it inside `session`, so we accept both.
        const groupName = (data && data.group_name) || session.group_name || session.group || '';
        const value = {
            scheduled_date: session.scheduled_date,
            scheduled_time: session.scheduled_time,
            group_name: groupName,
            status: session.status,
            is_today: session.is_today === true
        };
        return cell(value, 'workouts', 'ok');
    }

    function sleepLastNightCell(swrCaches, nowMs, enabled) {
        if (!enabled) return cell(null, 'health', 'disabled');
        const overview = swrCaches && swrCaches.health_overview;
        const stats = overview && overview.sleep_stats_7d;
        if (!Array.isArray(stats) || stats.length === 0) {
            return cell(null, 'health', 'missing');
        }
        // Prefer the most recent entry by date; server ordering is not guaranteed.
        let last = null;
        let lastMs = -Infinity;
        for (const row of stats) {
            const dayStr = row && (row.date || row.day);
            const t = dayStr ? Date.parse(dayStr) : NaN;
            if (!Number.isFinite(t)) continue;
            if (t > lastMs) { lastMs = t; last = row; }
        }
        if (!last) last = stats[stats.length - 1];
        // Real API returns total_mins (int); tests historically used total_minutes.
        const totalMinutes = last && (last.total_mins ?? last.total_minutes ?? last.totalMinutes);
        if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
            return cell(null, 'health', 'missing');
        }
        const value = {
            hours: Math.round((totalMinutes / 60) * 10) / 10,
            day: last.date || last.day || ''
        };
        const status = Number.isFinite(lastMs) && (nowMs - lastMs) > SLEEP_RECENT_MS ? 'stale' : 'ok';
        return cell(value, 'health', status);
    }

    function aggregateToday(bootstrap, swrCaches, now) {
        const caches = swrCaches || {};
        const nowDate = now instanceof Date ? now : new Date(now || Date.now());
        const nowMs = nowDate.getTime();
        const features = (bootstrap && bootstrap.features) || {};

        const medEnabled = pickFeature(features, 'medication');
        const bpEnabled = pickFeature(features, 'bp');
        const weightEnabled = pickFeature(features, 'weight');
        const foodEnabled = pickFeature(features, 'food');
        const workoutEnabled = pickFeature(features, 'workout');
        const healthEnabled = pickFeature(features, 'health');

        const result = {
            greeting: cell(greetingFor(nowDate), null, 'ok'),
            nextMed: nextMedCell(bootstrap, nowMs, medEnabled),
            bpLatest: bpLatestCell(bootstrap, nowMs, bpEnabled),
            bpTrend7d: bpTrendCell(bootstrap, nowMs, bpEnabled),
            weightLatest: weightLatestCell(bootstrap, nowMs, weightEnabled),
            weightTrend7d: weightTrendCell(bootstrap, nowMs, weightEnabled),
            caloriesToday: caloriesTodayCell(bootstrap, caches, nowMs, foodEnabled),
            caloriesTarget: caloriesTargetCell(bootstrap, foodEnabled),
            macrosToday: macrosTodayCell(caches, foodEnabled),
            macrosTarget: macrosTargetCell(bootstrap, foodEnabled),
            nextWorkout: nextWorkoutCell(caches, workoutEnabled),
            sleepLastNight: sleepLastNightCell(caches, nowMs, healthEnabled)
        };
        return result;
    }

    // ---- Rendering ----------------------------------------------------------
    //
    // renderToday(state, root, handlers) fills `root` with the Wandergeek
    // Today layout: sun-accent next-action card → vitals grid → fuel card
    // with mini-bars → workout+sleep plan grid → consistency streak card.
    //
    // Rules:
    //  - No inline `style.*` assignments. Dynamic values (mini-bar widths)
    //    ride on SVG attributes, not style.
    //  - Every colour comes from a --wg-* token via a CSS class.
    //  - Icons pulled from window.WGIcons; sparklines from window.WGSparkline.
    // ------------------------------------------------------------------------

    const DAY_IN_MS = 24 * 60 * 60 * 1000;
    const SVG_NS = 'http://www.w3.org/2000/svg';

    function doc() {
        return (typeof document !== 'undefined') ? document : null;
    }

    function fmtTimeHM(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        const h = String(d.getHours()).padStart(2, '0');
        const m = String(d.getMinutes()).padStart(2, '0');
        return `${h}:${m}`;
    }

    function relativeDayLabel(iso, nowMs) {
        if (!iso) return '';
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return '';
        if (t > nowMs) return 'upcoming';
        const dNow = new Date(nowMs);
        const dThen = new Date(t);
        const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const days = Math.round((startOfDay(dNow) - startOfDay(dThen)) / DAY_IN_MS);
        if (days <= 0) return 'today';
        if (days === 1) return 'yesterday';
        return `${days}d ago`;
    }

    function fmtDayLabel(iso) {
        if (!iso) return '';
        const dateOnly = String(iso).split('T')[0];
        const parts = dateOnly.split('-').map(Number);
        let d;
        if (parts.length === 3 && parts.every(Number.isFinite)) {
            d = new Date(parts[0], parts[1] - 1, parts[2]);
        } else {
            const t = Date.parse(iso);
            if (!Number.isFinite(t)) return String(iso);
            d = new Date(t);
        }
        try {
            return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        } catch (_) {
            return d.toISOString().slice(0, 10);
        }
    }

    function iconSvgOrNull(name, size) {
        if (typeof window === 'undefined' || !window.WGIcons || typeof window.WGIcons.iconSvg !== 'function') {
            return null;
        }
        try {
            return window.WGIcons.iconSvg(name, { size: size || 16 });
        } catch (_) {
            return null;
        }
    }

    function sparklineOrNull(points, variant) {
        if (typeof window === 'undefined' || !window.WGSparkline || typeof window.WGSparkline.render !== 'function') {
            return null;
        }
        return window.WGSparkline.render({ points, variant });
    }

    // Private helper used by the vitals grid. Each tile is a single <button>
    // that fires `onClick` when tapped.
    function renderMetricTile({ label, value, valueMuted, unit, statusTag, sparkPoints, variant, deeplink, onClick }) {
        const d = doc();
        const tile = d.createElement('button');
        tile.type = 'button';
        tile.className = 'wg-metric-tile';
        tile.setAttribute('data-deeplink', deeplink || '');
        tile.setAttribute('data-section', deeplink || 'metric');

        const labelEl = d.createElement('span');
        labelEl.className = 'wg-metric-tile__label';
        labelEl.textContent = label;
        tile.appendChild(labelEl);

        const valueEl = d.createElement('span');
        valueEl.className = 'wg-metric-tile__value';
        valueEl.textContent = value != null ? String(value) : '—';
        if (valueMuted != null && valueMuted !== '') {
            const muted = d.createElement('span');
            muted.className = 'wg-metric-tile__value-muted';
            muted.textContent = valueMuted;
            valueEl.appendChild(muted);
        }
        tile.appendChild(valueEl);

        const unitEl = d.createElement('span');
        unitEl.className = 'wg-metric-tile__unit';
        unitEl.textContent = unit || '';
        tile.appendChild(unitEl);

        const sparkSlot = d.createElement('span');
        sparkSlot.className = 'wg-metric-tile__spark';
        const sparkSvg = Array.isArray(sparkPoints) && sparkPoints.length > 0
            ? sparklineOrNull(sparkPoints, variant)
            : null;
        if (sparkSvg) sparkSlot.appendChild(sparkSvg);
        tile.appendChild(sparkSlot);

        const statusSlot = d.createElement('span');
        statusSlot.className = 'wg-metric-tile__status';
        if (statusTag instanceof Node) {
            statusSlot.appendChild(statusTag);
        } else if (typeof statusTag === 'string' && statusTag.length > 0) {
            const tag = d.createElement('span');
            tag.className = 'wg-tag wg-tag--normal';
            tag.textContent = statusTag;
            statusSlot.appendChild(tag);
        }
        tile.appendChild(statusSlot);

        if (typeof onClick === 'function') {
            tile.addEventListener('click', onClick);
        }
        return tile;
    }

    // Private helper for the fuel card's mini-bar stack. Uses an SVG <rect>
    // whose `width` attribute encodes the percentage (not an inline style),
    // so the [style] attribute stays off the DOM.
    function renderMiniBar({ label, pct, variant }) {
        const d = doc();
        const row = d.createElement('div');
        row.className = 'wg-mini-bar';

        const labelEl = d.createElement('span');
        labelEl.className = 'wg-mini-bar__label';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const track = d.createElement('span');
        track.className = 'wg-mini-bar__track';
        const svg = d.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 100 6');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('wg-mini-bar__svg');

        const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
        const rect = d.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', '0');
        rect.setAttribute('y', '0');
        rect.setAttribute('width', String(clamped.toFixed(2)));
        rect.setAttribute('height', '6');
        rect.classList.add('wg-mini-bar__fill');
        if (variant) rect.classList.add(`wg-mini-bar__fill--${variant}`);
        svg.appendChild(rect);
        track.appendChild(svg);
        row.appendChild(track);

        const valueEl = d.createElement('span');
        valueEl.className = 'wg-mini-bar__value';
        valueEl.textContent = `${Math.round(clamped)}%`;
        row.appendChild(valueEl);

        return row;
    }

    function statusTag(kind, text) {
        const span = doc().createElement('span');
        span.className = `wg-tag wg-tag--${kind}`;
        span.textContent = text;
        return span;
    }

    function bpStatusTag(systolic, diastolic) {
        if (!Number.isFinite(systolic) || !Number.isFinite(diastolic)) return null;
        if (systolic >= 140 || diastolic >= 90) return statusTag('alert', 'High');
        if (systolic >= 130 || diastolic >= 85) return statusTag('high', 'Stage 1');
        if (systolic >= 120 || diastolic >= 80) return statusTag('high', 'High-normal');
        return statusTag('normal', 'Normal');
    }

    function fmtCountdown(scheduledAt, nowMs) {
        const at = Date.parse(scheduledAt);
        if (!Number.isFinite(at)) return '';
        const diff = at - nowMs;
        if (diff <= 0) return '';
        const mins = Math.round(diff / 60000);
        if (mins < 60) return `in ${mins}m`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m === 0 ? `in ${h}h` : `in ${h}h ${String(m).padStart(2, '0')}m`;
    }

    // Meds card rendered at the bottom of Today. Wraps the meds summary + a
    // list of scheduled med names. Kept under the `.wg-next-action-card`
    // class so existing deep-link handlers keep working; the surrounding
    // `.wg-today-meds` modifier swaps out the sun-yellow banner background
    // for the plain card surface mandated by the mockup.
    function renderTodayMedsCard(cell, onDeeplink, nowMs) {
        if (!cell || cell.status === 'disabled') return null;
        const d = doc();
        const card = d.createElement('div');
        card.className = 'wg-today-meds wg-next-action-card wg-next-action-card--plain';
        card.setAttribute('data-deeplink', cell.deeplink || 'meds');
        card.setAttribute('data-section', 'next-action');

        const head = d.createElement('div');
        head.className = 'wg-today-meds__head';

        const iconWrap = d.createElement('span');
        iconWrap.className = 'wg-next-action-card__icon';
        const icon = iconSvgOrNull('pill', 17);
        if (icon) iconWrap.appendChild(icon);
        head.appendChild(iconWrap);

        const text = d.createElement('span');
        text.className = 'wg-next-action-card__text';
        const kicker = d.createElement('span');
        kicker.className = 'wg-next-action-card__kicker';
        const value = d.createElement('span');
        value.className = 'wg-next-action-card__value';

        const names = (cell.value && Array.isArray(cell.value.names)) ? cell.value.names : [];

        if (cell.status === 'missing' || !cell.value) {
            kicker.textContent = 'No scheduled doses';
            value.textContent = `${names.length} medication${names.length === 1 ? '' : 's'}`;
        } else {
            const v = cell.value;
            const when = fmtTimeHM(v.scheduledAt);
            const prefix = cell.status === 'overdue' ? 'Overdue' : 'Next';
            const countdown = cell.status === 'overdue' ? '' : fmtCountdown(v.scheduledAt, nowMs);
            const parts = [prefix];
            if (when) parts.push(when);
            if (countdown) parts.push(countdown);
            kicker.textContent = parts.join(' · ');
            value.textContent = `${names.length} medication${names.length === 1 ? '' : 's'}`;
        }
        text.appendChild(kicker);
        text.appendChild(value);
        head.appendChild(text);

        const cta = d.createElement('button');
        cta.type = 'button';
        cta.className = 'wg-next-action-card__cta wg-gloss wg-gloss--sun';
        if (cell.status === 'overdue') {
            cta.textContent = 'Take now';
        } else if (cell.status === 'missing' || !cell.value) {
            cta.textContent = 'Plan';
        } else {
            cta.textContent = 'Take';
        }
        cta.addEventListener('click', (event) => {
            event.stopPropagation();
            if (typeof onDeeplink === 'function') onDeeplink(cell.deeplink || 'meds');
        });
        head.appendChild(cta);
        card.appendChild(head);

        if (names.length > 0) {
            const list = d.createElement('ul');
            list.className = 'wg-today-meds__list';
            for (const name of names) {
                const row = d.createElement('li');
                row.className = 'wg-today-meds__row';
                const dot = d.createElement('span');
                dot.className = 'wg-today-meds__dot';
                const label = d.createElement('span');
                label.className = 'wg-today-meds__name';
                label.textContent = name;
                row.appendChild(dot);
                row.appendChild(label);
                list.appendChild(row);
            }
            card.appendChild(list);
        }

        card.addEventListener('click', () => {
            if (typeof onDeeplink === 'function') onDeeplink(cell.deeplink || 'meds');
        });
        return card;
    }

    function renderShortcutTile(iconName, label, onClick) {
        const d = doc();
        const btn = d.createElement('button');
        btn.type = 'button';
        btn.className = 'wg-shortcut-tile';
        btn.setAttribute('data-section', 'shortcut');

        const iconWrap = d.createElement('span');
        iconWrap.className = 'wg-shortcut-tile__icon';
        const icon = iconSvgOrNull(iconName, 15);
        if (icon) iconWrap.appendChild(icon);
        btn.appendChild(iconWrap);

        const labelEl = d.createElement('span');
        labelEl.className = 'wg-shortcut-tile__label';
        labelEl.textContent = label;
        btn.appendChild(labelEl);

        if (typeof onClick === 'function') {
            btn.addEventListener('click', onClick);
        }
        return btn;
    }

    function renderShortcutRow(state, handlers) {
        const d = doc();
        const row = d.createElement('div');
        row.className = 'wg-today-shortcuts';
        row.setAttribute('data-section', 'shortcuts');

        let added = 0;
        const foodCell = state && state.caloriesTarget;
        if (foodCell && foodCell.status !== 'disabled') {
            row.appendChild(renderShortcutTile('apple', 'Log food', () => {
                if (typeof handlers.onLogFood === 'function') handlers.onLogFood();
            }));
            added += 1;
        }
        const bpCell = state && state.bpLatest;
        if (bpCell && bpCell.status !== 'disabled') {
            row.appendChild(renderShortcutTile('heart', 'Add BP', () => {
                if (typeof handlers.onAddBp === 'function') handlers.onAddBp();
            }));
            added += 1;
        }
        const weightCell = state && state.weightLatest;
        if (weightCell && weightCell.status !== 'disabled') {
            row.appendChild(renderShortcutTile('scale', 'Add weight', () => {
                if (typeof handlers.onAddWeight === 'function') handlers.onAddWeight();
            }));
            added += 1;
        }
        return added > 0 ? row : null;
    }

    function renderBpTile(latest, trend, onDeeplink, nowMs) {
        if (!latest || latest.status === 'disabled') return null;
        let value = '—';
        let muted = '';
        let unit = 'mmHg';
        let tag = null;
        let points = null;
        if (latest.status === 'missing' || !latest.value) {
            unit = 'Log a reading';
        } else {
            const v = latest.value;
            value = String(v.systolic);
            muted = `/${v.diastolic}`;
            unit = `mmHg · ${relativeDayLabel(v.measured_at, nowMs) || 'today'}`;
            tag = bpStatusTag(v.systolic, v.diastolic);
            if (trend && trend.status === 'ok' && trend.value && Array.isArray(trend.value.systolicPoints)) {
                points = trend.value.systolicPoints;
            }
        }
        if (latest.status === 'stale' && tag) tag.textContent = `${tag.textContent} · stale`;
        return renderMetricTile({
            label: 'Blood pressure',
            value,
            valueMuted: muted,
            unit,
            statusTag: tag,
            sparkPoints: points,
            variant: 'sun',
            deeplink: latest.deeplink || 'bp',
            onClick: () => { if (typeof onDeeplink === 'function') onDeeplink(latest.deeplink || 'bp'); },
        });
    }

    function renderWeightTile(latest, trend, onDeeplink, nowMs) {
        if (!latest || latest.status === 'disabled') return null;
        let value = '—';
        let unit = 'kg';
        let tag = null;
        let points = null;
        if (latest.status === 'missing' || !latest.value) {
            unit = 'Log your weight';
        } else {
            const v = latest.value;
            value = String(v.weight);
            unit = `kg · ${relativeDayLabel(v.measured_at, nowMs) || 'today'}`;
            if (trend && trend.status === 'ok' && trend.value) {
                const sign = trend.value.delta > 0 ? '+' : '';
                const label = trend.value.direction === 'flat'
                    ? '7d flat'
                    : `7d ${sign}${trend.value.delta}`;
                tag = statusTag('normal', label);
                if (Array.isArray(trend.value.points)) points = trend.value.points;
            }
        }
        if (latest.status === 'stale') {
            if (tag) {
                tag.textContent = `${tag.textContent} · stale`;
            } else {
                tag = statusTag('high', 'Stale');
            }
        }
        return renderMetricTile({
            label: 'Weight',
            value,
            unit,
            statusTag: tag,
            sparkPoints: points,
            variant: 'mint-soft',
            deeplink: latest.deeplink || 'weight',
            onClick: () => { if (typeof onDeeplink === 'function') onDeeplink(latest.deeplink || 'weight'); },
        });
    }

    function renderFuelCard(today, target, macrosToday, macrosTarget, onDeeplink) {
        if (!today || today.status === 'disabled') return null;
        const d = doc();
        const card = d.createElement('button');
        card.type = 'button';
        card.className = 'wg-fuel-card wg-today-food';
        card.setAttribute('data-deeplink', today.deeplink || 'food');
        card.setAttribute('data-section', 'fuel');

        const header = d.createElement('div');
        header.className = 'wg-fuel-card__header';

        const leftCol = d.createElement('div');
        const total = d.createElement('div');
        total.className = 'wg-fuel-card__total';
        const current = Number.isFinite(today.value) ? today.value : 0;
        total.textContent = String(current);
        const unit = d.createElement('span');
        unit.className = 'wg-fuel-card__total-unit';
        const targetValue = (target && target.status === 'ok' && Number.isFinite(target.value))
            ? target.value
            : null;
        unit.textContent = targetValue ? `/ ${targetValue} kcal` : 'kcal';
        total.appendChild(unit);
        leftCol.appendChild(total);

        const rightCol = d.createElement('div');
        const pct = d.createElement('div');
        pct.className = 'wg-fuel-card__pct';
        const pctValue = targetValue ? Math.round((current / targetValue) * 100) : 0;
        pct.textContent = targetValue ? `${pctValue}%` : '—';
        rightCol.appendChild(pct);
        const pctLabel = d.createElement('div');
        pctLabel.className = 'wg-fuel-card__pct-label';
        pctLabel.textContent = targetValue ? 'of target' : 'No target set';
        rightCol.appendChild(pctLabel);

        header.appendChild(leftCol);
        header.appendChild(rightCol);
        card.appendChild(header);

        const macros = (macrosToday && macrosToday.value) || { protein: 0, carbs: 0, fat: 0 };
        const targets = (macrosTarget && macrosTarget.value) || {};

        const pctOf = (v, t) => {
            if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return 0;
            return Math.max(0, Math.min(100, (v / t) * 100));
        };

        const bars = d.createElement('div');
        bars.className = 'wg-fuel-card__bars';
        bars.appendChild(renderMiniBar({ label: 'Energy', pct: pctValue, variant: 'sun' }));
        bars.appendChild(renderMiniBar({ label: 'Protein', pct: pctOf(macros.protein, targets.protein), variant: 'mint' }));
        bars.appendChild(renderMiniBar({ label: 'Carbs', pct: pctOf(macros.carbs, targets.carbs), variant: 'sage' }));
        bars.appendChild(renderMiniBar({ label: 'Fat', pct: pctOf(macros.fat, targets.fat), variant: 'sun-deep' }));
        card.appendChild(bars);

        card.addEventListener('click', () => {
            if (typeof onDeeplink === 'function') onDeeplink(today.deeplink || 'food');
        });
        return card;
    }

    function renderPlanTile({ iconName, label, value, detail, deeplink, onDeeplink }) {
        const d = doc();
        const tile = d.createElement('button');
        tile.type = 'button';
        tile.className = 'wg-plan-tile';
        tile.setAttribute('data-deeplink', deeplink || '');
        tile.setAttribute('data-section', label.toLowerCase());

        const head = d.createElement('div');
        head.className = 'wg-plan-tile__header';
        const icon = iconSvgOrNull(iconName, 14);
        if (icon) head.appendChild(icon);
        const labelEl = d.createElement('span');
        labelEl.className = 'wg-plan-tile__label';
        labelEl.textContent = label;
        head.appendChild(labelEl);
        tile.appendChild(head);

        const valueEl = d.createElement('div');
        valueEl.className = 'wg-plan-tile__value';
        valueEl.textContent = value || '—';
        tile.appendChild(valueEl);

        const detailEl = d.createElement('div');
        detailEl.className = 'wg-plan-tile__detail';
        detailEl.textContent = detail || '';
        tile.appendChild(detailEl);

        if (typeof onDeeplink === 'function') {
            tile.addEventListener('click', () => onDeeplink(deeplink));
        }
        return tile;
    }

    function renderWorkoutTile(cell, onDeeplink) {
        if (!cell || cell.status === 'disabled') return null;
        let value = 'Not scheduled';
        let detail = '';
        if (cell.status === 'ok' && cell.value) {
            const v = cell.value;
            value = v.group_name || 'Workout';
            const when = v.is_today ? 'today' : fmtDayLabel(v.scheduled_date);
            const time = v.scheduled_time ? ` · ${v.scheduled_time}` : '';
            detail = `${when}${time}`.trim();
        }
        return renderPlanTile({
            iconName: 'dumbbell',
            label: 'Workout',
            value,
            detail,
            deeplink: cell.deeplink || 'workouts',
            onDeeplink,
        });
    }

    function renderSleepTile(cell, onDeeplink) {
        if (!cell || cell.status === 'disabled') return null;
        let value = '—';
        let detail = 'No sleep data';
        if ((cell.status === 'ok' || cell.status === 'stale') && cell.value) {
            const v = cell.value;
            const totalM = Math.round(v.hours * 60);
            const h = Math.floor(totalM / 60);
            const m = totalM % 60;
            value = `${h}h ${String(m).padStart(2, '0')}m`;
            const day = v.day || '';
            detail = cell.status === 'stale'
                ? (day ? `${day} · stale` : 'stale')
                : day;
        }
        return renderPlanTile({
            iconName: 'moon',
            label: 'Sleep',
            value,
            detail,
            deeplink: cell.deeplink || 'health',
            onDeeplink,
        });
    }

    function defaultHandler(name, fallbackTab) {
        return () => {
            if (typeof window !== 'undefined') {
                if (typeof window[name] === 'function') {
                    window[name]();
                    return;
                }
                if (fallbackTab && typeof window.switchTab === 'function') {
                    window.switchTab(fallbackTab);
                }
            }
        };
    }

    function renderToday(state, root, handlers) {
        const d = doc();
        if (!d || !root) return;
        const opts = handlers || {};
        const onDeeplink = opts.onDeeplink || ((target) => {
            if (target && typeof window !== 'undefined' && typeof window.switchTab === 'function') {
                window.switchTab(target);
            }
        });
        const nowMs = (opts.now instanceof Date) ? opts.now.getTime() : (opts.now || Date.now());

        const onLogFood = opts.onLogFood || defaultHandler('showAddFoodModal', 'food');
        const onAddBp = opts.onAddBp || defaultHandler('showBPRecordModal', 'bp');
        const onAddWeight = opts.onAddWeight || defaultHandler('showWeightModal', 'weight');

        root.innerHTML = '';
        root.classList.add('wg-today');
        root.classList.add('today-root');

        if (state && state.__offline && !state.__firstRun) {
            const banner = d.createElement('div');
            banner.className = 'today-offline-banner';
            banner.textContent = 'Offline — showing cached data';
            root.appendChild(banner);
        }

        if (state && state.__firstRun) {
            const empty = d.createElement('div');
            empty.className = 'today-empty today-empty-firstrun';
            empty.textContent = state.__offline
                ? 'Offline — reconnect to load your day'
                : 'Connect to load your day';
            root.appendChild(empty);
            return root;
        }

        let rendered = 0;

        const shortcuts = renderShortcutRow(state, {
            onLogFood, onAddBp, onAddWeight
        });
        if (shortcuts) { root.appendChild(shortcuts); rendered += 1; }

        const bpTile = renderBpTile(state && state.bpLatest, state && state.bpTrend7d, onDeeplink, nowMs);
        const weightTile = renderWeightTile(state && state.weightLatest, state && state.weightTrend7d, onDeeplink, nowMs);
        if (bpTile || weightTile) {
            const grid = d.createElement('div');
            grid.className = 'wg-vitals-grid wg-today-metrics';
            if (bpTile) grid.appendChild(bpTile);
            if (weightTile) grid.appendChild(weightTile);
            root.appendChild(grid);
            rendered += 1;
        }

        const fuelCard = renderFuelCard(
            state && state.caloriesToday,
            state && state.caloriesTarget,
            state && state.macrosToday,
            state && state.macrosTarget,
            onDeeplink
        );
        if (fuelCard) {
            root.appendChild(fuelCard);
            rendered += 1;
        }

        const workoutTile = renderWorkoutTile(state && state.nextWorkout, onDeeplink);
        const sleepTile = renderSleepTile(state && state.sleepLastNight, onDeeplink);
        if (workoutTile || sleepTile) {
            const planGrid = d.createElement('div');
            planGrid.className = 'wg-plan-grid wg-today-wo-sleep';
            if (workoutTile) planGrid.appendChild(workoutTile);
            if (sleepTile) planGrid.appendChild(sleepTile);
            root.appendChild(planGrid);
            rendered += 1;
        }

        const medsCard = renderTodayMedsCard(state && state.nextMed, onDeeplink, nowMs);
        if (medsCard) { root.appendChild(medsCard); rendered += 1; }

        if (rendered === 0) {
            const empty = d.createElement('div');
            empty.className = 'today-empty today-empty-disabled';
            empty.textContent = 'All features are off — enable one in Settings';
            root.appendChild(empty);
        }

        return root;
    }

    // ---- Live updates -------------------------------------------------------
    //
    // subscribe({ onRefresh, target, win }) wires up event listeners so the
    // Today dashboard re-renders when:
    //   - The service worker posts BOOTSTRAP_UPDATED after a stale-while-
    //     revalidate revalidation of /api/bootstrap.
    //   - The DataStore change stream reports invalidated tags relevant to
    //     Today (bp, weight, medications, food, workouts, health) via a
    //     'datastore:changed' CustomEvent on window.
    //   - The window fires 'online' or 'offline' — so the dashboard can toggle
    //     its offline banner and retry fresh data.
    //
    // onRefresh receives { source, tags?, data? } describing the trigger.
    // Returns an unsubscribe function that removes every registered listener.
    //
    // isOfflineStale({ online, cacheTimestamp, now, thresholdMs }) returns
    // true when the app is offline AND the cached data is older than the
    // freshness threshold (default 1h) — used to decide whether to show the
    // offline banner inside the dashboard.
    // ------------------------------------------------------------------------

    // Must match the tag vocabulary emitted by internal/store/migrations/027_add_change_events.sql.
    // Notable: workout uses singular 'workout' (not 'workouts'), intake_log emits 'history',
    // and reminder/settings tables emit 'settings'.
    const RELEVANT_TAGS = ['bp', 'weight', 'medications', 'history', 'food', 'workout', 'health', 'settings'];

    function isOfflineStale(opts) {
        const o = opts || {};
        if (o.online) return false;
        const threshold = Number.isFinite(o.thresholdMs) ? o.thresholdMs : FRESHNESS_MS;
        if (!Number.isFinite(o.cacheTimestamp) || o.cacheTimestamp <= 0) return true;
        const nowMs = Number.isFinite(o.now) ? o.now : Date.now();
        return (nowMs - o.cacheTimestamp) > threshold;
    }

    function subscribe(opts) {
        const options = opts || {};
        const onRefresh = options.onRefresh;
        const win = options.win || (typeof window !== 'undefined' ? window : null);
        const messageTarget = options.target
            || (typeof navigator !== 'undefined' && navigator.serviceWorker)
            || null;

        const offs = [];
        const call = (payload) => {
            if (typeof onRefresh === 'function') {
                try { onRefresh(payload); } catch (_) { /* handler errors are isolated */ }
            }
        };

        if (messageTarget && typeof messageTarget.addEventListener === 'function') {
            const onMessage = (event) => {
                const data = event && event.data;
                if (data && data.type === 'BOOTSTRAP_UPDATED') {
                    call({ source: 'bootstrap', data: data.data });
                }
            };
            messageTarget.addEventListener('message', onMessage);
            offs.push(() => messageTarget.removeEventListener('message', onMessage));
        }

        if (win && typeof win.addEventListener === 'function') {
            const onOnline = () => call({ source: 'online', online: true });
            const onOffline = () => call({ source: 'offline', online: false });
            const onChange = (event) => {
                const detail = event && event.detail;
                const tags = detail && Array.isArray(detail.changedTags) ? detail.changedTags : [];
                const relevant = tags.length === 0 || tags.some((t) => RELEVANT_TAGS.indexOf(t) !== -1);
                if (relevant) call({ source: 'datastore', tags });
            };
            win.addEventListener('online', onOnline);
            win.addEventListener('offline', onOffline);
            win.addEventListener('datastore:changed', onChange);
            offs.push(() => win.removeEventListener('online', onOnline));
            offs.push(() => win.removeEventListener('offline', onOffline));
            offs.push(() => win.removeEventListener('datastore:changed', onChange));
        }

        return () => {
            while (offs.length) {
                const fn = offs.pop();
                try { fn(); } catch (_) { /* ignore */ }
            }
        };
    }

    window.TodayDashboard = {
        aggregateToday,
        renderToday,
        subscribe,
        isOfflineStale,
        FRESHNESS_MS
    };
})();
