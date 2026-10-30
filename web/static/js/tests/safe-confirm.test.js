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
        expect(modal.querySelector('.wg-dialog__title').textContent).toBe('When did you eat this?');
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

    it.each([
        { destructive: true },
        { tone: 'danger' },
        { destructive: true, tone: 'warn', focusCancel: false },
        { tone: 'danger', focusCancel: false },
        { focusCancel: true },
        { tone: 'warn', focusCancel: true },
        { tone: 'info', focusCancel: true },
    ])('focuses Cancel for a plain confirm with %j and preserves callback cancellation', async (opts) => {
        const { window, document } = env;
        const callback = vi.fn((ok) => ok ? 'confirmed' : 'cancelled');
        const promise = window.safeConfirm('Continue?', callback, opts);
        expect(document.activeElement).toBe(document.querySelector('.mt-confirm-modal__cancel'));
        // jsdom does not synthesize native button activation from keyboard events.
        // Click the focused action here; real Enter activation is browser QA.
        document.activeElement.click();
        await expect(promise).resolves.toBe('cancelled');
        expect(callback).toHaveBeenCalledExactlyOnceWith(false);
        expect(document.querySelector('.mt-confirm-modal')).toBeNull();
    });

    it.each([
        {}, { tone: 'warn' }, { tone: 'info' },
        { focusCancel: false }, { focusCancel: 'true' }, { focusCancel: 1 },
    ])('keeps Confirm focused without an exact non-danger opt-in: %j', async (opts) => {
        const { window, document } = env;
        const promise = window.safeConfirm('Continue?', null, opts);
        expect(document.activeElement).toBe(document.querySelector('.mt-confirm-modal__confirm'));
        document.activeElement.click();
        await expect(promise).resolves.toBe(true);
    });

    it('keeps warn appearance and allows deliberate confirmation after Cancel initial focus', async () => {
        const { window, document } = env;
        const promise = window.safeConfirm('Merge these?', null, { tone: 'warn', icon: 'link', focusCancel: true });
        expect(document.querySelector('.wg-dialog__icon--warn svg[data-wg-icon="link"]')).not.toBeNull();
        const confirm = document.querySelector('.mt-confirm-modal__confirm');
        expect(confirm.classList.contains('wg-btn--primary')).toBe(true);
        expect(confirm.classList.contains('wg-btn--danger')).toBe(false);
        expect(document.activeElement).toBe(document.querySelector('.mt-confirm-modal__cancel'));
        confirm.focus();
        expect(document.activeElement).toBe(confirm);
        confirm.click();
        await expect(promise).resolves.toBe(true);
    });

    it('keeps prompt input and content/form focus and their settlement behavior', async () => {
        const { window, document } = env;
        const prompt = window.safePrompt('Name', { destructive: true, focusCancel: true, value: ' Test ' });
        const input = document.querySelector('.mt-confirm-modal__input');
        expect(document.activeElement).toBe(input);
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await expect(prompt).resolves.toBe('Test');

        const content = document.createElement('input');
        const collect = vi.fn(() => 'saved');
        const form = window.safeForm('Edit', content, { destructive: true, focusCancel: true, collect });
        expect(document.activeElement).toBe(document.querySelector('.mt-confirm-modal__confirm'));
        document.activeElement.click();
        await expect(form).resolves.toBe('saved');
        expect(collect).toHaveBeenCalledOnce();
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

    // med-xso6.6 — kit .wg-dialog anatomy: Cancel ghost, confirm sun primary
    // by default, filled clay with opts.destructive, optional icon.
    it('renders the kit dialog: ghost Cancel + sun primary confirm by default', async () => {
        const { window, document } = env;
        const promise = window.safeConfirm('Finish the workout?', null, { title: 'Finish?' });
        const modal = document.querySelector('mt-modal.mt-confirm-modal');
        expect(modal.classList.contains('wg-dialog')).toBe(true);
        expect(modal.getAttribute('role')).toBe('alertdialog');
        expect(modal.querySelector('.wg-dialog__title').textContent).toBe('Finish?');
        expect(modal.querySelector('.wg-dialog__body .mt-confirm-modal__message').textContent).toBe('Finish the workout?');
        const cancel = modal.querySelector('.wg-dialog__acts .mt-confirm-modal__cancel');
        const confirm = modal.querySelector('.wg-dialog__acts .mt-confirm-modal__confirm');
        expect(cancel.className).toContain('wg-btn wg-btn--ghost');
        expect(confirm.className).toContain('wg-btn wg-btn--primary');
        expect(confirm.classList.contains('wg-btn--danger')).toBe(false);
        expect(modal.querySelector('.wg-dialog__icon')).toBeNull();
        cancel.click();
        await expect(promise).resolves.toBe(false);
    });

    it('destructive: true paints the confirm filled clay and shows the danger icon', async () => {
        const { window, document } = env;
        const promise = window.safeConfirm('122/79 at 08:12 today.', null, {
            title: 'Delete this reading?', confirmLabel: 'Delete', destructive: true, icon: 'trash',
        });
        const modal = document.querySelector('mt-modal.mt-confirm-modal');
        const confirm = modal.querySelector('.mt-confirm-modal__confirm');
        expect(confirm.classList.contains('wg-btn--danger')).toBe(true);
        expect(confirm.classList.contains('wg-btn--primary')).toBe(false);
        const icon = modal.querySelector('.wg-dialog__icon');
        expect(icon).not.toBeNull();
        expect(icon.classList.contains('wg-dialog__icon--warn')).toBe(false);
        expect(icon.querySelector('svg[data-wg-icon="trash"]')).not.toBeNull();
        confirm.click();
        await expect(promise).resolves.toBe(true);
    });

    it('typedConfirm enables the confirm only once the phrase matches (case-insensitive)', async () => {
        const { window, document } = env;
        const promise = window.safeConfirm('This cannot be undone.', null, {
            title: 'Replace everything?', destructive: true, typedConfirm: 'replace', focusCancel: true,
        });
        const modal = document.querySelector('mt-modal.mt-confirm-modal');
        const input = modal.querySelector('.mt-confirm-modal__input');
        const confirm = modal.querySelector('.mt-confirm-modal__confirm');
        expect(document.activeElement).toBe(input);
        expect(modal.querySelector('.mt-confirm-modal__label').textContent).toContain('replace');
        expect(confirm.disabled).toBe(true);

        // Enter on a wrong phrase does not settle.
        input.value = 'repl';
        input.dispatchEvent(new window.Event('input'));
        expect(confirm.disabled).toBe(true);
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(document.querySelector('mt-modal.mt-confirm-modal')).not.toBeNull();

        input.value = '  Replace ';
        input.dispatchEvent(new window.Event('input'));
        expect(confirm.disabled).toBe(false);
        confirm.click();
        await expect(promise).resolves.toBe(true);
    });

    // med-ckm5.5 — the D1 dialog family on the one builder.
    describe('D1 dialog family', () => {
        it.each([
            ['danger', 'wg-dialog__icon', true],
            ['warn', 'wg-dialog__icon wg-dialog__icon--warn', false],
            ['info', 'wg-dialog__icon wg-dialog__icon--info', false],
        ])('tone %s picks the icon tile (and the clay confirm only for danger)', async (tone, iconClass, clay) => {
            const { window, document } = env;
            const promise = window.safeConfirm('', null, { title: 'T', icon: 'device', tone });
            const modal = document.querySelector('mt-modal.mt-confirm-modal');
            expect(modal.querySelector('.wg-dialog__icon').className).toBe(iconClass);
            expect(modal.querySelector('.mt-confirm-modal__confirm').classList.contains('wg-btn--danger')).toBe(clay);
            modal.querySelector('.mt-confirm-modal__cancel').click();
            await expect(promise).resolves.toBe(false);
        });

        it('warn tone with destructive keeps the warn icon and the clay confirm (Leave, Move)', async () => {
            const { window, document } = env;
            const promise = window.safeConfirm('', null, { title: 'Leave?', icon: 'device', tone: 'warn', destructive: true });
            const modal = document.querySelector('mt-modal.mt-confirm-modal');
            expect(modal.querySelector('.wg-dialog__icon--warn')).not.toBeNull();
            expect(modal.querySelector('.mt-confirm-modal__confirm').classList.contains('wg-btn--danger')).toBe(true);
            modal.querySelector('.mt-confirm-modal__confirm').click();
            await expect(promise).resolves.toBe(true);
        });

        it('facts render what goes (× is-gone) and what stays (✓), with no empty message', async () => {
            const { window, document } = env;
            const promise = window.safeConfirm('', null, {
                title: 'Erase?', destructive: true,
                facts: [{ text: 'All records here', gone: true }, { text: 'Exported files stay' }],
            });
            const modal = document.querySelector('mt-modal.mt-confirm-modal');
            expect(modal.querySelector('.mt-confirm-modal__message')).toBeNull();
            const items = [...modal.querySelectorAll('.wg-dialog__body ul.wg-dialog__facts > li')];
            expect(items.map((li) => li.textContent)).toEqual(['All records here', 'Exported files stay']);
            expect(items[0].classList.contains('is-gone')).toBe(true);
            expect(items[0].querySelector('svg.wg-ico[data-wg-icon="x"]')).not.toBeNull();
            expect(items[1].classList.contains('is-gone')).toBe(false);
            expect(items[1].querySelector('svg.wg-ico[data-wg-icon="check"]')).not.toBeNull();
            modal.querySelector('.mt-confirm-modal__confirm').click();
            await expect(promise).resolves.toBe(true);
        });

        it('typedConfirm renders the kit __confirm block with the word in mono and gates the confirm', async () => {
            const { window, document } = env;
            const promise = window.safeConfirm('', null, { title: 'Erase?', destructive: true, typedConfirm: 'ERASE' });
            const modal = document.querySelector('mt-modal.mt-confirm-modal');
            const block = modal.querySelector('.wg-dialog__confirm');
            expect(block.querySelector('.wg-label').textContent).toBe('Type ERASE to confirm');
            expect(block.querySelector('.wg-label b').textContent).toBe('ERASE');
            const input = block.querySelector('input.wg-input--text');
            expect(input.getAttribute('autocapitalize')).toBe('characters');
            const confirm = modal.querySelector('.mt-confirm-modal__confirm');
            expect(confirm.disabled).toBe(true);
            input.value = 'erase';
            input.dispatchEvent(new window.Event('input'));
            expect(confirm.disabled).toBe(false);
            confirm.click();
            await expect(promise).resolves.toBe(true);
        });

        it('a body link cancels the dialog, then runs its action', async () => {
            const { window, document } = env;
            const onClick = vi.fn();
            const promise = window.safeConfirm('if you might want them.', null, { title: 'Delete?', link: { label: 'Export a backup first', onClick } });
            const message = document.querySelector('.mt-confirm-modal__message');
            expect(message.textContent).toBe('Export a backup first if you might want them.');
            message.querySelector('button.wg-link').click();
            await expect(promise).resolves.toBe(false);
            expect(onClick).toHaveBeenCalledTimes(1);
            expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
        });
    });
});

