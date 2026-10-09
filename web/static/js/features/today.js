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

    // The queue / rejection markers an optimistic or queued row carries
    // (the WGChip.sync contract), so a device-saved log reads Pending on Today.
    function syncFlags(row) {
        const out = {};
        for (const k of ['isLocal', 'pending', '_optimistic', 'isRejected', 'errorMessage']) {
            if (row && row[k]) out[k] = row[k];
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

    // Due / missed doses for Next up (Next up applies the missed grace):
    // intakes still PENDING whose slot has passed and are not snoozed into the
    // future — the same rule as the Meds tab
    // badge (app-nav.js countDueDoses), over the cached GET /api/history?days=1
    // rows (bootstrap.intake_history). Intake state, not cache timing, decides
    // what is missed. One group per slot (oldest first), names joined from the
    // cached medications list. `missing` = no history cached yet.
    // ponytail: 24h window like the badge — an older unresolved dose is
    // history, not a nag.
    function missedDosesCell(bootstrap, nowMs, enabled) {
        if (!enabled) return cell(null, 'meds', 'disabled');
        const rows = bootstrap && bootstrap.intake_history;
        if (!Array.isArray(rows)) return cell(null, 'meds', 'missing');
        const meds = Array.isArray(bootstrap.medications) ? bootstrap.medications : [];
        const nameOf = (id) => {
            const m = meds.find((x) => x && x.id === id);
            return m && typeof m.name === 'string' ? m.name : null;
        };
        const bySlot = new Map();
        for (const r of rows) {
            if (!r || r.status !== 'PENDING') continue;
            const at = Date.parse(r.scheduled_at);
            if (!Number.isFinite(at) || at > nowMs) continue;
            if (r.snoozed_until && Date.parse(r.snoozed_until) > nowMs) continue;
            let g = bySlot.get(at);
            if (!g) { g = { at, scheduledAt: r.scheduled_at, names: [], ids: [], intakeIds: [] }; bySlot.set(at, g); }
            g.names.push(nameOf(r.medication_id) || 'Medication');
            g.ids.push(r.medication_id);
            g.intakeIds.push(r.id);
        }
        const groups = Array.from(bySlot.values()).sort((a, b) => a.at - b.at)
            .map(({ scheduledAt, names, ids, intakeIds }) => ({ scheduledAt, names, ids, intakeIds }));
        return cell(groups, 'meds', 'ok');
    }

    function bpLatestCell(bootstrap, nowMs, enabled) {
        if (!enabled) return cell(null, 'bp', 'disabled');
        const readings = bootstrap && bootstrap.bp && bootstrap.bp.readings;
        const latest = latestOf(readings, (r) => r.measured_at);
        if (!latest) return cell(null, 'bp', 'missing');
        const value = {
            systolic: latest.row.systolic,
            diastolic: latest.row.diastolic,
            measured_at: latest.row.measured_at,
            ...syncFlags(latest.row)
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
            measured_at: latest.row.measured_at,
            ...syncFlags(latest.row)
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
            id: session.id,
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

    // Most recent day with a non-zero step count from the health overview.
    function stepsLatestCell(swrCaches, enabled) {
        if (!enabled) return cell(null, 'health', 'disabled');
        const overview = swrCaches && swrCaches.health_overview;
        const stats = overview && overview.step_stats_7d;
        if (!Array.isArray(stats)) return cell(null, 'health', 'missing');
        let last = null;
        for (const row of stats) {
            if (!row || !row.day || !Number.isFinite(row.steps) || row.steps <= 0) continue;
            if (!last || String(row.day) > String(last.day)) last = row;
        }
        if (!last) return cell(null, 'health', 'missing');
        return cell({ steps: last.steps, day: last.day }, 'health', 'ok');
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
        // ED-safe (med-8tur.12) rides the Goal Line payload: no weight numbers
        // on Today — the Weight tab itself stays the user's own data.
        const goalLinePayload = caches.gamification_goal_line;
        const edSafe = gamificationEnabled && !!(goalLinePayload && goalLinePayload.ed_safe);

        const nextMed = nextMedCell(bootstrap, nowMs, medEnabled, opts);
        const result = {
            greeting: cell(greetingFor(nowDate), null, 'ok'),
            nextMed,
            missedDoses: missedDosesCell(bootstrap, nowMs, medEnabled),
            bpLatest: bpLatestCell(bootstrap, nowMs, bpEnabled),
            bpTrend7d: bpTrendCell(bootstrap, nowMs, bpEnabled),
            weightLatest: weightLatestCell(bootstrap, nowMs, weightEnabled && !edSafe),
            weightTrend7d: weightTrendCell(bootstrap, nowMs, weightEnabled && !edSafe),
            caloriesToday: caloriesTodayCell(bootstrap, caches, nowMs, foodEnabled),
            caloriesTarget: caloriesTargetCell(bootstrap, foodEnabled),
            macrosToday: macrosTodayCell(caches, foodEnabled),
            macrosTarget: macrosTargetCell(bootstrap, foodEnabled),
            nextWorkout: nextWorkoutCell(caches, workoutEnabled),
            sleepLastNight: sleepLastNightCell(caches, nowMs, healthEnabled),
            stepsLatest: stepsLatestCell(caches, healthEnabled),
            goalLine: goalLineCell(goalLinePayload, gamificationEnabled, weightEnabled)
        };
        return result;
    }

    // ---- Rendering (kit v2, screens-today.html T1/T3–T6, med-xso6.13) ------
    //
    // renderToday(state, root, handlers) fills `root` top to bottom:
    //   call row (Call agent · Log · Doctor brief) → Next up list → vitals
    //   strip (BP · Weight · Fuel) → Goal Line track → macros card →
    //   sleep / steps tiles → tz-transition card.
    //
    // Kit rules: one sun-filled control (.wg-btn--primary) per view — the
    // soonest Next-up action, else the goal card's "Set goal"; status only via
    // WGChip states; no inline style except the --p / --n custom properties
    // the track and meters read; icons are <i class="wg-ico" data-icon>
    // hydrated by WGIcons once the tree is built.
    // ------------------------------------------------------------------------

    const DAY_IN_MS = 24 * 60 * 60 * 1000;
    const LOG_SHEET_ID = 'today-log-sheet';

    function doc() {
        return (typeof document !== 'undefined') ? document : null;
    }

    function el(tag, className, text) {
        const node = doc().createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function ico(name, small) {
        const i = el('i', small ? 'wg-ico wg-ico--sm' : 'wg-ico');
        i.setAttribute('data-icon', name);
        i.setAttribute('aria-hidden', 'true');
        return i;
    }

    // A kit button. The click never bubbles into a tappable parent card.
    function btn(label, o) {
        const opts = o || {};
        let cls = 'wg-btn';
        if (opts.primary) cls += ' wg-btn--primary';
        if (opts.ghost) cls += ' wg-btn--ghost';
        if (opts.iconOnly) cls += ' wg-btn--icon';
        if (opts.sm) cls += ' wg-btn--sm';
        const b = el('button', cls);
        b.type = 'button';
        if (opts.icon) b.appendChild(ico(opts.icon, opts.sm));
        if (label) b.appendChild(doc().createTextNode(label));
        if (opts.aria) b.setAttribute('aria-label', opts.aria);
        if (opts.action) b.setAttribute('data-action', opts.action);
        if (typeof opts.onClick === 'function') {
            b.addEventListener('click', (e) => { e.stopPropagation(); opts.onClick(); });
        }
        return b;
    }

    function chip(text, state, icon) {
        const W = (typeof window !== 'undefined') ? window.WGChip : null;
        if (W && typeof W.create === 'function') return W.create({ text, state, small: true, icon });
        return el('span', state ? `wg-chip wg-chip--sm wg-chip--${state}` : 'wg-chip wg-chip--sm', text);
    }

    function pct(ratio) {
        const n = Number(ratio);
        return `${(Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0)) * 100).toFixed(1)}%`;
    }

    function on(c) {
        return !!c && c.status !== 'disabled';
    }

    function hydrateIcons(root) {
        const W = (typeof window !== 'undefined') ? window.WGIcons : null;
        if (!W || typeof W.hydrate !== 'function') return;
        // An unknown icon name throws and stops hydration (later slots stay
        // empty); caught so a bad name never breaks the render. Every name
        // used here is in the WGIcons registry.
        try { W.hydrate(root); } catch (_) { /* see above */ }
    }

    function sparklineOrNull(points, variant) {
        if (typeof window === 'undefined' || !window.WGSparkline || typeof window.WGSparkline.render !== 'function') {
            return null;
        }
        return window.WGSparkline.render({ points, variant });
    }

    function fmtTimeHM(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function startOfLocalDay(ms) {
        const d = new Date(ms);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }

    // 'YYYY-MM-DD' (or an ISO stamp) → local-midnight ms; NaN when unparseable.
    function localDayMs(day) {
        const parts = String(day || '').split('T')[0].split('-').map(Number);
        if (parts.length === 3 && parts.every(Number.isFinite)) {
            return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
        }
        const t = Date.parse(day);
        return Number.isFinite(t) ? startOfLocalDay(t) : NaN;
    }

    function daysAgo(ms, nowMs) {
        return Math.round((startOfLocalDay(nowMs) - startOfLocalDay(ms)) / DAY_IN_MS);
    }

    function ageLabel(ms, nowMs) {
        if (!Number.isFinite(ms)) return '';
        const days = daysAgo(ms, nowMs);
        if (days <= 0) return 'today';
        if (days === 1) return 'yesterday';
        return `${days}d ago`;
    }

    // "today" / "tomorrow" / "Wed" for a timestamp, relative to now.
    function dayWord(ms, nowMs) {
        const days = -daysAgo(ms, nowMs);
        if (days === 0) return 'today';
        if (days === 1) return 'tomorrow';
        if (days === -1) return 'yesterday';
        try {
            return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        } catch (_) {
            return new Date(ms).toISOString().slice(0, 10);
        }
    }

    function fmtCountdown(atMs, nowMs) {
        const diff = atMs - nowMs;
        if (!Number.isFinite(diff) || diff <= 0) return '';
        const mins = Math.round(diff / 60000);
        if (mins < 60) return `in ${mins}m`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m === 0 ? `in ${h}h` : `in ${h}h ${String(m).padStart(2, '0')}m`;
    }

    function weightFmt(kg) {
        const unit = (typeof window !== 'undefined' && window.weightUnitPreference === 'lb') ? 'lb' : 'kg';
        const display = (typeof formatWeight === 'function')
            ? formatWeight(kg, unit)
            : { value: Math.round(Number(kg) * 10) / 10, label: unit };
        return { text: Number(display.value).toFixed(1), unit: display.label };
    }

    function weightText(kg) {
        const f = weightFmt(kg);
        return `${f.text} ${f.unit}`;
    }

    function signedWeightText(kg) {
        const f = weightFmt(Math.abs(kg));
        const sign = kg > 0.05 ? '+' : (kg < -0.05 ? '−' : '');
        return `${sign}${f.text} ${f.unit}`;
    }

    // ---- Next up ------------------------------------------------------------
    //
    // Missed dose first (danger lead, "Missed HH:MM", plain Log), then the
    // scheduled items by time. The first actionable one carries the single sun
    // action (meds → Take, today's workout → Start / Resume); the rest stay
    // plain. Every action reuses the existing flow — no new write path.

    function nextUpItems(state, nowMs) {
        const items = [];
        // Missed doses come from intake history when it is cached. Without
        // it (offline cold start), a next_intake already past its slot is the
        // best missed signal there is; with it, history owns past slots and an
        // out-of-date next_intake is dropped until revalidation replaces it.
        const missed = state && state.missedDoses;
        const historyKnown = !!missed && missed.status === 'ok' && Array.isArray(missed.value);
        // A pending dose inside the same 5-min grace nextMed uses is due now
        // (Take, eligible for the sun), not missed yet.
        const historySlots = new Set();
        if (historyKnown) {
            for (const g of missed.value) {
                const at = Date.parse(g.scheduledAt);
                historySlots.add(at);
                items.push({ kind: at + OVERDUE_GRACE_MS < nowMs ? 'med-missed' : 'med', value: g, at });
            }
        }
        const med = state && state.nextMed;
        const medAt = med && med.value ? Date.parse(med.value.scheduledAt) : NaN;
        if (med && med.value && !historySlots.has(medAt)
            && (med.status === 'ok' || (med.status === 'overdue' && !historyKnown))) {
            items.push({ kind: med.status === 'overdue' ? 'med-missed' : 'med', value: med.value, at: medAt });
        }
        const wo = state && state.nextWorkout;
        if (wo && wo.status === 'ok' && wo.value) {
            const v = wo.value;
            const dayMs = v.is_today ? startOfLocalDay(nowMs) : localDayMs(v.scheduled_date);
            const hm = /^(\d{1,2}):(\d{2})/.exec(v.scheduled_time || '');
            let at = Number.isFinite(dayMs) ? dayMs : Infinity;
            if (hm && Number.isFinite(dayMs)) at = dayMs + (Number(hm[1]) * 60 + Number(hm[2])) * 60000;
            // A session due today with no set time is due now.
            if (v.is_today && !hm) at = nowMs;
            items.push({ kind: 'workout', value: v, at });
        }
        items.sort((a, b) => {
            if ((a.kind === 'med-missed') !== (b.kind === 'med-missed')) return a.kind === 'med-missed' ? -1 : 1;
            return (Number.isFinite(a.at) ? a.at : Infinity) - (Number.isFinite(b.at) ? b.at : Infinity);
        });
        return items;
    }

    function workoutAction(v) {
        if (!v.is_today || v.id == null) return 'view';
        if (v.status === 'in_progress') return 'resume';
        if (!v.status || v.status === 'pending' || v.status === 'scheduled') return 'start';
        return 'view';
    }

    function medNames(v) {
        return Array.isArray(v.names) ? v.names.filter(Boolean) : [];
    }

    function renderNextUpRow(item, primary, h, nowMs) {
        const row = el('div', 'wg-row');
        row.setAttribute('data-next', item.kind);
        const lead = el('span', 'wg-row__lead');
        if (item.kind === 'med-missed') lead.classList.add('wg-row__lead--danger');
        else if (primary) lead.classList.add('wg-row__lead--sun');
        const body = el('span', 'wg-row__body');
        const meta = el('span', 'wg-row__meta');
        const trail = el('span', 'wg-row__trail');
        let action = null;

        if (item.kind === 'med' || item.kind === 'med-missed') {
            const v = item.value;
            const names = medNames(v);
            lead.appendChild(ico('pill'));
            body.appendChild(el('span', 'wg-row__title',
                names.length === 1 ? names[0] : `${names.length} medications`));
            const when = fmtTimeHM(v.scheduledAt);
            if (item.kind === 'med-missed') {
                meta.appendChild(chip(when ? `Missed ${when}` : 'Missed', 'danger'));
                if (names.length > 1) meta.appendChild(doc().createTextNode(` ${names.join(', ')}`));
            } else {
                const parts = [];
                const day = Number.isFinite(item.at) ? dayWord(item.at, nowMs) : '';
                if (day && day !== 'today') parts.push(day);
                if (when) parts.push(when);
                const countdown = Number.isFinite(item.at) && day === 'today' ? fmtCountdown(item.at, nowMs) : '';
                if (countdown) parts.push(countdown);
                if (names.length > 1) parts.push(names.join(', '));
                meta.textContent = parts.join(' · ');
            }
            const label = item.kind === 'med-missed' ? 'Log' : 'Take';
            action = btn(label, {
                sm: true, primary, action: item.kind === 'med-missed' ? 'log-missed' : 'take',
                onClick: () => h.onTakeMed(v),
            });
        } else {
            const v = item.value;
            lead.appendChild(ico('dumbbell'));
            body.appendChild(el('span', 'wg-row__title', v.group_name || 'Workout'));
            const parts = [];
            if (v.is_today) parts.push('today');
            else if (Number.isFinite(item.at)) parts.push(dayWord(item.at, nowMs));
            if (v.scheduled_time) parts.push(v.scheduled_time);
            if (v.is_today && v.scheduled_time && Number.isFinite(item.at)) {
                const c = fmtCountdown(item.at, nowMs);
                if (c) parts.push(c);
            }
            if (v.status === 'pre_skipped') parts.push('skipped');
            if (v.status === 'in_progress') parts.push('in progress');
            meta.textContent = parts.join(' · ');
            const kind = workoutAction(v);
            if (kind === 'start') {
                action = btn('Start', { sm: true, primary, icon: 'play', action: 'start-workout', onClick: () => h.onStartWorkout(v.id) });
            } else if (kind === 'resume') {
                action = btn('Resume', { sm: true, primary, icon: 'play', action: 'resume-workout', onClick: () => h.onResumeWorkout(v.id) });
            } else {
                action = btn('View', { sm: true, action: 'view-workout', onClick: () => h.onDeeplink('workouts') });
            }
        }
        body.appendChild(meta);
        trail.appendChild(action);
        row.append(lead, body, trail);
        return row;
    }

    // Returns { node, hasPrimary }.
    function renderNextUp(state, h, nowMs) {
        const medsOn = on(state && state.nextMed);
        const workoutsOn = on(state && state.nextWorkout);
        if (!medsOn && !workoutsOn) return { node: null, hasPrimary: false };
        const section = el('section', 'wg-section wg-today-next');
        section.setAttribute('data-section', 'next-up');
        const head = el('div', 'wg-section__head');
        head.appendChild(el('span', 'wg-eyebrow wg-eyebrow--dot', 'Next up'));
        section.appendChild(head);

        const items = nextUpItems(state, nowMs);
        if (items.length === 0) {
            const actions = [];
            if (medsOn) actions.push({ label: 'Add medication', icon: 'pill', onClick: h.onAddMedication });
            if (workoutsOn) actions.push({ label: 'Create plan', icon: 'dumbbell', onClick: h.onCreatePlan });
            const card = el('div', 'wg-card wg-card--flush');
            card.appendChild(typeof createEmptyState === 'function'
                ? createEmptyState({
                    icon: 'calendar',
                    title: 'Nothing scheduled',
                    body: 'Add a medication or a training plan and its next dose or session shows up here.',
                    actions,
                })
                : el('p', 'wg-hint', 'Nothing scheduled'));
            section.appendChild(card);
            return { node: section, hasPrimary: false };
        }

        const todayEnd = startOfLocalDay(nowMs) + DAY_IN_MS;
        const todayCount = items.filter((it) => Number.isFinite(it.at) && it.at < todayEnd).length;
        if (todayCount > 0) head.appendChild(el('span', 'wg-meta', `${todayCount} today`));

        const primaryIdx = items.findIndex((it) => it.kind === 'med'
            || (it.kind === 'workout' && workoutAction(it.value) !== 'view'));
        const list = el('div', 'wg-list');
        items.forEach((it, i) => list.appendChild(renderNextUpRow(it, i === primaryIdx, h, nowMs)));
        section.appendChild(list);
        return { node: section, hasPrimary: primaryIdx !== -1 };
    }

    // ---- Vitals strip -------------------------------------------------------

    function bpClassChip(sys, dia) {
        if (!Number.isFinite(sys) || !Number.isFinite(dia)) return null;
        if (sys >= 140 || dia >= 90) return chip('High', 'danger');
        if (sys >= 130 || dia >= 85) return chip('Stage 1', 'warn');
        if (sys >= 120 || dia >= 80) return chip('High-normal', 'warn');
        return chip('Normal', 'ok');
    }

    // The reading's age as its own signal: a device-saved log still queued
    // reads Pending; offline, every cached value reads "cached"; an old
    // reading gets a stale chip; otherwise a quiet meta label.
    function ageSignal(cellIn, v, nowMs, offline) {
        const W = (typeof window !== 'undefined') ? window.WGChip : null;
        const syncChip = W && typeof W.sync === 'function' ? W.sync(v) : null;
        if (syncChip) return syncChip;
        const ms = Date.parse(v.measured_at);
        const age = ageLabel(ms, nowMs);
        if (offline) return chip('cached', 'stale');
        if (cellIn.status === 'stale') return chip(age || 'stale', 'stale');
        return el('span', 'wg-meta', age);
    }

    function vitalsTile(section, label, onTap) {
        const tile = el('button', 'wg-tile');
        tile.type = 'button';
        tile.setAttribute('data-section', section);
        tile.appendChild(el('span', 'wg-eyebrow', label));
        tile.addEventListener('click', onTap);
        return tile;
    }

    function missingValue(tile, onLog) {
        tile.appendChild(el('span', 'wg-stat__value wg-stat__value--md wg-muted', '—'));
        const link = el('span', 'wg-link', 'Log');
        link.setAttribute('data-action', 'log');
        link.addEventListener('click', (e) => { e.stopPropagation(); onLog(); });
        tile.appendChild(link);
    }

    function renderBpTile(latest, trend, h, nowMs, offline) {
        if (!on(latest)) return null;
        const tile = vitalsTile('bp', 'BP', () => h.onDeeplink(latest.deeplink || 'bp'));
        if (latest.status === 'missing' || !latest.value) {
            missingValue(tile, h.onAddBp);
            return tile;
        }
        const v = latest.value;
        const value = el('span', 'wg-stat__value wg-stat__value--md', String(v.systolic));
        value.appendChild(el('span', 'wg-dia', `/${v.diastolic}`));
        tile.appendChild(value);
        const points = trend && trend.status === 'ok' && trend.value ? trend.value.systolicPoints : null;
        const spark = Array.isArray(points) && points.length ? sparklineOrNull(points, 'sun') : null;
        if (spark) tile.appendChild(spark);
        const cls = bpClassChip(v.systolic, v.diastolic);
        if (cls) tile.appendChild(cls);
        tile.appendChild(ageSignal(latest, v, nowMs, offline));
        return tile;
    }

    function renderWeightTile(latest, trend, h, nowMs, offline) {
        if (!on(latest)) return null;
        const tile = vitalsTile('weight', 'Weight', () => h.onDeeplink(latest.deeplink || 'weight'));
        if (latest.status === 'missing' || !latest.value) {
            missingValue(tile, h.onAddWeight);
            return tile;
        }
        const v = latest.value;
        const f = weightFmt(v.weight);
        const value = el('span', 'wg-stat__value wg-stat__value--md', f.text);
        value.appendChild(el('small', null, f.unit));
        tile.appendChild(value);
        const tv = trend && trend.status === 'ok' ? trend.value : null;
        const spark = tv && Array.isArray(tv.points) && tv.points.length ? sparklineOrNull(tv.points, 'mint') : null;
        if (spark) tile.appendChild(spark);
        if (tv && Number.isFinite(tv.delta)) {
            tile.appendChild(el('span', 'wg-meta', tv.direction === 'flat' ? 'flat · 7d' : `${signedWeightText(tv.delta)} · 7d`));
        }
        tile.appendChild(ageSignal(latest, v, nowMs, offline));
        return tile;
    }

    function renderFuelTile(today, target, h) {
        if (!on(today)) return null;
        const tile = vitalsTile('fuel', 'Fuel', () => h.onDeeplink(today.deeplink || 'food'));
        const kcal = Number.isFinite(today.value) ? today.value : 0;
        const t = target && target.status === 'ok' && Number.isFinite(target.value) ? target.value : null;
        tile.appendChild(el('span', kcal > 0
            ? 'wg-stat__value wg-stat__value--md'
            : 'wg-stat__value wg-stat__value--md wg-muted', String(kcal)));
        if (t) {
            const meter = el('span', 'wg-meter');
            const fill = el('span', 'wg-meter__fill');
            fill.style.setProperty('--p', pct(kcal / t));
            meter.appendChild(fill);
            tile.appendChild(meter);
        }
        tile.appendChild(el('span', 'wg-meta', t ? `of ${t} kcal` : 'No target'));
        return tile;
    }

    // ---- Below the fold: macros, sleep, steps -------------------------------

    function renderMacrosCard(state, h) {
        const today = state && state.caloriesToday;
        if (!on(today)) return null;
        const target = state.caloriesTarget;
        const t = target && target.status === 'ok' && Number.isFinite(target.value) ? target.value : null;
        const kcal = Number.isFinite(today.value) ? today.value : 0;
        if (!t && kcal <= 0) return null; // the Fuel tile already says "No target"
        const macros = (state.macrosToday && state.macrosToday.value) || { protein: 0, carbs: 0, fat: 0 };
        const targets = (state.macrosTarget && state.macrosTarget.status === 'ok' && state.macrosTarget.value) || {};
        const card = el('button', 'wg-card wg-today-macros');
        card.type = 'button';
        card.setAttribute('data-section', 'macros');
        const head = el('div', 'wg-card__head');
        const left = el('span', 'wg-hstack');
        left.appendChild(el('span', 'wg-stat__value wg-stat__value--md', String(kcal)));
        left.appendChild(el('span', 'wg-meta', t ? `/ ${t} kcal` : 'kcal'));
        head.appendChild(left);
        if (t) head.appendChild(chip(`${Math.round((kcal / t) * 100)}%`));
        card.appendChild(head);
        const grid = el('div', 'wg-macros');
        const line = (label, val, tgt, unit, variant) => {
            grid.appendChild(el('span', 'wg-macros__label', label));
            const meter = el('span', 'wg-meter');
            const fill = el('span', variant ? `wg-meter__fill wg-meter__fill--${variant}` : 'wg-meter__fill');
            fill.style.setProperty('--p', Number.isFinite(tgt) && tgt > 0 ? pct(val / tgt) : '0%');
            meter.appendChild(fill);
            grid.appendChild(meter);
            grid.appendChild(el('span', 'wg-macros__val',
                Number.isFinite(tgt) && tgt > 0 ? `${val} / ${tgt}${unit}` : `${val}${unit}`));
        };
        line('Energy', kcal, t, '', null);
        line('Protein', macros.protein || 0, targets.protein, ' g', 'mint');
        line('Carbs', macros.carbs || 0, targets.carbs, ' g', 'sage');
        line('Fat', macros.fat || 0, targets.fat, ' g', 'clay');
        card.appendChild(grid);
        card.addEventListener('click', () => h.onDeeplink(today.deeplink || 'food'));
        return card;
    }

    function renderSleepTile(c, h, nowMs, offline) {
        if (!on(c)) return null;
        const tile = vitalsTile('sleep', 'Sleep', () => h.onDeeplink(c.deeplink || 'health'));
        if (!c.value) {
            tile.appendChild(el('span', 'wg-stat__value wg-stat__value--md wg-muted', '—'));
            tile.appendChild(el('span', 'wg-meta', 'No sleep data'));
            return tile;
        }
        const totalM = Math.round(c.value.hours * 60);
        tile.appendChild(el('span', 'wg-stat__value wg-stat__value--md',
            `${Math.floor(totalM / 60)}h ${String(totalM % 60).padStart(2, '0')}m`));
        const label = ageLabel(localDayMs(c.value.day), nowMs);
        if (offline) tile.appendChild(chip('cached', 'stale'));
        else if (c.status === 'stale') tile.appendChild(chip(label || 'stale', 'stale'));
        else if (label) tile.appendChild(el('span', 'wg-meta', label));
        return tile;
    }

    function renderStepsTile(c, h, nowMs, offline) {
        if (!on(c)) return null;
        const tile = vitalsTile('steps', 'Steps', () => h.onDeeplink(c.deeplink || 'health'));
        if (!c.value) {
            tile.appendChild(el('span', 'wg-stat__value wg-stat__value--md wg-muted', '—'));
            tile.appendChild(el('span', 'wg-meta', 'No step data'));
            return tile;
        }
        tile.appendChild(el('span', 'wg-stat__value wg-stat__value--md', Number(c.value.steps).toLocaleString('en-US')));
        const age = ageLabel(localDayMs(c.value.day), nowMs);
        if (offline) tile.appendChild(chip('cached', 'stale'));
        else if (age && age !== 'today') tile.appendChild(chip(age, 'stale'));
        else tile.appendChild(el('span', 'wg-meta', 'today'));
        return tile;
    }

    // ---- Goal Line (docs/gamification.md §0.3.2) ----------------------------
    //
    // The gamification headline, as a kit track: current → target, a marker
    // track (--n markers, --p progress, a pin on the next marker) and three
    // numbers — the same anatomy as the Journey goal card (journey.js
    // goalTrack). Facts only: no pace grade, no projected date, no HP / level /
    // rings. The card taps through to Journey; inline actions stop propagation.

    function goalLineCell(payload, enabled, weightEnabled) {
        if (!enabled) return cell(null, 'journey', 'disabled');
        // ED-safe (med-8tur.12): no Goal Line, but the medication alert it
        // carries is a safety signal — kept, rendered on its own.
        if (payload && payload.ed_safe) {
            const aa = payload.adherence_alert;
            return aa && aa.active ? cell({ ed_safe: true, adherence_alert: aa }, 'journey', 'ok') : cell(null, 'journey', 'disabled');
        }
        if (payload && payload.enabled === false) return cell(null, 'journey', 'disabled');
        if (!payload || !payload.goal) return cell(null, 'journey', 'missing');
        const c = cell(payload, 'journey', 'ok');
        c.weightOn = weightEnabled !== false;
        return c;
    }

    function goalAdherenceNudge(aa, h) {
        if (!aa || !aa.active) return null;
        const n = Number(aa.missed_doses) || 0;
        const link = el('button', 'wg-link wg-today-goal__adherence',
            `${n} missed dose${n === 1 ? '' : 's'} recently — worth a look`);
        link.type = 'button';
        link.setAttribute('data-section', 'meds');
        link.setAttribute('data-action', 'meds');
        link.addEventListener('click', (e) => { e.stopPropagation(); h.onDeeplink('meds'); });
        return link;
    }

    function goalPlanLine(plan) {
        if (!plan) return null;
        let text = null;
        if (plan.paused) text = 'Paused this week';
        else {
            const c = plan.cadence || {};
            const parts = [];
            if (plan.intention && plan.intention.text) parts.push(plan.intention.text);
            if (c.weigh_in === 'daily') parts.push('weigh-in daily');
            if (Number.isInteger(c.bp_days) && c.bp_days > 0) parts.push(`BP ${c.bp_days} day${c.bp_days === 1 ? '' : 's'}`);
            if (parts.length) text = `This week · ${parts.join(' · ')}`;
        }
        if (!text) return null;
        const line = el('span', 'wg-meta', text);
        line.setAttribute('data-fact', 'plan');
        return line;
    }

    function goalTrack(g) {
        const nm = g.next_milestone;
        const track = el('span', 'wg-track');
        track.style.setProperty('--p', pct(g.progress.fraction));
        if (nm && Number(nm.count) > 0) track.style.setProperty('--n', String(Number(nm.count)));
        track.appendChild(el('span', 'wg-track__fill'));
        const start = Number.isFinite(g.start_ref) ? g.start_ref : null;
        const span = start !== null && Number.isFinite(g.target) ? Math.abs(start - g.target) : 0;
        const showPin = !!nm && !nm.is_goal && Number.isFinite(nm.weight) && span > 0;
        if (showPin) {
            const pin = el('span', 'wg-track__pin');
            pin.style.setProperty('--p', pct(Math.abs(start - nm.weight) / span));
            track.appendChild(pin);
        }
        const ends = el('span', 'wg-track__ends');
        ends.appendChild(el('span', null, start !== null ? `start ${weightFmt(start).text}` : 'start'));
        if (showPin) ends.appendChild(el('span', null, `next ${weightFmt(nm.weight).text}`));
        ends.appendChild(el('span', null, nm && Number(nm.count) > 0
            ? `${Math.max(0, (Number(nm.ordinal) || 1) - 1)} / ${Number(nm.count)}`
            : 'goal'));
        return [track, ends];
    }

    // Returns { node, primary } — primary is true when the card carries the
    // view's sun control ("Set goal", only when Next up has none).
    function renderGoalCard(c, h, allowPrimary, offline) {
        if (!c || c.status === 'disabled' || c.status === 'missing' || !c.value) return { node: null, primary: false };
        const v = c.value;
        if (v.ed_safe) {
            // ED-safe: just the medication alert, in a plain card — no goal,
            // no weight, no tap-through to Journey.
            const alertCard = el('div', 'wg-card');
            alertCard.setAttribute('data-section', 'adherence-alert');
            alertCard.appendChild(goalAdherenceNudge(v.adherence_alert, h));
            return { node: alertCard, primary: false };
        }
        const g = v.goal;

        if (g.status === 'no_goal') {
            // Weight tab off → switchTab('weight') bounces to Today; no dead link.
            if (c.weightOn === false) return { node: null, primary: false };
            const card = el('div', 'wg-card wg-card--accent wg-vstack wg-today-goal');
            card.setAttribute('data-section', 'goal-line');
            card.setAttribute('data-status', g.status);
            card.appendChild(el('span', 'wg-eyebrow', 'Goal line'));
            card.appendChild(el('p', 'wg-card__title', 'Set a weight goal'));
            card.appendChild(el('p', 'wg-hint', 'The goal is the spine of your journey. Workouts, BP and food are the levers that move it.'));
            const foot = el('div', 'wg-card__foot');
            foot.appendChild(btn('Set goal', { primary: allowPrimary, action: 'set-goal', onClick: () => h.onDeeplink('weight') }));
            card.appendChild(foot);
            const nudge = goalAdherenceNudge(v.adherence_alert, h);
            if (nudge) card.appendChild(nudge);
            return { node: card, primary: allowPrimary };
        }

        const card = el('div', 'wg-card wg-vstack wg-today-goal');
        card.setAttribute('data-section', 'goal-line');
        card.setAttribute('data-deeplink', c.deeplink || 'journey');
        card.setAttribute('data-status', g.status);
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', 'Goal line — open Journey');
        const go = () => h.onDeeplink(c.deeplink || 'journey');
        card.addEventListener('click', go);
        card.addEventListener('keydown', (e) => {
            if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(); }
        });

        const head = el('span', 'wg-hstack');
        head.appendChild(el('span', 'wg-eyebrow', 'Goal line'));
        head.appendChild(el('span', 'wg-spacer'));
        if (offline) head.appendChild(chip('cached', 'stale', 'clock'));
        else if (Number.isFinite(g.change_7d)) {
            // Moving away from the target this week → warn; otherwise neutral.
            // Never praise: toward the goal is just the number.
            const away = Number.isFinite(g.direction) && g.direction !== 0 && g.change_7d * g.direction < -0.05
                && g.status !== 'at_goal' && g.status !== 'maintaining';
            head.appendChild(chip(`${signedWeightText(g.change_7d)} · 7d`, away ? 'warn' : undefined));
        }
        card.appendChild(head);

        const current = Number.isFinite(g.trend_weight) ? g.trend_weight
            : (g.latest_reading && Number.isFinite(g.latest_reading.weight) ? g.latest_reading.weight : null);
        if (current !== null && Number.isFinite(g.target)) {
            const nums = el('span', 'wg-hstack');
            nums.appendChild(el('span', 'wg-stat__value', weightFmt(current).text));
            const chev = ico('chev-r');
            chev.classList.add('wg-muted');
            nums.appendChild(chev);
            const tf = weightFmt(g.target);
            const target = el('span', 'wg-stat__value wg-sun', tf.text);
            target.appendChild(el('small', null, tf.unit));
            nums.appendChild(target);
            card.appendChild(nums);
        }

        if (g.status === 'preliminary') {
            const cov = g.coverage || {};
            const needed = Math.max(1, (Number(cov.min_weigh_in_days) || 0) - (Number(cov.weigh_in_days_28d) || 0));
            card.appendChild(el('p', 'wg-hint', g.latest_reading && Number.isFinite(g.latest_reading.weight)
                ? `Latest ${weightText(g.latest_reading.weight)} · trend forms after ${needed} more weigh-in${needed === 1 ? '' : 's'}`
                : 'Log a weigh-in to start your goal line'));
        } else if (g.status === 'at_goal' || g.status === 'maintaining') {
            card.appendChild(el('p', 'wg-hint', g.status === 'maintaining'
                ? `Maintaining your goal — trend holding at ${weightText(g.target)}`
                : `At your goal — trend has reached ${weightText(g.target)}`));
        } else if (g.progress) {
            // goal.progress is the episode progress the Weight tab and Journey
            // render too — never recomputed here, so the screens agree.
            goalTrack(g).forEach((n) => card.appendChild(n));
        }

        // The only pace judgment on the card: a calm safety line, never praise.
        if (g.too_fast) {
            card.appendChild(el('p', 'wg-hint', 'Faster than 1% a week — worth checking with your doctor.'));
        }

        // A reached milestone (med-8tur.5): shown once, until acknowledged.
        const ms = v.milestone;
        if (ms && ms.id && typeof h.onAckMilestone === 'function') {
            const row = el('span', 'wg-hstack');
            row.setAttribute('data-milestone-id', ms.id);
            row.appendChild(el('span', 'wg-meta', ms.title || 'Goal milestone reached'));
            row.appendChild(el('span', 'wg-spacer'));
            row.appendChild(btn('Got it', { sm: true, action: 'ack-milestone', onClick: () => h.onAckMilestone(ms.id) }));
            card.appendChild(row);
        }

        const plan = goalPlanLine(v.plan);
        if (plan) card.appendChild(plan);

        // Medication safety net: invisible unless the trailing PDC has slipped.
        const nudge = goalAdherenceNudge(v.adherence_alert, h);
        if (nudge) card.appendChild(nudge);

        // Weigh in stays a plain button; the session CTA moved to Next up.
        if (v.cta === 'weigh_in' && typeof h.onAddWeight === 'function') {
            const foot = el('div', 'wg-card__foot');
            foot.appendChild(btn('Weigh in', { sm: true, icon: 'scale', action: 'weigh-in', onClick: h.onAddWeight }));
            card.appendChild(foot);
        }
        return { node: card, primary: false };
    }

    // Default milestone ack (med-8tur.5): optimistic `milestone: null` on the
    // cached Goal Line, then the user write; rolled back when it fails.
    async function ackMilestoneDefault(id) {
        const ds = typeof window !== 'undefined' ? window.DataStore : null;
        const handle = (ds && typeof ds.applyOptimistic === 'function')
            ? await ds.applyOptimistic('gamification_goal_line',
                (prev) => (prev && typeof prev === 'object' ? { ...prev, milestone: null } : prev), ['gamification'])
            : null;
        const call = typeof window !== 'undefined' ? (window.offlineAwareApiCall || window.apiCallDirect) : null;
        let res = null;
        try {
            if (typeof call === 'function') res = await call(`/api/gamification/milestones/${encodeURIComponent(id)}/ack`, 'POST');
        } catch (_) { res = null; }
        if (!handle) return;
        try {
            if (res && res.ok) await handle.commit(null);
            else await handle.rollback();
        } catch (_) { /* best-effort */ }
    }

    // ---- Log sheet (T3) -----------------------------------------------------
    //
    // The Today "Log" button opens a kit bottom sheet of .wg-action tiles:
    // food fast paths first, then measurements & notes. Disabled features
    // drop out. Each tile closes the sheet and runs the same opener the old
    // shortcut tiles ran. The sheet is a dynamic <mt-modal> on <body>, opened
    // through ModalManager so Back / Esc close it.

    function logSheetGroups(state, h) {
        const food = on(state && state.caloriesToday) ? [
            { id: 'food-search', icon: 'search', label: 'Search', sub: 'Your foods + database', run: h.onLogFood },
            { id: 'food-photo', icon: 'camera', label: 'Photo meal', sub: 'AI estimates it', run: h.onPhotoMeal },
            { id: 'food-scan', icon: 'barcode', label: 'Scan barcode', run: h.onScanFood },
            { id: 'food-describe', icon: 'sparkle', label: 'Describe', sub: '"200 g chicken, rice"', run: h.onDescribeFood },
        ] : [];
        const measure = [];
        if (on(state && state.bpLatest)) measure.push({ id: 'bp', icon: 'activity', label: 'BP', run: h.onAddBp });
        if (on(state && state.weightLatest)) measure.push({ id: 'weight', icon: 'scale', label: 'Weight', run: h.onAddWeight });
        if (on(state && state.sleepLastNight)) measure.push({ id: 'note', icon: 'note', label: 'Note', run: h.onAddNote });
        return { food, measure };
    }

    function closeLogSheet() {
        const mm = typeof window !== 'undefined' ? window.ModalManager : null;
        if (mm && typeof mm.close === 'function') { mm.close(LOG_SHEET_ID); return; }
        const sheet = doc().getElementById(LOG_SHEET_ID);
        if (sheet) sheet.classList.add('hidden');
    }

    function openLogSheet(groups, nowMs) {
        const d = doc();
        let sheet = d.getElementById(LOG_SHEET_ID);
        if (!sheet) {
            sheet = d.createElement('mt-modal');
            sheet.id = LOG_SHEET_ID;
            sheet.className = 'hidden wg-modal wg-sheet wg-today-log-sheet';
            sheet.setAttribute('aria-label', 'Log');
            d.body.appendChild(sheet);
        }
        sheet.replaceChildren();
        sheet.appendChild(el('div', 'wg-sheet__grab'));
        const head = el('header', 'wg-sheethead');
        const titles = el('div', 'wg-sheethead__titles');
        titles.appendChild(el('div', 'wg-eyebrow', `Now · ${fmtTimeHM(new Date(nowMs).toISOString())}`));
        titles.appendChild(el('div', 'wg-sheethead__title', 'Log'));
        const acts = el('div', 'wg-sheethead__acts');
        acts.appendChild(btn(null, { ghost: true, iconOnly: true, icon: 'x', aria: 'Close', action: 'close', onClick: closeLogSheet }));
        head.append(titles, acts);
        sheet.appendChild(head);

        const body = el('div', 'wg-sheet__body');
        const group = (title, tiles, cls) => {
            if (!tiles.length) return;
            body.appendChild(el('span', 'wg-eyebrow', title));
            const grid = el('div', cls);
            for (const t of tiles) {
                const tile = el('button', 'wg-action');
                tile.type = 'button';
                tile.setAttribute('data-log', t.id);
                const iconWrap = el('span', 'wg-action__icon');
                iconWrap.appendChild(ico(t.icon));
                const label = el('span', 'wg-action__label', t.label);
                if (t.sub) label.appendChild(el('span', 'wg-action__sub', t.sub));
                tile.append(iconWrap, label);
                tile.addEventListener('click', () => {
                    closeLogSheet();
                    if (typeof t.run === 'function') t.run();
                });
                grid.appendChild(tile);
            }
            body.appendChild(grid);
        };
        group('Food', groups.food, 'wg-actions');
        group('Measurements & notes', groups.measure, 'wg-actions wg-actions--3');
        sheet.appendChild(body);
        hydrateIcons(sheet);

        const mm = typeof window !== 'undefined' ? window.ModalManager : null;
        if (mm && typeof mm.open === 'function') {
            if (typeof mm.register === 'function') mm.register(LOG_SHEET_ID, closeLogSheet);
            mm.open(LOG_SHEET_ID);
        } else if (typeof sheet.open === 'function') {
            sheet.open();
        } else {
            sheet.classList.remove('hidden');
        }
        return sheet;
    }

    // ---- Default openers ----------------------------------------------------

    function briefOpenerOrNull() {
        if (typeof window === 'undefined') return null;
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

    function resolveHandlers(opts) {
        const win = (typeof window !== 'undefined') ? window : {};
        const onDeeplink = opts.onDeeplink || ((target) => {
            if (target && typeof win.switchTab === 'function') win.switchTab(target);
        });
        const onLogFood = opts.onLogFood || defaultHandler('showAddFoodModal', 'food');
        return {
            onDeeplink,
            onLogFood,
            onAddBp: opts.onAddBp || defaultHandler('showBPRecordModal', 'bp'),
            onAddWeight: opts.onAddWeight || defaultHandler('showWeightModal', 'weight'),
            onPhotoMeal: opts.onPhotoMeal || (() => {
                if (win.FoodActions && typeof win.FoodActions.triggerPhotoPicker === 'function') {
                    win.FoodActions.triggerPhotoPicker();
                }
            }),
            onScanFood: opts.onScanFood || (() => {
                if (win.FoodLog && typeof win.FoodLog.openAdd === 'function') win.FoodLog.openAdd();
                if (win.FoodScanner && typeof win.FoodScanner.openFoodScannerModal === 'function') {
                    win.FoodScanner.openFoodScannerModal();
                } else if (win.ModalManager && win.ModalManager.foodScanner
                    && typeof win.ModalManager.foodScanner.open === 'function') {
                    win.ModalManager.foodScanner.open();
                }
            }),
            // The add-food modal in its AI "describe your meal" mode.
            onDescribeFood: opts.onDescribeFood || (() => {
                onLogFood();
                if (typeof win.setFoodParseAIMode === 'function') win.setFoodParseAIMode(true);
                const name = doc().getElementById('food-name');
                if (name && typeof name.focus === 'function') name.focus();
            }),
            // There is no new-note modal: the Notes sub-tab composer is the
            // one create path.
            onAddNote: opts.onAddNote || (() => {
                onDeeplink('health');
                const tab = doc().querySelector('.health-tab[data-tab="notes"]');
                if (tab) tab.click();
                const ta = doc().getElementById('notes-textarea');
                if (ta && typeof ta.focus === 'function') ta.focus();
            }),
            // Cloud-only: GET /api/brief is answered by web/cloud/js/apishim.js
            // and the print helper is served from the cloud shell. No handler →
            // no button rather than one that can only fail.
            onDoctorBrief: opts.onDoctorBrief || briefOpenerOrNull(),
            onTakeMed: opts.onTakeMed || ((v) => {
                const ids = Array.isArray(v && v.ids) ? v.ids : [];
                if (ids.length && typeof win.showMedicationConfirmModal === 'function') {
                    win.showMedicationConfirmModal(ids, v.names || [], v.scheduledAt, 'confirm', v.intakeIds || []);
                } else {
                    onDeeplink('meds');
                }
            }),
            onStartWorkout: opts.onStartWorkout || ((id) => {
                if (win.WorkoutSessions && typeof win.WorkoutSessions.start === 'function') win.WorkoutSessions.start(id);
                else onDeeplink('workouts');
            }),
            onResumeWorkout: opts.onResumeWorkout || ((id) => {
                if (win.WorkoutSessions && typeof win.WorkoutSessions.open === 'function') win.WorkoutSessions.open(id);
                else onDeeplink('workouts');
            }),
            onAddMedication: opts.onAddMedication || (() => {
                onDeeplink('meds');
                const add = doc().getElementById('add-btn');
                if (add) add.click();
            }),
            onCreatePlan: opts.onCreatePlan || (() => {
                onDeeplink('workouts');
                if (win.WorkoutGroups && typeof win.WorkoutGroups.openAdd === 'function') win.WorkoutGroups.openAdd();
            }),
            onRetry: opts.onRetry || (() => {
                if (typeof win.loadToday === 'function') win.loadToday();
                else if (win.TodayLoader && typeof win.TodayLoader.loadToday === 'function') win.TodayLoader.loadToday();
            }),
            onAckMilestone: opts.onAckMilestone || ackMilestoneDefault,
        };
    }

    // ---- States (T4–T6) -----------------------------------------------------

    // No cache of any kind on this device yet. Offline → the shared offline
    // state; a finished fetch that still left nothing → error + Retry;
    // otherwise (first unlock, fetch in flight) a skeleton shaped like T1.
    function renderFirstRun(root, opts, h) {
        if (opts.offline) {
            root.appendChild(createOfflineEmptyState());
            return;
        }
        if (opts.settled) {
            root.appendChild(createErrorState('Couldn’t load your day.', h.onRetry));
            return;
        }
        const stack = el('div', 'wg-vstack wg-today-skeleton');
        stack.setAttribute('data-section', 'skeleton');
        stack.setAttribute('aria-busy', 'true');
        stack.appendChild(createSkeleton('line', 1));
        stack.appendChild(createSkeleton('card', 1));
        const tiles = createSkeleton('tile', 3);
        tiles.classList.add('wg-grid3');
        stack.appendChild(tiles);
        stack.appendChild(createSkeleton('card', 1));
        stack.appendChild(el('span', 'wg-meta', 'Loading your day…'));
        root.appendChild(stack);
    }

    function renderToday(state, root, handlers) {
        const d = doc();
        if (!d || !root) return;
        const opts = handlers || {};
        const h = resolveHandlers(opts);
        const nowMs = (opts.now instanceof Date) ? opts.now.getTime() : (opts.now || Date.now());
        const offline = opts.offline === true;

        root.innerHTML = '';
        root.classList.add('wg-today');
        root.classList.add('today-root');

        if (state && state.__firstRun) {
            renderFirstRun(root, opts, h);
            hydrateIcons(root);
            return root;
        }

        // Call row: Call agent · Log · Doctor brief. The call card is mounted
        // into the row; mountCard() dedupes within its container and
        // reattaches live call state to a freshly built card, so a re-render
        // mid-call keeps "End call".
        const groups = logSheetGroups(state, h);
        const anyLog = groups.food.length + groups.measure.length > 0;
        const anyFeature = anyLog || on(state && state.nextMed) || on(state && state.nextWorkout);
        const callRow = el('div', 'wg-callbar wg-today-callbar');
        callRow.setAttribute('data-section', 'callbar');
        if (typeof window !== 'undefined' && window.WGCallAgent && typeof window.WGCallAgent.mountCard === 'function') {
            window.WGCallAgent.mountCard(callRow);
        }
        if (anyLog) {
            callRow.appendChild(btn('Log', {
                icon: 'plus', action: 'open-log',
                onClick: () => openLogSheet(logSheetGroups(state, h), Date.now()),
            }));
        }
        if (typeof h.onDoctorBrief === 'function' && anyFeature) {
            callRow.appendChild(btn(null, {
                iconOnly: true, icon: 'file', aria: 'Doctor brief', action: 'doctor-brief',
                onClick: () => h.onDoctorBrief(),
            }));
        }
        if (callRow.childNodes.length) {
            root.appendChild(callRow);
        }

        const next = renderNextUp(state, h, nowMs);
        if (next.node) { root.appendChild(next.node); }

        const vitals = [
            renderBpTile(state && state.bpLatest, state && state.bpTrend7d, h, nowMs, offline),
            renderWeightTile(state && state.weightLatest, state && state.weightTrend7d, h, nowMs, offline),
            renderFuelTile(state && state.caloriesToday, state && state.caloriesTarget, h),
        ].filter(Boolean);
        if (vitals.length) {
            const strip = el('div', vitals.length === 3 ? 'wg-grid3' : 'wg-grid2');
            strip.setAttribute('data-section', 'vitals');
            vitals.forEach((t) => strip.appendChild(t));
            root.appendChild(strip);
        }

        const goal = renderGoalCard(state && state.goalLine, h, !next.hasPrimary, offline);
        if (goal.node) { root.appendChild(goal.node); }

        const macros = renderMacrosCard(state, h);
        if (macros) { root.appendChild(macros); }

        const fold = [
            renderSleepTile(state && state.sleepLastNight, h, nowMs, offline),
            renderStepsTile(state && state.stepsLatest, h, nowMs, offline),
        ].filter(Boolean);
        if (fold.length) {
            const grid = el('div', 'wg-grid2');
            grid.setAttribute('data-section', 'sleep-steps');
            fold.forEach((t) => grid.appendChild(t));
            root.appendChild(grid);
        }

        // TZ-transition plan card (med-xso6.14 owns its look). Mounts nothing
        // when no plan is in flight.
        if (typeof window !== 'undefined' && window.TZPlanBanner
            && typeof window.TZPlanBanner.mountCard === 'function') {
            window.TZPlanBanner.mountCard(root);
        }

        // Nothing tracked (only the call card, if any) → every feature is off.
        if (!anyFeature && !goal.node) {
            const empty = typeof createEmptyState === 'function'
                ? createEmptyState({
                    icon: 'gear',
                    title: 'All features are off',
                    body: 'Turn one on in Settings.',
                    actions: [{ label: 'Open Settings', icon: 'gear', onClick: () => h.onDeeplink('settings') }],
                })
                : el('p', 'wg-hint', 'All features are off');
            empty.setAttribute('data-section', 'all-off');
            root.appendChild(empty);
        }

        hydrateIcons(root);
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
    //   - The window fires 'online' or 'offline' — so the dashboard can
    //     re-render and retry fresh data.
    //
    // onRefresh receives { source, tags?, data? } describing the trigger.
    // Returns an unsubscribe function that removes every registered listener.
    // ------------------------------------------------------------------------

    // Must match the tag vocabulary emitted by internal/store/migrations/027_add_change_events.sql.
    // Notable: workout uses singular 'workout' (not 'workouts'), intake_log emits 'history',
    // and reminder/settings tables emit 'settings'.
    const RELEVANT_TAGS = ['bp', 'weight', 'medications', 'history', 'food', 'workout', 'health', 'settings', 'gamification'];

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
        subscribe
    };
})();
