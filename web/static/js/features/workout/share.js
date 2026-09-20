// ====================================
// WORKOUT PLAN SHARE (bd med-uo64.2)
// ====================================
//
// Sender side: a Share icon on the Plan card opens a modal with a QR code,
// a copyable link, and (where supported) the OS share sheet. The plan
// travels gzip-compressed inside the link fragment — nothing is sent to a
// server. The receive path (paste / live scan / #share-plan deeplink) is
// bead .3 and lives elsewhere; decoding lives here so the encode test is
// the decode.
//
// Token: 'p1.' + base64url(gzip(JSON.stringify(exportPayload))) via
// window.BackupCrypto. Link: ${location.origin}/#share-plan=<token>.
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

async function openShareModal(plan, dayCount, exerciseCount, token) {
    const doc = document;
    const name = (plan && plan.name) || 'Workout plan';
    const url = buildShareUrl(token);
    window.WorkoutShare._current = { token, url, name };

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
    if (token.length > SHARE_QR_MAX_CHARS) {
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
    await openShareModal(plan, days.length, exerciseCount, token);
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
    const raw = String(text === null || text === undefined ? '' : text).trim();
    if (SHARE_SHEET_QR_SHAPE.test(raw)) {
        safeToast("That's a printed sheet code — use Scan filled sheet.", 'info');
        return;
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
    // Mirror saveWorkoutGroup's post-write refresh (invalidate the workout
    // cache, reload the Plans list). The write itself is one atomic POST with
    // nothing client-side to roll back, so DataStore.applyOptimistic
    // (CLAUDE.md rule 9's commit/rollback for multi-step writes) is not
    // required here.
    closeImportWorkoutPlanModal();
    await invalidateWorkoutCache();
    if (window.WorkoutGroups && typeof window.WorkoutGroups.load === 'function') window.WorkoutGroups.load();
    else if (typeof loadWorkoutGroups === 'function') loadWorkoutGroups();
    if (typeof switchTab === 'function') switchTab('workouts');
    // Plans sub-tab via the features/workout/index.js switcher (persists +
    // loads the groups pane); fall back to persisting the choice when the
    // orchestrator hasn't loaded (isolated harness).
    if (typeof switchWorkoutTab === 'function') switchWorkoutTab('groups');
    else if (typeof setActiveWorkoutsSubTab === 'function') setActiveWorkoutsSubTab('groups');
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
    const st = window.WorkoutShare._scan;
    try {
        setImportStatus('Requesting camera access...');
        const stream = await window.MediaCapture.openCameraStream({ facingMode: 'environment' });
        st.stream = stream;
        video.srcObject = stream;
        video.classList.remove('hidden');
        // Best-effort preview: the decoder reads the stream, not the
        // element's playback, so a preview failure still leaves a working
        // scanner rather than no scanner.
        try {
            if (typeof video.play === 'function') await video.play();
        } catch (e) {
            console.error('Share import camera preview failed:', e);
        }
        setImportStatus('Point the camera at the plan QR.');
        st.running = true;
        importScanFrameLoop();
    } catch (e) {
        console.error('Failed to start share import scan:', e);
        setImportStatus(e && e.code === 'UNAVAILABLE'
            ? 'Camera is unavailable. Paste the link instead.'
            : 'Camera access denied or unavailable. Paste the link instead.');
    }
}

function stopImportScan() {
    const st = window.WorkoutShare && window.WorkoutShare._scan;
    if (!st) return;
    st.running = false;
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
window.WorkoutShare._current = null;
// Live-scan lifecycle (stream/running/timer). On the namespace — classic
// scripts keep no top-level let (architecture.no-module-state) — so tests
// can arm and inspect the loop without a camera.
window.WorkoutShare._scan = { stream: null, running: false, timer: null };
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
