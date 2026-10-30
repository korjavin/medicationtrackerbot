// Medication editor (kit M5–M6, med-xso6.20).
//
// #med-modal is a pushed .wg-page on the modal stack: Cancel / Save in the
// page bar, Basics → Schedule → Inventory → Advanced sections, Rx chip +
// inline interaction warning, a times list, date value rows opening a hidden
// picker, a stock stepper, a time-zone value row opening safeChoose, Archived
// / Supplement toggles, and a destructive Delete only when deletion is
// allowed. The saved payload keeps the existing shape.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

async function seedMedications(window, meds) {
    window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(meds);
    });
    window.apiCall = vi.fn().mockResolvedValue([]);
    await window.loadMeds();
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Medication editor page (kit M5–M6)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('is a pushed .wg-page with the close X / Save in the page bar and four sections in order', () => {
        const { document } = env;
        const page = document.getElementById('med-modal');
        expect(page.classList.contains('wg-page')).toBe(true);

        const bar = page.querySelector(':scope > .wg-pagebar');
        expect(bar).not.toBeNull();
        const kids = Array.from(bar.children);
        expect(kids[0].id).toBe('med-modal-cancel-btn');
        expect(kids[kids.length - 1].id).toBe('med-modal-save-btn');
        expect(document.getElementById('med-modal-save-btn').classList.contains('wg-btn--primary')).toBe(true);

        const sections = Array.from(page.querySelectorAll('.wg-content > .wg-section')).map((s) => s.dataset.medSection);
        expect(sections).toEqual(['basics', 'schedule', 'inventory', 'advanced']);
    });

    it('has no visible native select, date input or checkbox', () => {
        const { document } = env;
        const page = document.getElementById('med-modal');
        expect(page.querySelector('select')).toBeNull();
        page.querySelectorAll('input[type="date"]').forEach((input) => {
            expect(input.classList.contains('wg-meds-editor__date-input')).toBe(true);
            expect(input.getAttribute('tabindex')).toBe('-1');
        });
        const boxes = page.querySelectorAll('input[type="checkbox"]');
        expect(boxes.length).toBe(3);
        boxes.forEach((box) => {
            expect(box.classList.contains('wg-toggle__input')).toBe(true);
            expect(box.parentElement.classList.contains('wg-toggle')).toBe(true);
        });
    });

    it('showAddModal opens the page reset for a new medication', () => {
        const { document, window } = env;
        window.showAddModal();

        expect(document.getElementById('med-modal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('med-modal-title').textContent).toBe('New medication');
        expect(document.getElementById('med-name').value).toBe('');
        expect(document.getElementById('schedule-type').value).toBe('daily');
        expect(document.querySelector('[data-schedule-type="daily"]').getAttribute('aria-pressed')).toBe('true');
        expect(document.querySelectorAll('#time-inputs .time-row')).toHaveLength(1);
        expect(document.getElementById('med-start-date-value').textContent).toBe('Not set');
        expect(document.getElementById('med-end-date-value').textContent).toBe('Ongoing');
        expect(document.getElementById('med-tz-policy-value').textContent).toBe('Flexible');
        expect(document.getElementById('med-rx-display').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('med-rx-warning').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('med-delete-block').classList.contains('hidden')).toBe(true);
    });

    it('schedule segment swaps the Days / Times blocks', () => {
        const { document, window } = env;
        window.showAddModal();
        const days = document.getElementById('days-container');
        const times = document.getElementById('times-container');

        document.querySelector('[data-schedule-type="weekly"]').click();
        expect(document.getElementById('schedule-type').value).toBe('weekly');
        expect(document.querySelector('[data-schedule-type="weekly"]').getAttribute('aria-pressed')).toBe('true');
        expect(document.querySelector('[data-schedule-type="daily"]').getAttribute('aria-pressed')).toBe('false');
        expect(days.classList.contains('hidden')).toBe(false);
        expect(times.classList.contains('hidden')).toBe(false);

        document.querySelector('[data-schedule-type="as_needed"]').click();
        expect(days.classList.contains('hidden')).toBe(true);
        expect(times.classList.contains('hidden')).toBe(true);
    });

    it('times are kit list rows with Remove, and Add time appends one', () => {
        const { document, window } = env;
        window.showAddModal();
        const list = document.getElementById('time-inputs');

        document.getElementById('add-time-btn').click();
        expect(list.querySelectorAll('.wg-row.time-row')).toHaveLength(2);
        const row = list.querySelector('.time-row:last-child');
        expect(row.querySelector('.wg-row__lead')).not.toBeNull();
        expect(row.querySelector('input.med-time-input[type="time"]')).not.toBeNull();

        row.querySelector('.remove-time').click();
        expect(list.querySelectorAll('.time-row')).toHaveLength(1);
    });

    // med-fhil (kit O3): WebKit draws an empty time input blank, so a new row
    // says "Set time" (sun) until a value is picked, then is the normal row.
    it('Add time renders a "Set time" row that becomes the time row once picked', () => {
        const { document, window } = env;
        window.showAddModal();
        document.getElementById('add-time-btn').click();
        const row = document.querySelector('#time-inputs .time-row:last-child');
        const input = row.querySelector('input.med-time-input[type="time"]');

        expect(row.classList.contains('is-unset')).toBe(true);
        expect(row.querySelector('.wg-row__lead').classList.contains('wg-row__lead--sun')).toBe(true);
        expect(row.querySelector('.wg-meds-editor__unset .wg-sun').textContent).toBe('Set time');
        expect(row.querySelector('.wg-meds-editor__unset .wg-row__meta').textContent).toBe('Tap to choose · not saved yet');

        // Tapping it opens the picker where the browser can.
        input.showPicker = vi.fn();
        input.click();
        expect(input.showPicker).toHaveBeenCalledTimes(1);

        input.value = '08:30';
        input.dispatchEvent(new window.Event('input'));
        expect(row.classList.contains('is-unset')).toBe(false);
        expect(row.querySelector('.wg-row__lead').classList.contains('wg-row__lead--sun')).toBe(false);
        input.click();
        expect(input.showPicker).toHaveBeenCalledTimes(1);

        // A saved time opens as a plain time row.
        window.addTimeInput('20:00');
        expect(document.querySelector('#time-inputs .time-row:last-child').classList.contains('is-unset')).toBe(false);
    });

    // med-ckm5.4: the warn note sits under the Times when notifications are off.
    it('shows "Reminders won\'t fire" under the times when notifications are denied', async () => {
        const { document, window } = env;
        window.Notification = { permission: 'denied' };
        window.showAddModal();
        await flush();
        const note = document.querySelector('#times-container #med-notify-note .wg-note--warn[data-notify-denied]');
        expect(note).not.toBeNull();
        expect(note.textContent).toContain('Reminders won’t fire. Notifications are off for Med Tracker.');

        window.Notification = { permission: 'granted' };
        window.showAddModal();
        await flush();
        expect(document.getElementById('med-notify-note').children).toHaveLength(0);
    });

    it('in the app shell the note offers Open iOS Settings when the shell has the op', async () => {
        const { document, window } = env;
        const call = vi.fn(async (op) => (op === 'shell.ops' ? ['notifications.openSettings'] : undefined));
        window.LocalNotifications = {
            isSupported: () => true,
            permission: vi.fn(async () => 'denied'),
            copy: { os: 'iOS', settingsPath: 'iOS Settings → Med Tracker → Notifications' },
            __native: { call },
        };
        window.showAddModal();
        await flush();
        await flush();
        const btn = document.querySelector('#med-notify-note [data-notify-open-settings]');
        expect(btn).not.toBeNull();
        expect(btn.textContent).toBe('Open iOS Settings');
        btn.click();
        expect(call).toHaveBeenCalledWith('notifications.openSettings');
    });

    // med-ckm5.4 / med-1ikf: the kit sheet before the one system prompt, asked
    // once per device and only while the permission is undecided.
    it('NotifyPermission.maybeAsk opens the sheet once per device while permission is default', async () => {
        const { document, window } = env;
        const requestPermission = vi.fn(async () => 'granted');
        window.LocalNotifications = { isSupported: () => true, permission: vi.fn(async () => 'default'), requestPermission };
        window.apiCall = vi.fn(async (url, method, body) => (method === 'PUT' ? body : { verbosity: 'generic' }));

        const first = window.NotifyPermission.maybeAsk();
        await flush();
        await flush();
        const sheet = document.getElementById('notify-permission-sheet');
        expect(sheet).not.toBeNull();
        expect(sheet.querySelector('.wg-eyebrow').textContent).toBe('Reminders');
        expect(sheet.querySelector('.wg-sheethead__title').textContent).toBe('Let Med Tracker remind you');
        expect(Array.from(sheet.querySelectorAll('.wg-facts b')).map((b) => b.textContent))
            .toEqual(['Only what you schedule', 'Change it any time']);
        // Account mode carries the RD1 choice too (med-5vy0).
        expect(sheet.querySelector('[data-notify-verbosity] .wg-choice[aria-pressed="true"]').dataset.value).toBe('generic');
        expect(sheet.querySelector('.wg-notif__text').textContent).toBe('Medication time');
        // A second schedule while the sheet is up does not stack another.
        expect(window.NotifyPermission.maybeAsk()).toBe(first);

        sheet.querySelector('[data-notify-choice="allow"]').click();
        expect(requestPermission).toHaveBeenCalledTimes(1);
        await expect(first).resolves.toBe(true);
        expect(document.getElementById('notify-permission-sheet')).toBeNull();
        // Untouched is not a choice: account mode stores only a floored Generic
        // (kept by the shim only when no pref exists), never a real write.
        const puts = window.apiCall.mock.calls.filter((c) => c[1] === 'PUT');
        expect(puts).toEqual([['/api/settings/reminder-delivery', 'PUT', { floor: 'generic' }]]);

        // Answered: never again on this device, even if still 'default'.
        await expect(window.NotifyPermission.maybeAsk()).resolves.toBe(false);
        expect(document.getElementById('notify-permission-sheet')).toBeNull();
    });

    it('NotifyPermission.maybeAsk: no sheet when already granted; Not now leaves the note', async () => {
        const { document, window } = env;
        const permission = vi.fn(async () => 'granted');
        window.LocalNotifications = { isSupported: () => true, permission, requestPermission: vi.fn() };
        await expect(window.NotifyPermission.maybeAsk()).resolves.toBe(false);
        expect(document.getElementById('notify-permission-sheet')).toBeNull();

        permission.mockResolvedValue('default');
        const realApiCall = window.apiCall;
        window.apiCall = vi.fn(async (url, method, body) => (method === 'PUT' ? body : { verbosity: 'detailed' }));
        const asking = window.NotifyPermission.maybeAsk();
        await flush();
        await flush();
        document.querySelector('#notify-permission-sheet [data-notify-choice="not-now"]').click();
        await expect(asking).resolves.toBe(false);
        expect(window.LocalNotifications.requestPermission).not.toHaveBeenCalled();
        // Not now on an account already on Detailed: only the floored default,
        // which the shim drops because a pref is stored (cloud.shim-contract.reminders).
        expect(window.apiCall.mock.calls.filter((c) => c[1] === 'PUT'))
            .toEqual([['/api/settings/reminder-delivery', 'PUT', { floor: 'generic' }]]);
        window.apiCall = realApiCall;

        window.showAddModal();
        await flush();
        expect(document.querySelector('#med-notify-note [data-notify-denied]')).not.toBeNull();
    });

    // med-mt0l (kit RD1): local-only mode's ask sheet carries S8's Generic /
    // Detailed pair with a live preview; the pick is saved however it closes.
    describe('lock-screen choice (RD1/RD2)', () => {
        const DELIVERY = '/api/settings/reminder-delivery';
        const pressed = (root) => root.querySelector('[data-notify-verbosity] .wg-choice[aria-pressed="true"]').dataset.value;

        function localSetup(window) {
            window.document.documentElement.classList.add('wg-local-vault');
            window.medications = [{ id: 1, name: 'Candecor' }];
            window.apiCall = vi.fn(async (url, method, body) => (method === 'PUT' ? body : { verbosity: 'generic' }));
        }

        it('RD1: the choice replaces the lock fact, previews live, and Allow saves Detailed', async () => {
            const { document, window } = env;
            localSetup(window);
            window.LocalNotifications = { isSupported: () => true, permission: vi.fn(async () => 'default'), requestPermission: vi.fn(async () => 'granted') };

            const asking = window.NotifyPermission.maybeAsk();
            await flush();
            await flush();
            const sheet = document.getElementById('notify-permission-sheet');
            expect(sheet).not.toBeNull();
            expect(Array.from(sheet.querySelectorAll('.wg-facts b')).map((b) => b.textContent))
                .toEqual(['Only what you schedule', 'Change it any time']);
            expect(sheet.querySelector('.wg-label').textContent).toBe('On the lock screen, show');
            expect(pressed(sheet)).toBe('generic');
            const preview = sheet.querySelector('.wg-notif__text');
            expect(preview.textContent).toBe('Medication time');
            expect(sheet.querySelector('.wg-notif').getAttribute('aria-live')).toBe('polite');
            expect(sheet.querySelector('.wg-hint').textContent)
                .toBe('Anyone holding your phone can read the lock screen, even while it is locked.');

            sheet.querySelector('[data-notify-verbosity] .wg-choice[data-value="detailed"]').click();
            expect(pressed(sheet)).toBe('detailed');
            expect(preview.textContent).toBe('Time to take: Candecor');

            sheet.querySelector('[data-notify-choice="allow"]').click();
            await expect(asking).resolves.toBe(true);
            expect(window.apiCall).toHaveBeenCalledWith(DELIVERY, 'PUT', { verbosity: 'detailed' });
        });

        it('RD1: "Not now" still saves the pick; an untouched Generic writes nothing', async () => {
            const { document, window } = env;
            localSetup(window);
            const permission = vi.fn(async () => 'default');
            window.LocalNotifications = { isSupported: () => true, permission, requestPermission: vi.fn() };

            const asking = window.NotifyPermission.maybeAsk();
            await flush();
            await flush();
            const sheet = document.getElementById('notify-permission-sheet');
            sheet.querySelector('[data-notify-verbosity] .wg-choice[data-value="detailed"]').click();
            sheet.querySelector('[data-notify-choice="not-now"]').click();
            await expect(asking).resolves.toBe(false);
            expect(window.LocalNotifications.requestPermission).not.toHaveBeenCalled();
            expect(window.apiCall).toHaveBeenCalledWith(DELIVERY, 'PUT', { verbosity: 'detailed' });

            // A fresh device: Generic left as it was → no write.
            window.localStorage.removeItem('wg.notifyPermission.asked');
            window.apiCall.mockClear();
            const again = window.NotifyPermission.maybeAsk();
            await flush();
            await flush();
            document.querySelector('#notify-permission-sheet [data-notify-choice="not-now"]').click();
            await expect(again).resolves.toBe(false);
            expect(window.apiCall.mock.calls.filter((c) => c[1] === 'PUT')).toEqual([]);
        });

        it('RD2: the first-run one-tap grant follows with "What should reminders show?"; Done saves', async () => {
            const { document, window } = env;
            localSetup(window);
            const permission = vi.fn(async () => 'default');
            const requestPermission = vi.fn(async () => { permission.mockResolvedValue('granted'); return 'granted'; });
            window.LocalNotifications = { isSupported: () => true, permission, requestPermission, copy: { os: 'iOS' } };
            const slot = document.createElement('div');
            document.body.appendChild(slot);

            await window.NotifyPermission.renderNote(slot, { askNow: true });
            slot.querySelector('[data-notify-allow]').click();
            expect(requestPermission).toHaveBeenCalledTimes(1);
            await flush();
            await flush();
            await flush();
            const sheet = document.getElementById('notify-detail-sheet');
            expect(sheet).not.toBeNull();
            expect(sheet.querySelector('.wg-eyebrow').textContent).toBe('Notifications are on');
            expect(sheet.querySelector('.wg-sheethead__title').textContent).toBe('What should reminders show?');
            expect(pressed(sheet)).toBe('generic');
            sheet.querySelector('[data-notify-verbosity] .wg-choice[data-value="detailed"]').click();
            sheet.querySelector('[data-notify-choice="done"]').click();
            expect(document.getElementById('notify-detail-sheet')).toBeNull();
            expect(window.apiCall).toHaveBeenCalledWith(DELIVERY, 'PUT', { verbosity: 'detailed' });
        });

        // med-5vy0: an account whose pref could not be read shows Generic and,
        // closed untouched, sends only the floored default — never a real
        // Generic over a Detailed it never saw.
        it('RD1 in account mode with an unreadable pref: Not now sends only the floored default', async () => {
            const { document, window } = env;
            window.apiCall = vi.fn(async (url, method, body) => (method === 'PUT' ? body : null));
            window.LocalNotifications = { isSupported: () => true, permission: vi.fn(async () => 'default'), requestPermission: vi.fn() };
            const asking = window.NotifyPermission.maybeAsk();
            await flush();
            await flush();
            const sheet = document.getElementById('notify-permission-sheet');
            expect(pressed(sheet)).toBe('generic');
            sheet.querySelector('[data-notify-choice="not-now"]').click();
            await expect(asking).resolves.toBe(false);
            expect(window.apiCall.mock.calls.filter((c) => c[1] === 'PUT')).toEqual([[DELIVERY, 'PUT', { floor: 'generic' }]]);
        });

        // med-5vy0: account mode gets RD2 too; a changed pick is a real write.
        it('RD2 in account mode: the grant opens the same sheet; Done untouched floors, a pick writes', async () => {
            const { document, window } = env;
            window.apiCall = vi.fn(async (url, method, body) => (method === 'PUT' ? body : { verbosity: 'generic' }));
            const permission = vi.fn(async () => 'default');
            const requestPermission = vi.fn(async () => { permission.mockResolvedValue('granted'); return 'granted'; });
            window.LocalNotifications = { isSupported: () => true, permission, requestPermission, copy: { os: 'iOS' } };
            const slot = document.createElement('div');
            document.body.appendChild(slot);
            await window.NotifyPermission.renderNote(slot, { askNow: true });
            slot.querySelector('[data-notify-allow]').click();
            await flush();
            await flush();
            await flush();
            const sheet = document.getElementById('notify-detail-sheet');
            expect(sheet).not.toBeNull();
            expect(pressed(sheet)).toBe('generic');
            sheet.querySelector('[data-notify-choice="done"]').click();
            expect(document.getElementById('notify-detail-sheet')).toBeNull();
            expect(window.apiCall.mock.calls.filter((c) => c[1] === 'PUT')).toEqual([[DELIVERY, 'PUT', { floor: 'generic' }]]);

            // The ask sheet with a changed pick: a real write of that pick.
            window.apiCall.mockClear();
            window.localStorage.removeItem('wg.notifyPermission.asked');
            permission.mockResolvedValue('default');
            const asking = window.NotifyPermission.maybeAsk();
            await flush();
            await flush();
            const ask = document.getElementById('notify-permission-sheet');
            ask.querySelector('[data-notify-verbosity] .wg-choice[data-value="detailed"]').click();
            ask.querySelector('[data-notify-choice="not-now"]').click();
            await expect(asking).resolves.toBe(false);
            expect(window.apiCall.mock.calls.filter((c) => c[1] === 'PUT')).toEqual([[DELIVERY, 'PUT', { verbosity: 'detailed' }]]);
        });

        afterEach(() => {
            env?.window.document.documentElement.classList.remove('wg-local-vault');
        });
    });

    // med-1ikf: after "Not now" the note's button is the one tap to the system
    // prompt (iOS Settings has no Notifications toggle before the app asked).
    it('undecided after Not now: the note offers Allow notifications, which asks and clears it', async () => {
        const { document, window } = env;
        const permission = vi.fn(async () => 'default');
        const requestPermission = vi.fn(async () => { permission.mockResolvedValue('granted'); return 'granted'; });
        window.LocalNotifications = { isSupported: () => true, permission, requestPermission, copy: { os: 'iOS' } };
        window.localStorage.setItem('wg.notifyPermission.asked', '1');
        window.document.documentElement.classList.add('wg-local-vault');
        const rescheduled = vi.fn();
        document.addEventListener('wg:local-reminders-reschedule', rescheduled);

        window.showAddModal();
        await flush();
        const allow = document.querySelector('#med-notify-note [data-notify-allow]');
        expect(allow).not.toBeNull();
        expect(allow.textContent).toBe('Allow notifications');
        expect(document.querySelector('#med-notify-note [data-notify-open-settings]')).toBeNull();

        allow.click();
        expect(requestPermission).toHaveBeenCalledTimes(1);
        await flush();
        await flush();
        expect(document.getElementById('med-notify-note').children).toHaveLength(0);
        // The grant re-runs this device's schedule (the shell dropped the earlier one).
        expect(rescheduled).toHaveBeenCalledTimes(1);
        window.document.documentElement.classList.remove('wg-local-vault');
    });

    it('Track stock reveals the stepper; the stepper never steps below zero', () => {
        const { document, window } = env;
        window.showAddModal();
        const track = document.getElementById('med-track-inventory');
        const fields = document.getElementById('inventory-fields');
        const count = document.getElementById('med-inventory-count');
        expect(fields.classList.contains('hidden')).toBe(true);
        expect(fields.querySelector('.wg-stepper')).not.toBeNull();

        track.checked = true;
        track.dispatchEvent(new window.Event('change'));
        expect(fields.classList.contains('hidden')).toBe(false);
        // A new medication has no ledger yet: the stepper is its starting stock.
        expect(document.getElementById('med-stock-row').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('med-pack-size-btn').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('med-pack-size-value').textContent).toBe('Not set');

        document.getElementById('med-inventory-inc').click();
        document.getElementById('med-inventory-inc').click();
        expect(count.value).toBe('2');
        document.getElementById('med-inventory-dec').click();
        document.getElementById('med-inventory-dec').click();
        document.getElementById('med-inventory-dec').click();
        expect(count.value).toBe('0');

        track.checked = false;
        track.dispatchEvent(new window.Event('change'));
        expect(fields.classList.contains('hidden')).toBe(true);
    });

    it('date value rows open the hidden picker and show the picked date', () => {
        const { document, window } = env;
        window.showAddModal();
        const start = document.getElementById('med-start-date');
        start.showPicker = vi.fn();

        document.getElementById('med-start-date-btn').click();
        expect(start.showPicker).toHaveBeenCalledTimes(1);

        start.value = '2026-10-01';
        start.dispatchEvent(new window.Event('change'));
        expect(document.getElementById('med-start-date-value').textContent).toBe('2026-10-01');

        // No programmatic picker: the input is revealed as the fallback.
        const end = document.getElementById('med-end-date');
        end.showPicker = undefined;
        document.getElementById('med-end-date-btn').click();
        expect(end.classList.contains('wg-meds-editor__date-input--shown')).toBe(true);
    });

    it('time-zone value row opens a choice sheet and the pick reaches the saved payload', async () => {
        const { document, window } = env;
        window.safeChoose = vi.fn().mockResolvedValue('strict');
        window.showAddModal();

        document.getElementById('med-tz-policy-btn').click();
        await flush();
        expect(window.safeChoose).toHaveBeenCalledWith(
            expect.any(String),
            expect.arrayContaining([expect.objectContaining({ value: 'flexible', selected: true })]),
            expect.objectContaining({ title: 'Time-zone changes' })
        );
        expect(document.getElementById('med-tz-policy-value').textContent).toBe('Strict · 2h');

        document.getElementById('med-name').value = 'Aspirin';
        document.getElementById('schedule-type').value = 'as_needed';
        window.apiCallDirect = vi.fn().mockResolvedValue({});
        window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
        window.DataStore.invalidateKey = vi.fn().mockResolvedValue(undefined);
        window.loadMeds = vi.fn();
        await window.saveMedication();
        expect(window.apiCallDirect).toHaveBeenCalledWith('/api/medications', 'POST',
            expect.objectContaining({ tz_shift_policy: 'strict' }));
    });

    it('showEditModal fills every section from the medication', async () => {
        const { document, window } = env;
        await seedMedications(window, [{
            id: 1,
            name: 'Allopurinol',
            dosage: '100mg',
            schedule: JSON.stringify({ type: 'weekly', times: ['08:00', '20:00'], days: [1, 3] }),
            archived: false,
            supplement: true,
            normalized_name: 'allopurinol',
            start_date: '2026-09-01T00:00:00.000Z',
            end_date: null,
            inventory_count: 30,
            pack_size: 28,
            stock: { counted: 20, counted_at: '2026-09-12T10:00:00Z', seed: false, refills: [{ n: 28, at: '2026-09-21T10:00:00Z' }], taken: 18 },
            tz_shift_policy: 'medium',
        }]);
        window.apiCallDirect = vi.fn().mockResolvedValue({ rxcui: '1', normalized_name: 'allopurinol', warning: '' });

        window.showEditModal(1);
        await flush();

        expect(document.getElementById('med-modal-title').textContent).toBe('Allopurinol');
        expect(document.getElementById('med-modal-eyebrow').textContent).toBe('Edit medication');
        expect(document.querySelector('[data-schedule-type="weekly"]').getAttribute('aria-pressed')).toBe('true');
        expect(Array.from(document.querySelectorAll('.med-time-input')).map((i) => i.value)).toEqual(['08:00', '20:00']);
        expect(document.getElementById('med-rx-name').textContent).toBe('Rx · allopurinol');
        expect(document.getElementById('med-rx-display').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('med-start-date-value').textContent).toBe('2026-09-01');
        expect(document.getElementById('med-end-date-value').textContent).toBe('Ongoing');
        expect(document.getElementById('med-supplement').checked).toBe(true);
        // A tracked med's stock is read-only, derived from its ledger (ST5).
        expect(document.getElementById('inventory-fields').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('med-stock-row').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('med-stock-value').textContent).toBe('30');
        expect(document.getElementById('med-stock-desc').textContent).toMatch(/^Counted 20 on \S+ \S+ · \+28 since · \u221218 taken$/);
        expect(document.getElementById('med-pack-size-value').textContent).toBe('28');
        expect(document.getElementById('med-tz-policy-value').textContent).toBe('Medium · 3h');
        // Active meds cannot be deleted from the editor.
        expect(document.getElementById('med-delete-block').classList.contains('hidden')).toBe(true);
    });

    it('pack size is picked in a prompt and saved; the stock row\'s Update opens the stock sheet (ST5)', async () => {
        const { document, window } = env;
        await seedMedications(window, [{
            id: 1, name: 'Metformin', dosage: '1000mg', schedule: JSON.stringify({ type: 'as_needed' }),
            archived: false, inventory_count: 47, tz_shift_policy: 'flexible',
        }]);
        window.apiCallDirect = vi.fn().mockResolvedValue({ rxcui: '', normalized_name: '', warning: '' });
        window.showEditModal(1);
        await flush();

        window.safePrompt = vi.fn().mockResolvedValue('28');
        document.getElementById('med-pack-size-btn').click();
        await flush();
        expect(window.safePrompt).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ title: 'Pack size' }));
        expect(document.getElementById('med-pack-size-value').textContent).toBe('28');

        document.getElementById('med-stock-update').click();
        const sheet = document.getElementById('stock-sheet');
        expect(sheet).not.toBeNull();
        expect(sheet.querySelector('.wg-pick[data-pack]').textContent).toBe('+1 pack (28)');
        sheet.querySelector('.wg-sheethead .wg-btn').click();
        expect(document.getElementById('stock-sheet')).toBeNull();

        window.DataStore.applyOptimistic = vi.fn().mockResolvedValue({ commit: vi.fn(), rollback: vi.fn() });
        window.loadMeds = vi.fn();
        await window.saveMedication();
        expect(window.apiCallDirect).toHaveBeenCalledWith('/api/medications/1', 'POST',
            expect.objectContaining({ pack_size: 28, inventory_count: 47 }));
    });

    it('shows the interaction warning inline once the Rx match resolves, and Save does not alert it again', async () => {
        const { document, window } = env;
        const warning = 'Interaction between candesartan and ibuprofen: reduced effect';
        window.safeAlert = vi.fn();
        window.apiCallDirect = vi.fn(async (url) => {
            if (url.startsWith('/api/medications/rx-check')) {
                return { rxcui: '1', normalized_name: 'candesartan', warning };
            }
            return { id: 9, status: 'created', warning };
        });
        window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
        window.DataStore.invalidateKey = vi.fn().mockResolvedValue(undefined);
        window.loadMeds = vi.fn();
        window.showAddModal();

        const name = document.getElementById('med-name');
        name.value = 'Candesartan';
        name.dispatchEvent(new window.Event('change'));
        await flush();

        expect(window.apiCallDirect).toHaveBeenCalledWith(
            expect.stringContaining('/api/medications/rx-check?name=Candesartan'), 'GET');
        expect(document.getElementById('med-rx-name').textContent).toBe('Rx · candesartan');
        expect(document.getElementById('med-rx-warning').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('med-rx-warning-text').textContent).toBe(warning);

        document.getElementById('schedule-type').value = 'as_needed';
        await window.saveMedication();
        expect(window.safeAlert).not.toHaveBeenCalled();

        // A stale inline result (renamed, saved before the new check) never
        // swallows the warning Save returns for the medication saved.
        window.showAddModal();
        window.setMedRxMatch('candesartan', warning);
        document.getElementById('med-name').value = 'Warfarin';
        document.getElementById('schedule-type').value = 'as_needed';
        window.apiCallDirect = vi.fn().mockResolvedValue({ id: 10, status: 'created', warning: 'Interaction between warfarin and ibuprofen: bleeding' });
        await window.saveMedication();
        expect(window.safeAlert).toHaveBeenCalledWith('Interaction between warfarin and ibuprofen: bleeding');
    });

    it('ignores an old lookup when another editor opens with the same name', async () => {
        const { document, window } = env;
        let resolveOld;
        const oldLookup = new Promise((resolve) => { resolveOld = resolve; });
        window.apiCallDirect = vi.fn()
            .mockReturnValueOnce(oldLookup)
            .mockResolvedValue({ rxcui: '', normalized_name: '', warning: '' });
        window.showAddModal();
        document.getElementById('med-name').value = 'Candecor';
        const oldCheck = window.checkMedRx();
        window.showAddModal();
        document.getElementById('med-name').value = 'Candecor';
        await window.checkMedRx();
        resolveOld({ rxcui: '999', normalized_name: 'Caldecort', warning: 'old warning' });
        await oldCheck;
        expect(document.getElementById('med-rx-name').textContent).toBe('');
        expect(document.getElementById('med-rx-warning').classList.contains('hidden')).toBe(true);
    });

    it('does not paint a lookup that resolves after the medication editor closes', async () => {
        const { document, window } = env;
        let resolveLookup;
        window.apiCallDirect = vi.fn().mockReturnValue(new Promise((resolve) => { resolveLookup = resolve; }));
        window.showAddModal();
        document.getElementById('med-name').value = 'Candecor';
        const check = window.checkMedRx();
        window.closeModal();
        resolveLookup({ rxcui: '999', normalized_name: 'Caldecort', warning: 'old warning' });
        await check;
        expect(document.getElementById('med-rx-name').textContent).toBe('');
        expect(document.getElementById('med-rx-warning').classList.contains('hidden')).toBe(true);
    });

    it('Delete is offered only for an archived, never-taken med and goes through deleteMed', async () => {
        const { document, window } = env;
        await seedMedications(window, [
            { id: 1, name: 'Old', dosage: '1mg', schedule: '{"type":"as_needed"}', archived: true, last_taken_at: null },
            { id: 2, name: 'Used', dosage: '1mg', schedule: '{"type":"as_needed"}', archived: true, last_taken_at: '2026-09-01T08:00:00Z' },
        ]);
        window.apiCallDirect = vi.fn().mockResolvedValue({});
        const block = document.getElementById('med-delete-block');

        window.showEditModal(2);
        expect(block.classList.contains('hidden')).toBe(true);

        window.showEditModal(1);
        expect(block.classList.contains('hidden')).toBe(false);

        window.deleteMed = vi.fn().mockResolvedValue(true);
        document.getElementById('med-delete-btn').click();
        await flush();
        expect(window.deleteMed).toHaveBeenCalledWith(1);
        expect(document.getElementById('med-modal').classList.contains('hidden')).toBe(true);
    });

    it('permanent delete asks through a destructive dialog', async () => {
        const { window } = env;
        await seedMedications(window, [
            { id: 1, name: 'Old', dosage: '1mg', schedule: '{"type":"as_needed"}', archived: true },
        ]);
        window.safeConfirm = vi.fn().mockResolvedValue(false);
        await window.deleteMed(1);
        expect(window.safeConfirm).toHaveBeenCalledWith(expect.any(String), expect.any(Function),
            expect.objectContaining({ destructive: true }));
    });

    it('Cancel and Back both close the page', () => {
        const { document, window } = env;
        window.showAddModal();
        document.getElementById('med-modal-cancel-btn').click();
        expect(document.getElementById('med-modal').classList.contains('hidden')).toBe(true);

        window.showAddModal();
        expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(false);
        window.ModalManager.closeTopMostVisibleModal();
        expect(document.getElementById('med-modal').classList.contains('hidden')).toBe(true);
    });

    it('Save posts the unchanged payload shape with the serialized schedule', async () => {
        const { document, window } = env;
        window.safeAlert = vi.fn();
        window.showAddModal();

        document.getElementById('med-name').value = 'Allopurinol';
        document.getElementById('med-dosage').value = '100mg';
        document.querySelector('[data-schedule-type="weekly"]').click();
        document.querySelector('.med-time-input').value = '08:00';
        const picks = document.querySelectorAll('#days-container .wg-picks > .wg-pick');
        expect(Array.from(picks).map((p) => p.dataset.day)).toEqual(['1', '2', '3', '4', '5', '6', '0']);
        picks[0].click();

        window.apiCallDirect = vi.fn().mockResolvedValue({});
        window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
        window.DataStore.invalidateKey = vi.fn().mockResolvedValue(undefined);
        window.loadMeds = vi.fn();

        await window.saveMedication();

        expect(window.apiCallDirect).toHaveBeenCalledWith('/api/medications', 'POST', {
            name: 'Allopurinol',
            dosage: '100mg',
            schedule: JSON.stringify({ type: 'weekly', times: ['08:00'], days: [1] }),
            archived: false,
            supplement: false,
            start_date: null,
            end_date: null,
            inventory_count: null,
            // The optional pack size (bd med-wi09.13, ST5).
            pack_size: null,
            tz_shift_policy: 'flexible',
        });
    });
});
