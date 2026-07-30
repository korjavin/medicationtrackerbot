// ====================================
// WORKOUT EXERCISE DETAIL — per-exercise records + progress graphs
// ====================================
//
// Phase 3 (epic med-qj4) read-side surface. Fetches one exercise's completed
// history (`GET /api/workout/exercises/history?name=`) and folds it through the
// pure web/domain/workout-analysis.js module (est-1RM / PRs / series) to render
// a records summary plus progress graphs. Also owns the shared analysis-module
// resolver + isPRLog record test consumed by the session log-card PR badge
// (sessions.js).
//
// The headline metric and graph order follow the exercise's effective training
// goal (med-qj4.6.4), and a hypertrophy exercise whose recent rated sets sit far
// from failure gets a gentle advisory (med-qj4.6.5). Both decisions are made in
// workout-analysis.js — goalHeadline / effortInsight — so nothing goal-shaped
// (rep thresholds, RIR cutoffs, the RIR = 10 − RPE conversion) is duplicated in
// this plain script; it only formats what the module hands it.
//
// The static frontend is classic <script> (no bundler / ESM imports), so the
// pure module reaches it two ways: tests inject `window.WorkoutAnalysis`; at
// runtime we dynamic-import `/domain/workout-analysis.js` (served in cloud mode,
// the primary target). Bot mode does not serve /domain/ — the import fails, the
// resolver caches null, and the analysis surfaces degrade silently (no records,
// no PR badge). No new server route, no duplicated arithmetic.

