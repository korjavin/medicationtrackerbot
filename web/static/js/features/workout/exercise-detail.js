// ====================================
// WORKOUT EXERCISE DETAIL — per-exercise records + progress graphs
// ====================================
//
// Phase 3 (epic med-qj4) read-side surface. Fetches one exercise's completed
// history (`GET /api/workout/exercises/history?name=`) and folds it through the
// pure web/domain/workout-analysis.js module (est-1RM / PRs / series) to render
// a records summary plus est-1RM + top-weight progress graphs. Also owns the
// shared analysis-module resolver + isPRLog record test consumed by the session
// log-card PR badge (sessions.js).
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
    // and returns true when any record — heaviest weight, best est-1RM, best set
    // volume, best session volume, most reps, or a per-rep-count set-record —
    // beats the prior baseline.
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

    function _recordRow(label, valueText) {
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
        return row;
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

    // renderDetail paints the records summary + progress graphs into `root`.
    // Pure DOM builder (no fetch) so tests can drive it with hand-built PRs/series.
    function renderDetail(root, name, prs, series) {
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

        if (prs) {
            const recHeading = document.createElement('div');
            recHeading.className = 'wg-section-label wg-workouts-stats__section-label';
            recHeading.textContent = 'Personal Records';
            root.appendChild(recHeading);

            const list = document.createElement('ul');
            list.className = 'wg-workouts-stats__top-exercises wg-workouts-exercise-detail__records';
            const rows = [
                ['Heaviest weight', _fmtWeight(prs.heaviest_weight)],
                ['Best est. 1RM', _fmtWeight(prs.best_est_1rm)],
                ['Best set volume', prs.best_set_volume > 0 ? `${Math.round(prs.best_set_volume)} kg` : '—'],
                ['Best session volume', prs.best_session_volume > 0 ? `${Math.round(prs.best_session_volume)} kg` : '—'],
                ['Most reps', prs.most_reps > 0 ? String(prs.most_reps) : '—'],
            ];
            rows.forEach(([label, value]) => list.appendChild(_recordRow(label, value)));
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

        const s = Array.isArray(series) ? series : [];
        root.appendChild(_chartFor(s, 'est-1rm', 'Estimated 1RM · over time'));
        root.appendChild(_chartFor(s, 'top-weight', 'Top weight · over time'));
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

        const root = document.createElement('div');
        renderDetail(root, name, prs, series);
        container.replaceChildren(root);
    }

    window.WorkoutExerciseDetail = { open, renderDetail, isPRLog, getAnalysis };
})();
