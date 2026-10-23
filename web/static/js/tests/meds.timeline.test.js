// Meds timeline sub-tab (kit v2 MT1 / MT5, bd med-wi09.3).
//
// One read-only pane over GET /api/doses (the occurrence projection): Tomorrow
// (first two groups + "N more"), Today (Next / Pending / Done, with earlier
// days' pending rows under their own date) and earlier days, paged in as they
// scroll into view. Rows group by the projection's own (localDate, localTime,
// tz, state) — never the device clock — and carry no action until
// med-wi09.17.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

// Fri 23.10.2026 12:49 UTC = 14:49 in Berlin (CEST), 08:49 in New York (EDT).
const NOW = Date.UTC(2026, 9, 23, 12, 49);

const MEDS = [
    { id: 1, name: 'Allopurinol', dosage: '300 mg', schedule: '{"type":"daily","times":["08:20"]}' },
    { id: 2, name: 'Lercanidipin', dosage: '10 mg', schedule: '{"type":"daily","times":["08:20","21:30"]}' },
    { id: 3, name: 'Metformin', dosage: '1000 mg', schedule: '{"type":"daily","times":["08:20","21:30"]}' },
    { id: 4, name: 'Candecor', dosage: '16 mg', schedule: '{"type":"daily","times":["13:00"]}' },
];

let seq = 0;
// One projection row. medId as a STRING against the medications list's
// numeric ids, and no name/dosage on the row: names must still resolve
// (the med-wi09.15 keying bug).
function dose({ med, at, localDate, localTime, tz = 'Europe/Berlin', state, takenAt, snoozedUntil }) {
    const row = {
        occId: `intake-${med}-${++seq}`,
        medId: String(med),
        name: '',
        dosage: '',
        plannedAt: at,
        tz,
        localDate,
        localTime,
        source: 'schedule',
        state,
    };
    if (takenAt) row.takenAt = takenAt;
    if (snoozedUntil) row.snoozedUntil = snoozedUntil;
    return row;
}

