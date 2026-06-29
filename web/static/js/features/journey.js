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
    // ringScores ordering). Icons come from the WGIcons registry.
    const RINGS = [
        { ring: 'adherence', label: 'Adherence', icon: 'pill' },
        { ring: 'movement', label: 'Movement', icon: 'activity' },
        { ring: 'vitals', label: 'Vitals', icon: 'heart' },
        { ring: 'nourishment', label: 'Nourishment', icon: 'apple' },
        { ring: 'mind', label: 'Mind', icon: 'moon' },
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
        card.appendChild(el('div', 'wg-section-label', 'TODAY’S RINGS'));

        const rings = Array.isArray(j.today_rings) ? j.today_rings : [];
        const hpByRing = {};
        let max = 0;
        rings.forEach((r) => {
            if (!r || typeof r.ring !== 'string') return;
            const hp = Number(r.hp) || 0;
            hpByRing[r.ring] = hp;
            if (hp > max) max = hp;
        });

        const list = el('div', 'wg-journey-rings__list');
        RINGS.forEach((meta) => {
            const hp = hpByRing[meta.ring] || 0;
            const row = el('div', 'wg-journey-ring');

            const head = el('div', 'wg-journey-ring__head');
            const ic = icon(meta.icon, 16);
            if (ic) {
                const wrap = el('span', 'wg-journey-ring__icon');
                wrap.appendChild(ic);
                head.appendChild(wrap);
            }
            head.appendChild(el('span', 'wg-journey-ring__label', meta.label));
            head.appendChild(el('span', 'wg-mono-display wg-journey-ring__hp', String(hp)));
            row.appendChild(head);

            // Fill is relative to the highest-scoring ring today, so the leader
            // reads full and the others scale against it. All-zero days render
            // empty tracks rather than NaN.
            row.appendChild(progressBar(max > 0 ? hp / max : 0));
            list.appendChild(row);
        });
        card.appendChild(list);
        return card;
    }

    function renderLadder(j) {
        const card = el('section', 'wg-card wg-journey-ladder');
        card.appendChild(el('div', 'wg-section-label', 'INSIGHT LADDER'));

        const unlocked = new Set(
            Array.isArray(j.unlocked_tiers) ? j.unlocked_tiers.map((t) => Number(t)) : []
        );

        const list = el('div', 'wg-journey-ladder__list');
        LADDER.forEach((entry) => {
            const isUnlocked = unlocked.has(entry.tier);
            const row = el('div', 'wg-journey-ladder__row' + (isUnlocked ? '' : ' wg-journey-ladder__row--locked'));

            const marker = el('span', 'wg-journey-ladder__marker');
            const markIcon = icon(isUnlocked ? 'check' : 'bolt', 14);
            if (markIcon) marker.appendChild(markIcon);
            row.appendChild(marker);

            const body = el('div', 'wg-journey-ladder__body');
            body.appendChild(el('span', 'wg-journey-ladder__title', entry.title));
            body.appendChild(el('span', 'wg-journey-ladder__desc wg-muted', entry.desc));
            row.appendChild(body);

            const status = el('span', 'wg-tag wg-tag--mono wg-journey-ladder__status',
                isUnlocked ? 'Unlocked' : `Lvl ${entry.level}`);
            row.appendChild(status);

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

        content.replaceChildren(
            renderHeader(journey),
            renderStreak(journey),
            renderRings(journey),
            renderLadder(journey)
        );
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
