// Meds schedule sub-tab (kit v2 M1, med-xso6.18; Phase 5 Task 4 before it).
//
// Exercises renderMeds(): scheduled entries group by their next dose slot into
// `.wg-meds-bucket` sections ("HH:MM · in Xh Ym" eyebrow + a "Take N" head
// action), missed doses get "HH:MM · missed today" buckets with "Log late",
// as-needed and archived meds collapse into their own buckets below, and each
// row is a kit `.wg-row.wg-meds-row` (tap edits; Edit/Delete behind the
// WGRowActions overflow menu; as-needed rows keep a per-row Log).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickRowAction, loadFrontendEnv } from './helpers/frontend-harness.js';

function toLocalTime(date) {
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

// `upcoming` seeds GET /api/medications/upcoming — the plan-aware forecast the
// Schedule tab buckets by (bd med-gut.1). The default `null` makes the route
// answer with null, i.e. NO forecast available (offline, or the legacy bot
// server), which is the path that still falls back to the device-local
// computation — the behaviour the pre-med-gut cases below were written for.
// An explicit `[]` is a different thing: a forecast that answered and has
// nothing upcoming.
async function seedMedications(window, meds, upcoming = null) {
    window.DataStore.loadSWR = vi.fn(async (options) => {
        await options.onFresh(meds);
    });
    window.apiCall = vi.fn(async (endpoint) => {
        if (typeof endpoint === 'string' && endpoint.startsWith('/api/medications/upcoming')) {
            return upcoming;
        }
        return [];
    });
    await window.loadMeds();
}

// Wire shape of one /api/medications/upcoming row (web/domain/medintake.js's
// upcomingDoses). local_date/local_time/day_offset are computed in the TRACKED
// timezone by the domain, which is the whole point — the browser only knows
// the device zone.
function upcomingDose({
    id, name, dosage = '', at, localDate, localTime, dayOffset = 0, step = null
}) {
    const row = {
        medication_id: id,
        med_name: name,
        dosage,
        scheduled_at: at.toISOString(),
        local_date: localDate,
        local_time: localTime,
        day_offset: dayOffset,
        source: step ? 'tz_step' : 'schedule'
    };
    if (step) {
        row.step_number = step.number;
        row.total_steps = step.total;
        row.note = step.note;
    }
    return row;
}

describe('Meds schedule sub-tab (Phase 5, Task 4)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('groups scheduled meds by next dose slot into `.wg-meds-bucket` sections with a "Take N" action', async () => {
        const { window, document } = env;
        const now = new Date();
        // Two meds share one dose instant (~+1h) and a third is later (~+4h).
        const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
        inOneHour.setMinutes(5, 0, 0);
        const alsoInOneHour = inOneHour; // same slot
        const fourHoursOut = new Date(inOneHour.getTime() + 3 * 60 * 60 * 1000);

        await seedMedications(window, [
            {
                id: 1,
                name: 'Allopurinol',
                dosage: '100mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false
            },
            {
                id: 2,
                name: 'Bisoprolol',
                dosage: '5mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(alsoInOneHour)] }),
                archived: false
            },
            {
                id: 3,
                name: 'Metformin',
                dosage: '500mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(fourHoursOut)] }),
                archived: false
            }
        ]);

        const list = document.getElementById('med-list');
        const sections = list.querySelectorAll('.wg-meds-bucket__label');
        expect(sections.length).toBeGreaterThanOrEqual(2);

        // First section header matches HH:MM · in ...
        const firstHeader = sections[0].textContent.trim();
        expect(firstHeader).toMatch(/^\d{2}:\d{2} · in /);

        const rows = list.querySelectorAll('.wg-meds-row');
        expect(rows.length).toBe(3);
        rows.forEach((row) => {
            expect(row.classList.contains('wg-row')).toBe(true);
            expect(row.classList.contains('med-item')).toBe(true);
        });

        // Both +1h meds cluster in the first bucket; its head action takes both.
        const buckets = list.querySelectorAll('.wg-meds-bucket');
        expect(buckets.length).toBeGreaterThanOrEqual(2);
        const names = Array.from(buckets[0].querySelectorAll('.wg-meds-row__name')).map((el) => el.textContent);
        expect(names).toEqual(['Allopurinol', 'Bisoprolol']);
        expect(buckets[0].querySelector('.wg-meds-bucket__action').textContent).toBe('Take 2');
        expect(buckets[1].querySelector('.wg-meds-bucket__action').textContent).toBe('Take 1');
    });

    it('"Take N" opens the confirm modal for the bucket\'s meds at the slot instant', async () => {
        const { window, document } = env;
        const slot = new Date(Date.now() + 60 * 60 * 1000);
        slot.setMinutes(5, 0, 0);
        const spy = vi.fn();
        window.showMedicationConfirmModal = spy;
        await seedMedications(window, [
            { id: 1, name: 'Allopurinol', dosage: '100mg', schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(slot)] }), archived: false },
            { id: 2, name: 'Bisoprolol', dosage: '5mg', schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(slot)] }), archived: false }
        ]);
        document.querySelector('#med-list .wg-meds-bucket__action').click();
        expect(spy).toHaveBeenCalledTimes(1);
        const [ids, , scheduledAt, mode] = spy.mock.calls[0];
        expect(ids).toEqual([1, 2]);
        expect(new Date(scheduledAt).getTime()).toBe(slot.getTime());
        expect(mode).toBe('confirm');
    });

    it('the take sheet for an upcoming, unmaterialized slot hides Snooze and Skip', () => {
        const { window, document } = env;
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        window.showMedicationConfirmModal([1], ['Allopurinol'], future, 'confirm', []);
        expect(document.getElementById('med-confirm-snooze-btn').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('med-confirm-skip-btn').classList.contains('hidden')).toBe(true);

        window.showMedicationConfirmModal([1], ['Allopurinol'], new Date(Date.now() - 60000).toISOString(), 'confirm', []);
        expect(document.getElementById('med-confirm-snooze-btn').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('med-confirm-skip-btn').classList.contains('hidden')).toBe(false);
    });

    it('a due PENDING intake renders a "missed" bucket first whose "Log late" confirms that intake', async () => {
        const { window, document } = env;
        const missedAt = new Date(Date.now() - 2 * 60 * 1000);
        missedAt.setSeconds(0, 0);
        const later = new Date(Date.now() + 60 * 60 * 1000);
        const spy = vi.fn();
        window.showMedicationConfirmModal = spy;
        const meds = [
            { id: 7, name: 'Losartan', dosage: '50mg', schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(missedAt)] }), archived: false },
            { id: 8, name: 'Metformin', dosage: '500mg', schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(later)] }), archived: false }
        ];
        window.DataStore.loadSWR = vi.fn(async (options) => { await options.onFresh(meds); });
        window.apiCall = vi.fn(async (endpoint) => {
            if (typeof endpoint === 'string' && endpoint.startsWith('/api/history')) {
                return [{ id: 'intake-7-x', medication_id: 7, scheduled_at: missedAt.toISOString(), status: 'PENDING', snoozed_until: null }];
            }
            if (typeof endpoint === 'string' && endpoint.startsWith('/api/medications/upcoming')) return null;
            return [];
        });
        await window.loadMeds();

        const buckets = document.querySelectorAll('#med-list .wg-meds-bucket');
        const first = buckets[0];
        expect(first.querySelector('.wg-meds-bucket__label').textContent).toMatch(/^\d{2}:\d{2} · missed (today|yesterday)$/);
        expect(first.querySelector('.wg-eyebrow--danger')).not.toBeNull();
        expect(first.querySelector('.wg-row__lead--danger')).not.toBeNull();
        expect(Array.from(first.querySelectorAll('.wg-meds-row__name')).map((el) => el.textContent)).toEqual(['Losartan']);
        // The missed med is not repeated under an upcoming bucket.
        expect(document.querySelectorAll('#med-list .wg-meds-row[data-med-id="7"]').length).toBe(1);

        const action = first.querySelector('.wg-meds-bucket__action');
        expect(action.textContent).toBe('Log late');
        action.click();
        expect(spy).toHaveBeenCalledTimes(1);
        const [ids, , scheduledAt, mode, intakeIds] = spy.mock.calls[0];
        expect(ids).toEqual([7]);
        expect(scheduledAt).toBe(missedAt.toISOString());
        expect(mode).toBe('confirm');
        expect(intakeIds).toEqual(['intake-7-x']);
    });

    it('renders the inventory tag in both normal and low-stock states', async () => {
        const { window, document } = env;
        const now = new Date();
        const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

        await seedMedications(window, [
            {
                id: 1,
                name: 'Aspirin',
                dosage: '75mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false,
                inventory_count: 2 // one per day ⇒ 2 days of stock ⇒ low (<7)
            },
            {
                id: 2,
                name: 'Metformin',
                dosage: '500mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false,
                inventory_count: 60 // plenty
            }
        ]);

        const aspirinRow = Array.from(document.querySelectorAll('.wg-meds-row'))
            .find((el) => el.textContent.includes('Aspirin'));
        const metforminRow = Array.from(document.querySelectorAll('.wg-meds-row'))
            .find((el) => el.textContent.includes('Metformin'));

        const lowTag = aspirinRow.querySelector('.wg-meds-row__inventory');
        expect(lowTag).not.toBeNull();
        expect(lowTag.classList.contains('wg-chip')).toBe(true);
        expect(lowTag.classList.contains('wg-chip--warn')).toBe(true);
        expect(lowTag.textContent).toBe('2 left');

        const okTag = metforminRow.querySelector('.wg-meds-row__inventory');
        expect(okTag).not.toBeNull();
        expect(okTag.classList.contains('wg-chip--ok')).toBe(true);
        expect(okTag.textContent).toBe('60 left');
    });

    it('renders negative and zero stock as Out labels, never a negative count', async () => {
        const { window, document } = env;
        const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
        const sched = JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] });
        await seedMedications(window, [
            { id: 1, name: 'Aspirin', dosage: '75mg', schedule: sched, archived: false, inventory_count: -17 },
            { id: 2, name: 'Metformin', dosage: '500mg', schedule: sched, archived: false, inventory_count: 0 }
        ]);
        const tagOf = (n) => Array.from(document.querySelectorAll('.wg-meds-row'))
            .find((el) => el.textContent.includes(n)).querySelector('.wg-meds-row__inventory');
        expect(tagOf('Aspirin').textContent).toBe('Out \u00B7 17 over');
        expect(tagOf('Aspirin').classList.contains('wg-chip--danger')).toBe(true);
        expect(tagOf('Metformin').textContent).toBe('Out');
        expect(tagOf('Metformin').classList.contains('wg-chip--danger')).toBe(true);
    });

    it('an optimistic (not yet committed) med row shows the shared Pending sync chip', async () => {
        const { window, document } = env;
        const sched = JSON.stringify({ type: 'daily', times: [toLocalTime(new Date(Date.now() + 60 * 60 * 1000))] });
        await seedMedications(window, [
            { id: 'local_optimistic_1', name: 'Queued', schedule: sched, archived: false, _optimistic: true },
            { id: 2, name: 'Synced', schedule: sched, archived: false }
        ]);
        const rowOf = (n) => Array.from(document.querySelectorAll('.wg-meds-row')).find((el) => el.textContent.includes(n));
        const chip = rowOf('Queued').querySelector('.wg-chip--pending');
        expect(chip).not.toBeNull();
        expect(chip.textContent).toBe('Pending');
        expect(rowOf('Synced').querySelector('.wg-chip--pending')).toBeNull();
    });

    it('collapses as-needed and archived meds into separate section-label groups after the scheduled ones', async () => {
        const { window, document } = env;
        const now = new Date();
        const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

        await seedMedications(window, [
            {
                id: 1,
                name: 'Scheduled Med',
                dosage: '10mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false
            },
            {
                id: 2,
                name: 'PRN Med',
                dosage: '1 tab',
                schedule: JSON.stringify({ type: 'as_needed' }),
                archived: false
            },
            {
                id: 3,
                name: 'Archived Med',
                dosage: '2mg',
                schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
                archived: true
            }
        ]);

        const list = document.getElementById('med-list');
        const headers = Array.from(list.querySelectorAll('.wg-meds-bucket__label'))
            .map((h) => h.textContent.trim());
        expect(headers.length).toBe(3);
        expect(headers[0]).toMatch(/^\d{2}:\d{2} · in /);
        expect(headers[1]).toBe('As needed');
        expect(headers[2]).toBe('Archived');

        const archivedRow = Array.from(list.querySelectorAll('.wg-meds-row'))
            .find((el) => el.textContent.includes('Archived Med'));
        expect(archivedRow.classList.contains('archived')).toBe(true);

        const prnRow = Array.from(list.querySelectorAll('.wg-meds-row'))
            .find((el) => el.textContent.includes('PRN Med'));
        expect(prnRow).not.toBeNull();
        expect(prnRow.querySelector('.wg-meds-row__schedule').textContent).toBe('As Needed');
    });

    it('row tap edits; Edit / Delete / "Log a dose" live in the overflow; as-needed rows keep a Log button', async () => {
        const { window, document } = env;
        const inOneHour = new Date(Date.now() + 60 * 60 * 1000);

        await seedMedications(window, [
            { id: 42, name: 'Soon Med', dosage: '10mg', schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }), archived: false },
            { id: 43, name: 'PRN Med', dosage: '1 tab', schedule: JSON.stringify({ type: 'as_needed' }), archived: false }
        ]);

        const editSpy = vi.spyOn(window, 'showEditModal').mockImplementation(() => {});
        const logSpy = vi.spyOn(window, 'logMedicationPast').mockImplementation(() => {});
        const deleteSpy = vi.spyOn(window, 'deleteMed').mockImplementation(() => {});

        const row = document.querySelector('.wg-meds-row[data-med-id="42"]');
        expect(row).not.toBeNull();
        expect(row.classList.contains('wg-swipe')).toBe(true);
        // Scheduled rows: the bucket head owns Take; no per-row Log button.
        expect(row.querySelector('.wg-meds-row__log-btn')).toBeNull();
        expect(row.querySelector('.icon-action-btn')).toBeNull();

        clickRowAction(row, 'Log a dose');
        expect(logSpy).toHaveBeenCalledWith(42, 'Soon Med');
        clickRowAction(row, 'Edit');
        expect(editSpy).toHaveBeenCalledWith(42);
        clickRowAction(row, 'Delete');
        expect(deleteSpy).toHaveBeenCalledWith(42);

        editSpy.mockClear();
        row.querySelector('.wg-meds-row__info').click();
        expect(editSpy).toHaveBeenCalledWith(42);

        const prnLog = document.querySelector('.wg-meds-row[data-med-id="43"] .wg-meds-row__log-btn');
        expect(prnLog).not.toBeNull();
        expect(prnLog.classList.contains('wg-btn')).toBe(true);
        logSpy.mockClear();
        editSpy.mockClear();
        prnLog.click();
        expect(logSpy).toHaveBeenCalledWith(43, 'PRN Med');
        expect(editSpy).not.toHaveBeenCalled();
    });

    it('Add medication is the kit primary in the Meds app bar, not inside a sub-tab pane', () => {
        const { document } = env;
        const btn = document.getElementById('add-btn');
        expect(btn).not.toBeNull();
        expect(btn.classList.contains('wg-btn')).toBe(true);
        expect(btn.classList.contains('wg-btn--primary')).toBe(true);
        expect(btn.classList.contains('wg-toolbar-btn')).toBe(false);
        expect(document.querySelector('#meds-view .wg-appbar').contains(btn)).toBe(true);
        expect(document.getElementById('med-schedule-tab').contains(btn)).toBe(false);
        expect(document.querySelector('.wg-meds-schedule-header')).toBeNull();
        expect(btn.textContent.trim()).toBe('Add');
    });


    // bd med-gut.1 — the Schedule tab used to bucket by a naive device-local
    // next-dose (medication-utils.getNextScheduledDate), which ignored the
    // tracked IANA timezone and any approved tz transition plan, so it
    // disagreed with Home's next-intake card. It now buckets by
    // GET /api/medications/upcoming, which runs the same plan-aware engine.
    it('buckets by the plan-aware forecast rather than the device-local schedule', async () => {
        const { window, document } = env;
        // The stored schedule says 08:00; the forecast says 05:30 (an approved
        // transition plan shifted the dose). The header must follow the
        // forecast, exactly like Home's next-intake card does.
        const shifted = new Date(Date.now() + 90 * 60 * 1000);

        await seedMedications(window, [
            {
                id: 7,
                name: 'Metformin',
                dosage: '500mg',
                schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }),
                archived: false
            }
        ], [
            upcomingDose({
                id: 7,
                name: 'Metformin',
                dosage: '500mg',
                at: shifted,
                localDate: '2026-08-16',
                localTime: '05:30',
                step: { number: 1, total: 2, note: 'Metformin (strict — gradual shift): step 1/2' }
            })
        ]);

        const list = document.getElementById('med-list');
        const headers = Array.from(list.querySelectorAll('.wg-meds-bucket__label'))
            .map((h) => h.textContent.trim());
        // Bucket header carries the forecast's tracked-timezone clock time,
        // never the 08:00 written on the medication.
        expect(headers[0]).toMatch(/^05:30 · in /);
        expect(headers.some((h) => h.startsWith('08:00'))).toBe(false);
        expect(headers).not.toContain('Scheduled');
    });

    // bd med-gut.1 — a forecast that answered with no row for a medication is
    // a real answer (course ended, starts past the horizon, every slot inside
    // it already handled). Recomputing it device-locally would resurrect the
    // bogus bucket this change removes.
    it('puts a med the forecast has no dose for in the no-time "Scheduled" group', async () => {
        const { window, document } = env;

        await seedMedications(window, [
            {
                id: 4,
                name: 'FinishedCourse',
                dosage: '10mg',
                schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }),
                archived: false
            }
        ], []);

        const list = document.getElementById('med-list');
        const headers = Array.from(list.querySelectorAll('.wg-meds-bucket__label'))
            .map((h) => h.textContent.trim());
        // The forecast lives in its own sub-tab now (bd med-4oxj), so the
        // Schedule list carries the no-time group and nothing else.
        expect(headers).toEqual(['Scheduled']);
        expect(list.querySelectorAll('.wg-meds-row').length).toBe(1);
    });

    // bd med-gut.1 — a legacy "HH:MM" schedule string used to fail
    // parseMedicationSchedule's bare JSON.parse, so the med lost its next dose
    // and dropped into the no-time "Scheduled" bucket.
    it('gives a legacy "HH:MM" schedule string a real hour bucket', async () => {
        const { window, document } = env;

        await seedMedications(window, [
            {
                id: 3,
                name: 'LegacyMed',
                dosage: '10mg',
                schedule: '08:00',
                archived: false
            }
        ]);

        const list = document.getElementById('med-list');
        const headers = Array.from(list.querySelectorAll('.wg-meds-bucket__label'))
            .map((h) => h.textContent.trim());
        expect(headers).toEqual([expect.stringMatching(/^08:00 · in /)]);
        expect(headers).not.toContain('Scheduled');

        const row = list.querySelector('.wg-meds-row');
        expect(row.querySelector('.wg-meds-row__schedule').textContent).toBe('Daily: 08:00');
    });

    it('rendering twice replaces the list cleanly (no duplicate section headers)', async () => {
        const { window, document } = env;
        const now = new Date();
        const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

        await seedMedications(window, [
            {
                id: 1,
                name: 'Scheduled Med',
                dosage: '10mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false
            }
        ]);

        window.renderMeds();

        const list = document.getElementById('med-list');
        const headers = list.querySelectorAll('.wg-meds-bucket__label');
        expect(headers.length).toBe(1);
        const rows = list.querySelectorAll('.wg-meds-row');
        expect(rows.length).toBe(1);
    });

    it('zero medications renders the kit empty state whose action opens Add (med-xso6.4)', async () => {
        const { window, document } = env;
        await seedMedications(window, []);
        window.renderMeds();

        const list = document.getElementById('med-list');
        const empty = list.querySelector('.wg-empty');
        expect(empty).not.toBeNull();
        expect(empty.querySelector('.wg-empty__title').textContent).toBe('No medications yet');
        expect(list.querySelectorAll('.wg-meds-row').length).toBe(0);

        const action = empty.querySelector('.wg-empty__acts button');
        expect(action.classList.contains('wg-btn--primary')).toBe(true);
        const spy = vi.spyOn(window, 'showAddModal').mockImplementation(() => {});
        action.click();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('hides the app-bar Add while the visible pane\'s empty state carries its own Add (M4)', async () => {
        const { window, document } = env;
        await seedMedications(window, []);
        const addBtn = document.getElementById('add-btn');
        window.switchMedTab('schedule');
        window.renderMeds();
        expect(addBtn.hidden).toBe(true);

        // Another pane without an empty-state Add shows it again.
        window.switchMedTab('history');
        expect(addBtn.hidden).toBe(false);

        // Once there is a med, Schedule keeps the app-bar Add.
        const sched = JSON.stringify({ type: 'daily', times: ['08:00'] });
        await seedMedications(window, [{ id: 1, name: 'Aspirin', schedule: sched, archived: false }]);
        window.switchMedTab('schedule');
        window.renderMeds();
        expect(addBtn.hidden).toBe(false);
    });
});

