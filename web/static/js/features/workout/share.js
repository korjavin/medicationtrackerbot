// ====================================
// WORKOUT PLAN SHARE (bd med-uo64.2)
// ====================================
//
// Sender side: a Share icon on the Plan card opens a modal with a QR code,
// a copyable link, and (where supported) the OS share sheet. The modal shows
// ONE link: in cloud mode a short link (the plan AES-GCM-encrypted in the
// browser, ciphertext POSTed to /api/share, key riding only in the fragment —
// bd med-1yi5.3), otherwise the long link with the plan gzip-compressed inside
// its fragment (nothing sent to a server). The receive path (paste / live
// scan / #share-plan deeplink / short-link resolve, bead .3) lives below in
// this same file, funnelling into receive(); decoding lives here so the
// encode test is the decode.
//
// Token: 'p1.' + base64url(gzip(JSON.stringify(exportPayload))) via
// window.BackupCrypto. Long link: ${location.origin}/#share-plan=<token>.
// Short link: <baseDomain>/s/<id>#<base64url(K)>.
//
// Classic-script conventions (same as scan.js): namespace object, no
// top-level let — see architecture.no-module-state.

// ponytail: phone-to-phone QR scanning past ~v25 is unreliable, and the
// vendored qrcode.mjs throws past v40 — so past this many token chars the
// modal hides the QR and leans on copy/share instead of showing a code
// most cameras can't read.
const SHARE_QR_MAX_CHARS = 1200;

// base64url without a dependency: btoa/atob with the -_ swap and padding
// stripped on encode, restored on decode.
function shareTokenB64Encode(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function shareTokenB64Decode(text) {
    const b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// encodeShareToken(payload) → 'p1.<base64url>'. The payload is the export
// route's response verbatim ({ v:1, plan:{...} }) so the receive side can
// hand it straight to the import route.
async function encodeShareToken(payload) {
    const gz = await window.BackupCrypto.gzipString(JSON.stringify(payload));
    return 'p1.' + shareTokenB64Encode(gz);
}

// decodeShareToken(text) → payload or null, never throws. Host-agnostic:
// accepts a bare token, a full URL, or any string containing
// #share-plan=<token> (whatever the camera/clipboard delivers). A QR from
// another app degrades to null ("not a plan link"), not an exception.
async function decodeShareToken(text) {
    try {
        const raw = String(text === null || text === undefined ? '' : text);
        const m = /#share-plan=([A-Za-z0-9\-_.~]+)/.exec(raw);
        const token = m ? m[1] : raw.trim();
        if (!token.startsWith('p1.')) return null;
        const bytes = shareTokenB64Decode(token.slice(3));
        const json = await window.BackupCrypto.gunzipToString(bytes);
        return JSON.parse(json);
    } catch (_) {
        return null;
    }
}

function buildShareUrl(token) {
    return `${window.location.origin}/#share-plan=${token}`;
}

// ponytail: no memoization — import() already caches by specifier. The
// indirection is the test seam (same shape as groups.js makePlanQrSvg).
function loadShareQrLib() { return import('/vendor/qrcode.mjs'); }

// makeShareQrSvg(url) → an SVG string for the share link. Same qrcode(0,
// 'L') shape as groups.js makePlanQrSvg (the link is longer than a sheet
// anchor, so it buys capacity instead of redundancy), but WITHOUT its
// margin:0: the renderer paints a white background rect, and the default
// margin (4 modules) is the light quiet zone scanners need. The print path
// can use margin:0 because white paper is the quiet zone; this modal is
// dark, so edge-to-edge modules would sit directly against it. (codex
// review on med-uo64.2.)
async function makeShareQrSvg(url) {
    const { qrcode } = await loadShareQrLib();
    const qr = qrcode(0, 'L');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, scalable: true });
}

