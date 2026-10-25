// Meds timeline sub-tab (kit v2 MT1 / MT5, bd med-wi09.3; actions MT3 / MT4 /
// MT6, bd med-wi09.17).
//
// One pane over GET /api/doses (the occurrence projection): Tomorrow (first
// two groups + "N more"), Today (Next / Pending / Done, with earlier days'
// pending rows under their own date) and earlier days, paged in as they
// scroll into view. Rows group by the projection's own (localDate, localTime,
// tz, state) — never the device clock. Rows act on their own occIds through
// POST /api/doses/act: Take / Skip on pending rows, a tap opens the take sheet
// (edit mode for taken / skipped), per-day bulk for earlier pending days, and
// the MT6 out-of-date reminder landing.

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
    let list = head && head.nextElementSibling;
    while (list && !list.classList.contains('wg-list')) list = list.nextElementSibling;
    return list ? Array.from(list.querySelectorAll('.wg-timeline__row')) : [];
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

// Mon 19.10 after a trip: six pending doses at two planned times, plus one
// already taken (MT4 · pile-up).
function pileUp() {
    const day = (med, time, at, state = 'due', extra = {}) => dose({ med, at, localDate: '2026-10-19', localTime: time, state, ...extra });
    return [
        day(1, '08:20', '2026-10-19T06:20:00.000Z'),
        day(2, '08:20', '2026-10-19T06:20:00.000Z'),
        day(3, '08:20', '2026-10-19T06:20:00.000Z'),
        day(2, '21:30', '2026-10-19T19:30:00.000Z'),
        day(3, '21:30', '2026-10-19T19:30:00.000Z'),
        day(4, '21:30', '2026-10-19T19:30:00.000Z'),
        day(4, '13:00', '2026-10-19T11:00:00.000Z', 'taken', { takenAt: '2026-10-19T11:02:00.000Z' }),
        dose({ med: 1, at: '2026-10-23T06:20:00.000Z', localDate: '2026-10-23', localTime: '08:20', state: 'taken', takenAt: '2026-10-23T06:24:00.000Z' }),
        dose({ med: 2, at: '2026-10-23T19:30:00.000Z', localDate: '2026-10-23', localTime: '21:30', state: 'upcoming' }),
    ];
}

