// TZ Transition Plan banner.
//
// Surfaces a pending timezone-change plan that the user has not yet approved
// or rejected. The banner stays hidden when there is no active plan, so users
// who never travel never see it.
//
// Lifecycle: call window.TZPlanBanner.refresh() to query GET
// /api/tz-plan/current. On a non-null plan in PENDING_APPROVAL or NOTIFIED
// state, render the banner with Approve / Reject / Details controls. On null
// plan, ensure the container is hidden. The bootstrap module triggers an
// initial refresh after auth completes.

(function () {
    const CONTAINER_ID = 'tz-plan-banner';
    const ACTIONABLE_STATUSES = new Set(['PENDING_APPROVAL', 'NOTIFIED']);

    function getContainer() {
        return document.getElementById(CONTAINER_ID);
    }

    function hide(container) {
        if (!container) return;
        container.classList.add('hidden');
        container.hidden = true;
        container.replaceChildren();
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

    function render(plan, steps) {
        const container = getContainer();
        if (!container) return;
        if (!plan || !ACTIONABLE_STATUSES.has(plan.status)) {
            hide(container);
            return;
        }

        const medCount = countDistinctMeds(steps);
        const offset = formatOffsetHours(plan.old_tz, plan.new_tz, plan.created_at);

        container.classList.remove('hidden');
        container.hidden = false;
        container.replaceChildren();

        const row = document.createElement('div');
        row.className = 'tz-plan-banner__row';

        const msg = document.createElement('div');
        msg.className = 'tz-plan-banner__msg';

        const title = document.createElement('div');
        title.className = 'tz-plan-banner__msg-title';
        const offsetSuffix = offset ? ` (${offset})` : '';
        title.textContent = `🌍 Timezone change: ${plan.old_tz} → ${plan.new_tz}${offsetSuffix}`;
        msg.appendChild(title);

        const detail = document.createElement('div');
        detail.className = 'tz-plan-banner__msg-detail';
        const stepNote = medCount === 1 ? '1 medication' : `${medCount} medications`;
        const statusNote = plan.status === 'NOTIFIED' ? 'awaiting your decision' : 'pending';
        detail.textContent = `${stepNote} · ${statusNote}`;
        msg.appendChild(detail);

        row.appendChild(msg);

        const actions = document.createElement('div');
        actions.className = 'tz-plan-banner__actions';

        const approveBtn = document.createElement('button');
        approveBtn.type = 'button';
        approveBtn.className = 'tz-plan-banner__btn tz-plan-banner__btn--primary';
        approveBtn.textContent = 'Apply';
        approveBtn.addEventListener('click', () => onAction(plan.id, 'approve', container));
        actions.appendChild(approveBtn);

        const rejectBtn = document.createElement('button');
        rejectBtn.type = 'button';
        rejectBtn.className = 'tz-plan-banner__btn';
        rejectBtn.textContent = 'Cancel';
        rejectBtn.addEventListener('click', () => onAction(plan.id, 'reject', container));
        actions.appendChild(rejectBtn);

        if (Array.isArray(steps) && steps.length > 0) {
            const detailsBtn = document.createElement('button');
            detailsBtn.type = 'button';
            detailsBtn.className = 'tz-plan-banner__btn';
            detailsBtn.textContent = 'Details';
            const detailsBox = renderDetails(steps);
            detailsBox.hidden = true;
            detailsBtn.addEventListener('click', () => {
                detailsBox.hidden = !detailsBox.hidden;
                detailsBtn.setAttribute('aria-expanded', String(!detailsBox.hidden));
            });
            actions.appendChild(detailsBtn);
            container.appendChild(row);
            container.appendChild(detailsBox);
        } else {
            container.appendChild(row);
        }
    }

    function renderDetails(steps) {
        const wrap = document.createElement('div');
        wrap.className = 'tz-plan-banner__details';
        const intro = document.createElement('div');
        intro.textContent = `${steps.length} transition dose${steps.length === 1 ? '' : 's'} planned:`;
        wrap.appendChild(intro);
        const ul = document.createElement('ul');
        ul.className = 'tz-plan-banner__details-list';
        for (const s of steps) {
            const li = document.createElement('li');
            li.textContent = s.note || `step ${s.step_number} at ${s.scheduled_at}`;
            ul.appendChild(li);
        }
        wrap.appendChild(ul);
        return wrap;
    }

    function countDistinctMeds(steps) {
        if (!Array.isArray(steps)) return 0;
        const seen = new Set();
        for (const s of steps) {
            if (s && (s.medication_id || s.medication_id === 0)) seen.add(s.medication_id);
        }
        return seen.size;
    }

    async function onAction(planId, action, container) {
        const buttons = container.querySelectorAll('button.tz-plan-banner__btn');
        buttons.forEach((b) => { b.disabled = true; });
        try {
            if (typeof window.apiCall !== 'function') {
                throw new Error('apiCall unavailable');
            }
            await window.apiCall(`/api/tz-plan/${encodeURIComponent(planId)}/${action}`, 'POST');
            // Hide regardless of which path the user took — both transitions
            // (APPROVED / REJECTED) make the plan no longer actionable.
            hide(container);
        } catch (e) {
            console.error('tz_plan banner action failed', e);
            buttons.forEach((b) => { b.disabled = false; });
        }
    }

    async function refresh() {
        const container = getContainer();
        if (!container) return;
        try {
            if (typeof window.apiCall !== 'function') return;
            const result = await window.apiCall('/api/tz-plan/current', 'GET');
            if (!result || typeof result !== 'object') {
                hide(container);
                return;
            }
            render(result.plan || null, Array.isArray(result.steps) ? result.steps : []);
        } catch (e) {
            // Silent failure: a missing endpoint or transient error must not
            // surface as an error banner — hide and move on.
            console.warn('tz_plan banner refresh failed', e);
            hide(container);
        }
    }

    window.TZPlanBanner = { refresh };
})();