// ====================================
// BLIND SHORT LINK (bd med-1yi5.3)
// ====================================
//
// Cloud-mode sender: the p1 token string → UTF-8 bytes → AES-128-GCM under a
// fresh random K (AAD 'mt/v1/share') → POST /api/share {ct} on the sender's
// OWN origin → {id, url} → modal link + QR = url + '#' + base64url(K).
// The server stores the packed blob (nonce ‖ ct) blindly for 30 days; the
// fragment never reaches any server. Any failure (non-200, network, bot
// mode, no WebCrypto) falls back to the long link exactly as before.
//
// Inline WebCrypto in this classic script is deliberate: share.js cannot
// import web/cloud/js/crypto.js, and window.BackupCrypto has no AES helper
// worth threading. Helpers stay file-local; the two test seams ride the
// existing window.WorkoutShare namespace (no new window.* globals, no
// top-level let — see architecture.globals / architecture.no-module-state).
//
// Wire contract (epic med-1yi5, byte-for-byte): K = 16 random bytes, nonce =
// 12 random bytes, AAD = UTF-8('mt/v1/share'), tag 128-bit (WebCrypto
// default), packed = nonce ‖ ct, ct on the wire as padded STD base64 (a Go
// []byte field), K in the fragment as UNPADDED base64url (22 chars).
const SHARE_LINK_AAD = 'mt/v1/share';
// Any host: the camera/clipboard may deliver the full URL. The id is the
// server's capability; the 22-char fragment is K (the actual secret).
const SHARE_LINK_SHORT_RE = /\/s\/([A-Za-z0-9]{10})#([A-Za-z0-9_\-]{22})$/;
// Never block the modal on the POST.
const SHARE_LINK_POST_TIMEOUT_MS = 3000;
// Server rejects decoded ct outside 1..16384 bytes; mirror the cap here so a
// hostile short link never reaches subtle.decrypt unbounded.
const SHARE_LINK_MAX_PACKED_BYTES = 16384;

// Response is the portable UTF-8 adapter (same reason as BackupCrypto's
// piped(): TextEncoder/TextDecoder are missing from the jsdom window the
// tests evaluate this file into, Response is not).
async function shareLinkUtf8Bytes(str) {
    const buf = await new Response(String(str)).arrayBuffer();
    return new Uint8Array(buf);
}

async function shareLinkUtf8Text(bytes) {
    return new Response(bytes).text();
}

