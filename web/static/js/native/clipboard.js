// window.Clipboard — read the clipboard's text from a tap (bd med-ta2n.6, the
// F1 "Have an invite?" sheet's Paste; contract med-ta2n.7 §7-8).
//
//   readText() → Promise<string | null>: the clipboard text, or null when it is
//                empty, not text, denied or unsupported (the caller then shows
//                a paste field). Never rejects.
//
// web + ios: navigator.clipboard.readText(), called synchronously inside the
// tap so WebKit (Safari, the iOS WKWebView) shows its own Paste callout — no
// permission prompt, no native op. android: WebView has no clipboard-read
// permission UI, so a shell that lists the bridge op clipboard.read (Android
// only — PLATFORM_ONLY in architecture.native-bridge-parity.test.js) answers
// from ClipboardManager; an older Android shell falls back to the web read.
//
// Load order: after native/index.js.
(function () {
    'use strict';

    var foundation = window.Clipboard && window.Clipboard.__native;
    if (!foundation || typeof foundation.registerImpl !== 'function') {
        throw new Error('native/clipboard.js: native/index.js must load first');
    }

    function text(value) {
        return typeof value === 'string' && value !== '' ? value : null;
    }

    function webReadText() {
        try {
            var clip = window.navigator && window.navigator.clipboard;
            if (!clip || typeof clip.readText !== 'function') return Promise.resolve(null);
            return Promise.resolve(clip.readText()).then(text, function () { return null; });
        } catch (_) {
            return Promise.resolve(null);
        }
    }

    foundation.registerImpl('Clipboard', 'web', { readText: webReadText });
    foundation.registerImpl('Clipboard', 'android', {
        readText: function () {
            return foundation.has('clipboard.read').then(function (has) {
                if (!has) return webReadText();
                return foundation.call('clipboard.read').then(text, function () { return null; });
            }, function () { return null; });
        },
    });
})();
