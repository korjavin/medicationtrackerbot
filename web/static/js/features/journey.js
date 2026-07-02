// Gamification "Journey" feature module (Plan 3 of 3 — frontend, Task 2).
//
// Closure-scoped module exposing window.Gamification — a loader (load) that
// reads GET /api/gamification/journey through cachedFetch (local-first +
// freshness chip) and a pure-ish render(journey) that paints #journey-content
// from the Plan 2 Journey read model:
//   { enabled, level, lifetime_hp, hp_into_level, level_span_hp, hp_to_next_level,
//     current_streak, longest_streak, freezes, today_hp, today_rings:[{ring,hp}],
//     period_rings:[{ring,hp}], unlocked_tiers:[1..], level_curve:[{level,hp_to_reach}] }
//
// Visuals come only from CSS classes + --wg-* tokens; the only inline style is
// `style.setProperty('--fill-pct', …)` for progress fills (allowed by the
// design-token guard, same convention as the weight-goal card + macro bar).
//
// Loads as a classic <script> (no ES modules); state lives inside the IIFE.
(function () {
    'use strict';

    const CACHE_KEY = 'gamification';
    const JOURNEY_URL = '/api/gamification/journey';
    const STALE_AFTER_MS = 6 * 60 * 60 * 1000; // 6h — matches the cache-keys registry

    // Ring display metadata in canonical order (matches the backend's
    // ringScores ordering). Icons come from the WGIcons registry. `how` is the
    // plain-language action that fills the ring — answers "how do I get this?"
    // right on the row (mirrors today.js RING_MOVE_META verbs; no HP number,
    // which lives in the backend Config and would drift if duplicated here).
    const RINGS = [
        { ring: 'adherence', label: 'Adherence', icon: 'pill', how: 'Take your meds on time' },
        { ring: 'movement', label: 'Movement', icon: 'activity', how: 'Log a workout' },
        { ring: 'vitals', label: 'Vitals', icon: 'heart', how: 'Log a BP reading' },
        { ring: 'nourishment', label: 'Nourishment', icon: 'apple', how: 'Log a meal' },
        { ring: 'mind', label: 'Mind', icon: 'moon', how: 'Log last night’s sleep' },
    ];

    // Insight ladder rows for the MVP (InsightMaxTier=4). tier → unlock level
    // mirrors scoring.InsightTierLevels {3,5,7} (tier 1 is always level 1);
    // locked/unlocked state is derived from journey.unlocked_tiers, not from
    // the level, so a backend curve change can't desync the lock state.
    // ponytail: descriptions are illustrative (per docs/gamification.md §8);
    // the L5+ visualizations themselves are Phase 2.
    const LADDER = [
        { tier: 1, level: 1, title: 'Rings & streak', desc: 'Daily rings, current streak, personal bests.' },
        { tier: 2, level: 3, title: 'Trend charts', desc: 'Per-domain trends & 30/90-day baselines — you vs. your past.' },
        { tier: 3, level: 5, title: 'Correlations', desc: 'Cross-domain links in your own data.' },
        { tier: 4, level: 7, title: 'Your good-day model', desc: 'Which behaviours most predict your in-range days.' },
    ];

    function icon(name, size) {
        if (window.WGIcons && typeof window.WGIcons.iconSvg === 'function') {
            try { return window.WGIcons.iconSvg(name, { size: size || 18 }); }
            catch (_) { return null; }
        }
        return null;
    }

    function ringSvgOrNull(opts) {
        if (typeof window === 'undefined' || !window.WGRing || typeof window.WGRing.render !== 'function') {
            return null;
        }
        return window.WGRing.render(opts);
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

    function renderHeader(j) {
        const card = el('section', 'wg-card wg-journey-header');

        const top = el('div', 'wg-journey-header__top');
        const badge = el('div', 'wg-journey-level-badge');
        const bolt = icon('bolt', 20);
        if (bolt) badge.appendChild(bolt);
        badge.appendChild(el('span', 'wg-journey-level-badge__num', `Lvl ${Number(j.level) || 0}`));
        top.appendChild(badge);

        const lifetime = el('div', 'wg-journey-header__lifetime');
        lifetime.appendChild(el('span', 'wg-mono-display wg-journey-header__hp', String(Number(j.lifetime_hp) || 0)));
        lifetime.appendChild(el('span', 'wg-journey-header__hp-label', 'lifetime HP'));
        top.appendChild(lifetime);
        card.appendChild(top);

        const span = Number(j.level_span_hp) || 0;
        const into = Number(j.hp_into_level) || 0;
        card.appendChild(progressBar(span > 0 ? into / span : 1, 'wg-journey-bar__fill--sun'));

        const toNext = Number(j.hp_to_next_level) || 0;
        const caption = toNext > 0
            ? `${toNext} HP to Level ${(Number(j.level) || 0) + 1}`
            : 'Max level reached';
        card.appendChild(el('div', 'wg-journey-header__caption wg-muted', caption));
        return card;
    }

    // First-run explainer (Plan 5, Task 5) — a short, static term/desc card
    // covering HP, rings, closing, levels and the insight ladder in plain
    // language. No collapse/expand JS: it's five short lines, not worth the
    // state.
    const EXPLAINER_TERMS = [
        ['HP', 'Healthy actions earn HealthPoints (HP).'],
        ['Rings', 'Each ring tracks one area of your health — adherence, movement, vitals, nourishment, mind.'],
        ['Closing a ring', 'A ring closes when today’s number lands in your target range, not just from logging.'],
        ['Levels', 'HP adds up across days; enough HP levels you up.'],
        ['Insight ladder', 'Levelling up unlocks deeper personal analytics below — some are still coming soon.'],
    ];

    function renderExplainer() {
        const card = el('section', 'wg-card wg-journey-explainer');
        card.appendChild(el('div', 'wg-section-label', 'HOW THIS WORKS'));
        const list = el('div', 'wg-journey-explainer__list');
        EXPLAINER_TERMS.forEach(([term, desc]) => {
            const row = el('div', 'wg-journey-explainer__row');
            row.appendChild(el('span', 'wg-journey-explainer__term', term));
            row.appendChild(el('span', 'wg-journey-explainer__desc wg-muted', desc));
            list.appendChild(row);
        });
        card.appendChild(list);
        return card;
    }

    function statCell(label, value) {
        const cell = el('div', 'wg-journey-stat');
        cell.appendChild(el('span', 'wg-mono-display wg-journey-stat__value', String(value)));
        cell.appendChild(el('span', 'wg-journey-stat__label', label));
        return cell;
    }

    function renderStreak(j) {
        const card = el('section', 'wg-card wg-journey-streak');
        card.appendChild(el('div', 'wg-section-label', 'STREAK'));
        const row = el('div', 'wg-journey-stat-row');
        row.appendChild(statCell('Current', `${Number(j.current_streak) || 0}`));
        row.appendChild(statCell('Longest', `${Number(j.longest_streak) || 0}`));
        row.appendChild(statCell('Freezes', `${Number(j.freezes) || 0}`));
        card.appendChild(row);
        return card;
    }

    function renderRings(j) {
        const card = el('section', 'wg-card wg-journey-rings');
        card.id = 'journey-rings-card';

        const rings = Array.isArray(j.today_rings) ? j.today_rings : [];
        const hpByRing = {};
        const progressByRing = {};
        const goalByRing = {};
        const closedByRing = {};
        const syncPendingByRing = {};
        let closedCount = 0;
        rings.forEach((r) => {
            if (!r || typeof r.ring !== 'string') return;
            const hp = Number(r.hp) || 0;
            hpByRing[r.ring] = hp;
            progressByRing[r.ring] = r.progress;
            goalByRing[r.ring] = r.goal;
            if (r.closed) { closedByRing[r.ring] = true; closedCount += 1; }
            if (r.sync_pending) { syncPendingByRing[r.ring] = true; }
        });

        // Closed count in the section label turns the rings from a scoreboard
        // into a goal ("3 of 5 closed"); the why-line says what a ring *is*.
        card.appendChild(el('div', 'wg-section-label',
            `TODAY’S RINGS · ${closedCount} OF ${RINGS.length} CLOSED`));
        card.appendChild(el('p', 'wg-journey-rings__why wg-muted',
            'Close each ring daily — one per area of your health.'));

        const list = el('div', 'wg-journey-rings__list');
        RINGS.forEach((meta) => {
            const hp = hpByRing[meta.ring] || 0;
            const isClosed = !!closedByRing[meta.ring];
            const isSyncPending = !!syncPendingByRing[meta.ring];
            const row = el('div', 'wg-journey-ring' + (isSyncPending ? ' wg-journey-ring--sync-pending' : ''));

            const head = el('div', 'wg-journey-ring__head');
            const ic = icon(meta.icon, 16);
            if (ic) {
                const wrap = el('span', 'wg-journey-ring__icon');
                wrap.appendChild(ic);
                head.appendChild(wrap);
            }
            head.appendChild(el('span', 'wg-journey-ring__label', meta.label));
            // A check marks a closed ring (landed in range, not just logged).
            if (isClosed) {
                const chk = icon('check', 14);
                if (chk) {
                    const cw = el('span', 'wg-journey-ring__check');
                    cw.setAttribute('aria-label', 'closed');
                    cw.appendChild(chk);
                    head.appendChild(cw);
                }
            }
            head.appendChild(el('span', 'wg-mono-display wg-journey-ring__hp', String(hp)));
            row.appendChild(head);

            // Honest fill: closed always draws a full ring; an open ring draws
            // its real range-membership progress toward closing — never a bar
            // relative to today's other rings (the bug this replaces).
            const ring = ringSvgOrNull({
                progress: progressByRing[meta.ring],
                closed: isClosed,
                label: meta.label,
                value: isClosed ? 'Closed' : `${hp} HP`
            });
            if (ring) row.appendChild(ring);

            // The subtitle answers "what closes this ring?" with the user's
            // real goal numbers (falls back to the generic "how" when the
            // backend hasn't sent a goal). Once closed it switches to a done
            // note instead of nagging; a sync-pending ring (no device sample
            // yet) reads as waiting, not failing.
            row.appendChild(el('p', 'wg-journey-ring__sub wg-muted',
                isSyncPending ? 'Syncs later' : (isClosed ? 'Closed for today' : (goalByRing[meta.ring] || meta.how))));

            list.appendChild(row);
        });
        card.appendChild(list);
        return card;
    }

    // Points-history card — turns the already-fetched (but previously discarded)
    // hp_history into a sparkline trend + caption. Each entry is one day that
    // earned HP (sparse), so "N days" counts active days, not calendar days.
    // Returns null when there's no history so a fresh account skips the card.
    function renderHistory(j) {
        const hist = Array.isArray(j.hp_history) ? j.hp_history : [];
        if (hist.length === 0) return null;

        const WINDOW = 30;
        const recent = hist.slice(-WINDOW);
        const points = recent.map((d) => Number(d && d.hp) || 0);
        const total = points.reduce((a, b) => a + b, 0);

        const card = el('section', 'wg-card wg-journey-history');
        card.appendChild(el('div', 'wg-section-label', 'POINTS HISTORY'));

        if (window.WGSparkline && typeof window.WGSparkline.render === 'function') {
            const spark = window.WGSparkline.render({ points, variant: 'sun', width: 300, height: 56 });
            if (spark) {
                const chart = el('div', 'wg-journey-history__chart');
                chart.appendChild(spark);
                card.appendChild(chart);
            }
        }

        const days = recent.length;
        card.appendChild(el('div', 'wg-journey-history__caption wg-muted',
            `Last ${days} day${days === 1 ? '' : 's'} · ${total.toLocaleString()} HP`));
        return card;
    }

    // Scrolls to the rings card — the real destination tier 1 ("Rings &
    // streak") describes. Tiers 3-4 have no built destination yet (Phase 2),
    // so they never get this treatment or the word "Unlocked".
    function goToRingsCard() {
        const target = document.getElementById('journey-rings-card');
        if (target && typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // Deep-links to the Vitals section's trend charts — the real destination
    // tier 2 ("Trend charts") describes. Vitals keeps the internal tab id
    // "health" for deeplink/localStorage stability (CLAUDE.md rule 6).
    function goToVitalsTrends() {
        if (typeof window.switchTab === 'function') {
            window.switchTab('health');
        }
    }

    // tier -> destination handler for tiers that have a built screen to link
    // to. Tiers without an entry here stay locked/"soon" regardless of the
    // backend's unlocked_tiers (Phase 2).
    const LADDER_DESTINATIONS = { 1: goToRingsCard, 2: goToVitalsTrends };

    function renderLadder(j) {
        const card = el('section', 'wg-card wg-journey-ladder');
        card.appendChild(el('div', 'wg-section-label', 'INSIGHT LADDER'));

        const unlocked = new Set(
            Array.isArray(j.unlocked_tiers) ? j.unlocked_tiers.map((t) => Number(t)) : []
        );

        const list = el('div', 'wg-journey-ladder__list');
        LADDER.forEach((entry) => {
            // Honest labels: "Unlocked" only ever appears where there is a
            // real destination to view. Tiers 1-2 have a built screen (the
            // rings/streak cards above, and the Vitals trend charts); tiers
            // 3-4 are Phase 2 — they always read "Unlocks at Lvl N · soon",
            // regardless of the backend's level-derived unlocked_tiers.
            const destination = LADDER_DESTINATIONS[entry.tier];
            const hasDestination = !!destination && unlocked.has(entry.tier);
            const row = el('div', 'wg-journey-ladder__row' +
                (hasDestination ? ' wg-journey-ladder__row--linked' : ' wg-journey-ladder__row--locked'));

            const marker = el('span', 'wg-journey-ladder__marker');
            const markIcon = icon(hasDestination ? 'check' : 'bolt', 14);
            if (markIcon) marker.appendChild(markIcon);
            row.appendChild(marker);

            const body = el('div', 'wg-journey-ladder__body');
            body.appendChild(el('span', 'wg-journey-ladder__title', entry.title));
            body.appendChild(el('span', 'wg-journey-ladder__desc wg-muted', entry.desc));
            row.appendChild(body);

            const status = el('span', 'wg-tag wg-tag--mono wg-journey-ladder__status',
                hasDestination ? 'Unlocked → view' : `Unlocks at Lvl ${entry.level} · soon`);
            row.appendChild(status);

            if (hasDestination) {
                row.setAttribute('role', 'button');
                row.setAttribute('tabindex', '0');
                row.addEventListener('click', destination);
                row.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); destination(); }
                });
            }

            list.appendChild(row);
        });
        card.appendChild(list);
        return card;
    }

    function render(journey) {
        const content = document.getElementById('journey-content');
        if (!content) return;

        if (!journey || journey.enabled === false) {
            renderEmpty(content, 'Gamification is off. Enable it in Settings to start your Journey.');
            return;
        }

        const cards = [
            renderHeader(journey),
            renderExplainer(),
            renderStreak(journey),
            renderRings(journey),
            renderHistory(journey),
            renderLadder(journey),
        ].filter(Boolean);
        content.replaceChildren(...cards);
    }

    // Mounts the freshness chip into the Journey header from the api_cache
    // 'gamification' timestamp (warmed by cachedFetch). Tone flips to offline
    // whenever navigator.onLine is false. Best-effort — never throws.
    async function mountBadge() {
        const slot = document.getElementById('journey-stale-badge');
        if (!slot) return;
        const api = (typeof window !== 'undefined') ? window.WGStaleBadge : null;
        if (!api || typeof api.mountFromKey !== 'function') {
            slot.replaceChildren();
            slot.classList.add('hidden');
            return;
        }
        await api.mountFromKey({ slot, key: CACHE_KEY, staleAfterMs: STALE_AFTER_MS });
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
            await mountBadge();
            return;
        }

        try {
            const result = await window.cachedFetch(CACHE_KEY, JOURNEY_URL, {
                tags: ['gamification'],
                freshAfterMs: 60_000,
                staleAfterMs: STALE_AFTER_MS,
            });
            render(result ? result.data : null);
            await mountBadge();
        } catch (e) {
            if (window.OfflineNoCacheError && e instanceof window.OfflineNoCacheError) {
                renderEmpty(content, 'No cached Journey data — connect to load.');
                await mountBadge();
                return;
            }
            console.error('Failed to load gamification journey:', e);
            renderEmpty(content, 'Failed to load your Journey.');
        }
    }

    window.Gamification = { load, render };
})();