// STD base64 WITH padding (Go []byte wire form) — unlike shareTokenB64*,
// which is the unpadded base64url fragment form.
function shareLinkB64StdEncode(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

function shareLinkB64StdDecode(text) {
    const bin = atob(String(text));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// The WebCrypto provider, or null where there is none (old WebView, insecure
// context, or the jsdom harness unless a test lends Node's webcrypto). Null
// means "short links unavailable" — the modal degrades to the long link.
function shareLinkCrypto() {
    try {
        const c = typeof crypto !== 'undefined' ? crypto : null;
        if (c && c.subtle && typeof c.getRandomValues === 'function') return c;
    } catch (_) { /* inaccessible crypto global */ }
    return null;
}

// encryptShareLink(token, keyBytes, nonceBytes) → packed nonce ‖ ct bytes.
// keyBytes/nonceBytes are injected (16/12 bytes); the golden-vector test pins
// the contract through this seam. Throws when crypto is missing or the args
// are misshapen — createShortLink turns that into the long-link fallback.
async function encryptShareLink(token, keyBytes, nonceBytes) {
    if (!keyBytes || keyBytes.length !== 16) throw new Error('encryptShareLink: 16-byte key required');
    if (!nonceBytes || nonceBytes.length !== 12) throw new Error('encryptShareLink: 12-byte nonce required');
    const c = shareLinkCrypto();
    if (!c) throw new Error('encryptShareLink: no WebCrypto');
    const key = await c.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const ct = await c.subtle.encrypt(
        { name: 'AES-GCM', iv: nonceBytes, additionalData: await shareLinkUtf8Bytes(SHARE_LINK_AAD) },
        key,
        await shareLinkUtf8Bytes(token),
    );
    const out = new Uint8Array(nonceBytes.length + ct.byteLength);
    out.set(nonceBytes, 0);
    out.set(new Uint8Array(ct), nonceBytes.length);
    return out;
}

// decryptShareLink(keyB64url, packedStdB64) → p1 token string or null, never
// throws. Wrong K, truncated/corrupt ct, oversize blob, missing crypto: null.
async function decryptShareLink(keyB64url, packedStdB64) {
    try {
        const k = shareTokenB64Decode(keyB64url);
        if (k.length !== 16) return null;
        const packed = shareLinkB64StdDecode(packedStdB64);
        if (packed.length <= 12 || packed.length > SHARE_LINK_MAX_PACKED_BYTES) return null;
        const nonce = packed.slice(0, 12);
        const ct = packed.slice(12);
        const c = shareLinkCrypto();
        if (!c) return null;
        const key = await c.subtle.importKey('raw', k, 'AES-GCM', false, ['decrypt']);
        const pt = await c.subtle.decrypt(
            { name: 'AES-GCM', iv: nonce, additionalData: await shareLinkUtf8Bytes(SHARE_LINK_AAD) },
            key,
            ct,
        );
        const token = await shareLinkUtf8Text(new Uint8Array(pt));
        return token && token.startsWith('p1.') ? token : null;
    } catch (_) {
        return null;
    }
}

// createShortLink(token) → '<url>#<base64url K>' or null. Raw fetch, not
// apiCall: /api/share is a real server route, not an apishim route
// (precedent: features/settings/importexport.js POSTs /api/vitals/import the
// same way). ONLY in cloud mode; bot mode never POSTs.
async function createShortLink(token) {
    try {
        if (!window.__MEDTRACKER_CLOUD__) return null;
        const c = shareLinkCrypto();
        if (!c) return null;
        const keyBytes = c.getRandomValues(new Uint8Array(16));
        const nonceBytes = c.getRandomValues(new Uint8Array(12));
        const packed = await encryptShareLink(token, keyBytes, nonceBytes);
        const ctrl = new AbortController();
        const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) { /* already settled */ } }, SHARE_LINK_POST_TIMEOUT_MS);
        let res = null;
        try {
            res = await fetch('/api/share', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ct: shareLinkB64StdEncode(packed) }),
                signal: ctrl.signal,
            });
        } finally {
            clearTimeout(timer);
        }
        if (!res || !res.ok) return null;
        const body = await res.json().catch(() => null);
        if (!body || typeof body.url !== 'string' || typeof body.id !== 'string' || !body.url || !body.id) return null;
        return `${body.url}#${shareTokenB64Encode(keyBytes)}`;
    } catch (_) {
        return null;
    }
}

// resolveShortLink(id, keyFrag) → { token } | { expired: true } | { failed: true }.
// Same-origin GET: the read route is mounted on every host, so connect-src
// 'self' covers it — never fetch the link's own host (CSP would block it).
// Never throws; the receiver maps the outcome to exactly one toast.
async function resolveShortLink(id, keyFrag) {
    try {
        const res = await fetch(`/api/s/${id}`, { cache: 'no-store' });
        if (!res) return { failed: true };
        if (res.status === 404) return { expired: true };
        if (!res.ok) return { failed: true };
        const body = await res.json().catch(() => null);
        const ct = body && typeof body.ct === 'string' ? body.ct : '';
        if (!ct) return { failed: true };
        const token = await decryptShareLink(keyFrag, ct);
        if (!token) return { failed: true };
        return { token };
    } catch (_) {
        return { failed: true };
    }
}

function setShareModalVisible(open) {
    const named = window.ModalManager && window.ModalManager.workoutShare;
    if (named && typeof named.open === 'function' && typeof named.close === 'function') {
        if (open) named.open();
        else named.close();
        return;
    }
    if (window.ModalManager && typeof window.ModalManager.open === 'function' && typeof window.ModalManager.close === 'function') {
        if (open) window.ModalManager.open('workout-share-modal');
        else window.ModalManager.close('workout-share-modal');
        return;
    }
    const modal = document.getElementById('workout-share-modal');
    if (modal) modal.classList.toggle('hidden', !open);
}

