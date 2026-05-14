/**
 * safe-confirm.test.js
 *
 * Pins the contract of safeConfirm() after the native confirm() fallback
 * was replaced with an in-page <mt-modal>. The browser-mode tests assert
 * that the modal mounts, the buttons resolve the promise with the
 * expected boolean, the modal is removed from the DOM after resolve, and
 * that Escape / backdrop click both resolve false. The Telegram-mode
 * test guarantees tg.showConfirm is still the preferred path and that
 * no <mt-modal> is mounted when Telegram context is available.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('safeConfirm — browser mode (no Telegram context)', () => {
    let env;

    beforeEach(() => {
        // telegramInitData is '' so hasTelegramContext is false in safeConfirm.
        env = loadFrontendEnv({ telegramInitData: '' });
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

describe('safeConfirm — Telegram mode', () => {
    let env;

    afterEach(() => {
        if (env) env.cleanup();
        env = null;
    });

    it('uses tg.showConfirm and does not mount an mt-modal', async () => {
        env = loadFrontendEnv({ telegramInitData: 'user=abc' });
        const { window, document } = env;

        const showConfirmSpy = vi.fn((_msg, cb) => cb(true));
        window.Telegram.WebApp.showConfirm = showConfirmSpy;

        const promise = window.safeConfirm('TG path');
        // mt-modal must NOT be created when Telegram path is available
        expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
        expect(document.querySelector('.mt-confirm-backdrop')).toBeNull();

        await expect(promise).resolves.toBe(true);
        expect(showConfirmSpy).toHaveBeenCalledWith('TG path', expect.any(Function));
    });

    it('falls back to the in-page modal when tg.showConfirm throws', async () => {
        env = loadFrontendEnv({ telegramInitData: 'user=abc' });
        const { window, document } = env;

        window.Telegram.WebApp.showConfirm = vi.fn(() => { throw new Error('unsupported'); });

        const promise = window.safeConfirm('TG fallback');
        const modal = document.querySelector('mt-modal.mt-confirm-modal');
        expect(modal).not.toBeNull();
        modal.querySelector('.mt-confirm-modal__cancel').click();
        await expect(promise).resolves.toBe(false);
    });
});
