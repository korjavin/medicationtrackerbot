// features/invite.js — F1, the "Have an invite?" sheet (bd med-ta2n.6,
// screens-onboarding-v3.html F1; contract med-ta2n.7 design §1, §5, §7-8).
//
// window.InviteSheet:
//   open()            the sheet: Paste (window.Clipboard, read inside the tap),
//                     Scan QR (window.MediaCapture + window.Barcode), Not now.
//                     Also opened by the document event `wg:invite-open` (the W1
//                     footer, med-ta2n.1; the W5 page, med-ta2n.5).
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
// A valid invite hands its claim URL to CloudVault.moveToCloud({url})
// (local.leave {url}) — until the P3 sheet (med-ta2n.7) sits in between —
// gated per A7 on a v3 shell (invite.pending listed) and navigator.onLine.
(function () {
    'use strict';

    var NOT_INVITE = "That isn't an invite link. Check the address, or ask whoever invited you for a new link.";
    var OFFLINE = "You're offline — try again when connected.";
    var NO_CAMERA = 'The camera is unavailable. Paste the link instead.';
    var SCAN_MS = 200;

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

    function open() {
        if (current || !window.WGSheet || !window.ModalManager) return;
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
                if (!n || !(await n.has('invite.pending')) || !window.CloudVault || typeof window.CloudVault.moveToCloud !== 'function') {
                    showError('Update Med Tracker to use an invite here.');
                    return;
                }
                if (!live()) return;
                await window.CloudVault.moveToCloud({ win: window, url: invite.claimUrl });
                // The shell is navigating to the account; nothing left to do here.
            } catch (e) {
                var msg = (e && e.message) || '';
                showError(/invalid url/.test(msg) ? NOT_INVITE : 'The invite could not be opened: ' + (msg || 'unknown error') + '.');
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
    }

    document.addEventListener('wg:invite-open', function () { open(); });

    window.InviteSheet = { open: open, parse: parse };
})();
