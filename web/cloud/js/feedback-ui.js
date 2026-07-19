// feedback-ui.js — cloud-mode-only "Send feedback" capture UI (bd med-dni.2).
//
// mountFeedbackLauncher(ctx) drops one floating launcher button into the live
// app (post-unlock). Tapping it opens an <mt-modal> where anyone can compose
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
    backdrop.className = 'mt-confirm-backdrop';

    const modal = doc.createElement('mt-modal');
    modal.className = 'wg-modal wg-feedback-modal';
    modal.id = 'feedback-modal';

    const header = doc.createElement('div');
    header.className = 'wg-modal__header';
    const title = doc.createElement('h3');
    title.className = 'wg-modal__title';
    title.textContent = 'Send feedback';
    header.appendChild(title);

    const body = doc.createElement('div');
    body.className = 'wg-modal__body';

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
    imageBtn.className = 'wg-gloss';
    imageBtn.setAttribute('data-feedback-attach', 'image');
    imageBtn.textContent = 'Attach image';
    capture.appendChild(imageBtn);

    let recordBtn = null;
    if (canRecordAudio()) {
        recordBtn = doc.createElement('button');
        recordBtn.type = 'button';
        recordBtn.className = 'wg-gloss';
        recordBtn.setAttribute('data-feedback-record', 'idle');
        recordBtn.textContent = 'Record voice';
        capture.appendChild(recordBtn);
    }
    body.appendChild(capture);

    const chip = doc.createElement('p');
    chip.className = 'wg-feedback-modal__chip';
    chip.setAttribute('data-feedback-chip', '');
    body.appendChild(chip);

    const actions = doc.createElement('div');
    actions.className = 'wg-modal__actions';
    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'wg-gloss';
    cancelBtn.setAttribute('data-feedback-choice', 'cancel');
    cancelBtn.textContent = 'Cancel';
    const sendBtn = doc.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'wg-gloss wg-gloss--sun';
    sendBtn.setAttribute('data-feedback-choice', 'send');
    sendBtn.textContent = 'Send';
    actions.appendChild(cancelBtn);
    actions.appendChild(sendBtn);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(actions);

    // --- capture state ---
    let imageBlob = null;
    let audioBlob = null;
    let audioHandle = null; // set while a recording is in progress
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
                try {
                    audioBlob = await handle.stop();
                    chips();
                } catch (_) { /* recording failed — drop it */ }
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
    function settle(action) {
        if (settled) return;
        settled = true;
        doc.removeEventListener('keydown', onKeydown, true);
        // Release the mic if a recording is still in flight on any exit path.
        if (audioHandle && typeof audioHandle.cancel === 'function') {
            try { audioHandle.cancel(); } catch (_) { /* ignore */ }
            audioHandle = null;
        }
        if (typeof modal.close === 'function') { try { modal.close(); } catch (_) { /* ignore */ } }
        if (modal.parentNode) modal.parentNode.removeChild(modal);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (action === 'send') toast('Thanks — feedback sent');
    }

    async function send() {
        // Disable first — the arrayBuffer() awaits below yield, so a fast
        // double-tap would otherwise enqueue the same feedback twice.
        sendBtn.disabled = true;
        const attachments = [];
        if (imageBlob) {
            attachments.push({ type: 'image', mime: imageBlob.type || 'image/jpeg', bytes: await imageBlob.arrayBuffer() });
        }
        if (audioBlob) {
            attachments.push({ type: 'audio', mime: audioBlob.type || 'audio/webm', bytes: await audioBlob.arrayBuffer() });
        }
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
    if (typeof modal.open === 'function') { try { modal.open(); } catch (_) { /* ignore */ } }
    try { textarea.focus(); } catch (_) { /* ignore */ }

    return modal;
}

// Drop the launcher into the live app. Dedupe by id; wait for <body> if the
// document is still parsing (copy of the cloud-boot auth-expired banner mount).
export async function mountFeedbackLauncher(ctx) {
    if (!document.body) {
        await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }
    if (document.getElementById(LAUNCHER_ID)) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = LAUNCHER_ID;
    btn.className = 'wg-gloss wg-feedback-launcher';
    btn.textContent = 'Send feedback';
    btn.addEventListener('click', () => openFeedbackModal());
    document.body.appendChild(btn);
    return btn;
}
