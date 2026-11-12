// Meds My meds list (kit v2 MY1, MY1 · end; bd med-5uwb.1), the `schedule`
// sub-tab.
//
// Exercises renderMeds(): one `.wg-row.wg-meds-row` per medication in exactly
// one `.wg-section[data-group]` — Needs a refill, Scheduled, When needed, Not
// in use, the Archived fold — then a neutral Add medication. Rows: tap edits,
// Edit / Delete (+ "Log a dose") behind the ⋯ More menu, as-needed rows keep a
// per-row Log, refill rows open the stock sheet, tracked Not-in-use rows carry
// Stop tracking (an optimistic full-record update, bd med-h1wk).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickRowAction, loadFrontendEnv } from './helpers/frontend-harness.js';

const DAILY = JSON.stringify({ type: 'daily', times: ['08:20', '21:30'] });
const AS_NEEDED = JSON.stringify({ type: 'as_needed' });
const DAY_MS = 24 * 60 * 60 * 1000;

async function seedMedications(window, meds) {
    window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(meds);
    });
    window.apiCall = vi.fn(async () => []);
    await window.loadMeds();
}

async function flushMicrotasks() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();
// The editor's stored day: the local calendar day as UTC midnight.
function storedDay(offsetDays) {
    const d = new Date(Date.now() + offsetDays * DAY_MS);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { iso: `${ymd}T00:00:00.000Z`, label: new Date(d.getFullYear(), d.getMonth(), d.getDate()).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) };
}

const rowOf = (document, id) => document.querySelector(`#med-list .wg-meds-row[data-med-id="${id}"]`);
const metaOf = (document, id) => rowOf(document, id).querySelector('.wg-meds-row__schedule').textContent;
const groupIds = (document, group) => Array.from(document.querySelectorAll(`#med-list [data-group="${group}"] .wg-meds-row`)).map((r) => r.dataset.medId);

// One med per group, plus a second refill and an archived one.
function everyGroup() {
    return [
        { id: 1, name: 'Metformin', dosage: '1000 mg', schedule: DAILY, archived: false, inventory_count: 6, last_taken_at: daysAgo(0) },
        { id: 2, name: 'Ibuprofen', dosage: '400 mg', schedule: AS_NEEDED, archived: false, inventory_count: -17, last_taken_at: daysAgo(1) },
        { id: 3, name: 'Candecor', dosage: '16 mg', schedule: JSON.stringify({ type: 'daily', times: ['21:30'] }), archived: false, inventory_count: 141 },
        { id: 4, name: 'Vitamin D3', dosage: '20000 IU', schedule: JSON.stringify({ type: 'weekly', days: [0], times: ['08:20'] }), archived: false },
        { id: 5, name: 'Paracetamol', dosage: '500 mg', schedule: AS_NEEDED, archived: false, inventory_count: 12, last_taken_at: daysAgo(3) },
        { id: 6, name: 'Amoxicillin', dosage: '500 mg', schedule: DAILY, archived: false, inventory_count: 9, end_date: storedDay(-10).iso, last_taken_at: daysAgo(40) },
        { id: 7, name: 'Prednisolone', dosage: '5 mg', schedule: AS_NEEDED, archived: false, inventory_count: 20, last_taken_at: daysAgo(45) },
        { id: 8, name: 'Omeprazole', dosage: '20 mg', schedule: DAILY, archived: true, inventory_count: 0 },
    ];
}

