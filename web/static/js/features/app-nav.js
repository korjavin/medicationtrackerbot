// App navigation chrome (Navigation v2, bd med-xso6.12). Spec:
// docs/design/claude-design/ui_kits/app-v2/navigation.html (N2/N3).
//
// The tab bar itself is components/wg-bottom-nav.js, mounted by
// features/bootstrap.js. This module owns everything around it that maps
// stable section ids (today, food, meds, workouts, bp, weight, health,
// journey, settings — CLAUDE.md rule 6) onto the five tabs:
//   • Health tab → bp / weight / health(Vitals) sections behind a shared
//     .wg-seg strip; the last segment is remembered in mt-health-segment on
//     EVERY switch to one of the three (deep links included).
//   • App-bar actions: [data-nav-to] (gear → settings, route → journey),
//     [data-nav-back] (pagebar Back), [data-health-seg] (segment strip).
//   • Settings / Journey are pages: AppStore 'previousTab' records the tab
//     they were opened from, and Back returns there (back-button.js).
//   • The Meds tab badge + the Meds app-bar sub ("N active · N pending",
//     kit TL1): the pending set — every due or snoozed dose of any day, the
//     same read the timeline's focus card + "+N more pending" count
//     (features/meds.js readPendingDoses, bd med-ry7b.4).
//
// Hooked into AppKernel.onTabSwitch (fired by app.js switchTab).

