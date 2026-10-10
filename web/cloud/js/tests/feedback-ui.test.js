/**
 * @vitest-environment jsdom
 *
 * feedback-ui.test.js (bd med-dni.2, Task 2)
 *
 * The cloud-only feedback capture UI: launcher → modal → anonymous bundle →
 * enqueueFeedback seam. enqueueFeedback is stubbed here (med-dni.3 fills it),
 * so the test spies on it and asserts the assembled bundle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// jsdom's Blob lacks arrayBuffer(); Node's does (matching real-browser Blobs
// returned by MediaCapture at runtime), so build attachment blobs from it.
import { Blob } from 'node:buffer';

const { enqueueFeedback } = vi.hoisted(() => ({ enqueueFeedback: vi.fn() }));
vi.mock('../feedback-submit.js', () => ({ enqueueFeedback }));

// The account app loads these classic scripts before feedback-ui: the modal is
// a kit sheet (WGSheet header) on the ModalManager stack (med-xso6.7).
import '../../../static/js/core/modal-manager.js';
import '../../../static/js/components/wg-sheet.js';
import { mountFeedbackLauncher } from '../feedback-ui.js';

function q(sel) { return document.querySelector(sel); }
function click(el) { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }
async function flush() { await new Promise((r) => setTimeout(r, 0)); }

describe('feedback-ui', () => {
    beforeEach(() => {
        // The launcher mounts into the static Settings home (index.html
        // .wg-settings-home) as its last group — seed that shape.
        document.body.innerHTML =
            '<div id="settings-view">'
            + '<div class="wg-settings-home"><div class="wg-list" id="everyday"></div></div>'
            + '<footer class="wg-settings-footer"></footer>'
            + '</div>';
        enqueueFeedback.mockReset();
        delete window.MediaCapture;
        delete window.SyncManager;
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('mounts one launcher row (deduped by id) as the last Settings home group', async () => {
        await mountFeedbackLauncher({});
        await mountFeedbackLauncher({});
        expect(document.querySelectorAll('#feedback-launcher').length).toBe(1);
        const row = q('#feedback-launcher');
        expect(row.classList.contains('wg-setting')).toBe(true);
        expect(row.querySelector('.wg-setting__title').textContent).toBe('Send feedback');
        expect(row.querySelector('.wg-setting__desc').textContent).toBe('Text or a screenshot');
        // A kit .wg-list group of its own, after the existing groups.
        const group = q('#feedback-settings');
        expect(group.classList.contains('wg-list')).toBe(true);
        expect(q('.wg-settings-home').lastElementChild).toBe(group);
    });

    it('does nothing when there is no Settings view', async () => {
        document.body.innerHTML = '';
        const res = await mountFeedbackLauncher({});
        expect(res).toBeNull();
        expect(q('#feedback-launcher')).toBeNull();
    });

    it('opens the modal on launcher click; Send disabled until content', async () => {
        await mountFeedbackLauncher({});
        click(q('#feedback-launcher'));
        expect(q('#feedback-modal')).toBeTruthy();
        const send = q('[data-feedback-choice="send"]');
        expect(send.disabled).toBe(true);

        const ta = q('.wg-feedback-modal__textarea');
        ta.value = 'hello';
        ta.dispatchEvent(new window.Event('input', { bubbles: true }));
        expect(send.disabled).toBe(false);
    });

    it('Send assembles an anonymous bundle with text + image + audio attachments', async () => {
        const imgBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
        const audBlob = new Blob([new Uint8Array([4, 5])], { type: 'audio/webm' });
        const audioHandle = { stop: vi.fn().mockResolvedValue(audBlob), cancel: vi.fn() };
        window.MediaCapture = {
            pickPhoto: vi.fn().mockResolvedValue(imgBlob),
            recordAudio: vi.fn().mockResolvedValue(audioHandle),
        };

        await mountFeedbackLauncher({});
        click(q('#feedback-launcher'));

        const ta = q('.wg-feedback-modal__textarea');
        ta.value = 'nice app';
        ta.dispatchEvent(new window.Event('input', { bubbles: true }));

        click(q('[data-feedback-attach="image"]'));
        await flush();

        // Record → Stop toggle captures the audio Blob.
        const recBtn = q('[data-feedback-record]');
        click(recBtn);
        await flush();
        expect(recBtn.getAttribute('data-feedback-record')).toBe('recording');
        click(recBtn);
        await flush();
        expect(audioHandle.stop).toHaveBeenCalled();

        click(q('[data-feedback-choice="send"]'));
        await flush();

        expect(enqueueFeedback).toHaveBeenCalledTimes(1);
        const bundle = enqueueFeedback.mock.calls[0][0];
        expect(bundle.text).toBe('nice app');
        expect(bundle.attachments.map((a) => a.type).sort()).toEqual(['audio', 'image']);
        const img = bundle.attachments.find((a) => a.type === 'image');
        const aud = bundle.attachments.find((a) => a.type === 'audio');
        expect(img.mime).toBe('image/jpeg');
        expect(aud.mime).toBe('audio/webm');
        expect(new Uint8Array(img.bytes)).toEqual(new Uint8Array([1, 2, 3]));
        expect(new Uint8Array(aud.bytes)).toEqual(new Uint8Array([4, 5]));
        // Anonymous: no account id / PII fields.
        expect(Object.keys(bundle).sort()).toEqual(['attachments', 'text']);

        // Modal closed after send.
        expect(q('#feedback-modal')).toBeFalsy();
    });

    it('Send while still recording finishes the recording — voice is not dropped', async () => {
        const audBlob = new Blob([new Uint8Array([7, 8])], { type: 'audio/webm' });
        const audioHandle = { stop: vi.fn().mockResolvedValue(audBlob), cancel: vi.fn() };
        window.MediaCapture = { pickPhoto: vi.fn(), recordAudio: vi.fn().mockResolvedValue(audioHandle) };

        await mountFeedbackLauncher({});
        click(q('#feedback-launcher'));

        const ta = q('.wg-feedback-modal__textarea');
        ta.value = 'note';
        ta.dispatchEvent(new window.Event('input', { bubbles: true }));

        click(q('[data-feedback-record]'));   // start recording
        await flush();
        click(q('[data-feedback-choice="send"]'));  // Send before tapping Stop
        await flush();

        // The in-flight recording was stopped (not cancelled) and its blob bundled.
        expect(audioHandle.stop).toHaveBeenCalled();
        expect(audioHandle.cancel).not.toHaveBeenCalled();
        const bundle = enqueueFeedback.mock.calls[0][0];
        expect(bundle.attachments.map((a) => a.type)).toContain('audio');
        expect(new Uint8Array(bundle.attachments.find((a) => a.type === 'audio').bytes))
            .toEqual(new Uint8Array([7, 8]));
    });

    it('Send tapped during the Stop await still bundles the voice (no data loss)', async () => {
        // Stop nulls audioHandle before awaiting stop(); a fast Send during that
        // await must wait on the in-flight stop() rather than enqueue without it.
        let resolveStop;
        const audBlob = new Blob([new Uint8Array([5, 6])], { type: 'audio/webm' });
        const audioHandle = {
            stop: vi.fn(() => new Promise((r) => { resolveStop = () => r(audBlob); })),
            cancel: vi.fn(),
        };
        window.MediaCapture = { pickPhoto: vi.fn(), recordAudio: vi.fn().mockResolvedValue(audioHandle) };

        await mountFeedbackLauncher({});
        click(q('#feedback-launcher'));
        const ta = q('.wg-feedback-modal__textarea');
        ta.value = 'note';
        ta.dispatchEvent(new window.Event('input', { bubbles: true }));

        const recBtn = q('[data-feedback-record]');
        click(recBtn);          // start recording
        await flush();
        click(recBtn);          // Stop — stop() stays pending
        await flush();
        click(q('[data-feedback-choice="send"]')); // Send while stop() still resolving
        await flush();
        resolveStop();          // recording finalizes after Send began
        await flush();

        expect(audioHandle.stop).toHaveBeenCalledTimes(1);
        expect(enqueueFeedback).toHaveBeenCalledTimes(1);
        const bundle = enqueueFeedback.mock.calls[0][0];
        expect(bundle.attachments.map((a) => a.type)).toContain('audio');
        expect(new Uint8Array(bundle.attachments.find((a) => a.type === 'audio').bytes))
            .toEqual(new Uint8Array([5, 6]));
    });

    it('Cancel during an active recording releases the mic (settle cancels the handle)', async () => {
        const audioHandle = { stop: vi.fn(), cancel: vi.fn() };
        window.MediaCapture = { pickPhoto: vi.fn(), recordAudio: vi.fn().mockResolvedValue(audioHandle) };

        await mountFeedbackLauncher({});
        click(q('#feedback-launcher'));
        const recBtn = q('[data-feedback-record]');
        click(recBtn);          // start recording
        await flush();
        expect(recBtn.getAttribute('data-feedback-record')).toBe('recording'); // handle set
        click(q('[data-feedback-choice="cancel"]')); // Cancel with a recording in progress

        // settle() must cancel the live handle — the exact mic-leak this UI prevents.
        expect(audioHandle.cancel).toHaveBeenCalled();
        expect(audioHandle.stop).not.toHaveBeenCalled();
        expect(enqueueFeedback).not.toHaveBeenCalled();
    });

    it('Cancel during an in-flight send does not enqueue', async () => {
        // stop() stays pending so send() is suspended mid-flight; Cancel fires
        // during that await. The feedback must NOT be enqueued behind the modal.
        let resolveStop;
        const audioHandle = {
            stop: vi.fn(() => new Promise((r) => { resolveStop = () => r(new Blob([new Uint8Array([1])], { type: 'audio/webm' })); })),
            cancel: vi.fn(),
        };
        window.MediaCapture = { pickPhoto: vi.fn(), recordAudio: vi.fn().mockResolvedValue(audioHandle) };

        await mountFeedbackLauncher({});
        click(q('#feedback-launcher'));
        q('.wg-feedback-modal__textarea').value = 'note';
        click(q('[data-feedback-record]'));   // start recording
        await flush();
        click(q('[data-feedback-choice="send"]'));  // send() suspends on stop()
        await flush();
        click(q('[data-feedback-choice="cancel"]')); // cancel while send is in flight
        resolveStop();
        await flush();

        expect(enqueueFeedback).not.toHaveBeenCalled();
    });

    it('renders as a kit sheet on the ModalManager stack: the close X in the header, Send in the foot', async () => {
        await mountFeedbackLauncher({});
        click(q('#feedback-launcher'));
        const modal = q('#feedback-modal');
        expect(modal.classList.contains('wg-sheet')).toBe(true);
        const close = q('#feedback-modal .wg-sheethead__acts [data-feedback-choice="cancel"]');
        expect(close.className).toBe('wg-btn wg-btn--ghost wg-btn--icon');
        expect(close.getAttribute('aria-label')).toBe('Close');
        expect(close.querySelector('.wg-ico[data-icon="x"]')).toBeTruthy();
        expect(q('#feedback-modal .wg-sheet__foot [data-feedback-choice="send"]').className).toContain('wg-btn--primary');
        expect(window.ModalManager.isAnyOpen()).toBe(true);
        // Single dim: the stack's #modal-overlay dims, the own backdrop is
        // the transparent tap-catcher (rule pinned in features.trial-consent).
        expect(q('.mt-confirm-backdrop').classList.contains('wg-sheet-backdrop')).toBe(true);

        // Back / Esc route through the stack's registered closer.
        expect(window.ModalManager.closeTopMostVisibleModal()).toBe(true);
        expect(q('#feedback-modal')).toBeFalsy();
        expect(enqueueFeedback).not.toHaveBeenCalled();
    });

    it('Cancel and Escape close without calling enqueue', async () => {
        await mountFeedbackLauncher({});

        click(q('#feedback-launcher'));
        q('.wg-feedback-modal__textarea').value = 'x';
        click(q('[data-feedback-choice="cancel"]'));
        expect(q('#feedback-modal')).toBeFalsy();

        click(q('#feedback-launcher'));
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
        expect(q('#feedback-modal')).toBeFalsy();

        expect(enqueueFeedback).not.toHaveBeenCalled();
    });

    it('ignores a second Record tap while the first is still starting (no double mic)', async () => {
        let resolveRec;
        const audBlob = new Blob([new Uint8Array([9])], { type: 'audio/webm' });
        const audioHandle = { stop: vi.fn().mockResolvedValue(audBlob), cancel: vi.fn() };
        const recordAudio = vi.fn(() => new Promise((r) => { resolveRec = () => r(audioHandle); }));
        window.MediaCapture = { pickPhoto: vi.fn(), recordAudio };

        await mountFeedbackLauncher({});
        click(q('#feedback-launcher'));
        const recBtn = q('[data-feedback-record]');
        click(recBtn);          // starts recording (getUserMedia still pending)
        click(recBtn);          // second tap while starting — must be a no-op
        resolveRec();
        await flush();
        expect(recordAudio).toHaveBeenCalledTimes(1);
    });

    it('releases the mic if the modal closes while a recording is still starting', async () => {
        let resolveRec;
        const audioHandle = { stop: vi.fn(), cancel: vi.fn() };
        const recordAudio = vi.fn(() => new Promise((r) => { resolveRec = () => r(audioHandle); }));
        window.MediaCapture = { pickPhoto: vi.fn(), recordAudio };

        await mountFeedbackLauncher({});
        click(q('#feedback-launcher'));
        click(q('[data-feedback-record]'));            // start (getUserMedia pending)
        click(q('[data-feedback-choice="cancel"]'));   // close modal mid-start
        expect(q('#feedback-modal')).toBeFalsy();
        resolveRec();
        await flush();
        // settle() ran while audioHandle was still null, so the handler itself
        // must cancel once recordAudio resolves — or the mic records forever.
        expect(audioHandle.cancel).toHaveBeenCalled();
        expect(audioHandle.stop).not.toHaveBeenCalled();
    });

    it('hides the Record button when recordAudio is unavailable (graceful degradation)', async () => {
        window.MediaCapture = { pickPhoto: vi.fn() }; // no recordAudio
        await mountFeedbackLauncher({});
        click(q('#feedback-launcher'));
        expect(q('[data-feedback-record]')).toBeFalsy();
        expect(q('[data-feedback-attach="image"]')).toBeTruthy();
    });
});