async function openShareModal(plan, dayCount, exerciseCount, token, shortUrl) {
    const doc = document;
    const name = (plan && plan.name) || 'Workout plan';
    // ONE link in the modal: the short link when the POST minted one, else
    // the long link exactly as before. The QR encodes whatever is shown, so
    // the length check applies to the shown URL — a short link always passes.
    const url = shortUrl || buildShareUrl(token);
    const isShort = !!shortUrl;
    window.WorkoutShare._current = { token, url, name, short: isShort };

    const title = doc.getElementById('workout-share-title');
    if (title) title.textContent = `Share: ${name}`;
    const counts = doc.getElementById('workout-share-counts');
    if (counts) counts.textContent = `${dayCount} day${dayCount === 1 ? '' : 's'} · ${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'}`;
    const link = doc.getElementById('workout-share-link');
    if (link) link.value = url;

    // The OS sheet only exists where the platform offers it — no dead
    // button elsewhere.
    const nativeBtn = doc.getElementById('workout-share-native-btn');
    if (nativeBtn) {
        const hasNative = typeof navigator !== 'undefined' && navigator !== null && typeof navigator.share === 'function';
        nativeBtn.classList.toggle('hidden', !hasNative);
    }

    const qrBox = doc.getElementById('workout-share-qr');
    const qrNote = doc.getElementById('workout-share-qr-note');
    if (qrBox) qrBox.replaceChildren();
    if (url.length > SHARE_QR_MAX_CHARS) {
        if (qrBox) qrBox.classList.add('hidden');
        if (qrNote) {
            qrNote.textContent = 'This plan is too large for a scannable QR — copy the link or use Share… instead.';
            qrNote.classList.remove('hidden');
        }
    } else {
        if (qrNote) {
            qrNote.textContent = '';
            qrNote.classList.add('hidden');
        }
        // QR render is best-effort: a link that copies still shares even
        // when the vendored renderer can't load.
        try {
            const svg = await window.WorkoutShare.makeQr(url);
            if (qrBox) {
                qrBox.classList.remove('hidden');
                qrBox.innerHTML = svg;
            }
        } catch (_) {
            if (qrBox) qrBox.classList.add('hidden');
            if (qrNote) {
                qrNote.textContent = 'QR unavailable — copy the link or use Share… instead.';
                qrNote.classList.remove('hidden');
            }
        }
    }

    const shortNote = doc.getElementById('workout-share-short-note');
    if (shortNote) {
        shortNote.textContent = isShort ? 'Link works for 30 days.' : '';
        shortNote.classList.toggle('hidden', !isShort);
    }
    // The static foot claims nothing reaches a server — true of the long
    // link, false of the short one (blind ciphertext, 30-day TTL).
    const foot = doc.getElementById('workout-share-foot');
    if (foot) {
        foot.textContent = isShort
            ? 'Only encrypted data is stored for this link, for 30 days — the key stays in the link itself. Anyone with the link can import it.'
            : 'The plan travels inside this link — nothing is sent to a server. Anyone with the link can import it.';
    }

    setShareModalVisible(true);
}

// `group` is the row's own cached group record — the Plans list was just
// rendered from it, so re-fetching /api/workout/groups would only re-read
// what we already hold.
async function shareWorkoutPlan(group) {
    const g = group || {};
    let exported = null;
    try {
        exported = await apiCall(`/api/workout/plans/export?id=${g.id}`);
    } catch (_) {
        exported = null;
    }
    if (!exported) {
        safeToast('Couldn\'t load the plan — try again online.', 'error');
        return;
    }
    const plan = exported && exported.plan ? exported.plan : exported;
    const days = plan && Array.isArray(plan.days) ? plan.days : [];
    let exerciseCount = 0;
    for (const d of days) {
        if (d && Array.isArray(d.exercises)) exerciseCount += d.exercises.length;
    }
    if (exerciseCount === 0) {
        safeToast('Add some exercises to this plan first.', 'info');
        return;
    }
    let token = null;
    try {
        token = await encodeShareToken(exported);
    } catch (_) {
        token = null;
    }
    if (!token) {
        safeToast('Couldn\'t build the share link — try again.', 'error');
        return;
    }
    // Blind short link when the server route exists (cloud mode): wrapped in
    // try/catch with its own timeout inside, so the modal never waits on it
    // past ~3s and any failure silently keeps the long link.
    const shortUrl = await createShortLink(token);
    await openShareModal(plan, days.length, exerciseCount, token, shortUrl);
}

