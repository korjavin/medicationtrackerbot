// Wandergeek Meds schedule sub-tab (Phase 5, Task 4).
//
// Exercises the rewritten renderMeds(): scheduled entries group by hour of
// their next dose under `.wg-section-label` headers (mono "HH:MM · in Xh Ym"),
// as-needed and archived meds collapse into separate section-label groups
// below the scheduled ones, and each row is a `.wg-card wg-meds-row` with
// dual-classed legacy selectors (`.med-item`, `.icon-action-btn`, `.btn-sm`)
// so the existing UI tests still pass.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

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

    it('groups scheduled meds by hour of next dose under `.wg-section-label` headers', async () => {
        const { window, document } = env;
        const now = new Date();
        // Two meds in the same hour bucket (~+1h) and a third in a later bucket (~+4h).
        // Anchor minutes to :05 so `alsoInOneHour` (+12min → :17) never spills
        // into the next hour regardless of the wall-clock minute when the
        // test runs.
        const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
        inOneHour.setMinutes(5, 0, 0);
        const alsoInOneHour = new Date(inOneHour.getTime() + 12 * 60 * 1000); // same hour
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
        const sections = list.querySelectorAll('.wg-section-label');
        expect(sections.length).toBeGreaterThanOrEqual(2);

        // First section header matches HH:MM · in ...
        const firstHeader = sections[0].textContent.trim();
        expect(firstHeader).toMatch(/^\d{2}:\d{2} · in /);

        const rows = list.querySelectorAll('.wg-meds-row');
        expect(rows.length).toBe(3);
        rows.forEach((row) => {
            expect(row.classList.contains('wg-card')).toBe(true);
            expect(row.classList.contains('med-item')).toBe(true);
        });

        // Both +1h meds cluster under the first hour header (before the
        // second header appears).
        const firstHeaderEl = sections[0];
        const secondHeaderEl = sections[1];
        const clustered = [];
        let node = firstHeaderEl.nextElementSibling;
        while (node && node !== secondHeaderEl) {
            if (node.classList.contains('wg-meds-row')) clustered.push(node);
            node = node.nextElementSibling;
        }
        const names = clustered.map((el) => el.querySelector('.wg-meds-row__name').textContent);
        expect(names).toEqual(expect.arrayContaining(['Allopurinol', 'Bisoprolol']));
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
        expect(lowTag.classList.contains('wg-tag')).toBe(true);
        expect(lowTag.classList.contains('wg-tag--mono')).toBe(true);
        expect(lowTag.classList.contains('wg-tag--alert')).toBe(true);
        expect(lowTag.textContent).toContain('2');
        expect(lowTag.textContent).toContain('⚠️');

        const okTag = metforminRow.querySelector('.wg-meds-row__inventory');
        expect(okTag).not.toBeNull();
        expect(okTag.classList.contains('wg-tag--alert')).toBe(false);
        expect(okTag.classList.contains('wg-tag--normal')).toBe(true);
        expect(okTag.textContent).toContain('60');
        expect(okTag.textContent).not.toContain('⚠️');
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
        const headers = Array.from(list.querySelectorAll('.wg-section-label'))
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

    it('Log / Edit / Delete buttons dispatch to the shared handlers with the med id', async () => {
        const { window, document } = env;
        const now = new Date();
        const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

        await seedMedications(window, [
            {
                id: 42,
                name: 'Soon Med',
                dosage: '10mg',
                schedule: JSON.stringify({ type: 'daily', times: [toLocalTime(inOneHour)] }),
                archived: false
            }
        ]);

        const editSpy = vi.spyOn(window, 'showEditModal').mockImplementation(() => {});
        const logSpy = vi.spyOn(window, 'logMedicationPast').mockImplementation(() => {});
        const deleteSpy = vi.spyOn(window, 'deleteMed').mockImplementation(() => {});

        const row = document.querySelector('.wg-meds-row');
        expect(row).not.toBeNull();

        // Log button — carries `.btn-sm` for legacy selectors + the new
        // `.wg-meds-row__log-btn` hook.
        const logBtn = row.querySelector('.wg-meds-row__log-btn');
        expect(logBtn).not.toBeNull();
        expect(logBtn.classList.contains('btn-sm')).toBe(true);
        logBtn.click();
        expect(logSpy).toHaveBeenCalledWith(42, 'Soon Med');

        const editBtn = row.querySelector('.icon-action-btn:not(.delete)');
        editBtn.click();
        expect(editSpy).toHaveBeenCalledWith(42);

        const deleteBtn = row.querySelector('.icon-action-btn.delete');
        deleteBtn.click();
        expect(deleteSpy).toHaveBeenCalledWith(42);

        // Clicking the info area also opens the edit modal.
        editSpy.mockClear();
        row.querySelector('.wg-meds-row__info').click();
        expect(editSpy).toHaveBeenCalledWith(42);
    });

    it('Add medication CTA uses the shared toolbar-btn classes and lives in the Schedule header (round-2 Task 7)', () => {
        const { document } = env;
        const btn = document.getElementById('add-btn');
        expect(btn).not.toBeNull();
        // Round-2 Task 7 (defect #10): migrated to the shared toolbar-btn
        // classes and re-homed under the Schedule subtab, so History and
        // Inventory no longer surface an Add control.
        expect(btn.classList.contains('wg-toolbar-btn')).toBe(true);
        expect(btn.classList.contains('wg-toolbar-btn--primary')).toBe(true);
        // Dead one-offs must not coexist with the shared class.
        expect(btn.classList.contains('wg-gloss')).toBe(false);
        expect(btn.classList.contains('wg-gloss--sun')).toBe(false);
        expect(btn.classList.contains('wg-meds-subtabs-row__add')).toBe(false);
        expect(btn.classList.contains('wg-meds-add-cta')).toBe(false);
        expect(btn.classList.contains('wg-fab')).toBe(false);
        expect(btn.classList.contains('btn-fab')).toBe(false);
        // The Add pill is now scoped to the Schedule subtab — it must sit
        // inside #med-schedule-tab and NOT inside the subtabs row above.
        const row = document.getElementById('med-subtabs');
        expect(row.contains(btn)).toBe(false);
        const scheduleTab = document.getElementById('med-schedule-tab');
        expect(scheduleTab.contains(btn)).toBe(true);
        // It lives in a dedicated header wrapper above the med-list.
        const header = scheduleTab.querySelector('.wg-meds-schedule-header');
        expect(header).not.toBeNull();
        expect(header.contains(btn)).toBe(true);

        const label = btn.querySelector('.wg-toolbar-btn__label');
        expect(label).not.toBeNull();
        expect(label.textContent.trim()).toBe('Add');
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
        const headers = Array.from(list.querySelectorAll('.wg-section-label'))
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
        const headers = Array.from(list.querySelectorAll('.wg-section-label'))
            .map((h) => h.textContent.trim());
        // The forecast answered (with nothing), so the Upcoming block renders
        // its empty state below the buckets — bd med-jr1e.
        expect(headers).toEqual(['Scheduled', 'Upcoming']);
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
        const headers = Array.from(list.querySelectorAll('.wg-section-label'))
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
        const headers = list.querySelectorAll('.wg-section-label');
        expect(headers.length).toBe(1);
        const rows = list.querySelectorAll('.wg-meds-row');
        expect(rows.length).toBe(1);
    });
});