window.AppNav = (function () {
    const HEALTH_SECTIONS = Object.freeze(['bp', 'weight', 'health']);
    const PAGE_SECTIONS = Object.freeze(['settings', 'journey']);
    const HEALTH_SEGMENT_KEY = 'mt-health-segment';
    const SECTION_FEATURE = Object.freeze({
        food: 'food', meds: 'medication', workouts: 'workout',
        bp: 'bp', weight: 'weight', health: 'health', journey: 'gamification',
    });
    const SEGMENT_LABEL = Object.freeze({ bp: 'BP', weight: 'Weight', health: 'Vitals' });

    // Origin tab of a Settings / Journey page, persisted so a restored page
    // (bootstrap restores a recent mt-active-tab) still lights it and Back
    // still returns there after a reload.
    const PAGE_ORIGIN_KEY = 'mt-page-origin';
    const BADGE_RECHECK_MAX_MS = 15 * 60 * 1000;

    let _state = { current: null, badgeSeq: 0, badgeTimer: null, pending: null };

    // Same predicate bootstrap's nav filter uses: a section with no feature
    // flag is always on; a flag map that hasn't loaded yet counts as on.
    function featureOn(section) {
        const flag = SECTION_FEATURE[section];
        const flags = window.featureSettings;
        return !flag || !flags || !!flags[flag];
    }

    function enabledHealthSections() {
        return HEALTH_SECTIONS.filter(featureOn);
    }

    // The section the Health tab opens: the remembered segment if it is still
    // enabled, else the first enabled one, else null (all three off).
    function healthSegmentTarget() {
        let saved = null;
        try { saved = window.localStorage.getItem(HEALTH_SEGMENT_KEY); } catch (_) { /* storage blocked */ }
        if (HEALTH_SECTIONS.indexOf(saved) !== -1 && featureOn(saved)) return saved;
        return enabledHealthSections()[0] || null;
    }

    // Tab id → section to switchTab into.
    function resolveNavTarget(navId) {
        if (navId === 'health-group') return healthSegmentTarget() || 'today';
        return navId;
    }

    function isPage(tab) {
        return PAGE_SECTIONS.indexOf(tab) !== -1;
    }

    function previousTab() {
        const inSession = window.AppStore ? window.AppStore.get('previousTab') : null;
        if (inSession) return inSession;
        try { return window.localStorage.getItem(PAGE_ORIGIN_KEY); } catch (_) { return null; }
    }

    // Where Back goes from `tab` when AppBack has no in-session trail (a
    // restored or deep-linked section): a page returns to the tab it was opened
    // from; any other section returns to Today.
    function backTarget(tab) {
        if (!isPage(tab)) return 'today';
        const prev = previousTab();
        return prev && !isPage(prev) && featureOn(prev) ? prev : 'today';
    }

    // Which section the tab bar should highlight while `tab` is showing:
    // pages are not tabs, so none is lit (bd med-av5l); Back still returns to
    // the origin tab via previousTab().
    function navSectionFor(tab) {
        return isPage(tab) ? null : tab;
    }

    function rangeLabel(section) {
        let raw = null;
        if (section === 'bp' && typeof getActiveBPRange === 'function') raw = `${getActiveBPRange()}d`;
        else if (section === 'weight' && typeof getActiveWeightRange === 'function') raw = getActiveWeightRange();
        else if (section === 'health' && typeof getActiveHealthRange === 'function') raw = getActiveHealthRange();
        if (!raw) return '';
        if (raw === 'all') return 'All time';
        const days = parseInt(raw, 10);
        return Number.isFinite(days) ? `${days} days` : '';
    }

    function todaySubtitle(now) {
        return now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit' })
            .replace(',', ' ·').replace('/', '.');
    }

    // Repaint the chrome that depends on the active section + feature flags.
    function syncChrome(tab) {
        const active = tab || _state.current;
        const enabled = enabledHealthSections();
        document.querySelectorAll('.wg-health-seg').forEach((strip) => {
            strip.hidden = enabled.length <= 1;
            strip.querySelectorAll('[data-health-seg]').forEach((opt) => {
                const seg = opt.dataset.healthSeg;
                opt.hidden = enabled.indexOf(seg) === -1;
                opt.setAttribute('aria-pressed', seg === active ? 'true' : 'false');
            });
        });
        document.querySelectorAll('[data-health-sub]').forEach((sub) => {
            const seg = sub.dataset.healthSub;
            const range = rangeLabel(seg);
            sub.textContent = range ? `${SEGMENT_LABEL[seg]} · ${range}` : SEGMENT_LABEL[seg];
        });
        document.querySelectorAll('[data-today-sub]').forEach((sub) => {
            sub.textContent = todaySubtitle(new Date());
        });
        document.querySelectorAll('[data-nav-to="journey"]').forEach((btn) => {
            btn.hidden = !featureOn('journey');
        });
    }

    // Pending: the occurrence projection's due + snoozed rows (GET /api/doses,
    // web/domain/medintake.js projectOccurrences) — the projection owns the
    // rule, this only counts. Pure — exported for tests.
    function countPendingDoses(rows) {
        if (!Array.isArray(rows)) return 0;
        return rows.filter((r) => r && (r.state === 'due' || r.state === 'snoozed')).length;
    }

    // "5 active · 2 pending" / "5 active · all taken" (kit TL1 / TL3), from
    // the last pending count; empty with no active medication (MT5 · empty
    // owns the screen). meds.js repaints it after each render (the med list
    // may land after the count).
    function syncMedsSub() {
        const meds = Array.isArray(window.medications) ? window.medications : [];
        const active = meds.filter((m) => m && !m.archived).length;
        const pending = _state.pending;
        let text = active ? `${active} active` : '';
        if (active && pending !== null) text += pending ? ` · ${pending} pending` : ' · all taken';
        document.querySelectorAll('[data-meds-sub]').forEach((sub) => {
            sub.textContent = text;
            sub.hidden = !text;
        });
    }

    async function refreshMedsBadge() {
        const canBadge = !!(window.WGBottomNav && typeof window.WGBottomNav.setBadge === 'function'
            && document.querySelector('.wg-tabbar [data-nav-id="meds"]'));
        // No mounted Meds tab or sub (pre-boot, unit-test DOM): nothing to paint.
        if (!canBadge && !document.querySelector('[data-meds-sub]')) return;
        const seq = ++_state.badgeSeq;
        if (!featureOn('meds') || typeof readPendingDoses !== 'function') {
            if (canBadge) window.WGBottomNav.setBadge('meds', 0);
            return;
        }
        const nowMs = Date.now();
        const rows = await readPendingDoses(nowMs).catch(() => null);
        // Offline / failed read keeps the last count; a newer refresh wins.
        if (seq !== _state.badgeSeq || !Array.isArray(rows)) return;
        _state.pending = countPendingDoses(rows);
        if (canBadge) window.WGBottomNav.setBadge('meds', _state.pending);
        syncMedsSub();
        scheduleBadgeRecheck(rows, nowMs);
    }

    // Doses come due (and snoozes lapse) with no data event: re-count at the
    // next snooze deadline, or every 15 min while visible to catch doses
    // coming due.
    function scheduleBadgeRecheck(rows, nowMs) {
        clearTimeout(_state.badgeTimer);
        _state.badgeTimer = null;
        if (document.hidden) return; // visibilitychange re-counts on return
        let next = nowMs + BADGE_RECHECK_MAX_MS;
        for (const r of rows) {
            if (!r || r.state !== 'snoozed') continue;
            const at = Date.parse(r.snoozedUntil);
            if (at > nowMs && at < next) next = at;
        }
        _state.badgeTimer = setTimeout(refreshMedsBadge, next - nowMs + 1000);
    }

    function onTabSwitch(tab) {
        const prev = _state.current;
        if (isPage(tab) && prev && !isPage(prev) && window.AppStore) {
            window.AppStore.set('previousTab', prev);
            try { window.localStorage.setItem(PAGE_ORIGIN_KEY, prev); } catch (_) { /* storage blocked */ }
        }
        _state.current = tab;
        if (HEALTH_SECTIONS.indexOf(tab) !== -1) {
            try { window.localStorage.setItem(HEALTH_SEGMENT_KEY, tab); } catch (_) { /* storage blocked */ }
        }
        syncChrome(tab);
        refreshMedsBadge();
    }

    function onClick(event) {
        const target = event.target && event.target.closest
            ? event.target.closest('[data-nav-to],[data-nav-back],[data-health-seg]')
            : null;
        if (!target || typeof switchTab !== 'function') return;
        if (target.hasAttribute('data-nav-back')) {
            // The page bar's Back is Back (features/app-back.js, bd med-y7b4.3).
            if (window.AppBack) window.AppBack.step();
            else switchTab(backTarget(_state.current));
        } else if (target.dataset.navTo) {
            switchTab(target.dataset.navTo);
        } else if (target.dataset.healthSeg) {
            switchTab(target.dataset.healthSeg);
        }
    }

    document.addEventListener('click', onClick);
    window.addEventListener('datastore:changed', (event) => {
        const tags = (event && event.detail && event.detail.changedTags) || [];
        if (tags.length === 0 || tags.indexOf('history') !== -1 || tags.indexOf('medications') !== -1) {
            refreshMedsBadge();
        }
    });
    // Doses come due as the clock moves, with no data event; re-count on return.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshMedsBadge();
    });
    if (window.AppKernel && typeof window.AppKernel.register === 'function') {
        window.AppKernel.register('appNav', { onTabSwitch });
    }

    return {
        HEALTH_SECTIONS,
        PAGE_SECTIONS,
        healthSegmentTarget,
        resolveNavTarget,
        backTarget,
        navSectionFor,
        syncChrome,
        countPendingDoses,
        syncMedsSub,
        refreshMedsBadge,
    };
})();
