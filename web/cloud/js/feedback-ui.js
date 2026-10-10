// feedback-ui.js — cloud-mode-only "Send feedback" capture UI (bd med-dni.2).
//
// mountFeedbackLauncher(ctx) adds a "Send feedback" row as the last group of the
// Settings home (post-unlock). Tapping it opens an <mt-modal> where anyone can compose
// anonymous feedback: free text, an attached image (via the shared
// MediaCapture.pickPhoto abstraction), and a recorded voice message (via the
// MediaCapture.recordAudio handle added in med-dni.2 Task 1). Send assembles a
// bundle carrying ONLY user-authored content — no account id, no PII (decided:
// feedback is anonymous) — and hands it to enqueueFeedback(); the encrypt +
// durable retry + POST behind that seam is med-dni.3.
//
// Mounted only when a recipient meta is configured — the gate lives in
// cloud-boot.js (getFeedbackRecipient() !== ''). No window.* global: cloud-boot
// dynamically imports this module and calls the export directly (CLAUDE.md
// rule 4 avoided). Device capture routes through window.MediaCapture
// (CLAUDE.md rule 10); visuals use wg-* classes + tokens only (rule 3).
import { enqueueFeedback } from './feedback-submit.js';

const LAUNCHER_ID = 'feedback-launcher';

function canRecordAudio() {
    return !!(window.MediaCapture && typeof window.MediaCapture.recordAudio === 'function');
}

function toast(message) {
    if (window.SyncManager && typeof window.SyncManager.showToast === 'function') {
        window.SyncManager.showToast(message, 'success');
    }
}

