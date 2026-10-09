// Gamification "Journey" feature module (Plan 3 of 3 — frontend, Task 2).
//
// Closure-scoped module exposing window.Gamification — a loader (load) that
// reads GET /api/gamification/journey through cachedFetch (local-first +
// freshness chip) and a pure-ish render(journey) that paints #journey-content
// from the Journey read model — only its `enabled` gate is read; the
// substrate fields it still serves for the registry shape (rings, strengths,
// hp_history, level/HP, unlocked_tiers, health_score) are not rendered
// (HP/levels/Health Score hidden outright, owner decision; their last
// consumers — the tier-gated insight cards — went in med-8tur.12) — plus the
// separately-fetched atlas / weekly_review / gauges / traits / experiments /
// chapter / keystones / narration / goal_line layers.
//
// Visuals come only from CSS classes + --wg-* tokens; the only inline styles
// are custom properties via style.setProperty: the kit's --p / --n on
// .wg-track / .wg-meter, and --fill-pct on the trial / chapter bars.
//
// Loads as a classic <script> (no ES modules); state lives inside the IIFE.
(function () {
    'use strict';

    const CACHE_KEY = 'gamification';
    const JOURNEY_URL = '/api/gamification/journey';
    const STALE_AFTER_MS = 6 * 60 * 60 * 1000; // 6h — matches the cache-keys registry
    const GAUGES_CACHE_KEY = 'gamification_gauges';
    const GAUGES_URL = '/api/gamification/gauges';

    function icon(name, size) {
        if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
            try { return window.WGIcons.iconSvg(name, { size: size || 18 }); }
            catch (_) { return null; }
        }
        return null;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    // A gloss-inset progress track with a --fill-pct fill. ratio is clamped to
    // [0,1]; variant lets callers tint the fill via a modifier class.
    function progressBar(ratio, variant) {
        const track = el('div', 'wg-gloss--inset wg-journey-bar__track');
        const fill = el('div', 'wg-journey-bar__fill' + (variant ? ' ' + variant : ''));
        let pct = Number(ratio);
        if (!Number.isFinite(pct)) pct = 0;
        pct = Math.max(0, Math.min(1, pct));
        fill.style.setProperty('--fill-pct', `${(pct * 100).toFixed(1)}%`);
        track.appendChild(fill);
        return track;
    }

    function renderEmpty(content, message) {
        content.replaceChildren(el('p', 'wg-journey-empty wg-muted', message));
    }

    // Goal Line detail (med-8tur.2 card, expanded by med-8tur.9): the same
    // Goal Line read-model the Today hero shows, so a tap through from Today
    // lands on the goal — progress, coverage, the marker count and the
    // reached-milestone timeline. HP / levels / the Health Score are hidden
    // outright (owner decision 2026-10-02; UI-only — the read-models keep
    // computing them).
    const GOAL_LINE_CACHE_KEY = 'gamification_goal_line';
    const GOAL_LINE_URL = '/api/gamification/goal-line';
    const GOAL_LINE_TAGS = ['gamification', 'weight', 'workout', 'bp', 'settings', 'medications', 'history'];

    function weightParts(kg) {
        const unit = window.weightUnitPreference === 'lb' ? 'lb' : 'kg';
        const d = typeof formatWeight === 'function' ? formatWeight(kg, unit) : { value: Number(kg), label: unit };
        return { value: Number(d.value).toFixed(1), unit: d.label };
    }

    function goalWeight(kg) {
        const d = weightParts(kg);
        return `${d.value} ${d.unit}`;
    }

    // Reached goal milestones ride the keystones payload (kind 'goal_milestone',
    // getKeystones) — rendered here as the goal's timeline instead of in the
    // Keystones card, so nothing is fetched or shown twice.
    function isGoalMilestone(k) { return !!k && k.kind === 'goal_milestone'; }

    function goalMilestones(j) {
        const ks = j && j.keystones;
        if (!ks || ks.enabled === false || !Array.isArray(ks.keystones)) return [];
        return ks.keystones.filter(isGoalMilestone);
    }

    function pct(ratio) {
        const n = Number(ratio);
        return `${(Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0)) * 100).toFixed(1)}%`;
    }

    function iconEl(name, className) {
        const i = el('i', 'wg-ico' + (className ? ' ' + className : ''));
        i.dataset.icon = name;
        return i;
    }

    function stat(value, unit, label) {
        const cell = el('div', 'wg-stat');
        const v = el('span', 'wg-stat__value wg-stat__value--md', value);
        if (unit) v.appendChild(el('small', null, unit));
        cell.append(v, el('span', 'wg-meta', label));
        return cell;
    }

    // Kit J1: the goal as current → target, a marker track (--p progress, --n
    // markers, a pin on the next marker) and three numbers. The safety line
    // keeps its wording and never praises pace (docs/gamification.md §0).
    function goalTrack(g) {
        const nm = g.next_milestone;
        const track = el('span', 'wg-track wg-journey-goal__track');
        track.style.setProperty('--p', pct(g.progress.fraction));
        if (nm && Number(nm.count) > 0) track.style.setProperty('--n', String(Number(nm.count)));
        track.appendChild(el('span', 'wg-track__fill'));
        const span = Math.abs(Number(g.start_ref) - Number(g.target));
        const showPin = nm && !nm.is_goal && Number.isFinite(Number(nm.weight)) && span > 0;
        if (showPin) {
            const pin = el('span', 'wg-track__pin');
            pin.style.setProperty('--p', pct(Math.abs(Number(g.start_ref) - Number(nm.weight)) / span));
            track.appendChild(pin);
        }
        const ends = el('span', 'wg-track__ends');
        ends.appendChild(el('span', null, Number.isFinite(Number(g.start_ref)) ? `start ${weightParts(g.start_ref).value}` : 'start'));
        if (showPin) ends.appendChild(el('span', null, `next marker ${weightParts(nm.weight).value}`));
        ends.appendChild(el('span', null, 'goal'));
        return [track, ends];
    }

    function renderGoalContext(j) {
        const gl = j && j.goal_line;
        if (!gl || gl.enabled === false || !gl.goal) return null;
        const g = gl.goal;
        const card = el('section', 'wg-card wg-vstack wg-journey-goal');
        card.id = 'journey-goal-card';
        card.appendChild(el('span', 'wg-eyebrow wg-eyebrow--dot', 'Your goal'));
        if (g.status === 'no_goal') {
            // Weight tab off → switchTab('weight') bounces to Today; no dead link.
            if (window.featureSettings && window.featureSettings.weight === false) return null;
            const set = el('button', 'wg-btn', 'Set a weight goal');
            set.type = 'button';
            set.addEventListener('click', () => { if (typeof window.switchTab === 'function') window.switchTab('weight'); });
            card.appendChild(set);
            return card;
        }
        const current = Number.isFinite(g.trend_weight) ? g.trend_weight
            : (g.latest_reading ? g.latest_reading.weight : null);
        if (Number.isFinite(current) && Number.isFinite(Number(g.target))) {
            const value = el('span', 'wg-hstack wg-journey-goal__value');
            const to = el('span', 'wg-stat__value wg-stat__value--hero wg-sun', weightParts(g.target).value);
            to.appendChild(el('small', null, weightParts(g.target).unit));
            value.append(el('span', 'wg-stat__value wg-stat__value--hero', weightParts(current).value),
                iconEl('chev-r', 'wg-muted'), to);
            card.appendChild(value);
        }
        if (g.status === 'preliminary') card.appendChild(el('p', 'wg-journey-goal__line wg-hint', 'Latest reading — your trend forms after a few more weigh-ins.'));
        else if (g.status === 'maintaining') card.appendChild(el('p', 'wg-journey-goal__line wg-hint', 'Maintaining your goal.'));
        else if (g.status === 'at_goal') card.appendChild(el('p', 'wg-journey-goal__line wg-hint', 'At your goal.'));
        else if (g.progress) {
            // goal.progress: the same episode progress Today + the Weight tab render.
            card.append(...goalTrack(g));
            const since = g.start_ref_source === 'trend_at_set' ? 'since you set the goal' : 'since your first reading';
            card.appendChild(el('p', 'wg-journey-goal__line wg-hint',
                `${goalWeight(g.progress.done_kg)} of ${goalWeight(g.progress.total_kg)} ${since}`));
        }
        const stats = el('div', 'wg-grid3 wg-journey-goal__stats');
        if ((g.status === 'ok' || g.status === 'preliminary') && Number.isFinite(Number(g.distance_to_goal))) {
            const d = weightParts(Math.abs(Number(g.distance_to_goal)));
            stats.appendChild(stat(d.value, null, `${d.unit} to go`));
        }
        const nm = g.next_milestone;
        if (g.status === 'ok' && nm && Number(nm.count) > 0) {
            const passed = Math.max(0, (Number(nm.ordinal) || 1) - 1);
            stats.appendChild(stat(String(passed), `/${Number(nm.count)}`, 'markers'));
        }
        if (g.coverage) {
            stats.appendChild(stat(String(Number(g.coverage.weigh_in_days_28d) || 0), null, 'weigh-ins / 28d'));
        }
        if (stats.childNodes.length) card.appendChild(stats);
        if (g.too_fast) {
            card.appendChild(el('p', 'wg-journey-goal__line', 'Faster than 1% a week — worth checking with your doctor.'));
        }
        // Together (med-8tur.10, §0.3.6): the joint weight/BP observation — the
        // first vs last full weeks of this goal, shown whichever way it points.
        const jt = gl.joint;
        if (jt && Array.isArray(jt.periods) && jt.periods.length === 2 && jt.bp_target) {
            const [a, b] = jt.periods;
            const t = jt.bp_target;
            card.appendChild(el('span', 'wg-eyebrow wg-journey-goal__timeline-label', 'Together'));
            card.appendChild(el('p', 'wg-journey-goal__line',
                `First vs last ${jt.weeks_per_period} full weeks of this goal: weight trend changed ${signedGoalWeight(jt.weight_change_kg)}; `
                + `daily-weighted BP averaged ${a.bp.systolic}/${a.bp.diastolic} → ${b.bp.systolic}/${b.bp.diastolic} `
                + `over ${a.bp.days}/${b.bp.days} measurement days (target ${t.systolic}/${t.diastolic}).`));
            card.appendChild(el('p', 'wg-journey-goal__line wg-hint',
                `${a.weigh_in_days}/${b.weigh_in_days} weigh-in days · concurrent changes don’t identify a cause.`));
        }
        const reached = goalMilestones(j);
        if (reached.length > 0) {
            card.appendChild(el('span', 'wg-eyebrow wg-journey-goal__timeline-label', 'Milestones'));
            const list = el('div', 'wg-journey-keystones__list');
            reached.forEach((k) => list.appendChild(keystoneRow(k)));
            card.appendChild(list);
        }
        if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(card);
        return card;
    }

    // "This week" scorecard (kit J1, med-xso6.15): the live week Mon–Sun as day
    // dots per lever, from goal_line.week_days (getGoalLine). hit · miss · rest ·
    // future come from the domain — a miss only exists against an explicit
    // contract (a scheduled workout, a daily weigh-in); today wears a ring.
    const SCORE_ROWS = [['weigh_in', 'Weigh-in'], ['workout', 'Workout'], ['bp', 'BP']];
    const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    function dayLabel(dayStr, i) {
        const dd = /^\d{4}-\d{2}-(\d{2})$/.exec(String(dayStr || ''));
        return dd ? `${WEEKDAYS[i]} ${dd[1]}` : WEEKDAYS[i];
    }

    function renderWeekScorecard(j) {
        const gl = j && j.goal_line;
        const days = gl && gl.enabled !== false && Array.isArray(gl.week_days) && gl.week_days.length === 7 ? gl.week_days : null;
        if (!days) return null;
        const rows = SCORE_ROWS.filter(([k]) => days.some((d) => d[k] != null));
        if (rows.length === 0) return null;

        const card = el('section', 'wg-card wg-vstack wg-journey-week');
        card.id = 'journey-week-card';
        const head = el('div', 'wg-card__head');
        head.append(el('span', 'wg-card__title', 'This week'), el('span', 'wg-meta', `${dayLabel(days[0].day, 0)} – ${dayLabel(days[6].day, 6)}`));
        card.appendChild(head);
        const labels = el('div', 'wg-score');
        const letters = el('span', 'wg-dots');
        letters.setAttribute('aria-hidden', 'true');
        WEEKDAYS.forEach((d) => letters.appendChild(el('span', 'wg-dots__lbl', d[0])));
        labels.append(el('span'), letters, el('span'));
        card.appendChild(labels);
        rows.forEach(([key, name]) => {
            const row = el('div', 'wg-score');
            row.setAttribute('data-lever', key);
            const dots = el('span', 'wg-dots');
            dots.setAttribute('role', 'img');
            const said = [];
            let hits = 0;
            days.forEach((d, i) => {
                const st = d[key] || 'future';
                const today = d.day === gl.day;
                if (st === 'hit') hits += 1;
                // An open today is just the ring (kit J1), not a dimmed future dot.
                const cls = today && st === 'future' ? '' : ` wg-dot--${st}`;
                dots.appendChild(el('span', `wg-dot${cls}${today ? ' wg-dot--today' : ''}`));
                said.push(`${WEEKDAYS[i]} ${today && st === 'future' ? 'today' : st}`);
            });
            dots.setAttribute('aria-label', `${name}: ${said.join(', ')}`);
            row.append(el('span', 'wg-score__name', name), dots, el('span', 'wg-score__val', String(hits)));
            card.appendChild(row);
        });
        return card;
    }

    // "Last week" card (med-8tur.4, docs/gamification.md §0.3.4): the most
    // recently COMPLETED week as three fact rows — weight, workouts, BP — plus
    // the best day, then the plan pick for the week ahead (a curated
    // implementation intention, committed once, or Pause) and a compact
    // cadence control. Fetched through its own cachedFetch entry
    // (loadWeeklyReview). Tone rules: facts only, missing reads as unknown.
    const WEEKLY_CACHE_KEY = 'gamification_weekly';
    const WEEKLY_URL = '/api/gamification/weekly-review';
    const WEEK_PLAN_URL = '/api/gamification/week-plan';

    function weekdayLabel(dayUnix) {
        const t = Number(dayUnix) * 1000;
        if (!Number.isFinite(t)) return null;
        try {
            return new Date(t).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });
        } catch (_) {
            return null;
        }
    }

    function signedGoalWeight(kg) {
        const v = Number(kg);
        if (v === 0) return `±${goalWeight(0)}`;
        return `${v > 0 ? '+' : '−'}${goalWeight(Math.abs(v))}`;
    }

    function weeklyWeightRow(w) {
        if (!w || w.feature_on === false) return null;
        const n = Number(w.weigh_in_days) || 0;
        const days = `${n} weigh-in${n === 1 ? '' : 's'}`;
        if (w.status !== 'ok') return `Weight: ${days} · not enough for a trend yet`;
        const parts = [];
        if (Number.isFinite(w.trend_change_kg)) parts.push(`trend ${signedGoalWeight(w.trend_change_kg)}`);
        else if (Number.isFinite(w.trend_weight)) parts.push(`trend ${goalWeight(w.trend_weight)}`);
        if (w.goal_status === 'at_goal' || w.goal_status === 'maintaining') parts.push('at your goal');
        else if (Number.isFinite(w.distance_to_goal)) parts.push(`${goalWeight(w.distance_to_goal)} to go`);
        parts.push(days);
        return `Weight: ${parts.join(' · ')}`;
    }

    function weeklyWorkoutRow(wo) {
        if (!wo || wo.feature_on === false) return null;
        const done = Number(wo.completed) || 0;
        return Number.isFinite(wo.scheduled)
            ? `Workouts: ${done} of ${wo.scheduled} scheduled`
            : `Workouts: ${done} session${done === 1 ? '' : 's'}`;
    }

    function weeklyBPRow(bp) {
        if (!bp || bp.feature_on === false) return null;
        if (!bp.mean) return 'BP: no readings this week';
        let text = `BP: avg ${Math.round(bp.mean.systolic)}/${Math.round(bp.mean.diastolic)}`;
        if (bp.target && (Number.isFinite(bp.target.systolic) || Number.isFinite(bp.target.diastolic))) {
            const t = (x) => (Number.isFinite(x) ? String(x) : '—');
            text += ` vs ${t(bp.target.systolic)}/${t(bp.target.diastolic)}`;
        }
        const n = Number(bp.days_measured) || 0;
        return `${text} · ${n} day${n === 1 ? '' : 's'} measured`;
    }

    // Optimistic projection of a pick onto the cached review — the server
    // (gamification.js putWeekPlan) stays the authority; commit swaps its plan in.
    function projectWeekPlan(prev, body) {
        if (!prev || typeof prev !== 'object') return prev;
        const cur = prev.plan || {
            week: prev.plan_week, intention: null, cadence: { weigh_in: 'weekly', bp_days: null }, paused: false,
        };
        const next = { ...cur, cadence: { ...(cur.cadence || {}), ...(body.cadence || {}) } };
        if (body.choice === 'pause') next.paused = true;
        else if (body.choice === 'keep') next.paused = false;
        else if (body.choice) {
            const opts = (prev.options && prev.options.intentions) || [];
            next.intention = opts.find((o) => o.id === body.choice) || null;
            next.paused = false;
        }
        // A weigh-in pick IS the reminder's cadence: weigh_in_current follows
        // it, so the select repaints to it and later edits never revert it.
        const weighIn = body.cadence && body.cadence.weigh_in;
        const options = weighIn ? { ...(prev.options || {}), weigh_in_current: weighIn } : prev.options;
        return { ...prev, plan: next, options };
    }

    // The weekly-plan user write: DataStore.applyOptimistic on the review cache,
    // then POST; commit with the server's plan, roll back on failure. A
    // committed this-week pick also clears the Today Goal Line entry (it shows
    // the live week's plan, and a pause hides its change / too-fast /
    // projection) so the next read refetches getGoalLine's truth — never a
    // hand-patched copy.
    async function saveWeekPlan(body, scope) {
        const ds = window.DataStore;
        const optimistic = !!(ds && typeof ds.applyOptimistic === 'function');
        let projected = null;
        const handle = optimistic
            ? await ds.applyOptimistic(WEEKLY_CACHE_KEY, (prev) => { projected = projectWeekPlan(prev, body); return projected; }, ['gamification'])
            : null;
        const call = window.offlineAwareApiCall || window.apiCallDirect;
        let res = null;
        try {
            if (typeof call === 'function') res = await call(WEEK_PLAN_URL, 'POST', body);
        } catch (_) { res = null; }
        const ok = !!(res && res.ok);
        try {
            if (handle) {
                if (ok) await handle.commit(projected ? { ...projected, plan: res.plan } : null);
                else await handle.rollback();
            }
        } catch (_) { /* best-effort */ }
        if (ok && optimistic && scope !== 'next_week') {
            try {
                const goalHandle = await ds.applyOptimistic(GOAL_LINE_CACHE_KEY, () => null, GOAL_LINE_TAGS);
                await goalHandle.commit(null);
            } catch (_) { /* best-effort: the entry still expires on its own */ }
        }
        return res;
    }

    function cadenceSelect(label, key, options, value) {
        const wrap = el('label', 'wg-journey-weekly__cadence-field');
        wrap.appendChild(el('span', 'wg-muted', label));
        const select = el('select', 'wg-input wg-select');
        select.setAttribute('data-cadence', key);
        options.forEach(([v, text]) => {
            const opt = el('option', null, text);
            opt.value = v;
            if (v === value) opt.selected = true;
            select.appendChild(opt);
        });
        wrap.appendChild(select);
        return wrap;
    }

    // Kit J2: the plan is a single-select .wg-choices list with ONE commit.
    // Tapping a choice only selects it; "Set … plan" writes it (through
    // saveWeekPlan → DataStore.applyOptimistic). Pause is the ghost action
    // beside it. The cadence selects keep writing on change.
    function renderWeekPlan(wr) {
        const opts = wr.options || {};
        const plan = wr.plan;
        const nextWeek = wr.plan_scope === 'next_week';
        const scope = nextWeek ? 'next week' : 'this week';
        const section = el('div', 'wg-section wg-journey-weekly__plan');
        section.setAttribute('data-plan-week', wr.plan_week || '');
        const head = el('div', 'wg-section__head');
        head.append(el('span', 'wg-eyebrow wg-eyebrow--dot wg-journey-weekly__scope', `Plan for ${scope}`),
            el('span', 'wg-meta', 'pick one'));
        section.appendChild(head);
        let current = `No pick yet — choose one for ${scope}.`;
        if (plan && plan.paused) current = `Paused ${scope}.`;
        else if (plan && plan.intention) current = plan.intention.text;
        section.appendChild(el('p', 'wg-hint wg-journey-weekly__current', current));

        const currentId = plan && !plan.paused && plan.intention ? plan.intention.id : null;
        let picked = currentId;
        const commit = el('button', 'wg-btn wg-btn--primary wg-journey-weekly__commit',
            nextWeek ? 'Set next week’s plan' : 'Set this week’s plan');
        commit.type = 'button';
        commit.disabled = true;

        const choices = el('div', 'wg-choices wg-journey-weekly__choices');
        (opts.intentions || []).forEach((it) => {
            const btn = el('button', 'wg-choice');
            btn.type = 'button';
            btn.setAttribute('data-choice', it.id);
            btn.setAttribute('aria-pressed', it.id === currentId ? 'true' : 'false');
            const label = el('span', null, it.text);
            if (it.id === currentId) label.appendChild(el('span', 'wg-choice__sub', 'Current'));
            btn.appendChild(label);
            btn.addEventListener('click', () => {
                picked = it.id;
                choices.querySelectorAll('.wg-choice').forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
                commit.disabled = picked === currentId;
            });
            choices.appendChild(btn);
        });
        section.appendChild(choices);

        // weigh_in goes out only from its own select (it sets the reminder).
        const pickBody = (choice) => {
            const { weigh_in: _w, ...cadence } = readCadence(section);
            return { choice, cadence };
        };
        commit.addEventListener('click', () => {
            if (!picked || picked === currentId) return;
            commit.disabled = true;
            saveWeekPlan(pickBody(picked), wr.plan_scope);
        });
        const pause = el('button', 'wg-btn wg-btn--ghost wg-journey-weekly__pause', `Pause ${scope}`);
        pause.type = 'button';
        pause.setAttribute('data-choice', 'pause');
        pause.setAttribute('aria-pressed', plan && plan.paused ? 'true' : 'false');
        pause.addEventListener('click', () => { saveWeekPlan(pickBody('pause'), wr.plan_scope); });
        const actions = el('div', 'wg-grid2 wg-journey-weekly__actions');
        actions.append(pause, commit);
        section.appendChild(actions);

        const cad = (plan && plan.cadence) || {};
        const cadence = el('div', 'wg-journey-weekly__cadence');
        if (Array.isArray(opts.weigh_in) && opts.weigh_in.length) {
            cadence.appendChild(cadenceSelect('Weigh-in', 'weigh_in',
                opts.weigh_in.map((v) => [v, v === 'daily' ? 'Daily' : 'Weekly']), opts.weigh_in_current || cad.weigh_in || 'weekly'));
        }
        const bpMax = Number(opts.bp_days_max) || 0;
        if (bpMax > 0) {
            const days = [['', '—']];
            for (let d = 1; d <= bpMax; d++) days.push([String(d), `${d} day${d === 1 ? '' : 's'}`]);
            cadence.appendChild(cadenceSelect('BP', 'bp_days', days,
                Number.isInteger(cad.bp_days) && cad.bp_days > 0 ? String(cad.bp_days) : ''));
        }
        // A cadence change alone keeps the week's pick (no `choice`).
        cadence.querySelectorAll('select').forEach((sel) => {
            sel.addEventListener('change', () => { saveWeekPlan({ cadence: readCadence(section) }, wr.plan_scope); });
        });
        if (cadence.childNodes.length) section.appendChild(cadence);
        return section;
    }

    function readCadence(section) {
        const out = {};
        const w = section.querySelector('select[data-cadence="weigh_in"]');
        if (w) out.weigh_in = w.value;
        const b = section.querySelector('select[data-cadence="bp_days"]');
        if (b) out.bp_days = b.value === '' ? null : Number(b.value);
        return out;
    }

    // Reads `journey.weekly_review` (attached by load() from its own
    // cachedFetch entry — GET /api/gamification/weekly-review), same pattern
    // as Gauges. Renders an explicit offline-empty state, omits the card
    // entirely while gate-off or not loaded yet, and reads an empty week as
    // "a quiet week" rather than a wall of zeros — the choice still shows.
    function renderWeeklyReview(j) {
        const wr = j.weekly_review;
        if (!wr) return null;

        const card = el('section', 'wg-card wg-vstack wg-journey-weekly');
        // The live week is the scorecard above; this card reviews the last
        // completed one, then holds the plan pick.
        card.appendChild(el('span', 'wg-eyebrow wg-journey-weekly__label', 'Last week'));

        if (wr.emptyState) {
            card.appendChild(el('p', 'wg-journey-weekly__empty wg-hint', wr.emptyState));
            return card;
        }
        if (wr.enabled === false) return null;

        if (wr.quiet) {
            card.appendChild(el('p', 'wg-journey-weekly__body wg-hint',
                'A quiet week — everything picks up where you left off.'));
        } else {
            const rows = wr.rows || {};
            const best = wr.best_day ? weekdayLabel(wr.best_day.day_unix) : null;
            const lines = [
                weeklyWeightRow(rows.weight),
                weeklyWorkoutRow(rows.workouts),
                weeklyBPRow(rows.bp),
                best ? `Best day: ${best}` : null,
            ].filter(Boolean);
            const list = el('div', 'wg-journey-weekly__list');
            lines.forEach((line) => list.appendChild(el('p', 'wg-journey-weekly__line wg-hint', line)));
            const reached = rows.weight && Array.isArray(rows.weight.milestones_reached) ? rows.weight.milestones_reached : [];
            reached.forEach((m) => list.appendChild(el('p', 'wg-journey-weekly__line wg-hint', `Reached: ${m.title}`)));
            card.appendChild(list);
        }
        card.appendChild(renderWeekPlan(wr));
        return card;
    }

    // Gauges panel (gamification-11 §Task4): weight/BP/resting-HR read as
    // trends, never a daily grade — copy is numbers + direction words only,
    // no color judgment (a slowing trend is an observation, never red; see
    // .wg-journey-gauge__caption, which stays a neutral meta line regardless of state).
    const GAUGE_PACE_STATUS_LABEL = {
        on_pace: 'on pace',
        too_slow: 'slower than your pace',
        too_fast: 'faster than your pace',
        wrong_direction: 'moving away from goal',
    };
    const GAUGE_ACCELERATION_LABEL = {
        speeding_up: 'speeding up',
        holding: 'holding steady',
        slowing: 'slowing',
    };

    function weightGaugeCopy(w) {
        if (!w || w.status !== 'ok') return 'Keep logging weight — not enough history yet for a trend.';
        const velocity = Number(w.velocity_pct_per_week) || 0;
        const parts = [`${velocity >= 0 ? '+' : ''}${velocity.toFixed(1)}%/week`];
        const pace = GAUGE_PACE_STATUS_LABEL[w.pace_status];
        if (pace) parts.push(pace);
        const accel = GAUGE_ACCELERATION_LABEL[w.acceleration];
        if (accel) parts.push(accel);
        return parts.join(' · ');
    }

    function bpGaugeCopy(bp) {
        if (!bp || bp.status !== 'ok') return 'Log a few more BP readings to see your range trend.';
        const baseline = Math.round((Number(bp.baseline_share_60d) || 0) * 100);
        // No readings in the last 30 days would render "In range 0%", which
        // reads as "out of range all month" when the truth is "no measurements".
        if (!(Number(bp.count_30d) > 0)) return `Baseline ${baseline}% in range · none logged in the last 30 days`;
        const share30d = Math.round((Number(bp.share_30d) || 0) * 100);
        return `In range ${share30d}% of last 30 days · baseline ${baseline}%`;
    }

    function restingHRGaugeCopy(hr) {
        if (!hr || hr.status !== 'ok') return 'Not enough resting-HR data yet for a baseline.';
        const recent = Math.round(Number(hr.recent_14d_mean) || 0);
        const delta = Math.round(Number(hr.delta_from_baseline) || 0);
        const deltaWord = delta === 0 ? 'at your baseline' : `${Math.abs(delta)} ${delta < 0 ? 'below' : 'above'} your baseline`;
        return `${recent} avg · ${deltaWord}`;
    }

    // One gauge as a kit row (J2): title, a .wg-meter where the gauge has a
    // real share to fill (BP in range over 30 days), the weight trend's
    // sparkline, and the caption. No fill reads a grade: weight velocity and
    // resting HR have no honest 0–100%, so they carry no meter.
    function renderGaugeRow(label, caption, opts) {
        const o = opts || {};
        const row = el('div', 'wg-row wg-row--pad wg-journey-gauge');
        const body = el('span', 'wg-row__body');
        body.appendChild(el('span', 'wg-row__title wg-journey-gauge__label', label));
        if (Number.isFinite(o.share)) {
            const meter = el('span', 'wg-meter wg-journey-gauge__meter');
            const fill = el('span', 'wg-meter__fill wg-meter__fill--sage');
            fill.style.setProperty('--p', pct(o.share));
            meter.appendChild(fill);
            body.appendChild(meter);
        }
        const points = o.sparkline;
        if (Array.isArray(points) && points.length > 1 &&
            window.WGSparkline && typeof window.WGSparkline.render === 'function') {
            const spark = window.WGSparkline.render({ points, variant: 'mint', width: 300, height: 40 });
            if (spark) {
                const chart = el('span', 'wg-journey-gauge__chart');
                chart.appendChild(spark);
                body.appendChild(chart);
            }
        }
        body.appendChild(el('span', 'wg-row__meta wg-journey-gauge__caption', caption));
        row.appendChild(body);
        return row;
    }

    // Reads `journey.gauges` (attached by load() from its own cachedFetch
    // entry — GET /api/gamification/gauges, gamification-11 §Task3) rather
    // than the Journey payload itself. Renders an explicit offline-empty state via `emptyState`, and
    // omits the whole section while gate-off (`enabled:false`) or not loaded yet.
    function renderGauges(j) {
        const gauges = j.gauges;
        if (!gauges) return null;

        const section = el('section', 'wg-section wg-journey-gauges');
        const head = el('div', 'wg-section__head');
        head.appendChild(el('span', 'wg-eyebrow', 'Gauges'));
        section.appendChild(head);

        if (gauges.emptyState) {
            section.appendChild(el('p', 'wg-journey-gauges__empty wg-hint', gauges.emptyState));
            return section;
        }
        if (gauges.enabled === false) return null;

        const list = el('div', 'wg-list wg-journey-gauges__list');
        // weight === null is ED-safe mode (med-8tur.12): no weight row at all.
        if (gauges.weight !== null) {
            list.appendChild(renderGaugeRow('Weight', weightGaugeCopy(gauges.weight),
                { sparkline: gauges.weight && gauges.weight.trend_history }));
        }
        const bp = gauges.bp;
        const bpShare = bp && bp.status === 'ok' && Number(bp.count_30d) > 0 ? Number(bp.share_30d) : NaN;
        list.appendChild(renderGaugeRow('Blood pressure', bpGaugeCopy(bp), { share: bpShare }));
        list.appendChild(renderGaugeRow('Resting heart rate', restingHRGaugeCopy(gauges.resting_hr)));
        section.appendChild(list);

        return section;
    }

    // --- Discovery Atlas feed (Phase 1, cloud POC) ------------------------
    // Reads `journey.atlas` (attached by load() from GET /api/gamification/atlas,
    // recomputed client-side from vault records in cloud mode). Three card
    // states, all rendered as first-class findings:
    //   developing — locked; one line, question + an inline "6/8 · 2 more"
    //                meter. Only the card closest to revealing also names the
    //                EXACT next log action.
    //   revealed   — the gate cleared; the finding with its numbers.
    //   no_effect  — the gate cleared and found nothing; a genuine, dignified
    //                result, not a hidden failure (the §14.8 honesty gate).
    // In bot mode the /atlas route 404s, loadAtlas() returns null, and this card
    // is simply omitted — the full substrate Journey renders unchanged.

    // Reveal-once: mark a terminal card seen the first time it renders, so the
    // backend can suppress a repeat "reveal" moment. Fire-and-forget — a failed
    // write never blocks the paint (the card still shows its finding).
    function markDiscoverySeen(card) {
        if (!card || card.seen) return;
        if (card.state !== 'revealed' && card.state !== 'no_effect') return;
        const call = window.offlineAwareApiCall || window.apiCallDirect;
        if (typeof call !== 'function') return;
        try {
            Promise.resolve(call('/api/gamification/atlas/seen', 'POST', { id: card.id }))
                .catch(() => {});
        } catch (_) { /* best-effort */ }
    }

    // Terminal = the probe gate cleared, either way (revealed / no_effect share
    // equal dignity). An unseen terminal card is the one genuinely new thing on
    // the screen: `seen` comes off the payload, so markDiscoverySeen() firing on
    // this paint only demotes the card on the NEXT load.
    function isTerminal(card) { return card.state === 'revealed' || card.state === 'no_effect'; }
    function isNewFinding(card) { return isTerminal(card) && !card.seen; }

    // Sort key: unseen findings (0) → developing (1) → findings already read (2).
    function atlasRank(card) { return isTerminal(card) ? (card.seen ? 2 : 0) : 1; }

    // One line per card (med-edxz.2). `showNext` is true only for the developing
    // card closest to revealing — that single action sentence is the daily hook.
    function atlasCardEl(card, expCtx, showNext) {
        const isNew = isNewFinding(card);
        const item = el('div', 'wg-journey-atlas__card wg-journey-atlas__card--' + card.state
            + (isNew ? ' wg-journey-atlas__card--new' : ''));

        if (card.state === 'developing') {
            const question = el('p', 'wg-journey-atlas__question', card.question);
            question.appendChild(el('span', 'wg-journey-atlas__meter wg-muted',
                `${Number(card.have) || 0}/${Number(card.needed) || 0} · ${Number(card.remaining) || 0} more`));
            item.appendChild(question);
            if (card.next && showNext) item.appendChild(el('p', 'wg-journey-atlas__next wg-muted', card.next));
            return item;
        }

        // revealed / no_effect — both terminal findings with equal dignity. The
        // finding states the question, so there is no separate question line.
        const finding = el('p', 'wg-journey-atlas__finding', card.text || card.question);
        // Honest spread: ± two standard errors of the delta, when the domain sent one.
        if (card.state === 'revealed' && Number.isFinite(card.se)) {
            const spread = card.unit === 'kg/wk' ? (2 * card.se).toFixed(1) : Math.round(2 * card.se);
            finding.appendChild(el('span', 'wg-journey-atlas__spread wg-muted', `±${spread} ${card.unit || ''}`.trim()));
        }
        item.appendChild(finding);
        const tags = el('div', 'wg-journey-atlas__tags');
        if (isNew) tags.appendChild(el('span', 'wg-tag wg-tag--mono wg-tag--sun wg-journey-atlas__tag--new', 'New'));
        tags.appendChild(el('span', 'wg-tag wg-tag--mono wg-journey-atlas__tag',
            card.state === 'revealed' ? 'Descriptive association' : 'Descriptive association · no difference'));
        item.appendChild(tags);

        // "Test it" (Phase 4): a terminal discovery with a matching lever
        // template can become a 14-day N-of-1 trial — but only one experiment
        // runs at a time, and never during recovery mode.
        const tpl = expCtx && expCtx.templateByProbe && expCtx.templateByProbe[card.id];
        if (tpl && expCtx.canStart) {
            const btn = el('button', 'wg-btn wg-btn--sm wg-journey-atlas__testit', 'Test it');
            btn.type = 'button';
            btn.addEventListener('click', () => startExperiment(tpl.id, card.id));
            item.appendChild(btn);
        }

        markDiscoverySeen(card);
        return item;
    }

    // --- "Since you last looked" strip (med-edxz.3) ------------------------
    // The Journey's first card: the handful of things that changed since the
    // last visit, as tappable one-liners that scroll to the card that owns
    // each one. The list is computed in the domain (getWhatsNew) and rides
    // along on the Atlas payload, so it costs no extra fetch. Empty list (a
    // fresh account, or an offline cold cache) → no card at all.
    //
    // `builtIds` is the set of card ids that actually rendered this pass. Each
    // target's card is omitted whenever its own fetch failed (offline with a
    // warm Atlas cache is the routine case), so only a line whose destination
    // exists becomes a button — a role="button" that scrolls nowhere is a
    // worse control than a plain line.
    // A goal-milestone line targets the goal card's timeline; when that
    // timeline didn't render (no goal, goal-line fetch failed) the milestone
    // sits in the Keystones card instead, so the line follows it there.
    function renderWhatsNew(j, builtIds, timelineShown) {
        const atlas = j && j.atlas;
        const items = (atlas && Array.isArray(atlas.whats_new)) ? atlas.whats_new : [];
        if (items.length === 0) return null;

        const card = el('section', 'wg-card wg-journey-whatsnew');
        card.id = 'journey-whatsnew-card';
        // Only the anticipation fallback survived → nothing actually changed,
        // so the label promises today's next step instead of news.
        const onlyFallback = items.every((it) => it.kind === 'anticipation');
        card.appendChild(el('div', 'wg-section-label',
            onlyFallback ? 'TODAY' : 'SINCE YOU LAST LOOKED'));

        const list = el('div', 'wg-journey-whatsnew__list');
        items.forEach((it) => {
            const want = (it.target === 'journey-goal-card' && !timelineShown) ? 'journey-keystones-card' : it.target;
            const target = (want && builtIds && builtIds.has(want)) ? want : null;
            const row = el('p', 'wg-journey-whatsnew__item'
                + (target ? ' wg-journey-whatsnew__item--tappable' : ''), it.text);
            if (target) {
                row.setAttribute('role', 'button');
                row.setAttribute('tabindex', '0');
                row.addEventListener('click', () => goToCard(target));
                row.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToCard(target); }
                });
            }
            list.appendChild(row);
        });
        card.appendChild(list);
        return card;
    }

    function renderAtlas(j) {
        const atlas = j && j.atlas;
        if (!atlas) return null;

        const card = el('section', 'wg-card wg-journey-atlas');
        card.id = 'journey-atlas-card';
        const label = el('div', 'wg-section-label', 'DISCOVERIES');
        card.appendChild(label);

        if (atlas.emptyState) {
            card.appendChild(el('p', 'wg-journey-atlas__empty wg-muted', atlas.emptyState));
            return card;
        }

        const cards = Array.isArray(atlas.cards) ? atlas.cards : [];
        if (cards.length === 0) return null;

        // Build the "Test it" context once: which discoveries have a lever
        // template, and whether a new trial can start (nothing active, not paused).
        const exp = j && j.experiments;
        const templateByProbe = {};
        if (exp && Array.isArray(exp.templates)) {
            exp.templates.forEach((t) => { if (t.from_probe) templateByProbe[t.from_probe] = t; });
        }
        const expCtx = { templateByProbe, canStart: !!(exp && exp.can_start) };

        // Unseen findings lead, then the developing cards closest to revealing,
        // then the findings already read. sort() is stable, so the catalog order
        // survives inside each group.
        const ordered = cards.slice().sort((a, b) => atlasRank(a) - atlasRank(b)
            || (atlasRank(a) === 1 ? (Number(a.remaining) || 0) - (Number(b.remaining) || 0) : 0));

        const newCount = cards.filter(isNewFinding).length;
        const revealedCount = cards.filter(isTerminal).length;
        const parts = ['DISCOVERIES'];
        if (newCount > 0) parts.push(`${newCount} NEW`);
        if (revealedCount > 0) parts.push(`${revealedCount} revealed`);
        if (cards.length > revealedCount) parts.push(`${cards.length - revealedCount} developing`);
        label.textContent = parts.join(' · ');

        const list = el('div', 'wg-journey-atlas__list');
        let nextShown = false;
        ordered.forEach((c) => {
            const showNext = c.state === 'developing' && !nextShown;
            if (showNext) nextShown = true;
            list.appendChild(atlasCardEl(c, expCtx, showNext));
        });
        card.appendChild(list);
        return card;
    }

    // --- Self-Experiments (Phase 4) ---------------------------------------
    // The active-trial tracker + verdict card, and the start/cancel handlers.
    // Reads `journey.experiments` (attached by load() from GET
    // /api/gamification/experiments). Bot mode 404s the route → null → no card.

    function experimentApiCall(endpoint, method, body) {
        const call = window.offlineAwareApiCall || window.apiCallDirect;
        if (typeof call !== 'function') return Promise.resolve(null);
        return Promise.resolve(call(endpoint, method, body)).catch(() => null);
    }

    async function reloadJourney() {
        if (window.Gamification && typeof window.Gamification.load === 'function') {
            await window.Gamification.load();
        }
    }

    async function startExperiment(templateId, sourceDiscovery) {
        await experimentApiCall('/api/gamification/experiments', 'POST',
            { template_id: templateId, source_discovery: sourceDiscovery });
        await reloadJourney();
    }

    async function cancelExperiment(id) {
        if (!id) return;
        await experimentApiCall(`/api/gamification/experiments/${encodeURIComponent(id)}`, 'DELETE');
        await reloadJourney();
    }

    function verdictTagText(verdict) {
        if (verdict === 'effect') return 'A difference — a finding';
        if (verdict === 'no_effect') return 'No difference — an equally real finding';
        return 'Not enough contrast';
    }

    function renderExperiment(j) {
        const exp = j && j.experiments;
        if (!exp || exp.enabled === false) return null;
        // Nothing to surface as a card: the "Test it" entry points live on the
        // discovery cards themselves, so an idle state renders no experiment card.
        if (!exp.active && !exp.verdict) return null;

        const card = el('section', 'wg-card wg-journey-experiment');
        card.id = 'journey-experiment-card';
        card.appendChild(el('div', 'wg-section-label', 'SELF-EXPERIMENT'));

        if (exp.active) {
            const a = exp.active;
            card.appendChild(el('p', 'wg-journey-experiment__title', a.title || 'Your trial'));
            if (a.intention) card.appendChild(el('p', 'wg-journey-experiment__intention', a.intention));
            if (a.measure) card.appendChild(el('p', 'wg-journey-experiment__measure wg-muted', a.measure));
            const duration = Number(a.duration) || 0;
            card.appendChild(progressBar(duration > 0 ? (Number(a.day_number) || 0) / duration : 0,
                'wg-journey-bar__fill--sun'));
            card.appendChild(el('p', 'wg-journey-experiment__tracker wg-muted', a.tracker || ''));
            if (a.paused) {
                card.appendChild(el('span', 'wg-tag wg-tag--mono wg-journey-experiment__paused',
                    'Paused — recovery mode'));
            }
            const stop = el('button', 'wg-btn wg-btn--ghost wg-btn--sm wg-journey-experiment__cancel', 'Stop trial (no penalty)');
            stop.type = 'button';
            stop.addEventListener('click', () => cancelExperiment(a.id));
            card.appendChild(stop);
            return card;
        }

        // Verdict — effect / no_effect / not_enough_contrast, all shown with the
        // numbers; no_effect carries the SAME reward line as effect (§3.3).
        const v = exp.verdict;
        card.appendChild(el('p', 'wg-journey-experiment__title', v.title || 'Verdict'));
        card.appendChild(el('span', 'wg-tag wg-tag--mono wg-journey-experiment__verdict-tag',
            verdictTagText(v.verdict)));
        card.appendChild(el('p', 'wg-journey-experiment__finding', v.text || ''));
        if (v.rewarded) {
            card.appendChild(el('p', 'wg-journey-experiment__reward wg-muted',
                'Logged as a keystone — running a clean trial is the win, whatever it found.'));
        }
        if (v.disclaimer) {
            card.appendChild(el('p', 'wg-journey-experiment__disclaimer wg-muted', v.disclaimer));
        }
        const done = el('button', 'wg-btn wg-btn--ghost wg-btn--sm wg-journey-experiment__done', 'Got it');
        done.type = 'button';
        done.addEventListener('click', () => cancelExperiment(v.id));
        card.appendChild(done);
        return card;
    }

    // Scrolls to another card on this screen. A no-op if that card wasn't
    // rendered this pass — every caller's destination is conditional on its
    // own payload having loaded.
    function goToCard(id) {
        // A card waiting behind the "More" row opens its page before the scroll.
        if (document.querySelector(`#journey-more .wg-journey-more__cards > #${id}`)) openMorePage();
        const target = document.getElementById(id);
        if (target && typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // --- Chapters (Phase 5) -----------------------------------------------
    // Opt-in 4-week themed arcs. Reads `journey.chapter` (GET
    // /api/gamification/chapter). Active → a day tracker; idle → the last
    // review + the theme library to start the next arc (never auto-enrolled).

    async function startChapter(themeId) {
        await experimentApiCall('/api/gamification/chapter', 'POST', { theme_id: themeId });
        await reloadJourney();
    }

    async function closeChapter() {
        await experimentApiCall('/api/gamification/chapter', 'DELETE');
        await reloadJourney();
    }

    function renderChapterReview(card, review) {
        card.appendChild(el('p', 'wg-journey-chapter__title', review.title || 'Your last chapter'));
        card.appendChild(el('span', 'wg-tag wg-tag--mono wg-journey-chapter__tag', 'Chapter review'));
        card.appendChild(el('p', 'wg-journey-chapter__recap wg-muted', review.text || ''));
    }

    // The theme library is a menu you open, not a wall you read: collapsed
    // behind one summary line (med-edxz.1), native <details>, no JS state.
    function renderChapterThemes(card, themes) {
        const details = el('details', 'wg-journey-chapter__details');
        details.appendChild(el('summary', 'wg-journey-chapter__summary wg-muted', 'Start a 4-week chapter'));
        const list = el('div', 'wg-journey-chapter__themes');
        (Array.isArray(themes) ? themes : []).forEach((t) => {
            const row = el('div', 'wg-journey-chapter__theme');
            const head = el('div', 'wg-journey-chapter__theme-head');
            head.appendChild(el('span', 'wg-journey-chapter__theme-title', t.title));
            const start = el('button', 'wg-btn wg-btn--sm', 'Start');
            start.type = 'button';
            start.addEventListener('click', () => startChapter(t.id));
            head.appendChild(start);
            row.appendChild(head);
            row.appendChild(el('p', 'wg-journey-chapter__theme-blurb wg-muted', t.blurb || t.focus || ''));
            list.appendChild(row);
        });
        details.appendChild(list);
        card.appendChild(details);
    }

    function renderChapter(j) {
        const ch = j && j.chapter;
        if (!ch || ch.enabled === false) return null;

        const card = el('section', 'wg-card wg-journey-chapter');
        card.id = 'journey-chapter-card';
        card.appendChild(el('div', 'wg-section-label', 'CHAPTER'));

        if (ch.active) {
            const a = ch.active;
            card.appendChild(el('p', 'wg-journey-chapter__title', a.title || 'Your chapter'));
            if (a.focus) card.appendChild(el('p', 'wg-journey-chapter__focus wg-muted', `Focus: ${a.focus}`));
            const duration = Number(a.duration) || 0;
            card.appendChild(progressBar(duration > 0 ? (Number(a.day_number) || 0) / duration : 0,
                'wg-journey-bar__fill--sun'));
            card.appendChild(el('p', 'wg-journey-chapter__tracker wg-muted',
                `Day ${Number(a.day_number) || 0} of ${duration}`));
            const end = el('button', 'wg-btn wg-btn--ghost wg-btn--sm wg-journey-chapter__close', 'End chapter (writes your review)');
            end.type = 'button';
            end.addEventListener('click', () => closeChapter());
            card.appendChild(end);
            return card;
        }

        if (ch.review) renderChapterReview(card, ch.review);
        if (ch.can_start) renderChapterThemes(card, ch.themes);
        return card;
    }

    // --- Traits (Phase 5) --------------------------------------------------
    // Levers-only identity statements. Reads `journey.traits` (GET
    // /api/gamification/traits). Three states, all dignified: held (currently
    // true), dormant (lapsed — dimmed, never deleted, with a cheap rekindle
    // cost), developing (not yet earned, with progress to the bar).

    function traitStateTag(t) {
        if (t.state === 'held') return t.recovery_held ? 'Held · paused' : 'Held';
        if (t.state === 'dormant') return 'Dormant';
        return 'Developing';
    }

    function traitSubtitle(t) {
        if (t.state === 'held') {
            return t.recovery_held
                ? 'Held through recovery — the clock is paused, nothing lapses.'
                : `${Number(t.on_28d) || 0} ${t.lever_label} in the last 28 days.`;
        }
        if (t.state === 'dormant') {
            const need = Number(t.rekindle_remaining);
            const n = Number.isFinite(need) ? need : Number(t.rekindle) || 0;
            const unit = n === 1 ? String(t.lever_label).replace(/s$/, '') : t.lever_label;
            return `Dormant — ${n} more ${unit} rekindles it. Nothing was lost.`;
        }
        const remaining = Number(t.remaining) || 0;
        return `${Number(t.on_28d) || 0} of ${Number(t.earn) || 0} ${t.lever_label} — ${remaining} more to earn it.`;
    }

    function renderTraits(j) {
        const tr = j && j.traits;
        if (!tr || tr.enabled === false) return null;
        const traits = Array.isArray(tr.traits) ? tr.traits : [];
        if (traits.length === 0) return null;

        const card = el('section', 'wg-card wg-journey-traits');
        card.id = 'journey-traits-card';
        card.appendChild(el('div', 'wg-section-label', 'TRAITS'));
        const list = el('div', 'wg-journey-traits__list');
        traits.forEach((t) => {
            const row = el('div', 'wg-journey-trait wg-journey-trait--' + t.state);
            const head = el('div', 'wg-journey-trait__head');
            head.appendChild(el('span', 'wg-journey-trait__name', t.title || t.id));
            head.appendChild(el('span', 'wg-tag wg-tag--mono wg-journey-trait__tag', traitStateTag(t)));
            row.appendChild(head);
            row.appendChild(el('p', 'wg-journey-trait__sub wg-muted', traitSubtitle(t)));
            list.appendChild(row);
        });
        card.appendChild(list);
        return card;
    }

    // --- Keystones (Phase 5) ----------------------------------------------
    // The permanent timeline of rare, real-outcome milestones. Reads
    // `journey.keystones` (GET /api/gamification/keystones). Never a countdown,
    // never decays — an empty timeline simply omits the card.

    function keystoneDateLabel(ms) {
        const t = Number(ms);
        if (!Number.isFinite(t)) return '';
        try {
            return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        } catch (_) { return ''; }
    }

    function keystoneRow(k) {
        const row = el('div', 'wg-journey-keystone');
        const marker = el('span', 'wg-journey-keystone__marker');
        const star = icon('check', 14);
        if (star) marker.appendChild(star);
        row.appendChild(marker);
        const body = el('div', 'wg-journey-keystone__body');
        body.appendChild(el('span', 'wg-journey-keystone__title', k.title || 'Milestone'));
        if (k.text) body.appendChild(el('span', 'wg-journey-keystone__text wg-muted', k.text));
        const date = keystoneDateLabel(k.earned_at);
        if (date) body.appendChild(el('span', 'wg-journey-keystone__date wg-muted', date));
        row.appendChild(body);
        return row;
    }

    // Goal milestones move to the goal card's timeline whenever that timeline
    // renders; without it (goal-line fetch failed, no_goal) they stay here.
    function renderKeystones(j, timelineShown) {
        const ks = j && j.keystones;
        if (!ks || ks.enabled === false) return null;
        const entries = (Array.isArray(ks.keystones) ? ks.keystones : [])
            .filter((k) => !(timelineShown && isGoalMilestone(k)));
        if (entries.length === 0) return null;

        const card = el('section', 'wg-card wg-journey-keystones');
        card.id = 'journey-keystones-card';
        card.appendChild(el('div', 'wg-section-label', 'KEYSTONES'));
        const list = el('div', 'wg-journey-keystones__list');
        entries.forEach((k) => list.appendChild(keystoneRow(k)));
        card.appendChild(list);
        return card;
    }

    // --- AI narration (Phase 6) -------------------------------------------
    // Opt-in, BYO-key prose OVER the deterministic cards. The card only mounts
    // in cloud mode (bot mode 404s /api/gamification/narrate → null → omitted).
    // Every button is purely additive: tapping POSTs a narrate route that hands
    // the user's OWN provider the already-computed stats-JSON and returns prose,
    // dropped into a SEPARATE attributed block. Numbers on screen still come
    // from the deterministic cards above — this never replaces a value, and a
    // no-key/error response ({text:null}) shows an honest hint instead.
    function narrateInto(kind, outEl, btn) {
        outEl.replaceChildren(el('p', 'wg-journey-narrator__status wg-muted', 'Narrating with your AI…'));
        btn.disabled = true;
        return Promise.resolve(experimentApiCall(`/api/gamification/narrate/${kind}`, 'POST', {}))
            .then((res) => {
                btn.disabled = false;
                if (res && res.text) {
                    const block = el('div', 'wg-journey-narrator__prose');
                    block.appendChild(el('span', 'wg-tag wg-tag--mono wg-journey-narrator__attr', 'narrated by your AI'));
                    block.appendChild(el('p', 'wg-journey-narrator__text', res.text));
                    outEl.replaceChildren(block);
                } else {
                    outEl.replaceChildren(el('p', 'wg-journey-narrator__status wg-muted',
                        'AI narration unavailable — add an OpenAI key in Settings → Integrations to enable it.'));
                }
            })
            .catch(() => {
                btn.disabled = false;
                outEl.replaceChildren(el('p', 'wg-journey-narrator__status wg-muted',
                    'AI narration is unavailable right now — your story above is unaffected.'));
            });
    }

    function narratorButton(label, kind, outEl) {
        const btn = el('button', 'wg-btn wg-btn--ghost wg-btn--sm', label);
        btn.type = 'button';
        btn.addEventListener('click', () => narrateInto(kind, outEl, btn));
        return btn;
    }

    function renderNarrator(j) {
        const n = j && j.narration;
        if (!n || n.enabled === false) return null;

        const card = el('section', 'wg-card wg-journey-narrator');
        card.id = 'journey-narrator-card';
        card.appendChild(el('div', 'wg-section-label', 'AI STORY'));
        card.appendChild(el('p', 'wg-journey-narrator__note wg-muted',
            'Optional — sends computed summaries, never raw logs, to your own AI key or, with your consent, the trial AI.'));

        const out = el('div', 'wg-journey-narrator__out');
        const buttons = el('div', 'wg-journey-narrator__buttons');
        buttons.appendChild(narratorButton('Narrate my week', 'weekly', out));
        buttons.appendChild(narratorButton('Workout insight', 'workout', out));
        if (j && j.chapter && j.chapter.review) {
            buttons.appendChild(narratorButton('Chapter recap', 'chapter', out));
        }
        if (j && j.experiments && j.experiments.can_start) {
            buttons.appendChild(narratorButton('Experiment idea', 'experiments', out));
        }
        card.appendChild(buttons);
        card.appendChild(out);
        return card;
    }

    // Experiment / chapter / traits / keystones (med-8tur.9): Atlas machinery,
    // not the goal. They live on their own pushed page behind one "More" row
    // (kit J2, med-xso6.8); the row's meta line says when a trial or chapter
    // is live. Cards are rebuilt every render: while the page is open they
    // refresh in place there, otherwise they wait in a hidden holder on the
    // row (so goToCard can still find them).
    function renderMore(cards, liveNote) {
        const built = cards.filter(Boolean);
        const openPage = document.getElementById('journey-more-page');
        if (built.length === 0) {
            // Nothing left behind the row: an open page must not keep stale cards.
            if (openPage) openPage.replaceChildren();
            return null;
        }
        const section = el('section', 'wg-list wg-journey-more');
        section.id = 'journey-more';

        const row = el('button', 'wg-row wg-journey-more__row');
        row.type = 'button';
        const lead = el('span', 'wg-row__lead');
        const flag = el('i', 'wg-ico');
        flag.dataset.icon = 'flag';
        lead.appendChild(flag);
        const body = el('span', 'wg-row__body');
        body.appendChild(el('span', 'wg-row__title', 'More'));
        body.appendChild(el('span', 'wg-row__meta', liveNote || 'Experiments, chapters, traits, keystones'));
        const chev = el('i', 'wg-ico wg-row__chev');
        chev.dataset.icon = 'chev-r';
        row.append(lead, body, chev);
        row.addEventListener('click', openMorePage);

        const holder = el('div', 'wg-journey-more__cards');
        holder.hidden = true;
        (openPage || holder).replaceChildren(...built);
        section.append(row, holder);
        if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(section);
        return section;
    }

    function openMorePage() {
        if (document.getElementById('journey-more-page')) return;
        const holder = document.querySelector('#journey-more .wg-journey-more__cards');
        if (!holder || !window.WGPage) return;
        const body = el('div', 'wg-journey-more__page');
        body.id = 'journey-more-page';
        body.append(...holder.childNodes);
        window.WGPage.push({
            title: 'More',
            crumb: 'Experiments · chapters · traits · keystones',
            back: 'Journey',
            body,
            onClose: () => {
                const h = document.querySelector('#journey-more .wg-journey-more__cards');
                if (h) h.replaceChildren(...body.childNodes);
            },
        });
    }

    function moreLiveNote(j) {
        const parts = [];
        const exp = j && j.experiments;
        if (exp && exp.active) parts.push('1 trial running');
        else if (exp && exp.verdict) parts.push('trial verdict ready');
        if (j && j.chapter && j.chapter.active) parts.push('chapter in progress');
        return parts.join(' · ');
    }

    function render(journey) {
        const content = document.getElementById('journey-content');
        if (!content) return;

        // Goal-first (med-8tur.9): Goal Line detail → this week's scorecard →
        // last week + the plan pick → discoveries
        // (the "since you last looked" strip + Atlas) → gauges →
        // experiment/chapter/traits/keystones behind a disclosure → AI story.
        // HP/levels/Health Score are not rendered. The narrative layer also
        // stands on its own: a disabled substrate ({enabled:false}) with a live
        // narrative layer still renders it rather than the "gamification is
        // off" state — without the substrate-fed week / gauges.
        const substrate = !!journey && journey.enabled !== false;
        let cards = [];
        if (journey) {
            const goalCard = renderGoalContext(journey);
            const atlasCard = renderAtlas(journey);
            const traitsCard = renderTraits(journey);
            const experimentCard = renderExperiment(journey);
            const chapterCard = renderChapter(journey);
            const timelineShown = !!(goalCard && goalCard.querySelector('.wg-journey-goal__timeline-label'));
            const keystonesCard = renderKeystones(journey, timelineShown);
            // The strip is built LAST: it can only link to a card this pass produced.
            const builtIds = new Set([goalCard, atlasCard, traitsCard, experimentCard, chapterCard, keystonesCard]
                .filter(Boolean).map((c) => c.id));
            const whatsNewCard = renderWhatsNew(journey, builtIds, timelineShown);
            cards = [
                goalCard,
                renderWeekScorecard(journey),
                substrate ? renderWeeklyReview(journey) : null,
                whatsNewCard,
                atlasCard,
                substrate ? renderGauges(journey) : null,
                renderMore([experimentCard, chapterCard, traitsCard, keystonesCard], moreLiveNote(journey)),
                renderNarrator(journey),
            ].filter(Boolean);
        }

        if (cards.length === 0 && !substrate) {
            renderEmpty(content, 'Gamification is off. Enable it in Settings to start your Journey.');
            return;
        }
        content.replaceChildren(...cards);
    }

    // Fetches the Gauges read model through its own cachedFetch entry (Task
    // 4), whenever the Journey payload loads. A cold cache offline read renders
    // an explicit empty state on the card rather than omitting it silently.
    async function loadGauges() {
        try {
            const result = await window.cachedFetch(GAUGES_CACHE_KEY, GAUGES_URL, {
                tags: ['gamification'],
                freshAfterMs: 60_000,
                staleAfterMs: STALE_AFTER_MS,
            });
            return result ? result.data : null;
        } catch (e) {
            if (window.OfflineNoCacheError && e instanceof window.OfflineNoCacheError) {
                return { emptyState: 'No cached gauge data — connect to load.' };
            }
            console.error('Failed to load gamification gauges:', e);
            return null;
        }
    }

    // Fetches the Weekly Review read model through its own cachedFetch entry
    // (Task 3) — like Gauges, fetched whenever the Journey payload loads. A
    // cold cache offline read renders an explicit empty state on the card
    // rather than omitting it silently.
    async function loadWeeklyReview() {
        try {
            const result = await window.cachedFetch(WEEKLY_CACHE_KEY, WEEKLY_URL, {
                tags: ['gamification'],
                freshAfterMs: 60_000,
                staleAfterMs: STALE_AFTER_MS,
            });
            return result ? result.data : null;
        } catch (e) {
            if (window.OfflineNoCacheError && e instanceof window.OfflineNoCacheError) {
                return { emptyState: 'No cached weekly review — connect to load.' };
            }
            console.error('Failed to load gamification weekly review:', e);
            return null;
        }
    }

    // Goal Line read-model for the goal-context card — same cache entry as the
    // Today hero. Offline cold cache / error → no card (the Today card carries
    // the offline story; this one is context).
    async function loadGoalLine() {
        try {
            const result = await window.cachedFetch(GOAL_LINE_CACHE_KEY, GOAL_LINE_URL, {
                tags: GOAL_LINE_TAGS,
                freshAfterMs: 60_000,
                staleAfterMs: STALE_AFTER_MS,
            });
            return result ? result.data : null;
        } catch (_) {
            return null;
        }
    }

    // Fetches the Discovery Atlas read model through its own cachedFetch entry
    // (Phase 1). Cloud mode serves it from the vault client-side; bot mode 404s
    // the route, which surfaces here as a null (no Atlas card) — the substrate
    // Journey renders unchanged. A cold-cache offline read shows an explicit
    // empty state on the card rather than omitting it silently.
    const ATLAS_CACHE_KEY = 'gamification_atlas';
    const ATLAS_URL = '/api/gamification/atlas';
    async function loadAtlas() {
        try {
            const result = await window.cachedFetch(ATLAS_CACHE_KEY, ATLAS_URL, {
                tags: ['gamification'],
                freshAfterMs: 60_000,
                staleAfterMs: STALE_AFTER_MS,
            });
            return result ? result.data : null;
        } catch (e) {
            if (window.OfflineNoCacheError && e instanceof window.OfflineNoCacheError) {
                return { emptyState: 'No cached discoveries — connect to load.' };
            }
            // A 404 (bot mode, no Atlas route) or any other error → no card.
            return null;
        }
    }

    // Fetches the Self-Experiments read model (Phase 4). Stateful (persisted
    // trials), so it reads through offlineAwareApiCall rather than cachedFetch —
    // the atlas/journey cachedFetch calls already satisfy the offline-coverage
    // guard for this file. Bot mode 404s the route → null → no experiment card.
    function loadExperiments() {
        const call = window.offlineAwareApiCall || window.apiCallDirect;
        if (typeof call !== 'function') return Promise.resolve(null);
        return Promise.resolve(call('/api/gamification/experiments', 'GET')).catch(() => null);
    }

    // Narrative-layer loaders (Phase 5) — chapters/traits/keystones. Stateful
    // (persisted in the journal singleton), so like experiments they read
    // through offlineAwareApiCall rather than cachedFetch; the atlas/journey
    // cachedFetch calls already satisfy the offline-coverage guard for this
    // file. Bot mode 404s each route → null → the card is omitted.
    function loadNarrative(endpoint) {
        const call = window.offlineAwareApiCall || window.apiCallDirect;
        if (typeof call !== 'function') return Promise.resolve(null);
        return Promise.resolve(call(endpoint, 'GET')).catch(() => null);
    }

    // Loads the Journey read model and paints the screen. Routes through
    // cachedFetch so a cold relaunch offline renders last-known data; a cold
    // cache offline surfaces an explicit empty state (OfflineNoCacheError).
    async function load() {
        const content = document.getElementById('journey-content');
        if (!content) return;

        if (typeof window.cachedFetch !== 'function') {
            // Early boot / non-browser harness: best-effort direct read.
            try {
                const raw = await (window.offlineAwareApiCall || window.apiCallDirect)(JOURNEY_URL, 'GET');
                render(raw);
            } catch (e) {
                console.error('Failed to load gamification journey:', e);
                renderEmpty(content, 'Failed to load your Journey.');
            }
            return;
        }

        try {
            const result = await window.cachedFetch(CACHE_KEY, JOURNEY_URL, {
                tags: ['gamification'],
                freshAfterMs: 60_000,
                staleAfterMs: STALE_AFTER_MS,
            });
            const data = result ? result.data : null;
            if (data) {
                data.gauges = await loadGauges();
                data.weekly_review = await loadWeeklyReview();
            }
            // The narrative layer is fetched whether or not the substrate is
            // enabled: in cloud mode the substrate returns {enabled:false} but
            // the Atlas/chapters/traits/keystones are the whole point of the
            // screen, so they must still render.
            const [atlas, experiments, chapter, traits, keystones, narration, goalLine] = await Promise.all([
                loadAtlas(), loadExperiments(),
                loadNarrative('/api/gamification/chapter'),
                loadNarrative('/api/gamification/traits'),
                loadNarrative('/api/gamification/keystones'),
                loadNarrative('/api/gamification/narrate'),
                loadGoalLine(),
            ]);
            if (atlas || experiments || chapter || traits || keystones || narration || goalLine) {
                const narrative = { atlas, experiments, chapter, traits, keystones, narration, goal_line: goalLine };
                if (!data) render({ enabled: false, ...narrative });
                else { Object.assign(data, narrative); render(data); }
                return;
            }
            render(data);
        } catch (e) {
            if (window.OfflineNoCacheError && e instanceof window.OfflineNoCacheError) {
                renderEmpty(content, 'No cached Journey data — connect to load.');
                return;
            }
            console.error('Failed to load gamification journey:', e);
            renderEmpty(content, 'Failed to load your Journey.');
        }
    }

    window.Gamification = { load, render };
})();
