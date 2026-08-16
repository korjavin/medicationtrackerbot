// TZ Transition Plan card.
//
// Surfaces an in-flight timezone-change plan as a Wandergeek card on the Today
// screen, sitting directly above the medications card. Stays absent from the
// DOM entirely when no plan is in flight, so users who never travel never see
// it. Two modes, one card builder:
//
//   PENDING_APPROVAL / NOTIFIED — actionable: Apply / Cancel buttons.
//   APPROVED                    — read-only "Transition in progress": how many
//                                 steps are done, the next shifted dose, and
//                                 the remaining steps. The plan is silently
//                                 driving dose times at this point, so hiding
//                                 it is what made the app feel out of control
//                                 right after Apply (bd med-gut.3).
//
// COMPLETED / REJECTED render nothing — web/domain/tzplan.js's
// refreshPlanStatus flips APPROVED → COMPLETED once every step is past, and
// the next refresh() drops the card.
//
// Lifecycle:
//   refresh()           — fetches GET /api/tz-plan/current, updates cache,
//                         and triggers a Today reload so the card appears
//                         (or disappears) without a manual refresh.
//   mountCard(root)     — synchronously appends the card from cached state.
//                         Today's renderer calls this once per render, before
//                         the meds card.
//
// Apply / Cancel actions hit the existing approve / reject endpoints, clear
// the cached plan, and reload the current tab so the card re-renders itself.