// Build + show the compose modal. A fresh modal per open (like trial-consent);
// removed on every exit path, releasing the mic if a recording is in flight.
function openFeedbackModal() {
    const doc = document;

    const backdrop = doc.createElement('div');
    backdrop.className = 'mt-confirm-backdrop wg-sheet-backdrop';

    // Kit sheet (med-xso6.7): a compose flow — the close X in the header, Send in
    // the keyboard-docked foot (WGSheet keeps it above the virtual keyboard).
    const modal = doc.createElement('mt-modal');
    modal.className = 'wg-modal wg-sheet wg-feedback-modal';
    modal.id = 'feedback-modal';

    const grab = doc.createElement('div');
    grab.className = 'wg-sheet__grab';
    const { el: header, buttons: [cancelBtn] } = window.WGSheet.header({
        eyebrow: 'Feedback',
        title: 'Send feedback',
        actions: [{ label: 'Close', icon: 'x', attrs: { 'data-feedback-choice': 'cancel' } }],
    });

    const body = doc.createElement('div');
    body.className = 'wg-sheet__body';

    const textarea = doc.createElement('textarea');
    textarea.className = 'wg-feedback-modal__textarea';
    textarea.setAttribute('aria-label', 'Your feedback');
    textarea.placeholder = 'What would you like to tell us?';
    body.appendChild(textarea);

    // Capture buttons row: attach image + (optional) record voice.
    const capture = doc.createElement('div');
    capture.className = 'wg-feedback-modal__capture';

    const imageBtn = doc.createElement('button');
    imageBtn.type = 'button';
    imageBtn.className = 'wg-btn wg-btn--sm';
    imageBtn.setAttribute('data-feedback-attach', 'image');
    imageBtn.textContent = 'Attach image';
    capture.appendChild(imageBtn);

    let recordBtn = null;
    if (canRecordAudio()) {
        recordBtn = doc.createElement('button');
        recordBtn.type = 'button';
        recordBtn.className = 'wg-btn wg-btn--sm';
        recordBtn.setAttribute('data-feedback-record', 'idle');
        recordBtn.textContent = 'Record voice';
        capture.appendChild(recordBtn);
    }
    body.appendChild(capture);

    const chip = doc.createElement('p');
    chip.className = 'wg-feedback-modal__chip';
    chip.setAttribute('data-feedback-chip', '');
    body.appendChild(chip);

    const foot = doc.createElement('div');
    foot.className = 'wg-sheet__foot';
    const sendBtn = doc.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'wg-btn wg-btn--primary';
    sendBtn.setAttribute('data-feedback-choice', 'send');
    sendBtn.textContent = 'Send';
    foot.appendChild(sendBtn);

    modal.append(grab, header, body, foot);

    // --- capture state ---
    let imageBlob = null;
    let audioBlob = null;
    let audioHandle = null; // set while a recording is in progress
    let stopPromise = null; // in-flight handle.stop() while the blob resolves
    let starting = false;   // guards the recordAudio() await against a double-tap

    function chips() {
        const parts = [];
        if (imageBlob) parts.push('Image attached ✓');
        if (audioBlob) parts.push('Voice recorded ✓');
        chip.textContent = parts.join('  ·  ');
    }

    function refreshSend() {
        const hasText = textarea.value.trim().length > 0;
        sendBtn.disabled = !(hasText || imageBlob || audioBlob);
    }
    refreshSend();

    textarea.addEventListener('input', refreshSend);

    imageBtn.addEventListener('click', async () => {
        if (!(window.MediaCapture && typeof window.MediaCapture.pickPhoto === 'function')) return;
        try {
            const blob = await window.MediaCapture.pickPhoto({ capture: false });
            if (blob) { imageBlob = blob; chips(); refreshSend(); }
        } catch (_) { /* user cancelled or unavailable — leave state as-is */ }
    });

    if (recordBtn) {
        recordBtn.addEventListener('click', async () => {
            // idle → start; recording → stop.
            if (audioHandle) {
                const handle = audioHandle;
                audioHandle = null;
                recordBtn.disabled = true;
                stopPromise = handle.stop();
                try {
                    audioBlob = await stopPromise;
                    chips();
                } catch (_) { /* recording failed — drop it */ }
                stopPromise = null;
                recordBtn.disabled = false;
                recordBtn.textContent = 'Re-record voice';
                recordBtn.setAttribute('data-feedback-record', 'idle');
                refreshSend();
                return;
            }
            // A second tap while getUserMedia is still resolving would open a
            // second mic stream and orphan the first (never stopped). Guard it.
            if (starting) return;
            starting = true;
            recordBtn.disabled = true;
            try {
                const handle = await window.MediaCapture.recordAudio();
                // The modal may have been dismissed (cancel/escape/send) while
                // getUserMedia was still resolving. settle() couldn't cancel a
                // handle that didn't exist yet, so release the mic here — else
                // it records forever behind a closed modal.
                if (settled) {
                    try { handle.cancel(); } catch (_) { /* ignore */ }
                    return;
                }
                audioHandle = handle;
                recordBtn.textContent = 'Stop recording';
                recordBtn.setAttribute('data-feedback-record', 'recording');
            } catch (_) {
                audioHandle = null; // mic denied / unavailable — stay idle
            }
            starting = false;
            recordBtn.disabled = false;
        });
    }

    let settled = false;
    let sending = false; // re-entrancy guard for send() across its awaits
    function settle(action) {
        if (settled) return;
        settled = true;
        doc.removeEventListener('keydown', onKeydown, true);
        // Release the mic if a recording is still in flight on any exit path.
        if (audioHandle && typeof audioHandle.cancel === 'function') {
            try { audioHandle.cancel(); } catch (_) { /* ignore */ }
            audioHandle = null;
        }
        window.ModalManager.close(modal.id);
        window.ModalManager.register(modal.id, null);
        if (modal.parentNode) modal.parentNode.removeChild(modal);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (action === 'send') toast('Thanks — feedback sent');
    }

    async function send() {
        // Re-entrancy guard: the awaits below yield, and refreshSend() (fired by
        // textarea input) re-enables the button, so disabling it isn't enough to
        // stop a second send() from enqueueing the same feedback twice.
        if (sending) return;
        sending = true;
        sendBtn.disabled = true;
        // A recording still in progress (user tapped Send before Stop) would
        // otherwise be cancelled by settle() and the voice silently dropped.
        // Finish it here so it lands in the bundle.
        if (audioHandle) {
            const handle = audioHandle;
            audioHandle = null;
            try { audioBlob = await handle.stop(); } catch (_) { /* recording failed — drop it */ }
        } else if (stopPromise) {
            // Stop was tapped but its stop() is still resolving. Wait for the
            // blob so a fast Send-right-after-Stop doesn't enqueue without the
            // voice (audioBlob is still null mid-await). Can't rely on disabling
            // Send — refreshSend() (textarea input) re-enables it.
            try { audioBlob = await stopPromise; } catch (_) { /* recording failed — drop it */ }
        }
        const attachments = [];
        if (imageBlob) {
            attachments.push({ type: 'image', mime: imageBlob.type || 'image/jpeg', bytes: await imageBlob.arrayBuffer() });
        }
        if (audioBlob) {
            attachments.push({ type: 'audio', mime: audioBlob.type || 'audio/webm', bytes: await audioBlob.arrayBuffer() });
        }
        // The user may have cancelled (settle) during the stop/arrayBuffer
        // awaits — honor it and don't enqueue behind a closed modal.
        if (settled) return;
        // Anonymous: text + attachments only, no account id / PII (decided).
        const bundle = { text: textarea.value.trim(), attachments };
        try {
            await enqueueFeedback(bundle);
        } catch (_) { /* med-dni.3 owns delivery reliability; UI is optimistic */ }
        settle('send');
    }

    function onKeydown(e) {
        if (e.key === 'Escape') { e.preventDefault(); settle('cancel'); }
    }

    sendBtn.addEventListener('click', () => send());
    cancelBtn.addEventListener('click', () => settle('cancel'));
    backdrop.addEventListener('click', () => settle('cancel'));
    doc.addEventListener('keydown', onKeydown, true);

    doc.body.appendChild(backdrop);
    doc.body.appendChild(modal);
    // On the ModalManager stack so Back / Esc dismiss it like any sheet.
    window.ModalManager.register(modal.id, () => settle('cancel'));
    window.ModalManager.open(modal.id);
    try { textarea.focus(); } catch (_) { /* ignore */ }

    return modal;
}

