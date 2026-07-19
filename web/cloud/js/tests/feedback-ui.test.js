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

import { mountFeedbackLauncher } from '../feedback-ui.js';

function q(sel) { return document.querySelector(sel); }
function click(el) { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }
async function flush() { await new Promise((r) => setTimeout(r, 0)); }

describe('feedback-ui', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        enqueueFeedback.mockReset();
        delete window.MediaCapture;
        delete window.SyncManager;
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('mounts one launcher (deduped by id)', async () => {
        await mountFeedbackLauncher({});
        await mountFeedbackLauncher({});
        expect(document.querySelectorAll('#feedback-launcher').length).toBe(1);
        expect(q('#feedback-launcher').textContent).toBe('Send feedback');
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
