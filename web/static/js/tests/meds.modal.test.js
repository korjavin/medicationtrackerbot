// Wandergeek EditMedicationModal (Phase 5, Task 7).
//
// Asserts the rewritten edit-med modal uses the Wandergeek shell — `.wg-modal`
// + `.wg-meds-modal`, dual-line eyebrow / mono title, top-right `.wg-icon-btn`
// close, gloss-inset input wraps, schedule-type pill strip, inventory toggle
// that reveals the stock field, bottom Cancel + Save action bar — while
// preserving every existing wiring (saveMedication, pill <-> #schedule-type
// sync, inventory toggle, modal-controller history integration).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

async function seedMedications(window, meds) {
    window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(meds);
    });
    window.apiCall = vi.fn().mockResolvedValue([]);
    await window.loadMeds();
}

describe('EditMedicationModal (Phase 5, Task 7)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('shell uses the shared .wg-modal primitive plus the .wg-meds-modal class', () => {
        const { document } = env;
        const modal = document.getElementById('med-modal');
        expect(modal).not.toBeNull();
        expect(modal.classList.contains('wg-modal')).toBe(true);
        expect(modal.classList.contains('wg-meds-modal')).toBe(true);
    });

    it('header renders eyebrow + mono title + .wg-icon-btn close affordance', () => {
        const { document } = env;
        const header = document.querySelector('#med-modal .wg-meds-modal__header');
        expect(header).not.toBeNull();

        const eyebrow = document.getElementById('med-modal-eyebrow');
        expect(eyebrow).not.toBeNull();
        expect(eyebrow.classList.contains('wg-section-label')).toBe(true);
        expect(eyebrow.classList.contains('wg-meds-modal__eyebrow')).toBe(true);

        const title = document.getElementById('med-modal-title');
        expect(title).not.toBeNull();
        expect(title.classList.contains('wg-mono-display')).toBe(true);

        const close = document.getElementById('med-modal-close-btn');
        expect(close).not.toBeNull();
        expect(close.classList.contains('wg-icon-btn')).toBe(true);
        expect(close.querySelector('.wg-gloss')).not.toBeNull();
    });

    it('Name + Dosage row uses gloss-inset input wraps', () => {
        const { document } = env;
        const row = document.querySelector('#med-modal .wg-meds-modal__row--identity');
        expect(row).not.toBeNull();

        const nameWrap = document.getElementById('med-name').parentElement;
        expect(nameWrap.classList.contains('wg-gloss--inset')).toBe(true);
        expect(nameWrap.classList.contains('wg-meds-modal__input-wrap')).toBe(true);

        const dosageWrap = document.getElementById('med-dosage').parentElement;
        expect(dosageWrap.classList.contains('wg-gloss--inset')).toBe(true);
        expect(dosageWrap.classList.contains('wg-meds-modal__input-wrap')).toBe(true);
    });

    it('schedule-type pill strip renders three pills bound to data-schedule-type', () => {
        const { document } = env;
        const pills = document.querySelectorAll('.wg-meds-modal__pill');
        expect(pills).toHaveLength(3);

        const types = Array.from(pills).map((p) => p.dataset.scheduleType);
        expect(types).toEqual(['daily', 'weekly', 'as_needed']);

        pills.forEach((pill) => {
            expect(pill.classList.contains('wg-gloss')).toBe(true);
        });

        const wrap = document.querySelector('#med-modal .wg-meds-modal__pills');
        expect(wrap).not.toBeNull();
        expect(wrap.classList.contains('wg-gloss--inset')).toBe(true);
    });

    it('clicking a schedule-type pill swaps detail panels via toggleScheduleFields', () => {
        const { document, window } = env;
        window.showAddModal();

        const dailyPill = document.querySelector('.wg-meds-modal__pill[data-schedule-type="daily"]');
        const weeklyPill = document.querySelector('.wg-meds-modal__pill[data-schedule-type="weekly"]');
        const asNeededPill = document.querySelector('.wg-meds-modal__pill[data-schedule-type="as_needed"]');

        // Default: daily → times visible, days hidden.
        expect(dailyPill.getAttribute('aria-pressed')).toBe('true');
        expect(dailyPill.classList.contains('wg-gloss--sun')).toBe(true);
        expect(document.getElementById('times-container').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('days-container').classList.contains('hidden')).toBe(true);

        weeklyPill.click();
        expect(document.getElementById('schedule-type').value).toBe('weekly');
        expect(weeklyPill.getAttribute('aria-pressed')).toBe('true');
        expect(weeklyPill.classList.contains('wg-gloss--sun')).toBe(true);
        expect(dailyPill.getAttribute('aria-pressed')).toBe('false');
        expect(document.getElementById('days-container').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('times-container').classList.contains('hidden')).toBe(false);

        asNeededPill.click();
        expect(document.getElementById('schedule-type').value).toBe('as_needed');
        expect(asNeededPill.classList.contains('wg-gloss--sun')).toBe(true);
        expect(document.getElementById('times-container').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('days-container').classList.contains('hidden')).toBe(true);
    });

    it('time-row initial input is wrapped in a gloss-inset input wrap', () => {
        const { document } = env;
        const timeInput = document.querySelector('#time-inputs .med-time-input');
        expect(timeInput).not.toBeNull();
        const wrap = timeInput.parentElement;
        expect(wrap.classList.contains('wg-gloss--inset')).toBe(true);
        expect(wrap.classList.contains('wg-meds-modal__input-wrap')).toBe(true);

        const row = wrap.closest('.time-row');
        expect(row).not.toBeNull();
        expect(row.classList.contains('wg-meds-modal__time-row')).toBe(true);

        const removeBtn = row.querySelector('.remove-time');
        expect(removeBtn).not.toBeNull();
        expect(removeBtn.classList.contains('wg-icon-btn')).toBe(true);
    });

    it('addTimeInput emits the wrapped gloss-inset structure + removeTime undoes it', () => {
        const { document, window } = env;
        const container = document.getElementById('time-inputs');
        const initial = container.querySelectorAll('.time-row').length;

        window.addTimeInput('08:45');
        expect(container.querySelectorAll('.time-row').length).toBe(initial + 1);

        const newRow = container.querySelector('.time-row:last-child');
        const wrap = newRow.querySelector('.wg-gloss--inset.wg-meds-modal__input-wrap');
        expect(wrap).not.toBeNull();
        const input = wrap.querySelector('.med-time-input');
        expect(input.value).toBe('08:45');
        expect(input.classList.contains('wg-meds-modal__input')).toBe(true);

        const remove = newRow.querySelector('.remove-time');
        expect(remove.classList.contains('wg-icon-btn')).toBe(true);
        window.removeTime(remove);
        expect(container.querySelectorAll('.time-row').length).toBe(initial);
    });

    it('inventory toggle reveals the count field and hides it again', () => {
        const { document, window } = env;
        window.showAddModal();

        const toggle = document.getElementById('med-track-inventory');
        const fields = document.getElementById('inventory-fields');
        expect(fields.classList.contains('hidden')).toBe(true);

        toggle.checked = true;
        toggle.dispatchEvent(new window.Event('change'));
        expect(fields.classList.contains('hidden')).toBe(false);

        // Stock input is inside a gloss-inset wrap
        const countInput = document.getElementById('med-inventory-count');
        expect(countInput.parentElement.classList.contains('wg-gloss--inset')).toBe(true);

        toggle.checked = false;
        toggle.dispatchEvent(new window.Event('change'));
        expect(fields.classList.contains('hidden')).toBe(true);
    });

    it('start + end date inputs are wrapped in gloss-inset wraps', () => {
        const { document } = env;
        const startWrap = document.getElementById('med-start-date').parentElement;
        const endWrap = document.getElementById('med-end-date').parentElement;
        expect(startWrap.classList.contains('wg-gloss--inset')).toBe(true);
        expect(endWrap.classList.contains('wg-gloss--inset')).toBe(true);
    });

    it('archived + supplement toggles are rendered in a side-by-side .wg-meds-modal__toggle-row', () => {
        const { document } = env;
        const row = document.querySelector('#med-modal .wg-meds-modal__toggle-row');
        expect(row).not.toBeNull();

        const archived = document.getElementById('med-archived');
        const supplement = document.getElementById('med-supplement');
        expect(archived).not.toBeNull();
        expect(supplement).not.toBeNull();
        expect(archived.closest('.wg-meds-modal__toggle')).not.toBeNull();
        expect(supplement.closest('.wg-meds-modal__toggle')).not.toBeNull();
    });

    it('tz-policy select is wrapped in a gloss-inset wrap', () => {
        const { document } = env;
        const tz = document.getElementById('med-tz-policy');
        expect(tz.parentElement.classList.contains('wg-gloss--inset')).toBe(true);
    });

    it('header action bar: Cancel (.wg-gloss) left, Save (.wg-gloss--sun) right', () => {
        const { document } = env;
        const actions = document.querySelector('#med-modal .wg-meds-modal__header-actions');
        expect(actions).not.toBeNull();

        const cancelBtn = document.getElementById('med-modal-cancel-btn');
        const saveBtn = document.getElementById('med-modal-save-btn');
        expect(cancelBtn.parentElement).toBe(actions);
        expect(saveBtn.parentElement).toBe(actions);

        expect(cancelBtn.classList.contains('wg-gloss')).toBe(true);
        expect(cancelBtn.classList.contains('wg-gloss--sun')).toBe(false);
        expect(saveBtn.classList.contains('wg-gloss')).toBe(true);
        expect(saveBtn.classList.contains('wg-gloss--sun')).toBe(true);

        // Cancel left of Save inside the header row
        const children = Array.from(actions.children);
        expect(children.indexOf(cancelBtn)).toBeGreaterThan(-1);
        expect(children.indexOf(saveBtn)).toBeGreaterThan(children.indexOf(cancelBtn));
    });

    it('showAddModal opens the modal, sets header to "New medication", resets inputs', () => {
        const { document, window } = env;
        window.showAddModal();

        expect(document.getElementById('med-modal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('med-modal-title').textContent).toBe('New medication');
        expect(document.getElementById('med-modal-eyebrow').textContent).toBe('Medication');
        expect(document.getElementById('med-name').value).toBe('');
        expect(document.getElementById('schedule-type').value).toBe('daily');

        // Default pill active state
        const dailyPill = document.querySelector('.wg-meds-modal__pill[data-schedule-type="daily"]');
        expect(dailyPill.classList.contains('wg-gloss--sun')).toBe(true);
    });

    it('showEditModal sets title to the medication name and syncs pill state', async () => {
        const { document, window } = env;
        await seedMedications(window, [
            {
                id: 1,
                name: 'Allopurinol',
                dosage: '100mg',
                schedule: JSON.stringify({ type: 'weekly', times: ['08:00'], days: [1, 3] }),
                archived: false
            }
        ]);

        window.loadRestockHistory = vi.fn().mockResolvedValue(undefined);
        window.showEditModal(1);

        expect(document.getElementById('med-modal-title').textContent).toBe('Allopurinol');
        expect(document.getElementById('med-modal-eyebrow').textContent).toBe('Edit medication');
        expect(document.getElementById('schedule-type').value).toBe('weekly');

        const weeklyPill = document.querySelector('.wg-meds-modal__pill[data-schedule-type="weekly"]');
        expect(weeklyPill.classList.contains('wg-gloss--sun')).toBe(true);
        expect(weeklyPill.getAttribute('aria-pressed')).toBe('true');
    });

    it('cancel button routes through closeModal (hides modal)', () => {
        const { document, window } = env;
        window.showAddModal();
        expect(document.getElementById('med-modal').classList.contains('hidden')).toBe(false);

        document.getElementById('med-modal-cancel-btn').click();
        expect(document.getElementById('med-modal').classList.contains('hidden')).toBe(true);
    });

    it('close icon (top-right) also routes through closeModal', () => {
        const { document, window } = env;
        window.showAddModal();
        expect(document.getElementById('med-modal').classList.contains('hidden')).toBe(false);

        document.getElementById('med-modal-close-btn').click();
        expect(document.getElementById('med-modal').classList.contains('hidden')).toBe(true);
    });

    it('saveMedication path: save button invokes apiCallDirect with serialized schedule', async () => {
        const { document, window } = env;
        window.safeAlert = vi.fn();
        window.showAddModal();

        document.getElementById('med-name').value = 'Allopurinol';
        document.getElementById('med-dosage').value = '100mg';

        // Switch to weekly via the pill — exercises the click-to-save path.
        document.querySelector('.wg-meds-modal__pill[data-schedule-type="weekly"]').click();
        document.querySelector('.med-time-input').value = '08:00';
        document.querySelector('.days-select span[data-day="1"]').classList.add('selected');

        window.apiCallDirect = vi.fn().mockResolvedValue({});
        window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
        window.DataStore.invalidateKey = vi.fn().mockResolvedValue(undefined);
        window.loadMeds = vi.fn();

        await window.saveMedication();

        expect(window.apiCallDirect).toHaveBeenCalledWith(
            '/api/medications',
            'POST',
            expect.objectContaining({
                name: 'Allopurinol',
                dosage: '100mg',
                schedule: JSON.stringify({ type: 'weekly', times: ['08:00'], days: [1] })
            })
        );
    });

    it('Telegram BackButton handler pops the med modal (modal-controller history wiring)', () => {
        const { document, window } = env;
        window.showAddModal();
        expect(document.getElementById('med-modal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('modal-overlay').classList.contains('hidden')).toBe(false);

        window.ModalManager.closeTopMostVisibleModal();
        expect(document.getElementById('med-modal').classList.contains('hidden')).toBe(true);
    });
});
