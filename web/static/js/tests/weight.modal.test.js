// Wandergeek Weight edit-modal tests (Phase 6, Task 6).
//
// Covers the rewritten `#weight-modal` shell:
//   • markup uses `.wg-modal` + `.wg-weight-modal__*` wrappers with a dual-line
//     mono header, gloss-inset input wraps, a kg/lb unit-toggle pill pair, and
//     a Cancel / Save action bar where Save carries 2× flex.
//   • opening via showWeightModal() sets the title to "New weight", datetime
//     defaults to now, unit toggle starts on kg.
//   • editWeightLog() prefills fields and swaps the title to "Edit weight".
//   • unit-toggle round-trip (kg → lb → kg) preserves the kg value within
//     rounding tolerance.
//   • handleWeightSubmit() posts kg regardless of the active display unit,
//     invalidates the weight tag, reloads logs, and closes the modal.
//   • modal-controller.js history plumbing is preserved — the cancel button
//     still closes the modal.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_PATH = path.resolve(__dirname, '../../../../web/static/index.html');
const CSS_PATH = path.resolve(__dirname, '../../../../web/static/css/styles.css');

const KG_PER_LB = 0.45359237;

describe('Edit-weight modal (Phase 6, Task 6)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    describe('markup (index.html)', () => {
        it('weight-modal uses the generic .wg-modal + .wg-weight-modal shell', () => {
            const html = fs.readFileSync(INDEX_PATH, 'utf8');
            const m = html.match(/<mt-modal[^>]*id="weight-modal"[^>]*>/);
            expect(m, 'expected #weight-modal declaration').not.toBeNull();
            expect(m[0]).toMatch(/wg-modal/);
            expect(m[0]).toMatch(/wg-weight-modal/);
        });

        it('renders the mono header, close icon-btn, unit-toggle pill pair, and action bar', () => {
            const { document } = env;
            const modal = document.getElementById('weight-modal');
            expect(modal).not.toBeNull();

            expect(modal.querySelector('.wg-weight-modal__header')).not.toBeNull();
            expect(modal.querySelector('.wg-weight-modal__title#weight-modal-title')).not.toBeNull();
            const closeBtn = modal.querySelector('#weight-modal-close-btn');
            expect(closeBtn).not.toBeNull();
            expect(closeBtn.classList.contains('wg-icon-btn')).toBe(true);

            const unitBtns = modal.querySelectorAll('.wg-weight-modal__unit-btn');
            expect(unitBtns.length).toBe(2);
            const units = Array.from(unitBtns).map((b) => b.getAttribute('data-unit'));
            expect(units).toEqual(['kg', 'lb']);

            const cancelBtn = modal.querySelector('#weight-modal-cancel-btn');
            const saveBtn = modal.querySelector('#weight-modal-save-btn');
            expect(cancelBtn).not.toBeNull();
            expect(saveBtn).not.toBeNull();
            expect(cancelBtn.classList.contains('wg-weight-modal__action--cancel')).toBe(true);
            expect(saveBtn.classList.contains('wg-weight-modal__action--save')).toBe(true);
            expect(saveBtn.getAttribute('type')).toBe('submit');
            expect(saveBtn.getAttribute('form')).toBe('weight-form');
        });

        it('styles.css gives Save 2× flex vs. Cancel in the action bar', () => {
            const css = fs.readFileSync(CSS_PATH, 'utf8');
            expect(css).toMatch(/\.wg-weight-modal__action--cancel\s*\{\s*flex:\s*1\s+1\s+0/);
            expect(css).toMatch(/\.wg-weight-modal__action--save\s*\{\s*flex:\s*2\s+1\s+0/);
        });

        it('index.html does NOT declare the paper-era ruler / weight-display markup', () => {
            const html = fs.readFileSync(INDEX_PATH, 'utf8');
            expect(html).not.toMatch(/id="weight-ruler"/);
            expect(html).not.toMatch(/id="weight-ruler-container"/);
            expect(html).not.toMatch(/class="weight-display/);
        });
    });

    describe('showWeightModal()', () => {
        it('opens the modal, sets the New-entry eyebrow, keeps the Weight title, and seeds datetime + default value', () => {
            const { window, document } = env;
            window.showWeightModal();

            expect(document.getElementById('weight-modal').classList.contains('hidden')).toBe(false);
            expect(document.getElementById('weight-modal-eyebrow').textContent).toBe('New entry');
            expect(document.getElementById('weight-modal-title').textContent).toBe('Weight');
            expect(document.getElementById('weight-datetime').value).not.toBe('');
            expect(document.getElementById('weight-notes').value).toBe('');
            const valueInput = document.getElementById('weight-value');
            expect(parseFloat(valueInput.value)).toBeGreaterThanOrEqual(30);
            expect(parseFloat(valueInput.value)).toBeLessThanOrEqual(300);
        });

        it('resets the unit toggle to kg on each open', () => {
            const { window, document } = env;
            window.showWeightModal();
            // Flip to lb, close, reopen and expect kg is active again.
            const lbBtn = document.querySelector('.wg-weight-modal__unit-btn[data-unit="lb"]');
            lbBtn.click();
            expect(lbBtn.getAttribute('aria-pressed')).toBe('true');

            window.closeWeightModal();
            window.showWeightModal();

            const kgBtn = document.querySelector('.wg-weight-modal__unit-btn[data-unit="kg"]');
            expect(kgBtn.getAttribute('aria-pressed')).toBe('true');
            expect(lbBtn.getAttribute('aria-pressed')).toBe('false');
        });

        it('restores the kg input min/max on reopen after a prior lb toggle', () => {
            const { window, document } = env;
            window.showWeightModal();
            const lbBtn = document.querySelector('.wg-weight-modal__unit-btn[data-unit="lb"]');
            lbBtn.click();
            const input = document.getElementById('weight-value');
            expect(input.min).toBe('66');
            expect(input.max).toBe('660');

            window.closeWeightModal();
            window.showWeightModal();

            expect(input.min).toBe('30');
            expect(input.max).toBe('300');
        });
    });

    describe('editWeightLog()', () => {
        it('prefills weight, datetime, notes and swaps the eyebrow to Edit entry while the title stays Weight', () => {
            const { window, document } = env;
            const measuredAt = new Date('2026-03-12T09:30:00Z').toISOString();
            window.editWeightLog({
                id: 42, weight: 78.4, measured_at: measuredAt, notes: 'post-run'
            });

            expect(document.getElementById('weight-modal').classList.contains('hidden')).toBe(false);
            expect(document.getElementById('weight-modal-eyebrow').textContent).toBe('Edit entry');
            expect(document.getElementById('weight-modal-title').textContent).toBe('Weight');
            expect(parseFloat(document.getElementById('weight-value').value)).toBeCloseTo(78.4, 2);
            expect(document.getElementById('weight-notes').value).toBe('post-run');
            expect(document.getElementById('weight-datetime').value).not.toBe('');
        });
    });

    describe('unit toggle', () => {
        it('round-trips kg → lb → kg without drift', () => {
            const { window, document } = env;
            window.showWeightModal();

            const input = document.getElementById('weight-value');
            input.value = '80.0';

            const lbBtn = document.querySelector('.wg-weight-modal__unit-btn[data-unit="lb"]');
            const kgBtn = document.querySelector('.wg-weight-modal__unit-btn[data-unit="kg"]');

            lbBtn.click();
            expect(lbBtn.getAttribute('aria-pressed')).toBe('true');
            expect(kgBtn.getAttribute('aria-pressed')).toBe('false');
            const lbVal = parseFloat(input.value);
            expect(lbVal).toBeCloseTo(80.0 / KG_PER_LB, 1);

            kgBtn.click();
            expect(kgBtn.getAttribute('aria-pressed')).toBe('true');
            const kgVal = parseFloat(input.value);
            expect(kgVal).toBeCloseTo(80.0, 1);
        });

        it('marks the active unit button with sun + active modifiers', () => {
            const { window, document } = env;
            window.showWeightModal();
            const kgBtn = document.querySelector('.wg-weight-modal__unit-btn[data-unit="kg"]');
            const lbBtn = document.querySelector('.wg-weight-modal__unit-btn[data-unit="lb"]');

            expect(kgBtn.classList.contains('wg-weight-modal__unit-btn--active')).toBe(true);
            expect(kgBtn.classList.contains('wg-gloss--sun')).toBe(true);
            expect(lbBtn.classList.contains('wg-weight-modal__unit-btn--active')).toBe(false);

            lbBtn.click();
            expect(lbBtn.classList.contains('wg-weight-modal__unit-btn--active')).toBe(true);
            expect(lbBtn.classList.contains('wg-gloss--sun')).toBe(true);
            expect(kgBtn.classList.contains('wg-weight-modal__unit-btn--active')).toBe(false);
            expect(kgBtn.classList.contains('wg-gloss--sun')).toBe(false);
        });
    });

    describe('handleWeightSubmit()', () => {
        it('POSTs kg when the unit is kg and closes the modal on success', async () => {
            const { window, document } = env;
            const apiCallSpy = vi.fn().mockResolvedValue({ id: 1 });
            const invalidateSpy = vi.fn().mockResolvedValue(undefined);
            const loadWeightSpy = vi.fn();

            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = invalidateSpy;
            window.loadWeightLogs = loadWeightSpy;

            window.showWeightModal();
            document.getElementById('weight-datetime').value = '2026-04-22T08:15';
            document.getElementById('weight-value').value = '75.3';
            document.getElementById('weight-notes').value = 'morning';

            await window.handleWeightSubmit({ preventDefault() {} });

            expect(apiCallSpy).toHaveBeenCalledTimes(1);
            const [url, method, payload] = apiCallSpy.mock.calls[0];
            expect(url).toBe('/api/weight');
            expect(method).toBe('POST');
            expect(payload.weight).toBeCloseTo(75.3, 2);
            expect(payload.notes).toBe('morning');
            expect(invalidateSpy).toHaveBeenCalledWith(['weight']);
            expect(loadWeightSpy).toHaveBeenCalledTimes(1);
            expect(document.getElementById('weight-modal').classList.contains('hidden')).toBe(true);
        });

        it('converts lb input back to kg before POSTing', async () => {
            const { window, document } = env;
            const apiCallSpy = vi.fn().mockResolvedValue({ id: 1 });
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
            window.loadWeightLogs = vi.fn();

            window.showWeightModal();
            document.getElementById('weight-datetime').value = '2026-04-22T08:15';
            document.getElementById('weight-value').value = '80.0';

            // Flip to lb; input shows lb value now.
            const lbBtn = document.querySelector('.wg-weight-modal__unit-btn[data-unit="lb"]');
            lbBtn.click();
            const displayLb = parseFloat(document.getElementById('weight-value').value);
            expect(displayLb).toBeCloseTo(80.0 / KG_PER_LB, 1);

            await window.handleWeightSubmit({ preventDefault() {} });

            const [, , payload] = apiCallSpy.mock.calls[0];
            expect(payload.weight).toBeCloseTo(80.0, 1);
        });

        it('does not POST when required fields are missing', async () => {
            const { window, document } = env;
            const apiCallSpy = vi.fn();
            window.apiCall = apiCallSpy;
            window.Telegram.WebApp.showAlert = vi.fn();
            window.alert = vi.fn();

            window.showWeightModal();
            document.getElementById('weight-datetime').value = '';
            document.getElementById('weight-value').value = '';

            await window.handleWeightSubmit({ preventDefault() {} });
            expect(apiCallSpy).not.toHaveBeenCalled();
        });

        it('editing a server-backed log POSTs the replacement before DELETEing the original', async () => {
            const { window, document } = env;
            const apiCallSpy = vi.fn().mockResolvedValue({ id: 2 });
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
            window.loadWeightLogs = vi.fn();

            window.editWeightLog({ id: 17, measured_at: '2026-04-20T08:00:00Z', weight: 81.2, notes: '' });
            document.getElementById('weight-datetime').value = '2026-04-22T08:15';
            document.getElementById('weight-value').value = '80.1';

            await window.handleWeightSubmit({ preventDefault() {} });

            expect(apiCallSpy).toHaveBeenCalledTimes(2);
            const [postUrl, postMethod, postPayload] = apiCallSpy.mock.calls[0];
            // The edit path tags the POST with ?replaces=<id> so the server
            // excludes the about-to-be-deleted row from the EMA baseline.
            expect(postUrl).toBe('/api/weight?replaces=17');
            expect(postMethod).toBe('POST');
            expect(postPayload.weight).toBeCloseTo(80.1, 2);
            const [delUrl, delMethod] = apiCallSpy.mock.calls[1];
            expect(delUrl).toBe('/api/weight/17');
            expect(delMethod).toBe('DELETE');
        });

        it('skips the DELETE when POST fails so the original row is not lost', async () => {
            const { window, document } = env;
            // First call (POST) returns null (write failure contract in
            // core/api.js). DELETE must NOT be issued — otherwise a failed
            // edit would remove the original without a replacement.
            const apiCallSpy = vi.fn().mockResolvedValueOnce(null);
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
            const loadWeightSpy = vi.fn();
            window.loadWeightLogs = loadWeightSpy;

            window.editWeightLog({ id: 99, measured_at: '2026-04-20T08:00:00Z', weight: 81.2, notes: '' });
            document.getElementById('weight-datetime').value = '2026-04-22T08:15';
            document.getElementById('weight-value').value = '80.1';

            await window.handleWeightSubmit({ preventDefault() {} });

            expect(apiCallSpy).toHaveBeenCalledTimes(1);
            const [postUrl, postMethod] = apiCallSpy.mock.calls[0];
            expect(postUrl).toBe('/api/weight?replaces=99');
            expect(postMethod).toBe('POST');
            expect(loadWeightSpy).not.toHaveBeenCalled();
        });

        it('still completes the edit when DELETE fails after a successful POST (duplicate preferred to data loss)', async () => {
            const { window, document } = env;
            // POST succeeds; DELETE returns null (e.g. network hiccup after
            // the replacement landed). The modal still closes and
            // loadWeightLogs runs so the user sees the new row; the stale
            // original remains and can be deleted from the history list.
            const apiCallSpy = vi.fn()
                .mockResolvedValueOnce({ id: 2 })  // POST
                .mockResolvedValueOnce(null);      // DELETE
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
            const loadWeightSpy = vi.fn();
            window.loadWeightLogs = loadWeightSpy;

            window.editWeightLog({ id: 17, measured_at: '2026-04-20T08:00:00Z', weight: 81.2, notes: '' });
            document.getElementById('weight-datetime').value = '2026-04-22T08:15';
            document.getElementById('weight-value').value = '80.1';

            await window.handleWeightSubmit({ preventDefault() {} });

            expect(apiCallSpy).toHaveBeenCalledTimes(2);
            expect(apiCallSpy.mock.calls[0][1]).toBe('POST');
            expect(apiCallSpy.mock.calls[1][1]).toBe('DELETE');
            expect(loadWeightSpy).toHaveBeenCalledTimes(1);
        });

        it('clears editingWeightLog after a successful edit so a later Save does not DELETE the old row again', async () => {
            const { window, document } = env;
            // First attempt: POST resolves → DELETE resolves → happy path.
            // A synthetic follow-up handleWeightSubmit() (no re-open) should
            // issue only a POST — the previous DELETE already ran.
            const apiCallSpy = vi.fn()
                .mockResolvedValueOnce({ id: 2 })       // POST
                .mockResolvedValueOnce({ ok: true })    // DELETE
                .mockResolvedValueOnce({ id: 3 });      // follow-up POST
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
            window.loadWeightLogs = vi.fn();

            window.editWeightLog({ id: 17, measured_at: '2026-04-20T08:00:00Z', weight: 81.2, notes: '' });
            document.getElementById('weight-datetime').value = '2026-04-22T08:15';
            document.getElementById('weight-value').value = '80.1';
            await window.handleWeightSubmit({ preventDefault() {} });

            document.getElementById('weight-datetime').value = '2026-04-22T08:20';
            document.getElementById('weight-value').value = '80.2';
            await window.handleWeightSubmit({ preventDefault() {} });

            // Three calls total: POST, DELETE, then the follow-up POST only.
            expect(apiCallSpy).toHaveBeenCalledTimes(3);
            expect(apiCallSpy.mock.calls[0][1]).toBe('POST');
            expect(apiCallSpy.mock.calls[1][1]).toBe('DELETE');
            expect(apiCallSpy.mock.calls[2][1]).toBe('POST');
        });

        it('editing a local (pending) log purges IndexedDB instead of issuing a DELETE request', async () => {
            const { window, document } = env;
            const apiCallSpy = vi.fn().mockResolvedValue({ id: 3 });
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
            window.loadWeightLogs = vi.fn();

            const confirmDeleteSpy = vi.fn().mockResolvedValue(undefined);
            window.MedTrackerDB = { WeightStore: { confirmDelete: confirmDeleteSpy } };
            window.SyncManager = { updateStatus: vi.fn() };

            window.editWeightLog({
                id: 'local_42',
                measured_at: '2026-04-20T08:00:00Z',
                weight: 81.2,
                notes: '',
                isLocal: true,
            });
            document.getElementById('weight-datetime').value = '2026-04-22T08:15';
            document.getElementById('weight-value').value = '80.1';

            await window.handleWeightSubmit({ preventDefault() {} });

            expect(confirmDeleteSpy).toHaveBeenCalledWith(42);
            expect(apiCallSpy).toHaveBeenCalledTimes(1);
            const [postUrl, postMethod] = apiCallSpy.mock.calls[0];
            expect(postUrl).toBe('/api/weight');
            expect(postMethod).toBe('POST');
        });
    });

    describe('cancel + close wiring', () => {
        it('cancel button closes the modal (modal-controller history preserved)', () => {
            const { window, document } = env;
            window.showWeightModal();
            expect(document.getElementById('weight-modal').classList.contains('hidden')).toBe(false);
            document.getElementById('weight-modal-cancel-btn').click();
            expect(document.getElementById('weight-modal').classList.contains('hidden')).toBe(true);
        });

        it('close icon-btn also closes the modal', () => {
            const { window, document } = env;
            window.showWeightModal();
            expect(document.getElementById('weight-modal').classList.contains('hidden')).toBe(false);
            document.getElementById('weight-modal-close-btn').click();
            expect(document.getElementById('weight-modal').classList.contains('hidden')).toBe(true);
        });
    });

    // Round-2 defects Task 4 — #2 (close icon), #3 (last-logged seed), #4 (focus)
    describe('Round-2 Task 4: open-time polish', () => {
        it('paints the Wandergeek close SVG into #weight-modal-close-btn on open (defect #2)', () => {
            const { window, document } = env;
            window.showWeightModal();

            const closeBtn = document.getElementById('weight-modal-close-btn');
            expect(closeBtn).not.toBeNull();
            expect(closeBtn.classList.contains('wg-icon-btn')).toBe(true);

            const gloss = closeBtn.querySelector('.wg-gloss');
            expect(gloss).not.toBeNull();
            const svg = gloss.querySelector('svg');
            expect(svg, 'expected close SVG to be rendered on open').not.toBeNull();
            expect(svg.getAttribute('data-wg-icon')).toBe('close');
        });

        it('seeds the weight input from DataStore weight cache when no in-memory log exists (defect #3)', async () => {
            const { window, document } = env;
            const cachedPayload = {
                logsRes: [
                    { id: 9, measured_at: '2026-04-20T07:00:00Z', weight: 82.5 },
                    { id: 8, measured_at: '2026-04-18T07:00:00Z', weight: 83.1 },
                ]
            };
            window.DataStore.getCached = vi.fn(async (key) => key === 'weight' ? cachedPayload : null);

            window.showWeightModal();
            // showWeightModal kicks off the async DataStore read; flush the
            // microtask queue so the input picks up the cached latest weight.
            await new Promise((resolve) => setTimeout(resolve, 0));

            const input = document.getElementById('weight-value');
            expect(parseFloat(input.value)).toBeCloseTo(82.5, 2);
        });

        it('focuses the weight input on open (defect #4)', () => {
            const { window, document } = env;
            window.showWeightModal();
            const input = document.getElementById('weight-value');
            expect(document.activeElement).toBe(input);
        });
    });
});
