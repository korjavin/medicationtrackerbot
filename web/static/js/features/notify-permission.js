// features/notify-permission.js — notification permission, asked in context
// (bd med-ckm5.4, kit O3; covers med-1ikf).
//
// window.NotifyPermission:
//   state()         → 'granted' | 'denied' | 'default' | 'unsupported' for this
//                     device: the app shell's LocalNotifications permission, else
//                     the browser's Notification.permission.
//   maybeAsk()      → the kit sheet "Let Med Tracker remind you", then the one
//                     system prompt on Allow. Only while the permission is
//                     'default' and this device was never asked; resolves true
//                     only when this call newly granted it. Called by
//                     web/cloud/js/reminders.js when a write-triggered schedule
//                     has items for this device — never at launch.
//   renderNote(el, {askNow}) → fills el with the "Reminders won't fire" warn
//                     note when the permission is denied, or still 'default'
//                     after "Not now" (or askNow); empties it otherwise. While
//                     undecided the note's button is the one-tap system prompt
//                     (med-1ikf); denied offers the OS settings path. Shared by the med editor's
//                     Times section, the first-run features screen and
//                     Settings → Reminders & notifications (S8, med-ckm5.8).
//   reminderHint(slot) → kit RD3 (med-mt0l): the one-time "Want the medication
//                     name on the lock screen?" line on a take sheet opened from
//                     a reminder. Generic pref, once per device, both modes.
//
// The lock-screen choice (kit RD1/RD2, med-mt0l; account mode too since
// med-5vy0): the ask sheet and, after the first-run one-tap grant, a "What
// should reminders show?" sheet carry S8's Generic / Detailed pair. Saved
// however the sheet closes (Not now too), through the same PUT
// /api/settings/reminder-delivery S8 uses. A changed pick is a real write.
// Closed untouched, local mode writes nothing and account mode stores Generic
// as a floored default ({floor: 'generic'}: clientTs 1, only when no pref is
// stored), so skipping never overwrites another device's pick.
(function () {
    'use strict';

    var ASKED_KEY = 'wg.notifyPermission.asked';
    var HINT_KEY = 'wg.reminderDetailHint.shown';
    var DELIVERY_PATH = '/api/settings/reminder-delivery';
    var OPEN_SETTINGS_OP = 'notifications.openSettings';

    function isLocal() {
        return document.documentElement.classList.contains('wg-local-vault');
    }

    // The app shell's capability, or null on the web (the native/ stub throws
    // until an impl registers).
    function shell() {
        try {
            var ln = window.LocalNotifications;
            return ln && ln.isSupported && ln.isSupported() === true ? ln : null;
        } catch (_) {
            return null;
        }
    }

    async function state() {
        var ln = shell();
        if (ln) {
            try { return await ln.permission(); } catch (_) { return 'unsupported'; }
        }
        if (typeof Notification === 'undefined') return 'unsupported';
        return Notification.permission;
    }

    function asked() {
        try { return window.localStorage.getItem(ASKED_KEY) === '1'; } catch (_) { return false; }
    }

    function markAsked() {
        try { window.localStorage.setItem(ASKED_KEY, '1'); } catch (_) { /* private mode: may ask again next session */ }
    }

    // The system prompt. Must start synchronously inside the Allow click: Safari
    // drops the transient activation across an await. On the web a grant then
    // subscribes this browser to the push relay (settings.js's Enable flow).
    function request() {
        var ln = shell();
        if (ln) {
            try {
                return Promise.resolve(ln.requestPermission()).catch(function () { return 'default'; });
            } catch (_) {
                return Promise.resolve('default');
            }
        }
        var ask = typeof window.requestNotificationPermissionNormalized === 'function'
            ? window.requestNotificationPermissionNormalized()
            : Promise.resolve('default');
        return ask.then(async function (permission) {
            if (permission !== 'granted') return permission;
            try {
                var push = await import('/js/push.js');
                await push.subscribe();
            } catch (e) {
                console.error('[notify-permission] push subscribe failed', e);
                if (typeof window.safeToast === 'function') {
                    window.safeToast((e && e.message) || 'Could not turn on reminders for this browser.', 'error');
                }
            }
            return permission;
        });
    }

    // A grant outside a schedule run: re-run this device's schedule now (the
    // shell dropped the earlier one), as Settings' Enable does — local-only
    // mode via local-policy.js's reschedule event, cloud via reminders.js.
    function rearm() {
        if (isLocal()) {
            document.dispatchEvent(new CustomEvent('wg:local-reminders-reschedule'));
            return;
        }
        var ctx = window.MedTrackerCloud && window.MedTrackerCloud.ctx;
        if (!ctx) return;
        import('/js/reminders.js')
            .then(function (m) { return m.recomputeAndPush(ctx); })
            .catch(function (e) { console.error('[notify-permission] reschedule failed', e); });
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }

    function icon(name) {
        var i = el('i', 'wg-ico');
        i.dataset.icon = name;
        return i;
    }

    function hydrate(root) {
        if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(root);
    }

    function button(className, text, attr, value) {
        var b = el('button', className, text);
        b.type = 'button';
        b.setAttribute(attr, value);
        return b;
    }

    // The lock-screen pref, the verbosity half of the vault's reminder
    // delivery pref (S8's path; the shim reschedules on a change). null when
    // it could not be read (apiCall answers null or throws).
    async function getVerbosity() {
        try {
            var pref = await window.apiCall(DELIVERY_PATH, 'GET');
            if (!pref) return null;
            // The resolved lock-screen value (med-5vy0); older shims send verbosity only.
            return (pref.lockscreen || pref.verbosity) === 'detailed' ? 'detailed' : 'generic';
        } catch (_) {
            return null;
        }
    }

    // A sheet closing with value: a change is the user's pick, stored as a
    // real write. Untouched is not a choice: local mode stores nothing, and
    // account mode stores Generic as a FLOORED default (med-5vy0, see the
    // header), which never overwrites a pick another device already made.
    function keepVerbosity(value, initial) {
        if (value !== (initial || 'generic')) {
            saveVerbosity(value);
        } else if (!isLocal()) {
            Promise.resolve(window.apiCall(DELIVERY_PATH, 'PUT', { floor: 'generic' })).catch(function (e) {
                console.error('[notify-permission] lock-screen default save failed', e);
            });
        }
    }

    // Resolves true once the pref reads back as value. apiCall already tells
    // the user about a failed write (and answers null), so this only reports.
    function saveVerbosity(value) {
        return Promise.resolve(window.apiCall(DELIVERY_PATH, 'PUT', { verbosity: value }))
            .then(function (pref) { return !!(pref && pref.verbosity === value); })
            .catch(function (e) {
                console.error('[notify-permission] lock-screen choice save failed', e);
                return false;
            });
    }

    // S8's preview line for a dose; Detailed names one of the user's own meds.
    function previewText(value) {
        if (value !== 'detailed') return 'Medication time';
        var meds = Array.isArray(window.medications) ? window.medications : [];
        var med = meds.find(function (m) { return m && !m.archived && m.name; });
        return 'Time to take: ' + (med ? med.name : 'Metformin');
    }

    // Kit RD1/RD2: S8's Generic / Detailed pair, the live preview under it and
    // the privacy line. value() is the current pick.
    function detailChoice(initial) {
        var value = initial || 'generic';
        var field = el('div', 'wg-field');
        var group = el('div', 'wg-choices');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', 'Lock-screen reminder text');
        group.setAttribute('data-notify-verbosity', '');
        var text = el('span', 'wg-notif__text', previewText(value));
        [['generic', 'Generic', '"Medication time"'], ['detailed', 'Detailed', 'The medication or measurement']].forEach(function (c) {
            var b = button('wg-choice', null, 'data-value', c[0]);
            var label = el('span', null, c[1]);
            label.appendChild(el('span', 'wg-choice__sub', c[2]));
            b.appendChild(label);
            b.setAttribute('aria-pressed', String(c[0] === value));
            b.addEventListener('click', function () {
                value = c[0];
                group.querySelectorAll('.wg-choice').forEach(function (o) {
                    o.setAttribute('aria-pressed', String(o === b));
                });
                text.textContent = previewText(value);
            });
            group.appendChild(b);
        });
        field.append(el('span', 'wg-label', 'On the lock screen, show'), group);

        var notif = el('div', 'wg-notif');
        notif.setAttribute('aria-live', 'polite');
        var mark = el('span', 'wg-mark');
        mark.appendChild(icon('pill'));
        var nbody = el('span', 'wg-notif__body');
        var app = el('span', 'wg-notif__app');
        app.append(el('span', null, 'Med Tracker'), el('span', null, 'now'));
        nbody.append(app, el('span', 'wg-notif__title', 'Med Tracker'), text);
        notif.append(mark, nbody);

        var hint = el('p', 'wg-hint', 'Anyone holding your phone can read the lock screen, even while it is locked.');
        return { nodes: [field, notif, hint], value: function () { return value; } };
    }

    // One runtime sheet on the confirm layer (over the W1 overlay too).
    // onClose(reason) runs once, whichever way it closes; close(reason)
    // returns false when it already had.
    function mountSheet(id, titles, bodyNodes, footNodes, onClose) {
        var modal = el('mt-modal', 'wg-modal wg-sheet wg-notify-ask');
        modal.id = id;
        var backdrop = el('div', 'mt-confirm-backdrop wg-sheet-backdrop');
        var body = el('div', 'wg-sheet__body');
        body.append.apply(body, bodyNodes);
        var foot = el('div', 'wg-sheet__foot');
        foot.append.apply(foot, footNodes);
        modal.append(el('div', 'wg-sheet__grab'), window.WGSheet.header(titles).el, body, foot);
        hydrate(modal);

        var settled = false;
        function close(reason) {
            if (settled) return false;
            settled = true;
            document.removeEventListener('keydown', onKeydown, true);
            window.ModalManager.close(modal.id);
            window.ModalManager.register(modal.id, null);
            modal.remove();
            backdrop.remove();
            onClose(reason);
            return true;
        }
        function onKeydown(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                close('dismiss');
            }
        }
        backdrop.addEventListener('click', function () { close('dismiss'); });
        document.addEventListener('keydown', onKeydown, true);
        document.body.append(backdrop, modal);
        window.ModalManager.register(modal.id, function () { close('dismiss'); });
        window.ModalManager.open(modal.id);
        var primary = foot.querySelector('.wg-btn--primary');
        try { if (primary) primary.focus(); } catch (_) { /* ignore */ }
        return close;
    }

    // Resolves true when Allow ended in a grant; false on Not now / Back / Esc.
    // verbosity: the saved lock-screen pref, the choice's starting value.
    function openSheet(verbosity) {
        return new Promise(function (resolve) {
            var facts = [
                ['bell', 'Only what you schedule', 'Doses, BP and weigh-ins. Nothing else.'],
                ['gear', 'Change it any time', 'Settings → Reminders & notifications.'],
            ];
            var list = el('ul', 'wg-facts wg-facts--sm');
            facts.forEach(function (f) {
                var li = el('li');
                var span = el('span');
                span.append(el('b', null, f[1]), f[2]);
                li.append(icon(f[0]), span);
                list.appendChild(li);
            });
            var choice = detailChoice(verbosity);

            var notNow = button('wg-btn wg-btn--ghost', 'Not now', 'data-notify-choice', 'not-now');
            var allow = button('wg-btn wg-btn--primary', 'Allow notifications', 'data-notify-choice', 'allow');
            var close = mountSheet('notify-permission-sheet', { eyebrow: 'Reminders', title: 'Let Med Tracker remind you' },
                [list].concat(choice.nodes), [notNow, allow], function (reason) {
                    markAsked();
                    // Kept whichever way the sheet closes, "Not now" too.
                    keepVerbosity(choice.value(), verbosity);
                    if (reason !== 'allow') resolve(false);
                });

            allow.addEventListener('click', function () {
                var asking = request(); // before anything else: keeps the click's activation
                if (!close('allow')) return;
                asking.then(function (p) { resolve(p === 'granted'); }, function () { resolve(false); });
            });
            notNow.addEventListener('click', function () { close('not-now'); });
        });
    }

    // Kit RD2: right after the first-run one-tap grant, the same choice with
    // "Done". Saved however it closes.
    async function openDetailSheet() {
        if (!window.WGSheet || !window.ModalManager || document.getElementById('notify-detail-sheet')) return;
        var verbosity = await getVerbosity();
        var choice = detailChoice(verbosity);
        var done = button('wg-btn wg-btn--primary', 'Done', 'data-notify-choice', 'done');
        var close = mountSheet('notify-detail-sheet', { eyebrow: 'Notifications are on', title: 'What should reminders show?' },
            choice.nodes.concat([el('p', 'wg-hint', 'Change it any time in Settings → Reminders & notifications.')]), [done],
            function () { keepVerbosity(choice.value(), verbosity); });
        done.addEventListener('click', function () { close('done'); });
    }

    var pending = null;
    function maybeAsk() {
        if (pending) return pending;
        pending = (async function () {
            if (asked() || !window.WGSheet || !window.ModalManager) return false;
            if ((await state()) !== 'default') return false;
            return openSheet(await getVerbosity());
        })().catch(function (e) {
            console.error('[notify-permission] ask failed', e);
            return false;
        }).finally(function () { pending = null; });
        return pending;
    }

    // Does the shell answer this bridge op? settings.js's page-wide probe.
    function nativeHas(op) {
        return typeof window.nativeHas === 'function' ? window.nativeHas(op) : Promise.resolve(false);
    }

    // undecided: still 'default' after "Not now" — the system prompt can still
    // be shown, and iOS Settings has no Notifications toggle until it was.
    // askNow: the first-run context, where a grant goes on to the RD2
    // lock-screen choice.
    async function buildNote(slot, undecided, askNow) {
        var ln = shell();
        var copy = (ln && ln.copy) || {};
        var android = copy.os === 'Android';
        var note = el('div', 'wg-note wg-note--warn');
        note.setAttribute('data-notify-denied', '');
        var body = el('div', 'wg-note__body');
        var text = el('span');
        // Android's permission() is 'granted' only with both grants, so either may be missing.
        text.append(el('b', null, 'Reminders won’t fire.'),
            ' Notifications are off for Med Tracker' + (android ? ', or Alarms & reminders isn’t allowed.' : '.'));
        body.appendChild(text);
        if (undecided) {
            // One tap to the system prompt (med-1ikf); request() starts inside the click.
            var allow = el('button', 'wg-btn wg-btn--sm', 'Allow notifications');
            allow.type = 'button';
            allow.setAttribute('data-notify-allow', '');
            allow.addEventListener('click', function () {
                markAsked();
                request().then(function (p) {
                    if (p === 'granted') {
                        rearm();
                        if (askNow) openDetailSheet().catch(function (e) { console.error('[notify-permission] detail sheet failed', e); });
                    }
                    return renderNote(slot);
                }, function () { return renderNote(slot); });
            });
            body.appendChild(allow);
        } else if (ln && await nativeHas(OPEN_SETTINGS_OP)) {
            var open = el('button', 'wg-btn wg-btn--sm', 'Open ' + (copy.os || 'iOS') + ' Settings');
            open.type = 'button';
            open.setAttribute('data-notify-open-settings', '');
            open.addEventListener('click', function () {
                Promise.resolve(ln.__native.call(OPEN_SETTINGS_OP)).catch(function (e) {
                    console.error('[notify-permission] openSettings failed', e);
                });
            });
            body.appendChild(open);
        } else {
            body.appendChild(el('span', null, ln
                ? 'Turn them on in ' + (copy.settingsPath || 'iOS Settings → Med Tracker → Notifications') + '.'
                : 'Allow notifications for this site in your browser settings.'));
        }
        note.append(icon('alert'), body);
        hydrate(note);
        return note;
    }

    // opts.askNow: the caller is itself the context (first-run Medications
    // pick), so an undecided permission gets the one-tap Allow even if this
    // device was never asked.
    async function renderNote(slot, opts) {
        if (!slot) return;
        if (slot.ownerDocument?.documentElement?.hasAttribute('data-provider-reload-committed')) return;
        var s = await state();
        if (slot.ownerDocument?.documentElement?.hasAttribute('data-provider-reload-committed')) return;
        var show = s === 'denied' || (s === 'default' && (asked() || !!(opts && opts.askNow)));
        var note = show ? await buildNote(slot, s === 'default', !!(opts && opts.askNow)) : null;
        if (slot.ownerDocument?.documentElement?.hasAttribute('data-provider-reload-committed')) return;
        slot.replaceChildren.apply(slot, note ? [note] : []);
    }

    function hintShown() {
        try { return window.localStorage.getItem(HINT_KEY) === '1'; } catch (_) { return false; }
    }

    // Kit RD3 (med-mt0l): once per device, on a take sheet opened from a
    // reminder while the pref is Generic (the shim reschedules every body on a
    // pref change, so the pref now is what that reminder showed). "Show
    // details" sets Detailed in place with an Undo toast; × just retires it.
    async function reminderHint(slot) {
        if (!slot || hintShown()) return;
        if ((await getVerbosity()) !== 'generic') return;
        try { window.localStorage.setItem(HINT_KEY, '1'); } catch (_) { /* private mode: may show again */ }

        var row = el('div', 'wg-hstack');
        row.setAttribute('data-reminder-hint', '');
        var lock = el('span', 'wg-muted');
        var lockIco = icon('lock');
        lockIco.classList.add('wg-ico--sm');
        lock.appendChild(lockIco);
        var text = el('span', 'wg-hint wg-spacer', 'Want the medication name on the lock screen? ');
        var link = button('wg-link', 'Show details', 'data-reminder-hint-action', 'details');
        text.appendChild(link);
        var dismiss = button('wg-btn wg-btn--ghost wg-btn--icon wg-btn--sm', null, 'data-reminder-hint-action', 'dismiss');
        dismiss.setAttribute('aria-label', 'Dismiss');
        var x = icon('x');
        x.classList.add('wg-ico--sm');
        dismiss.appendChild(x);
        row.append(lock, text, dismiss);
        hydrate(row);

        dismiss.addEventListener('click', function () { row.remove(); });
        link.addEventListener('click', async function () {
            row.remove();
            // A failed save puts the line back, so the tap can be retried.
            if (!(await saveVerbosity('detailed'))) {
                slot.replaceChildren(row);
                return;
            }
            if (typeof window.safeToast === 'function') {
                window.safeToast('Lock screen now shows medication names', 'success', {
                    detail: 'Change in Settings → Reminders',
                    action: { label: 'Undo', onClick: function () { saveVerbosity('generic'); } },
                });
            }
        });
        slot.replaceChildren(row);
    }

    window.NotifyPermission = { state: state, maybeAsk: maybeAsk, renderNote: renderNote, reminderHint: reminderHint };
})();
