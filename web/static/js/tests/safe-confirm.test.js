/**
 * safe-confirm.test.js
 *
 * Pins the contract of safeConfirm() after the native confirm() fallback
 * was replaced with an in-page <mt-modal>. The browser-mode tests assert
 * that the modal mounts, the buttons resolve the promise with the
 * expected boolean, the modal is removed from the DOM after resolve, and
 * that Escape / backdrop click both resolve false.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('safeConfirm — in-page modal', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('mounts an <mt-modal> and resolves true when Confirm is clicked', async () => {
        const { window, document } = env;
        const promise = window.safeConfirm('Are you sure?');

        // Modal should be in the DOM with our class hook
        const modal = document.querySelector('mt-modal.mt-confirm-modal');
        expect(modal).not.toBeNull();
        const message = modal.querySelector('.mt-confirm-modal__message');
        expect(message.textContent).toBe('Are you sure?');

        const confirmBtn = modal.querySelector('.mt-confirm-modal__confirm');
        expect(confirmBtn).not.toBeNull();
        confirmBtn.click();

        await expect(promise).resolves.toBe(true);
        // Modal is removed after resolve
        expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
        expect(document.querySelector('.mt-confirm-backdrop')).toBeNull();
    });

    it('renders custom title and button labels when opts are passed', async () => {
        const { window, document } = env;
        const promise = window.safeConfirm('This photo was taken on May 30.', null, {
            title: 'When did you eat this?',
            cancelLabel: 'Use now',
            confirmLabel: 'Use photo time',
        });

        const modal = document.querySelector('mt-modal.mt-confirm-modal');
        expect(modal.querySelector('.wg-modal__title').textContent).toBe('When did you eat this?');
        expect(modal.querySelector('.mt-confirm-modal__cancel').textContent).toBe('Use now');
        expect(modal.querySelector('.mt-confirm-modal__confirm').textContent).toBe('Use photo time');

        modal.querySelector('.mt-confirm-modal__confirm').click();
        await expect(promise).resolves.toBe(true);
    });

    it('resolves false when Cancel is clicked', async () => {
        const { window, document } = env;
        const promise = window.safeConfirm('Delete this thing?');

        const cancelBtn = document.querySelector('.mt-confirm-modal__cancel');
        expect(cancelBtn).not.toBeNull();
        cancelBtn.click();

        await expect(promise).resolves.toBe(false);
        expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
    });

    it('resolves false on Escape keydown and removes the backdrop', async () => {
        const { window, document } = env;
        const promise = window.safeConfirm('Escape me');

        expect(document.querySelector('.mt-confirm-backdrop')).not.toBeNull();
        const evt = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
        document.dispatchEvent(evt);

        await expect(promise).resolves.toBe(false);
        expect(document.querySelector('.mt-confirm-backdrop')).toBeNull();
        expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
    });

    it('resolves false when the backdrop is clicked', async () => {
        const { window, document } = env;
        const promise = window.safeConfirm('Click outside');

        const backdrop = document.querySelector('.mt-confirm-backdrop');
        expect(backdrop).not.toBeNull();
        backdrop.click();

        await expect(promise).resolves.toBe(false);
        expect(document.querySelector('.mt-confirm-backdrop')).toBeNull();
    });

    it('removes the modal element after resolving', async () => {
        const { window, document } = env;
        const promise = window.safeConfirm('Remove me');
        document.querySelector('.mt-confirm-modal__confirm').click();
        await promise;
        expect(document.querySelector('.mt-confirm-modal')).toBeNull();
        expect(document.querySelector('.mt-confirm-backdrop')).toBeNull();
    });

    it('passes the boolean result to the callback and resolves with its return value', async () => {
        const { window, document } = env;
        const callback = vi.fn(async (ok) => (ok ? 'yes' : 'no'));
        const promise = window.safeConfirm('Callback test', callback);
        document.querySelector('.mt-confirm-modal__confirm').click();
        const result = await promise;
        expect(callback).toHaveBeenCalledWith(true);
        expect(result).toBe('yes');
    });
});

// med-v83g: safeAlert is the in-page dialog's alert mode — one OK button in
// the cancel slot (so modal-manager's Back-cancels-first path dismisses it),
// never a native alert().
describe('safeAlert — in-page alert mode', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('renders the styled dialog with only an OK button and resolves on OK', async () => {
        const { window, document } = env;
        const nativeAlert = vi.fn();
        window.alert = nativeAlert;
        const promise = window.safeAlert('Saved offline');

        const modal = document.querySelector('mt-modal.mt-confirm-modal');
        expect(modal).not.toBeNull();
        expect(modal.querySelector('.mt-confirm-modal__message').textContent).toBe('Saved offline');
        expect(modal.querySelector('.mt-confirm-modal__confirm')).toBeNull();
        const ok = modal.querySelector('.mt-confirm-modal__cancel');
        expect(ok.textContent).toBe('OK');
        expect(document.activeElement).toBe(ok);

        ok.click();
        await expect(promise).resolves.toBeUndefined();
        expect(document.querySelector('.mt-confirm-modal')).toBeNull();
        expect(document.querySelector('.mt-confirm-backdrop')).toBeNull();
        expect(nativeAlert).not.toHaveBeenCalled();
    });

    it('settles on Escape and on a backdrop click', async () => {
        const { window, document } = env;
        const first = window.safeAlert('one');
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await first;
        expect(document.querySelector('.mt-confirm-modal')).toBeNull();

        const second = window.safeAlert('two');
        document.querySelector('.mt-confirm-backdrop').click();
        await second;
        expect(document.querySelector('.mt-confirm-modal')).toBeNull();
    });

    it('is dismissed by Back (ModalManager closes the dialog first)', async () => {
        const { window, document } = env;
        const promise = window.safeAlert('back me out');
        expect(window.ModalManager.closeTopMostVisibleModal()).toBe(true);
        await promise;
        expect(document.querySelector('.mt-confirm-modal')).toBeNull();
    });
});

describe('safeToast — toast dispatch with alert fallback (med-omvw)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('prefers SyncManager.showToast with the given type, defaulting to info', () => {
        const { window } = env;
        const toastSpy = vi.fn();
        window.SyncManager = { showToast: toastSpy };

        window.safeToast('Saved', 'info');
        window.safeToast('Failed', 'error');
        window.safeToast('Defaulted');

        expect(toastSpy).toHaveBeenNthCalledWith(1, 'Saved', 'info');
        expect(toastSpy).toHaveBeenNthCalledWith(2, 'Failed', 'error');
        expect(toastSpy).toHaveBeenNthCalledWith(3, 'Defaulted', 'info');
    });

    it('falls back to safeAlert when no toast surface exists', () => {
        const { window } = env;
        window.SyncManager = {};
        const alertSpy = vi.fn();
        window.safeAlert = alertSpy;

        window.safeToast('Fallback message', 'error');

        expect(alertSpy).toHaveBeenCalledWith('Fallback message');
    });
});
