// Meds timeline sub-tab (kit v2 TL1–TL4, bd med-ry7b; actions MT3 / MT4 /
// MT6, bd med-wi09.17).
//
// One pane in time order over GET /api/doses (the occurrence projection): the
// future on top ("Show 3 more days ahead", then one folded "Planned" row per
// day), Today led by the focus card (one pending dose — the latest of every
// pending dose, from a pending-only read — plus the next dose due today), and
// History (Yesterday + the day before, "Show 3 earlier days"). Paging is local
// and instant; each visit starts short and opens at the top. Rows group by the
// projection's own (localDate, localTime, tz, state) — never the device clock.
// Rows act on their own occIds through POST /api/doses/act.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

// Fri 23.10.2026 12:49 UTC = 14:49 in Berlin (CEST), 08:49 in New York (EDT).
const NOW = Date.UTC(2026, 9, 23, 12, 49);
const DAY = 86400000;

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

// A Berlin (UTC+2 in October) dose on `ymd` at `hm`.
function berlin(med, ymd, hm, state, extra = {}) {
    const [h, m] = hm.split(':').map(Number);
    const [y, mo, d] = ymd.split('-').map(Number);
    const at = new Date(Date.UTC(y, mo - 1, d, h - 2, m)).toISOString();
    return dose({ med, at, localDate: ymd, localTime: hm, state, ...extra });
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

// One taken 08:20 dose a day for `n` days back, plus planned 08:20 + 21:30
// for `ahead` days forward.
function longRange({ back = 12, ahead = 8 } = {}) {
    const rows = [];
    const ymd = (offset) => new Date(Date.UTC(2026, 9, 23) + offset * DAY).toISOString().slice(0, 10);
    for (let i = back; i >= 1; i--) rows.push(berlin(1, ymd(-i), '08:20', 'taken', { takenAt: `${ymd(-i)}T06:25:00.000Z` }));
    rows.push(berlin(1, ymd(0), '08:20', 'taken', { takenAt: `${ymd(0)}T06:25:00.000Z` }));
    for (let i = 1; i <= ahead; i++) {
        rows.push(berlin(1, ymd(i), '08:20', 'upcoming'), berlin(2, ymd(i), '21:30', 'upcoming'));
    }
    return rows;
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const sections = (document) => Array.from(document.querySelectorAll('#med-timeline-list > section'));
const labels = (section) => Array.from(section.querySelectorAll(':scope > .wg-section__head .wg-label')).map(text);
const historyDays = (document) => Array.from(document.querySelectorAll('#med-timeline-list > section.wg-timeline__day:not(.wg-timeline__today)')).map((s) => s.dataset.localDate);
const plannedDays = (document) => Array.from(document.querySelectorAll('.wg-timeline__future .wg-tl-day')).map((r) => r.dataset.localDate);
const card = (document) => document.querySelector('.wg-timeline__today .wg-tl-focus');
const button = (root, label) => Array.from(root.querySelectorAll('button')).find((b) => text(b) === label);
// The rows of the list that follows the block label `label` inside `section`.
function blockRows(section, label) {
    const head = Array.from(section.querySelectorAll(':scope > .wg-section__head'))
        .find((h) => text(h.querySelector('.wg-label')) === label || text(h).startsWith(label));
    let list = head && head.nextElementSibling;
    while (list && !list.classList.contains('wg-list')) list = list.nextElementSibling;
    return list ? Array.from(list.querySelectorAll('.wg-timeline__row')) : [];
}

// GET /api/doses as the domain answers it: from/to bound the rows (by planned
// instant) and status keeps only those states. `reads` logs every GET path.
function serveRange(window, rows) {
    const reads = [];
    window.apiCall = vi.fn(async (path) => {
        if (!String(path).startsWith('/api/doses')) return null;
        reads.push(path);
        const p = new URL(path, 'https://x.test').searchParams;
        const from = Date.parse(p.get('from') || '') || -Infinity;
        const to = Date.parse(p.get('to') || '') || Infinity;
        const states = (p.get('status') || '').split(',').filter(Boolean);
        return rows
            .filter((r) => Date.parse(r.plannedAt) >= from && Date.parse(r.plannedAt) <= to)
            .filter((r) => !states.length || states.includes(r.state))
            .map((r) => ({ ...r }));
    });
    return reads;
}

// A stateful GET /api/doses + POST /api/doses/act over `rows`, as
// web/domain/medintake.js answers: a dose already in the target state is
// `unchanged`. `hold` keeps the next POST in flight until released.
function serveDoses(window, rows, { fail = false } = {}) {
    const posts = [];
    let hold = null;
    window.apiCall = vi.fn(async (path, method, body) => {
        if (method === 'POST' && path === '/api/doses/act') {
            posts.push(body);
            if (hold) await hold.promise;
            if (fail) return { updated: 0, unchanged: 0, failed: body.occ_ids.length, failures: body.occ_ids.map((id) => ({ id, reason: 'not_found' })) };
            const res = { updated: 0, unchanged: 0, failed: 0, failures: [] };
            const target = { take: 'taken', skip: 'skipped', undo: 'due' }[body.action];
            body.occ_ids.forEach((id) => {
                const r = rows.find((x) => x.occId === id);
                if (r.state === target) { res.unchanged++; return; }
                r.state = target;
                if (target === 'taken') r.takenAt = body.taken_at || new Date(NOW).toISOString();
                else delete r.takenAt;
                res.updated++;
            });
            return res;
        }
        return String(path).startsWith('/api/doses') ? rows.map((r) => ({ ...r })) : null;
    });
    return {
        posts,
        hold() {
            let release;
            hold = { promise: new Promise((r) => { release = r; }) };
            return () => { hold = null; release(); };
        },
    };
}

// Yesterday (Thu 22.10) after a trip: six pending doses at two planned times,
// plus one already taken (MT4 · pile-up).
function pileUp() {
    const day = (med, time, at, state = 'due', extra = {}) => dose({ med, at, localDate: '2026-10-22', localTime: time, state, ...extra });
    return [
        day(1, '08:20', '2026-10-22T06:20:00.000Z'),
        day(2, '08:20', '2026-10-22T06:20:00.000Z'),
        day(3, '08:20', '2026-10-22T06:20:00.000Z'),
        day(2, '21:30', '2026-10-22T19:30:00.000Z'),
        day(3, '21:30', '2026-10-22T19:30:00.000Z'),
        day(4, '21:30', '2026-10-22T19:30:00.000Z'),
        day(4, '13:00', '2026-10-22T11:00:00.000Z', 'taken', { takenAt: '2026-10-22T11:02:00.000Z' }),
        dose({ med: 1, at: '2026-10-23T06:20:00.000Z', localDate: '2026-10-23', localTime: '08:20', state: 'taken', takenAt: '2026-10-23T06:24:00.000Z' }),
        dose({ med: 2, at: '2026-10-23T19:30:00.000Z', localDate: '2026-10-23', localTime: '21:30', state: 'upcoming' }),
    ];
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('Meds timeline v2 (TL1–TL4)', () => {
    let env;
    let rows;

    async function load(r, { meds = MEDS, anchor = false } = {}) {
        rows = r;
        env.window.medications = meds;
        env.window.apiCall = vi.fn(async (path) => (String(path).startsWith('/api/doses') ? rows : null));
        return env.window.loadTimeline({ anchor });
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

    it('reads one display window (the shown days + a page each side) and every pending dose up to now', async () => {
        await load(normalDay());
        const paths = env.window.apiCall.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/api/doses'));
        expect(paths).toHaveLength(2);
        const win = new URL(paths.find((p) => p.includes('from=')), 'https://x.test').searchParams;
        expect(Date.parse(win.get('from'))).toBe(NOW - 6 * DAY);
        expect(Date.parse(win.get('to'))).toBe(NOW + 5 * DAY);
        const pending = new URL(paths.find((p) => p.includes('status=')), 'https://x.test').searchParams;
        expect(pending.get('status')).toBe('due,snoozed');
        expect(pending.get('from')).toBeNull();
        expect(Date.parse(pending.get('to'))).toBe(NOW);
    });

    it('TL1: time order — Show more ahead, folded future, Today, History (2 days), Show earlier', async () => {
        const { document } = env;
        await load(normalDay());
        const list = document.getElementById('med-timeline-list');
        // The very first thing on the page.
        expect(text(list.querySelector('section .wg-tl-more'))).toBe('Show 3 more days ahead');
        expect(list.firstElementChild.classList.contains('wg-timeline__future')).toBe(true);
        expect(sections(document).map((s) => s.classList.contains('wg-timeline__future') ? 'future' : s.dataset.localDate)).toEqual([
            'future', '2026-10-23', '2026-10-22', '2026-10-21',
        ]);
        expect(text(document.querySelector('.wg-timeline__today > .wg-section__head .wg-eyebrow'))).toBe('Today · Fri 23.10');
        expect(text(document.querySelector('.wg-timeline__today > .wg-section__head .wg-meta'))).toBe('14:49');
        expect(sections(document).slice(2).map((s) => text(s.querySelector('.wg-eyebrow')))).toEqual(['Yesterday · Thu 22.10', 'Wed 21.10']);
        // "Show 3 earlier days" closes the last History day.
        const last = list.lastElementChild;
        expect(text(last.lastElementChild)).toBe('Show 3 earlier days');
        expect(last.lastElementChild.classList.contains('wg-tl-more')).toBe(true);
        // No auto-load, no skeleton.
        expect(list.querySelector('.wg-skel')).toBeNull();
    });

    it('TL1 · focus card: the latest pending dose with Take as the sun, +N more pending, then the next dose due today', async () => {
        const { document } = env;
        await load(normalDay());
        const focus = card(document);
        expect(focus.classList.contains('wg-card--accent')).toBe(true);
        expect(document.querySelectorAll('#med-timeline-list .wg-card--accent')).toHaveLength(1);
        const focusLabels = Array.from(focus.querySelectorAll('.wg-tl-focus__label'));
        expect(focusLabels.map((l) => text(l.querySelector('.wg-label')))).toEqual(['Pending', 'Next today']);
        expect(text(focusLabels[0].querySelector('.wg-meta'))).toBe('+2 more pending');
        const [now, next] = focus.querySelectorAll('.wg-timeline__row');
        // Today 08:20: due and snoozed at the same instant → due wins.
        expect(now.dataset.state).toBe('due');
        expect(text(now.querySelector('.wg-row__title'))).toBe('08:20');
        expect(text(now.querySelector('.wg-row__meta').firstChild)).toBe('Allopurinol 300 mg');
        expect(text(now.querySelector('.wg-chip--pending'))).toBe('Due 6h ago');
        expect(Array.from(now.querySelectorAll('.wg-row__trail button')).map((b) => `${text(b)}${b.classList.contains('wg-btn--primary') ? '*' : ''}`)).toEqual(['Skip', 'Take*']);
        expect(text(next.querySelector('.wg-row__title'))).toBe('21:30');
        expect(text(next.querySelector('.wg-row__meta').firstChild)).toBe('Lercanidipin 10 mg · Metformin 1000 mg');
        expect(text(next.querySelector('.wg-chip--pending'))).toBe('in 6h 41m');
        const take = next.querySelector('.wg-row__trail button');
        expect(text(take)).toBe('Take 2');
        expect(take.classList.contains('wg-btn--primary') || take.classList.contains('wg-btn--ghost')).toBe(false);
    });

    it('Today below the card lists only the rest — Pending, Done — never the card\'s doses', async () => {
        const { document } = env;
        await load(normalDay());
        const today = document.querySelector('.wg-timeline__today');
        expect(labels(today)).toEqual(['Pending', 'Done']);
        const pending = blockRows(today, 'Pending');
        expect(pending.map((r) => r.dataset.state)).toEqual(['snoozed']);
        expect(text(pending[0].querySelector('.wg-chip--pending'))).toBe('Snoozed until 08:30');
        const [done] = blockRows(today, 'Done');
        expect(text(done.querySelector('.wg-row__meta'))).toContain('Lercanidipin 10 mg');
        expect(text(done.querySelector('.wg-chip--ok'))).toBe('Taken 08:24');
        // Each card dose appears exactly once on the page.
        card(document).querySelectorAll('.wg-timeline__row').forEach((row) => {
            row.dataset.occIds.split(' ').forEach((id) => {
                expect(document.querySelectorAll(`#med-timeline-list .wg-timeline__row[data-occ-ids~="${id}"]`)).toHaveLength(1);
            });
        });
    });

    it('History days summarise themselves and list newest first', async () => {
        const { document } = env;
        await load(normalDay());
        const [, , yesterday, older] = sections(document);
        expect(text(yesterday.querySelector('.wg-section__head .wg-meta'))).toBe('1 pending');
        expect(Array.from(yesterday.querySelectorAll('.wg-timeline__row')).map((r) => `${text(r.querySelector('.wg-row__title'))} ${r.dataset.state}`))
            .toEqual(['21:30 taken', '08:20 due']);
        expect(text(yesterday.querySelector('.wg-chip--ok'))).toBe('Taken 21:34');
        expect(text(older.querySelector('.wg-section__head .wg-meta'))).toBe('1 of 1 taken');
    });

    it('epic acceptance: yesterday\'s pending 20:00 is the card with a Yesterday chip, next 14:00, its day says 1 pending', async () => {
        const { document } = env;
        env.window.Date.now = () => Date.UTC(2026, 9, 23, 9, 0); // 11:00 Berlin
        const fixture = [
            berlin(1, '2026-10-22', '20:00', 'due'),
            berlin(2, '2026-10-23', '08:00', 'taken', { takenAt: '2026-10-23T06:02:00.000Z' }),
            berlin(1, '2026-10-23', '14:00', 'upcoming'),
            berlin(1, '2026-10-23', '20:00', 'upcoming'),
            berlin(2, '2026-10-24', '08:00', 'upcoming'),
            berlin(1, '2026-10-24', '20:00', 'upcoming'),
            berlin(2, '2026-10-25', '08:00', 'upcoming'),
            berlin(1, '2026-10-25', '20:00', 'upcoming'),
        ];
        await load(fixture);
        expect(plannedDays(document)).toEqual(['2026-10-24']);
        const focus = card(document);
        const [now, next] = focus.querySelectorAll('.wg-timeline__row');
        expect(now.dataset.occIds).toBe(fixture[0].occId);
        expect(text(now.querySelector('.wg-row__title'))).toBe('20:00');
        expect(text(now.querySelector('.wg-chip--pending'))).toBe('Yesterday');
        expect(now.querySelector('.wg-btn--primary')).not.toBeNull();
        // Nothing else pending: the count stays off (TL4).
        expect(focus.querySelector('.wg-tl-focus__label .wg-meta')).toBeNull();
        expect(text(next.querySelector('.wg-row__title'))).toBe('14:00');
        const today = document.querySelector('.wg-timeline__today');
        expect(labels(today)).toEqual(['Later today', 'Done']);
        expect(blockRows(today, 'Later today').map((r) => text(r.querySelector('.wg-row__title')))).toEqual(['20:00']);
        expect(blockRows(today, 'Done').map((r) => text(r.querySelector('.wg-row__title')))).toEqual(['08:00']);
        const yesterday = document.querySelector('section[data-local-date="2026-10-22"]');
        expect(text(yesterday.querySelector('.wg-section__head .wg-meta'))).toBe('1 pending');
        expect(yesterday.querySelector('.wg-timeline__row')).toBeNull();
        expect(text(document.querySelector('section[data-local-date="2026-10-21"] .wg-section__head .wg-meta'))).toBe('No doses');
    });

    it('a dose left pending 4 days ago is the card and in the count while History still shows 2 days', async () => {
        const { document } = env;
        const fixture = [
            berlin(1, '2026-10-19', '08:20', 'due'),
            berlin(2, '2026-10-20', '08:20', 'due'),
            ...longRange({ back: 3, ahead: 2 }).filter((r) => r.localDate > '2026-10-20'),
        ];
        const reads = serveRange(env.window, fixture);
        env.window.medications = MEDS;
        await env.window.loadTimeline();
        expect(reads.some((p) => p.includes('status=due,snoozed'))).toBe(true);
        expect(historyDays(document)).toEqual(['2026-10-22', '2026-10-21']);
        const focus = card(document);
        const [now] = focus.querySelectorAll('.wg-timeline__row');
        expect(now.dataset.occIds).toBe(fixture[1].occId);
        expect(text(now.querySelector('.wg-chip--pending'))).toBe('3 days ago');
        expect(text(focus.querySelector('.wg-tl-focus__label .wg-meta'))).toBe('+1 more pending');
        // Their own days are beyond the shown History.
        expect(document.querySelector('section[data-local-date="2026-10-19"], section[data-local-date="2026-10-20"]')).toBeNull();
    });

    it('TL3: nothing pending, nothing left today → All done, the next dose named, no accent, no buttons', async () => {
        const { document } = env;
        env.window.Date.now = () => Date.UTC(2026, 9, 23, 20, 5); // 22:05 Berlin
        await load([
            berlin(1, '2026-10-23', '08:20', 'taken', { takenAt: '2026-10-23T06:24:00.000Z' }),
            berlin(2, '2026-10-23', '21:30', 'taken', { takenAt: '2026-10-23T19:34:00.000Z' }),
            berlin(1, '2026-10-24', '08:20', 'upcoming'),
            berlin(2, '2026-10-24', '08:20', 'upcoming'),
            berlin(3, '2026-10-24', '08:20', 'upcoming'),
        ]);
        const focus = card(document);
        expect(focus.classList.contains('wg-tl-focus--done')).toBe(true);
        expect(focus.classList.contains('wg-card--accent')).toBe(false);
        expect(text(focus.querySelector('.wg-row__title'))).toBe('All done for today');
        expect(text(focus.querySelector('.wg-meta'))).toBe('Next: tomorrow 08:20 · 3 meds');
        expect(focus.querySelector('.wg-row__lead--ok')).not.toBeNull();
        expect(focus.querySelector('button')).toBeNull();
        expect(document.querySelector('#med-timeline-list .wg-card--accent')).toBeNull();
    });

    it('TL4 · no missed state: an old dose stays pending — no "missed" anywhere', async () => {
        const { document } = env;
        await load([berlin(1, '2026-10-22', '09:00', 'due'), berlin(1, '2026-10-23', '21:00', 'upcoming')]);
        expect(text(document.getElementById('med-timeline-list')).toLowerCase()).not.toContain('missed');
        expect(card(document).querySelector('.wg-timeline__row').dataset.state).toBe('due');
    });

    describe('folded future days (TL1 / TL2)', () => {
        it('a future day is one Planned row; a tap unfolds its planned doses without buttons, a second tap folds', async () => {
            const { document } = env;
            await load(normalDay());
            const day = () => document.querySelector('.wg-tl-day[data-local-date="2026-10-24"]');
            expect(text(day().querySelector('.wg-row__title'))).toBe('Tomorrow · Sat 24.10');
            expect(text(day().querySelector('.wg-row__meta'))).toBe('3 doses · first 08:20');
            expect(text(day().querySelector('.wg-tag'))).toBe('Planned');
            expect(day().getAttribute('aria-expanded')).toBe('false');
            expect(document.querySelectorAll('.wg-timeline__future .wg-timeline__row')).toHaveLength(0);

            day().click();
            expect(day().getAttribute('aria-expanded')).toBe('true');
            const planned = Array.from(document.querySelectorAll('.wg-timeline__future .wg-timeline__row'));
            expect(planned.map((r) => text(r.querySelector('.wg-row__title')))).toEqual(['08:20', '13:00', '21:30']);
            planned.forEach((r) => {
                expect(r.dataset.state).toBe('upcoming');
                expect(r.querySelector('button')).toBeNull();
                expect(r.querySelector('.wg-chip')).toBeNull();
                expect(r.getAttribute('role')).toBeNull();
            });
            expect(text(planned[0].querySelector('.wg-row__meta'))).toBe('Allopurinol 300 mg · Lercanidipin 10 mg');

            day().click();
            expect(day().getAttribute('aria-expanded')).toBe('false');
            expect(document.querySelectorAll('.wg-timeline__future .wg-timeline__row')).toHaveLength(0);
        });

        it('today\'s remaining doses never fold into the future block', async () => {
            const { document } = env;
            await load(normalDay());
            expect(document.querySelector('.wg-tl-day[data-local-date="2026-10-23"]')).toBeNull();
        });
    });

    describe('local paging (TL2)', () => {
        it('Show 3 more days ahead adds three folded days above at once, farthest first — no fetch wait, no spinner', async () => {
            const { document, window } = env;
            const reads = serveRange(window, longRange());
            window.medications = MEDS;
            await window.loadTimeline({ anchor: true });
            expect(plannedDays(document)).toEqual(['2026-10-24']);
            const before = reads.length;
            button(document.querySelector('.wg-timeline__future'), 'Show 3 more days ahead').click();
            // Synchronously, before any read settles.
            expect(plannedDays(document)).toEqual(['2026-10-27', '2026-10-26', '2026-10-25', '2026-10-24']);
            expect(document.querySelector('.wg-tl-day[data-local-date="2026-10-27"]').getAttribute('aria-expanded')).toBe('false');
            expect(document.querySelector('#med-timeline-list .wg-skel')).toBeNull();
            // The window then widens by a local re-read.
            await vi.waitFor(() => expect(reads.length).toBeGreaterThan(before));
            const win = new URL(reads.filter((p) => p.includes('from='))[reads.filter((p) => p.includes('from=')).length - 1], 'https://x.test').searchParams;
            expect(Date.parse(win.get('to'))).toBe(NOW + 8 * DAY);
        });

        it('Show 3 earlier days adds exactly three days below at once, again and again, without scrolling', async () => {
            const { document, window } = env;
            const scrolled = [];
            window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this); };
            const reads = serveRange(window, longRange());
            window.medications = MEDS;
            await window.loadTimeline();
            expect(historyDays(document)).toEqual(['2026-10-22', '2026-10-21']);
            button(document.getElementById('med-timeline-list').lastElementChild, 'Show 3 earlier days').click();
            expect(historyDays(document)).toEqual(['2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18']);
            expect(text(document.querySelector('section[data-local-date="2026-10-18"] .wg-section__head .wg-meta'))).toBe('1 of 1 taken');
            expect(document.querySelector('#med-timeline-list .wg-skel')).toBeNull();
            // The window widens to a page beyond the shown days.
            await vi.waitFor(() => expect(reads.some((p) => p.includes(`from=${new Date(NOW - 9 * DAY).toISOString()}`))).toBe(true));
            await settle();
            await settle();
            button(document.getElementById('med-timeline-list').lastElementChild, 'Show 3 earlier days').click();
            expect(historyDays(document)).toHaveLength(8);
            expect(document.querySelector('section[data-local-date="2026-10-15"] .wg-timeline__row')).not.toBeNull();
            // The button stays at the bottom; the page never jumps.
            expect(text(document.getElementById('med-timeline-list').lastElementChild.lastElementChild)).toBe('Show 3 earlier days');
            expect(scrolled).toHaveLength(0);
        });

        it('a revisit starts short again: default window, everything folded, opened at the top', async () => {
            const { document, window } = env;
            const scrolled = [];
            window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this); };
            serveRange(window, longRange());
            window.medications = MEDS;
            await window.loadTimeline({ anchor: true });
            expect(scrolled.map((el) => el.id)).toEqual(['meds-view']);
            button(document.querySelector('.wg-timeline__future'), 'Show 3 more days ahead').click();
            document.querySelector('.wg-tl-day[data-local-date="2026-10-24"]').click();
            button(document.getElementById('med-timeline-list').lastElementChild, 'Show 3 earlier days').click();
            await settle();
            await settle();
            expect(historyDays(document)).toHaveLength(5);

            await window.loadTimeline({ anchor: true });
            expect(historyDays(document)).toEqual(['2026-10-22', '2026-10-21']);
            expect(plannedDays(document)).toEqual(['2026-10-24']);
            expect(document.querySelector('.wg-tl-day[aria-expanded="true"]')).toBeNull();
            expect(scrolled.map((el) => el.id)).toEqual(['meds-view', 'meds-view']);
        });

        it('nothing loads by itself: no IntersectionObserver is ever registered', async () => {
            const { window } = env;
            const observers = [];
            window.IntersectionObserver = class { constructor() { observers.push(this); } observe() {} disconnect() {} };
            serveRange(window, longRange({ back: 30 }));
            window.medications = MEDS;
            await window.loadTimeline({ anchor: true });
            expect(observers).toHaveLength(0);
        });
    });

    it('a skipped dose reads Skipped in the stale tone, never as taken', async () => {
        const { document } = env;
        await load([dose({ med: 4, at: '2026-10-23T11:00:00.000Z', localDate: '2026-10-23', localTime: '13:00', state: 'skipped' })]);
        const [row] = blockRows(document.querySelector('.wg-timeline__today'), 'Done');
        expect(row.querySelector('.wg-row__lead--stale')).not.toBeNull();
        expect(text(row.querySelector('.wg-chip--stale'))).toBe('Skipped');
    });

    it('list rows carry their occIds; upcoming rows are read-only, the rest are buttons, pending rows carry Skip / Take', async () => {
        const { document } = env;
        await load(normalDay());
        document.querySelector('.wg-tl-day').click();
        const all = Array.from(document.querySelectorAll('.wg-timeline__row')).filter((r) => !r.closest('.wg-tl-focus'));
        expect(all.length).toBeGreaterThan(0);
        all.forEach((row) => {
            expect(row.getAttribute('style')).toBeNull();
            const upcoming = row.dataset.state === 'upcoming';
            expect(row.getAttribute('role')).toBe(upcoming ? null : 'button');
            const pending = row.dataset.state === 'due' || row.dataset.state === 'snoozed';
            expect(Array.from(row.querySelectorAll('.wg-row__trail button')).map(text)).toEqual(pending ? ['Skip', 'Take'] : []);
        });
        document.querySelectorAll('#med-timeline-list [style]').forEach((el) => expect(el.getAttribute('style')).toBeNull());
    });

    describe('actions (MT3 / MT4, bd med-wi09.17)', () => {
        async function serve(fixture, opts) {
            env.window.medications = MEDS;
            const server = serveDoses(env.window, fixture, opts);
            await env.window.loadTimeline();
            return server;
        }
        const today = () => env.document.querySelector('.wg-timeline__today');
        const yesterday = () => env.document.querySelector('section[data-local-date="2026-10-22"]');
        const modalOpen = () => !env.document.getElementById('med-confirm-modal').classList.contains('hidden');

        it('Take on the focus card goes through applyOptimistic, flips in place before the POST resolves, and the next pending moves up', async () => {
            const fixture = normalDay();
            const server = await serve(fixture);
            const spy = vi.spyOn(env.window.DataStore, 'applyOptimistic');
            const [focusRow] = card(env.document).querySelectorAll('.wg-timeline__row');
            const occIds = focusRow.dataset.occIds.split(' ');
            const release = server.hold();
            focusRow.querySelector('.wg-btn--primary').click();
            await vi.waitFor(() => expect(server.posts).toHaveLength(1));
            expect(server.posts[0]).toEqual({ action: 'take', occ_ids: occIds });
            expect(spy.mock.calls.map(([key]) => key)).toEqual(expect.arrayContaining(['doses_timeline', 'doses_pending']));
            // Flipped while the POST is in flight — no reload: the taken dose
            // is in Done, the snoozed 08:20 (latest left) is the card now.
            expect(blockRows(today(), 'Done').some((r) => r.dataset.occIds.split(' ').includes(occIds[0]))).toBe(true);
            const [nextUp] = card(env.document).querySelectorAll('.wg-timeline__row');
            expect(nextUp.dataset.state).toBe('snoozed');
            expect(text(card(env.document).querySelector('.wg-tl-focus__label .wg-meta'))).toBe('+1 more pending');
            release();
            await settle();
            await settle();
            expect(fixture.find((r) => r.occId === occIds[0]).state).toBe('taken');
            expect(card(env.document).querySelector('.wg-timeline__row').dataset.state).toBe('snoozed');
        });

        it('Take on "Next today" takes that dose early through the same act route', async () => {
            const fixture = normalDay();
            const server = await serve(fixture);
            const next = card(env.document).querySelectorAll('.wg-timeline__row')[1];
            const occIds = next.dataset.occIds.split(' ');
            button(next, 'Take 2').click();
            await vi.waitFor(() => expect(server.posts).toHaveLength(1));
            expect(server.posts[0]).toEqual({ action: 'take', occ_ids: occIds });
        });

        it('row Skip on a History day\'s pending dose skips that dose, and a failed write rolls the row back', async () => {
            const fixture = normalDay();
            await serve(fixture, { fail: true });
            env.window.safeAlert = vi.fn();
            const due = yesterday().querySelector('.wg-timeline__row[data-state="due"]');
            const occId = due.dataset.occIds;
            button(due, 'Skip').click();
            await vi.waitFor(() => expect(env.window.apiCall).toHaveBeenCalledWith('/api/doses/act', 'POST', { action: 'skip', occ_ids: [occId] }));
            await settle();
            await settle();
            expect(env.document.querySelector(`.wg-timeline__row[data-occ-ids~="${occId}"]`).dataset.state).toBe('due');
            expect(env.window.safeAlert).toHaveBeenCalledWith("Couldn't update some doses. Please try again.");
        });

        it('tapping a pending row opens the take sheet (M2) on its own occIds; Take at a picked time posts that time', async () => {
            const fixture = normalDay();
            const server = await serve(fixture);
            const due = yesterday().querySelector('.wg-timeline__row[data-state="due"]');
            due.click();
            expect(modalOpen()).toBe(true);
            expect(env.document.getElementById('med-confirm-eyebrow').textContent).toBe('Time for meds');
            expect(env.document.getElementById('med-confirm-state').classList.contains('hidden')).toBe(true);
            expect(env.document.getElementById('med-confirm-skip-btn').classList.contains('hidden')).toBe(false);
            expect(env.document.getElementById('med-confirm-snooze-btn').classList.contains('hidden')).toBe(false);
            const input = env.document.getElementById('med-confirm-datetime');
            input.value = '2026-10-22T08:40';
            input.dispatchEvent(new env.window.Event('change'));
            await env.window.confirmSelectedMedications();
            expect(server.posts).toEqual([{ action: 'take', occ_ids: [due.dataset.occIds], taken_at: new Date('2026-10-22T08:40').toISOString() }]);
        });

        it('tapping a taken row opens the sheet in edit mode (MT3); Not taken undoes that dose in place', async () => {
            const fixture = normalDay();
            const server = await serve(fixture);
            const [done] = blockRows(today(), 'Done');
            const occId = done.dataset.occIds;
            done.click();
            expect(modalOpen()).toBe(true);
            expect(env.document.getElementById('med-confirm-eyebrow').textContent).toBe('Edit intake');
            const seg = env.document.getElementById('med-confirm-state');
            expect(seg.classList.contains('hidden')).toBe(false);
            expect(Array.from(seg.querySelectorAll('.wg-seg__opt')).map(text)).toEqual(['Taken', 'Skipped', 'Not taken']);
            expect(text(seg.querySelector('[aria-pressed="true"]'))).toBe('Taken');
            // The time row starts at the dose's taken time.
            expect(env.document.getElementById('med-confirm-datetime').value).toBe(env.window.formatDateTimeLocalForInput('2026-10-23T06:24:00.000Z'));

            seg.querySelector('[data-dose-state="pending"]').click();
            expect(env.document.getElementById('med-confirm-time-edit').classList.contains('hidden')).toBe(true);
            const release = server.hold();
            const done$ = env.window.updateIntakeHistory();
            await vi.waitFor(() => expect(server.posts).toHaveLength(1));
            expect(server.posts[0]).toEqual({ action: 'undo', occ_ids: [occId] });
            expect(env.document.querySelector(`.wg-timeline__row[data-occ-ids~="${occId}"]`).dataset.state).toBe('due');
            release();
            await done$;
            await settle();
            expect(env.document.querySelector(`.wg-timeline__row[data-occ-ids~="${occId}"]`).dataset.state).toBe('due');
        });

        it('a skipped row edited to Taken is undone, then taken at the picked time', async () => {
            const fixture = [dose({ med: 4, at: '2026-10-23T11:00:00.000Z', localDate: '2026-10-23', localTime: '13:00', state: 'skipped' })];
            const server = await serve(fixture);
            blockRows(today(), 'Done')[0].click();
            expect(text(env.document.querySelector('#med-confirm-state [aria-pressed="true"]'))).toBe('Skipped');
            env.document.querySelector('#med-confirm-state [data-dose-state="taken"]').click();
            env.document.getElementById('med-confirm-datetime').value = '2026-10-23T13:05';
            await env.window.updateIntakeHistory();
            const at = new Date('2026-10-23T13:05').toISOString();
            expect(server.posts).toEqual([
                { action: 'undo', occ_ids: [fixture[0].occId] },
                { action: 'take', occ_ids: [fixture[0].occId], taken_at: at },
            ]);
            await settle();
            expect(blockRows(today(), 'Done')[0].dataset.state).toBe('taken');
        });

        it('MT4 · pile-up: a History day with pending doses gets one Mark all taken / Skip all pair, under its own head only', async () => {
            await serve(pileUp());
            const own = yesterday();
            expect(text(own.querySelector('.wg-section__head .wg-meta'))).toBe('6 pending');
            expect(Array.from(own.querySelectorAll('.wg-timeline__bulk button')).map(text)).toEqual(['Mark all taken', 'Skip all']);
            expect(own.querySelector('.wg-timeline__bulk .wg-btn--ghost')).not.toBeNull();
            expect(today().querySelector('.wg-timeline__bulk')).toBeNull();
            expect(env.document.querySelectorAll('.wg-timeline__bulk')).toHaveLength(1);
        });

        it('Mark all taken writes each dose\'s planned time on only that day\'s pending occIds, and a repeat is a no-op', async () => {
            const fixture = pileUp();
            const server = await serve(fixture);
            const pendingIds = fixture.filter((r) => r.localDate === '2026-10-22' && r.state === 'due');
            const bulk = yesterday().querySelector('.wg-timeline__bulk .wg-btn:not(.wg-btn--ghost)');
            bulk.click();
            await vi.waitFor(() => expect(server.posts).toHaveLength(2));
            const byTime = (at) => pendingIds.filter((r) => r.plannedAt === at).map((r) => r.occId);
            expect(server.posts).toEqual([
                { action: 'take', occ_ids: byTime('2026-10-22T06:20:00.000Z'), taken_at: '2026-10-22T06:20:00.000Z' },
                { action: 'take', occ_ids: byTime('2026-10-22T19:30:00.000Z'), taken_at: '2026-10-22T19:30:00.000Z' },
            ]);
            await settle();
            await settle();
            const own = yesterday();
            expect(Array.from(own.querySelectorAll('.wg-timeline__row')).every((r) => r.dataset.state === 'taken')).toBe(true);
            expect(own.querySelector('.wg-timeline__bulk')).toBeNull();
            expect(fixture.find((r) => r.localTime === '13:00').takenAt).toBe('2026-10-22T11:02:00.000Z');

            // The stale button again: nothing is pending, nothing is sent.
            bulk.click();
            await settle();
            expect(server.posts).toHaveLength(2);
        });

        it('bulk is confirmed by an undo toast (8 s) whose Undo restores exactly those doses to due', async () => {
            env.cleanup();
            env = loadFrontendEnv({ withSync: true });
            env.window.Date.now = () => NOW;
            env.window.loadMeds = async () => {};
            const fixture = pileUp();
            const server = await serve(fixture);
            const skipIds = fixture.filter((r) => r.localDate === '2026-10-22' && r.state === 'due').map((r) => r.occId);
            yesterday().querySelector('.wg-timeline__bulk .wg-btn--ghost').click();
            const toast = await vi.waitFor(() => {
                const t = env.document.querySelector('.wg-toasts .wg-toast');
                expect(t).not.toBeNull();
                return t;
            });
            expect(server.posts).toEqual([{ action: 'skip', occ_ids: skipIds }]);
            expect(toast.classList.contains('wg-toast--ok')).toBe(true);
            expect(toast.querySelector('.wg-toast__text').firstChild.textContent).toBe('6 doses skipped');
            expect(text(toast.querySelector('.wg-toast__text small'))).toBe('Thu 22.10');
            toast.querySelector('.wg-toast__undo').click();
            await vi.waitFor(() => expect(server.posts).toHaveLength(2));
            expect(server.posts[1]).toEqual({ action: 'undo', occ_ids: skipIds });
            await settle();
            await settle();
            // Back to due: the latest group leads the card again, the rest in its day.
            expect(Array.from(env.document.querySelectorAll('#med-timeline-list .wg-timeline__row[data-state="due"]'))
                .flatMap((r) => r.dataset.occIds.split(' ')).sort()).toEqual([...skipIds].sort());
        });
    });

    it('MT6: an out-of-date reminder lands on the timeline at the med, quoting its time + zone, nothing selected or logged', async () => {
        const { window, document } = env;
        const scrolled = [];
        window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this); };
        window.medications = MEDS;
        const server = serveDoses(window, normalDay());
        window.showMedsReminderOutOfDate({ medId: 3, scheduled: '2026-10-23T06:20:00.000Z', tz: 'America/New_York' });
        const note = await vi.waitFor(() => {
            const n = document.querySelector('#med-timeline-list .wg-note--warn.wg-timeline__stale');
            expect(n).not.toBeNull();
            return n;
        });
        expect(text(note.querySelector('.wg-note__body span'))).toBe('Reminder for 02:20 New York is out of date. Pick the dose you mean.');
        expect(document.getElementById('med-timeline-tab').classList.contains('active')).toBe(true);
        // Scrolled to Metformin's row in Today; no sheet, no write.
        await vi.waitFor(() => expect(scrolled.some((el) => el.classList.contains('wg-timeline__row'))).toBe(true));
        const target = scrolled.filter((el) => el.classList.contains('wg-timeline__row')).pop();
        expect(target.dataset.medIds.split(' ')).toContain('3');
        expect(target.dataset.state).toBe('snoozed');
        expect(target.closest('.wg-timeline__today')).not.toBeNull();
        expect(document.getElementById('med-confirm-modal').classList.contains('hidden')).toBe(true);
        expect(server.posts).toHaveLength(0);

        // Dismiss clears it, and a re-render does not bring it back.
        button(note, 'Dismiss').click();
        expect(document.querySelector('.wg-timeline__stale')).toBeNull();
        await window.loadTimeline();
        expect(document.querySelector('.wg-timeline__stale')).toBeNull();
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

        // The later New York 08:20 leads the card; Berlin's stays in Pending.
        expect(text(card(document).querySelector('.wg-row__title'))).toBe('08:20');
        const pending = blockRows(today, 'Pending');
        expect(pending.map((r) => text(r.querySelector('.wg-row__title')))).toEqual(['08:20 · Berlin']);
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

    it('shows a skeleton while the first read is in flight', async () => {
        const { document, window } = env;
        window.medications = MEDS;
        const releases = [];
        window.apiCall = vi.fn(() => new Promise((resolve) => { releases.push(resolve); }));
        const pending = window.loadTimeline();
        await vi.waitFor(() => expect(window.apiCall).toHaveBeenCalledTimes(2));
        expect(document.querySelectorAll('#med-timeline-list .wg-skel--row').length).toBeGreaterThan(0);
        releases.forEach((release) => release(normalDay()));
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
        expect(list.querySelector('.wg-tl-focus')).toBeNull();
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