(function () {
    // undefined = not yet resolved, null = unavailable, object = the module.
    let _analysis;
    async function getAnalysis() {
        if (_analysis !== undefined) return _analysis;
        if (window.WorkoutAnalysis && typeof window.WorkoutAnalysis.exercisePRs === 'function') {
            _analysis = window.WorkoutAnalysis;
            return _analysis;
        }
        try {
            const m = await import('/domain/workout-analysis.js');
            _analysis = (m && typeof m.exercisePRs === 'function') ? m : null;
        } catch (_) {
            _analysis = null; // bot mode (no /domain/) or offline — cache the miss
        }
        return _analysis;
    }

    // isPRLog: does `log` set a new record against `priorPRs` (the folded PRs of
    // that exercise's history EXCLUDING this log's session)? Folds this log's own
    // sets via exercisePRs (so warm-up exclusion + every PR type stay in one place)
    // and returns true only when a new heaviest weight or best est-1RM beats the
    // prior baseline (see the trigger-narrowing rationale below).
    function isPRLog(log, priorPRs, WA) {
        if (!log || !priorPRs || !WA || typeof WA.exercisePRs !== 'function') return false;
        const cur = WA.exercisePRs([log]);
        // Only a genuinely stronger lift earns the badge: a new heaviest weight or
        // a new best estimated 1RM. The other record types (best set/session
        // volume, most reps, per-rep-count set_records) fired on ordinary
        // set-to-set variation — any novel rep count beats an undefined→0 bucket —
        // so the badge showed on nearly every log. exercisePRs still computes them
        // for the exercise-detail Records view; only this trigger narrows.
        // ponytail: bodyweight-only exercises (weight 0) can no longer earn a PR
        // badge — acceptable, the badge targets weighted lifts.
        if (cur.heaviest_weight > (priorPRs.heaviest_weight || 0)) return true;
        if (cur.best_est_1rm > (priorPRs.best_est_1rm || 0)) return true;
        return false;
    }

    function _fmtWeight(kg) {
        const n = Number(kg) || 0;
        if (n <= 0) return '—';
        return `${n % 1 === 0 ? n : n.toFixed(1)} kg`;
    }

    // Low-confidence chip for an est-1RM back-computed from a high-rep set
    // (med-qj4.6.4). Epley/Brzycki drift past ~10-12 reps, so the number gets
    // the caveat attached to it rather than a footnote elsewhere.
    function _confidenceFlag(reps) {
        const flag = document.createElement('span');
        flag.className = 'wg-workouts-exercise-detail__flag';
        flag.textContent = `estimate · from a ${reps}-rep set`;
        flag.title = 'The Epley formula loses accuracy above ~12 reps — treat this as a rough estimate.';
        return flag;
    }

    function _recordRow(label, valueText, flagNode) {
        const row = document.createElement('li');
        row.className = 'wg-card wg-workouts-stats__top-row wg-workouts-exercise-detail__record';

        const head = document.createElement('div');
        head.className = 'wg-workouts-stats__top-row-head';

        const name = document.createElement('span');
        name.className = 'wg-workouts-stats__top-row-name';
        name.textContent = label;

        const value = document.createElement('span');
        value.className = 'wg-workouts-stats__top-row-volume wg-mono-display';
        value.textContent = valueText;

        head.appendChild(name);
        head.appendChild(value);
        row.appendChild(head);
        if (flagNode) row.appendChild(flagNode);
        return row;
    }

    // Format a headline/summary value in its own unit: kg through the weight
    // formatter, counts as plain integers.
    function _fmtUnit(value, unit) {
        const n = Number(value) || 0;
        if (unit === 'kg') return _fmtWeight(n);
        return n > 0 ? `${Math.round(n)} ${unit}` : '—';
    }

    const CHART_LABELS = {
        'est-1rm': 'Estimated 1RM · over time',
        'top-weight': 'Top weight · over time',
        volume: 'Volume load · over time',
        reps: 'Total reps · over time',
    };

    // Goal-driven headline card (med-qj4.6.4): the metric this exercise's
    // effective training goal is actually chasing, ahead of the records list.
    function _headlineCard(headline) {
        const card = document.createElement('div');
        card.className = 'wg-card wg-workouts-exercise-detail__headline';
        card.dataset.goal = headline.goal;

        const label = document.createElement('span');
        label.className = 'wg-workouts-exercise-detail__headline-label';
        label.textContent = headline.label;
        card.appendChild(label);

        const value = document.createElement('span');
        value.className = 'wg-mono-display wg-workouts-exercise-detail__headline-value';
        value.textContent = _fmtUnit(headline.value, headline.unit);
        card.appendChild(value);

        if (headline.low_confidence && headline.confidence_reps) {
            card.appendChild(_confidenceFlag(headline.confidence_reps));
        }

        if (headline.sub_label) {
            const sub = document.createElement('span');
            sub.className = 'wg-workouts-exercise-detail__headline-sub';
            sub.textContent = `${headline.sub_label}: ${_fmtUnit(headline.sub_value, headline.sub_unit)}`;
            card.appendChild(sub);
        }
        return card;
    }

    function _chartFor(series, metric, labelText) {
        const section = document.createElement('div');
        section.className = 'wg-workouts-exercise-detail__chart';

        const label = document.createElement('div');
        label.className = 'wg-section-label wg-workouts-stats__section-label';
        label.textContent = labelText;
        section.appendChild(label);

        const panel = document.createElement('div');
        panel.className = 'wg-workouts-stats__chart-panel';
        const node = window.WGWorkoutChart && typeof window.WGWorkoutChart.render === 'function'
            ? window.WGWorkoutChart.render({ sessions: series, range: 'all', metric })
            : null;
        if (node) {
            panel.appendChild(node);
        } else {
            const empty = document.createElement('div');
            empty.className = 'wg-workout-chart wg-workout-chart--empty';
            const msg = document.createElement('span');
            msg.className = 'wg-workout-chart__empty-msg';
            msg.textContent = 'No data yet';
            empty.appendChild(msg);
            panel.appendChild(empty);
        }
        section.appendChild(panel);
        return section;
    }

    // renderDetail paints the goal headline, records summary and progress graphs
    // into `root`. Pure DOM builder (no fetch) so tests can drive it with
    // hand-built PRs/series. `opts` carries the folded goal presentation:
    //   headline — goalHeadline() output (med-qj4.6.4); absent → the historical
    //              est-1RM/top-weight pair, no headline card.
    //   effort   — effortInsight() output (med-qj4.6.5); absent/null when the
    //              user logs no RPE, in which case nothing about effort renders.
    function renderDetail(root, name, prs, series, opts) {
        root.className = 'wg-workouts-exercise-detail';
        root.replaceChildren();

        const header = document.createElement('div');
        header.className = 'wg-workouts-exercise-detail__header';

        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'wg-gloss wg-workouts-exercise-detail__back';
        back.textContent = '← Stats';
        back.addEventListener('click', () => {
            if (window.WorkoutStats && typeof window.WorkoutStats.load === 'function') {
                window.WorkoutStats.load();
            }
        });
        header.appendChild(back);

        const title = document.createElement('span');
        title.className = 'wg-mono-display wg-workouts-exercise-detail__title';
        title.textContent = name || '';
        header.appendChild(title);
        root.appendChild(header);

        const headline = opts && opts.headline;
        const effort = opts && opts.effort;
        if (headline) root.appendChild(_headlineCard(headline));

        // Near-failure advisory (med-qj4.6.5). Advice, not a verdict: it never
        // gates progression, only appears for a hypertrophy goal with enough
        // rated sets to mean something, and is silent for everyone else.
        if (effort && effort.advise) {
            const advice = document.createElement('p');
            advice.className = 'wg-card wg-workouts-exercise-detail__advice';
            advice.textContent = `Your last ${effort.sets} rated sets sat around ${effort.median_rir} reps in reserve — `
                + 'push closer to failure or add load; the last few reps drive growth.';
            root.appendChild(advice);
        }

        if (prs) {
            const recHeading = document.createElement('div');
            recHeading.className = 'wg-section-label wg-workouts-stats__section-label';
            recHeading.textContent = 'Personal Records';
            root.appendChild(recHeading);

            const list = document.createElement('ul');
            list.className = 'wg-workouts-stats__top-exercises wg-workouts-exercise-detail__records';
            // The est-1RM row carries its own confidence caveat when the best
            // estimate came off a high-rep set — the flag belongs next to the
            // number wherever the number appears, headline or not.
            // `best_est_1rm_low_confidence` is the domain's verdict (the rep
            // threshold lives in workout-analysis.js, never duplicated here).
            const est1rmFlag = prs.best_est_1rm_low_confidence
                ? _confidenceFlag(prs.best_est_1rm_reps)
                : null;
            const rows = [
                ['Heaviest weight', _fmtWeight(prs.heaviest_weight), null],
                ['Best est. 1RM', _fmtWeight(prs.best_est_1rm), est1rmFlag],
                ['Best set volume', prs.best_set_volume > 0 ? `${Math.round(prs.best_set_volume)} kg` : '—', null],
                ['Best session volume', prs.best_session_volume > 0 ? `${Math.round(prs.best_session_volume)} kg` : '—', null],
                ['Most reps', prs.most_reps > 0 ? String(prs.most_reps) : '—', null],
            ];
            // Per-set RIR made visible (med-qj4.6.5) — shown for every goal, so
            // rating effort pays off even where the advisory never fires.
            if (effort) {
                rows.push([`Recent effort · ${effort.sets} rated sets`, `${effort.median_rir} RIR median`, null]);
            }
            rows.forEach(([label, value, flag]) => list.appendChild(_recordRow(label, value, flag)));
            root.appendChild(list);

            // Per-rep-count set-records (heaviest weight lifted for exactly N reps).
            // Computed by exercisePRs but otherwise unsurfaced — list ascending by reps.
            const setRecords = prs.set_records && typeof prs.set_records === 'object' ? prs.set_records : {};
            const repCounts = Object.keys(setRecords)
                .map(Number)
                .filter((n) => n > 0)
                .sort((a, b) => a - b);
            if (repCounts.length) {
                const repHeading = document.createElement('div');
                repHeading.className = 'wg-section-label wg-workouts-stats__section-label';
                repHeading.textContent = 'Rep-max records';
                root.appendChild(repHeading);

                const repList = document.createElement('ul');
                repList.className = 'wg-workouts-stats__top-exercises wg-workouts-exercise-detail__records';
                repCounts.forEach((reps) => {
                    repList.appendChild(_recordRow(`${reps} rep${reps === 1 ? '' : 's'}`, _fmtWeight(setRecords[reps])));
                });
                root.appendChild(repList);
            }
        } else {
            const unavailable = document.createElement('p');
            unavailable.className = 'text-hint wg-workouts-exercise-detail__unavailable';
            unavailable.textContent = 'Analysis unavailable';
            root.appendChild(unavailable);
        }

        // Graph order follows the goal's emphasis — the metric it's chasing
        // first. No headline (analysis module unavailable) → the historical pair.
        const s = Array.isArray(series) ? series : [];
        const charts = (headline && Array.isArray(headline.charts) && headline.charts.length)
            ? headline.charts
            : ['est-1rm', 'top-weight'];
        charts.forEach((metric) => {
            root.appendChild(_chartFor(s, metric, CHART_LABELS[metric] || metric));
        });
    }

    // open fetches the exercise history, folds it, and mounts the detail view
    // into the Stats sub-tab container (replacing the stats list; the back
    // button reloads WorkoutStats).
    async function open(name) {
        const container = document.getElementById('workout-stats-display');
        if (!container) return;

        let logs = [];
        try {
            const res = await apiCall(`/api/workout/exercises/history?name=${encodeURIComponent(name)}&limit=500`);
            if (Array.isArray(res)) logs = res;
        } catch (_) { /* fall through to empty */ }

        const WA = await getAnalysis();
        const prs = WA ? WA.exercisePRs(logs) : null;
        const series = WA ? WA.exerciseSeries(logs) : [];
        // The exercise's effective goal rides on the history response
        // (listExerciseLogsByName); absent → normalizeGoal's hypertrophy default.
        const goal = logs.length ? logs[0].training_goal : null;
        const headline = WA && typeof WA.goalHeadline === 'function' ? WA.goalHeadline(goal, prs, series) : null;
        const effort = WA && typeof WA.effortInsight === 'function' ? WA.effortInsight(logs, goal) : null;

        const root = document.createElement('div');
        renderDetail(root, name, prs, series, { headline, effort });
        container.replaceChildren(root);
    }

    window.WorkoutExerciseDetail = { open, renderDetail, isPRLog, getAnalysis };
})();
