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
            goalLine: goalLineCell(goalLinePayload, gamificationEnabled, weightEnabled),
            // GET /api/trackers as cached (no feature flag: no trackers, no card).
            trackers: Array.isArray(caches.trackers) ? caches.trackers : null
        };
        return result;
    }

    // ---- Rendering (kit v2, screens-today.html T1/T3–T6, med-xso6.13) ------
    //
    // renderToday(state, root, handlers) fills `root` top to bottom:
    //   call row (Call agent · Log · Doctor brief) → Next up list → vitals
    //   strip (BP · Weight · Fuel) → Trackers card → Goal Line track → macros card →
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

    // ---- Trackers card (screens-trackers.html TR1/TR1b, med-1vy5.2) --------
    //
    // One tile per active tracker, between the vitals strip and the Goal Line.
    // Tap = +step (count) or toggle today (check); the toast undoes exactly
    // that log. The ⋯ button or a long press (contextmenu) opens the log sheet:
    // a custom amount plus today's logs with delete. Every write patches the
    // cached GET /api/trackers list through DataStore.applyOptimistic and
    // commits (with the real log id) or rolls back. No list read yet → no
    // card; an empty list → the create prompt (TR1-C).

    const TRACKERS_KEY = 'trackers';
    const TRACKERS_TAGS = ['trackers'];
    const TRACKER_SHEET_ID = 'today-tracker-sheet';
    const PERIOD_WORD = { day: 'today', week: 'this week', month: 'this month' };
    const PERIOD_RULE = { day: 'a day', week: 'a week', month: 'a month' };

    function fmtNum(n) {
        return String(Math.round(Number(n) * 100) / 100);
    }

    // ponytail: naive English plural (glass → glasses, cup → cups);
    // abbreviations (ml, km) stay as typed. Per-unit plurals when someone asks.
    function unitText(unit, n) {
        if (!unit) return '';
        if (Number(n) === 1 || unit.length <= 2) return unit;
        return /(s|x|z|ch|sh)$/.test(unit) ? `${unit}es` : `${unit}s`;
    }

    function trackerDoneToday(t) {
        return t.kind === 'check' && Array.isArray(t.todayLogs) && t.todayLogs.length > 0;
    }

    // 'met' | 'todo' (goals) · 'under' | 'at' | 'over' (limits).
    function trackerState(t) {
        const p = t.progress || {};
        if (t.target && t.target.op === 'atMost') {
            if (p.total > p.target) return 'over';
            return p.total === p.target ? 'at' : 'under';
        }
        return p.total >= p.target ? 'met' : 'todo';
    }

    // "5 / 8 glasses", "2 / ≤3 cups", "2 / 3 this week".
    function trackerRatio(t) {
        const p = t.progress || {};
        const lim = t.target.op === 'atMost' ? '≤' : '';
        const tail = t.target.period === 'day' ? unitText(t.unit, p.target) : PERIOD_WORD[t.target.period];
        return { value: fmtNum(p.total), rest: `/ ${lim}${fmtNum(p.target)}${tail ? ` ${tail}` : ''}` };
    }

    function trackerGlyph(t) {
        const g = el('span', 'wg-trk__glyph');
        const e = typeof t.emoji === 'string' ? t.emoji : '';
        const W = typeof window !== 'undefined' ? window.WGIcons : null;
        if (/^[a-z-]+$/.test(e) && W && W.paths && W.paths[e]) {
            g.appendChild(ico(e));
        } else if (e) {
            // The emoji exception: user content inside the glyph only.
            g.classList.add('wg-trk__glyph--emoji');
            g.textContent = e;
        } else {
            g.appendChild(ico('target'));
        }
        return g;
    }

    function patchTracker(id, fn) {
        return (prev) => (Array.isArray(prev) ? prev.map((t) => (t && t.id === id ? fn(t) : t)) : prev);
    }

    function logAmount(t, log) {
        return t.kind === 'check' ? 1 : (Number(log.amount) || 0);
    }

    function withLogs(t, delta, todayLogs) {
        const p = t.progress || { total: 0, target: 0 };
        const total = Number(p.total) + delta;
        // Weekly strip: today's segment moves with the optimistic total.
        const days = Array.isArray(p.days)
            ? p.days.map((d) => (d.day === t.day ? { ...d, total: d.total + delta } : d)) : p.days;
        const met = t.target.op === 'atMost' ? total <= p.target : total >= p.target;
        return { ...t, todayLogs, progress: { ...p, total, met, days } };
    }

    function addLog(log) {
        return (t) => withLogs(t, logAmount(t, log), [log, ...(t.todayLogs || [])]);
    }

    function dropLog(logId) {
        return (t) => {
            const log = (t.todayLogs || []).find((l) => l.id === logId);
            return log ? withLogs(t, -logAmount(t, log), t.todayLogs.filter((l) => l.id !== logId)) : t;
        };
    }

    function trackersApi() {
        return (typeof window !== 'undefined' && typeof window.apiCall === 'function') ? window.apiCall : null;
    }

    // One optimistic write on the cached list: patch, send, then commit —
    // `settle(res)` (optional, may await a read) returns a patch for the
    // CURRENT list that swaps provisional data for the server's. A failed
    // call (apiCall resolves null and has already told the user) commits
    // `revert` over the current list instead of rolling back to the
    // snapshot, so an overlapping tap that succeeded meanwhile is not erased.
    async function trackerWrite(mutator, revert, send, settle) {
        const ds = typeof window !== 'undefined' ? window.DataStore : null;
        const handle = (ds && typeof ds.applyOptimistic === 'function')
            ? await ds.applyOptimistic(TRACKERS_KEY, mutator, TRACKERS_TAGS)
            : null;
        let res = null;
        try { res = await send(); } catch (_) { res = null; }
        if (!handle) return res;
        try {
            const patch = res && settle ? await settle(res) : null;
            const cur = await ds.getCached(TRACKERS_KEY);
            if (!Array.isArray(cur)) {
                await (res ? handle.commit(null) : handle.rollback());
            } else if (!res) {
                await handle.commit(revert(cur));
            } else if (patch) {
                await handle.commit(patch(cur));
            } else {
                await handle.commit(null);
            }
        } catch (_) { /* best-effort */ }
        return res;
    }

    function trackerToast(message, detail, onUndo) {
        const toast = (typeof window !== 'undefined' && typeof window.safeToast === 'function')
            ? window.safeToast(message, 'success', { detail, action: { label: 'Undo', onClick: onUndo } })
            : null;
        const sheet = doc().getElementById(TRACKER_SHEET_ID);
        if (toast && toast.root && toast.root.parentElement && sheet && !sheet.classList.contains('hidden')) {
            toast.root.parentElement.classList.add('wg-toasts--sheet');
        }
    }

    function trackerDetail(t) {
        const r = trackerRatio(t);
        return `${r.value} ${r.rest}`;
    }

    // Count: append one log of `amount` (default the tap step), at `at`
    // (default now). Check: mark today done. Toasts with Undo unless `quiet`
    // (an undo of an undo).
    async function logTracker(t, amount, quiet, at) {
        const api = trackersApi();
        if (!api) return null;
        const provisionalId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const n = t.kind === 'check' ? 1 : (Number(amount) > 0 ? Number(amount) : t.step);
        const log = t.kind === 'check'
            ? { id: provisionalId, trackerId: t.id, done: true }
            : { id: provisionalId, trackerId: t.id, at: at || new Date().toISOString(), amount: n };
        const res = await trackerWrite(patchTracker(t.id, addLog(log)), patchTracker(t.id, dropLog(provisionalId)),
            () => api(`/api/trackers/${encodeURIComponent(t.id)}/log`, 'POST',
                t.kind === 'check' ? {} : (at ? { amount: n, at } : { amount: n })),
            (saved) => (saved.id ? (cur) => cur.map((x) => ({
                ...x,
                todayLogs: (x.todayLogs || []).map((l) => (l.id === provisionalId ? saved : l)),
            })) : null));
        if (res && res.id && !quiet) {
            const message = t.kind === 'check' ? `${t.name} done` : `${t.name} +${fmtNum(n)}`;
            trackerToast(message, trackerDetail(addLog(log)(t)), () => unlogTracker(t, res, true));
        }
        return res;
    }

    // Count: delete that one log. Check: write done:false for its day.
    async function unlogTracker(t, log, quiet) {
        const api = trackersApi();
        if (!api) return null;
        const res = await trackerWrite(patchTracker(t.id, dropLog(log.id)), patchTracker(t.id, addLog(log)),
            () => api(`/api/trackers/${encodeURIComponent(t.id)}/log/${encodeURIComponent(log.id)}`, 'DELETE'));
        if (res && !quiet) {
            const message = t.kind === 'check'
                ? `${t.name} not done`
                : `Removed +${fmtNum(log.amount)}${t.unit ? ` ${unitText(t.unit, log.amount)}` : ''}`;
            trackerToast(message, null, () => logTracker(t, log.amount, true, log.at));
        }
        return res;
    }

    // A log still carrying its provisional id has no server record to delete
    // yet; its tap / delete waits for the commit.
    function isProvisional(log) {
        return String(log && log.id).startsWith('pending-');
    }

    function trackerTap(t) {
        if (isProvisional(t)) return null; // created a moment ago, not saved yet
        if (trackerDoneToday(t)) {
            return isProvisional(t.todayLogs[0]) ? null : unlogTracker(t, t.todayLogs[0]);
        }
        return logTracker(t, t.step);
    }

    function renderTrackerTile(t) {
        const state = trackerState(t);
        const done = trackerDoneToday(t);
        let cls = 'wg-trk';
        if (state === 'met') cls += ' wg-trk--met';
        if (state === 'over') cls += ' wg-trk--over';
        const tile = el('div', cls);
        tile.setAttribute('data-tracker-id', t.id);
        tile.setAttribute('data-state', state);

        const tap = el('button', 'wg-trk__tap');
        tap.type = 'button';
        tap.setAttribute('data-action', 'tracker-tap');
        const top = el('span', 'wg-trk__top');
        top.append(trackerGlyph(t), el('span', 'wg-trk__name', t.name));
        tap.appendChild(top);

        const r = trackerRatio(t);
        const p = t.progress || {};
        if (t.kind === 'check' && t.target.period === 'day') {
            tap.appendChild(el('span', 'wg-trk__val wg-trk__val--text', done ? 'Done' : 'Not yet'));
        } else {
            const val = el('span', 'wg-trk__val', r.value);
            val.appendChild(el('small', null, r.rest));
            tap.appendChild(val);
        }

        if (t.kind === 'check') {
            const row = el('span', 'wg-trk__check');
            const tick = el('span', 'wg-trk__tick');
            if (done) tick.appendChild(ico('check'));
            row.append(tick, el('span', 'wg-meta', done ? 'Done today' : 'Tap when done'));
            tap.appendChild(row);
            tap.setAttribute('aria-label', `${t.name}, ${done ? 'done today. Tap to undo' : 'not done yet. Tap to mark done'}`);
        } else {
            tap.appendChild(Array.isArray(p.days) && p.days.length === 7 ? trackerWeek(t) : trackerMeter(t));
            const foot = el('span', 'wg-trk__foot');
            const left = fmtNum(Math.max(0, p.target - p.total));
            if (state === 'met') foot.appendChild(chip('Goal met', 'ok', 'check'));
            else if (state === 'todo') foot.appendChild(el('span', 'wg-meta', `${left} to go`));
            else if (state === 'under') foot.appendChild(el('span', 'wg-meta', `${left} left ${PERIOD_WORD[t.target.period]}`));
            else if (state === 'at') foot.appendChild(chip('At limit'));
            else foot.appendChild(chip(`${fmtNum(p.total - p.target)} over`, 'warn'));
            tap.appendChild(foot);
            tap.setAttribute('aria-label', `${t.name}, ${r.value} ${r.rest}. Tap to add ${fmtNum(t.step)}`);
        }
        tap.addEventListener('click', () => trackerTap(t));
        // Long press on touch surfaces as contextmenu: open the log sheet.
        tap.addEventListener('contextmenu', (e) => { e.preventDefault(); openTrackerSheet(t); });
        tile.appendChild(tap);

        const more = el('button', 'wg-trk__more');
        more.type = 'button';
        more.setAttribute('data-action', 'tracker-more');
        more.setAttribute('aria-label', `${t.name}: log and options`);
        more.appendChild(ico('more', true));
        more.addEventListener('click', () => openTrackerSheet(t));
        tile.appendChild(more);
        return tile;
    }

    // A list cached on an earlier account-local day (Today left open past
    // midnight, or an offline relaunch) must not show — or let a tap delete —
    // yesterday's logs. The loader refetches it; until then the day's logs
    // are dropped.
    function freshTracker(t, nowMs) {
        if (!t.day || !t.timeZone) return t;
        let today;
        try {
            today = new Intl.DateTimeFormat('en-CA', {
                timeZone: t.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
            }).format(new Date(nowMs));
        } catch (_) { return t; }
        if (today === t.day) return t;
        const p = t.progress || {};
        // ponytail: a week/month total keeps its sum (yesterday is still in the
        // period, except across a period boundary) until the refetch lands.
        return withLogs({ ...t, progress: { ...p, total: t.target.period === 'day' ? 0 : p.total } }, 0, []);
    }

    function trackersFor(list, nowMs) {
        return Array.isArray(list) ? list.filter((t) => t && t.id && t.target).map((t) => freshTracker(t, nowMs)) : [];
    }

    // "Not now" on the empty card is a per-device convenience: the card
    // collapses to its header, whose "+" still creates.
    const TRACKERS_EMPTY_DISMISSED = 'wg.today.trackersEmptyDismissed';

    function trackersEmptyDismissed() {
        try { return window.localStorage.getItem(TRACKERS_EMPTY_DISMISSED) === '1'; } catch (_) { return false; }
    }

    function dismissTrackersEmpty() {
        try { window.localStorage.setItem(TRACKERS_EMPTY_DISMISSED, '1'); } catch (_) { /* best-effort */ }
        const card = doc().querySelector('[data-section="trackers"]');
        const empty = card && card.querySelector('.wg-empty');
        if (empty) empty.remove();
    }

    // No list yet (never fetched) → no card. An empty list → the TR1-C empty
    // state, or just the header once dismissed.
    function renderTrackersCard(list, nowMs) {
        if (!Array.isArray(list)) return null;
        const trackers = trackersFor(list, nowMs);
        const card = el('section', 'wg-card wg-today-trackers');
        card.setAttribute('data-section', 'trackers');
        const head = el('div', 'wg-card__head');
        head.appendChild(el('span', 'wg-card__title', 'Trackers'));
        const acts = el('span', 'wg-hstack');
        acts.appendChild(btn(null, { ghost: true, iconOnly: true, icon: 'plus', aria: 'New tracker', action: 'tracker-new', onClick: () => openTrackerEditor() }));
        if (trackers.length) acts.appendChild(btn('Manage', { ghost: true, action: 'tracker-manage', onClick: () => openTrackerManage(trackers) }));
        head.appendChild(acts);
        card.appendChild(head);
        if (!trackers.length) {
            if (!trackersEmptyDismissed()) {
                const empty = el('div', 'wg-empty');
                const icon = el('span', 'wg-empty__icon');
                icon.appendChild(ico('target'));
                const emptyActs = el('div', 'wg-empty__acts');
                emptyActs.append(
                    btn('Add a tracker', { sm: true, icon: 'plus', action: 'tracker-empty-add', onClick: () => openTrackerEditor() }),
                    btn('Not now', { sm: true, ghost: true, action: 'tracker-empty-dismiss', onClick: dismissTrackersEmpty }),
                );
                empty.append(icon, el('p', 'wg-empty__title', 'Track anything'),
                    el('p', 'wg-empty__body', 'Count glasses of water, keep coffee under a limit, or check off a daily stretch. One tap logs it.'),
                    emptyActs);
                card.appendChild(empty);
            }
            return card;
        }
        const grid = el('div', 'wg-trks');
        trackers.forEach((t) => grid.appendChild(renderTrackerTile(t)));
        card.appendChild(grid);
        return card;
    }

    // ---- Tracker log sheet (TR1b) ------------------------------------------

    function closeTrackerSheet() {
        const stack = doc().querySelector('body > .wg-toasts');
        if (stack) stack.classList.remove('wg-toasts--sheet');
        hideTrackerModal(TRACKER_SHEET_ID);
    }

    function renderTrackerSheet(sheet, t) {
        sheet.replaceChildren();
        sheet.setAttribute('data-tracker-id', t.id);
        const step = Number(t.step) > 0 ? Number(t.step) : 1;
        const amount = Number(sheet.getAttribute('data-amount')) > 0 ? Number(sheet.getAttribute('data-amount')) : step;
        sheet.setAttribute('data-amount', String(amount));

        sheet.appendChild(el('div', 'wg-sheet__grab'));
        const head = el('header', 'wg-sheethead');
        const titles = el('div', 'wg-sheethead__titles');
        titles.appendChild(el('div', 'wg-eyebrow', 'Tracker · today'));
        titles.appendChild(el('div', 'wg-sheethead__title', t.name));
        const acts = el('div', 'wg-sheethead__acts');
        acts.appendChild(btn(null, { ghost: true, iconOnly: true, icon: 'x', aria: 'Close', action: 'close', onClick: closeTrackerSheet }));
        head.append(titles, acts);
        sheet.appendChild(head);

        const body = el('div', 'wg-sheet__body');
        const summary = el('div', 'wg-vstack');
        const line = el('div', 'wg-hstack');
        const r = trackerRatio(t);
        const stat = el('span', 'wg-stat__value', r.value);
        stat.appendChild(el('small', null, r.rest));
        const rule = `${t.target.op === 'atMost' ? 'at most' : 'at least'} ${fmtNum(t.target.value)} ${PERIOD_RULE[t.target.period] || ''}`.trim();
        line.append(stat, el('span', 'wg-spacer'), el('span', 'wg-meta', rule));
        summary.appendChild(line);
        body.appendChild(summary);

        if (t.kind === 'count') {
            const field = el('div', 'wg-field');
            field.appendChild(el('span', 'wg-label', 'Add an amount'));
            const stepper = el('div', 'wg-stepper');
            const minus = el('button', 'wg-stepper__btn');
            minus.type = 'button';
            minus.setAttribute('aria-label', 'Fewer');
            minus.setAttribute('data-action', 'tracker-fewer');
            minus.appendChild(ico('minus'));
            const val = el('span', 'wg-stepper__val', fmtNum(amount));
            val.appendChild(el('small', null, unitText(t.unit, amount)));
            const plus = el('button', 'wg-stepper__btn');
            plus.type = 'button';
            plus.setAttribute('aria-label', 'More');
            plus.setAttribute('data-action', 'tracker-more-amount');
            plus.appendChild(ico('plus'));
            const setAmount = (n) => {
                sheet.setAttribute('data-amount', String(Math.max(step, Math.round(n * 100) / 100)));
                renderTrackerSheet(sheet, t);
                hydrateIcons(sheet);
            };
            minus.addEventListener('click', () => setAmount(amount - step));
            plus.addEventListener('click', () => setAmount(amount + step));
            stepper.append(minus, val, plus);
            field.appendChild(stepper);
            body.appendChild(field);
        }

        const logs = Array.isArray(t.todayLogs) ? t.todayLogs : [];
        const section = el('section', 'wg-section');
        const sHead = el('div', 'wg-section__head');
        sHead.append(el('span', 'wg-eyebrow', 'Today’s logs'),
            el('span', 'wg-meta', `${logs.length} ${logs.length === 1 ? 'entry' : 'entries'}`));
        section.appendChild(sHead);
        if (!logs.length) {
            section.appendChild(el('p', 'wg-hint', 'Nothing logged today.'));
        } else {
            const list = el('div', 'wg-list');
            for (const log of logs) {
                const row = el('div', 'wg-row');
                row.setAttribute('data-log-id', log.id);
                const rb = el('span', 'wg-row__body');
                rb.appendChild(el('span', 'wg-row__title wg-row__title--mono',
                    t.kind === 'check' ? 'Done' : fmtTimeHM(log.at)));
                row.appendChild(rb);
                if (t.kind === 'count') {
                    const v = el('span', 'wg-row__value', `+${fmtNum(log.amount)}`);
                    if (t.unit) v.appendChild(el('small', null, unitText(t.unit, log.amount)));
                    row.appendChild(v);
                }
                const trail = el('span', 'wg-row__trail');
                if (!isProvisional(log)) trail.appendChild(btn(null, {
                    ghost: true, iconOnly: true, icon: 'trash', aria: 'Delete', action: 'tracker-delete-log',
                    onClick: () => unlogTracker(t, log),
                }));
                row.appendChild(trail);
                list.appendChild(row);
            }
            section.appendChild(list);
        }
        body.appendChild(section);
        const links = el('div', 'wg-list');
        links.append(
            trackerLink('setting', 'history', 'History', 'Last 30 days and habit strength', 'tracker-history',
                () => { closeTrackerSheet(); openTrackerHistory(t); }),
            trackerLink('setting', 'pencil', 'Edit tracker', 'Name, target, reminder', 'tracker-edit',
                () => { closeTrackerSheet(); openTrackerEditor(t); }),
        );
        body.appendChild(links);
        sheet.appendChild(body);

        if (t.kind === 'count' || !trackerDoneToday(t)) {
            const foot = el('div', 'wg-sheet__foot');
            const label = t.kind === 'count'
                ? `Add ${fmtNum(amount)}${t.unit ? ` ${unitText(t.unit, amount)}` : ''}`
                : 'Mark done';
            foot.appendChild(btn(label, {
                primary: true, action: 'tracker-add',
                onClick: () => logTracker(t, t.kind === 'count' ? amount : null),
            }));
            sheet.appendChild(foot);
        }
    }

    function openTrackerSheet(t) {
        if (isProvisional(t)) return null;
        const sheet = mountTrackerModal(TRACKER_SHEET_ID, 'wg-today-tracker-sheet', 'Tracker log');
        if (sheet.getAttribute('data-tracker-id') !== t.id) sheet.removeAttribute('data-amount');
        renderTrackerSheet(sheet, t);
        showTrackerModal(sheet, closeTrackerSheet);
        return sheet;
    }

    // A Today repaint (every optimistic write ends in one) refreshes an open
    // sheet from the same list, so its total and log rows track the tiles.
    function syncTrackerSheet(list, nowMs) {
        const sheet = doc().getElementById(TRACKER_SHEET_ID);
        if (!sheet || sheet.classList.contains('hidden')) return;
        const t = trackersFor(list, nowMs).find((x) => x && x.id === sheet.getAttribute('data-tracker-id'));
        if (!t) { closeTrackerSheet(); return; }
        renderTrackerSheet(sheet, t);
        hydrateIcons(sheet);
    }

    // ---- Tracker create / edit (TR2), manage, history (TR3) — med-1vy5.3 ----
    //
    // Create starts on the template picker; a template only prefills the
    // form. Edit opens on the form; the kind is fixed once created (the
    // domain refuses a change). Save validates inline, closes, and writes
    // through trackerWrite (DataStore.applyOptimistic). Archive is the only
    // delete: a wg-dialog confirm, then the tracker leaves the list. History
    // is a pushed WGPage: current period, 30 days of bars, habit strength.

    const TRACKER_EDITOR_ID = 'today-tracker-editor';
    const TRACKER_MANAGE_ID = 'today-tracker-manage';
    const TRACKER_ICONS = ['drop', 'cup', 'glass-off', 'stretch', 'pill', 'target'];
    const TRACKER_TEMPLATES = [
        { name: 'Water', emoji: 'drop', kind: 'count', unit: 'glass', step: 1, target: { op: 'atLeast', value: 8, period: 'day' } },
        { name: 'Coffee', emoji: 'cup', kind: 'count', unit: 'cup', step: 1, target: { op: 'atMost', value: 3, period: 'day' } },
        { name: 'No alcohol', emoji: 'glass-off', kind: 'check', unit: null, step: 1, target: { op: 'atLeast', value: 1, period: 'day' } },
        { name: 'Stretching', emoji: 'stretch', kind: 'check', unit: null, step: 1, target: { op: 'atLeast', value: 3, period: 'week' } },
        { name: 'Vitamins', emoji: 'pill', kind: 'check', unit: null, step: 1, target: { op: 'atLeast', value: 1, period: 'day' } },
    ];
    const PERIOD_PLURAL = { day: 'Days', week: 'Weeks', month: 'Months' };
    const REMINDER_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

    function trackerNum(v) {
        const s = String(v == null ? '' : v).trim().replace(',', '.');
        return s === '' ? NaN : Number(s);
    }

    // "at least 8 glasses a day", "every day", "3 times a week", "at most 0 cans a day".
    function trackerRuleText(d) {
        const { op, period } = d.target;
        const value = trackerNum(d.target.value);
        if (d.kind === 'check' && op === 'atLeast' && value === 1 && period === 'day') return 'every day';
        const what = d.kind === 'check' ? (value === 1 ? 'time' : 'times') : unitText(d.unit, value);
        const lead = d.kind === 'check' && op === 'atLeast' ? '' : `${op === 'atMost' ? 'at most' : 'at least'} `;
        const n = Number.isFinite(value) ? fmtNum(value) : '…';
        return `${lead}${n}${what ? ` ${what}` : ''} ${PERIOD_RULE[period]}`;
    }

    function trackerKindRule(t) {
        return `${t.kind === 'check' ? 'Check' : 'Count'} · ${trackerRuleText(t)}`;
    }

    function trackerFormHint(d) {
        const rule = trackerRuleText(d);
        const lead = rule.charAt(0).toUpperCase() + rule.slice(1);
        if (d.target.op === 'atMost') return `${lead}. ${PERIOD_PLURAL[d.target.period]} at or under the limit count as met.`;
        if (d.kind === 'check') return `${lead}. Tap the tile when it's done.`;
        const step = trackerNum(d.step);
        return `${lead}. Each tap on the tile adds ${Number.isFinite(step) ? fmtNum(step) : '…'}.`;
    }

    // A row lead: a kit icon name, else the user's emoji, else the target icon.
    function trackerLead(emoji) {
        const lead = el('span', 'wg-row__lead');
        const W = typeof window !== 'undefined' ? window.WGIcons : null;
        if (/^[a-z-]+$/.test(emoji || '') && W && W.paths && W.paths[emoji]) lead.appendChild(ico(emoji));
        else if (emoji) lead.textContent = emoji;
        else lead.appendChild(ico('target'));
        return lead;
    }

    // A tappable list row (kind 'row') or settings link (kind 'setting').
    function trackerLink(kind, emoji, title, desc, action, onClick) {
        const row = kind === 'row';
        const b = el('button', row ? 'wg-row' : 'wg-setting');
        b.type = 'button';
        b.setAttribute('data-action', action);
        const body = el('span', row ? 'wg-row__body' : 'wg-setting__body');
        body.appendChild(el('span', row ? 'wg-row__title' : 'wg-setting__title', title));
        if (desc) body.appendChild(el('span', row ? 'wg-row__meta' : 'wg-setting__desc', desc));
        const chev = ico('chev-r');
        chev.classList.add('wg-row__chev');
        b.append(trackerLead(emoji), body, chev);
        b.addEventListener('click', onClick);
        return b;
    }

    function trackerSheetHead(eyebrow, title, onClose, onSave) {
        const head = el('header', 'wg-sheethead');
        const titles = el('div', 'wg-sheethead__titles');
        titles.append(el('div', 'wg-eyebrow', eyebrow), el('div', 'wg-sheethead__title', title));
        const acts = el('div', 'wg-sheethead__acts');
        acts.appendChild(btn(null, { ghost: true, iconOnly: true, icon: 'x', aria: 'Close', action: 'close', onClick: onClose }));
        if (onSave) acts.appendChild(btn('Save', { primary: true, sm: true, action: 'tracker-save', onClick: onSave }));
        head.append(titles, acts);
        return head;
    }

    function mountTrackerModal(id, cls, label) {
        const d = doc();
        let node = d.getElementById(id);
        if (!node) {
            node = d.createElement('mt-modal');
            node.id = id;
            node.className = `hidden wg-modal wg-sheet${cls ? ` ${cls}` : ''}`;
            node.setAttribute('aria-label', label);
            d.body.appendChild(node);
        }
        return node;
    }

    function showTrackerModal(node, closer) {
        hydrateIcons(node);
        const mm = typeof window !== 'undefined' ? window.ModalManager : null;
        if (mm && typeof mm.open === 'function') {
            if (typeof mm.register === 'function') mm.register(node.id, closer);
            mm.open(node.id);
        } else if (typeof node.open === 'function') {
            node.open();
        } else {
            node.classList.remove('hidden');
        }
    }

    function hideTrackerModal(id) {
        const mm = typeof window !== 'undefined' ? window.ModalManager : null;
        if (mm && typeof mm.close === 'function') { mm.close(id); return; }
        const node = doc().getElementById(id);
        if (node) node.classList.add('hidden');
    }

    // The form's working copy: numbers stay the typed strings until Save.
    function trackerDraft(src) {
        const t = src || {};
        const target = t.target || { op: 'atLeast', value: '', period: 'day' };
        const emoji = typeof t.emoji === 'string' ? t.emoji : '';
        return {
            name: t.name || '',
            emoji,
            emojiMode: !!emoji && TRACKER_ICONS.indexOf(emoji) === -1,
            kind: t.kind || 'count',
            unit: t.unit || '',
            step: String(t.step || 1),
            target: { op: target.op, value: String(target.value), period: target.period },
            reminderOn: !!t.reminder,
            reminderTime: (t.reminder && t.reminder.time) || '20:00',
        };
    }

    // Mirrors normalizeTracker in web/domain/trackers.js, worded for people.
    function validateTrackerDraft(d) {
        const errors = {};
        const name = d.name.trim();
        if (!name) errors.name = 'Add a name so you can find it on Today';
        else if ([...name].length > 60) errors.name = 'Keep the name to 60 characters or fewer';
        if (d.kind === 'count' && !(trackerNum(d.step) > 0)) errors.step = 'Each tap must add more than 0';
        const v = trackerNum(d.target.value);
        if (d.target.op === 'atLeast' && !(v > 0)) {
            errors.value = 'A goal needs at least 1. To track "none", switch to Limit and use 0.';
        } else if (d.target.op === 'atMost' && !(v >= 0)) {
            errors.value = 'Enter a limit of 0 or more';
        }
        if (d.target.op === 'atLeast' && d.reminderOn && !REMINDER_TIME.test(d.reminderTime)) {
            errors.reminder = 'Pick a time for the reminder';
        }
        return errors;
    }

    // A limit carries no reminder: it is dropped on Save (TR2-C).
    function trackerBody(d) {
        const count = d.kind === 'count';
        return {
            name: d.name.trim(),
            emoji: d.emoji.trim(),
            unit: count && d.unit.trim() ? d.unit.trim() : null,
            step: count ? trackerNum(d.step) : 1,
            target: { op: d.target.op, value: trackerNum(d.target.value), period: d.target.period },
            reminder: d.target.op === 'atLeast' && d.reminderOn ? { time: d.reminderTime } : null,
        };
    }

    function closeTrackerEditor() {
        hideTrackerModal(TRACKER_EDITOR_ID);
    }

    // No tracker → create, on the template step; a tracker → edit, on the form.
    function openTrackerEditor(tracker) {
        const sheet = mountTrackerModal(TRACKER_EDITOR_ID, 'wg-sheet--full wg-today-tracker-editor', 'Tracker editor');
        const ed = { tracker: tracker || null, step: tracker ? 'form' : 'pick', from: null, draft: trackerDraft(tracker), errors: {} };
        renderTrackerEditor(sheet, ed);
        showTrackerModal(sheet, closeTrackerEditor);
        return sheet;
    }

    function renderTrackerEditor(sheet, ed) {
        const rerender = () => { renderTrackerEditor(sheet, ed); hydrateIcons(sheet); };
        sheet.replaceChildren();
        sheet.setAttribute('data-step', ed.step);
        sheet.appendChild(el('div', 'wg-sheet__grab'));
        const body = el('div', 'wg-sheet__body');

        if (ed.step === 'pick') {
            sheet.appendChild(trackerSheetHead('New tracker', 'Pick a starting point', closeTrackerEditor));
            const list = el('div', 'wg-list');
            for (const tpl of TRACKER_TEMPLATES) {
                const row = trackerLink('row', tpl.emoji, tpl.name, trackerKindRule(tpl), 'tracker-template', () => {
                    ed.step = 'form';
                    ed.from = tpl.name;
                    ed.draft = trackerDraft(tpl);
                    rerender();
                });
                row.setAttribute('data-template', tpl.name);
                list.appendChild(row);
            }
            const custom = el('div', 'wg-list');
            custom.appendChild(trackerLink('row', 'plus', 'Custom', 'Start blank', 'tracker-custom', () => {
                ed.step = 'form';
                ed.from = 'custom';
                ed.draft = trackerDraft(null);
                rerender();
            }));
            body.append(list, custom, el('p', 'wg-hint', 'A template only fills in the form. You can change everything before you save.'));
            sheet.appendChild(body);
            return;
        }

        const d = ed.draft;
        const editing = !!ed.tracker;
        const custom = ed.from === 'custom';
        let eyebrow = 'Edit tracker';
        if (!editing) eyebrow = custom ? 'New tracker · custom' : 'New tracker · from template';
        let title = 'New tracker';
        if (editing) title = ed.tracker.name;
        else if (!custom) title = ed.from;
        sheet.appendChild(trackerSheetHead(eyebrow, title, closeTrackerEditor, () => saveTrackerEditor(sheet, ed)));

        // Typing updates the plain-English summary and the affix units in
        // place (no re-render, so the field keeps focus).
        const live = [];
        const refresh = () => live.forEach((fn) => fn());

        const field = (key, label, ...controls) => {
            const f = el('div', ed.errors[key] ? 'wg-field wg-field--error' : 'wg-field');
            f.setAttribute('data-field', key);
            f.appendChild(el('span', 'wg-label', label));
            controls.forEach((c) => f.appendChild(c));
            if (ed.errors[key]) {
                const err = el('span', 'wg-error');
                err.append(ico('alert', true), doc().createTextNode(ed.errors[key]));
                f.appendChild(err);
            }
            return f;
        };
        const input = (key, value, opts, onInput) => {
            const o = opts || {};
            const i = el('input', o.numeric ? 'wg-input' : 'wg-input wg-input--text');
            i.type = 'text';
            if (o.numeric) i.setAttribute('inputmode', 'decimal');
            if (o.maxLength) i.maxLength = o.maxLength;
            if (o.placeholder) i.placeholder = o.placeholder;
            if (o.aria) i.setAttribute('aria-label', o.aria);
            i.value = value;
            i.setAttribute('data-input', key);
            i.addEventListener('input', () => { onInput(i.value); refresh(); });
            return i;
        };
        const affix = (inp, unitFn) => {
            const a = el('div', 'wg-affix wg-affix--unit');
            const u = el('span', 'wg-affix__unit', unitFn());
            live.push(() => { u.textContent = unitFn(); });
            a.append(inp, u);
            return a;
        };
        const seg = (key, options, small, disabled, read, write) => {
            const s = el('div', small ? 'wg-seg wg-seg--sm' : 'wg-seg');
            s.setAttribute('role', 'group');
            s.setAttribute('data-seg', key);
            for (const [value, label] of options) {
                const o = el('button', 'wg-seg__opt', label);
                o.type = 'button';
                o.setAttribute('aria-pressed', String(read() === value));
                o.setAttribute('data-value', value);
                if (disabled) o.disabled = true;
                else o.addEventListener('click', () => { write(value); rerender(); });
                s.appendChild(o);
            }
            return s;
        };

        body.appendChild(field('name', 'Name', input('name', d.name, { maxLength: 60, placeholder: 'e.g. Reading', aria: 'Name' }, (v) => { d.name = v; })));

        const picks = el('div', 'wg-picks');
        for (const name of TRACKER_ICONS) {
            const p = el('button', 'wg-pick');
            p.type = 'button';
            p.setAttribute('aria-pressed', String(!d.emojiMode && d.emoji === name));
            p.setAttribute('aria-label', name);
            p.setAttribute('data-icon-pick', name);
            p.appendChild(ico(name, true));
            p.addEventListener('click', () => { d.emoji = name; d.emojiMode = false; rerender(); });
            picks.appendChild(p);
        }
        const emojiPick = el('button', 'wg-pick', 'Emoji');
        emojiPick.type = 'button';
        emojiPick.setAttribute('aria-pressed', String(d.emojiMode));
        emojiPick.setAttribute('data-icon-pick', 'emoji');
        emojiPick.addEventListener('click', () => {
            if (!d.emojiMode) d.emoji = '';
            d.emojiMode = true;
            rerender();
        });
        picks.appendChild(emojiPick);
        const iconControls = [picks];
        if (d.emojiMode) {
            iconControls.push(input('emoji', d.emoji, { maxLength: 16, placeholder: 'e.g. 🍊', aria: 'Emoji' }, (v) => { d.emoji = v; }));
        }
        iconControls.push(el('span', 'wg-hint', 'Or choose any emoji. It shows on the tile only.'));
        body.appendChild(field('emoji', 'Icon', ...iconControls));

        body.appendChild(field('kind', 'Kind', seg('kind', [['count', 'Count'], ['check', 'Check']], false, editing,
            () => d.kind, (v) => { d.kind = v; })));

        const count = d.kind === 'count';
        if (count) {
            const row = el('div', 'wg-fieldrow');
            row.append(
                field('unit', 'Unit · optional', input('unit', d.unit, { placeholder: 'e.g. page', aria: 'Unit' }, (v) => { d.unit = v; })),
                field('step', 'Each tap adds', affix(input('step', d.step, { numeric: true, aria: 'Each tap adds' }, (v) => { d.step = v; }),
                    () => unitText(d.unit.trim(), trackerNum(d.step)))),
            );
            body.appendChild(row);
        }

        body.appendChild(field('op', 'Target', seg('op', [['atLeast', 'Goal · at least'], ['atMost', 'Limit · at most']], false, false,
            () => d.target.op, (v) => { d.target.op = v; })));
        const targetRow = el('div', 'wg-fieldrow');
        const limit = d.target.op === 'atMost';
        targetRow.append(
            field('value', limit ? 'No more than' : 'At least', affix(
                input('value', d.target.value, { numeric: true, aria: limit ? 'No more than' : 'At least' }, (v) => { d.target.value = v; }),
                () => {
                    const n = trackerNum(d.target.value);
                    if (!count) return n === 1 ? 'time' : 'times';
                    return unitText(d.unit.trim(), n);
                })),
            field('period', 'Per', seg('period', [['day', 'Day'], ['week', 'Week'], ['month', 'Month']], true, false,
                () => d.target.period, (v) => { d.target.period = v; })),
        );
        body.appendChild(targetRow);
        const hint = el('p', 'wg-hint', trackerFormHint(d));
        hint.setAttribute('data-role', 'tracker-rule');
        live.push(() => { hint.textContent = trackerFormHint(d); });
        body.appendChild(hint);

        if (limit) {
            const quiet = el('div', 'wg-setting wg-setting--boxed wg-setting--quiet');
            const qb = el('span', 'wg-setting__body');
            qb.append(el('span', 'wg-setting__title', 'No reminder for limits'),
                el('span', 'wg-setting__desc', 'Reminders only nudge goals you haven’t reached yet.'));
            quiet.append(trackerLead('bell'), qb);
            body.appendChild(quiet);
        } else {
            const rem = el('div', 'wg-setting wg-setting--boxed');
            rem.setAttribute('data-field', 'reminder');
            const rb = el('span', 'wg-setting__body');
            rb.append(el('span', 'wg-setting__title', 'Reminder'),
                el('span', 'wg-setting__desc', 'Only if the goal isn’t met by then'));
            rem.appendChild(rb);
            if (d.reminderOn) {
                const time = el('input', 'wg-input wg-trkedit__time');
                time.type = 'time';
                time.value = d.reminderTime;
                time.setAttribute('aria-label', 'Reminder time');
                time.setAttribute('data-input', 'reminderTime');
                time.addEventListener('input', () => { d.reminderTime = time.value; });
                rem.appendChild(time);
            }
            const toggle = el('button', 'wg-toggle');
            toggle.type = 'button';
            toggle.setAttribute('role', 'switch');
            toggle.setAttribute('aria-checked', String(d.reminderOn));
            toggle.setAttribute('aria-label', 'Reminder');
            toggle.setAttribute('data-action', 'tracker-reminder');
            toggle.addEventListener('click', () => { d.reminderOn = !d.reminderOn; rerender(); });
            rem.appendChild(toggle);
            body.appendChild(rem);
            if (ed.errors.reminder) {
                const err = el('span', 'wg-error');
                err.append(ico('alert', true), doc().createTextNode(ed.errors.reminder));
                body.appendChild(err);
            }
        }

        if (editing) {
            const box = el('div', 'wg-vstack');
            const archive = btn('Archive tracker', { icon: 'archive', action: 'tracker-archive', onClick: () => archiveTracker(ed.tracker, closeTrackerEditor) });
            archive.classList.add('wg-btn--danger-ghost', 'wg-btn--block');
            const since = trackerSince(ed.tracker);
            box.append(archive, el('p', 'wg-hint', `${since ? `Tracking since ${since}. ` : ''}Archiving removes it from Today and keeps its history.`));
            body.appendChild(box);
        }
        sheet.appendChild(body);
    }

    function trackerSince(t) {
        const d = new Date(t && t.createdAt);
        if (isNaN(d.getTime())) return '';
        return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
    }

    // Errors show inline after Save and focus moves to the first one (TR2-D).
    function saveTrackerEditor(sheet, ed) {
        ed.errors = validateTrackerDraft(ed.draft);
        if (Object.keys(ed.errors).length) {
            renderTrackerEditor(sheet, ed);
            hydrateIcons(sheet);
            const first = sheet.querySelector('.wg-field--error input, [data-field="reminder"] input');
            if (first && typeof first.focus === 'function') first.focus();
            return null;
        }
        closeTrackerEditor();
        const body = trackerBody(ed.draft);
        return ed.tracker ? updateTracker(ed.tracker, body) : createTracker({ ...body, kind: ed.draft.kind });
    }

    function sortTrackers(list) {
        return list.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    }

    // The server's list row for one tracker (progress, todayLogs and the
    // day/timeZone a cached list needs to notice midnight), or null.
    async function serverTrackerRow(api, id) {
        try {
            const list = await api('/api/trackers', 'GET');
            return Array.isArray(list) ? (list.find((x) => x && x.id === id) || null) : null;
        } catch (_) { return null; }
    }

    // The new tile shows at once under a provisional id (taps wait for the
    // commit); the server's row replaces it.
    async function createTracker(body) {
        const api = trackersApi();
        if (!api) return null;
        const provisionalId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const row = {
            ...body, id: provisionalId, archived: false, createdAt: new Date().toISOString(),
            progress: { total: 0, target: body.target.value, met: body.target.op === 'atMost' }, todayLogs: [],
        };
        return trackerWrite(
            (prev) => [...(Array.isArray(prev) ? prev : []), row],
            (cur) => cur.filter((t) => t.id !== provisionalId),
            () => api('/api/trackers', 'POST', body),
            async (saved) => {
                const fresh = saved.id ? await serverTrackerRow(api, saved.id) : null;
                return (cur) => cur.map((t) => (t.id === provisionalId ? (fresh || { ...t, ...saved }) : t));
            });
    }

    // A changed period changes what the total sums, so the commit takes the
    // server's row for this tracker (others keep any concurrent writes).
    async function updateTracker(t, body) {
        const api = trackersApi();
        if (!api) return null;
        const apply = (fields) => (x) => {
            const p = x.progress || { total: 0 };
            const value = fields.target.value;
            const met = fields.target.op === 'atMost' ? p.total <= value : p.total >= value;
            return { ...x, ...fields, progress: { ...p, target: value, met } };
        };
        const old = { name: t.name, emoji: t.emoji, unit: t.unit, step: t.step, target: t.target, reminder: t.reminder };
        return trackerWrite(patchTracker(t.id, apply(body)), patchTracker(t.id, apply(old)),
            () => api(`/api/trackers/${encodeURIComponent(t.id)}`, 'PUT', body),
            async () => {
                const fresh = await serverTrackerRow(api, t.id);
                // A tap made while saving is still provisional: keep it on top.
                const merge = (x) => (x.todayLogs || []).filter(isProvisional).reduce((acc, l) => addLog(l)(acc), fresh);
                return fresh ? (cur) => cur.map((x) => (x.id === t.id ? merge(x) : x)) : null;
            });
    }

    async function archiveTracker(t, after) {
        const ask = typeof window !== 'undefined' ? window.safeConfirm : null;
        if (typeof ask !== 'function') return null;
        const ok = await ask('It leaves Today and stops counting. Its history stays in your vault and in the doctor brief.', null, {
            title: `Archive ${t.name}?`, confirmLabel: 'Archive', icon: 'archive', destructive: true,
        });
        if (!ok) return null;
        if (typeof after === 'function') after();
        const api = trackersApi();
        if (!api) return null;
        return trackerWrite(
            (prev) => (Array.isArray(prev) ? prev.filter((x) => x.id !== t.id) : prev),
            (cur) => (cur.some((x) => x.id === t.id) ? cur : sortTrackers([...cur, t])),
            () => api(`/api/trackers/${encodeURIComponent(t.id)}`, 'DELETE'));
    }

    // Manage: every active tracker (tap = edit) plus New tracker.
    function openTrackerManage(trackers) {
        const sheet = mountTrackerModal(TRACKER_MANAGE_ID, '', 'Manage trackers');
        const close = () => hideTrackerModal(TRACKER_MANAGE_ID);
        sheet.replaceChildren();
        sheet.appendChild(el('div', 'wg-sheet__grab'));
        sheet.appendChild(trackerSheetHead('Trackers', 'Manage', close));
        const body = el('div', 'wg-sheet__body');
        const list = el('div', 'wg-list');
        // A tracker still saving has no record to edit yet.
        for (const t of trackers.filter((x) => !isProvisional(x))) {
            const row = trackerLink('row', t.emoji, t.name, trackerKindRule(t), 'tracker-manage-edit', () => { close(); openTrackerEditor(t); });
            row.setAttribute('data-manage-id', t.id);
            list.appendChild(row);
        }
        const add = el('div', 'wg-list');
        add.appendChild(trackerLink('row', 'plus', 'New tracker', 'From a template or blank', 'tracker-manage-new', () => { close(); openTrackerEditor(); }));
        body.append(list, add, el('p', 'wg-hint', 'Archiving a tracker takes it off Today and keeps its history.'));
        sheet.appendChild(body);
        showTrackerModal(sheet, close);
        return sheet;
    }

    // Weekly tile (TR1): Mon..Sun strip instead of the meter.
    function trackerWeek(t) {
        const week = el('span', 'wg-trk__week');
        week.setAttribute('aria-hidden', 'true');
        t.progress.days.forEach((d) => {
            const seg = el('i');
            if (d.total > 0) seg.classList.add('is-hit');
            if (d.day === t.day) seg.classList.add('is-today');
            else if (t.day && d.day > t.day) seg.classList.add('is-future');
            week.appendChild(seg);
        });
        return week;
    }

    function trackerMeter(t) {
        const p = t.progress || {};
        const limit = t.target.op === 'atMost';
        const meter = el('span', limit ? 'wg-meter wg-trk__limit' : 'wg-meter');
        const fill = el('span', limit ? 'wg-meter__fill' : 'wg-meter__fill wg-meter__fill--sage');
        fill.style.setProperty('--p', p.target > 0 ? pct(p.total / p.target) : (p.total > 0 ? '100%' : '0%'));
        meter.appendChild(fill);
        return meter;
    }

    function trackerStatusText(t) {
        const p = t.progress || {};
        const left = fmtNum(Math.max(0, p.target - p.total));
        const state = trackerState(t);
        if (state === 'met') return 'Goal met';
        if (state === 'todo') return `${left} to go`;
        if (state === 'under') return `${left} left`;
        if (state === 'at') return 'At limit';
        return `${fmtNum(p.total - p.target)} over`;
    }

    function shortDate(day) {
        return `${day.slice(8, 10)}.${day.slice(5, 7)}`;
    }

    function mondayOf(day) {
        const ms = Date.parse(`${day}T00:00:00Z`);
        const dow = (new Date(ms).getUTCDay() + 6) % 7;
        return new Date(ms - dow * DAY_IN_MS).toISOString().slice(0, 10);
    }

    // history() rows (oldest first) → bar buckets: days, or ISO weeks for a
    // weekly tracker (the last 5). ponytail: a monthly tracker shows its days
    // unjudged (no goal line) — month bars when someone keeps one.
    function trackerBuckets(t, rows) {
        if (t.target.period !== 'week') return rows.map((r) => ({ label: shortDate(r.date), total: Number(r.total) || 0 }));
        const weeks = [];
        for (const r of rows) {
            const key = mondayOf(r.date);
            const last = weeks[weeks.length - 1];
            if (last && last.key === key) last.total += Number(r.total) || 0;
            else weeks.push({ key, label: shortDate(key), total: Number(r.total) || 0 });
        }
        return weeks.slice(-5);
    }

    function renderTrackerBars(t, rows) {
        const card = el('div', 'wg-card');
        card.setAttribute('data-section', 'tracker-history');
        const weekly = t.target.period === 'week';
        const judged = t.target.period !== 'month';
        const buckets = trackerBuckets(t, rows);
        const head = el('div', 'wg-card__head');
        head.appendChild(el('span', 'wg-card__title', weekly ? 'Last 5 weeks' : 'Last 30 days'));
        if (rows.length) head.appendChild(el('span', 'wg-meta', `${shortDate(rows[0].date)} – ${shortDate(rows[rows.length - 1].date)}`));
        card.appendChild(head);
        if (!buckets.length) {
            card.appendChild(el('p', 'wg-hint', 'No history yet.'));
            return card;
        }
        const target = Number(t.target.value) || 0;
        const limit = t.target.op === 'atMost';
        const scale = Math.max(target * 1.5, 1, ...buckets.map((b) => b.total));
        const met = (b) => (limit ? b.total <= target : b.total >= target);
        const bars = el('div', 'wg-trkhist');
        bars.style.setProperty('--n', String(buckets.length));
        buckets.forEach((b, i) => {
            const current = i === buckets.length - 1;
            let cls = 'wg-trkhist__bar';
            if (judged && limit && !met(b)) cls += ' wg-trkhist__bar--over';
            else if (judged && !limit && met(b)) cls += ' wg-trkhist__bar--met';
            else if (current) cls += ' wg-trkhist__bar--today';
            const bar = el('span', cls);
            bar.style.setProperty('--p', pct(b.total / scale));
            bar.setAttribute('title', `${b.label}: ${fmtNum(b.total)}`);
            bars.appendChild(bar);
        });
        if (judged) {
            const goal = el('span', 'wg-trkhist__goal');
            goal.style.setProperty('--p', pct(target / scale));
            goal.appendChild(el('span', null, fmtNum(target)));
            bars.appendChild(goal);
        }
        card.appendChild(bars);
        const axis = el('div', 'wg-trkhist__axis');
        axis.append(el('span', null, buckets[0].label));
        if (buckets.length > 2) axis.append(el('span', null, buckets[Math.floor(buckets.length / 2)].label));
        axis.append(el('span', null, weekly ? 'This week' : 'Today'));
        card.appendChild(axis);
        const legend = el('div', 'wg-trkhist__legend');
        const key = (cls, text) => {
            const s = el('span');
            s.append(el('i', cls), doc().createTextNode(text));
            return s;
        };
        if (judged && limit) legend.append(key(null, 'Within limit'), key('is-over', 'Over limit'));
        else if (judged) legend.append(key('is-met', 'Met'), key(null, 'Under goal'));
        legend.append(key('is-today', weekly ? 'This week, in progress' : 'Today, in progress'));
        card.appendChild(legend);
        return card;
    }

    // "Met 22 of the last 29 days" — finished buckets only (not today / this week).
    function trackerMetText(t, rows) {
        if (t.target.period === 'month') return '';
        const done = trackerBuckets(t, rows).slice(0, -1);
        if (!done.length) return '';
        const target = Number(t.target.value) || 0;
        const n = done.filter((b) => (t.target.op === 'atMost' ? b.total <= target : b.total >= target)).length;
        const unit = t.target.period === 'week' ? 'weeks' : 'days';
        return ` ${t.target.op === 'atMost' ? 'Within the limit' : 'Met'} ${n} of the last ${done.length} ${unit}.`;
    }

    function strengthWord(v) {
        if (v < 0.25) return 'Starting';
        if (v < 0.5) return 'Building';
        if (v < 0.8) return 'Steady';
        return 'Strong';
    }

    function renderTrackerStrength(strength, metText) {
        const card = el('div', 'wg-card wg-vstack');
        card.setAttribute('data-section', 'tracker-strength');
        card.appendChild(el('span', 'wg-eyebrow', 'Habit strength'));
        const line = el('span', 'wg-hstack');
        const v = Math.max(0, Math.min(1, Number(strength.value) || 0));
        line.append(el('span', 'wg-stat__value wg-stat__value--md', `${Math.round(v * 100)}%`), chip(strengthWord(v)));
        card.appendChild(line);
        card.appendChild(el('p', 'wg-hint',
            `Grows on days you meet the goal and fades slowly on days you don't, so one missed day barely moves it.${metText}`));
        return card;
    }

    // TR3: a pushed page. The current period renders at once; the bars and
    // the strength (habit strength from GET /api/gamification/summary,
    // med-1vy5.4) fill in once read.
    function openTrackerHistory(t) {
        const W = typeof window !== 'undefined' ? window.WGPage : null;
        const api = trackersApi();
        if (!W || typeof W.push !== 'function' || !api) return null;
        const body = el('div', 'wg-vstack');
        body.setAttribute('data-tracker-history', t.id);

        const nowCard = el('div', 'wg-card wg-vstack');
        nowCard.appendChild(el('span', 'wg-eyebrow wg-eyebrow--dot', { day: 'Today', week: 'This week', month: 'This month' }[t.target.period]));
        const line = el('span', 'wg-hstack');
        if (t.kind === 'check' && t.target.period === 'day') {
            line.appendChild(el('span', 'wg-stat__value', trackerDoneToday(t) ? 'Done' : 'Not yet'));
        } else {
            const r = trackerRatio(t);
            const stat = el('span', 'wg-stat__value', r.value);
            stat.appendChild(el('small', null, r.rest));
            line.appendChild(stat);
        }
        line.append(el('span', 'wg-spacer'), el('span', 'wg-meta', trackerStatusText(t)));
        nowCard.appendChild(line);
        nowCard.appendChild(trackerMeter(t));
        nowCard.appendChild(el('span', 'wg-meta',
            `${t.target.op === 'atMost' ? 'Limit' : 'Goal'} · ${trackerRuleText(t)}${t.reminder ? ` · reminder ${t.reminder.time}` : ''}`));
        body.appendChild(nowCard);

        const slot = el('div', 'wg-vstack');
        body.appendChild(slot);

        const page = W.push({
            title: t.name, crumb: 'Tracker', back: 'Today', body,
            primary: { label: 'Edit', onClick: () => { page.close(); openTrackerEditor(t); } },
        });
        const archive = btn('Archive tracker', { icon: 'archive', action: 'tracker-archive', onClick: () => archiveTracker(t, () => page.close()) });
        archive.classList.add('wg-btn--danger-ghost', 'wg-btn--block');
        body.appendChild(archive);
        hydrateIcons(body);

        const days = t.target.period === 'week' ? 42 : 30;
        Promise.all([
            Promise.resolve(api(`/api/trackers/${encodeURIComponent(t.id)}/history?days=${days}`, 'GET')).catch(() => null),
            Promise.resolve(api('/api/gamification/summary', 'GET')).catch(() => null),
        ]).then(([rows, summary]) => {
            const list = Array.isArray(rows) ? rows : [];
            slot.appendChild(renderTrackerBars(t, list));
            const strengths = summary && Array.isArray(summary.strengths) ? summary.strengths : [];
            const strength = strengths.find((s) => s && s.key === `tracker:${t.id}`);
            if (strength) slot.appendChild(renderTrackerStrength(strength, trackerMetText(t, list)));
        });
        return page;
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
            // The food Add sheet's Describe view (features/food/add-sheet.js).
            onDescribeFood: opts.onDescribeFood || (() => {
                const addSheet = win.FoodLog && win.FoodLog.addSheet;
                if (addSheet && typeof addSheet.openDescribe === 'function') addSheet.openDescribe();
                else onLogFood();
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

        // Call bar (kit .wg-callbar): Call agent · Log · Doctor brief.
        // mountCard() fills the row with the call trigger and its live
        // controls and repaints live call state onto the fresh row, so a
        // re-render mid-call keeps End call; mid-call it docks the row above
        // the tab bar (Log and Doctor brief hide while live).
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

        const trackersCard = renderTrackersCard(state && state.trackers, nowMs);
        if (trackersCard) { root.appendChild(trackersCard); }
        syncTrackerSheet(state && state.trackers, nowMs);

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

        // TZ-transition plan card (kit T2 tz card). Mounts nothing
        // when no plan is in flight.
        if (typeof window !== 'undefined' && window.TZPlanBanner
            && typeof window.TZPlanBanner.mountCard === 'function') {
            window.TZPlanBanner.mountCard(root);
        }

        // Nothing tracked (only the call bar, if any) → every feature is off.
        if (!anyFeature && !goal.node && !(trackersCard && trackersCard.querySelector('.wg-trk'))) {
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
    const RELEVANT_TAGS = ['bp', 'weight', 'medications', 'history', 'food', 'workout', 'health', 'settings', 'gamification', 'trackers'];

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