// bd med-gut.2 — read-only "Upcoming" forecast under the hour buckets: the
// next 7 days of doses grouped by day in the TRACKED timezone, with tz-plan
// steps labelled and their explanatory note surfaced.
describe('Meds schedule sub-tab — Upcoming forecast (bd med-gut.2)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

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

        await seedMedications(window, [med], [
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

        const wrap = document.querySelector('.wg-meds-upcoming');
        expect(wrap).not.toBeNull();
        const label = wrap.querySelector('.wg-section-label');
        expect(label.textContent.trim()).toBe('Upcoming');

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

        await seedMedications(window, [med], [
            upcomingDose({
                id: 1, name: 'Metformin', dosage: '500mg', at,
                localDate: '2026-08-16', localTime: '05:00', dayOffset: 0,
                step: { number: 1, total: 2, note }
            })
        ]);

        const row = document.querySelector('.wg-meds-upcoming__row');
        expect(row.classList.contains('wg-meds-upcoming__row--step')).toBe(true);
        const badge = row.querySelector('.wg-meds-upcoming__badge');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-tag')).toBe(true);
        expect(badge.classList.contains('wg-tag--mono')).toBe(true);
        expect(badge.textContent).toBe('transition step 1/2');
        expect(row.querySelector('.wg-meds-upcoming__note').textContent).toBe(note);
    });

    // bd med-jr1e: an answered-but-empty forecast used to render nothing, which
    // was indistinguishable on screen from the feature not shipping at all.
    it('renders an honest empty state when the forecast answered with no doses', async () => {
        const { window, document } = env;
        await seedMedications(window, [med], []);

        const wrap = document.querySelector('.wg-meds-upcoming');
        expect(wrap).not.toBeNull();
        expect(wrap.querySelector('.wg-section-label').textContent.trim()).toBe('Upcoming');
        const empty = wrap.querySelector('.wg-meds-upcoming__empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toBe('No scheduled doses in the next 7 days.');
        expect(wrap.querySelectorAll('.wg-meds-upcoming__row').length).toBe(0);
    });

    // bd med-jr1e: the block used to be appended after "As needed"/"Archived",
    // which pushed it below the fold on any account with archived meds.
    it('renders the Upcoming block under the hour buckets, above As needed / Archived', async () => {
        const { window, document } = env;
        const at = new Date(Date.now() + 60 * 60 * 1000);

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

        const labels = Array.from(document.querySelectorAll('#med-list .wg-section-label'))
            .map((el) => el.textContent.trim());
        expect(labels[0]).toMatch(/^\d{2}:\d{2} · in /);
        expect(labels[1]).toBe('Upcoming');
        expect(labels[2]).toBe('As needed');
        expect(labels[3]).toBe('Archived');
    });

    it('renders no Upcoming section when the forecast route is unavailable', async () => {
        const { window, document } = env;
        await seedMedications(window, [med]); // route answers null
        expect(document.querySelector('.wg-meds-upcoming')).toBeNull();
        // ...and the hour buckets still paint from the device-local fallback.
        expect(document.querySelectorAll('#med-list .wg-section-label').length).toBe(1);
    });
});
