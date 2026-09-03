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

    function cell(value, deeplink, status, meta) {
        const out = { value, deeplink, status };
        if (meta && (meta.fetchedAt != null || meta.isStale != null)) {
            out.meta = {
                fetchedAt: meta.fetchedAt != null ? meta.fetchedAt : null,
                isStale: !!meta.isStale
            };
        }
        return out;
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

    // Find the earliest upcoming scheduled dose across the cached medications
    // list. Groups meds whose next dose lands inside the same minute so the
    // returned value mirrors the server's /api/medications/next-intake shape
    // (multiple meds taken at one slot collapse into one card). Returns null
    // when the helpers aren't available, the list is empty, or no med has a
    // computable next dose. Used as the offline fallback when the cached
    // next_intake response is missing or stale.
    //
    // Course-window filter (start_date / end_date) mirrors medplan.PlanDoses
    // so the offline fallback does not advertise a finished antibiotic course
    // or a med that doesn't start until tomorrow.
    function computeFallbackFromMedications(meds, nowMs, parseSchedule, getNext) {
        if (!Array.isArray(meds) || meds.length === 0) return null;
        if (typeof parseSchedule !== 'function' || typeof getNext !== 'function') return null;
        const nowDate = new Date(nowMs);
        let bestMs = Infinity;
        const candidates = [];
        for (const med of meds) {
            if (!med || med.archived) continue;
            if (typeof med.name !== 'string' || med.id == null) continue;
            const startMs = med.start_date ? Date.parse(med.start_date) : NaN;
            if (Number.isFinite(startMs) && startMs > nowMs) continue;
            const endMs = med.end_date ? Date.parse(med.end_date) : NaN;
            if (Number.isFinite(endMs) && endMs <= nowMs) continue;
            const schedule = parseSchedule(med.schedule);
            if (!schedule) continue;
            const type = schedule.type;
            if (type !== 'daily' && type !== 'weekly') continue;
            const next = getNext(schedule, nowDate);
            if (!next) continue;
            const t = next instanceof Date ? next.getTime() : Date.parse(next);
            if (!Number.isFinite(t)) continue;
            if (Number.isFinite(endMs) && t > endMs) continue;
            candidates.push({ med, t });
            if (t < bestMs) bestMs = t;
        }
        if (!Number.isFinite(bestMs)) return null;
        // Mirror the server's forecastClusterWindow / triggerNextIntakeClusterWindow
        // (10 minutes) so the offline fallback collapses multi-med slots into one
        // card the same way /api/medications/next-intake does.
        const TOL_MS = 10 * 60 * 1000;
        const grouped = candidates
            .filter((c) => c.t - bestMs <= TOL_MS)
            .sort((a, b) => a.t - b.t);
        const earliest = grouped[0];
        return {
            scheduledAt: new Date(earliest.t).toISOString(),
            names: grouped.map((c) => c.med.name),
            ids: grouped.map((c) => c.med.id)
        };
    }

    function nextMedCell(bootstrap, nowMs, enabled, opts) {
        if (!enabled) return cell(null, 'meds', 'disabled');
        const meta = bootstrap && bootstrap.__next_intake_meta;
        const medsMeta = bootstrap && bootstrap.__medications_meta;
        const nx = bootstrap && bootstrap.next_intake;
        // Fall back to computing the next dose from the cached medications list
        // when the server-rendered next_intake is missing entirely, or its
        // cached value is stale (e.g. relaunch-while-offline). A populated
        // next_intake that's still fresh stays authoritative — only the server
        // knows whether the upcoming dose has already been taken in another
        // session.
        const nextIntakeUsable = nx && nx.scheduled_at && (!meta || !meta.isStale);
        if (!nextIntakeUsable) {
            const helpers = opts || {};
            const parseSchedule = helpers.parseMedicationSchedule
                || (typeof window !== 'undefined' ? window.parseMedicationSchedule : null);
            const getNext = helpers.getNextScheduledDate
                || (typeof window !== 'undefined' ? window.getNextScheduledDate : null);
            const meds = bootstrap && bootstrap.medications;
            const fallback = computeFallbackFromMedications(meds, nowMs, parseSchedule, getNext);
            if (fallback) {
                const at = Date.parse(fallback.scheduledAt);
                const status = Number.isFinite(at) && at + OVERDUE_GRACE_MS < nowMs ? 'overdue' : 'ok';
                return cell(fallback, 'meds', status, medsMeta || meta);
            }
        }
        // When next_intake is absent or unparseable, prefer the medications-list
        // freshness if we have it — that's the cache the renderer just consulted
        // via the fallback path, and its provenance is more honest than an
        // undefined next_intake meta.
        if (!nx || !nx.scheduled_at) return cell(null, 'meds', 'missing', meta || medsMeta);
        const at = Date.parse(nx.scheduled_at);
        if (!Number.isFinite(at)) return cell(null, 'meds', 'missing', meta || medsMeta);
        const names = Array.isArray(nx.medication_names) ? nx.medication_names : [];
        const ids = Array.isArray(nx.medication_ids) ? nx.medication_ids : [];
        const value = { scheduledAt: nx.scheduled_at, names, ids };
        const status = at + OVERDUE_GRACE_MS < nowMs ? 'overdue' : 'ok';
        return cell(value, 'meds', status, meta);
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

    // Today gamification rings tile. Reads the slim Plan 2 rings payload
    // ({ enabled, level, today_hp, rings:[{ring,hp}] }) and projects it into a
    // cell the renderer turns into a tappable summary card that deep-links to
    // the Journey screen. `enabled` is the cached feature flag; the payload's
    // own `enabled:false` is honoured too so a lagged flag still hides the tile.
    function gamificationRingsCell(rings, enabled) {
        if (!enabled) return cell(null, 'journey', 'disabled');
        if (rings && rings.enabled === false) return cell(null, 'journey', 'disabled');
        const list = rings && Array.isArray(rings.rings) ? rings.rings : null;
        if (!list || list.length === 0) return cell(null, 'journey', 'missing');
        const hs = rings.health_score;
        const aa = rings.adherence_alert;
        const value = {
            level: Number.isFinite(rings.level) ? rings.level : 0,
            todayHp: Number.isFinite(rings.today_hp) ? rings.today_hp : 0,
            healthScore: { value: (hs && Number.isFinite(hs.value)) ? hs.value : null },
            adherenceAlert: (aa && aa.active) ? { missedDoses: Number(aa.missed_doses) || 0 } : null,
            rings: list
                .filter((r) => r && typeof r.ring === 'string')
                .map((r) => ({
                    ring: r.ring,
                    hp: Number(r.hp) || 0,
                    closed: !!r.closed,
                    progress: Number.isFinite(r.progress) ? r.progress : (r.closed ? 1 : 0),
                    goal: typeof r.goal === 'string' ? r.goal : '',
                    sync_pending: !!r.sync_pending
                }))
        };
        return cell(value, 'journey', 'ok');
    }

    function aggregateToday(bootstrap, swrCaches, now, opts) {
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
        const gamificationEnabled = pickFeature(features, 'gamification');

        const result = {
            greeting: cell(greetingFor(nowDate), null, 'ok'),
            nextMed: nextMedCell(bootstrap, nowMs, medEnabled, opts),
            bpLatest: bpLatestCell(bootstrap, nowMs, bpEnabled),
            bpTrend7d: bpTrendCell(bootstrap, nowMs, bpEnabled),
            weightLatest: weightLatestCell(bootstrap, nowMs, weightEnabled),
            weightTrend7d: weightTrendCell(bootstrap, nowMs, weightEnabled),
            caloriesToday: caloriesTodayCell(bootstrap, caches, nowMs, foodEnabled),
            caloriesTarget: caloriesTargetCell(bootstrap, foodEnabled),
            macrosToday: macrosTodayCell(caches, foodEnabled),
            macrosTarget: macrosTargetCell(bootstrap, foodEnabled),
            nextWorkout: nextWorkoutCell(caches, workoutEnabled),
            sleepLastNight: sleepLastNightCell(caches, nowMs, healthEnabled),
            gamificationRings: gamificationRingsCell(caches.gamification_rings, gamificationEnabled)
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

    // Qualitative band for the 0-100 Health Score composite (Task 8, Oura/Whoop
    // pattern), token-colored via the same wg-tag palette bpStatusTag uses.
    // Duplicated in journey.js rather than shared — same convention as
    // RING_TILE_META (today.js stays self-contained for its pure-render tests).
    function healthScoreBand(value) {
        if (!Number.isFinite(value)) return null;
        if (value >= 70) return { label: 'Good', kind: 'normal' };
        if (value >= 40) return { label: 'Fair', kind: 'high' };
        return { label: 'Needs attention', kind: 'alert' };
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
    function renderTodayMedsCard(cell, onDeeplink, nowMs, isOffline) {
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
            // When offline, the empty next_intake cache may simply mean the
            // bootstrap fetch never landed — be explicit so the user does not
            // assume the schedule is empty.
            kicker.textContent = isOffline ? 'Next dose data unavailable offline' : 'No scheduled doses';
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
            const v = cell.value;
            const canConfirm = v && Array.isArray(v.ids) && v.ids.length > 0
                && (cell.status === 'ok' || cell.status === 'overdue');
            const win = (typeof window !== 'undefined') ? window : null;
            if (canConfirm && win && typeof win.showMedicationConfirmModal === 'function') {
                win.showMedicationConfirmModal(v.ids, v.names || [], v.scheduledAt, 'confirm');
                return;
            }
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
        const rows = [];

        const foodRow = d.createElement('div');
        foodRow.className = 'wg-today-shortcuts wg-today-shortcuts--food';
        foodRow.setAttribute('data-section', 'shortcuts-food');
        const foodCell = state && state.caloriesTarget;
        if (foodCell && foodCell.status !== 'disabled') {
            foodRow.appendChild(renderShortcutTile('apple', 'Log food', () => {
                if (typeof handlers.onLogFood === 'function') handlers.onLogFood();
            }));
            foodRow.appendChild(renderShortcutTile('barcode', 'Scan food', () => {
                if (typeof handlers.onScanFood === 'function') handlers.onScanFood();
            }));
            foodRow.appendChild(renderShortcutTile('camera', 'Photo meal', () => {
                if (typeof handlers.onPhotoMeal === 'function') handlers.onPhotoMeal();
            }));
            rows.push(foodRow);
        }

        const vitalsRow = d.createElement('div');
        vitalsRow.className = 'wg-today-shortcuts wg-today-shortcuts--vitals';
        vitalsRow.setAttribute('data-section', 'shortcuts-vitals');
        let vitalsAdded = 0;
        const bpCell = state && state.bpLatest;
        if (bpCell && bpCell.status !== 'disabled') {
            vitalsRow.appendChild(renderShortcutTile('heart', 'Add BP', () => {
                if (typeof handlers.onAddBp === 'function') handlers.onAddBp();
            }));
            vitalsAdded += 1;
        }
        const weightCell = state && state.weightLatest;
        if (weightCell && weightCell.status !== 'disabled') {
            vitalsRow.appendChild(renderShortcutTile('scale', 'Add weight', () => {
                if (typeof handlers.onAddWeight === 'function') handlers.onAddWeight();
            }));
            vitalsAdded += 1;
        }
        if (vitalsAdded > 0) rows.push(vitalsRow);

        // Doctor brief (med-5k6t.2) — its own row because it is a document
        // action, not a quick-log; renderToday folds that row into the Call
        // agent card's row when the call card is present (med-z8ic), so the
        // two share one line instead of stacking. Shown whenever anything at
        // all is tracked
        // (a meds-only vault still goes to appointments, and it has no BP or
        // food quick-log row to ride on); suppressed in the every-feature-off
        // state, where there is nothing to brief and Today shows its empty
        // placeholder instead, and wherever the caller supplies no handler
        // (bot mode — see renderToday's cloud gate).
        const medsCell = state && state.nextMed;
        if (typeof handlers.onDoctorBrief === 'function'
            && (rows.length > 0 || (medsCell && medsCell.status !== 'disabled'))) {
            const briefRow = d.createElement('div');
            briefRow.className = 'wg-today-shortcuts wg-today-shortcuts--brief';
            briefRow.setAttribute('data-section', 'shortcuts-brief');
            briefRow.appendChild(renderShortcutTile('chart', 'Doctor brief', () => {
                if (typeof handlers.onDoctorBrief === 'function') handlers.onDoctorBrief();
            }));
            rows.push(briefRow);
        }

        return rows.length > 0 ? rows : null;
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
        const preferredUnit = (typeof window !== 'undefined' && window.weightUnitPreference === 'lb') ? 'lb' : 'kg';
        const fmt = (typeof formatWeight === 'function')
            ? formatWeight
            : (kg, u) => ({ value: Number(kg), label: u });
        let value = '—';
        let unit = preferredUnit;
        let tag = null;
        let points = null;
        if (latest.status === 'missing' || !latest.value) {
            unit = 'Log your weight';
        } else {
            const v = latest.value;
            const display = fmt(v.weight, preferredUnit);
            value = String(display.value);
            unit = `${display.label} · ${relativeDayLabel(v.measured_at, nowMs) || 'today'}`;
            if (trend && trend.status === 'ok' && trend.value) {
                const deltaDisplay = fmt(Math.abs(trend.value.delta), preferredUnit);
                const signedDelta = trend.value.delta > 0
                    ? `+${deltaDisplay.value}`
                    : (trend.value.delta < 0 ? `-${deltaDisplay.value}` : `${deltaDisplay.value}`);
                const label = trend.value.direction === 'flat'
                    ? '7d flat'
                    : `7d ${signedDelta}`;
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

    // Ring display metadata for the Today tile, canonical order — the three
    // daily levers (gamification-10 §2.5): a decision made today, not a
    // delayed body signal. Mirrors the RINGS list in features/journey.js —
    // kept as a small local copy rather than reaching into window.Gamification
    // so today.js stays self-contained for the pure-render tests.
    const RING_TILE_META = [
        { ring: 'bedtime', label: 'Bedtime', icon: 'moon' },
        { ring: 'movement', label: 'Movement', icon: 'activity' },
        { ring: 'nourishment', label: 'Nourishment', icon: 'apple' }
    ];

    // "Your move" — the single suggested action to close an open ring. We pick
    // the first ring in canonical order whose `closed` is false. The action
    // deep-links to the section where that ring is logged. No HP number here on
    // purpose: a ring's outcome max lives in the backend scoring Config and
    // would drift if duplicated client-side; the ring name + action is the
    // prompt.
    const RING_MOVE_META = {
        bedtime: { verb: 'Log last night’s sleep', section: 'health' },
        movement: { verb: 'Log a workout', section: 'workouts' },
        nourishment: { verb: 'Log a meal', section: 'food' }
    };

    function ringStackOrNull(opts) {
        if (typeof window === 'undefined' || !window.WGRingStack || typeof window.WGRingStack.render !== 'function') {
            return null;
        }
        return window.WGRingStack.render(opts);
    }

    // Today rings summary card: a compact, square-ish tappable card — the
    // wg-ring-stack (Plan 7) centered over a per-ring icon state row; tapping
    // deep-links to Journey (which carries the full legend with goals + HP).
    function renderRingsTile(cell, onDeeplink) {
        if (!cell || cell.status === 'disabled') return null;
        const d = doc();
        const card = d.createElement('div');
        card.className = 'wg-card wg-today-rings';
        card.setAttribute('data-deeplink', cell.deeplink || 'journey');
        card.setAttribute('data-section', 'rings');

        const hasValue = !(cell.status === 'missing' || !cell.value);
        const ringList = hasValue ? cell.value.rings : [];
        const closedByRing = {};
        const syncPendingByRing = {};
        let closedCount = 0;
        let syncPendingCount = 0;
        for (const r of ringList) {
            if (!r) continue;
            if (r.closed) { closedByRing[r.ring] = true; closedCount += 1; }
            if (r.sync_pending) { syncPendingByRing[r.ring] = true; syncPendingCount += 1; }
        }
        // First open, actionable (not sync_pending) ring in canonical order is
        // the suggested "your move" — a ring waiting on a device sync isn't
        // something the user can act on right now.
        const openMeta = hasValue
            ? RING_TILE_META.find((m) => !closedByRing[m.ring] && !syncPendingByRing[m.ring])
            : null;

        const header = d.createElement('div');
        header.className = 'wg-today-rings__header';
        const title = d.createElement('span');
        title.className = 'wg-today-rings__title';
        title.textContent = hasValue
            ? `${closedCount} of ${RING_TILE_META.length} rings closed`
                + (syncPendingCount > 0 ? ` · ${syncPendingCount} waiting for sync` : '')
            : 'Today’s rings';
        header.appendChild(title);

        // Headline is the Health Score (Task 8), not the raw today_hp count —
        // "34 HP today" doesn't tell the user whether that's good; a 0-100
        // score with a band word does. Falls back to a muted note below the
        // min-contributors threshold ("not enough data") rather than a
        // misleadingly confident number.
        const scoreValue = (cell.value && cell.value.healthScore) ? cell.value.healthScore.value : null;
        const band = healthScoreBand(scoreValue);
        const scoreWrap = d.createElement('span');
        scoreWrap.className = 'wg-today-rings__score';
        const scoreNum = d.createElement('span');
        scoreNum.className = 'wg-mono-display wg-today-rings__score-value';
        scoreNum.textContent = Number.isFinite(scoreValue) ? String(Math.round(scoreValue)) : '—';
        scoreWrap.appendChild(scoreNum);
        if (band) {
            scoreWrap.appendChild(statusTag(band.kind, band.label));
        } else {
            const note = d.createElement('span');
            note.className = 'wg-today-rings__score-note wg-muted';
            note.textContent = 'Not enough data';
            scoreWrap.appendChild(note);
        }
        header.appendChild(scoreWrap);
        card.appendChild(header);

        // "Your move" — one tappable next action that deep-links to the open
        // ring's section (not the Journey screen). Stop propagation so the
        // card's own Journey deep-link doesn't fire too. When every actionable
        // ring is closed — whether or not sync-pending rings remain — celebrate
        // instead of nagging: a ring waiting on a device sync isn't a "your move".
        if (hasValue) {
            const move = d.createElement('div');
            move.className = 'wg-today-rings__move';
            if (openMeta) {
                const m = RING_MOVE_META[openMeta.ring];
                const ic = iconSvgOrNull('target', 16);
                if (ic) {
                    const wrap = d.createElement('span');
                    wrap.className = 'wg-today-rings__move-icon';
                    wrap.appendChild(ic);
                    move.appendChild(wrap);
                }
                const text = d.createElement('span');
                text.className = 'wg-today-rings__move-text';
                text.textContent = `Your move: ${m.verb} · ${openMeta.label}`;
                move.appendChild(text);
                move.setAttribute('role', 'button');
                move.setAttribute('tabindex', '0');
                move.setAttribute('data-section', m.section);
                const go = (e) => { if (e) e.stopPropagation(); if (typeof onDeeplink === 'function') onDeeplink(m.section); };
                move.addEventListener('click', go);
                move.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
            } else {
                move.classList.add('wg-muted');
                const ic = iconSvgOrNull('check', 16);
                if (ic) {
                    const wrap = d.createElement('span');
                    wrap.className = 'wg-today-rings__move-icon';
                    wrap.appendChild(ic);
                    move.appendChild(wrap);
                }
                const text = d.createElement('span');
                text.className = 'wg-today-rings__move-text';
                text.textContent = closedCount >= RING_TILE_META.length
                    ? 'All rings closed today — nice.'
                    : 'All caught up — the rest will sync in.';
                move.appendChild(text);
            }
            card.appendChild(move);
        }

        // Adherence safety net (Task 3): a solved habit is invisible — this
        // line only renders while the trailing PDC has actually slipped, and
        // links to Meds rather than nagging inline every day.
        const adherenceAlert = hasValue ? cell.value.adherenceAlert : null;
        if (adherenceAlert) {
            const nudge = d.createElement('div');
            nudge.className = 'wg-today-rings__adherence wg-muted';
            nudge.textContent = `${adherenceAlert.missedDoses} missed dose${adherenceAlert.missedDoses === 1 ? '' : 's'} recently — worth a look`;
            nudge.setAttribute('role', 'button');
            nudge.setAttribute('tabindex', '0');
            nudge.setAttribute('data-section', 'meds');
            const goMeds = (e) => { if (e) e.stopPropagation(); if (typeof onDeeplink === 'function') onDeeplink('meds'); };
            nudge.addEventListener('click', goMeds);
            nudge.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') goMeds(e); });
            card.appendChild(nudge);
        }

        if (!hasValue) {
            const empty = d.createElement('div');
            empty.className = 'wg-today-rings__empty wg-muted';
            empty.textContent = 'No points yet today';
            card.appendChild(empty);
        } else {
            const progressByRing = {};
            const goalByRing = {};
            for (const r of ringList) {
                progressByRing[r.ring] = r.progress;
                goalByRing[r.ring] = r.goal;
            }
            const body = d.createElement('div');
            body.className = 'wg-today-rings__body';

            // One big concentric stack (Plan 7) replaces the old per-ring gauge;
            // outer→inner follows RING_TILE_META's canonical order. The center
            // check doubles as the celebration state once every *actionable*
            // ring is closed — the same condition as the "your move" celebration
            // above (no open, non-sync-pending ring left), so sync-pending rings
            // don't block it and the two never disagree.
            const allActionableClosed = !openMeta;
            const stack = ringStackOrNull({
                rings: RING_TILE_META.map((meta) => ({
                    key: meta.ring,
                    progress: progressByRing[meta.ring],
                    closed: !!closedByRing[meta.ring],
                    syncPending: !!syncPendingByRing[meta.ring]
                })),
                centerLabel: allActionableClosed ? iconSvgOrNull('check', 20) : `${closedCount}/${RING_TILE_META.length}`,
                label: 'Today’s rings'
            });
            if (stack) body.appendChild(stack);

            // Compact per-ring state row: one icon per ring, colored by state
            // (closed / syncs-later / open), with the label + goal in the
            // accessible name. The verbose legend (labels, goals, per-ring HP)
            // lives on the Journey screen — Today stays square.
            const icons = d.createElement('div');
            icons.className = 'wg-today-rings__icons';
            for (const meta of RING_TILE_META) {
                const isClosed = !!closedByRing[meta.ring];
                const isSyncPending = !!syncPendingByRing[meta.ring];
                const goal = goalByRing[meta.ring] || '';
                const item = d.createElement('span');
                item.className = 'wg-today-rings__ic'
                    + (isClosed ? ' wg-today-rings__ic--closed' : '')
                    + (isSyncPending ? ' wg-today-rings__ic--sync' : '');
                const stateText = isClosed ? 'closed' : (isSyncPending ? 'syncs later' : (goal || 'open'));
                item.setAttribute('aria-label', meta.label + ' — ' + stateText);
                item.setAttribute('title', meta.label + ' — ' + stateText);
                const ic = iconSvgOrNull(meta.icon, 16);
                if (ic) item.appendChild(ic);
                icons.appendChild(item);
            }
            body.appendChild(icons);
            card.appendChild(body);
        }

        // Tomorrow Forecast (us0.3): merged into the rings card so forecast +
        // calibration read as one compact unit rather than a separate large
        // block above. The module appends its own content (or nothing, when
        // below the confidence gate / in bot mode) — the self-suppress and
        // lifecycle live entirely in forecast-card.js; here we only relocate
        // where it mounts. CSS strips the nested-card chrome inside .wg-today-rings.
        if (typeof window !== 'undefined' && window.WGForecastCard
            && typeof window.WGForecastCard.mountCard === 'function') {
            window.WGForecastCard.mountCard(card);
        }

        const journeyLink = d.createElement('div');
        journeyLink.className = 'wg-today-rings__journey-link';
        const journeyText = d.createElement('span');
        journeyText.textContent = 'View Journey';
        journeyLink.appendChild(journeyText);
        const journeyIcon = iconSvgOrNull('chevronRight', 14);
        if (journeyIcon) journeyLink.appendChild(journeyIcon);
        card.appendChild(journeyLink);

        card.addEventListener('click', () => {
            if (typeof onDeeplink === 'function') onDeeplink(cell.deeplink || 'journey');
        });
        return card;
    }

    function briefOpenerOrNull() {
        if (typeof window === 'undefined' || !window.__MEDTRACKER_CLOUD__) return null;
        const brief = window.DoctorBrief;
        return (brief && typeof brief.open === 'function') ? () => brief.open() : null;
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
        const onPhotoMeal = opts.onPhotoMeal || (() => {
            if (typeof window !== 'undefined'
                && window.FoodActions
                && typeof window.FoodActions.triggerPhotoPicker === 'function') {
                window.FoodActions.triggerPhotoPicker();
            }
        });
        // Cloud-only: GET /api/brief is answered by web/cloud/js/apishim.js and
        // the print helper is served from the cloud shell, so bot mode has
        // neither. No handler → renderShortcutRow omits the tile entirely
        // rather than offering a button that can only fail.
        const onDoctorBrief = opts.onDoctorBrief || briefOpenerOrNull();
        const onScanFood = opts.onScanFood || (() => {
            if (typeof window === 'undefined') return;
            if (window.FoodLog && typeof window.FoodLog.openAdd === 'function') {
                window.FoodLog.openAdd();
            }
            if (window.FoodScanner && typeof window.FoodScanner.openFoodScannerModal === 'function') {
                window.FoodScanner.openFoodScannerModal();
            } else if (window.ModalManager
                && window.ModalManager.foodScanner
                && typeof window.ModalManager.foodScanner.open === 'function') {
                window.ModalManager.foodScanner.open();
            }
        });

        root.innerHTML = '';
        root.classList.add('wg-today');
        root.classList.add('today-root');

        // Stale-data chip (Task 5 of local-first read resilience). Rendered at
        // the top of Today using the OLDEST fetchedAt across the caches that
        // feed the screen, so the user reads it as a worst-case freshness
        // floor. Suppressed during the firstRun empty-state — the placeholder
        // already explains what's going on.
        if (!state.__firstRun
            && typeof window !== 'undefined'
            && window.WGStaleBadge
            && typeof window.WGStaleBadge.render === 'function') {
            const fetchedAt = (state && Number.isFinite(state.__fetchedAt)) ? state.__fetchedAt : null;
            // Badge tone uses the raw navigator-offline signal (state.__navigatorOffline)
            // so offline + fresh cache renders "Offline · 5m old" rather than the neutral
            // "Updated 5m ago". state.__offline only flips when offline+stale.
            const isOffline = !!(state.__navigatorOffline || state.__offline);
            if (fetchedAt !== null || isOffline) {
                const headerRow = d.createElement('div');
                headerRow.className = 'today-stale-badge-row';
                const badge = window.WGStaleBadge.render({
                    fetchedAt,
                    isOffline,
                    now: nowMs
                });
                headerRow.appendChild(badge);
                root.appendChild(headerRow);
            }
        }

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

        // Call agent + Shortcuts are pinned to the very top of Today (us0.4) so
        // they're the first thing visible in every state (features on/off,
        // cached/offline). Nothing renders above them except the freshness
        // badge + offline banner.
        let callCard = null;
        if (typeof window !== 'undefined' && window.WGCallAgent && typeof window.WGCallAgent.mountCard === 'function') {
            callCard = window.WGCallAgent.mountCard(root);
            rendered += 1;
        }

        const shortcutRows = renderShortcutRow(state, {
            onLogFood, onScanFood, onPhotoMeal, onAddBp, onAddWeight, onDoctorBrief
        });
        if (shortcutRows) {
            shortcutRows.forEach((r) => {
                // med-z8ic: Doctor brief rides the Call agent row as its
                // narrower sibling (2fr / 1fr, see .wg-call-card--with-brief)
                // instead of burning a whole row on one tile. It goes *inside*
                // the call card rather than into a shared wrapper on purpose:
                // mountCard() dedupes on `root.querySelector('[data-section=
                // "call-agent"]')` and reattaches live-call state to whatever
                // it finds, so the container it is handed must stay `root`.
                // Whichever of the two is absent, the survivor fills the row.
                if (callCard && r.getAttribute('data-section') === 'shortcuts-brief'
                    && !callCard.querySelector('[data-section="shortcuts-brief"]')) {
                    r.classList.add('wg-call-card__brief');
                    callCard.classList.add('wg-call-card--with-brief');
                    // Insert right after the trigger (before the in-call
                    // controls) so DOM order matches the visual order the
                    // grid produces: trigger + brief on line 1, controls and
                    // status on their own full-width lines below.
                    callCard.insertBefore(r, callCard.querySelector('.wg-call-card__controls'));
                    return;
                }
                root.appendChild(r);
            });
            rendered += shortcutRows.length;
        }

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

        // Gamification rings — a compact tile (us0.1) sitting directly above the
        // food card. The Tomorrow Forecast (us0.3) is merged inside this tile by
        // renderRingsTile. With gamification off there is no tile and no
        // forecast: the shim's forecast route returns {enabled:false}, so the
        // card has nothing to mount anywhere on Today.
        const ringsTile = renderRingsTile(state && state.gamificationRings, onDeeplink);
        if (ringsTile) {
            root.appendChild(ringsTile);
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

        // TZ-transition plan card sits directly above the medications card
        // because the doses listed inside the plan are a temporary override of
        // the meds schedule — keeping the two adjacent makes the relationship
        // legible. The module silently mounts nothing when no plan is in
        // flight, so users who never travel never see anything here.
        if (typeof window !== 'undefined' && window.TZPlanBanner
            && typeof window.TZPlanBanner.mountCard === 'function') {
            const tzCard = window.TZPlanBanner.mountCard(root);
            if (tzCard) { rendered += 1; }
        }

        const medsCard = renderTodayMedsCard(state && state.nextMed, onDeeplink, nowMs, !!(state && state.__offline));
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
    const RELEVANT_TAGS = ['bp', 'weight', 'medications', 'history', 'food', 'workout', 'health', 'settings', 'gamification'];

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
