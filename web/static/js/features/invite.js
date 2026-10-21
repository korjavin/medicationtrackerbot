// features/invite.js — F1, the "Have an invite?" sheet (bd med-ta2n.6,
// screens-onboarding-v3.html F1; contract med-ta2n.7 design §1, §5, §7-8).
//
// window.InviteSheet:
//   open({kit, action}?) the sheet: Paste (window.Clipboard, read inside the
//                     tap), Scan QR (window.MediaCapture + window.Barcode), Not
//                     now; action 'paste' | 'scan' runs that one straight away.
//                     Also opened by the document event `wg:invite-open` (the W1
//                     footer, med-ta2n.1; the W5 page, med-ta2n.5).
//   base()            → the shell's deployment domain, or '' (W5's "How to get
//                     an invite" link).
//   request()         the "Request an invite" sheet (bd med-ta2n.14, W5): email
//                     + note → POST https://<base>/api/invite-requests.
//   parse(raw, base?) → {claimUrl, sub} | null. Accepts the landing link
//                     https://<base>/i/<sub>#<token>, the scheme link
//                     medtracker://i/<sub>#<token>, the claim link
//                     https://<sub>.<base>/#claim=<token>[&kit=1], a bare
//                     account address and the Emergency Kit QR (first line).
//                     Landing/scheme forms are checked on the RAW string (no
//                     percent-decoding): sub ^[a-z0-9-]+$ after lowercasing,
//                     token ^[0-9a-f]+$, no userinfo/port/query; they become the
//                     claim link. Everything else goes through the shells'
//                     AccountURL.parse rules: https, no userinfo/port, one label
//                     under base, the rest verbatim. Twin of ios AccountURL
//                     .parseInvite / android AccountUrl.parseInvite; the shared
//                     vectors are inviteVectors in ios/Tests/main.swift.
//                     base: the shell's deployment domain (Attest.status().base).
//                     Without it only the shape is checked (claim/account host of
//                     3+ labels; a landing link's own host is its base; a scheme
//                     link has no base and is rejected) — the shell's
//                     local.leave {url} re-validates against its base anyway.
//
// A valid invite goes to offer() — the P3 route (bd med-ta2n.7) — in a v3
// shell (invite.pending listed) only.
//
//   offer(url, {kit}?)  url = a claim URL. Local mode with records → the P3
//                     "Turn on sync?" sheet; local with none → "Your invite is
//                     here" (P3 · Android, any shell); account mode → the
//                     "Switch account?" D1. kit: entered from Settings (W5/W4),
//                     appends &kit=1 to the claim fragment (contract §8).
//   pending()         → claim URL | null: the slot's live invite, read-only.
//   boot()            ONE invite.pending read per page (contract §8), called by
//                     auth-bootstrap.js before W1 mounts; null outside a shell,
//                     else a promise that settles when W1 may mount (the "Your
//                     invite is here" screen holds it until "Use without
//                     sync"). No slot + ?invite=1 (the shell's warm delivery) →
//                     F1. A slot older than 14 days is cleared and ignored.
// Every leave is gated per A7 at the tap: navigator.onLine !== false, else an
// in-page error with nothing stashed and no op called. Turn on sync / Sign in →
// CloudVault.moveToCloud({url}) (move.stash + local.leave {url}); Switch →
// account.leave {url}; Keep this account → invite.clear. The shell clears the
// slot after a successful leave.
(function () {
    'use strict';

    var NOT_INVITE = "That isn't an invite link. Check the address, or ask whoever invited you for a new link.";
    var OFFLINE = "You're offline — try again when connected.";
    var NO_CAMERA = 'The camera is unavailable. Paste the link instead.';
    var SCAN_MS = 200;
    var PROBE_MS = 3000;
    var STALE_MS = 14 * 24 * 60 * 60 * 1000;

    // scheme://authority path ?query #fragment, raw. `.` stops at a newline, so
    // a multi-line kit QR falls through to the first-line account parse.
    var URL_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(?:#(.*))?$/;
    var HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

    function accountHost(host, base) {
        if (!HOST_RE.test(host)) return false;
        if (!base) return host.split('.').length >= 3;
        var label = host.slice(0, -(base.length + 1));
        return host.slice(-(base.length + 1)) === '.' + base && label !== '' && label.indexOf('.') === -1;
    }

    // ios AccountURL.parse: the first non-empty line, https assumed.
    function parseAccount(raw, base) {
        var line = String(raw).split(/\r\n|\r|\n/).map(function (s) { return s.trim(); })
            .filter(Boolean)[0];
        if (!line) return null;
        var m = URL_RE.exec(line.indexOf('://') !== -1 ? line : 'https://' + line);
        if (!m || m[1].toLowerCase() !== 'https') return null;
        var host = m[2].toLowerCase();
        if (!accountHost(host, base)) return null;
        return {
            claimUrl: 'https://' + host + (m[3] || '/') + (m[4] || '') + (m[5] !== undefined ? '#' + m[5] : ''),
            sub: host.split('.')[0],
        };
    }

    function parse(raw, base) {
        base = String(base || '').toLowerCase();
        var line = String(raw == null ? '' : raw).trim();
        var m = URL_RE.exec(line);
        if (m) {
            var scheme = m[1].toLowerCase();
            var host = m[2].toLowerCase();
            var path = m[3];
            var landing = scheme === 'https' && (base ? host === base : path.indexOf('/i/') === 0);
            var custom = scheme === 'medtracker' && host === 'i';
            if (landing || custom) {
                var prefix = landing ? '/i/' : '/';
                var sub = path.indexOf(prefix) === 0 ? path.slice(prefix.length).toLowerCase() : '';
                var claimBase = base || (landing ? host : '');
                if (m[4] !== undefined || !claimBase || !/^[a-z0-9-]+$/.test(sub) || !/^[0-9a-f]+$/.test(m[5] || '')) return null;
                return parseAccount('https://' + sub + '.' + claimBase + '/#claim=' + m[5], claimBase);
            }
        }
        return parseAccount(line, base);
    }

    function native() {
        var n = window.LocalNotifications && window.LocalNotifications.__native;
        return n && typeof n.has === 'function' ? n : null;
    }

    // The deployment base the shell was built for, or '' (the web, a locked
    // shell, an older build).
    function shellBase() {
        try {
            var attest = window.Attest;
            if (!attest || attest.isSupported() !== true || typeof attest.status !== 'function') return Promise.resolve('');
            return Promise.resolve(attest.status()).then(function (s) {
                return s && typeof s.base === 'string' ? s.base : '';
            }, function () { return ''; });
        } catch (_) {
            return Promise.resolve('');
        }
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }

    function button(className, label, iconName, action) {
        var btn = el('button', className);
        btn.type = 'button';
        btn.setAttribute('data-invite-action', action);
        if (iconName) {
            var i = el('i', 'wg-ico wg-ico--sm');
            i.dataset.icon = iconName;
            btn.appendChild(i);
        }
        btn.appendChild(document.createTextNode(label));
        return btn;
    }

    var current = null;

    function open(opts) {
        if (current || !window.WGSheet || !window.ModalManager) return;
        var kit = !!(opts && opts.kit);
        var modal = el('mt-modal', 'wg-modal wg-sheet wg-invite-sheet');
        modal.id = 'invite-sheet';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        var backdrop = el('div', 'mt-confirm-backdrop wg-sheet-backdrop');
        var head = window.WGSheet.header({
            title: 'Have an invite?',
            actions: [{ label: 'Close', icon: 'x', attrs: { 'data-invite-action': 'close' } }],
        });

        var body = el('div', 'wg-sheet__body');
        var lede = el('p', 'wg-hint', 'Paste the link you were sent, or scan its QR code. You can also do this later in Settings → Sync & backup.');
        var row = el('div', 'wg-hstack');
        var paste = button('wg-btn', 'Paste', 'copy', 'paste');
        var scan = button('wg-btn', 'Scan QR', 'qr', 'scan');
        row.append(paste, el('span', 'wg-spacer'), scan);

        var field = el('div', 'wg-field');
        field.hidden = true;
        var label = el('label', 'wg-label', 'or paste it here');
        label.htmlFor = 'invite-sheet-input';
        var input = el('input', 'wg-input');
        input.id = 'invite-sheet-input';
        input.type = 'url';
        input.autocomplete = 'off';
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('data-invite-field', '');
        var go = button('wg-btn wg-btn--primary', 'Continue', null, 'submit');
        var fieldRow = el('div', 'wg-hstack');
        fieldRow.append(input, go);
        field.append(label, fieldRow);

        var video = el('video', 'food-scanner-video');
        video.hidden = true;
        video.muted = true;
        video.setAttribute('playsinline', '');
        var error = el('p', 'wg-error');
        error.hidden = true;
        error.setAttribute('role', 'alert');
        body.append(lede, row, field, video, error);

        var foot = el('div', 'wg-sheet__foot');
        var notNow = button('wg-btn wg-btn--ghost', 'Not now', null, 'not-now');
        foot.appendChild(notNow);
        modal.append(el('div', 'wg-sheet__grab'), head.el, body, foot);
        if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(modal);

        var busy = false;
        var scanState = { gen: 0, stream: null, timer: null };

        function showError(message) {
            error.textContent = message || '';
            error.hidden = !message;
        }

        function showField() {
            field.hidden = false;
            try { input.focus(); } catch (_) { /* headless */ }
        }

        function stopScan() {
            scanState.gen++;
            if (scanState.timer) clearTimeout(scanState.timer);
            scanState.timer = null;
            if (scanState.stream) {
                try { scanState.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) { /* stopped */ }
                scanState.stream = null;
            }
            try { video.srcObject = null; } catch (_) { /* headless */ }
            video.hidden = true;
        }

        function close() {
            if (current !== close) return false;
            current = null;
            stopScan();
            document.removeEventListener('keydown', onKeydown, true);
            window.ModalManager.close(modal.id);
            window.ModalManager.register(modal.id, null);
            modal.remove();
            backdrop.remove();
            return true;
        }
        function onKeydown(e) {
            if (e.key === 'Escape') { e.preventDefault(); close(); }
        }

        // A sheet dismissed while a read or a check was pending must not leave.
        function live() { return current === close; }

        async function submit(raw) {
            if (busy || !live()) return;
            busy = true;
            showError('');
            try {
                var invite = parse(raw, await shellBase());
                if (!invite) { showError(NOT_INVITE); showField(); return; }
                if (window.navigator.onLine === false) { showError(OFFLINE); return; }
                var n = native();
                if (!n || !(await n.has('invite.pending'))) {
                    showError('Update Med Tracker to use an invite here.');
                    return;
                }
                if (!live()) return;
                close();
                offer(invite.claimUrl, { kit: kit });
            } catch (e) {
                showError('The invite could not be opened: ' + ((e && e.message) || 'unknown error') + '.');
            } finally {
                busy = false;
            }
        }

        paste.addEventListener('click', function () {
            showError('');
            var reading;
            try { reading = window.Clipboard.readText(); } catch (_) { reading = null; } // inside the tap: WebKit's Paste callout
            Promise.resolve(reading).then(function (text) {
                if (!live()) return;
                if (!text) { showField(); return; }
                input.value = text;
                submit(text);
            }, showField);
        });

        go.addEventListener('click', function () { submit(input.value); });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); submit(input.value); }
        });

        function scanLoop(gen) {
            if (gen !== scanState.gen) return;
            // An unready frame decodes to null; the loop just tries again.
            Promise.resolve()
                .then(function () { return window.Barcode.scan({ source: video, formats: ['qr_code'] }); })
                .catch(function () { return null; })
                .then(function (result) {
                    if (gen !== scanState.gen) return;
                    if (result && result.rawValue) {
                        stopScan();
                        submit(result.rawValue);
                        return;
                    }
                    scanState.timer = setTimeout(function () { scanLoop(gen); }, SCAN_MS);
                });
        }

        scan.addEventListener('click', async function () {
            if (scanState.stream || busy) return;
            showError('');
            var gen = ++scanState.gen;
            try {
                if (typeof window.Barcode.supportsLiveScan !== 'function' || !window.Barcode.supportsLiveScan()) throw new Error('no live scan');
                var stream = await window.MediaCapture.openCameraStream({ facingMode: 'environment' });
                if (gen !== scanState.gen) {
                    try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) { /* stopped */ }
                    return;
                }
                scanState.stream = stream;
                video.srcObject = stream;
                video.hidden = false;
                try { if (typeof video.play === 'function') await video.play(); } catch (_) { /* the decoder reads the stream */ }
                scanLoop(gen);
            } catch (_) {
                if (gen !== scanState.gen) return;
                stopScan();
                showError(NO_CAMERA);
                showField();
            }
        });

        head.buttons[0].addEventListener('click', close);
        notNow.addEventListener('click', close);
        backdrop.addEventListener('click', close);
        document.addEventListener('keydown', onKeydown, true);

        current = close;
        document.body.append(backdrop, modal);
        window.ModalManager.register(modal.id, close);
        window.ModalManager.open(modal.id);
        // The W5 page's own Paste / Scan (opts.action): run the sheet's action
        // in the same tap, so the clipboard read keeps its user gesture.
        if (opts && opts.action === 'paste') paste.click();
        else if (opts && opts.action === 'scan') scan.click();
    }

    document.addEventListener('wg:invite-open', function (e) { open(e && e.detail); });

    // ---- P3 (bd med-ta2n.7) ------------------------------------------------

    function within(promise, fallback) {
        return Promise.race([
            Promise.resolve(promise).catch(function () { return fallback; }),
            new Promise(function (r) { setTimeout(function () { r(fallback); }, PROBE_MS); }),
        ]);
    }

    function isLocal() {
        return document.documentElement.classList.contains('wg-local-vault');
    }

    // Device words off the capability (LocalNotifications.copy), never the platform.
    function words() {
        var c = (window.LocalNotifications && window.LocalNotifications.copy) || {};
        var android = c.os === 'Android';
        return {
            device: c.device || 'iPhone',
            bio: android ? 'your fingerprint' : 'Face ID',
            bioShort: android ? 'fingerprint' : 'Face ID',
            bioIcon: android ? 'finger' : 'faceid',
        };
    }

    function withKit(url) {
        var hash = url.indexOf('#');
        if (hash === -1 || url.slice(hash + 1).indexOf('claim=') !== 0) return url;
        return /[#&]kit=1(&|$)/.test(url) ? url : url + '&kit=1';
    }

    function facts(items, small) {
        var ul = el('ul', small ? 'wg-facts wg-facts--sm' : 'wg-facts');
        items.forEach(function (f) {
            var li = el('li');
            var i = el('i', 'wg-ico');
            i.dataset.icon = f[0];
            var span = el('span');
            span.append(el('b', null, f[1]), f[2]);
            li.append(i, span);
            ul.appendChild(li);
        });
        return ul;
    }

    // The leave behind "Turn on sync" / "Sign in": A7 offline gate, then the
    // move (stash + local.leave {url}). While it runs it cannot be called back.
    function leaver(url, error) {
        var state = { moving: false };
        state.go = async function () {
            if (state.moving) return;
            error.hidden = true;
            if (window.navigator.onLine === false) { error.textContent = OFFLINE; error.hidden = false; return; }
            state.moving = true;
            try {
                await window.CloudVault.moveToCloud({ win: window, url: url });
                // The shell is navigating to the account; nothing left to do here.
            } catch (e) {
                var msg = (e && e.message) || '';
                error.textContent = /invalid url/.test(msg) ? NOT_INVITE : 'The invite could not be opened: ' + (msg || 'unknown error') + '.';
                error.hidden = false;
            } finally {
                state.moving = false;
            }
        };
        return state;
    }

    function errorLine() {
        var error = el('p', 'wg-error');
        error.hidden = true;
        error.setAttribute('role', 'alert');
        return error;
    }

    // P3 "Turn on sync?" over Today: local mode with records.
    function turnOnSync(url, count) {
        if (document.getElementById('invite-sync-sheet') || !window.WGSheet || !window.ModalManager) return;
        var w = words();
        var modal = el('mt-modal', 'wg-modal wg-sheet wg-invite-sheet');
        modal.id = 'invite-sync-sheet';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        var backdrop = el('div', 'mt-confirm-backdrop wg-sheet-backdrop');
        var head = window.WGSheet.header({
            eyebrow: 'Invite',
            title: 'Turn on sync?',
            actions: [{ label: 'Close', icon: 'x', attrs: { 'data-invite-action': 'close' } }],
        });
        var body = el('div', 'wg-sheet__body');
        var error = errorLine();
        body.append(facts([
            ['cloud-up', 'Your ' + count + (count === 1 ? ' record moves' : ' records move') + ' to your account', 'This ' + w.device + ' keeps working offline.'],
            [w.bioIcon, 'Sign in with ' + w.bio, 'No password, no email.'],
            ['device', 'Use it on other devices too', 'Add a tablet or a browser later.'],
        ], true), error);
        var foot = el('div', 'wg-sheet__foot');
        var notNow = button('wg-btn', 'Not now', null, 'not-now');
        var go = button('wg-btn wg-btn--primary', 'Turn on sync', null, 'turn-on-sync');
        foot.append(notNow, go);
        modal.append(el('div', 'wg-sheet__grab'), head.el, body, foot);
        if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(modal);

        var leave = leaver(url, error);
        // Not now keeps the slot: P3 offers it again on the next open, until
        // it is 14 days old (STALE_MS).
        function close() {
            if (leave.moving || !modal.isConnected) return false;
            document.removeEventListener('keydown', onKeydown, true);
            window.ModalManager.close(modal.id);
            window.ModalManager.register(modal.id, null);
            modal.remove();
            backdrop.remove();
            return true;
        }
        function onKeydown(e) {
            if (e.key === 'Escape') { e.preventDefault(); close(); }
        }
        go.addEventListener('click', leave.go);
        head.buttons[0].addEventListener('click', close);
        notNow.addEventListener('click', close);
        backdrop.addEventListener('click', close);
        document.addEventListener('keydown', onKeydown, true);
        document.body.append(backdrop, modal);
        window.ModalManager.register(modal.id, close);
        window.ModalManager.open(modal.id);
    }

    // P3 · Android "Your invite is here": nothing on this device yet (the
    // Play-referrer first launch, or F1 on an empty device). A full screen
    // ahead of W1; resolves when the user picks "Use without sync".
    function inviteReady(url) {
        if (document.getElementById('invite-ready')) return Promise.resolve();
        var w = words();
        var overlay = el('div', 'wg-firstrun-overlay wg-invite-ready');
        overlay.id = 'invite-ready';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'invite-ready-title');
        var panel = el('div', 'wg-firstrun-overlay__panel');
        var brand = el('div', 'wg-shell__brand');
        var mark = el('span', 'wg-mark wg-mark--sm');
        var ico = el('i', 'wg-ico');
        ico.dataset.icon = 'pill';
        mark.appendChild(ico);
        brand.append(mark, el('span', 'wg-shell__name', 'Med Tracker'));
        var title = el('h2', 'wg-firstrun-overlay__title wg-shell__title', 'Your invite is here');
        title.id = 'invite-ready-title';
        var error = errorLine();
        var foot = el('div', 'wg-firstrun-foot');
        var go = button('wg-btn wg-btn--primary wg-btn--lg', 'Sign in with ' + w.bioShort, w.bioIcon, 'sign-in');
        var skip = button('wg-btn wg-btn--ghost', 'Use without sync', null, 'without-sync');
        foot.append(go, skip);
        panel.append(brand, title,
            el('p', 'wg-shell__lede', 'Sign in once and your log syncs to your account.'),
            facts([
                ['cloud-up', 'Your account is ready', 'Set up by the person who invited you.'],
                [w.bioIcon, 'Sign in with ' + w.bio, 'No password, no email.'],
            ]),
            error, foot);
        overlay.appendChild(panel);
        if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(overlay);
        var leave = leaver(url, error);
        go.addEventListener('click', leave.go);
        document.body.appendChild(overlay);
        return new Promise(function (resolve) {
            // Keeps the slot: W1 follows without its "Have an invite?" footer.
            skip.addEventListener('click', function () {
                if (leave.moving) return;
                overlay.remove();
                resolve();
            });
        });
    }

    // "Switch account?" (account mode): this host is left, nothing is copied.
    async function switchAccount(url) {
        var n = native();
        var w = words();
        var host = window.location.hostname;
        var ok = await window.safeConfirm('', null, {
            title: 'Switch account?',
            icon: 'swap',
            tone: 'warn',
            dangerOutline: true,
            cancelLabel: 'Keep this account',
            confirmLabel: 'Switch',
            facts: [
                { text: 'This ' + w.device + ' leaves ' + host + '. Your records stay on the server for your other devices.' },
                { text: 'The invite opens a new, empty account.' },
                { text: 'Nothing is copied across.', gone: true },
            ],
        });
        if (!ok) {
            n.call('invite.clear').catch(function () { /* the slot stays; asked again next open */ });
            return;
        }
        if (window.navigator.onLine === false) { window.safeToast(OFFLINE, 'error'); return; }
        try {
            await n.call('account.leave', { url: url });
        } catch (e) {
            var msg = (e && e.message) || '';
            window.safeToast(/invalid url/.test(msg) ? NOT_INVITE : 'The invite could not be opened: ' + (msg || 'unknown error') + '.', 'error');
        }
    }

    function offer(url, opts) {
        if (opts && opts.kit) url = withKit(url);
        if (!isLocal()) return switchAccount(url);
        return Promise.resolve(window.CloudVault.userContentCount()).then(function (count) {
            if (count > 0) turnOnSync(url, count);
            else inviteReady(url);
        });
    }

    async function route(n) {
        var forced = false;
        try {
            var here = new URL(window.location.href);
            forced = here.searchParams.get('invite') === '1';
            if (forced) {
                here.searchParams.delete('invite');
                window.history.replaceState(window.history.state, '', here.pathname + here.search + here.hash);
            }
        } catch (_) { /* no URL: nothing forced */ }
        if ((await within(n.has('invite.pending'), false)) !== true) return;
        var slot = await within(n.call('invite.pending'), null);
        var invite = slot && typeof slot.url === 'string' ? parse(slot.url, await shellBase()) : null;
        if (invite && !(slot.receivedAt > Date.now() - STALE_MS)) {
            n.call('invite.clear').catch(function () { /* judged stale again next open */ });
            invite = null;
        }
        if (!invite) {
            // After W1 mounts (the caller's .then), so F1 opens over it.
            if (forced) setTimeout(open, 0);
            return;
        }
        if (!isLocal()) { switchAccount(invite.claimUrl); return; }
        var count = await window.CloudVault.userContentCount();
        if (count > 0) { turnOnSync(invite.claimUrl, count); return; }
        await inviteReady(invite.claimUrl);
    }

    // The shell slot's invite as a claim URL, or null (no v3 shell, empty,
    // stale or unparseable). Read-only: boot()'s route owns clearing a stale
    // slot. The W4 sheet (today.js) reads it for "An invite is waiting."
    async function pending() {
        var n = native();
        if (!n || (await within(n.has('invite.pending'), false)) !== true) return null;
        var slot = await within(n.call('invite.pending'), null);
        var invite = slot && typeof slot.url === 'string' ? parse(slot.url, await shellBase()) : null;
        return invite && slot.receivedAt > Date.now() - STALE_MS ? invite.claimUrl : null;
    }

    var booted = null;
    function boot() {
        var n = native();
        if (!n || (n.platform !== 'ios' && n.platform !== 'android')) return null;
        if (!booted) {
            booted = route(n).catch(function (e) { console.warn('[invite] boot routing failed', e); });
        }
        return booted;
    }

    // ---- Request an invite (bd med-ta2n.14) --------------------------------
    // The W5 page's "Request an invite": email + optional note, POSTed to
    // https://<base>/api/invite-requests (the shell's deployment; local mode's
    // CSP lists it, local-policy.js). The admin approves in Telegram and the
    // server emails the invite — nothing comes back here but "sent". A 404
    // means the operator has not turned the form on: say so and point at the
    // landing page, whose contact line is the fallback. opts.base / opts.post
    // replace the shell base and window.fetch (the visual QA driver).
    var REQUEST_SENT = "Request sent — if it's approved, your invite arrives by email.";
    var REQUEST_BUSY = 'Too many requests right now — try again in an hour.';
    var REQUEST_OFF = "Requests aren't open in the app right now.";
    var REQUEST_FAILED = "Couldn't send the request. Check your connection and try again.";
    var REQUEST_BAD_EMAIL = 'Enter an email address like name@example.com.';
    var NOTE_MAX = 500;

    function note(tone, iconName, lead, text) {
        var box = el('div', 'wg-note wg-note--' + tone);
        box.setAttribute('role', tone === 'ok' ? 'status' : 'alert');
        var i = el('i', 'wg-ico');
        i.dataset.icon = iconName;
        var body = el('div', 'wg-note__body');
        var line = el('span');
        if (lead) line.appendChild(el('b', null, lead + ' '));
        line.appendChild(document.createTextNode(text));
        body.appendChild(line);
        box.append(i, body);
        return { el: box, body: body };
    }

    function request(opts) {
        if (document.getElementById('invite-request-sheet') || !window.WGSheet || !window.ModalManager) return;
        opts = opts || {};
        var modal = el('mt-modal', 'wg-modal wg-sheet wg-invite-sheet');
        modal.id = 'invite-request-sheet';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        var backdrop = el('div', 'mt-confirm-backdrop wg-sheet-backdrop');
        var head = window.WGSheet.header({
            eyebrow: 'Sync',
            title: 'Request an invite',
            actions: [{ label: 'Close', icon: 'x', attrs: { 'data-invite-action': 'close' } }],
        });
        var body = el('div', 'wg-sheet__body');
        var lede = el('p', 'wg-hint', "Sync is invite-only for now. Leave your email — if the request is approved, the invite arrives there.");

        var emailField = el('div', 'wg-field');
        var emailLabel = el('label', 'wg-label', 'Email');
        emailLabel.htmlFor = 'invite-request-email';
        var email = el('input', 'wg-input');
        email.id = 'invite-request-email';
        email.type = 'email';
        email.autocomplete = 'email';
        email.required = true;
        email.placeholder = 'name@example.com';
        email.setAttribute('autocapitalize', 'off');
        email.setAttribute('inputmode', 'email');
        var emailError = errorLine();
        emailField.append(emailLabel, email, emailError);

        var noteField = el('div', 'wg-field');
        var noteLabel = el('label', 'wg-label', 'Note (optional)');
        noteLabel.htmlFor = 'invite-request-note';
        var noteInput = el('textarea', 'wg-input wg-textarea');
        noteInput.id = 'invite-request-note';
        noteInput.rows = 3;
        noteInput.maxLength = NOTE_MAX;
        noteInput.placeholder = 'Anything the admin should know';
        noteField.append(noteLabel, noteInput, el('p', 'wg-hint', 'Up to ' + NOTE_MAX + ' characters.'));

        var status = el('div', 'wg-vstack');
        body.append(lede, emailField, noteField,
            facts([['lock', 'What we send', 'Your email and your note. Nothing from your records.']], true),
            status);

        var foot = el('div', 'wg-sheet__foot');
        var notNow = button('wg-btn wg-btn--ghost', 'Not now', null, 'not-now');
        var send = button('wg-btn wg-btn--primary', 'Send request', 'message', 'send-request');
        foot.append(notNow, send);
        modal.append(el('div', 'wg-sheet__grab'), head.el, body, foot);
        if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(modal);

        var busy = false;
        function close() {
            if (!modal.isConnected) return false;
            document.removeEventListener('keydown', onKeydown, true);
            window.ModalManager.close(modal.id);
            window.ModalManager.register(modal.id, null);
            modal.remove();
            backdrop.remove();
            return true;
        }
        function onKeydown(e) {
            if (e.key === 'Escape') { e.preventDefault(); close(); }
        }
        function showStatus(box) {
            status.replaceChildren();
            if (box) status.appendChild(box);
            if (box && window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(status);
        }
        function showEmailError(message) {
            emailField.classList.toggle('wg-field--error', !!message);
            emailError.textContent = message || '';
            emailError.hidden = !message;
        }
        function sent() {
            var done = note('ok', 'check', null, REQUEST_SENT);
            done.el.setAttribute('data-invite-request', 'sent');
            body.replaceChildren(done.el);
            var ok = button('wg-btn wg-btn--primary', 'Done', null, 'done');
            ok.addEventListener('click', close);
            foot.replaceChildren(ok);
            if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(modal);
        }

        async function submit() {
            if (busy) return;
            var address = email.value.trim();
            showStatus(null);
            if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) { showEmailError(REQUEST_BAD_EMAIL); return; }
            showEmailError('');
            if (window.navigator.onLine === false) { showStatus(note('warn', 'cloud-off', null, OFFLINE).el); return; }
            busy = true;
            send.disabled = true;
            try {
                var base = opts.base || (await shellBase());
                if (!base) throw new Error('no base');
                var post = opts.post || window.fetch.bind(window);
                var res = await post('https://' + base + '/api/invite-requests', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: address, note: noteInput.value.trim() }),
                });
                if (!modal.isConnected) return;
                if (res.status === 202) { sent(); return; }
                if (res.status === 429) { showStatus(note('warn', 'clock', null, REQUEST_BUSY).el); return; }
                if (res.status === 400) {
                    var reply = await res.json().catch(function () { return {}; });
                    if (reply.error === 'invalid_email') { showEmailError(REQUEST_BAD_EMAIL); return; }
                }
                if (res.status === 404) {
                    var off = note('info', 'info', null, REQUEST_OFF);
                    off.el.setAttribute('data-invite-request', 'off');
                    var how = el('a', 'wg-link', 'How to get an invite');
                    how.href = 'https://' + base + '/';
                    how.target = '_blank';
                    how.rel = 'noopener';
                    off.body.appendChild(how);
                    showStatus(off.el);
                    return;
                }
                showStatus(note('warn', 'alert', null, REQUEST_FAILED).el);
            } catch (_) {
                if (modal.isConnected) showStatus(note('warn', 'alert', null, REQUEST_FAILED).el);
            } finally {
                busy = false;
                send.disabled = false;
            }
        }

        send.addEventListener('click', submit);
        email.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
        head.buttons[0].addEventListener('click', close);
        notNow.addEventListener('click', close);
        backdrop.addEventListener('click', close);
        document.addEventListener('keydown', onKeydown, true);
        document.body.append(backdrop, modal);
        window.ModalManager.register(modal.id, close);
        window.ModalManager.open(modal.id);
        return { email: email, note: noteInput, send: send };
    }

    window.InviteSheet = { open: open, parse: parse, offer: offer, boot: boot, pending: pending, base: shellBase, request: request };
})();