// med-ckm5.5 — safeChoose with confirmLabel: choose, then Continue.
describe('safeChoose — choose + Continue', () => {
    let env;
    beforeEach(() => { env = loadFrontendEnv(); });
    afterEach(() => { env.cleanup(); env = null; });

    const open = (window, opts) => window.safeChoose('You already have records.', [
        { value: 'merge', label: 'Merge', sub: 'Keep both.' },
        { value: 'replace', label: 'Replace', sub: 'Delete these first' },
    ], { title: 'Records already here', icon: 'archive', tone: 'info', confirmLabel: 'Continue', ...opts });

    it('preselects the selected choice and Continue commits only it', async () => {
        const { window, document } = env;
        const promise = open(window, { selected: 'merge', destructive: true, focusCancel: true });
        const modal = document.querySelector('mt-modal.mt-confirm-modal');
        expect(modal.querySelector('.wg-dialog__icon--info')).not.toBeNull();
        const choices = [...modal.querySelectorAll('.mt-confirm-modal__choice')];
        expect(document.activeElement).toBe(choices[0]);
        expect(choices.map((c) => c.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
        expect(choices[0].querySelector('.wg-choice__sub').textContent).toBe('Keep both.');
        // Actions sit below the body, like a plain confirm.
        expect(modal.lastElementChild.classList.contains('wg-dialog__acts')).toBe(true);
        const confirm = modal.querySelector('.mt-confirm-modal__confirm');
        expect(confirm.textContent).toBe('Continue');
        expect(confirm.classList.contains('wg-btn--danger')).toBe(true);
        expect(document.querySelector('mt-modal.mt-confirm-modal')).not.toBeNull();
        confirm.click();
        await expect(promise).resolves.toBe('merge');
    });

    it('a tap only moves the selection; Continue settles the new one', async () => {
        const { window, document } = env;
        const promise = open(window, { selected: 'merge' });
        const choices = [...document.querySelectorAll('.mt-confirm-modal__choice')];
        choices[1].click();
        expect(document.querySelector('mt-modal.mt-confirm-modal')).not.toBeNull();
        expect(choices.map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
        document.querySelector('.mt-confirm-modal__confirm').click();
        await expect(promise).resolves.toBe('replace');
    });

    it('with nothing preselected Continue waits for a pick; Cancel resolves null', async () => {
        const { window, document } = env;
        const promise = open(window, { destructive: true, focusCancel: true });
        const confirm = document.querySelector('.mt-confirm-modal__confirm');
        expect(confirm.disabled).toBe(true);
        // Focusing a disabled Continue leaves focus on the body, as before.
        expect(document.activeElement).toBe(document.body);
        document.querySelector('.mt-confirm-modal__cancel').click();
        await expect(promise).resolves.toBeNull();
    });

    it('without confirmLabel a tap still settles at once (untouched callers)', async () => {
        const { window, document } = env;
        const promise = window.safeChoose('', [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], { title: 'Pick', destructive: true, focusCancel: true });
        expect(document.querySelector('.mt-confirm-modal__confirm')).toBeNull();
        expect(document.activeElement).toBe(document.querySelector('.mt-confirm-modal__cancel'));
        document.querySelectorAll('.mt-confirm-modal__choice')[1].click();
        await expect(promise).resolves.toBe('b');
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
        const promise = window.safeAlert('Saved offline', { destructive: true, focusCancel: true });

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