(function () {
    const ACTIONABLE_STATUSES = new Set(['PENDING_APPROVAL', 'NOTIFIED']);

    let cached = { plan: null, steps: [] };

    function actionable(plan) {
        return !!(plan && ACTIONABLE_STATUSES.has(plan.status));
    }

    // An approved plan is read-only but still worth showing: its steps are
    // actively overriding dose times until the status flips to COMPLETED.
    function inProgress(plan) {
        return !!(plan && plan.status === 'APPROVED');
    }

    function renderable(plan) {
        return actionable(plan) || inProgress(plan);
    }

    // Identity of what is on screen, so a refresh that changes it repaints
    // Today: the plan id and status (an approve done on another device leaves
    // both states renderable), plus — for an in-progress plan, whose card is
    // step-derived — how many steps are left, which is what "K of N done", the
    // next-dose line, and mountCard's done-check all read.
    function renderKey(plan, steps) {
        if (!renderable(plan)) return '';
        const base = `${plan.id}:${plan.status}`;
        return inProgress(plan) ? `${base}:${remainingSteps(steps).length}` : base;
    }

    function stepTimeMs(step) {
        const t = Date.parse(step && step.scheduled_at);
        return Number.isNaN(t) ? null : t;
    }

    // Steps still ahead of the user, in chronological order — so remaining[0]
    // really is the next shifted dose. The Go path
    // (internal/domain/tzreschedule/engine.go) appends steps per medication and
    // never sorts across meds, so a multi-med plan arrives grouped, not
    // time-ordered. A step with an unparseable time counts as remaining rather
    // than silently vanishing, and sorts last.
    function remainingSteps(steps) {
        const nowMs = Date.now();
        return (Array.isArray(steps) ? steps : [])
            .filter((s) => {
                const t = stepTimeMs(s);
                return t === null || t > nowMs;
            })
            .sort((a, b) => (stepTimeMs(a) ?? Infinity) - (stepTimeMs(b) ?? Infinity));
    }

    function formatStepTime(ms, tz) {
        const opts = {
            hourCycle: 'h23', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric'
        };
        try {
            return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz }).format(new Date(ms));
        } catch (_) {
            // Unknown/absent zone — fall back to the device zone rather than
            // dropping the line entirely.
            return new Intl.DateTimeFormat('en-US', opts).format(new Date(ms));
        }
    }

    function reloadTab() {
        try {
            if (typeof window.reloadCurrentTab === 'function') {
                window.reloadCurrentTab();
            }
        } catch (e) {
            console.warn('tz_plan: reloadCurrentTab failed', e);
        }
    }

    function formatOffsetHours(oldTZ, newTZ, refIso) {
        try {
            const ref = refIso ? new Date(refIso) : new Date();
            if (Number.isNaN(ref.getTime())) return '';
            const offsetFor = (tz) => {
                const fmt = new Intl.DateTimeFormat('en-US', {
                    timeZone: tz,
                    timeZoneName: 'shortOffset'
                });
                const parts = fmt.formatToParts(ref);
                const tzn = parts.find((p) => p.type === 'timeZoneName');
                if (!tzn) return null;
                const m = tzn.value.match(/GMT([+-])(\d+)(?::(\d+))?/);
                if (!m) return 0;
                const sign = m[1] === '-' ? -1 : 1;
                const h = parseInt(m[2], 10) || 0;
                const min = parseInt(m[3] || '0', 10) || 0;
                return sign * (h * 60 + min);
            };
            const oldOff = offsetFor(oldTZ);
            const newOff = offsetFor(newTZ);
            if (oldOff == null || newOff == null) return '';
            const deltaMin = newOff - oldOff;
            if (deltaMin === 0) return '';
            const sign = deltaMin > 0 ? '+' : '−';
            const absMin = Math.abs(deltaMin);
            const h = Math.floor(absMin / 60);
            const m = absMin % 60;
            return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
        } catch (_) {
            return '';
        }
    }

    function countDistinctMeds(steps) {
        if (!Array.isArray(steps)) return 0;
        const seen = new Set();
        for (const s of steps) {
            if (s && (s.medication_id || s.medication_id === 0)) seen.add(s.medication_id);
        }
        return seen.size;
    }

    function addDetailLine(text, parent) {
        const detail = document.createElement('span');
        detail.className = 'wg-tz-plan-card__detail';
        detail.textContent = text;
        parent.appendChild(detail);
        return detail;
    }

    function buildCard(plan, steps) {
        const d = document;
        const isPending = actionable(plan);
        const allSteps = Array.isArray(steps) ? steps : [];
        const remaining = isPending ? allSteps : remainingSteps(allSteps);

        const card = d.createElement('div');
        // Reuse the same visual contract as the meds card. The --plain
        // modifier drops the sun-yellow header so we can compose with the
        // dedicated tz-plan section and not steal medication emphasis.
        card.className = 'wg-next-action-card wg-next-action-card--plain wg-tz-plan-card';
        card.setAttribute('data-section', 'tz-plan');

        const head = d.createElement('div');
        head.className = 'wg-tz-plan-card__head';

        const iconWrap = d.createElement('span');
        iconWrap.className = 'wg-next-action-card__icon wg-tz-plan-card__icon';
        iconWrap.textContent = '🌍';
        head.appendChild(iconWrap);

        const text = d.createElement('span');
        text.className = 'wg-next-action-card__text';

        const kicker = d.createElement('span');
        kicker.className = 'wg-next-action-card__kicker';
        kicker.textContent = isPending ? 'Timezone change pending' : 'Transition in progress';
        text.appendChild(kicker);

        const value = d.createElement('span');
        value.className = 'wg-next-action-card__value wg-tz-plan-card__value';
        const offset = formatOffsetHours(plan.old_tz, plan.new_tz, plan.created_at);
        const offsetSuffix = offset ? `  ·  ${offset}` : '';
        value.textContent = `${plan.old_tz} → ${plan.new_tz}${offsetSuffix}`;
        text.appendChild(value);

        if (isPending) {
            const medCount = countDistinctMeds(allSteps);
            if (medCount > 0) {
                const noun = medCount === 1 ? 'medication' : 'medications';
                addDetailLine(`${medCount} ${noun} will shift`, text);
            }
        } else {
            const done = allSteps.length - remaining.length;
            addDetailLine(`${done} of ${allSteps.length} steps done`, text);

            const next = remaining[0];
            const nextMs = next ? stepTimeMs(next) : null;
            if (nextMs !== null) {
                // med_name is cloud-only (web/domain/tzplan.js); the Go wire
                // shape omits it, so the time stands alone there.
                const medName = next.med_name ? `  ·  ${next.med_name}` : '';
                addDetailLine(`Next shifted dose: ${formatStepTime(nextMs, plan.new_tz)}${medName}`, text);
            }
        }
        head.appendChild(text);

        if (isPending) {
            const actions = d.createElement('div');
            actions.className = 'wg-tz-plan-card__actions';

            const applyBtn = d.createElement('button');
            applyBtn.type = 'button';
            applyBtn.className = 'wg-toolbar-btn wg-toolbar-btn--primary wg-tz-plan-card__btn';
            applyBtn.textContent = 'Apply';
            applyBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                onAction(plan.id, 'approve', card);
            });
            actions.appendChild(applyBtn);

            const cancelBtn = d.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'wg-toolbar-btn wg-tz-plan-card__btn';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                onAction(plan.id, 'reject', card);
            });
            actions.appendChild(cancelBtn);

            head.appendChild(actions);
        }
        card.appendChild(head);

        if (remaining.length > 0) {
            const detailsWrap = d.createElement('details');
            detailsWrap.className = 'wg-tz-plan-card__details';

            const summary = d.createElement('summary');
            summary.className = 'wg-tz-plan-card__details-summary';
            const stepNoun = remaining.length === 1 ? 'transition dose' : 'transition doses';
            summary.textContent = isPending
                ? `${remaining.length} ${stepNoun} planned`
                : `${remaining.length} ${stepNoun} left`;
            detailsWrap.appendChild(summary);

            const ul = d.createElement('ul');
            ul.className = 'wg-tz-plan-card__details-list';
            for (const s of remaining) {
                const li = d.createElement('li');
                li.textContent = s.note || `step ${s.step_number} at ${s.scheduled_at}`;
                ul.appendChild(li);
            }
            detailsWrap.appendChild(ul);
            card.appendChild(detailsWrap);
        }

        return card;
    }

    async function onAction(planId, action, cardEl) {
        const buttons = cardEl.querySelectorAll('button');
        buttons.forEach((b) => { b.disabled = true; });
        try {
            if (typeof window.apiCall !== 'function') {
                throw new Error('apiCall unavailable');
            }
            await window.apiCall(`/api/tz-plan/${encodeURIComponent(planId)}/${action}`, 'POST');
            // Re-read rather than blanking the cache: approve lands on the
            // read-only "Transition in progress" card, reject drops the card
            // entirely, and either way the plan's render key changed, so
            // refresh() repaints Today exactly once. refresh() swallows its own
            // errors (it drops the cached plan and reloads), so a failed re-read
            // after a successful POST can never land in the catch below and
            // re-enable buttons for a plan that already moved on.
            await refresh();
        } catch (e) {
            console.error('tz_plan card action failed', e);
            buttons.forEach((b) => { b.disabled = false; });
        }
    }

    function mountCard(root) {
        if (!root) return null;
        if (!renderable(cached.plan)) return null;
        // An approved plan whose last step is past is finished in everything but
        // name — the shim's materialization sweep flips it to COMPLETED on its
        // own clock, and nothing tells this module when that happens. Dropping
        // it here means a tab left open through the final dose stops showing an
        // in-progress card with nothing left in it, without waiting for a page
        // reload to re-read the status.
        if (inProgress(cached.plan) && remainingSteps(cached.steps).length === 0) return null;
        const card = buildCard(cached.plan, cached.steps);
        root.appendChild(card);
        return card;
    }

    async function refresh() {
        try {
            if (typeof window.apiCall !== 'function') return;
            const result = await window.apiCall('/api/tz-plan/current', 'GET');
            const plan = (result && typeof result === 'object') ? (result.plan || null) : null;
            const steps = (result && Array.isArray(result.steps)) ? result.steps : [];
            const prevKey = renderKey(cached.plan, cached.steps);
            const show = renderable(plan);
            cached = { plan: show ? plan : null, steps: show ? steps : [] };
            if (prevKey !== renderKey(cached.plan, cached.steps)) {
                reloadTab();
            }
        } catch (e) {
            // Silent failure: a missing endpoint or transient error must not
            // surface as an error — drop any cached plan and move on.
            console.warn('tz_plan card refresh failed', e);
            if (renderable(cached.plan)) {
                cached = { plan: null, steps: [] };
                reloadTab();
            }
        }
    }

    window.TZPlanBanner = { refresh, mountCard };
})();
