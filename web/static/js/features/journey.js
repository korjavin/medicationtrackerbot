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
    const GAUGES_CACHE_KEY = 'gamification_gauges';
    const GAUGES_URL = '/api/gamification/gauges';

    // Ring display metadata in canonical order (matches the backend's
    // ringScores ordering) — the three daily levers (gamification-10 §2.5).
    // Icons come from the WGIcons registry. `how` is the plain-language action
    // that fills the ring — answers "how do I get this?" right on the row
    // (mirrors today.js RING_MOVE_META verbs; no HP number, which lives in the
    // backend Config and would drift if duplicated here).
    const RINGS = [
        { ring: 'bedtime', label: 'Bedtime', icon: 'moon', how: 'Keep a steady lights-out time' },
        { ring: 'movement', label: 'Movement', icon: 'activity', how: 'Log a workout' },
        { ring: 'nourishment', label: 'Nourishment', icon: 'apple', how: 'Log a meal' },
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
        ['Rings', 'Each ring tracks one daily decision you make — bedtime, movement, nourishment.'],
        ['Closing a ring', 'A ring closes when today’s number lands in your target range, not just from logging.'],
        ['Levers vs. gauges', 'Bedtime, movement and nourishment are levers you choose today, so they close rings daily. Weight, BP and heart readings are gauges — read as trends over time, never graded day to day.'],
        ['Health Score', 'A 0–100 score built from your recent readings — a gap in the data dilutes it, it never counts as a zero.'],
        ['Strengths', 'Each habit’s strength rises when you keep it up and eases off on a miss — no all-or-nothing streak to lose.'],
        ['Levels', 'HP adds up across days; enough HP levels you up.'],
        ['Discoveries', 'Log honestly and your body’s patterns develop into findings — no level gate.'],
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

    // "Your week" card (gamification-12 §Task3): the primary reading cadence
    // for gauges (Overview) — this week vs last, folded from the same
    // ledger/gauge/Health-Score reads the other cards already use. Fetched
    // through its own cachedFetch entry (loadWeeklyReview), rendered as a
    // native <details>/<summary> collapsible (the tz-plan-banner convention)
    // between the Health Score and Gauges cards. Tone rules: neutral-to-
    // positive phrasing only, no red styling for a down week — every line
    // renders wg-muted regardless of direction, same as the Gauges panel.
    const WEEKLY_CACHE_KEY = 'gamification_weekly';
    const WEEKLY_URL = '/api/gamification/weekly-review';

    function weekdayLabel(dayUnix) {
        const t = Number(dayUnix) * 1000;
        if (!Number.isFinite(t)) return null;
        try {
            return new Date(t).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });
        } catch (_) {
            return null;
        }
    }

    function weeklyScoreLine(hs) {
        const now = hs && hs.now;
        const prior = hs && hs.prior;
        const nowValue = now && Number.isFinite(now.value) ? Math.round(now.value) : null;
        if (nowValue == null) return null;
        const priorValue = prior && Number.isFinite(prior.value) ? Math.round(prior.value) : null;
        if (priorValue == null) return `Health Score ${nowValue}`;
        const delta = nowValue - priorValue;
        if (delta === 0) return `Health Score ${nowValue} · holding steady`;
        return `Health Score ${nowValue} · ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)}`;
    }

    // First lever spells out "closed N of 7"; the rest just carry the count —
    // the denominator (a week) doesn't need repeating per lever.
    function weeklyLeverLine(levers) {
        const list = Array.isArray(levers) ? levers : [];
        if (list.length === 0) return null;
        return list.map((lv, i) => {
            const meta = RINGS.find((r) => r.ring === lv.key);
            const label = (meta && meta.label) || lv.key;
            const closed = Number(lv.closed_this_week) || 0;
            return i === 0 ? `${label} closed ${closed} of 7` : `${label} ${closed}`;
        }).join(' · ');
    }

    function weeklyWeightLine(w) {
        if (!w || w.status !== 'ok') return null;
        const velocity = Number(w.velocity_pct_per_week) || 0;
        const parts = [`${velocity >= 0 ? '+' : ''}${velocity.toFixed(1)}%/wk`];
        const pace = GAUGE_PACE_STATUS_LABEL[w.pace_status];
        if (pace) parts.push(pace);
        const accel = GAUGE_ACCELERATION_LABEL[w.acceleration];
        if (accel) parts.push(accel);
        return `Weight ${parts.join(' · ')}`;
    }

    function weeklyBPLine(bp, priorSharePct) {
        if (!bp || bp.status !== 'ok' || !(Number(bp.count_30d) > 0)) return null;
        const share = Math.round((Number(bp.share_30d) || 0) * 100);
        const prior = Math.round((Number(priorSharePct) || 0) * 100);
        // No comparable prior week (too few readings a week ago yields a 0
        // share) → show just the current share, not a misleading "up from 0%".
        if (prior <= 0) return `BP in range ${share}%`;
        const delta = share - prior;
        const word = delta === 0 ? 'holding steady' : `${delta > 0 ? 'up' : 'down'} from ${prior}%`;
        return `BP in range ${share}% · ${word}`;
    }

    function weeklyRestingHRLine(hr) {
        if (!hr || hr.status !== 'ok') return null;
        const recent = Math.round(Number(hr.recent_14d_mean) || 0);
        const delta = Math.round(Number(hr.delta_from_baseline) || 0);
        const deltaWord = delta === 0 ? 'at your baseline' : `${Math.abs(delta)} ${delta < 0 ? 'below' : 'above'} your baseline`;
        return `Resting HR ${recent} avg · ${deltaWord}`;
    }

    function weeklyBestDayLine(bestDay) {
        if (!bestDay) return null;
        const day = weekdayLabel(bestDay.day_unix);
        if (!day) return null;
        const rings = Number(bestDay.rings_closed) || 0;
        return `Best day: ${day} · ${rings} ring${rings === 1 ? '' : 's'} closed`;
    }

    // Reads `journey.weekly_review` (attached by load() from its own
    // cachedFetch entry — GET /api/gamification/weekly-review), same pattern
    // as Gauges/Insights. Renders an explicit offline-empty state, omits the
    // card entirely while gate-off or not loaded yet, and reads a zero-HP
    // week as "a quiet week" rather than a wall of zeros (Overview).
    function renderWeeklyReview(j) {
        const wr = j.weekly_review;
        if (!wr) return null;

        const card = el('section', 'wg-card wg-journey-weekly');
        const details = el('details', 'wg-journey-weekly__details');
        details.open = true;
        details.appendChild(el('summary', 'wg-journey-weekly__summary wg-section-label', 'YOUR WEEK'));

        if (wr.emptyState) {
            details.appendChild(el('p', 'wg-journey-weekly__empty wg-muted', wr.emptyState));
            card.appendChild(details);
            return card;
        }
        if (wr.enabled === false) return null;

        if (wr.quiet) {
            details.appendChild(el('p', 'wg-journey-weekly__body wg-muted',
                'A quiet week — everything picks up where you left off.'));
            card.appendChild(details);
            return card;
        }

        const gauges = wr.gauges || {};
        const lines = [
            weeklyScoreLine(wr.health_score),
            weeklyLeverLine(wr.levers),
            weeklyWeightLine(gauges.weight),
            weeklyBPLine(gauges.bp, gauges.bp_share_30d_prior),
            weeklyRestingHRLine(gauges.resting_hr),
            weeklyBestDayLine(wr.best_day),
        ].filter(Boolean);

        const list = el('div', 'wg-journey-weekly__list');
        lines.forEach((line) => list.appendChild(el('p', 'wg-journey-weekly__line wg-muted', line)));
        details.appendChild(list);
        card.appendChild(details);
        return card;
    }

    // Gauges panel (gamification-11 §Task4): weight/BP/resting-HR read as
    // trends, never a daily grade — copy is numbers + direction words only,
    // no color judgment (a slowing trend is an observation, never red; see
    // .wg-journey-gauge__caption, which stays wg-muted regardless of state).
    const GAUGE_PACE_STATUS_LABEL = {
        on_pace: 'on pace',
        too_slow: 'slower than your pace',
        too_fast: 'faster than your pace',
        wrong_direction: 'moving away from goal',
    };
    const GAUGE_ACCELERATION_LABEL = {
        speeding_up: 'speeding up',
        holding: 'holding steady',
        slowing: 'slowing',
    };

    function weightGaugeCopy(w) {
        if (!w || w.status !== 'ok') return 'Keep logging weight — not enough history yet for a trend.';
        const velocity = Number(w.velocity_pct_per_week) || 0;
        const parts = [`${velocity >= 0 ? '+' : ''}${velocity.toFixed(1)}%/week`];
        const pace = GAUGE_PACE_STATUS_LABEL[w.pace_status];
        if (pace) parts.push(pace);
        const accel = GAUGE_ACCELERATION_LABEL[w.acceleration];
        if (accel) parts.push(accel);
        return parts.join(' · ');
    }

    function bpGaugeCopy(bp) {
        if (!bp || bp.status !== 'ok') return 'Log a few more BP readings to see your range trend.';
        const baseline = Math.round((Number(bp.baseline_share_60d) || 0) * 100);
        // No readings in the last 30 days would render "In range 0%", which
        // reads as "out of range all month" when the truth is "no measurements".
        if (!(Number(bp.count_30d) > 0)) return `Baseline ${baseline}% in range · none logged in the last 30 days`;
        const share30d = Math.round((Number(bp.share_30d) || 0) * 100);
        return `In range ${share30d}% of last 30 days · baseline ${baseline}%`;
    }

    function restingHRGaugeCopy(hr) {
        if (!hr || hr.status !== 'ok') return 'Not enough resting-HR data yet for a baseline.';
        const recent = Math.round(Number(hr.recent_14d_mean) || 0);
        const delta = Math.round(Number(hr.delta_from_baseline) || 0);
        const deltaWord = delta === 0 ? 'at your baseline' : `${Math.abs(delta)} ${delta < 0 ? 'below' : 'above'} your baseline`;
        return `${recent} avg · ${deltaWord}`;
    }

    function renderGaugeRow(label, caption, sparklinePoints) {
        const row = el('div', 'wg-journey-gauge');
        row.appendChild(el('span', 'wg-journey-gauge__label', label));
        if (Array.isArray(sparklinePoints) && sparklinePoints.length > 1 &&
            window.WGSparkline && typeof window.WGSparkline.render === 'function') {
            const spark = window.WGSparkline.render({ points: sparklinePoints, variant: 'mint', width: 300, height: 40 });
            if (spark) {
                const chart = el('div', 'wg-journey-gauge__chart');
                chart.appendChild(spark);
                row.appendChild(chart);
            }
        }
        row.appendChild(el('p', 'wg-journey-gauge__caption wg-muted', caption));
        return row;
    }

    // Reads `journey.gauges` (attached by load() from its own cachedFetch
    // entry — GET /api/gamification/gauges, gamification-11 §Task3) rather
    // than the Journey payload itself, same pattern as the tier-3 insight
    // card. Renders an explicit offline-empty state via `emptyState`, and
    // omits the whole card while gate-off (`enabled:false`) or not loaded yet.
    function renderGauges(j) {
        const gauges = j.gauges;
        if (!gauges) return null;

        const card = el('section', 'wg-card wg-journey-gauges');
        card.appendChild(el('div', 'wg-section-label', 'GAUGES'));

        if (gauges.emptyState) {
            card.appendChild(el('p', 'wg-journey-gauges__empty wg-muted', gauges.emptyState));
            return card;
        }
        if (gauges.enabled === false) return null;

        card.appendChild(el('p', 'wg-journey-gauges__why wg-muted',
            'Your body reports back slowly — these read as trends, never a daily grade.'));

        const list = el('div', 'wg-journey-gauges__list');
        list.appendChild(renderGaugeRow('Weight', weightGaugeCopy(gauges.weight), gauges.weight && gauges.weight.trend_history));
        list.appendChild(renderGaugeRow('Blood pressure', bpGaugeCopy(gauges.bp)));
        list.appendChild(renderGaugeRow('Resting heart rate', restingHRGaugeCopy(gauges.resting_hr)));
        card.appendChild(list);

        // Attribution loop (Task4, item 2): the tier-3/4 insight cards answer
        // "why is this moving?" — reuses the ladder's own scroll target so
        // there's one destination for "your insights", not two.
        const link = el('div', 'wg-journey-gauges__link', 'Why is this moving? → your insights');
        link.setAttribute('role', 'button');
        link.setAttribute('tabindex', '0');
        link.addEventListener('click', goToInsightCard);
        link.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToInsightCard(); }
        });
        card.appendChild(link);

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

    // --- Discovery Atlas feed (Phase 1, cloud POC) ------------------------
    // Reads `journey.atlas` (attached by load() from GET /api/gamification/atlas,
    // recomputed client-side from vault records in cloud mode). Three card
    // states, all rendered as first-class findings:
    //   developing — locked; a progress meter names the EXACT next log action.
    //   revealed   — the gate cleared; the finding with its numbers.
    //   no_effect  — the gate cleared and found nothing; a genuine, dignified
    //                result, not a hidden failure (the §14.8 honesty gate).
    // In bot mode the /atlas route 404s, loadAtlas() returns null, and this card
    // is simply omitted — the full substrate Journey renders unchanged.

    // Reveal-once: mark a terminal card seen the first time it renders, so the
    // backend can suppress a repeat "reveal" moment. Fire-and-forget — a failed
    // write never blocks the paint (the card still shows its finding).
    function markDiscoverySeen(card) {
        if (!card || card.seen) return;
        if (card.state !== 'revealed' && card.state !== 'no_effect') return;
        const call = window.offlineAwareApiCall || window.apiCallDirect;
        if (typeof call !== 'function') return;
        try {
            Promise.resolve(call('/api/gamification/atlas/seen', 'POST', { id: card.id }))
                .catch(() => {});
        } catch (_) { /* best-effort */ }
    }

    function atlasCardEl(card, expCtx) {
        const item = el('div', 'wg-journey-atlas__card wg-journey-atlas__card--' + card.state);
        item.appendChild(el('p', 'wg-journey-atlas__question', card.question));

        if (card.state === 'developing') {
            const needed = Number(card.needed) || 0;
            const have = Number(card.have) || 0;
            item.appendChild(progressBar(needed > 0 ? have / needed : 0, 'wg-journey-bar__fill--sun'));
            item.appendChild(el('p', 'wg-journey-atlas__meter wg-muted',
                `${have} of ${needed} paired observations · ${Number(card.remaining) || 0} more to develop`));
            if (card.next) item.appendChild(el('p', 'wg-journey-atlas__next wg-muted', card.next));
            return item;
        }

        // revealed / no_effect — both terminal findings with equal dignity.
        item.appendChild(el('p', 'wg-journey-atlas__finding', card.text || card.question));
        const revealed = card.state === 'revealed';
        item.appendChild(el('span', 'wg-tag wg-tag--mono wg-journey-atlas__tag',
            revealed ? 'Discovery' : 'No effect — a finding'));

        // "Test it" (Phase 4): a terminal discovery with a matching lever
        // template can become a 14-day N-of-1 trial — but only one experiment
        // runs at a time, and never during recovery mode.
        const tpl = expCtx && expCtx.templateByProbe && expCtx.templateByProbe[card.id];
        if (tpl && expCtx.canStart) {
            const btn = el('button', 'btn btn-sm btn-secondary wg-journey-atlas__testit', 'Test it');
            btn.type = 'button';
            btn.addEventListener('click', () => startExperiment(tpl.id, card.id));
            item.appendChild(btn);
        }

        markDiscoverySeen(card);
        return item;
    }

    function renderAtlas(j) {
        const atlas = j && j.atlas;
        if (!atlas) return null;

        const card = el('section', 'wg-card wg-journey-atlas');
        card.id = 'journey-atlas-card';
        card.appendChild(el('div', 'wg-section-label', 'DISCOVERY ATLAS'));

        if (atlas.emptyState) {
            card.appendChild(el('p', 'wg-journey-atlas__empty wg-muted', atlas.emptyState));
            return card;
        }

        const cards = Array.isArray(atlas.cards) ? atlas.cards : [];
        if (cards.length === 0) return null;

        // Build the "Test it" context once: which discoveries have a lever
        // template, and whether a new trial can start (nothing active, not paused).
        const exp = j && j.experiments;
        const templateByProbe = {};
        if (exp && Array.isArray(exp.templates)) {
            exp.templates.forEach((t) => { if (t.from_probe) templateByProbe[t.from_probe] = t; });
        }
        const expCtx = { templateByProbe, canStart: !!(exp && exp.can_start) };

        card.appendChild(el('p', 'wg-journey-atlas__why wg-muted',
            'Log honestly and your body’s patterns develop — each card is a question your own data answers.'));
        const list = el('div', 'wg-journey-atlas__list');
        cards.forEach((c) => list.appendChild(atlasCardEl(c, expCtx)));
        card.appendChild(list);
        return card;
    }

    // --- Self-Experiments (Phase 4) ---------------------------------------
    // The active-trial tracker + verdict card, and the start/cancel handlers.
    // Reads `journey.experiments` (attached by load() from GET
    // /api/gamification/experiments). Bot mode 404s the route → null → no card.

    function experimentApiCall(endpoint, method, body) {
        const call = window.offlineAwareApiCall || window.apiCallDirect;
        if (typeof call !== 'function') return Promise.resolve(null);
        return Promise.resolve(call(endpoint, method, body)).catch(() => null);
    }

    async function reloadJourney() {
        if (window.Gamification && typeof window.Gamification.load === 'function') {
            await window.Gamification.load();
        }
    }

    async function startExperiment(templateId, sourceDiscovery) {
        await experimentApiCall('/api/gamification/experiments', 'POST',
            { template_id: templateId, source_discovery: sourceDiscovery });
        await reloadJourney();
    }

    async function cancelExperiment(id) {
        if (!id) return;
        await experimentApiCall(`/api/gamification/experiments/${encodeURIComponent(id)}`, 'DELETE');
        await reloadJourney();
    }

    function verdictTagText(verdict) {
        if (verdict === 'effect') return 'Effect — a finding';
        if (verdict === 'no_effect') return 'No effect — an equally real finding';
        return 'Not enough contrast';
    }

    function renderExperiment(j) {
        const exp = j && j.experiments;
        if (!exp || exp.enabled === false) return null;
        // Nothing to surface as a card: the "Test it" entry points live on the
        // discovery cards themselves, so an idle state renders no experiment card.
        if (!exp.active && !exp.verdict) return null;

        const card = el('section', 'wg-card wg-journey-experiment');
        card.id = 'journey-experiment-card';
        card.appendChild(el('div', 'wg-section-label', 'SELF-EXPERIMENT'));

        if (exp.active) {
            const a = exp.active;
            card.appendChild(el('p', 'wg-journey-experiment__title', a.title || 'Your trial'));
            if (a.intention) card.appendChild(el('p', 'wg-journey-experiment__intention', a.intention));
            if (a.measure) card.appendChild(el('p', 'wg-journey-experiment__measure wg-muted', a.measure));
            const duration = Number(a.duration) || 0;
            card.appendChild(progressBar(duration > 0 ? (Number(a.day_number) || 0) / duration : 0,
                'wg-journey-bar__fill--sun'));
            card.appendChild(el('p', 'wg-journey-experiment__tracker wg-muted', a.tracker || ''));
            if (a.paused) {
                card.appendChild(el('span', 'wg-tag wg-tag--mono wg-journey-experiment__paused',
                    'Paused — recovery mode'));
            }
            const stop = el('button', 'btn btn-sm btn-link wg-journey-experiment__cancel', 'Stop trial (no penalty)');
            stop.type = 'button';
            stop.addEventListener('click', () => cancelExperiment(a.id));
            card.appendChild(stop);
            return card;
        }

        // Verdict — effect / no_effect / not_enough_contrast, all shown with the
        // numbers; no_effect carries the SAME reward line as effect (§3.3).
        const v = exp.verdict;
        card.appendChild(el('p', 'wg-journey-experiment__title', v.title || 'Verdict'));
        card.appendChild(el('span', 'wg-tag wg-tag--mono wg-journey-experiment__verdict-tag',
            verdictTagText(v.verdict)));
        card.appendChild(el('p', 'wg-journey-experiment__finding', v.text || ''));
        if (v.rewarded) {
            card.appendChild(el('p', 'wg-journey-experiment__reward wg-muted',
                'Logged as a keystone — running a clean trial is the win, whatever it found.'));
        }
        if (v.disclaimer) {
            card.appendChild(el('p', 'wg-journey-experiment__disclaimer wg-muted', v.disclaimer));
        }
        const done = el('button', 'btn btn-sm btn-link', 'Got it');
        done.type = 'button';
        done.addEventListener('click', () => cancelExperiment(v.id));
        card.appendChild(done);
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

    // Plain-language behavior labels for the tier-4 good-day scan (Task 3),
    // matching the fixed candidate set in insights_goodday.go.
    const GOOD_DAY_BEHAVIOR_LABEL = {
        workout: 'a workout',
        bedtime: 'bedtime in your window',
        steps: 'hitting your step goal',
        adherence: 'taking all doses on time',
    };

    function goodDayFindingLine(finding) {
        const label = GOOD_DAY_BEHAVIOR_LABEL[finding.behavior] || finding.behavior;
        const withPct = Math.round((Number(finding.rate_with) || 0) * 100);
        const withoutPct = Math.round((Number(finding.rate_without) || 0) * 100);
        const nWith = Number(finding.n_with) || 0;
        const total = nWith + (Number(finding.n_without) || 0);
        return `On days after ${label}, BP in range ${withPct}% vs ${withoutPct}% · ${nWith}/${total} days`;
    }

    function goodDayInsufficientLine(item) {
        const label = GOOD_DAY_BEHAVIOR_LABEL[item.behavior] || item.behavior;
        const have = Math.min(Number(item.n_with) || 0, Number(item.n_without) || 0);
        return `Not enough contrast yet for ${label} · keep logging — ${have} of ${item.needed} days needed`;
    }

    // Mirrors the honesty gate in insights_goodday.go: `effect` (one line per
    // finding, max 3 — already capped server-side), `no_effect` (a genuine
    // "nothing stands out" result, not an apology), and `insufficient_data`
    // (one line per behavior still short on paired days).
    function goodDayLines(gd) {
        if (!gd) return [];
        if (gd.status === 'effect') {
            return (Array.isArray(gd.findings) ? gd.findings : []).map(goodDayFindingLine);
        }
        if (gd.status === 'no_effect') {
            return ['No single habit stands out yet — your good days look evenly spread.'];
        }
        if (gd.status === 'insufficient_data') {
            const items = Array.isArray(gd.insufficient) ? gd.insufficient : [];
            return items.length > 0
                ? items.map(goodDayInsufficientLine)
                : ['Not enough contrast yet — keep logging.'];
        }
        return [];
    }

    // Tier-4 destination card (Task 3): the good-day association scan, reusing
    // the same `insight` fetch as the tier-3 card (both live under
    // GET /api/gamification/insights). Omitted below tier 4 or before
    // `journey.insight` has loaded, matching renderInsightCard's contract.
    function renderGoodDayCard(j) {
        if (!tierUnlocked(j, 4)) return null;

        const insight = j.insight;
        if (!insight) return null;

        const card = el('section', 'wg-card wg-journey-insight wg-journey-goodday');
        card.id = 'journey-goodday-card';
        card.appendChild(el('div', 'wg-section-label', 'YOUR GOOD-DAY MODEL'));

        if (insight.emptyState) {
            card.appendChild(el('p', 'wg-journey-insight__body wg-muted', insight.emptyState));
            return card;
        }

        const gd = insight.good_day;
        const lines = goodDayLines(gd);
        if (lines.length === 0) return null;

        const list = el('div', 'wg-journey-goodday__list');
        lines.forEach((line) => list.appendChild(el('p', 'wg-journey-insight__body wg-muted', line)));
        card.appendChild(list);

        if (gd.good_day_definition) {
            card.appendChild(el('p', 'wg-journey-goodday__definition wg-muted', gd.good_day_definition));
        }
        return card;
    }

    // Scrolls to the sleep→BP insight card rendered above (renderInsightCard).
    // A no-op if the card wasn't rendered (e.g. `journey.insight` hasn't
    // loaded yet). Reached from the Gauges "why is this moving?" link.
    function goToInsightCard() {
        const target = document.getElementById('journey-insight-card');
        if (target && typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // --- Chapters (Phase 5) -----------------------------------------------
    // Opt-in 4-week themed arcs. Reads `journey.chapter` (GET
    // /api/gamification/chapter). Active → a day tracker; idle → the last
    // review + the theme library to start the next arc (never auto-enrolled).

    async function startChapter(themeId) {
        await experimentApiCall('/api/gamification/chapter', 'POST', { theme_id: themeId });
        await reloadJourney();
    }

    async function closeChapter() {
        await experimentApiCall('/api/gamification/chapter', 'DELETE');
        await reloadJourney();
    }

    function renderChapterReview(card, review) {
        card.appendChild(el('p', 'wg-journey-chapter__title', review.title || 'Your last chapter'));
        card.appendChild(el('span', 'wg-tag wg-tag--mono wg-journey-chapter__tag', 'Chapter review'));
        card.appendChild(el('p', 'wg-journey-chapter__recap wg-muted', review.text || ''));
    }

    function renderChapterThemes(card, themes) {
        card.appendChild(el('p', 'wg-journey-chapter__prompt wg-muted',
            'Start a four-week chapter — a theme to focus on, closed with a written review. Opt-in, never a deadline.'));
        const list = el('div', 'wg-journey-chapter__themes');
        (Array.isArray(themes) ? themes : []).forEach((t) => {
            const row = el('div', 'wg-journey-chapter__theme');
            const head = el('div', 'wg-journey-chapter__theme-head');
            head.appendChild(el('span', 'wg-journey-chapter__theme-title', t.title));
            const start = el('button', 'btn btn-sm btn-secondary', 'Start');
            start.type = 'button';
            start.addEventListener('click', () => startChapter(t.id));
            head.appendChild(start);
            row.appendChild(head);
            row.appendChild(el('p', 'wg-journey-chapter__theme-blurb wg-muted', t.blurb || t.focus || ''));
            list.appendChild(row);
        });
        card.appendChild(list);
    }

    function renderChapter(j) {
        const ch = j && j.chapter;
        if (!ch || ch.enabled === false) return null;

        const card = el('section', 'wg-card wg-journey-chapter');
        card.id = 'journey-chapter-card';
        card.appendChild(el('div', 'wg-section-label', 'CHAPTER'));

        if (ch.active) {
            const a = ch.active;
            card.appendChild(el('p', 'wg-journey-chapter__title', a.title || 'Your chapter'));
            if (a.focus) card.appendChild(el('p', 'wg-journey-chapter__focus wg-muted', `Focus: ${a.focus}`));
            const duration = Number(a.duration) || 0;
            card.appendChild(progressBar(duration > 0 ? (Number(a.day_number) || 0) / duration : 0,
                'wg-journey-bar__fill--sun'));
            card.appendChild(el('p', 'wg-journey-chapter__tracker wg-muted',
                `Day ${Number(a.day_number) || 0} of ${duration}`));
            const end = el('button', 'btn btn-sm btn-link wg-journey-chapter__close', 'End chapter (writes your review)');
            end.type = 'button';
            end.addEventListener('click', () => closeChapter());
            card.appendChild(end);
            return card;
        }

        if (ch.review) renderChapterReview(card, ch.review);
        if (ch.can_start) renderChapterThemes(card, ch.themes);
        return card;
    }

    // --- Traits (Phase 5) --------------------------------------------------
    // Levers-only identity statements. Reads `journey.traits` (GET
    // /api/gamification/traits). Three states, all dignified: held (currently
    // true), dormant (lapsed — dimmed, never deleted, with a cheap rekindle
    // cost), developing (not yet earned, with progress to the bar).

    function traitStateTag(t) {
        if (t.state === 'held') return t.recovery_held ? 'Held · paused' : 'Held';
        if (t.state === 'dormant') return 'Dormant';
        return 'Developing';
    }

    function traitSubtitle(t) {
        if (t.state === 'held') {
            return t.recovery_held
                ? 'Held through recovery — the clock is paused, nothing lapses.'
                : `${Number(t.on_28d) || 0} ${t.lever_label} in the last 28 days.`;
        }
        if (t.state === 'dormant') {
            const need = Number(t.rekindle_remaining);
            const n = Number.isFinite(need) ? need : Number(t.rekindle) || 0;
            return `Dormant — ${n} more ${t.lever_label} rekindles it. Nothing was lost.`;
        }
        const remaining = Number(t.remaining) || 0;
        return `${Number(t.on_28d) || 0} of ${Number(t.earn) || 0} ${t.lever_label} — ${remaining} more to earn it.`;
    }

    function renderTraits(j) {
        const tr = j && j.traits;
        if (!tr || tr.enabled === false) return null;
        const traits = Array.isArray(tr.traits) ? tr.traits : [];
        if (traits.length === 0) return null;

        const card = el('section', 'wg-card wg-journey-traits');
        card.id = 'journey-traits-card';
        card.appendChild(el('div', 'wg-section-label', 'TRAITS'));
        card.appendChild(el('p', 'wg-journey-traits__why wg-muted',
            'Identities you earn by keeping a lever steady — they go dormant, never disappear.'));

        const list = el('div', 'wg-journey-traits__list');
        traits.forEach((t) => {
            const row = el('div', 'wg-journey-trait wg-journey-trait--' + t.state);
            const head = el('div', 'wg-journey-trait__head');
            head.appendChild(el('span', 'wg-journey-trait__name', t.title || t.id));
            head.appendChild(el('span', 'wg-tag wg-tag--mono wg-journey-trait__tag', traitStateTag(t)));
            row.appendChild(head);
            row.appendChild(el('p', 'wg-journey-trait__sub wg-muted', traitSubtitle(t)));
            list.appendChild(row);
        });
        card.appendChild(list);
        return card;
    }

    // --- Keystones (Phase 5) ----------------------------------------------
    // The permanent timeline of rare, real-outcome milestones. Reads
    // `journey.keystones` (GET /api/gamification/keystones). Never a countdown,
    // never decays — an empty timeline simply omits the card.

    function keystoneDateLabel(ms) {
        const t = Number(ms);
        if (!Number.isFinite(t)) return '';
        try {
            return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        } catch (_) { return ''; }
    }

    function renderKeystones(j) {
        const ks = j && j.keystones;
        if (!ks || ks.enabled === false) return null;
        const entries = Array.isArray(ks.keystones) ? ks.keystones : [];
        if (entries.length === 0) return null;

        const card = el('section', 'wg-card wg-journey-keystones');
        card.id = 'journey-keystones-card';
        card.appendChild(el('div', 'wg-section-label', 'KEYSTONES'));
        card.appendChild(el('p', 'wg-journey-keystones__why wg-muted',
            'Rare, permanent milestones — earned because reality made them rare.'));

        const list = el('div', 'wg-journey-keystones__list');
        entries.forEach((k) => {
            const row = el('div', 'wg-journey-keystone');
            const marker = el('span', 'wg-journey-keystone__marker');
            const star = icon('check', 14);
            if (star) marker.appendChild(star);
            row.appendChild(marker);
            const body = el('div', 'wg-journey-keystone__body');
            body.appendChild(el('span', 'wg-journey-keystone__title', k.title || 'Milestone'));
            if (k.text) body.appendChild(el('span', 'wg-journey-keystone__text wg-muted', k.text));
            const date = keystoneDateLabel(k.earned_at);
            if (date) body.appendChild(el('span', 'wg-journey-keystone__date wg-muted', date));
            row.appendChild(body);
            list.appendChild(row);
        });
        card.appendChild(list);
        return card;
    }

    // --- AI narration (Phase 6) -------------------------------------------
    // Opt-in, BYO-key prose OVER the deterministic cards. The card only mounts
    // in cloud mode (bot mode 404s /api/gamification/narrate → null → omitted).
    // Every button is purely additive: tapping POSTs a narrate route that hands
    // the user's OWN provider the already-computed stats-JSON and returns prose,
    // dropped into a SEPARATE attributed block. Numbers on screen still come
    // from the deterministic cards above — this never replaces a value, and a
    // no-key/error response ({text:null}) shows an honest hint instead.
    function narrateInto(kind, outEl, btn) {
        outEl.replaceChildren(el('p', 'wg-journey-narrator__status wg-muted', 'Narrating with your AI…'));
        btn.disabled = true;
        return Promise.resolve(experimentApiCall(`/api/gamification/narrate/${kind}`, 'POST', {}))
            .then((res) => {
                btn.disabled = false;
                if (res && res.text) {
                    const block = el('div', 'wg-journey-narrator__prose');
                    block.appendChild(el('span', 'wg-tag wg-tag--mono wg-journey-narrator__attr', 'narrated by your AI'));
                    block.appendChild(el('p', 'wg-journey-narrator__text', res.text));
                    outEl.replaceChildren(block);
                } else {
                    outEl.replaceChildren(el('p', 'wg-journey-narrator__status wg-muted',
                        'AI narration unavailable — add an OpenAI key in Settings → Integrations to enable it.'));
                }
            })
            .catch(() => {
                btn.disabled = false;
                outEl.replaceChildren(el('p', 'wg-journey-narrator__status wg-muted',
                    'AI narration is unavailable right now — your story above is unaffected.'));
            });
    }

    function narratorButton(label, kind, outEl) {
        const btn = el('button', 'btn btn-sm btn-secondary', label);
        btn.type = 'button';
        btn.addEventListener('click', () => narrateInto(kind, outEl, btn));
        return btn;
    }

    function renderNarrator(j) {
        const n = j && j.narration;
        if (!n || n.enabled === false) return null;

        const card = el('section', 'wg-card wg-journey-narrator');
        card.id = 'journey-narrator-card';
        card.appendChild(el('div', 'wg-section-label', 'AI STORY'));
        card.appendChild(el('p', 'wg-journey-narrator__note wg-muted',
            'Optional. Each button sends your already-computed health summaries — never raw logs — to your own AI provider for a few sentences of prose. Every number above stays deterministic.'));

        const out = el('div', 'wg-journey-narrator__out');
        const buttons = el('div', 'wg-journey-narrator__buttons');
        buttons.appendChild(narratorButton('Narrate my week', 'weekly', out));
        buttons.appendChild(narratorButton('Workout insight', 'workout', out));
        if (j && j.chapter && j.chapter.review) {
            buttons.appendChild(narratorButton('Chapter recap', 'chapter', out));
        }
        if (j && j.experiments && j.experiments.can_start) {
            buttons.appendChild(narratorButton('Experiment idea', 'experiments', out));
        }
        card.appendChild(buttons);
        card.appendChild(out);
        return card;
    }

    function render(journey) {
        const content = document.getElementById('journey-content');
        if (!content) return;

        // The narrative layer (chapter / atlas / experiment / traits /
        // keystones) leads the feed and stands on its own: in cloud mode the HP/
        // levels/rings substrate is a later phase (returns {enabled:false}), so a
        // disabled substrate with a live narrative layer still renders it rather
        // than the "gamification is off" empty state (insight leads).
        const chapterCard = journey ? renderChapter(journey) : null;
        const atlasCard = journey ? renderAtlas(journey) : null;
        const experimentCard = journey ? renderExperiment(journey) : null;
        const traitsCard = journey ? renderTraits(journey) : null;
        const keystonesCard = journey ? renderKeystones(journey) : null;
        const narratorCard = journey ? renderNarrator(journey) : null;
        const narrativeCards = [chapterCard, experimentCard, atlasCard, traitsCard, keystonesCard, narratorCard];

        if (!journey || journey.enabled === false) {
            const live = narrativeCards.filter(Boolean);
            if (live.length > 0) {
                content.replaceChildren(...live);
                return;
            }
            renderEmpty(content, 'Gamification is off. Enable it in Settings to start your Journey.');
            return;
        }

        const cards = [
            chapterCard,
            experimentCard,
            atlasCard,
            renderHeader(journey),
            renderExplainer(),
            renderHealthScore(journey),
            renderWeeklyReview(journey),
            renderGauges(journey),
            renderStrengths(journey),
            traitsCard,
            renderRings(journey),
            renderHistory(journey),
            renderInsightCard(journey),
            renderGoodDayCard(journey),
            keystonesCard,
            narratorCard,
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

    // Fetches the Gauges read model through its own cachedFetch entry (Task
    // 4) — unlike the tier-3 insight, this isn't ladder-gated: it's fetched
    // whenever the Journey payload loads. A cold cache offline read renders
    // an explicit empty state on the card rather than omitting it silently.
    async function loadGauges() {
        try {
            const result = await window.cachedFetch(GAUGES_CACHE_KEY, GAUGES_URL, {
                tags: ['gamification'],
                freshAfterMs: 60_000,
                staleAfterMs: STALE_AFTER_MS,
            });
            return result ? result.data : null;
        } catch (e) {
            if (window.OfflineNoCacheError && e instanceof window.OfflineNoCacheError) {
                return { emptyState: 'No cached gauge data — connect to load.' };
            }
            console.error('Failed to load gamification gauges:', e);
            return null;
        }
    }

    // Fetches the Weekly Review read model through its own cachedFetch entry
    // (Task 3) — like Gauges, fetched whenever the Journey payload loads. A
    // cold cache offline read renders an explicit empty state on the card
    // rather than omitting it silently.
    async function loadWeeklyReview() {
        try {
            const result = await window.cachedFetch(WEEKLY_CACHE_KEY, WEEKLY_URL, {
                tags: ['gamification'],
                freshAfterMs: 60_000,
                staleAfterMs: STALE_AFTER_MS,
            });
            return result ? result.data : null;
        } catch (e) {
            if (window.OfflineNoCacheError && e instanceof window.OfflineNoCacheError) {
                return { emptyState: 'No cached weekly review — connect to load.' };
            }
            console.error('Failed to load gamification weekly review:', e);
            return null;
        }
    }

    // Fetches the Discovery Atlas read model through its own cachedFetch entry
    // (Phase 1). Cloud mode serves it from the vault client-side; bot mode 404s
    // the route, which surfaces here as a null (no Atlas card) — the substrate
    // Journey renders unchanged. A cold-cache offline read shows an explicit
    // empty state on the card rather than omitting it silently.
    const ATLAS_CACHE_KEY = 'gamification_atlas';
    const ATLAS_URL = '/api/gamification/atlas';
    async function loadAtlas() {
        try {
            const result = await window.cachedFetch(ATLAS_CACHE_KEY, ATLAS_URL, {
                tags: ['gamification'],
                freshAfterMs: 60_000,
                staleAfterMs: STALE_AFTER_MS,
            });
            return result ? result.data : null;
        } catch (e) {
            if (window.OfflineNoCacheError && e instanceof window.OfflineNoCacheError) {
                return { emptyState: 'No cached discoveries — connect to load.' };
            }
            // A 404 (bot mode, no Atlas route) or any other error → no card.
            return null;
        }
    }

    // Fetches the Self-Experiments read model (Phase 4). Stateful (persisted
    // trials), so it reads through offlineAwareApiCall rather than cachedFetch —
    // the atlas/journey cachedFetch calls already satisfy the offline-coverage
    // guard for this file. Bot mode 404s the route → null → no experiment card.
    function loadExperiments() {
        const call = window.offlineAwareApiCall || window.apiCallDirect;
        if (typeof call !== 'function') return Promise.resolve(null);
        return Promise.resolve(call('/api/gamification/experiments', 'GET')).catch(() => null);
    }

    // Narrative-layer loaders (Phase 5) — chapters/traits/keystones. Stateful
    // (persisted in the journal singleton), so like experiments they read
    // through offlineAwareApiCall rather than cachedFetch; the atlas/journey
    // cachedFetch calls already satisfy the offline-coverage guard for this
    // file. Bot mode 404s each route → null → the card is omitted.
    function loadNarrative(endpoint) {
        const call = window.offlineAwareApiCall || window.apiCallDirect;
        if (typeof call !== 'function') return Promise.resolve(null);
        return Promise.resolve(call(endpoint, 'GET')).catch(() => null);
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
            if (data) {
                data.gauges = await loadGauges();
                data.weekly_review = await loadWeeklyReview();
            }
            // The narrative layer is fetched whether or not the substrate is
            // enabled: in cloud mode the substrate returns {enabled:false} but
            // the Atlas/chapters/traits/keystones are the whole point of the
            // screen, so they must still render.
            const [atlas, experiments, chapter, traits, keystones, narration] = await Promise.all([
                loadAtlas(), loadExperiments(),
                loadNarrative('/api/gamification/chapter'),
                loadNarrative('/api/gamification/traits'),
                loadNarrative('/api/gamification/keystones'),
                loadNarrative('/api/gamification/narrate'),
            ]);
            if (atlas || experiments || chapter || traits || keystones || narration) {
                const narrative = { atlas, experiments, chapter, traits, keystones, narration };
                if (!data) render({ enabled: false, ...narrative });
                else { Object.assign(data, narrative); render(data); }
                await mountBadge();
                return;
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
