// Tomorrow Forecast card (Gamification Phase 3, §3.4 of the redesign).
//
// The evening "open loop": one card on Today that reads tonight's actionable
// lever (an adequate night's sleep) against the user's OWN history and quotes a
// personalized in-range-morning chance — then, the next morning after the BP
// log, resolves forecast vs actual. Alongside it a "how well do we know you"
// calibration meter: the honest progress bar that gives a reason to return
// daily without any push notification (Zeigarnik open loop).
//
// Every number is recomputed client-side from vault records by
// web/domain/gamification.js (getForecast) and served through the cloud apishim
// at GET /api/gamification/forecast. In bot mode that route 404s, refresh()
// caches null, and the card omits itself entirely.
//
// Lifecycle mirrors tz-plan-banner.js:
//   refresh()       — fetches the forecast, caches it, reloads Today if the
//                     presence of a card changed (so it appears without a
//                     manual refresh).
//   mountCard(root) — synchronously appends the card from cached state; Today's
//                     renderer calls it once per render.

(function () {
    let cached = null; // last forecast payload, or null (no card)

    function reloadTab() {
        try {
            if (typeof window.reloadCurrentTab === 'function') {
                window.reloadCurrentTab();
            }
        } catch (e) {
            console.warn('forecast: reloadCurrentTab failed', e);
        }
    }

    // A payload is renderable when it carries either a forecast surface (evening
    // card / morning resolution) or a calibration meter to fill. getForecast
    // always returns a calibration meter, so any enabled payload renders.
    function renderable(f) {
        return !!(f && f.enabled && (f.evening || f.resolution || f.calibration));
    }

    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    // Reuses the Journey progress-bar contract: the fill width is driven by the
    // neutral --fill-pct custom property (no hardcoded visual value in JS),
    // exactly as journey.js's progressBar does.
    function meterBar(fraction) {
        const track = el('div', 'wg-gloss--inset wg-journey-bar__track');
        const fill = el('div', 'wg-journey-bar__fill wg-journey-bar__fill--sun');
        let pct = Number(fraction);
        if (!Number.isFinite(pct)) pct = 0;
        pct = Math.max(0, Math.min(1, pct));
        fill.style.setProperty('--fill-pct', `${(pct * 100).toFixed(1)}%`);
        track.appendChild(fill);
        return track;
    }

    function buildCard(f) {
        const card = el('section', 'wg-card wg-forecast-card');
        card.id = 'today-forecast-card';
        card.setAttribute('data-section', 'forecast');
        card.appendChild(el('div', 'wg-section-label', 'TOMORROW FORECAST'));

        // Morning phase leads with the resolution when this morning's reading is
        // in; every other time (and always in the evening) leads with the
        // prospective card. A resolution only exists once the model is calibrated.
        const leadMorning = f.phase === 'morning' && f.resolution;
        if (leadMorning) {
            card.appendChild(el('p', 'wg-forecast-card__resolution', f.resolution.text));
        } else if (f.evening) {
            card.appendChild(el('p', 'wg-forecast-card__evening', f.evening.text));
            // In the morning, still surface the resolution below the evening line
            // if one happens to be present.
            if (f.resolution) {
                card.appendChild(el('p', 'wg-forecast-card__resolution wg-muted', f.resolution.text));
            }
        }

        // Calibration meter — always present; the honest open loop.
        const cal = f.calibration;
        if (cal) {
            card.appendChild(meterBar(cal.fraction));
            card.appendChild(el('p', 'wg-forecast-card__calibration wg-muted', cal.label));
        }
        return card;
    }

    function mountCard(root) {
        if (!root) return null;
        if (!renderable(cached)) return null;
        const card = buildCard(cached);
        root.appendChild(card);
        return card;
    }

    async function refresh() {
        const was = renderable(cached);
        try {
            if (typeof window.apiCall !== 'function') return;
            const result = await window.apiCall('/api/gamification/forecast', 'GET');
            cached = renderable(result) ? result : null;
        } catch (e) {
            // 404 (bot mode / no route) or any transient error → no card. Silent:
            // a missing forecast must never surface as an error toast.
            cached = null;
        }
        if (was !== renderable(cached)) reloadTab();
    }

    window.WGForecastCard = { refresh, mountCard };
})();