async function copyShareLink() {
    const cur = (window.WorkoutShare && window.WorkoutShare._current) || {};
    const link = document.getElementById('workout-share-link');
    const url = (link && link.value) || cur.url || '';
    if (!url) return;
    try {
        if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(url);
            safeToast('Link copied.', 'info');
        } else if (link && typeof link.select === 'function') {
            link.select();
            safeToast('Copy the link by hand.', 'info');
        }
    } catch (_) {
        safeToast('Couldn\'t copy — copy the link by hand.', 'error');
    }
}

async function nativeSharePlan() {
    const cur = (window.WorkoutShare && window.WorkoutShare._current) || {};
    try {
        await navigator.share({ title: cur.name || 'Workout plan', url: cur.url });
    } catch (e) {
        // Dismissing the OS sheet is not an error.
        if (e && e.name === 'AbortError') return;
        safeToast('Couldn\'t share — copy the link instead.', 'error');
    }
}

function closeWorkoutShareModal() {
    setShareModalVisible(false);
}

// ====================================
// WORKOUT PLAN IMPORT — receive path (bd med-uo64.3)
// ====================================
//
// Paste, live QR scan, and the #share-plan deeplink all funnel into
// receive(): the confirm → import → Edit Plan path lives here exactly once.
// Decoding stays shared with the sender side above (decodeShareToken).

// Same throttle food/scanner.js uses between live-decode attempts.
const SHARE_IMPORT_SCAN_THROTTLE_MS = 200;
const SHARE_IMPORT_QR_FORMATS = ['qr_code'];

// Upper bound on anything receive() will hand to the gunzip: hostile input
// reaches decodeShareToken (a tapped link decodes before any confirm), and
// gunzipToString inflates without a limit. 100k chars is ~75 KB compressed
// — several times any realistic plan (a 30-day plan gzips to ~15 KB) —
// while keeping a crafted gzip bomb from OOM-killing the tab pre-confirm.
const SHARE_IMPORT_MAX_TOKEN_CHARS = 100000;

// Printed-sheet QR shape ("workout-plan:<v>:<id>", owned by
// web/domain/workoutsheet.js parseSheetQrText): the one QR a user can
// plausibly offer this modal instead of Scan filled sheet. Shape-only check,
// no domain import — this is a classic script and the domain module owns the
// parse; a gym photo that doesn't even match the shape is plain garbage.
const SHARE_SHEET_QR_SHAPE = /^workout-plan:\d+:\d+$/;

// barcodeCan helper shape copied from food/scanner.js (do not import food
// code). The platform decision belongs to the window.Barcode abstraction,
// not to us (CLAUDE.md rule 10); a missing method falls back instead of
// throwing so a stale cached bundle degrades to the paste field.
function shareBarcodeCan(method, fallback) {
    try {
        const barcode = window.Barcode;
        if (!barcode || typeof barcode[method] !== 'function') return fallback;
        return !!barcode[method]();
    } catch (_) { return fallback; }
}

function setImportStatus(message) {
    const status = document.getElementById('workout-share-import-status');
    if (status) status.textContent = message || '';
}

