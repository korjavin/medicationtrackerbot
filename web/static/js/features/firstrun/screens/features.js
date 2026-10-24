// features/firstrun/screens/features.js — W1, the first-run module picker
// (bd med-ta2n.1, screens-onboarding-v3.html W1). The first and only picker
// screen: seven kit check choices, nothing preselected, "Continue with N",
// Skip = everything on.
//
// Rows ↔ feature flags. Six rows are tracking sections, each a key in the
// cloud shim's PORTED_SET (web/cloud/js/apishim.js), so every write here can
// stick in every build that renders the overlay. Sleep is the Vitals section
// (`health`). Diary has NO flag (the notes section has none, owner decision
// 2026-10-20): picking it drives the W3 Today hints and keeps `health` on,
// since the notes live in Vitals (bd med-ta2n.21). Deliberately not
// rows: `gamification` (not a tracking section), `weekly_digest` (bot-only
// Telegram summary), `live_hr` (an experimental Vitals sub-feature).
//
// Write path: Continue/Skip persist an EXPLICIT boolean for all six flags,
// not just the picks (med-t05.1). web/domain/settings.js DEFAULT_FEATURES is
// all-on and getFeatures() spreads it under the stored flags, so a flag this
// screen showed unpicked but never wrote would come back ON. DEFAULT_FEATURES
// itself must stay all-on — it is also the fallback for existing accounts.
// Writes reuse the Settings global `toggleFeatureSetting` (POST, SettingsState
// mirror, bottom-nav rebuild, DataStore invalidation); the `fetch` fallback is
// for the Vitest harness, which loads the firstrun modules alone. Taps only
// flip the choice; nothing is written until Continue/Skip.
//
// Then helpers.finishPicker(picked) stores the picks (POSTed as `picked` with
// /api/firstrun/complete, W1 order, incl. 'diary') and moves on to the trial
// offer or completes.
//
// Footer "Have an invite?" (F1) renders only in a v3 shell in local mode with
// no invite already waiting: foundation.has('invite.pending') AND
// :root.wg-local-vault AND invite.pending → null. Hidden on the web, in
// account mode, and while a slot exists (W1 · invited). It dispatches
// `wg:invite-open` on document; the F1 sheet (med-ta2n.6) listens.
(function () {
    'use strict';

    var FEATURES_URL = '/api/settings/features';
    var INVITE_EVENT = 'wg:invite-open';

    // W1 order. `flag: false` = no feature flag behind the row.
    var CATALOG = [
        { key: 'medication', label: 'Medications', copy: 'Doses, reminders, stock', icon: 'pill' },
        { key: 'bp', label: 'Blood pressure', copy: 'Readings and trends', icon: 'activity' },
        { key: 'weight', label: 'Weight', copy: 'Progress to a goal', icon: 'scale' },
        { key: 'workout', label: 'Workouts', copy: 'Plans and sets', icon: 'dumbbell' },
        { key: 'health', label: 'Sleep', copy: 'From your watch or by hand', icon: 'moon' },
        { key: 'food', label: 'Food', copy: 'Meals and calories', icon: 'food' },
        { key: 'diary', label: 'Diary', copy: 'How you feel, in a line', icon: 'note', flag: false },
    ];

    function _el(tag, className, text) {
        var el = document.createElement(tag);
        if (className) el.className = className;
        if (text) el.textContent = text;
        return el;
    }

    // Account mode (med-5vy0): a new account starts on Generic lock-screen
    // text, as local mode does. The empty PUT stores the current pref (Generic
    // when none is stored) before any medication exists, so the Detailed floor
    // for existing accounts (web/cloud/js/reminders.js) never fires for it. A
    // re-run with medications skips it: that account keeps what it has. Part
    // of the W1 save: a failed write (apiCall answers null or rejects) keeps
    // W1 open with its error, so first run never completes without the pref.
    function _keepReminderText() {
        if (document.documentElement.classList.contains('wg-local-vault')) return Promise.resolve();
        if (typeof window.apiCall !== 'function') return Promise.resolve();
        if (Array.isArray(window.medications) && window.medications.length) return Promise.resolve();
        return Promise.resolve(window.apiCall('/api/settings/reminder-delivery', 'PUT', {})).then(function (pref) {
            if (!pref || !pref.verbosity) throw new Error('reminder text pref not saved');
        });
    }

    function _isEnabled(key) {
        var flags = window.featureSettings;
        if (!flags || typeof flags !== 'object' || typeof flags[key] !== 'boolean') return true;
        return flags[key];
    }

    function _writeFeature(key, enabled) {
        if (typeof window.toggleFeatureSetting === 'function') {
            // Resolves whether or not the POST succeeded, so re-read the
            // mirror to find out what actually stuck.
            return Promise.resolve(window.toggleFeatureSetting(key, enabled))
                .then(function () {
                    if (_isEnabled(key) !== enabled) throw new Error('rejected');
                });
        }
        return window.fetch(FEATURES_URL + '/' + encodeURIComponent(key), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: enabled }),
        }).then(function (resp) {
            if (!resp || !resp.ok) throw new Error('rejected');
        });
    }

    // Sequential, not parallel: the cloud shim's setFeature reads the whole
    // flags map, mutates one key and puts it back, so concurrent writes would
    // last-write-wins each other's keys away.
    function _persistAll(picked) {
        return CATALOG.reduce(function (chain, item) {
            if (item.flag === false) return chain;
            return chain.then(function () {
                // Diary's notes live in Vitals: picking it keeps `health` on
                // even without Sleep (bd med-ta2n.21).
                var on = picked.indexOf(item.key) !== -1
                    || (item.key === 'health' && picked.indexOf('diary') !== -1);
                return _writeFeature(item.key, on);
            });
        }, Promise.resolve());
    }

    function _renderChoice(item) {
        var btn = _el('button', 'wg-choice wg-choice--check');
        btn.type = 'button';
        btn.setAttribute('aria-pressed', 'false');
        btn.setAttribute('data-firstrun-feature', item.key);
        var text = _el('span', null, item.label);
        text.appendChild(_el('span', 'wg-choice__sub', item.copy));
        var trail = _el('span', 'wg-choice__trail wg-muted');
        var ico = _el('i', 'wg-ico');
        ico.setAttribute('data-icon', item.icon);
        trail.appendChild(ico);
        btn.append(text, trail);
        return btn;
    }

    function _showInviteInLocalShell(row) {
        if (!document.documentElement.classList.contains('wg-local-vault')) return;
        var native = window.LocalNotifications && window.LocalNotifications.__native;
        if (!native || typeof native.has !== 'function') return;
        Promise.resolve(native.has('invite.pending'))
            .then(function (has) {
                if (!has) return null;
                return Promise.resolve(native.call('invite.pending')).then(function (slot) {
                    if (slot || !row.isConnected) return;
                    var invite = _el('button', 'wg-btn wg-btn--ghost wg-btn--sm', 'Have an invite?');
                    invite.type = 'button';
                    invite.setAttribute('data-firstrun-action', 'invite');
                    invite.addEventListener('click', function () {
                        document.dispatchEvent(new window.CustomEvent(INVITE_EVENT));
                    });
                    row.appendChild(invite);
                });
            })
            .catch(function () { /* no invite entry: the footer keeps Skip only */ });
    }

    // W1 footnote (bd med-ta2n.28, contract med-ta2n.24 §D): the disclaimer and
    // links the deleted native first-run screens carried. "Want it on every
    // device? Get an invite" (IM1, bd med-er5x) is local mode only: the W5 request sheet when the shell can
    // base.post, else the base landing page, else nothing.
    var PRIVACY_URL = 'https://cloud.myhealthbot.ai/privacy';
    var DISCLAIMER = 'Med Tracker is a personal log, not a medical device, and does not give medical advice. Talk to your doctor before changing a treatment.';

    function _externalLink(text, href) {
        var a = _el('a', 'wg-link', text);
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        return a;
    }

    function _renderFootnote(body) {
        body.appendChild(_el('p', 'wg-shell__fine', DISCLAIMER));
        var links = _el('div', 'wg-hstack wg-firstrun-links');
        var privacy = _externalLink('Privacy policy', PRIVACY_URL);
        privacy.setAttribute('data-firstrun-link', 'privacy');
        links.append(privacy, _el('span', 'wg-spacer'));
        body.appendChild(links);
        _showInviteHowTo(links);
    }

    function _showInviteHowTo(links) {
        var sheet = window.InviteSheet;
        if (!document.documentElement.classList.contains('wg-local-vault')) return;
        if (!sheet || typeof sheet.request !== 'function') return;
        Promise.resolve(typeof sheet.canRequest === 'function' ? sheet.canRequest() : false)
            .then(function (can) {
                if (can === true) return { request: true };
                return Promise.resolve(typeof sheet.base === 'function' ? sheet.base() : '')
                    .then(function (base) { return { base: base }; });
            })
            .then(function (how) {
                if (!links.isConnected) return;
                var link;
                if (how.request) {
                    link = _el('button', 'wg-link', 'Get an invite');
                    link.type = 'button';
                    link.addEventListener('click', function () { sheet.request(); });
                } else if (how.base) {
                    link = _externalLink('Get an invite', 'https://' + how.base + '/');
                } else return;
                link.setAttribute('data-firstrun-link', 'invite-howto');
                // IM1 (bd med-er5x): one line of value, the first fact.
                var line = _el('span', 'wg-shell__fine', 'Want it on every device? ');
                line.setAttribute('data-firstrun-invite-line', '');
                line.appendChild(link);
                links.appendChild(line);
            })
            .catch(function () { /* no invite path: Privacy policy only */ });
    }

    function render(body, helpers) {
        body.appendChild(_el('p', 'wg-shell__lede', 'Pick any. You can change this later in Settings.'));

        var list = _el('div', 'wg-choices');
        var choices = CATALOG.map(function (item) {
            var btn = _renderChoice(item);
            list.appendChild(btn);
            return btn;
        });
        body.appendChild(list);

        var error = _el('p', 'wg-firstrun-form__error');
        error.setAttribute('data-firstrun-feature-error', '');
        body.appendChild(error);

        var foot = _el('div', 'wg-firstrun-foot');
        var cont = _el('button', 'wg-btn wg-btn--primary wg-btn--lg wg-btn--block', 'Continue');
        cont.type = 'button';
        cont.setAttribute('data-firstrun-action', 'continue');
        var row = _el('div', 'wg-hstack');
        var skip = _el('button', 'wg-btn wg-btn--ghost wg-btn--sm', 'Skip');
        skip.type = 'button';
        // The id the QA scenarios (android/qa smoke) wait on, kept from the
        // old welcome screen's "Skip all".
        skip.setAttribute('data-firstrun-action', 'skip-all');
        row.append(skip, _el('span', 'wg-spacer'));
        foot.append(cont, row);
        body.appendChild(foot);
        _renderFootnote(body);

        function picks() {
            return CATALOG.filter(function (_, i) {
                return choices[i].getAttribute('aria-pressed') === 'true';
            }).map(function (item) { return item.key; });
        }
        function paintCount() {
            var n = picks().length;
            cont.textContent = n ? 'Continue with ' + n : 'Continue';
        }
        function busy(on) {
            choices.concat([cont, skip]).forEach(function (b) { b.disabled = on; });
        }
        // 0 picks = Skip: everything on, all seven picked.
        function finish(picked) {
            if (!picked.length) picked = CATALOG.map(function (item) { return item.key; });
            busy(true);
            error.textContent = '';
            _persistAll(picked)
                .then(_keepReminderText)
                .then(function () { return helpers.finishPicker(picked); })
                .catch(function () {
                    // Moving on now would leave unpicked sections silently ON
                    // (an unwritten flag falls back to DEFAULT_FEATURES).
                    busy(false);
                    error.textContent = 'Couldn’t save your choices. Check your connection and try again — you can also adjust this later in Settings.';
                });
        }

        choices.forEach(function (btn) {
            btn.addEventListener('click', function () {
                btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
                paintCount();
            });
        });
        cont.addEventListener('click', function () { finish(picks()); });
        skip.addEventListener('click', function () { finish([]); });

        // Medications: "Reminders won't fire" under the row while it is picked
        // and notifications are off for this device (med-ckm5.4, kit O3). A
        // sibling of the choice: the note may hold a button.
        if (window.NotifyPermission) {
            var med = choices[0];
            var slot = _el('div', 'wg-notify-slot');
            slot.setAttribute('data-firstrun-notify-note', '');
            med.after(slot);
            med.addEventListener('click', function () {
                // askNow: picking Medications is the context to ask in (med-1ikf).
                if (med.getAttribute('aria-pressed') === 'true') window.NotifyPermission.renderNote(slot, { askNow: true });
                else slot.replaceChildren();
            });
        }

        if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(body);
        _showInviteInLocalShell(row);
    }

    window.WGFirstRun = window.WGFirstRun || {};
    window.WGFirstRun.screens = window.WGFirstRun.screens || {};
    window.WGFirstRun.screens.features = {
        title: 'What do you want to track?',
        brand: true,
        render: render,
        CATALOG: CATALOG,
    };
})();
