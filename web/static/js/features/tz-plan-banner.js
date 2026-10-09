// TZ Transition Plan card.
//
// Surfaces an in-flight timezone-change plan as the kit T2 time-zone card on
// the Today screen, below the sleep/steps tiles. Stays absent from the
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
//                         Today's renderer calls this once per render.
//
// Apply / Cancel actions hit the existing approve / reject endpoints, clear
// the cached plan, and reload the current tab so the card re-renders itself.

(function () {
    const ACTIONABLE_STATUSES = new Set(['PENDING_APPROVAL', 'NOTIFIED']);

    let cached = { plan: null, steps: [] };
    // renderKey of the card actually on screen. Recomputing the old key at
    // refresh time would use the new clock, so a card that went stale purely
    // because a step fell into the past would compare equal to itself and never
    // repaint. mountCard is the only thing that paints, so it owns this.
    let mountedKey = '';

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

    // Identity of the card mountCard would paint right now, '' for no card.
    // The in-progress card is step-derived, so its key carries the remaining
    // count: "K of N done", the next-dose line and the remaining list all move
    // when a step falls into the past, with no change to the payload. A plan
    // with nothing left keys to '' because it is finished in everything but
    // name — the shim's materialization sweep flips it to COMPLETED on its own
    // clock and nothing tells this module when, so a tab left open through the
    // final dose must not keep showing an empty in-progress card.
    function renderKey(plan, steps) {
        if (!renderable(plan)) return '';
        const base = `${plan.id}:${plan.status}`;
        if (!inProgress(plan)) return base;
        const left = remainingSteps(steps).length;
        return left === 0 ? '' : `${base}:${left}`;
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

    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function actionButton(label, cls, onClick) {
        const b = el('button', `wg-btn wg-btn--sm ${cls}`, label);
        b.type = 'button';
        b.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick();
        });
        return b;
    }

    // Kit T2 time-zone card: .wg-card with a globe lead, "old → new · offset",
    // detail hints, a .wg-steps progress strip (approved plans) over the
    // remaining-steps list, and Cancel (ghost) / Apply (primary) in the foot
    // while the plan awaits a decision.
    function buildCard(plan, steps) {
        const isPending = actionable(plan);
        const allSteps = Array.isArray(steps) ? steps : [];
        const remaining = isPending ? allSteps : remainingSteps(allSteps);

        const card = el('div', 'wg-card wg-tz-plan-card');
        card.setAttribute('data-section', 'tz-plan');

        const head = el('div', 'wg-card__head');
        const hstack = el('span', 'wg-hstack');
        const lead = el('span', 'wg-row__lead wg-row__lead--sky');
        const globe = el('i', 'wg-ico');
        globe.setAttribute('aria-hidden', 'true');
        globe.appendChild(window.WGIcons.iconSvg('globe'));
        lead.appendChild(globe);
        hstack.appendChild(lead);
        const titles = el('span', 'wg-vstack');
        titles.appendChild(el('span', 'wg-card__title wg-tz-plan-card__title',
            isPending ? 'Timezone change pending' : 'Transition in progress'));
        const offset = formatOffsetHours(plan.old_tz, plan.new_tz, plan.created_at);
        titles.appendChild(el('span', 'wg-meta wg-tz-plan-card__value',
            `${plan.old_tz} → ${plan.new_tz}${offset ? ` · ${offset}` : ''}`));
        hstack.appendChild(titles);
        head.appendChild(hstack);
        card.appendChild(head);

        const detail = (text) => card.appendChild(el('p', 'wg-hint wg-tz-plan-card__detail', text));
        if (isPending) {
            const medCount = countDistinctMeds(allSteps);
            if (medCount > 0) {
                detail(`${medCount} ${medCount === 1 ? 'medication' : 'medications'} will shift`);
            }
        } else {
            const done = allSteps.length - remaining.length;
            detail(`${done} of ${allSteps.length} steps done`);

            const next = remaining[0];
            const nextMs = next ? stepTimeMs(next) : null;
            if (nextMs !== null) {
                // med_name is cloud-only (web/domain/tzplan.js); the Go wire
                // shape omits it, so the time stands alone there.
                const medName = next.med_name ? ` · ${next.med_name}` : '';
                detail(`Next shifted dose: ${formatStepTime(nextMs, plan.new_tz)}${medName}`);
            }

            const strip = el('div', 'wg-steps');
            strip.setAttribute('aria-hidden', 'true');
            allSteps.forEach((_, i) => {
                strip.appendChild(el('i', i < done ? 'is-done' : (i === done ? 'is-now' : '')));
            });
            card.appendChild(strip);
        }

        if (remaining.length > 0) {
            const stepNoun = remaining.length === 1 ? 'transition dose' : 'transition doses';
            card.appendChild(el('span', 'wg-eyebrow wg-tz-plan-card__steps-title', isPending
                ? `${remaining.length} ${stepNoun} planned`
                : `${remaining.length} ${stepNoun} left`));
            const ul = el('ul', 'wg-tz-plan-card__steps');
            for (const s of remaining) {
                ul.appendChild(el('li', '', s.note || `step ${s.step_number} at ${s.scheduled_at}`));
            }
            card.appendChild(ul);
        }

        if (isPending) {
            const foot = el('div', 'wg-card__foot');
            foot.appendChild(actionButton('Cancel', 'wg-btn--ghost', () => onAction(plan.id, 'reject', card)));
            foot.appendChild(actionButton('Apply', 'wg-btn--primary', () => onAction(plan.id, 'approve', card)));
            card.appendChild(foot);
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
        mountedKey = renderKey(cached.plan, cached.steps);
        if (!mountedKey) return null;
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
            const show = renderable(plan);
            cached = { plan: show ? plan : null, steps: show ? steps : [] };
            if (mountedKey !== renderKey(cached.plan, cached.steps)) {
                reloadTab();
            }
        } catch (e) {
            // Silent failure: a missing endpoint or transient error must not
            // surface as an error — drop any cached plan and move on.
            console.warn('tz_plan card refresh failed', e);
            cached = { plan: null, steps: [] };
            if (mountedKey) reloadTab();
        }
    }

    window.TZPlanBanner = { refresh, mountCard };
})();