// receive(text): decode → confirm → POST /api/workout/plans/import → toast,
// Plans refresh, workouts tab + Plans sub-tab, Edit Plan. Garbage toasts and
// never POSTs; a cancelled confirm never POSTs.
async function receiveSharedPlan(text) {
    // let, not const: a resolved short link replaces the pasted URL with the
    // decrypted p1 token before the shared decode path below.
    let raw = String(text === null || text === undefined ? '' : text).trim();
    if (raw.length > SHARE_IMPORT_MAX_TOKEN_CHARS) {
        safeToast("That's not a workout plan link.", 'error');
        return;
    }
    if (SHARE_SHEET_QR_SHAPE.test(raw)) {
        safeToast("That's a printed sheet code — use Scan filled sheet.", 'info');
        return;
    }
    // Short link (any host — the camera/clipboard may deliver the full URL):
    // resolve on OUR origin, decrypt with the fragment K, then run the
    // resulting p1 string through the EXISTING decode → confirm → import path
    // below. The #share-plan deeplink is untouched by this branch.
    const shortMatch = SHARE_LINK_SHORT_RE.exec(raw);
    if (shortMatch) {
        const resolved = await resolveShortLink(shortMatch[1], shortMatch[2]);
        if (resolved.expired) {
            safeToast('This short link has expired or belongs to another Med Tracker server — ask for the plan code instead.', 'error');
            return;
        }
        if (!resolved.token) {
            safeToast("That's not a workout plan link.", 'error');
            return;
        }
        raw = resolved.token;
    }
    const payload = await decodeShareToken(raw);
    if (!payload || typeof payload !== 'object' || !payload.plan) {
        safeToast("That's not a workout plan link.", 'error');
        return;
    }
    const plan = payload.plan;
    const days = Array.isArray(plan.days) ? plan.days : [];
    let exerciseCount = 0;
    for (const d of days) {
        if (d && Array.isArray(d.exercises)) exerciseCount += d.exercises.length;
    }
    const name = plan.name || 'Workout plan';
    const ok = await safeConfirm(`Import "${name}"? ${days.length} day(s), ${exerciseCount} exercise(s).`);
    if (!ok) return;
    let res = null;
    try {
        // suppressWriteAlert: apiCall would safeAlert a failed write itself;
        // the 400 message belongs in a toast, so take the feedback over here
        // exactly once.
        res = await apiCall('/api/workout/plans/import', 'POST', payload, { suppressWriteAlert: true });
    } catch (e) {
        // invalid_request / precondition_failed rethrow out of apiCall
        // (core/api.js) — the router's 400 message rides along, so toast it.
        safeToast((e && e.message) || "Couldn't import the plan — try again.", 'error');
        return;
    }
    if (!res || !res.id) {
        safeToast("Couldn't import the plan — try again online.", 'error');
        return;
    }
    safeToast(`Added "${res.name || name}"`, 'info');
    // Same post-write refresh as the create path (saveWorkoutGroup):
    // invalidate + reload, AWAITED so the just-created plan is in
    // cachedGroups before openEdit looks it up (without the await the Edit
    // screen silently never opens). No optimistic placeholder: the import
    // route server-materializes the group plus its days, exercises, and
    // library links, which no client-side stand-in can usefully preview —
    // the authoritative rows arrive with this reload.
    closeImportWorkoutPlanModal();
    await invalidateWorkoutCache();
    if (window.WorkoutGroups && typeof window.WorkoutGroups.load === 'function') await window.WorkoutGroups.load();
    else if (typeof loadWorkoutGroups === 'function') await loadWorkoutGroups();
    if (typeof switchTab === 'function') switchTab('workouts');
    // Plans sub-tab via the features/workout/index.js switcher (persists +
    // loads the groups pane; same classic script as the setter, so no
    // fallback branch — either both exist or neither does).
    if (typeof switchWorkoutTab === 'function') switchWorkoutTab('groups');
    if (window.WorkoutGroups && typeof window.WorkoutGroups.openEdit === 'function') window.WorkoutGroups.openEdit(res.id);
}

function setImportModalVisible(open) {
    const named = window.ModalManager && window.ModalManager.workoutShareImport;
    if (named && typeof named.open === 'function' && typeof named.close === 'function') {
        if (open) named.open();
        else named.close();
        return;
    }
    if (window.ModalManager && typeof window.ModalManager.open === 'function' && typeof window.ModalManager.close === 'function') {
        if (open) window.ModalManager.open('workout-share-import-modal');
        else window.ModalManager.close('workout-share-import-modal');
        return;
    }
    const modal = document.getElementById('workout-share-import-modal');
    if (modal) modal.classList.toggle('hidden', !open);
}

function openImportWorkoutPlanModal() {
    setImportModalVisible(true);
    const input = document.getElementById('workout-share-import-input');
    if (input) {
        input.value = '';
        if (typeof input.focus === 'function') {
            try { input.focus(); } catch (_) { /* headless harness */ }
        }
    }
    setImportStatus('');
}