const settle = () => new Promise((r) => setTimeout(r, 0));

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

    it('rows carry their occIds; upcoming rows are read-only, the rest are buttons, pending rows carry Skip / Take', async () => {
        const { document } = env;
        const fixture = normalDay();
        await load(fixture);
        const all = Array.from(document.querySelectorAll('.wg-timeline__row'));
        expect(all.length).toBeGreaterThan(0);
        all.forEach((row) => {
            expect(row.getAttribute('style')).toBeNull();
            const upcoming = row.dataset.state === 'upcoming';
            expect(row.getAttribute('role')).toBe(upcoming ? null : 'button');
            const pending = row.dataset.state === 'due' || row.dataset.state === 'snoozed';
            expect(Array.from(row.querySelectorAll('.wg-row__trail button')).map(text)).toEqual(pending ? ['Skip', 'Take'] : []);
        });
        const next = blockRows(document.querySelector('.wg-timeline__today'), 'Next')[0];
        expect(next.dataset.occIds.split(' ')).toEqual(fixture.filter((r) => r.state === 'upcoming' && r.localDate === '2026-10-23').map((r) => r.occId));
    });

    describe('actions (MT3 / MT4, bd med-wi09.17)', () => {
        async function serve(fixture, opts) {
            env.window.medications = MEDS;
            const server = serveDoses(env.window, fixture, opts);
            await env.window.loadTimeline();
            return server;
        }
        const today = () => env.document.querySelector('.wg-timeline__today');
        const modalOpen = () => !env.document.getElementById('med-confirm-modal').classList.contains('hidden');

        it('row Take flips the pending row to Done in place, before the POST resolves, on exactly its occIds', async () => {
            const fixture = normalDay();
            const server = await serve(fixture);
            const [due] = blockRows(today(), 'Pending');
            const occIds = due.dataset.occIds.split(' ');
            const release = server.hold();
            Array.from(due.querySelectorAll('button')).find((b) => text(b) === 'Take').click();
            await vi.waitFor(() => expect(server.posts).toHaveLength(1));
            expect(server.posts[0]).toEqual({ action: 'take', occ_ids: occIds });
            // Flipped while the POST is in flight — no reload.
            expect(blockRows(today(), 'Pending').map((r) => r.dataset.state)).toEqual(['snoozed']);
            expect(blockRows(today(), 'Done').some((r) => r.dataset.occIds.split(' ').includes(occIds[0]))).toBe(true);
            release();
            await settle();
            await settle();
            expect(fixture.find((r) => r.occId === occIds[0]).state).toBe('taken');
            expect(blockRows(today(), 'Pending').map((r) => r.dataset.state)).toEqual(['snoozed']);
        });

        it('row Skip on an earlier day\'s pending dose skips that dose, and a failed write rolls the row back', async () => {
            const fixture = normalDay();
            await serve(fixture, { fail: true });
            env.window.safeAlert = vi.fn();
            const [dated] = blockRows(today(), 'Thu 22.10');
            const occId = dated.dataset.occIds;
            Array.from(dated.querySelectorAll('button')).find((b) => text(b) === 'Skip').click();
            await vi.waitFor(() => expect(env.window.apiCall).toHaveBeenCalledWith('/api/doses/act', 'POST', { action: 'skip', occ_ids: [occId] }));
            await settle();
            await settle();
            expect(env.document.querySelector(`.wg-timeline__row[data-occ-ids~="${occId}"]`).dataset.state).toBe('due');
            expect(env.window.safeAlert).toHaveBeenCalledWith("Couldn't update some doses. Please try again.");
        });

        it('tapping a pending row opens the take sheet (M2) on its own occIds; Take at a picked time posts that time', async () => {
            const fixture = normalDay();
            const server = await serve(fixture);
            const [dated] = blockRows(today(), 'Thu 22.10');
            dated.click();
            expect(modalOpen()).toBe(true);
            expect(env.document.getElementById('med-confirm-eyebrow').textContent).toBe('Time for meds');
            expect(env.document.getElementById('med-confirm-state').classList.contains('hidden')).toBe(true);
            expect(env.document.getElementById('med-confirm-skip-btn').classList.contains('hidden')).toBe(false);
            expect(env.document.getElementById('med-confirm-snooze-btn').classList.contains('hidden')).toBe(false);
            const input = env.document.getElementById('med-confirm-datetime');
            input.value = '2026-10-22T08:40';
            input.dispatchEvent(new env.window.Event('change'));
            await env.window.confirmSelectedMedications();
            expect(server.posts).toEqual([{ action: 'take', occ_ids: [dated.dataset.occIds], taken_at: new Date('2026-10-22T08:40').toISOString() }]);
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

        it('MT4 · pile-up: each earlier pending day gets one Mark all taken / Skip all pair, under its own day head only', async () => {
            await serve(pileUp());
            const own = env.document.querySelector('section[data-local-date="2026-10-19"]');
            expect(text(own.querySelector('.wg-section__head .wg-meta'))).toBe('6 pending');
            expect(Array.from(own.querySelectorAll('.wg-timeline__bulk button')).map(text)).toEqual(['Mark all taken', 'Skip all']);
            expect(own.querySelector('.wg-timeline__bulk .wg-btn--ghost')).not.toBeNull();
            // Today's dated subhead lists the rows but carries no second pair,
            // and a day with nothing pending gets none.
            expect(blockRows(today(), 'Mon 19.10').length).toBeGreaterThan(0);
            expect(today().querySelector('.wg-timeline__bulk')).toBeNull();
            expect(env.document.querySelectorAll('.wg-timeline__bulk')).toHaveLength(1);
        });

        it('Mark all taken writes each dose\'s planned time on only that day\'s pending occIds, and a repeat is a no-op', async () => {
            const fixture = pileUp();
            const server = await serve(fixture);
            const pendingIds = fixture.filter((r) => r.localDate === '2026-10-19' && r.state === 'due');
            const bulk = env.document.querySelector('section[data-local-date="2026-10-19"] .wg-timeline__bulk .wg-btn:not(.wg-btn--ghost)');
            bulk.click();
            await vi.waitFor(() => expect(server.posts).toHaveLength(2));
            const byTime = (at) => pendingIds.filter((r) => r.plannedAt === at).map((r) => r.occId);
            expect(server.posts).toEqual([
                { action: 'take', occ_ids: byTime('2026-10-19T06:20:00.000Z'), taken_at: '2026-10-19T06:20:00.000Z' },
                { action: 'take', occ_ids: byTime('2026-10-19T19:30:00.000Z'), taken_at: '2026-10-19T19:30:00.000Z' },
            ]);
            await settle();
            await settle();
            const own = env.document.querySelector('section[data-local-date="2026-10-19"]');
            expect(Array.from(own.querySelectorAll('.wg-timeline__row')).every((r) => r.dataset.state === 'taken')).toBe(true);
            expect(own.querySelector('.wg-timeline__bulk')).toBeNull();
            expect(fixture.find((r) => r.localTime === '13:00').takenAt).toBe('2026-10-19T11:02:00.000Z');

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
            const skipIds = fixture.filter((r) => r.localDate === '2026-10-19' && r.state === 'due').map((r) => r.occId);
            env.document.querySelector('section[data-local-date="2026-10-19"] .wg-timeline__bulk .wg-btn--ghost').click();
            const toast = await vi.waitFor(() => {
                const t = env.document.querySelector('.wg-toasts .wg-toast');
                expect(t).not.toBeNull();
                return t;
            });
            expect(server.posts).toEqual([{ action: 'skip', occ_ids: skipIds }]);
            expect(toast.classList.contains('wg-toast--ok')).toBe(true);
            expect(toast.querySelector('.wg-toast__text').firstChild.textContent).toBe('6 doses skipped');
            expect(text(toast.querySelector('.wg-toast__text small'))).toBe('Mon 19.10');
            toast.querySelector('.wg-toast__undo').click();
            await vi.waitFor(() => expect(server.posts).toHaveLength(2));
            expect(server.posts[1]).toEqual({ action: 'undo', occ_ids: skipIds });
            await settle();
            await settle();
            const own = env.document.querySelector('section[data-local-date="2026-10-19"]');
            expect(Array.from(own.querySelectorAll('.wg-timeline__row[data-state="due"]')).flatMap((r) => r.dataset.occIds.split(' ')).sort()).toEqual([...skipIds].sort());
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
        Array.from(note.querySelectorAll('button')).find((b) => text(b) === 'Dismiss').click();
        expect(document.querySelector('.wg-timeline__stale')).toBeNull();
        await window.loadTimeline();
        expect(document.querySelector('.wg-timeline__stale')).toBeNull();
    });

    // A Telegram tap drained in the background never switches section: MT6
    // waits for the next Timeline open and a toast names what was not logged.
    it('MT6 from a background drain: a scoped toast, no section switch, Open lands on the note', async () => {
        const { window, document } = env;
        window.medications = MEDS;
        serveDoses(window, normalDay());
        const toast = vi.spyOn(window, 'safeToast').mockImplementation(() => null);
        const nav = vi.spyOn(window, 'switchTab');
        const info = { medId: '3', scheduled: '2026-10-23T06:20:00.000Z', count: 1 };
        window.queueMedsReminderOutOfDate(info);

        const [msg, type, opts] = toast.mock.calls.at(-1);
        expect([msg, type, opts.action.label]).toEqual(['Telegram reminder out of date for Metformin: log it in the app.', 'info', 'Open']);
        expect(nav).not.toHaveBeenCalled();

        window.queueMedsReminderOutOfDate({ ...info, count: 2 });
        expect(toast.mock.calls.at(-1)[0]).toBe('Telegram reminder out of date for 2 medications: log them in the app.');

        opts.action.onClick();
        await vi.waitFor(() => expect(document.querySelector('#med-timeline-list .wg-timeline__stale')).not.toBeNull());
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
