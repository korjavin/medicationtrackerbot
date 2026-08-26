// Doctor-visit brief, presentation half (med-5k6t.2): the Today-screen modal,
// the standalone printable document it builds, and the print/download handoff
// to web/cloud/js/print-doc.js.
//
// The document is what a doctor actually reads, so the assertions here are
// about what reaches paper: only the sections the user ticked, no empty
// tables, weights in the user's own unit, and the "never left the device"
// footer. print-doc.js is imported for real (not stubbed) in the download
// case — the blob path is the one that silently produces a 0-byte file when
// it breaks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';
import { macrotask } from './helpers/settle.js';
import { downloadDoc, printDoc } from '../../../cloud/js/print-doc.js';

// The sleep chart's '30d' window is a CALENDAR filter anchored on the real
// Date.now() (wg-sleep-chart.js filterByRange), so these fixture days have to
// be relative — hardcoded ones silently fall out of range as the clock moves.
function daysAgo(n) {
    const d = new Date(Date.now() - n * 86400000);
    const p2 = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function sleepDay(n, total, hr) {
    return {
        date: daysAgo(n), total_mins: total, deep_mins: 90, light_mins: total - 150, rem_mins: 45, awake_mins: 15, heart_rate_avg: hr,
    };
}

// bd med-29gh.4. WGWorkoutChart's range filter is anchored on the real
// Date.now() too, so the ISO-Monday buckets have to be relative.
function weekStart(weeksAgo) {
    const d = new Date(Date.now() - weeksAgo * 7 * 86400000);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const p2 = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function workoutsPayload(overrides) {
    return {
        session_count: 9,
        per_week: 2.3,
        current_streak_weeks: 3,
        totals: {
            volume_kg: 12400, hard_sets: 54, easy_sets: 6, reps: 380, pr_count: 2,
        },
        weekly_activity: [
            { week: weekStart(2), completed: 3, skipped: 0 },
            { week: weekStart(1), completed: 4, skipped: 1 },
            { week: weekStart(0), completed: 2, skipped: 0 },
        ],
        top_exercises: [
            { exercise_name: 'Squat', session_count: 5 },
            { exercise_name: 'Bench press', session_count: 4 },
            { exercise_name: 'Deadlift', session_count: 2 },
            { exercise_name: 'Plank', session_count: 1 },
        ],
        ...(overrides || {}),
    };
}

function briefPayload(overrides) {
    return {
        range: {
            days: 90,
            from: '2026-03-01T09:00:00.000Z',
            to: '2026-05-30T09:00:00.000Z',
            generated_at: '2026-05-30T09:00:00.000Z',
        },
        medications: [
            {
                name: 'Lisinopril',
                dosage: '10mg',
                schedule_summary: 'daily at 08:00',
                started_at: '2026-01-04',
                adherence_pct: 92.5,
            },
        ],
        overall_adherence_pct: 92.5,
        bp: {
            count: 2,
            systolic: { avg: 128, min: 124, max: 132 },
            diastolic: { avg: 81, min: 78, max: 84 },
            pulse: { avg: 66, min: 62, max: 70 },
            goal: { target_systolic: 130, target_diastolic: 80 },
            readings: [
                { measured_at: '2026-05-01T07:00:00.000Z', systolic: 124, diastolic: 78, pulse: 62 },
                { measured_at: '2026-05-20T07:00:00.000Z', systolic: 132, diastolic: 84, pulse: 70 },
            ],
        },
        weight: {
            start: 80,
            end: 75,
            delta: -5,
            unit: 'kg',
            points: [
                { measured_at: '2026-03-02T07:00:00.000Z', weight: 80 },
                { measured_at: '2026-05-28T07:00:00.000Z', weight: 75 },
            ],
        },
        vitals: {
            avg_sleep_minutes: 431,
            resting_hr: 58,
            sleep_daily: [sleepDay(2, 420, 57), sleepDay(1, 445, 59)],
        },
        notes: [
            { id: 'n1', date: '2026-04-02', text: 'Dizzy after the dose <bump>' },
            { id: 'n2', date: '2026-04-11', text: 'Argument with my sister, slept badly' },
            { id: 'n3', date: '2026-05-04', text: 'Headache all afternoon' },
        ],
        ...(overrides || {}),
    };
}

describe('Doctor brief — printable document', () => {
    let env;
    let build;

    beforeEach(() => {
        env = loadFrontendEnv();
        build = env.window.DoctorBrief.buildBriefDocument;
    });

    afterEach(() => {
        env?.cleanup();
        env = null;
    });

    it('renders the selected sections, the range header, and the local-only footer', () => {
        const html = build(briefPayload(), {});

        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html).toContain('Doctor brief');
        expect(html).toContain('2026-03-01 — 2026-05-30');
        expect(html).toContain('last 90 days');
        expect(html).toContain('Medications');
        expect(html).toContain('Lisinopril');
        expect(html).toContain('92.5%');
        expect(html).toContain('Blood pressure');
        expect(html).toContain('Weight');
        expect(html).toContain('Vitals');
        expect(html).toContain('7h 11m');
        expect(html).toContain('Notes');
        expect(html).toContain('Generated locally by Med Tracker — this data never left the device.');
    });

    // bd med-29gh.1: an as-needed med has no schedule to be adherent to, so
    // the Adherence cell must carry a count and never a percentage — a printed
    // "100%" for a PRN med is compliance the patient never claimed.
    it('prints an as-needed medication as a count of doses, never a percentage', () => {
        const html = build(briefPayload({
            medications: [
                {
                    name: 'Lisinopril', dosage: '10mg', schedule_summary: 'daily at 08:00',
                    started_at: '2026-01-04', adherence_pct: 50, as_needed: false, times_taken: 12,
                },
                {
                    name: 'Ibuprofen', dosage: '200mg', schedule_summary: 'as needed',
                    started_at: '2026-01-04', adherence_pct: null, as_needed: true, times_taken: 5,
                },
            ],
            overall_adherence_pct: 50,
        }), {});

        expect(html).toContain('Ibuprofen');
        expect(html).toContain('taken 5 times');
        const row = html.slice(html.indexOf('Ibuprofen'));
        expect(row.slice(0, row.indexOf('</tr>'))).not.toMatch(/%/);
    });

    // bd med-29gh.2: the line under "Overall adherence" that says what the
    // percentage does not — how many doses were missed outright versus merely
    // late, and by how much.
    it('prints the adherence breakdown under the overall percentage', () => {
        const html = build(briefPayload({
            adherence_detail: { missed: 4, delayed: 7, avg_delay_minutes: 70 },
        }), {});

        expect(html).toContain('missed 4, delayed 7, average delay 1h 10m');
    });

    // fmtDuration floored the hour off the raw value and rounded only the
    // remainder, so a fractional 119.6 printed as "1h 60m". Averages are the
    // first fractional minute count any caller passes it.
    it('carries a rounded-up remainder into the hour', () => {
        const html = build(briefPayload({
            adherence_detail: { missed: 0, delayed: 3, avg_delay_minutes: 119.6 },
        }), {});

        expect(html).toContain('average delay 2h 0m');
        expect(html).not.toContain('60m');
    });

    it('omits the average-delay clause when nothing was late', () => {
        const html = build(briefPayload({
            adherence_detail: { missed: 2, delayed: 0, avg_delay_minutes: null },
        }), {});

        expect(html).toContain('missed 2, delayed 0');
        expect(html).not.toContain('average delay');
    });

    // An older brief payload (or a cached one) has no adherence_detail at all;
    // the document must print without an empty stat line rather than "— , —".
    it('prints no breakdown line when the brief carries no adherence_detail', () => {
        const html = build(briefPayload(), {});

        expect(html).toContain('Overall adherence');
        expect(html).not.toContain('missed');
    });

    it('carries no external references — it must render from the Downloads folder offline', () => {
        const html = build(briefPayload(), {
            charts: { bp: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
        });
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/<link\b/i);
        // xmlns is a namespace identifier, never fetched; everything else that
        // looks like a URL would be.
        expect(html.replace(/xmlns(:\w+)?="[^"]*"/g, '')).not.toMatch(/https?:\/\//);
    });

    it('omits a section the user did not select', () => {
        const data = briefPayload();
        delete data.food;
        delete data.workouts;
        const html = build(data, {});
        expect(html).not.toContain('Nutrition');
        expect(html).not.toContain('Workouts');
    });

    it('omits a selected-but-empty section rather than printing an empty table', () => {
        const data = briefPayload({
            weight: { start: null, end: null, delta: null, unit: 'kg', points: [] },
            notes: [],
            vitals: { avg_sleep_minutes: null, resting_hr: null },
        });
        const html = build(data, {});
        expect(html).not.toContain('<h2>Weight</h2>');
        expect(html).not.toContain('<h2>Notes</h2>');
        expect(html).not.toContain('<h2>Vitals</h2>');
        // The sections that DO have data are untouched.
        expect(html).toContain('<h2>Blood pressure</h2>');
    });

    it('says so plainly when the whole range is empty', () => {
        const html = build({ range: briefPayload().range }, {});
        expect(html).toContain('Nothing recorded in this range.');
    });

    it('escapes vault text so a note can never inject markup', () => {
        const html = build(briefPayload(), {});
        expect(html).toContain('Dizzy after the dose &lt;bump&gt;');
        expect(html).not.toContain('<bump>');
    });

    it('prints kilograms as kilograms for a kg user', () => {
        const html = build(briefPayload(), { unit: 'kg' });
        expect(html).toContain('80 kg');
        expect(html).toContain('75 kg');
        expect(html).toContain('-5 kg');
    });

    // The payload is always kg (web/domain/brief.js deliberately does no unit
    // conversion); an lb user's numbers are converted here or the doctor reads
    // a figure 2.2x off.
    it('converts to pounds for an lb user, delta included', () => {
        const html = build(briefPayload(), { unit: 'lb' });
        expect(html).toContain('176.4 lb');
        expect(html).toContain('165.3 lb');
        expect(html).toContain('-11 lb');
        expect(html).not.toContain('80 kg');
    });

    it('inlines the serialized charts it is handed', () => {
        const html = build(briefPayload(), {
            charts: { bp: '<svg id="bpx"></svg>', weight: '<svg id="wx"></svg>', sleep: '<svg id="sx"></svg>' },
        });
        expect(html).toContain('<svg id="bpx">');
        expect(html).toContain('<svg id="wx">');
        expect(html).toContain('<svg id="sx">');
    });

    // bd med-29gh.3: the sentence averages the whole range, the bars cover only
    // the last 30 days. Without the caption a doctor reads the bars as spanning
    // the range printed in the header.
    it('captions the sleep chart with the narrower window it actually spans', () => {
        const html = build(briefPayload(), { charts: { sleep: '<svg id="sx"></svg>' } });

        expect(html).toContain('<svg id="sx">');
        expect(html).toContain('Sleep chart: last 30 days shown.');
    });

    // No chart (no sleep in range, or the component handed back its empty-state
    // card) must degrade to the sentence — never a caption for bars that are
    // not there, and never an empty chart box.
    it('prints the vitals sentence alone when there is no sleep chart', () => {
        const html = build(briefPayload({ vitals: { avg_sleep_minutes: 431, resting_hr: 58, sleep_daily: [] } }), {});

        expect(html).toContain('average sleep 7h 11m');
        expect(html).not.toContain('Sleep chart: last 30 days shown.');
        expect(html).not.toContain('<div class="chart"></div>');
    });

    // bd med-29gh.4 — the Workouts section used to be one sentence.
    it('prints the workout stats table, the top three exercises, and the chart', () => {
        const html = build(briefPayload({ workouts: workoutsPayload() }), {
            charts: { workouts: '<svg id="wkx"></svg>' },
        });

        expect(html).toContain('<h2>Workouts</h2>');
        expect(html).toContain('Completed sessions');
        expect(html).toContain('>9<');
        expect(html).toContain('Sessions per week');
        expect(html).toContain('>2.3<');
        expect(html).toContain('Current streak');
        expect(html).toContain('3 weeks');
        // Top THREE, by name and session count.
        expect(html).toContain('Most trained: Squat (5 sessions), Bench press (4 sessions), Deadlift (2 sessions).');
        expect(html).not.toContain('Plank');
        expect(html).toContain('<svg id="wkx">');
        // Whole ISO weeks, and weekly_activity keeps a >=12-week span whatever
        // the range — so the first bar can start (and on a 30-day brief can
        // count) before the range in the header. Said plainly rather than as a
        // fixed span, because the buckets are sparse.
        expect(html).toContain('Activity chart: one bar per week; the first week may start before the range.');
    });

    it('never captions a chart that is not there', () => {
        const data = briefPayload({ workouts: workoutsPayload({ weekly_activity: null }) });

        expect(build(data, {})).not.toContain('Activity chart:');
    });

    // The med-45u guard, on the surface that matters: a "0 kg" row is a
    // nuisance on a screen and misinformation in a document handed to a doctor.
    it('never prints a per-exercise weight or volume', () => {
        // Workouts alone, so the weight section's own kilograms cannot mask a
        // leak here.
        const html = build({ range: briefPayload().range, workouts: workoutsPayload() }, {});

        expect(html).toContain('Most trained: Squat');
        expect(html).not.toContain('kg');
        expect(html).not.toContain('12400');
    });

    it('prints the workout numbers without a chart when the window has no weekly activity', () => {
        const html = build(briefPayload({
            workouts: workoutsPayload({ weekly_activity: null, top_exercises: null }),
        }), {});

        expect(html).toContain('<h2>Workouts</h2>');
        expect(html).toContain('Completed sessions');
        expect(html).not.toContain('Most trained');
        expect(html).not.toContain('<div class="chart"></div>');
    });

    it('omits Workouts entirely when nothing was completed in the window', () => {
        const html = build(briefPayload({
            workouts: workoutsPayload({
                session_count: 0, per_week: 0, weekly_activity: null, top_exercises: null,
            }),
        }), {});

        expect(html).not.toContain('<h2>Workouts</h2>');
    });
});

describe('Doctor brief — modal + print/download', () => {
    let env;
    let doc;
    let requested;

    beforeEach(() => {
        env = loadFrontendEnv();
        doc = env.document;
        requested = [];
        env.window.weightUnitPreference = 'kg';
        env.window.apiCall = async (url) => {
            requested.push(url);
            return briefPayload();
        };
    });

    afterEach(() => {
        vi.useRealTimers();
        env?.cleanup();
        env = null;
    });

    function click(id) {
        doc.getElementById(id).dispatchEvent(new env.window.Event('click', { bubbles: true }));
    }

    // One event-loop hop drains the whole promise chain (see helpers/settle.js).
    const settle = macrotask;

    // Notes is on by default and the fixture has notes in range, so Print and
    // Download stop at the per-note picker first (med-29gh.5); the second press
    // is the confirm. Tests that turn Notes off go straight through.
    async function generateVia(id) {
        click(id);
        await settle();
        if (!doc.getElementById('brief-notes-step').classList.contains('hidden')) {
            click(id);
            await settle();
        }
    }

    it('opens from the Today shortcut with 90 days and the default section set', () => {
        env.window.DoctorBrief.open();

        const modal = doc.getElementById('brief-modal');
        expect(modal.classList.contains('hidden')).toBe(false);
        expect(doc.querySelector('#brief-range [aria-pressed="true"]').dataset.days).toBe('90');

        const checked = Array.from(doc.querySelectorAll('#brief-sections input:checked'))
            .map((b) => b.dataset.section);
        expect(checked).toEqual(['meds', 'bp', 'weight', 'vitals', 'notes']);
    });

    it('puts Cancel left of the primary action, both in the header row', () => {
        const actions = Array.from(doc.querySelectorAll('#brief-modal .wg-health-modal__header-actions button'))
            .map((b) => b.id);
        expect(actions).toEqual(['brief-back-btn', 'brief-cancel-btn', 'brief-download-btn', 'brief-print-btn']);
        // Back only exists for the per-note step, and that step is not open yet.
        expect(doc.getElementById('brief-back-btn').classList.contains('hidden')).toBe(true);
    });

    it('Cancel closes the modal without generating anything', () => {
        env.window.DoctorBrief.open();
        click('brief-cancel-btn');
        expect(doc.getElementById('brief-modal').classList.contains('hidden')).toBe(true);
        expect(requested).toEqual([]);
    });

    it('passes the picked range and section selection through to GET /api/brief', async () => {
        env.window.DoctorBrief.open();
        doc.querySelector('#brief-range [data-days="30"]')
            .dispatchEvent(new env.window.Event('click', { bubbles: true }));
        doc.querySelector('#brief-sections input[data-section="food"]').checked = true;
        doc.querySelector('#brief-sections input[data-section="notes"]').checked = false;

        env.window.DoctorBrief.loadPrintDoc = async () => ({ downloadDoc: () => true, printDoc: () => {} });
        await generateVia('brief-print-btn');

        expect(requested).toEqual(['/api/brief?days=30&sections=meds%2Cbp%2Cweight%2Cvitals%2Cfood']);
    });

    // An empty `sections` means "the default set" to web/domain/brief.js, so
    // sending it would print exactly the sections the user just unticked.
    it('refuses to generate with no section selected instead of sending an empty list', async () => {
        env.window.DoctorBrief.open();
        doc.querySelectorAll('#brief-sections input').forEach((b) => { b.checked = false; });
        await generateVia('brief-print-btn');

        expect(requested).toEqual([]);
        expect(doc.getElementById('brief-status').textContent).toMatch(/at least one section/i);
    });

    it('prints the brief document itself, not the app chrome', async () => {
        const printed = [];
        env.window.DoctorBrief.loadPrintDoc = async () => ({
            downloadDoc: () => true,
            printDoc: (d, html, cls, css) => printed.push({ html, cls, css }),
        });
        env.window.DoctorBrief.open();
        await generateVia('brief-print-btn');

        expect(printed.length).toBe(1);
        expect(printed[0].cls).toBe('wg-brief-print-frame');
        expect(printed[0].html).toContain('Doctor brief');
        expect(printed[0].html).toContain('Lisinopril');
        // App chrome must not ride along.
        expect(printed[0].html).not.toContain('bottom-nav');
        // The print frame inherits the app origin's `style-src 'self'`, which
        // refuses the document's inline <style>; the stylesheet must ride
        // alongside so print-doc.js can adopt it, or the brief prints with no
        // layout and invisible charts.
        expect(printed[0].css).toContain('.wg-bp-chart__sys');
        expect(printed[0].html).toContain(printed[0].css);
    });

    it('downloads a self-contained .html through the real blob path', async () => {
        const urls = [];
        const clicks = [];
        // Only setTimeout: print-doc.js defers revokeObjectURL by 30s (Safari
        // cancels the download otherwise) and settle() rides setImmediate.
        vi.useFakeTimers({ toFake: ['setTimeout'] });
        vi.spyOn(globalThis.URL, 'createObjectURL').mockImplementation(() => {
            urls.push('blob:https://example.test/brief');
            return 'blob:https://example.test/brief';
        });
        vi.spyOn(globalThis.URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.spyOn(env.window.HTMLAnchorElement.prototype, 'click').mockImplementation(function onClick() {
            clicks.push({ download: this.download, href: this.href });
        });

        env.window.DoctorBrief.loadPrintDoc = async () => ({ downloadDoc, printDoc });
        env.window.DoctorBrief.open();
        await generateVia('brief-download-btn');

        expect(urls.length).toBe(1);
        expect(clicks.length).toBe(1);
        expect(clicks[0].download).toMatch(/^med-tracker-doctor-brief-\d{4}-\d{2}-\d{2}\.html$/);
        expect(clicks[0].href).toBe('blob:https://example.test/brief');
        // The anchor is cleaned up — no orphan node left in the document.
        expect(doc.querySelector('a[download]')).toBeNull();
        expect(doc.getElementById('brief-status').textContent).toMatch(/downloaded/i);
    });

    it('falls back to print when the browser refuses the download', async () => {
        const printed = [];
        env.window.DoctorBrief.loadPrintDoc = async () => ({
            downloadDoc: () => false,
            printDoc: (d, html, cls) => printed.push(cls),
        });
        env.window.DoctorBrief.open();
        await generateVia('brief-download-btn');

        expect(printed).toEqual(['wg-brief-print-frame']);
        expect(doc.getElementById('brief-status').textContent).toMatch(/print dialog/i);
    });

    it('says the brief is unavailable rather than printing a blank page when the read fails', async () => {
        // The handler logs the swallowed failure on purpose — that is the only
        // trace a user's "it just said it could not build" report leaves.
        allowConsoleNoise();
        env.window.apiCall = async () => null;
        const printed = [];
        env.window.DoctorBrief.loadPrintDoc = async () => ({
            downloadDoc: () => true,
            printDoc: () => printed.push(1),
        });
        env.window.DoctorBrief.open();
        await generateVia('brief-print-btn');

        expect(printed).toEqual([]);
        expect(doc.getElementById('brief-status').textContent).toMatch(/could not build/i);
    });

    it('inlines real deterministic SVG charts for BP and weight', async () => {
        const printed = [];
        env.window.DoctorBrief.loadPrintDoc = async () => ({
            downloadDoc: () => true,
            printDoc: (d, html) => printed.push(html),
        });
        env.window.DoctorBrief.open();
        await generateVia('brief-print-btn');

        expect(printed.length).toBe(1);
        expect(printed[0]).toContain('<svg');
        expect(printed[0]).toContain('class="wg-bp-chart"');
        expect(printed[0]).toContain('class="wg-weight-chart"');
        // bd med-29gh.3 — the sleep chart is the live WGSleepChart component
        // serialized, not a second renderer.
        expect(printed[0]).toContain('class="wg-sleep-chart"');
        expect(printed[0]).toContain('Sleep chart: last 30 days shown.');
        // The doc restates the chart class contract with a fixed print palette,
        // because --wg-* tokens do not exist outside the app.
        expect(printed[0]).toContain('.wg-bp-chart__sys');
        expect(printed[0]).toContain('.wg-sleep-chart__stage--deep');
    });

    // bd med-29gh.4 — same deal for the workout chart: the live WGWorkoutChart
    // serialized, in the 'bars' variant (discrete weeks, forced zero baseline).
    it('inlines the live workout chart as zero-baselined bars', async () => {
        env.window.apiCall = async () => briefPayload({ workouts: workoutsPayload() });
        const printed = [];
        env.window.DoctorBrief.loadPrintDoc = async () => ({
            downloadDoc: () => true,
            printDoc: (d, html) => printed.push(html),
        });
        env.window.DoctorBrief.open();
        await generateVia('brief-print-btn');

        expect(printed.length).toBe(1);
        expect(printed[0]).toContain('class="wg-workout-chart"');
        expect(printed[0]).toContain('data-workout-variant="bars"');
        // A real <rect> per week, plus the print rule that colors it.
        expect(printed[0]).toContain('class="wg-workout-chart__bar"');
        expect(printed[0]).toContain('.wg-workout-chart__bar {');
        expect(printed[0]).toContain('Most trained: Squat (5 sessions)');
    });

    // A chart that cannot draw must never cost the doctor the numbers.
    it('still prints the workout stats when the chart component is missing', async () => {
        env.window.apiCall = async () => briefPayload({ workouts: workoutsPayload() });
        delete env.window.WGWorkoutChart;
        const printed = [];
        env.window.DoctorBrief.loadPrintDoc = async () => ({
            downloadDoc: () => true,
            printDoc: (d, html) => printed.push(html),
        });
        env.window.DoctorBrief.open();
        await generateVia('brief-print-btn');

        expect(printed.length).toBe(1);
        expect(printed[0]).toContain('<h2>Workouts</h2>');
        expect(printed[0]).toContain('Most trained: Squat (5 sessions)');
        expect(printed[0]).not.toContain('class="wg-workout-chart"');
    });
});

// bd med-29gh.5 — diary notes are the most personal free text in the vault and
// the brief is the one artifact handed to another human, so the user gets to
// say which notes travel. Purely presentational: the filter runs on the brief
// already fetched, and health.brief still hands agents every note.
describe('Doctor brief — per-note include picker', () => {
    let env;
    let doc;
    let requested;
    let printed;

    beforeEach(() => {
        env = loadFrontendEnv();
        doc = env.document;
        requested = [];
        printed = [];
        env.window.weightUnitPreference = 'kg';
        env.window.apiCall = async (url) => {
            requested.push(url);
            return briefPayload();
        };
        env.window.DoctorBrief.loadPrintDoc = async () => ({
            downloadDoc: () => true,
            printDoc: (d, html) => printed.push(html),
        });
    });

    afterEach(() => {
        env?.cleanup();
        env = null;
    });

    const settle = macrotask;

    function click(id) {
        doc.getElementById(id).dispatchEvent(new env.window.Event('click', { bubbles: true }));
    }

    function boxes() {
        return Array.from(doc.querySelectorAll('#brief-notes-list input[type="checkbox"]'));
    }

    function stepOpen() {
        return !doc.getElementById('brief-notes-step').classList.contains('hidden');
    }

    async function toPicker() {
        env.window.DoctorBrief.open();
        click('brief-print-btn');
        await settle();
    }

    it('shows every note ticked, hides the range/section step, and prints nothing yet', async () => {
        await toPicker();

        expect(stepOpen()).toBe(true);
        expect(doc.getElementById('brief-options').classList.contains('hidden')).toBe(true);
        expect(doc.getElementById('brief-back-btn').classList.contains('hidden')).toBe(false);
        expect(boxes().map((b) => b.dataset.noteId)).toEqual(['n1', 'n2', 'n3']);
        expect(boxes().every((b) => b.checked)).toBe(true);
        expect(doc.getElementById('brief-notes-all').checked).toBe(true);
        // The picker is a preview of a read already made — one fetch, no second
        // trip, so nothing can change under the user between tick and print.
        expect(requested.length).toBe(1);
        expect(printed).toEqual([]);
    });

    it('keeps only the ticked notes in the printed document', async () => {
        await toPicker();
        boxes().find((b) => b.dataset.noteId === 'n2').checked = false;

        click('brief-print-btn');
        await settle();

        expect(requested.length).toBe(1);
        expect(printed.length).toBe(1);
        expect(printed[0]).toContain('Dizzy after the dose');
        expect(printed[0]).toContain('Headache all afternoon');
        expect(printed[0]).not.toContain('Argument with my sister');
    });

    it('drops the Notes section entirely when nothing is ticked', async () => {
        await toPicker();
        doc.getElementById('brief-notes-all').checked = false;
        doc.getElementById('brief-notes-all')
            .dispatchEvent(new env.window.Event('change', { bubbles: true }));

        expect(boxes().every((b) => !b.checked)).toBe(true);

        click('brief-print-btn');
        await settle();

        expect(printed[0]).not.toContain('<h2>Notes</h2>');
        // The rest of the brief is untouched.
        expect(printed[0]).toContain('Lisinopril');
    });

    it('re-ticks everything from the All toggle, and unticks the toggle when one note goes', async () => {
        await toPicker();
        const all = doc.getElementById('brief-notes-all');

        all.checked = false;
        all.dispatchEvent(new env.window.Event('change', { bubbles: true }));
        all.checked = true;
        all.dispatchEvent(new env.window.Event('change', { bubbles: true }));
        expect(boxes().every((b) => b.checked)).toBe(true);

        const one = boxes()[0];
        one.checked = false;
        one.dispatchEvent(new env.window.Event('change', { bubbles: true }));
        expect(all.checked).toBe(false);
    });

    it('Back returns to the range/section step and keeps the ticks for the next pass', async () => {
        await toPicker();
        boxes().find((b) => b.dataset.noteId === 'n3').checked = false;

        click('brief-back-btn');
        expect(stepOpen()).toBe(false);
        expect(doc.getElementById('brief-options').classList.contains('hidden')).toBe(false);
        expect(doc.getElementById('brief-back-btn').classList.contains('hidden')).toBe(true);

        // Back drops the held payload, so this re-reads the (possibly re-ranged)
        // brief — but the note the user dropped stays dropped.
        click('brief-print-btn');
        await settle();

        expect(requested.length).toBe(2);
        expect(stepOpen()).toBe(true);
        expect(boxes().map((b) => b.checked)).toEqual([true, true, false]);
    });

    it('skips the step when the range holds no notes', async () => {
        env.window.apiCall = async (url) => {
            requested.push(url);
            return briefPayload({ notes: [] });
        };

        await toPicker();

        expect(stepOpen()).toBe(false);
        expect(printed.length).toBe(1);
    });

    it('skips the step when Notes is not among the selected sections', async () => {
        env.window.DoctorBrief.open();
        doc.querySelector('#brief-sections input[data-section="notes"]').checked = false;

        click('brief-print-btn');
        await settle();

        expect(stepOpen()).toBe(false);
        expect(printed.length).toBe(1);
        expect(requested[0]).not.toContain('notes');
    });

    it('reopening the modal starts back at the range/section step', async () => {
        await toPicker();
        expect(stepOpen()).toBe(true);

        env.window.DoctorBrief.close();
        env.window.DoctorBrief.open();

        expect(stepOpen()).toBe(false);
        expect(doc.getElementById('brief-options').classList.contains('hidden')).toBe(false);
    });
});
