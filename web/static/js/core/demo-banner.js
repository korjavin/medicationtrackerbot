// Demo-mode affordances — mounted from /api/bootstrap when the server
// runs with DEMO_MODE=1. Two responsibilities:
//
//   1. mount(demo)          — renders a dismissible #demo-banner row at
//                              the top of the app explaining that this is
//                              a public, shared, rate-limited demo. Dismiss
//                              persists in localStorage keyed by a hash of
//                              the current limits so a change in restrictions
//                              re-surfaces the banner on the next visit.
//
//   2. showDemoLimitAlert(parsed)
//                            — invoked by core/api.js when a request
//                              returns 429 with a JSON body shaped
//                              {error:'demo_rate_limit', limit, retry_after_seconds}.
//                              Formats a human-readable popup quoting the
//                              demo restriction and routes it through
//                              window.safeAlert (or alert) so it surfaces
//                              regardless of host adapter.
//
// Loaded after core/utils.js (for safeAlert) and before core/api.js's
// runtime call sites; both consumers resolve window.DemoBanner lazily
// at call time so strict load order is not required.

(function () {
    const STORAGE_KEY = 'demoBannerDismissed';

    // Cached limits captured at mount time so showDemoLimitAlert can quote
    // the actual count without round-tripping back to the server.
    let cachedLimits = null;

    function limitsHash(limits) {
        if (!limits || typeof limits !== 'object') return '';
        return JSON.stringify({
            a: Number(limits.agent_calls_per_day) || 0,
            fl: Number(limits.food_logs_per_hour) || 0,
            fp: Number(limits.food_photos_per_hour) || 0,
            fd: Number(limits.food_descriptions_per_hour) || 0,
        });
    }

    function limitCount(label) {
        if (!cachedLimits || typeof cachedLimits !== 'object') return null;
        switch (label) {
            case 'agent_calls': return Number(cachedLimits.agent_calls_per_day) || null;
            case 'food_log': return Number(cachedLimits.food_logs_per_hour) || null;
            case 'food_log_from_photo': return Number(cachedLimits.food_photos_per_hour) || null;
            case 'food_log_from_description': return Number(cachedLimits.food_descriptions_per_hour) || null;
            default: return null;
        }
    }

    function limitUnitPhrase(label, count) {
        const plural = count !== 1;
        switch (label) {
            case 'agent_calls': return plural ? 'voice agent calls' : 'voice agent call';
            case 'food_log': return plural ? 'manual food logs' : 'manual food log';
            case 'food_log_from_photo': return plural ? 'food-from-photo entries' : 'food-from-photo entry';
            case 'food_log_from_description': return plural ? 'food-from-text entries' : 'food-from-text entry';
            default: return plural ? 'requests' : 'request';
        }
    }

    function windowPhrase(retryAfterSeconds) {
        const n = Number(retryAfterSeconds);
        if (!Number.isFinite(n) || n <= 0) return 'while';
        if (n >= 24 * 3600) return 'day';
        if (n >= 3600) return 'hour';
        if (n >= 60) return 'minute';
        return 'second';
    }

    function formatLimitMessage(parsed) {
        const p = parsed || {};
        const count = limitCount(p.limit) || 1;
        const unit = limitUnitPhrase(p.limit, count);
        const win = windowPhrase(p.retry_after_seconds);
        return `Demo restriction: only ${count} ${unit} per ${win}. Try again later.`;
    }

    function hideBanner(slot) {
        slot.classList.add('hidden');
        slot.setAttribute('hidden', '');
        slot.replaceChildren();
    }

    // Sections that depend on auth-protected, operator-scoped functionality
    // (Integrations panel writes shared API keys to the singleton settings
    // row — backend correctly returns 403 in demo mode, so the UI must not
    // pretend the form is interactive). Each entry is an element id whose
    // section is removed from the DOM when demo.enabled=true.
    const DEMO_HIDDEN_SECTION_IDS = ['settings-integrations'];

    function applyDemoSectionVisibility(enabled) {
        if (typeof document === 'undefined') return;
        for (const id of DEMO_HIDDEN_SECTION_IDS) {
            const el = document.getElementById(id);
            if (!el) continue;
            if (enabled) {
                el.setAttribute('hidden', '');
                el.classList.add('hidden');
            } else {
                el.removeAttribute('hidden');
                el.classList.remove('hidden');
            }
        }
    }

    function mount(demo) {
        const slot = (typeof document !== 'undefined')
            ? document.getElementById('demo-banner')
            : null;
        if (!slot || typeof slot.replaceChildren !== 'function') {
            applyDemoSectionVisibility(!!(demo && demo.enabled));
            return false;
        }

        if (!demo || !demo.enabled) {
            cachedLimits = null;
            hideBanner(slot);
            applyDemoSectionVisibility(false);
            return false;
        }

        applyDemoSectionVisibility(true);

        const limits = (demo.limits && typeof demo.limits === 'object') ? demo.limits : {};
        cachedLimits = limits;
        const hash = limitsHash(limits);

        try {
            const dismissed = window.localStorage.getItem(STORAGE_KEY);
            if (dismissed && dismissed === hash) {
                hideBanner(slot);
                return false;
            }
        } catch (_) { /* localStorage unavailable — fall through and render */ }

        slot.classList.remove('hidden');
        slot.removeAttribute('hidden');
        slot.classList.add('wg-demo-banner');

        const msg = document.createElement('span');
        msg.className = 'wg-demo-banner__text';
        msg.textContent = 'Demo version — data is shared across visitors and may reset. AI features are rate-limited.';

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'wg-demo-banner__dismiss';
        dismissBtn.setAttribute('aria-label', 'Dismiss demo banner');
        dismissBtn.textContent = '×';
        dismissBtn.addEventListener('click', () => {
            try {
                window.localStorage.setItem(STORAGE_KEY, hash);
            } catch (_) { /* best-effort */ }
            hideBanner(slot);
        });

        slot.replaceChildren(msg, dismissBtn);
        return true;
    }

    function showDemoLimitAlert(parsed) {
        const message = formatLimitMessage(parsed);
        if (typeof window.safeAlert === 'function') {
            window.safeAlert(message);
        } else if (typeof window.alert === 'function') {
            window.alert(message);
        }
        return message;
    }

    // Inspects a Response that may be a 429 demo_rate_limit. If so, surfaces
    // the formatted popup and returns the parsed body so callers can throw
    // a typed error. Returns null when the response is not a demo limit hit.
    // Used by bare-fetch call sites (multipart uploads, FormData posts) that
    // cannot go through apiCallDirect's 429 branch.
    //
    // Reads the body on a cloned response so callers can still call
    // `res.text()` themselves on a non-demo 429 (e.g. proxy-injected) without
    // getting an empty string — Response bodies are one-shot streams and
    // consuming the original here would silently strip diagnostic detail.
    async function tryHandleResponse(res) {
        if (!res || res.status !== 429) return null;
        const probe = (typeof res.clone === 'function') ? res.clone() : res;
        let txt;
        try { txt = await probe.text(); } catch (_) { return null; }
        let parsed = null;
        try { parsed = JSON.parse(txt); } catch (_) { return null; }
        if (!parsed || parsed.error !== 'demo_rate_limit') return null;
        showDemoLimitAlert(parsed);
        return parsed;
    }

    window.DemoBanner = {
        mount,
        showDemoLimitAlert,
        formatLimitMessage,
        limitsHash,
        tryHandleResponse,
    };
})();