describe('Meds My meds list (kit MY1, bd med-5uwb.1)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('every med shows once, in groups in order with data-group, and Add medication ends the list', async () => {
        const { window, document } = env;
        await seedMedications(window, everyGroup());

        const list = document.getElementById('med-list');
        const sections = Array.from(list.querySelectorAll(':scope > .wg-section'));
        expect(sections.map((s) => s.dataset.group)).toEqual(['refill', 'scheduled', 'as-needed', 'not-in-use', 'archived']);
        expect(sections.slice(0, 4).map((s) => s.querySelector('.wg-eyebrow').textContent))
            .toEqual(['Needs a refill', 'Scheduled', 'When needed', 'Not in use']);
        // Out before Low; the rest by name.
        expect(groupIds(document, 'refill')).toEqual(['2', '1']);
        expect(groupIds(document, 'scheduled')).toEqual(['3', '4']);
        expect(groupIds(document, 'as-needed')).toEqual(['5']);
        expect(groupIds(document, 'not-in-use')).toEqual(['6', '7']);
        expect(groupIds(document, 'archived')).toEqual(['8']);
        const ids = Array.from(list.querySelectorAll('.wg-meds-row')).map((r) => r.dataset.medId).sort();
        expect(ids).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);

        const add = list.lastElementChild;
        expect(add.matches('button.wg-btn.wg-btn--block')).toBe(true);
        expect(add.classList.contains('wg-btn--primary')).toBe(false);
        expect(add.textContent).toBe('Add medication');
        const spy = vi.spyOn(window, 'showAddModal').mockImplementation(() => {});
        add.click();
        expect(spy).toHaveBeenCalledTimes(1);

        // Taking scheduled doses lives on the Timeline now.
        expect(list.querySelector('.wg-meds-bucket__action')).toBeNull();
        expect(list.textContent).not.toMatch(/Take \d|Log late/);
    });

    it('row meta per group: when · stock, weekly days, When needed, Not in use', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            ...everyGroup(),
            { id: 9, name: 'Zinc', schedule: JSON.stringify({ type: 'weekly', days: [1, 3, 5], times: ['08:20'] }), archived: false, inventory_count: 30, last_taken_at: daysAgo(2) },
            { id: 10, name: 'Old cream', schedule: AS_NEEDED, archived: false },
        ]);
        expect(metaOf(document, 1)).toBe('08:20, 21:30 · 6 left · lasts 3 days');
        expect(metaOf(document, 2)).toBe('When needed');
        expect(metaOf(document, 3)).toBe('21:30 · 141 left · lasts 141 days');
        expect(metaOf(document, 4)).toBe('Sundays 08:20 · stock not tracked');
        expect(metaOf(document, 9)).toBe('Mon, Wed, Fri 08:20 · 30 left · lasts 70 days');
        expect(metaOf(document, 5)).toBe('Last 3 days ago · 12 left');
        expect(metaOf(document, 6)).toBe(`Ended ${storedDay(-10).label} · 9 left`);
        expect(metaOf(document, 7)).toBe('Last 45 days ago · 20 left');
        expect(metaOf(document, 10)).toBe('Never taken');

        // The Out/Low chip only in Needs a refill; none on Scheduled rows.
        expect(rowOf(document, 2).querySelector('.wg-meds-stock__chip').textContent).toBe('Out · 17 over');
        expect(rowOf(document, 2).querySelector('.wg-meds-stock__chip').classList.contains('wg-chip--danger')).toBe(true);
        expect(rowOf(document, 1).querySelector('.wg-meds-stock__chip').textContent).toBe('Low');
        expect(rowOf(document, 1).querySelector('.wg-meds-stock__chip').classList.contains('wg-chip--warn')).toBe(true);
        [3, 4, 5, 6, 7, 9].forEach((id) => expect(rowOf(document, id).querySelector('.wg-chip--warn, .wg-chip--danger')).toBeNull());

        // Trailing buttons: Update (refill), Log (When needed), Stop tracking
        // (tracked Not in use only), none on Scheduled.
        expect(rowOf(document, 1).querySelector('.wg-meds-stock__update').textContent).toBe('Update');
        expect(rowOf(document, 5).querySelector('.wg-meds-row__log-btn').textContent).toBe('Log');
        expect(rowOf(document, 6).querySelector('.wg-meds-row__stop').textContent).toBe('Stop tracking');
        expect(rowOf(document, 10).querySelector('.wg-meds-row__stop')).toBeNull();
        expect(rowOf(document, 3).querySelector('.wg-meds-row__actions .wg-btn--sm')).toBeNull();
    });

    it('Needs a refill: Update opens the stock sheet for that med', async () => {
        const { window, document } = env;
        await seedMedications(window, everyGroup());
        rowOf(document, 1).querySelector('.wg-meds-stock__update').click();
        const sheet = document.getElementById('stock-sheet');
        expect(sheet).not.toBeNull();
        expect(sheet.querySelector('.wg-eyebrow').textContent).toBe('Metformin · 1000 mg');
    });

    it('the Archived fold is collapsed on every render and toggles; archived rows carry no stock', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            ...everyGroup(),
            { id: 11, name: 'Atorvastatin', schedule: DAILY, archived: true, inventory_count: 3 },
        ]);
        const section = document.querySelector('#med-list [data-group="archived"]');
        const fold = section.querySelector('.wg-meds-fold');
        const rows = section.querySelector('.wg-meds-archived');
        expect(fold.querySelector('.wg-row__title').textContent).toBe('Archived');
        expect(fold.querySelector('.wg-row__meta').textContent).toBe('2 meds');
        expect(fold.getAttribute('role')).toBe('button');
        expect(fold.getAttribute('aria-expanded')).toBe('false');
        expect(rows.hidden).toBe(true);

        fold.click();
        expect(fold.getAttribute('aria-expanded')).toBe('true');
        expect(rows.hidden).toBe(false);
        fold.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(rows.hidden).toBe(true);

        fold.click();
        window.renderMeds();
        expect(document.querySelector('#med-list .wg-meds-archived').hidden).toBe(true);

        ['8', '11'].forEach((id) => {
            const row = rowOf(document, id);
            expect(row.classList.contains('wg-row--muted')).toBe(true);
            expect(row.querySelector('.wg-meds-row__archived').textContent).toBe('Archived');
            expect(row.querySelector('.wg-meds-stock__chip, .wg-meds-stock__update, .wg-chip--warn, .wg-chip--danger')).toBeNull();
            expect(row.textContent).not.toMatch(/left|Out/);
        });
        expect(document.querySelectorAll('#med-list .wg-meds-row[data-med-id="8"]')).toHaveLength(1);
    });

    it('row tap edits; Edit / Delete / "Log a dose" live in the overflow; When needed rows keep a Log button', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 42, name: 'Soon Med', dosage: '10mg', schedule: DAILY, archived: false },
            { id: 43, name: 'PRN Med', dosage: '1 tab', schedule: AS_NEEDED, archived: false, last_taken_at: daysAgo(1) },
        ]);

        const editSpy = vi.spyOn(window, 'showEditModal').mockImplementation(() => {});
        const logSpy = vi.spyOn(window, 'logMedicationPast').mockImplementation(() => {});
        const deleteSpy = vi.spyOn(window, 'deleteMed').mockImplementation(() => {});

        const row = rowOf(document, 42);
        expect(row.closest('[data-group]').dataset.group).toBe('scheduled');
        expect(row.classList.contains('wg-swipe')).toBe(true);
        expect(row.querySelector('.wg-meds-row__log-btn')).toBeNull();
        expect(row.querySelector('.wg-swipe__more')).not.toBeNull();

        clickRowAction(row, 'Log a dose');
        expect(logSpy).toHaveBeenCalledWith(42, 'Soon Med');
        clickRowAction(row, 'Edit');
        expect(editSpy).toHaveBeenCalledWith(42);
        clickRowAction(row, 'Delete');
        expect(deleteSpy).toHaveBeenCalledWith(42);

        editSpy.mockClear();
        row.querySelector('.wg-meds-row__info').click();
        expect(editSpy).toHaveBeenCalledWith(42);

        const prnLog = rowOf(document, 43).querySelector('.wg-meds-row__log-btn');
        expect(prnLog.classList.contains('wg-btn')).toBe(true);
        logSpy.mockClear();
        editSpy.mockClear();
        prnLog.click();
        expect(logSpy).toHaveBeenCalledWith(43, 'PRN Med');
        expect(editSpy).not.toHaveBeenCalled();
    });

    it('an optimistic (not yet committed) med row shows the shared Pending sync chip', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 'local_optimistic_1', name: 'Queued', schedule: DAILY, archived: false, _optimistic: true },
            { id: 2, name: 'Synced', schedule: DAILY, archived: false },
        ]);
        const chip = rowOf(document, 'local_optimistic_1').querySelector('.wg-chip--pending');
        expect(chip.textContent).toBe('Pending');
        expect(rowOf(document, 2).querySelector('.wg-chip--pending')).toBeNull();
    });

    // bd med-aec1 — course dates read as copy, after the meta.
    it('renders course dates as "since"/"until"/range copy and omits open ends', async () => {
        const { document, window } = env;
        await seedMedications(window, [
            { id: 11, name: 'StartOnly', schedule: DAILY, start_date: '2026-09-12T00:00:00.000Z', archived: false },
            { id: 12, name: 'Bounded', schedule: DAILY, start_date: '2026-09-12T00:00:00.000Z', end_date: '2099-10-01T00:00:00.000Z', archived: false },
            { id: 13, name: 'EndOnly', schedule: DAILY, end_date: '2099-10-01T00:00:00.000Z', archived: false },
            { id: 14, name: 'Open', schedule: DAILY, archived: false },
        ]);
        const dates = (id) => {
            const el = rowOf(document, id).querySelector('.wg-meds-row__dates');
            return el ? el.textContent : null;
        };
        const day = (y, m, d) => new Date(y, m, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
        expect(dates(11)).toBe(`· since ${day(2026, 8, 12)}`);
        expect(dates(12)).toBe(`· ${day(2026, 8, 12)} – ${day(2099, 9, 1)}`);
        expect(dates(13)).toBe(`· until ${day(2099, 9, 1)}`);
        expect(dates(14)).toBeNull();
        // Tags follow the meta.
        const meta = rowOf(document, 13).querySelector('.wg-meds-row__meta');
        expect(meta.firstElementChild.classList.contains('wg-meds-row__schedule')).toBe(true);
    });

    it('a course ending today is still Scheduled; one that ended yesterday with no dose is Not in use', async () => {
        const { window, document } = env;
        await seedMedications(window, [
            { id: 1, name: 'Today', schedule: DAILY, archived: false, end_date: storedDay(0).iso },
            { id: 2, name: 'Yesterday', schedule: DAILY, archived: false, end_date: storedDay(-1).iso },
        ]);
        expect(groupIds(document, 'scheduled')).toEqual(['1']);
        expect(groupIds(document, 'not-in-use')).toEqual(['2']);
    });

    it('rendering twice replaces the list cleanly (no duplicate sections)', async () => {
        const { window, document } = env;
        await seedMedications(window, [{ id: 1, name: 'Scheduled Med', dosage: '10mg', schedule: DAILY, archived: false }]);
        window.renderMeds();
        const list = document.getElementById('med-list');
        expect(list.querySelectorAll('.wg-section')).toHaveLength(1);
        expect(list.querySelectorAll('.wg-meds-row')).toHaveLength(1);
        expect(list.querySelectorAll('.wg-btn--block')).toHaveLength(1);
    });

    it('zero medications renders the kit empty state whose action opens Add (med-xso6.4)', async () => {
        const { window, document } = env;
        await seedMedications(window, []);
        window.renderMeds();

        const list = document.getElementById('med-list');
        const empty = list.querySelector('.wg-empty');
        expect(empty.querySelector('.wg-empty__title').textContent).toBe('No medications yet');
        expect(list.querySelectorAll('.wg-meds-row')).toHaveLength(0);
        expect(list.querySelector('.wg-btn--block')).toBeNull();

        const action = empty.querySelector('.wg-empty__acts button');
        expect(action.classList.contains('wg-btn--primary')).toBe(true);
        const spy = vi.spyOn(window, 'showAddModal').mockImplementation(() => {});
        action.click();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('Add medication is the ghost icon button in the Meds app bar, not inside a sub-tab pane', () => {
        const { document } = env;
        const btn = document.getElementById('add-btn');
        expect(btn.classList.contains('wg-btn')).toBe(true);
        expect(btn.classList.contains('wg-btn--ghost')).toBe(true);
        expect(document.querySelector('#meds-view .wg-appbar').contains(btn)).toBe(true);
        expect(document.getElementById('med-schedule-tab').contains(btn)).toBe(false);
        expect(btn.textContent.trim()).toBe('');
    });

    it('hides the app-bar Add while the visible pane\'s empty state carries its own Add (M4)', async () => {
        const { window, document } = env;
        await seedMedications(window, []);
        const addBtn = document.getElementById('add-btn');
        window.switchMedTab('schedule');
        window.renderMeds();
        expect(addBtn.hidden).toBe(true);

        window.loadTimeline = () => {};
        window.switchMedTab('timeline');
        expect(addBtn.hidden).toBe(false);

        // With a med, My meds keeps the app-bar Add next to its own neutral one.
        await seedMedications(window, [{ id: 1, name: 'Aspirin', schedule: DAILY, archived: false }]);
        window.switchMedTab('schedule');
        window.renderMeds();
        expect(addBtn.hidden).toBe(false);
    });

    describe('Stop tracking (bd med-5uwb.1 + med-h1wk full payload)', () => {
        const tracked = () => ({
            id: 6, name: 'Amoxicillin', dosage: '500 mg', schedule: DAILY, archived: false, supplement: true,
            start_date: '2026-09-01T00:00:00.000Z', end_date: storedDay(-10).iso, tz_shift_policy: 'strict',
            inventory_count: 9, pack_size: 21, last_taken_at: daysAgo(40),
            stock: { counted: 21, counted_at: '2026-09-01T10:00:00Z', seed: false, refills: [], taken: 12 },
        });

        it('flips the row at once, POSTs the full record with tracking off, and the row stays under Not in use', async () => {
            const { window, document } = env;
            await seedMedications(window, [tracked()]);
            const handle = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
            const applySpy = vi.spyOn(window.DataStore, 'applyOptimistic').mockResolvedValue(handle);
            const post = deferred();
            const calls = [];
            window.apiCall = vi.fn((endpoint, method, body) => {
                if (method === 'POST') { calls.push({ endpoint, body }); return post.promise; }
                return Promise.resolve([]);
            });
            window.loadMeds = vi.fn();

            rowOf(document, 6).querySelector('.wg-meds-row__stop').click();
            await flushMicrotasks();

            // Optimistic: no count, no button before the POST resolves.
            expect(metaOf(document, 6)).toBe(`Ended ${storedDay(-10).label}`);
            expect(rowOf(document, 6).querySelector('.wg-meds-row__stop')).toBeNull();
            expect(applySpy).toHaveBeenCalledWith('medications', expect.any(Function), ['medications']);
            const flipped = applySpy.mock.calls[0][1]([tracked(), { id: 7, inventory_count: 5 }]);
            expect(flipped[0]).toMatchObject({ id: 6, inventory_count: null, pack_size: null });
            expect(flipped[1]).toEqual({ id: 7, inventory_count: 5 });

            expect(calls).toEqual([{
                endpoint: '/api/medications/6',
                body: {
                    name: 'Amoxicillin', dosage: '500 mg', schedule: DAILY, archived: false, supplement: true,
                    start_date: '2026-09-01T00:00:00.000Z', end_date: storedDay(-10).iso,
                    inventory_count: null, pack_size: null, tz_shift_policy: 'strict',
                },
            }]);
            // Nothing is deleted: no DELETE, no ledger route.
            expect(window.apiCall.mock.calls.some(([e, m]) => m === 'DELETE' || /restock|stock-audit/.test(e))).toBe(false);

            post.resolve({ status: 'updated' });
            await flushMicrotasks();
            expect(handle.commit).toHaveBeenCalled();
            expect(handle.rollback).not.toHaveBeenCalled();
            expect(window.loadMeds).toHaveBeenCalled();
            expect(groupIds(document, 'not-in-use')).toEqual(['6']);
        });

        it('a failed write rolls back: the count and the button return', async () => {
            const { window, document } = env;
            await seedMedications(window, [tracked()]);
            const handle = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
            vi.spyOn(window.DataStore, 'applyOptimistic').mockResolvedValue(handle);
            window.apiCall = vi.fn(async (_e, method) => (method === 'POST' ? null : []));

            rowOf(document, 6).querySelector('.wg-meds-row__stop').click();
            await flushMicrotasks();

            expect(handle.rollback).toHaveBeenCalled();
            expect(handle.commit).not.toHaveBeenCalled();
            expect(metaOf(document, 6)).toBe(`Ended ${storedDay(-10).label} · 9 left`);
            expect(rowOf(document, 6).querySelector('.wg-meds-row__stop')).not.toBeNull();
        });
    });
});
