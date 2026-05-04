// TZ Transition Plan card.
//
// Surfaces a pending timezone-change plan that the user has not yet approved
// or rejected as a Wandergeek card on the Today screen, sitting directly
// above the medications card. Stays absent from the DOM entirely when no
// plan is in flight, so users who never travel never see it.
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
// the cached plan, and reload the current tab so the card unmounts itself.

(function () {
    const ACTIONABLE_STATUSES = new Set(['PENDING_APPROVAL', 'NOTIFIED']);

    let cached = { plan: null, steps: [] };

    function actionable(plan) {
        return !!(plan && ACTIONABLE_STATUSES.has(plan.status));
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

    function buildCard(plan, steps) {
        const d = document;
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
        kicker.textContent = 'Timezone change pending';
        text.appendChild(kicker);

        const value = d.createElement('span');
        value.className = 'wg-next-action-card__value wg-tz-plan-card__value';
        const offset = formatOffsetHours(plan.old_tz, plan.new_tz, plan.created_at);
        const offsetSuffix = offset ? `  ·  ${offset}` : '';
        value.textContent = `${plan.old_tz} → ${plan.new_tz}${offsetSuffix}`;
        text.appendChild(value);

        const medCount = countDistinctMeds(steps);
        if (medCount > 0) {
            const detail = d.createElement('span');
            detail.className = 'wg-tz-plan-card__detail';
            const noun = medCount === 1 ? 'medication' : 'medications';
            detail.textContent = `${medCount} ${noun} will shift`;
            text.appendChild(detail);
        }
        head.appendChild(text);

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
        card.appendChild(head);

        if (Array.isArray(steps) && steps.length > 0) {
            const detailsWrap = d.createElement('details');
            detailsWrap.className = 'wg-tz-plan-card__details';

            const summary = d.createElement('summary');
            summary.className = 'wg-tz-plan-card__details-summary';
            const stepNoun = steps.length === 1 ? 'transition dose' : 'transition doses';
            summary.textContent = `${steps.length} ${stepNoun} planned`;
            detailsWrap.appendChild(summary);

            const ul = d.createElement('ul');
            ul.className = 'wg-tz-plan-card__details-list';
            for (const s of steps) {
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
            cached = { plan: null, steps: [] };
            reloadTab();
        } catch (e) {
            console.error('tz_plan card action failed', e);
            buttons.forEach((b) => { b.disabled = false; });
        }
    }

    function mountCard(root) {
        if (!root) return null;
        if (!actionable(cached.plan)) return null;
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
            const wasActionable = actionable(cached.plan);
            const isActionable = actionable(plan);
            cached = { plan: isActionable ? plan : null, steps: isActionable ? steps : [] };
            if (wasActionable !== isActionable
                || (isActionable && plan && cached.plan && plan.id !== cached.plan.id)) {
                reloadTab();
            }
        } catch (e) {
            // Silent failure: a missing endpoint or transient error must not
            // surface as an error — drop any cached plan and move on.
            console.warn('tz_plan card refresh failed', e);
            if (actionable(cached.plan)) {
                cached = { plan: null, steps: [] };
                reloadTab();
            }
        }
    }

    window.TZPlanBanner = { refresh, mountCard };
})();
