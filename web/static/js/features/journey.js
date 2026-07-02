// Gamification "Journey" feature module (Plan 3 of 3 — frontend, Task 2).
//
// Closure-scoped module exposing window.Gamification — a loader (load) that
// reads GET /api/gamification/journey through cachedFetch (local-first +
// freshness chip) and a pure-ish render(journey) that paints #journey-content
// from the Plan 2 Journey read model:
//   { enabled, level, lifetime_hp, hp_into_level, level_span_hp, hp_to_next_level,
//     current_streak, longest_streak, freezes, today_hp, today_rings:[{ring,hp}],
//     period_rings:[{ring,hp}], unlocked_tiers:[1..], level_curve:[{level,hp_to_reach}],
//     health_score:{value,contributors:[{key,label,score,weight,missing}],missing:[]},
//     strengths:[{key,label,value,frequency}] }  (Task 8, the two additive score layers)
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
    const INSIGHTS_CACHE_KEY = 'gamification_insights';
    const INSIGHTS_URL = '/api/gamification/insights';

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

    function ringStackOrNull(opts) {
        if (typeof window === 'undefined' || !window.WGRingStack || typeof window.WGRingStack.render !== 'function') {
            return null;
        }
        return window.WGRingStack.render(opts);
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
        ['Health Score', 'A 0–100 score built from your recent readings — a gap in the data dilutes it, it never counts as a zero.'],
        ['Strengths', 'Each habit’s strength rises when you keep it up and eases off on a miss — no all-or-nothing streak to lose.'],
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

    // Qualitative band for the 0-100 Health Score composite (Task 8). Duplicated
    // from today.js rather than shared, matching the RINGS/RING_TILE_META
    // convention already in this file pair.
    function healthScoreBand(value) {
        if (!Number.isFinite(value)) return null;
        if (value >= 70) return { label: 'Good', kind: 'normal' };
        if (value >= 40) return { label: 'Fair', kind: 'high' };
        return { label: 'Needs attention', kind: 'alert' };
    }

    // Health Score card (Task 8): the Oura/Whoop-pattern 0-100 composite as a
    // big number + band word, then one mini-bar per named contributor. A
    // contributor with no data in its window renders "No data" instead of a
    // misleading 0-width bar — the composite renormalizes over what's present,
    // it never scores an absent signal as zero.
    function renderHealthScore(j) {
        const hs = (j && j.health_score) || {};
        const card = el('section', 'wg-card wg-journey-score');
        card.appendChild(el('div', 'wg-section-label', 'HEALTH SCORE'));

        const hero = el('div', 'wg-journey-score__hero');
        const scoreValue = Number.isFinite(hs.value) ? Math.round(hs.value) : null;
        hero.appendChild(el('span', 'wg-mono-display wg-journey-score__value', scoreValue != null ? String(scoreValue) : '—'));
        const band = healthScoreBand(scoreValue);
        if (band) {
            hero.appendChild(el('span', `wg-tag wg-tag--${band.kind}`, band.label));
        } else {
            hero.appendChild(el('span', 'wg-journey-score__hero-note wg-muted', 'Not enough data yet'));
        }
        card.appendChild(hero);

        const contributors = Array.isArray(hs.contributors) ? hs.contributors : [];
        const list = el('div', 'wg-journey-score__list');
        contributors.forEach((c) => {
            const row = el('div', 'wg-journey-score__row');
            const head = el('div', 'wg-journey-score__row-head');
            head.appendChild(el('span', 'wg-journey-score__row-label', c.label || c.key));
            head.appendChild(el('span', 'wg-journey-score__row-value wg-muted',
                c.missing ? 'No data' : `${Math.round((Number(c.score) || 0) * 100)}%`));
            row.appendChild(head);
            row.appendChild(progressBar(c.missing ? 0 : c.score, 'wg-journey-bar__fill--sun'));
            list.appendChild(row);
        });
        card.appendChild(list);
        return card;
    }

    // Strengths pillar metadata — icon only; label comes from the backend so
    // wording changes don't need a frontend deploy.
    const STRENGTHS_META = {
        meds: { icon: 'pill' },
        movement: { icon: 'activity' },
        measurement: { icon: 'chart' },
    };

    // Strengths card (Task 8): replaces the weekly streak card as the
    // continuity mechanic — one Loop-Habit-Tracker EMA gauge per pillar
    // (meds/movement/measurement). The derived streak from Phase A is
    // demoted to a single footnote line here rather than dropped outright,
    // since "N-week streak" is still a legible, familiar number. The streak
    // is weekly-cadence (derived per met week in streak.go), so it reads in
    // weeks, not days.
    function renderStrengths(j) {
        const card = el('section', 'wg-card wg-journey-strengths');
        card.appendChild(el('div', 'wg-section-label', 'STRENGTHS'));

        const strengths = Array.isArray(j.strengths) ? j.strengths : [];
        if (strengths.length === 0) {
            card.appendChild(el('p', 'wg-journey-strengths__empty wg-muted', 'No habit data yet.'));
        } else {
            const list = el('div', 'wg-journey-strengths__list');
            strengths.forEach((s) => {
                const meta = STRENGTHS_META[s.key] || {};
                const row = el('div', 'wg-journey-strength');
                const head = el('div', 'wg-journey-strength__head');
                const ic = icon(meta.icon || 'bolt', 16);
                if (ic) {
                    const wrap = el('span', 'wg-journey-strength__icon');
                    wrap.appendChild(ic);
                    head.appendChild(wrap);
                }
                head.appendChild(el('span', 'wg-journey-strength__label', s.label || s.key));
                const pct = Math.round((Number(s.value) || 0) * 100);
                head.appendChild(el('span', 'wg-mono-display wg-journey-strength__value', `${pct}%`));
                row.appendChild(head);
                row.appendChild(progressBar(s.value, 'wg-journey-bar__fill--sun'));
                list.appendChild(row);
            });
            card.appendChild(list);
        }

        const current = Number(j.current_streak) || 0;
        const longest = Number(j.longest_streak) || 0;
        const footnote = current > 0
            ? `${current}-week streak · best ${longest}`
            : (longest > 0 ? `Best streak: ${longest} weeks` : 'Close a ring weekly to start a streak.');
        card.appendChild(el('div', 'wg-journey-strengths__footnote wg-muted', footnote));
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

        // One big concentric stack (Plan 7) replaces the old per-row wg-ring
        // gauges; outer→inner follows RINGS' canonical order. Larger size
        // modifier than the Today tile — this is the screen dedicated to it.
        // The center check appears once every *actionable* ring is closed (each
        // ring is either closed or waiting on a device sync) — sync-pending
        // rings don't block celebration, matching the Today tile and the
        // wg-ring-stack contract (Plan 7, Task 1).
        const body = el('div', 'wg-journey-rings__body');
        const allActionableClosed = RINGS.every((meta) =>
            closedByRing[meta.ring] || syncPendingByRing[meta.ring]);
        const stack = ringStackOrNull({
            rings: RINGS.map((meta) => ({
                key: meta.ring,
                progress: progressByRing[meta.ring],
                closed: !!closedByRing[meta.ring],
                syncPending: !!syncPendingByRing[meta.ring]
            })),
            centerLabel: allActionableClosed ? icon('check', 24) : `${closedCount}/${RINGS.length}`,
            label: 'Today’s rings'
        });
        if (stack) {
            stack.classList.add('wg-ring-stack--lg');
            body.appendChild(stack);
        }

        const legend = el('div', 'wg-journey-rings__legend');
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

            // The subtitle answers "what closes this ring?" with the user's
            // real goal numbers (falls back to the generic "how" when the
            // backend hasn't sent a goal). Once closed it switches to a done
            // note instead of nagging; a sync-pending ring (no device sample
            // yet) reads as waiting, not failing.
            row.appendChild(el('p', 'wg-journey-ring__sub wg-muted',
                isSyncPending ? 'Syncs later' : (isClosed ? 'Closed for today' : (goalByRing[meta.ring] || meta.how))));

            list.appendChild(row);
        });
        legend.appendChild(list);
        body.appendChild(legend);
        card.appendChild(body);
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

    // Plain-language copy for the tier-3 sleep→BP insight (Task 3 — the first
    // real destination in the Insight Ladder). Mirrors the honesty gate in
    // internal/domain/gamification/insights.go: "no effect" and "insufficient
    // data" are terminal, genuine findings, not error states, so they render
    // with the same wording style as the effect case, not an apology.
    function insightCopy(sleepBp) {
        if (!sleepBp) return null;
        if (sleepBp.status === 'effect') {
            const delta = Number(sleepBp.delta_systolic) || 0;
            const signed = `${delta >= 0 ? '+' : ''}${Math.round(delta)}`;
            return `Nights under ${sleepBp.short_threshold_hours}h → next-morning systolic ~${signed} mmHg · ${sleepBp.n_short} nights`;
        }
        if (sleepBp.status === 'no_effect') {
            return 'Your morning BP looks steady regardless of sleep length — solid.';
        }
        if (sleepBp.status === 'insufficient_data') {
            const have = Math.min(Number(sleepBp.n_short) || 0, Number(sleepBp.n_in_band) || 0);
            return `Not enough paired nights yet · ${have} of ${sleepBp.needed} — keep logging`;
        }
        return null;
    }

    // Tier-3 destination card (Task 3): the sleep→BP insight, fetched
    // separately from the Journey payload (`load()` attaches it to
    // `journey.insight` once it sees tier 3 in unlocked_tiers). Omitted
    // entirely below tier 3 — matching how the ladder itself keeps the row
    // "locked" — and while `journey.insight` hasn't arrived yet (e.g. render()
    // called directly, as in tests, without a preceding load()).
    // True when the Journey payload reports insight tier `n` unlocked.
    function tierUnlocked(j, n) {
        return Array.isArray(j.unlocked_tiers) && j.unlocked_tiers.map(Number).includes(n);
    }

    function renderInsightCard(j) {
        if (!tierUnlocked(j, 3)) return null;

        const insight = j.insight;
        if (!insight) return null;

        const card = el('section', 'wg-card wg-journey-insight');
        card.id = 'journey-insight-card';
        card.appendChild(el('div', 'wg-section-label', 'YOUR INSIGHT'));

        const copy = insight.emptyState || insightCopy(insight.sleep_bp);
        if (!copy) return null;
        card.appendChild(el('p', 'wg-journey-insight__body wg-muted', copy));
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

    // Scrolls to the tier-3 insight card rendered above (renderInsightCard).
    // A no-op if the card wasn't rendered (e.g. `journey.insight` hasn't
    // loaded yet) — the ladder row still reads "Unlocked → view" from
    // unlocked_tiers alone, independent of whether the fetch has resolved.
    function goToInsightCard() {
        const target = document.getElementById('journey-insight-card');
        if (target && typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // tier -> destination handler for tiers that have a built screen to link
    // to. Tiers without an entry here stay locked/"soon" regardless of the
    // backend's unlocked_tiers (Phase 2 — tier 4 "good-day model" has no
    // destination yet).
    const LADDER_DESTINATIONS = { 1: goToRingsCard, 2: goToVitalsTrends, 3: goToInsightCard };

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
            renderHealthScore(journey),
            renderStrengths(journey),
            renderRings(journey),
            renderHistory(journey),
            renderInsightCard(journey),
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

    // Fetches the tier-3 sleep→BP insight through its own cachedFetch entry
    // (Task 3) — only called once the Journey payload reports tier 3
    // unlocked, so accounts below level 5 never pay for the extra request.
    // A cold cache offline read renders an explicit empty state on the card
    // rather than silently omitting it (local-first read pattern).
    async function loadInsight() {
        try {
            const result = await window.cachedFetch(INSIGHTS_CACHE_KEY, INSIGHTS_URL, {
                tags: ['gamification'],
                freshAfterMs: 60_000,
                staleAfterMs: STALE_AFTER_MS,
            });
            return result ? result.data : null;
        } catch (e) {
            if (window.OfflineNoCacheError && e instanceof window.OfflineNoCacheError) {
                return { emptyState: 'No cached insight — connect to load.' };
            }
            console.error('Failed to load gamification insight:', e);
            return null;
        }
    }

    // Loads the Journey read model and paints the screen. Routes through
    // cachedFetch so a cold relaunch offline renders last-known data; a cold
    // cache offline surfaces an explicit empty state (OfflineNoCacheError).
    async function load() {
        const content = document.getElementById('journey-content');
        if (!content) return;

        if (typeof window.cachedFetch !== 'function') {
            // Early boot / non-browser harness: best-effort direct read.
            // ponytail: no insight fetch on this degraded path — the tier-3
            // card just won't show; the primary cachedFetch path below covers
            // real usage.
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
            const data = result ? result.data : null;
            if (data && tierUnlocked(data, 3)) {
                data.insight = await loadInsight();
            }
            render(data);
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
