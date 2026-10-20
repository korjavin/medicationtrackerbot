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
//   renderNote(el)  → fills el with the "Reminders won't fire" warn note when
//                     the permission is denied, or still 'default' after "Not
//                     now"; empties it otherwise. Shared by the med editor's
//                     Times section, the first-run features screen and
//                     Settings → Reminders & notifications (S8, med-ckm5.8).
(function () {
    'use strict';

    var ASKED_KEY = 'wg.notifyPermission.asked';
    var OPEN_SETTINGS_OP = 'notifications.openSettings';

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

    // The lock-screen fact must be true per mode: only local-only mode honours
    // the generic/detailed pref on the device (reminders.js recomputeAndPush);
    // cloud reminders name what is due.
    function facts() {
        var local = document.documentElement.classList.contains('wg-local-vault');
        return [
            ['bell', 'Only what you schedule', 'Doses, BP and weigh-ins. Nothing else.'],
            local
                ? ['lock', 'Private on the lock screen', 'Shows a plain line like "Medication time" unless you choose detailed text.']
                : ['lock', 'Shown on your lock screen', 'Reminders name the medication or measurement that is due.'],
            ['gear', 'Change it any time', 'Settings → Reminders & notifications.'],
        ];
    }

    // Resolves true when Allow ended in a grant; false on Not now / Back / Esc.
    function openSheet() {
        return new Promise(function (resolve) {
            var modal = el('mt-modal', 'wg-modal wg-sheet wg-notify-ask');
            modal.id = 'notify-permission-sheet';
            var backdrop = el('div', 'mt-confirm-backdrop wg-sheet-backdrop');

            var header = window.WGSheet.header({ eyebrow: 'Reminders', title: 'Let Med Tracker remind you' }).el;
            var body = el('div', 'wg-sheet__body');
            var list = el('ul', 'wg-facts wg-facts--sm');
            facts().forEach(function (f) {
                var li = el('li');
                var span = el('span');
                span.append(el('b', null, f[1]), f[2]);
                li.append(icon(f[0]), span);
                list.appendChild(li);
            });
            body.appendChild(list);

            var foot = el('div', 'wg-sheet__foot');
            var notNow = el('button', 'wg-btn wg-btn--ghost', 'Not now');
            notNow.type = 'button';
            notNow.setAttribute('data-notify-choice', 'not-now');
            var allow = el('button', 'wg-btn wg-btn--primary', 'Allow notifications');
            allow.type = 'button';
            allow.setAttribute('data-notify-choice', 'allow');
            foot.append(notNow, allow);

            modal.append(el('div', 'wg-sheet__grab'), header, body, foot);
            hydrate(modal);

            var settled = false;
            function close() {
                if (settled) return false;
                settled = true;
                markAsked();
                document.removeEventListener('keydown', onKeydown, true);
                window.ModalManager.close(modal.id);
                window.ModalManager.register(modal.id, null);
                modal.remove();
                backdrop.remove();
                return true;
            }
            function onKeydown(e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    if (close()) resolve(false);
                }
            }

            allow.addEventListener('click', function () {
                var asking = request(); // before anything else: keeps the click's activation
                if (!close()) return;
                asking.then(function (p) { resolve(p === 'granted'); }, function () { resolve(false); });
            });
            notNow.addEventListener('click', function () { if (close()) resolve(false); });
            backdrop.addEventListener('click', function () { if (close()) resolve(false); });
            document.addEventListener('keydown', onKeydown, true);

            document.body.append(backdrop, modal);
            window.ModalManager.register(modal.id, function () { if (close()) resolve(false); });
            window.ModalManager.open(modal.id);
            try { allow.focus(); } catch (_) { /* ignore */ }
        });
    }

    var pending = null;
    function maybeAsk() {
        if (pending) return pending;
        pending = (async function () {
            if (asked() || !window.WGSheet || !window.ModalManager) return false;
            if ((await state()) !== 'default') return false;
            return openSheet();
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

    async function buildNote() {
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
        if (ln && await nativeHas(OPEN_SETTINGS_OP)) {
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

    async function renderNote(slot) {
        if (!slot) return;
        var s = await state();
        var show = s === 'denied' || (s === 'default' && asked());
        var note = show ? await buildNote() : null;
        slot.replaceChildren.apply(slot, note ? [note] : []);
    }

    window.NotifyPermission = { state: state, maybeAsk: maybeAsk, renderNote: renderNote };
})();