function closeImportWorkoutPlanModal() {
    stopImportScan();
    setImportModalVisible(false);
}

function submitImportField() {
    const input = document.getElementById('workout-share-import-input');
    receiveSharedPlan(input && input.value ? input.value : '');
}

async function importScanFrameLoop() {
    const st = window.WorkoutShare._scan;
    if (!st || !st.running) return;
    const video = document.getElementById('workout-share-import-video');
    if (!video || !window.Barcode || video.readyState < 2) {
        st.timer = setTimeout(importScanFrameLoop, SHARE_IMPORT_SCAN_THROTTLE_MS);
        return;
    }
    try {
        const result = await window.Barcode.scan({ source: video, formats: SHARE_IMPORT_QR_FORMATS });
        // Re-check after await: stopImportScan() may have run while the
        // decode was in flight (modal closed, pagehide). Without this guard
        // a late-resolving decode would import into a dismissed UI.
        if (!window.WorkoutShare._scan.running) return;
        if (result && result.rawValue) {
            stopImportScan();
            await receiveSharedPlan(result.rawValue);
            return;
        }
    } catch (e) {
        console.error('Share import frame decode failed:', e);
    }
    if (!window.WorkoutShare._scan.running) return;
    st.timer = setTimeout(importScanFrameLoop, SHARE_IMPORT_SCAN_THROTTLE_MS);
}

async function startImportScan() {
    const st = window.WorkoutShare._scan;
    // Re-entrancy guard: the Scan button stays tappable while a scan — or a
    // still-pending camera request — is in flight. A second entry would
    // overwrite st.stream and orphan the first stream: its reference lost,
    // its camera surviving modal close.
    if (!st || st.running || st.starting || st.stream) return;
    const video = document.getElementById('workout-share-import-video');
    if (!video) return;
    // Not a device capability — a page-context fact the abstraction can't own.
    if (!window.isSecureContext) {
        setImportStatus('Camera requires HTTPS (or localhost). Paste the link instead.');
        return;
    }
    if (!shareBarcodeCan('supportsLiveScan', true)) {
        setImportStatus('Live scan is unavailable on this browser. Paste the link instead.');
        return;
    }
    // Generation: a bare boolean cannot tell "my start was cancelled" from
    // "my start was SUPERSEDED" — cancel, retap, and the first acquire
    // resolves into the second start's tenure and hijacks its stream. Each
    // start takes the next number; stopImportScan moves it on, so a
    // continuation whose number is stale releases its stream and returns.
    // Entry + take stays synchronous past the guards above (no await
    // between), so two taps cannot take the same number — and a guard
    // early-return above leaves st.starting false so a second Scan tap
    // re-attempts instead of going inert.
    st.starting = true;
    const gen = ++st.generation;
    try {
        setImportStatus('Requesting camera access...');
        const stream = await window.MediaCapture.openCameraStream({ facingMode: 'environment' });
        if (gen !== st.generation) {
            // Cancelled — or superseded by a newer start — while the camera
            // request was in flight. Release the stream instead of
            // resurrecting (or hijacking) the scanner.
            try { stream.getTracks().forEach((track) => track.stop()); } catch (_) { /* already stopped */ }
            return;
        }
        st.stream = stream;
        video.srcObject = stream;
        video.classList.remove('hidden');
        // Best-effort preview: the decoder reads the stream, not the
        // element's playback, so a preview failure still leaves a working
        // scanner rather than no scanner. The play() await is a second
        // suspension point (camera warm-up is routinely 200-800 ms), so the
        // closed-while-waiting re-check from above applies here too —
        // without it a Cancel during preview restarts the loop behind the
        // shut modal and wedges st.stream, bricking the Scan button.
        try {
            if (typeof video.play === 'function') await video.play();
        } catch (e) {
            console.error('Share import camera preview failed:', e);
        }
        if (gen !== st.generation) {
            stopImportScan();
            return;
        }
        setImportStatus('Point the camera at the plan QR.');
        st.running = true;
        importScanFrameLoop();
    } catch (e) {
        console.error('Failed to start share import scan:', e);
        setImportStatus(e && e.code === 'UNAVAILABLE'
            ? 'Camera is unavailable. Paste the link instead.'
            : 'Camera access denied or unavailable. Paste the link instead.');
    } finally {
        // Only clear our own tenure: a stale continuation must not drop the
        // flag a superseding start set.
        if (gen === st.generation) st.starting = false;
    }
}

