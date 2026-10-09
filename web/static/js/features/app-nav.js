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
//   • The Meds tab badge: missed + overdue doses, i.e. materialized PENDING
//     intakes already due (web/domain/medintake.js, GET /api/history?days=1).
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

    let _state = { current: null, badgeSeq: 0 };

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
        return window.AppStore ? window.AppStore.get('previousTab') : null;
    }

    // Where Back goes from `tab`: a page returns to the tab it was opened from;
    // any other section returns to Today.
    function backTarget(tab) {
        if (!isPage(tab)) return 'today';
        const prev = previousTab();
        return prev && !isPage(prev) && featureOn(prev) ? prev : 'today';
    }

    // Which section the tab bar should highlight while `tab` is showing:
    // pages keep their origin tab lit.
    function navSectionFor(tab) {
        return isPage(tab) ? (previousTab() || null) : tab;
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

    // Missed + overdue: intakes still PENDING whose slot has passed (and are
    // not snoozed into the future). Pure — exported for tests.
    function countDueDoses(rows, nowMs) {
        if (!Array.isArray(rows)) return 0;
        return rows.filter((r) => r && r.status === 'PENDING'
            && Date.parse(r.scheduled_at) <= nowMs
            && !(r.snoozed_until && Date.parse(r.snoozed_until) > nowMs)).length;
    }

    async function refreshMedsBadge() {
        if (!window.WGBottomNav || typeof window.WGBottomNav.setBadge !== 'function') return;
        // No mounted Meds tab (pre-boot, Meds disabled, unit-test DOM): nothing to paint.
        if (!document.querySelector('.wg-tabbar [data-nav-id="meds"]')) return;
        const seq = ++_state.badgeSeq;
        if (!featureOn('meds') || typeof apiCall !== 'function') {
            window.WGBottomNav.setBadge('meds', 0);
            return;
        }
        let rows = null;
        try { rows = await apiCall('/api/history?days=1'); } catch (_) { rows = null; }
        // Offline / failed read keeps the last count; a newer refresh wins.
        if (seq !== _state.badgeSeq || !Array.isArray(rows)) return;
        window.WGBottomNav.setBadge('meds', countDueDoses(rows, Date.now()));
    }

    function onTabSwitch(tab) {
        const prev = _state.current;
        if (isPage(tab) && prev && !isPage(prev) && window.AppStore) {
            window.AppStore.set('previousTab', prev);
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
            switchTab(backTarget(_state.current));
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
        countDueDoses,
        refreshMedsBadge,
    };
})();