// bd med-gut.2 — read-only "Upcoming" forecast: the next 7 days of doses
// grouped by day in the TRACKED timezone, with tz-plan steps labelled and
// their explanatory note surfaced.
//
// bd med-4oxj promoted it out of the Schedule list into its own Meds sub-tab
// (History | Schedule | Upcoming | Inventory), so these cases now drive
// switchMedTab('upcoming') and assert against the `#med-upcoming-list` pane.
describe('Meds Upcoming sub-tab — forecast (bd med-gut.2, bd med-4oxj)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        try { env.window.sessionStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    // Enters the Upcoming sub-tab the way a tap does — switchMedTab activates
    // the pane and dispatches to loadUpcoming(); the explicit await makes the
    // dispatch's floating promise deterministic for assertions.
    async function openUpcomingTab(window, upcoming) {
        window.apiCall = vi.fn(async (endpoint) => (
            typeof endpoint === 'string' && endpoint.startsWith('/api/medications/upcoming')
                ? upcoming
                : []
        ));
        window.switchMedTab('upcoming');
        await window.loadUpcoming();
    }

    const med = {
        id: 1,
        name: 'Metformin',
        dosage: '500mg',
        schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }),
        archived: false
    };

    it('groups the forecast by day using the route\'s tracked-timezone day fields', async () => {
        const { window, document } = env;
        const base = Date.now() + 60 * 60 * 1000;

        await openUpcomingTab(window, [
            upcomingDose({
                id: 1, name: 'Metformin', dosage: '500mg', at: new Date(base),
                localDate: '2026-08-16', localTime: '08:00', dayOffset: 0
            }),
            upcomingDose({
                id: 1, name: 'Metformin', dosage: '500mg', at: new Date(base + 24 * 3600_000),
                localDate: '2026-08-17', localTime: '08:00', dayOffset: 1
            }),
            upcomingDose({
                id: 1, name: 'Metformin', dosage: '500mg', at: new Date(base + 48 * 3600_000),
                localDate: '2026-08-18', localTime: '08:00', dayOffset: 2
            })
        ]);

        const wrap = document.querySelector('#med-upcoming-list .wg-meds-upcoming');
        expect(wrap).not.toBeNull();
        // The pill above names the pane — no duplicated section label inside.
        expect(wrap.querySelector('.wg-meds-bucket__label')).toBeNull();

        const dayLabels = Array.from(wrap.querySelectorAll('.wg-meds-upcoming__day'))
            .map((el) => el.textContent.trim());
        expect(dayLabels).toHaveLength(3);
        // day_offset comes from the domain (tracked zone), so "Today"/"Tomorrow"
        // stay correct even when the device zone is a different calendar day.
        expect(dayLabels[0]).toBe('Today');
        expect(dayLabels[1]).toBe('Tomorrow');
        expect(dayLabels[2]).not.toBe('Tomorrow');

        const rows = wrap.querySelectorAll('.wg-meds-upcoming__row');
        expect(rows.length).toBe(3);
        expect(rows[0].querySelector('.wg-meds-upcoming__time').textContent).toBe('08:00');
        expect(rows[0].querySelector('.wg-meds-upcoming__name').textContent).toBe('Metformin');
        expect(rows[0].querySelector('.wg-meds-upcoming__dosage').textContent).toBe('500mg');
        // Read-only: no take/skip/log affordances in the forecast list.
        expect(wrap.querySelectorAll('button').length).toBe(0);
    });

    it('badges a tz-plan step dose and shows the step note', async () => {
        const { window, document } = env;
        const at = new Date(Date.now() + 3 * 3600_000);
        const note = 'Metformin (strict — gradual shift): step 1/2 — 08:00 GMT+3 old / 05:00 GMT new';

        await openUpcomingTab(window, [
            upcomingDose({
                id: 1, name: 'Metformin', dosage: '500mg', at,
                localDate: '2026-08-16', localTime: '05:00', dayOffset: 0,
                step: { number: 1, total: 2, note }
            })
        ]);

        const row = document.querySelector('#med-upcoming-list .wg-meds-upcoming__row');
        expect(row.classList.contains('wg-meds-upcoming__row--step')).toBe(true);
        const badge = row.querySelector('.wg-meds-upcoming__badge');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-tag')).toBe(true);
        expect(badge.classList.contains('wg-tag--mono')).toBe(true);
        expect(badge.textContent).toBe('transition step 1/2');
        expect(row.querySelector('.wg-meds-upcoming__note').textContent).toBe(note);
    });

    // bd med-jr1e: an answered-but-empty forecast used to render nothing, which
    // was indistinguishable on screen from the feature not shipping at all —
    // and in a dedicated tab (bd med-4oxj) that would be a blank screen.
    it('renders an honest empty state when the forecast answered with no doses', async () => {
        const { window, document } = env;
        await openUpcomingTab(window, []);

        const wrap = document.querySelector('#med-upcoming-list .wg-meds-upcoming');
        expect(wrap).not.toBeNull();
        const empty = wrap.querySelector('.wg-empty');
        expect(empty).not.toBeNull();
        expect(empty.querySelector('.wg-empty__title').textContent).toBe('Nothing scheduled');
        expect(empty.querySelector('.wg-empty__body').textContent).toContain('next 7 days');
        expect(wrap.querySelectorAll('.wg-meds-upcoming__row').length).toBe(0);
        // M4: the empty state's Add is the one primary on screen.
        expect(empty.querySelector('.wg-btn--primary')).not.toBeNull();
        expect(document.getElementById('add-btn').hidden).toBe(true);
    });

    // bd med-4oxj: the forecast used to render inside the Schedule list
    // (between the `Scheduled` fallback and `As needed`, bd med-jr1e). It now
    // lives in its own pane, and the Schedule list must not carry it at all.
    it('keeps the forecast out of the Schedule list and paints it in the Upcoming pane', async () => {
        const { window, document } = env;
        const at = new Date(Date.now() + 60 * 60 * 1000);

        // seedMedications drives loadMeds(), which is the Schedule tab's own
        // path — and still refreshes the shared forecast state (bd med-gut.1).
        await seedMedications(window, [
            { ...med, schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(at)] }) },
            { id: 2, name: 'PRN Med', dosage: '1 tab', schedule: JSON.stringify({ type: 'as_needed' }), archived: false },
            { id: 3, name: 'Archived Med', dosage: '2mg', schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }), archived: true }
        ], [
            upcomingDose({
                id: 1, name: 'Metformin', dosage: '500mg', at,
                localDate: '2026-08-16', localTime: toLocalTime(at), dayOffset: 0
            })
        ]);

        const labels = Array.from(document.querySelectorAll('#med-list .wg-meds-bucket__label'))
            .map((el) => el.textContent.trim());
        expect(labels[0]).toMatch(/^\d{2}:\d{2} · in /);
        expect(labels[1]).toBe('As needed');
        expect(labels[2]).toBe('Archived');
        expect(document.querySelector('#med-list .wg-meds-upcoming')).toBeNull();

        // The same loadMeds() pass painted the Upcoming pane off the forecast
        // it already fetched — one request behind both views.
        const rows = document.querySelectorAll('#med-upcoming-list .wg-meds-upcoming__row');
        expect(rows.length).toBe(1);
        expect(rows[0].querySelector('.wg-meds-upcoming__name').textContent).toBe('Metformin');
    });

    it('renders nothing when the forecast route is unavailable', async () => {
        const { window, document } = env;
        await openUpcomingTab(window, null); // route answers null

        // Offline / legacy server: no forecast to claim anything about, so the
        // pane stays blank rather than asserting "nothing upcoming".
        expect(document.querySelector('#med-upcoming-list .wg-meds-upcoming')).toBeNull();
        expect(document.getElementById('med-upcoming-list').children.length).toBe(0);
    });
});