function stopImportScan() {
    const st = window.WorkoutShare && window.WorkoutShare._scan;
    if (!st) return;
    st.running = false;
    st.starting = false;
    st.generation++;
    if (st.timer) {
        clearTimeout(st.timer);
        st.timer = null;
    }
    const video = document.getElementById('workout-share-import-video');
    if (video) {
        if (typeof video.pause === 'function') {
            try { video.pause(); } catch (_) { /* headless harness */ }
        }
        try { video.srcObject = null; } catch (_) { /* headless harness */ }
        video.classList.add('hidden');
    }
    if (st.stream) {
        try {
            st.stream.getTracks().forEach((track) => track.stop());
        } catch (_) { /* already stopped */ }
        st.stream = null;
    }
}

window.WorkoutShare = {
    share: shareWorkoutPlan,
    encode: encodeShareToken,
    decode: decodeShareToken,
    buildUrl: buildShareUrl,
    close: closeWorkoutShareModal,
    receive: receiveSharedPlan,
    openImport: openImportWorkoutPlanModal,
    closeImport: closeImportWorkoutPlanModal,
};
// Test seam for the vendored QR renderer (mirrors WorkoutGroups.makePlanQr)
// plus the currently displayed share, so tests can assert without a camera,
// a clipboard, or the /vendor module graph.
window.WorkoutShare.makeQr = makeShareQrSvg;
// Short-link crypto seam: encrypt takes an injected K + nonce so the golden
// vector pins the wire contract byte-for-byte; decrypt backs the golden and
// receive-path tests. Still the same allowlisted namespace, no new global.
window.WorkoutShare._shortLink = { encrypt: encryptShareLink, decrypt: decryptShareLink };
window.WorkoutShare._current = null;
// Live-scan lifecycle (stream/running/starting/generation/timer). On the
// namespace — classic scripts keep no top-level let
// (architecture.no-module-state) — so tests can arm and inspect the loop
// without a camera. `starting` covers the camera request in flight (running
// only flips once the stream lands); `generation` tells a cancelled start
// from a superseded one (see startImportScan).
window.WorkoutShare._scan = { stream: null, running: false, starting: false, generation: 0, timer: null };
window.addEventListener('pagehide', stopImportScan);


// Static modal buttons (markup lives in index.html next to the other
// workout modals). Bound here — not in features/workout/index.js — so the
// share file stays self-contained. Scripts load at the end of <body>, so
// the nodes exist; the guards keep isolated harnesses honest.
(function bindWorkoutShareButtons() {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const copyBtn = document.getElementById('workout-share-copy-btn');
    if (copyBtn) copyBtn.addEventListener('click', () => { copyShareLink(); });
    const nativeBtn = document.getElementById('workout-share-native-btn');
    if (nativeBtn) nativeBtn.addEventListener('click', () => { nativeSharePlan(); });
    const cancelBtn = document.getElementById('workout-share-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { closeWorkoutShareModal(); });
    const importBtn = document.getElementById('import-workout-plan-btn');
    if (importBtn) importBtn.addEventListener('click', () => { openImportWorkoutPlanModal(); });
    const importSubmitBtn = document.getElementById('workout-share-import-submit-btn');
    if (importSubmitBtn) importSubmitBtn.addEventListener('click', () => { submitImportField(); });
    const importScanBtn = document.getElementById('workout-share-import-scan-btn');
    if (importScanBtn) importScanBtn.addEventListener('click', () => { startImportScan(); });
    const importCancelBtn = document.getElementById('workout-share-import-cancel-btn');
    if (importCancelBtn) importCancelBtn.addEventListener('click', () => { closeImportWorkoutPlanModal(); });
})();