function normalDay() {
    return [
        dose({ med: 1, at: '2026-10-21T06:20:00.000Z', localDate: '2026-10-21', localTime: '08:20', state: 'taken', takenAt: '2026-10-21T06:30:00.000Z' }),
        dose({ med: 1, at: '2026-10-22T06:20:00.000Z', localDate: '2026-10-22', localTime: '08:20', state: 'due' }),
        dose({ med: 2, at: '2026-10-22T19:30:00.000Z', localDate: '2026-10-22', localTime: '21:30', state: 'taken', takenAt: '2026-10-22T19:34:00.000Z' }),
        dose({ med: 3, at: '2026-10-22T19:30:00.000Z', localDate: '2026-10-22', localTime: '21:30', state: 'taken', takenAt: '2026-10-22T19:36:00.000Z' }),
        dose({ med: 1, at: '2026-10-23T06:20:00.000Z', localDate: '2026-10-23', localTime: '08:20', state: 'due' }),
        dose({ med: 2, at: '2026-10-23T06:20:00.000Z', localDate: '2026-10-23', localTime: '08:20', state: 'taken', takenAt: '2026-10-23T06:24:00.000Z' }),
        dose({ med: 3, at: '2026-10-23T06:20:00.000Z', localDate: '2026-10-23', localTime: '08:20', state: 'snoozed', snoozedUntil: '2026-10-23T06:30:00.000Z' }),
        dose({ med: 2, at: '2026-10-23T19:30:00.000Z', localDate: '2026-10-23', localTime: '21:30', state: 'upcoming' }),
        dose({ med: 3, at: '2026-10-23T19:30:00.000Z', localDate: '2026-10-23', localTime: '21:30', state: 'upcoming' }),
        dose({ med: 1, at: '2026-10-24T06:20:00.000Z', localDate: '2026-10-24', localTime: '08:20', state: 'upcoming' }),
        dose({ med: 2, at: '2026-10-24T06:20:00.000Z', localDate: '2026-10-24', localTime: '08:20', state: 'upcoming' }),
        dose({ med: 4, at: '2026-10-24T11:00:00.000Z', localDate: '2026-10-24', localTime: '13:00', state: 'upcoming' }),
        dose({ med: 2, at: '2026-10-24T19:30:00.000Z', localDate: '2026-10-24', localTime: '21:30', state: 'upcoming' }),
    ];
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const sections = (document) => Array.from(document.querySelectorAll('#med-timeline-list > section'));
const labels = (section) => Array.from(section.querySelectorAll('.wg-section__head .wg-label')).map(text);
// The rows of the list that follows the block label `label` inside `section`.
function blockRows(section, label) {
    const head = Array.from(section.querySelectorAll('.wg-section__head'))
        .find((h) => text(h.querySelector('.wg-label')) === label || text(h).startsWith(label));
    const list = head && head.nextElementSibling;
    return list ? Array.from(list.querySelectorAll('.wg-timeline__row')) : [];
}

describe('Meds timeline (MT1 / MT5)', () => {
    let env;
    let rows;

    async function load(r, { meds = MEDS } = {}) {
        rows = r;
        env.window.medications = meds;
        env.window.apiCall = vi.fn(async (path) => (String(path).startsWith('/api/doses') ? rows : null));
        return env.window.loadTimeline();
    }

    beforeEach(() => {
        env = loadFrontendEnv();
        env.window.Date.now = () => NOW;
        env.window.loadMeds = async () => {};
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('reads the whole ledger through tomorrow from GET /api/doses', async () => {
        await load(normalDay());
        const path = env.window.apiCall.mock.calls.find(([p]) => String(p).startsWith('/api/doses'))[0];
        const params = new URL(path, 'https://x.test').searchParams;
        expect(params.get('from')).toBe(new Date(0).toISOString());
        expect(Date.parse(params.get('to'))).toBe(NOW + 2 * 86400000);
    });

    it('MT1: Tomorrow above Today, then earlier days newest first', async () => {
        const { document } = env;
        await load(normalDay());
        expect(sections(document).map((s) => text(s.querySelector('.wg-eyebrow')))).toEqual([
            'Tomorrow · Sat 24.10',
            'Today · Fri 23.10',
            'Yesterday · Thu 22.10',
            'Wed 21.10',
        ]);
    });

    it('Tomorrow shows its first two groups and an "N more" reveal', async () => {
        const { document } = env;
        await load(normalDay());
        const tomorrow = document.querySelector('.wg-timeline__tomorrow');
        expect(Array.from(tomorrow.querySelectorAll('.wg-row__title')).map(text)).toEqual(['08:20', '13:00']);
        expect(text(tomorrow.querySelector('.wg-row__meta'))).toBe('Allopurinol 300 mg · Lercanidipin 10 mg');
        expect(tomorrow.querySelector('.wg-chip')).toBeNull();
        const more = tomorrow.querySelector('.wg-timeline__more-btn');
        expect(text(more)).toBe('1 more · 21:30');
        more.click();
        const open = document.querySelector('.wg-timeline__tomorrow');
        expect(Array.from(open.querySelectorAll('.wg-row__title')).map(text)).toEqual(['08:20', '13:00', '21:30']);
        expect(open.querySelector('.wg-timeline__more-btn')).toBeNull();
    });

    it('Today: Next, Pending (a group split from its Done half), dated earlier pending, Done', async () => {
        const { document } = env;
        await load(normalDay());
        const today = document.querySelector('.wg-timeline__today');
        expect(text(today.querySelector('.wg-section__head .wg-meta'))).toBe('14:49');
        expect(labels(today)).toEqual(['Next', 'Pending', 'Thu 22.10', 'Done']);

        const [next] = blockRows(today, 'Next');
        expect(text(next.querySelector('.wg-row__title'))).toBe('21:30');
        expect(text(next.querySelector('.wg-row__meta'))).toContain('Lercanidipin 10 mg · Metformin 1000 mg');
        expect(text(next.querySelector('.wg-chip--pending'))).toBe('in 6h 41m');

        const pending = blockRows(today, 'Pending');
        expect(pending.map((r) => r.dataset.state)).toEqual(['due', 'snoozed']);
        expect(text(pending[0].querySelector('.wg-row__meta'))).toContain('Allopurinol 300 mg');
        expect(text(pending[0].querySelector('.wg-chip--pending'))).toBe('Due 6h ago');
        expect(pending[0].querySelector('.wg-row__lead--sky')).not.toBeNull();
        expect(text(pending[1].querySelector('.wg-chip--pending'))).toBe('Snoozed until 08:30');

        const dated = blockRows(today, 'Thu 22.10');
        expect(dated).toHaveLength(1);
        expect(text(dated[0].querySelector('.wg-chip'))).toBe('Due');
        expect(text(Array.from(today.querySelectorAll('.wg-section__head')).find((h) => text(h).startsWith('Thu 22.10'))))
            .toContain('Yesterday');

        const [done] = blockRows(today, 'Done');
        expect(text(done.querySelector('.wg-row__meta'))).toContain('Lercanidipin 10 mg');
        expect(text(done.querySelector('.wg-chip--ok'))).toBe('Taken 08:24');
        expect(done.querySelector('.wg-row__lead--ok')).not.toBeNull();
    });

    it('earlier days keep their own pending rows and summarise the day', async () => {
        const { document } = env;
        await load(normalDay());
        const [, , yesterday, older] = sections(document);
        expect(text(yesterday.querySelector('.wg-section__head .wg-meta'))).toBe('1 pending');
        expect(Array.from(yesterday.querySelectorAll('.wg-timeline__row')).map((r) => `${text(r.querySelector('.wg-row__title'))} ${r.dataset.state}`))
            .toEqual(['21:30 taken', '08:20 due']);
        expect(text(yesterday.querySelector('.wg-chip--ok'))).toBe('Taken 21:34');
        expect(text(older.querySelector('.wg-section__head .wg-meta'))).toBe('1 of 1 taken');
    });

    it('a skipped dose reads Skipped in the stale tone, never as taken', async () => {
        const { document } = env;
        await load([dose({ med: 4, at: '2026-10-23T11:00:00.000Z', localDate: '2026-10-23', localTime: '13:00', state: 'skipped' })]);
        const [row] = blockRows(document.querySelector('.wg-timeline__today'), 'Done');
        expect(row.querySelector('.wg-row__lead--stale')).not.toBeNull();
        expect(text(row.querySelector('.wg-chip--stale'))).toBe('Skipped');
    });

    it('rows carry their occIds and no action affordance (read-only until med-wi09.17)', async () => {
        const { document } = env;
        const fixture = normalDay();
        await load(fixture);
        const all = Array.from(document.querySelectorAll('.wg-timeline__row'));
        expect(all.length).toBeGreaterThan(0);
        all.forEach((row) => {
            expect(row.getAttribute('role')).toBeNull();
            expect(row.getAttribute('tabindex')).toBeNull();
            expect(row.querySelector('button')).toBeNull();
            expect(row.getAttribute('style')).toBeNull();
        });
        const next = blockRows(document.querySelector('.wg-timeline__today'), 'Next')[0];
        expect(next.dataset.occIds.split(' ')).toEqual(fixture.filter((r) => r.state === 'upcoming' && r.localDate === '2026-10-23').map((r) => r.occId));
    });

    it('after a zone change rows keep their own date, and the same local time in two zones never merges', async () => {
        const { document } = env;
        const ny = 'America/New_York';
        // 02:00Z on the 23rd is 22:00 on the 22nd in New York: the device's UTC
        // calendar would call it the 23rd, the projection says the 22nd.
        await load([
            dose({ med: 1, at: '2026-10-23T02:00:00.000Z', localDate: '2026-10-22', localTime: '22:00', tz: ny, state: 'taken', takenAt: '2026-10-23T02:05:00.000Z' }),
            dose({ med: 1, at: '2026-10-23T06:20:00.000Z', localDate: '2026-10-23', localTime: '08:20', tz: 'Europe/Berlin', state: 'due' }),
            dose({ med: 2, at: '2026-10-23T12:20:00.000Z', localDate: '2026-10-23', localTime: '08:20', tz: ny, state: 'due' }),
            dose({ med: 2, at: '2026-10-24T12:20:00.000Z', localDate: '2026-10-24', localTime: '08:20', tz: ny, state: 'upcoming' }),
        ]);
        const today = document.querySelector('.wg-timeline__today');
        expect(today.dataset.localDate).toBe('2026-10-23');
        const yesterday = document.querySelector('section[data-local-date="2026-10-22"]');
        expect(text(yesterday.querySelector('.wg-eyebrow'))).toBe('Yesterday · Thu 22.10');
        expect(text(yesterday.querySelector('.wg-row__title'))).toBe('22:00');
        expect(text(yesterday.querySelector('.wg-chip--ok'))).toBe('Taken 22:05');

        const pending = blockRows(today, 'Pending');
        expect(pending.map((r) => text(r.querySelector('.wg-row__title')))).toEqual(['08:20 · Berlin', '08:20']);
        expect(text(pending[0].querySelector('.wg-row__meta'))).toContain('02:20 here · Allopurinol 300 mg');

        const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const note = today.querySelector('.wg-note--info.wg-timeline__zone');
        expect(Boolean(note)).toBe(device !== ny);
        if (note) expect(text(note)).toBe('Times are New York time.');
    });

    it('no zone note while the device sits in the tracked zone', async () => {
        const { document } = env;
        const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
        await load([dose({ med: 1, at: '2026-10-23T20:00:00.000Z', localDate: '2026-10-23', localTime: '20:00', tz: device, state: 'upcoming' })]);
        expect(document.querySelector('.wg-timeline__zone')).toBeNull();
    });

    it('earlier days page in as the skeleton day head scrolls into view (MT5 · loading)', async () => {
        const { document, window } = env;
        const observers = [];
        window.IntersectionObserver = class {
            constructor(cb) { this.cb = cb; this.targets = []; observers.push(this); }
            observe(el) { this.targets.push(el); }
            disconnect() { this.targets = []; }
        };
        const past = [];
        for (let i = 1; i <= 20; i++) {
            const day = new Date(Date.UTC(2026, 9, 23 - i));
            const ymd = day.toISOString().slice(0, 10);
            past.push(dose({ med: 1, at: `${ymd}T06:20:00.000Z`, localDate: ymd, localTime: '08:20', state: 'taken', takenAt: `${ymd}T06:25:00.000Z` }));
        }
        await load(past);
        const pastDays = () => document.querySelectorAll('#med-timeline-list > section.wg-timeline__day:not(.wg-timeline__today)').length;
        const sentinel = () => document.querySelector('.wg-timeline__more');

        expect(pastDays()).toBe(7);
        expect(sentinel().querySelectorAll('.wg-skel--row')).toHaveLength(2);
        expect(text(sentinel().querySelector('.wg-section__head .wg-eyebrow'))).toBe('Thu 15.10');
        expect(text(sentinel().querySelector('.wg-section__head .wg-meta'))).toBe('loading');

        const scrollInto = () => {
            const obs = observers[observers.length - 1];
            obs.cb(obs.targets.map((target) => ({ target, isIntersecting: true })));
        };
        scrollInto();
        expect(pastDays()).toBe(14);
        scrollInto();
        expect(pastDays()).toBe(20);
        expect(sentinel()).toBeNull();
        // Oldest last.
        expect(document.querySelector('#med-timeline-list > section:last-child').dataset.localDate).toBe('2026-10-03');
    });

    it('shows a skeleton while the first read is in flight', async () => {
        const { document, window } = env;
        window.medications = MEDS;
        let release;
        window.apiCall = vi.fn(() => new Promise((resolve) => { release = resolve; }));
        const pending = window.loadTimeline();
        await vi.waitFor(() => expect(window.apiCall).toHaveBeenCalled());
        expect(document.querySelectorAll('#med-timeline-list .wg-skel--row').length).toBeGreaterThan(0);
        release(normalDay());
        await pending;
        expect(document.querySelector('#med-timeline-list .wg-skel--row')).toBeNull();
    });

    it('MT5 · empty: no medications → the empty state owns the one Add', async () => {
        const { document } = env;
        await load([], { meds: [] });
        const list = document.getElementById('med-timeline-list');
        expect(list.querySelector('.wg-card--flush .wg-empty')).not.toBeNull();
        expect(text(list.querySelector('.wg-empty__title'))).toBe('No medications yet');
        expect(list.querySelector('.wg-empty .wg-btn--primary')).not.toBeNull();
        expect(list.querySelector('.wg-section')).toBeNull();
        expect(document.getElementById('add-btn').hidden).toBe(true);
    });

    it('a route that does not answer leaves no blank pane', async () => {
        const { document, window } = env;
        window.medications = MEDS;
        window.apiCall = vi.fn(async () => null);
        expect(await window.loadTimeline()).toBeNull();
        expect(document.querySelector('#med-timeline-list .wg-empty')).not.toBeNull();
    });
});
