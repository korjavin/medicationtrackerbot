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
        return { first: recent[0], last: recent[recent.length - 1] };
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
            diastolicDelta: Math.round((dia.last.v - dia.first.v) * 10) / 10
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
            delta: Math.round((anchors.last.v - anchors.first.v) * 10) / 10
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
            nextWorkout: nextWorkoutCell(caches, workoutEnabled),
            sleepLastNight: sleepLastNightCell(caches, nowMs, healthEnabled)
        };
        return result;
    }

    // ---- Rendering ----------------------------------------------------------
    //
    // renderToday(state, root, handlers) fills `root` with the dashboard DOM.
    // `state` is the object returned by aggregateToday. Cards with status
    // 'disabled' are omitted. Card activation calls handlers.onDeeplink(target).
    //
    // Rules:
    //  - No inline style.* assignments; use CSS classes only.
    //  - Uses existing primitives when applicable (createEmptyState).
    //  - Stroke SVG icons, currentColor, tokens for color.
    // ------------------------------------------------------------------------

    const DAY_IN_MS = 24 * 60 * 60 * 1000;

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

    function svgEl(pathD) {
        const ns = 'http://www.w3.org/2000/svg';
        const d = doc();
        const svg = d.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        const path = d.createElementNS(ns, 'path');
        path.setAttribute('d', pathD);
        svg.appendChild(path);
        return svg;
    }

    function trendArrow(direction) {
        // Stroke-based triangular arrow.  `direction`: 'up' | 'down' | 'flat'
        const span = doc().createElement('span');
        span.className = `today-trend-arrow today-trend-${direction}`;
        if (direction === 'up') {
            span.appendChild(svgEl('M5 15l7-7 7 7'));
        } else if (direction === 'down') {
            span.appendChild(svgEl('M5 9l7 7 7-7'));
        } else {
            span.appendChild(svgEl('M5 12h14'));
        }
        return span;
    }

    function cardShell({ title, status, deeplink }, onDeeplink) {
        const d = doc();
        const actionable = !!(deeplink && typeof onDeeplink === 'function');
        const card = d.createElement(actionable ? 'button' : 'div');
        if (actionable) {
            card.type = 'button';
        } else {
            card.setAttribute('role', 'group');
        }
        card.className = `today-card today-card-${status}`;
        card.setAttribute('data-deeplink', deeplink || '');
        if (status === 'overdue') card.classList.add('today-card-warning');
        if (status === 'stale') card.classList.add('today-card-stale');

        const header = d.createElement('div');
        header.className = 'today-card-header';
        const titleEl = d.createElement('span');
        titleEl.className = 'today-card-title';
        titleEl.textContent = title;
        header.appendChild(titleEl);
        if (status === 'overdue') {
            const badge = d.createElement('span');
            badge.className = 'today-card-badge today-card-badge-warning';
            badge.textContent = 'overdue';
            header.appendChild(badge);
        } else if (status === 'stale') {
            const badge = d.createElement('span');
            badge.className = 'today-card-badge today-card-badge-stale';
            badge.textContent = 'stale';
            header.appendChild(badge);
        }
        card.appendChild(header);

        if (actionable) {
            card.addEventListener('click', () => onDeeplink(deeplink));
        }
        return card;
    }

    function cardBody(card, textNodes) {
        const d = doc();
        const body = d.createElement('div');
        body.className = 'today-card-body';
        for (const node of textNodes) {
            if (node == null) continue;
            if (typeof node === 'string') {
                const span = d.createElement('span');
                span.textContent = node;
                body.appendChild(span);
            } else {
                body.appendChild(node);
            }
        }
        card.appendChild(body);
        return body;
    }

    function cardMissing(card, message) {
        const d = doc();
        const empty = (typeof window !== 'undefined' && typeof window.createEmptyState === 'function')
            ? window.createEmptyState(message, { tag: 'div', className: 'today-card-empty' })
            : null;
        if (empty) {
            card.appendChild(empty);
            return empty;
        }
        const fallback = d.createElement('div');
        fallback.className = 'empty-state-msg today-card-empty';
        fallback.textContent = message;
        card.appendChild(fallback);
        return fallback;
    }

    function renderNextMedCard(cell, onDeeplink, nowMs) {
        if (cell.status === 'disabled') return null;
        const card = cardShell(
            { title: 'Next medication', status: cell.status, deeplink: cell.deeplink },
            onDeeplink
        );
        if (cell.status === 'missing') {
            cardMissing(card, 'No scheduled doses');
            return card;
        }
        const names = (cell.value && Array.isArray(cell.value.names)) ? cell.value.names : [];
        const at = fmtTimeHM(cell.value && cell.value.scheduledAt);
        const primary = doc().createElement('span');
        primary.className = 'today-card-value';
        primary.textContent = at || '—';
        const secondary = doc().createElement('span');
        secondary.className = 'today-card-detail';
        secondary.textContent = names.length > 0 ? names.join(', ') : 'scheduled';
        cardBody(card, [primary, secondary]);
        return card;
    }

    function renderBpCard(latest, trend, onDeeplink, nowMs) {
        if (latest.status === 'disabled') return null;
        const card = cardShell(
            { title: 'Blood pressure', status: latest.status, deeplink: latest.deeplink },
            onDeeplink
        );
        if (latest.status === 'missing') {
            cardMissing(card, 'Log a reading to see it here');
            return card;
        }
        const v = latest.value || {};
        const primary = doc().createElement('span');
        primary.className = 'today-card-value';
        primary.textContent = `${v.systolic}/${v.diastolic}`;
        const secondary = doc().createElement('span');
        secondary.className = 'today-card-detail';
        secondary.textContent = relativeDayLabel(v.measured_at, nowMs);
        cardBody(card, [primary, secondary]);
        if (trend && trend.status === 'ok') {
            const row = doc().createElement('div');
            row.className = 'today-card-trend';
            const dir = trend.value.systolicDirection;
            row.appendChild(trendArrow(dir));
            const label = doc().createElement('span');
            label.className = 'today-card-trend-label';
            const delta = trend.value.systolicDelta;
            const sign = delta > 0 ? '+' : '';
            label.textContent = dir === 'flat' ? '7d flat' : `7d ${sign}${delta}`;
            row.appendChild(label);
            card.appendChild(row);
        }
        return card;
    }

    function renderWeightCard(latest, trend, onDeeplink, nowMs) {
        if (latest.status === 'disabled') return null;
        const card = cardShell(
            { title: 'Weight', status: latest.status, deeplink: latest.deeplink },
            onDeeplink
        );
        if (latest.status === 'missing') {
            cardMissing(card, 'Log your weight to start tracking');
            return card;
        }
        const v = latest.value || {};
        const primary = doc().createElement('span');
        primary.className = 'today-card-value';
        primary.textContent = `${v.weight} kg`;
        const secondary = doc().createElement('span');
        secondary.className = 'today-card-detail';
        secondary.textContent = relativeDayLabel(v.measured_at, nowMs);
        cardBody(card, [primary, secondary]);
        if (trend && trend.status === 'ok') {
            const row = doc().createElement('div');
            row.className = 'today-card-trend';
            const dir = trend.value.direction;
            row.appendChild(trendArrow(dir));
            const label = doc().createElement('span');
            label.className = 'today-card-trend-label';
            const delta = trend.value.delta;
            const sign = delta > 0 ? '+' : '';
            label.textContent = dir === 'flat' ? '7d flat' : `7d ${sign}${delta} kg`;
            row.appendChild(label);
            card.appendChild(row);
        }
        return card;
    }

    function renderCaloriesCard(today, target, onDeeplink) {
        if (today.status === 'disabled') return null;
        const card = cardShell(
            { title: 'Calories today', status: today.status, deeplink: today.deeplink },
            onDeeplink
        );
        const primary = doc().createElement('span');
        primary.className = 'today-card-value';
        const current = Number.isFinite(today.value) ? today.value : 0;
        primary.textContent = String(current);
        cardBody(card, [primary]);
        if (target && target.status === 'ok') {
            const sub = doc().createElement('span');
            sub.className = 'today-card-detail';
            sub.textContent = `of ${target.value} kcal`;
            card.querySelector('.today-card-body').appendChild(sub);
        } else if (today.status === 'missing') {
            const sub = doc().createElement('span');
            sub.className = 'today-card-detail';
            sub.textContent = 'no entries yet';
            card.querySelector('.today-card-body').appendChild(sub);
        }
        return card;
    }

    function fmtDayLabel(iso) {
        if (!iso) return '';
        // `scheduled_date` is a bare YYYY-MM-DD on the API; parsing via Date.parse
        // treats it as UTC midnight, which shifts the rendered day back by one in
        // UTC-negative zones. Reconstruct from y/m/d components for local midnight.
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

    function renderWorkoutCard(cell, onDeeplink) {
        if (cell.status === 'disabled') return null;
        const card = cardShell(
            { title: 'Next workout', status: cell.status, deeplink: cell.deeplink },
            onDeeplink
        );
        if (cell.status === 'missing') {
            cardMissing(card, 'No scheduled workout');
            return card;
        }
        const v = cell.value || {};
        const primary = doc().createElement('span');
        primary.className = 'today-card-value';
        primary.textContent = v.group_name || 'Workout';
        const secondary = doc().createElement('span');
        secondary.className = 'today-card-detail';
        const when = v.is_today ? 'today' : fmtDayLabel(v.scheduled_date);
        const time = v.scheduled_time ? ` · ${v.scheduled_time}` : '';
        secondary.textContent = `${when}${time}`.trim();
        cardBody(card, [primary, secondary]);
        return card;
    }

    function renderSleepCard(cell, onDeeplink) {
        if (cell.status === 'disabled') return null;
        const card = cardShell(
            { title: 'Sleep last night', status: cell.status, deeplink: cell.deeplink },
            onDeeplink
        );
        if (cell.status === 'missing') {
            cardMissing(card, 'No sleep data');
            return card;
        }
        const v = cell.value || {};
        const primary = doc().createElement('span');
        primary.className = 'today-card-value';
        primary.textContent = `${v.hours} h`;
        const secondary = doc().createElement('span');
        secondary.className = 'today-card-detail';
        secondary.textContent = v.day || '';
        cardBody(card, [primary, secondary]);
        return card;
    }

    function buildSettingsGearButton(onSettings) {
        const d = doc();
        const btn = d.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-icon today-settings-gear';
        btn.setAttribute('aria-label', 'Settings');
        const ns = 'http://www.w3.org/2000/svg';
        const svg = d.createElementNS(ns, 'svg');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2.25');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        const circle = d.createElementNS(ns, 'circle');
        circle.setAttribute('cx', '12');
        circle.setAttribute('cy', '12');
        circle.setAttribute('r', '3');
        svg.appendChild(circle);
        const path = d.createElementNS(ns, 'path');
        path.setAttribute('d', 'M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42');
        svg.appendChild(path);
        btn.appendChild(svg);
        btn.addEventListener('click', () => {
            if (typeof onSettings === 'function') onSettings();
        });
        return btn;
    }

    function buildTodayHeader(titleText, onSettings) {
        const d = doc();
        const gear = buildSettingsGearButton(onSettings);
        const factory = (typeof window !== 'undefined' && window.SectionHeader && typeof window.SectionHeader.create === 'function')
            ? window.SectionHeader.create
            : null;
        if (factory) {
            return factory({ title: titleText, onBack: null, rightSlot: gear });
        }
        // Fallback when SectionHeader component isn't loaded (e.g., in isolated unit tests).
        const header = d.createElement('header');
        header.className = 'section-header no-back';
        const titleEl = d.createElement('h2');
        titleEl.className = 'section-title';
        titleEl.textContent = titleText;
        header.appendChild(titleEl);
        const right = d.createElement('div');
        right.className = 'section-header-right';
        right.appendChild(gear);
        header.appendChild(right);
        return header;
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
        const onSettings = opts.onSettings || (() => {
            if (typeof window !== 'undefined' && typeof window.switchTab === 'function') {
                window.switchTab('settings');
            }
        });
        const nowMs = (opts.now instanceof Date) ? opts.now.getTime() : (opts.now || Date.now());

        root.innerHTML = '';
        root.classList.add('today-root');

        const greetingText = (state && state.greeting && state.greeting.value) || 'Today';
        const header = buildTodayHeader(greetingText, onSettings);
        root.appendChild(header);

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

        const grid = d.createElement('div');
        grid.className = 'today-card-grid';
        root.appendChild(grid);

        // Map each card to the `tab_order` key it corresponds to (Design Decision 5:
        // the existing tab_order array now controls Today card order since there's
        // no tab strip to order). DEFAULT_CARD_ORDER is the fallback sequence when
        // no saved order is available or a key is missing from the saved order.
        const cardBuilders = {
            meds: () => renderNextMedCard(state.nextMed, onDeeplink, nowMs),
            bp: () => renderBpCard(state.bpLatest, state.bpTrend7d, onDeeplink, nowMs),
            weight: () => renderWeightCard(state.weightLatest, state.weightTrend7d, onDeeplink, nowMs),
            food: () => renderCaloriesCard(state.caloriesToday, state.caloriesTarget, onDeeplink),
            workouts: () => renderWorkoutCard(state.nextWorkout, onDeeplink),
            health: () => renderSleepCard(state.sleepLastNight, onDeeplink)
        };
        const DEFAULT_CARD_ORDER = ['meds', 'bp', 'weight', 'food', 'workouts', 'health'];
        const savedOrder = Array.isArray(opts.cardOrder) ? opts.cardOrder : null;
        const seen = new Set();
        const finalOrder = [];
        if (savedOrder) {
            for (const key of savedOrder) {
                if (cardBuilders[key] && !seen.has(key)) {
                    finalOrder.push(key);
                    seen.add(key);
                }
            }
        }
        for (const key of DEFAULT_CARD_ORDER) {
            if (!seen.has(key)) {
                finalOrder.push(key);
                seen.add(key);
            }
        }
        const cards = finalOrder.map((key) => cardBuilders[key]());
        let visible = 0;
        for (const c of cards) {
            if (!c) continue;
            grid.appendChild(c);
            visible += 1;
        }
        if (visible === 0) {
            grid.remove();
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