// Mount the launcher as the Settings home's last group: one kit .wg-setting row
// (med-xso6.23, kit S1). Dedupe by id; wait for <body> if the document is still
// parsing (the #settings-view container is static in index.html, so it exists
// once the body is ready).
export async function mountFeedbackLauncher(ctx) {
    if (!document.body) {
        await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }
    const settingsView = document.getElementById('settings-view');
    if (!settingsView) return null;
    if (document.getElementById(LAUNCHER_ID)) return null;

    const group = document.createElement('div');
    group.id = 'feedback-settings';
    group.className = 'wg-list';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = LAUNCHER_ID;
    btn.className = 'wg-setting';

    const lead = document.createElement('span');
    lead.className = 'wg-row__lead wg-row__lead--sun';
    const ico = document.createElement('i');
    ico.className = 'wg-ico';
    ico.dataset.icon = 'message';
    lead.appendChild(ico);

    const body = document.createElement('span');
    body.className = 'wg-setting__body';
    const title = document.createElement('span');
    title.className = 'wg-setting__title';
    title.textContent = 'Send feedback';
    const desc = document.createElement('span');
    desc.className = 'wg-setting__desc';
    desc.textContent = canRecordAudio() ? 'Text, a screenshot or a voice note' : 'Text or a screenshot';
    body.append(title, desc);

    const chev = document.createElement('i');
    chev.className = 'wg-ico wg-row__chev';
    chev.dataset.icon = 'chev-r';

    btn.append(lead, body, chev);
    btn.addEventListener('click', () => openFeedbackModal());
    group.appendChild(btn);

    (settingsView.querySelector('.wg-settings-home') || settingsView).appendChild(group);
    if (window.WGIcons && typeof window.WGIcons.hydrate === 'function') window.WGIcons.hydrate(group);
    return btn;
}
