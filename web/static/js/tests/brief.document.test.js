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
        vitals: { avg_sleep_minutes: 431, resting_hr: 58 },
        notes: [{ date: '2026-04-02', text: 'Dizzy after the dose <bump>' }],
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
        const html = build(briefPayload(), { charts: { bp: '<svg id="bpx"></svg>', weight: '<svg id="wx"></svg>' } });
        expect(html).toContain('<svg id="bpx">');
        expect(html).toContain('<svg id="wx">');
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
        expect(actions).toEqual(['brief-cancel-btn', 'brief-download-btn', 'brief-print-btn']);
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
        click('brief-print-btn');
        await settle();

        expect(requested).toEqual(['/api/brief?days=30&sections=meds%2Cbp%2Cweight%2Cvitals%2Cfood']);
    });

    // An empty `sections` means "the default set" to web/domain/brief.js, so
    // sending it would print exactly the sections the user just unticked.
    it('refuses to generate with no section selected instead of sending an empty list', async () => {
        env.window.DoctorBrief.open();
        doc.querySelectorAll('#brief-sections input').forEach((b) => { b.checked = false; });
        click('brief-print-btn');
        await settle();

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
        click('brief-print-btn');
        await settle();

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
        click('brief-download-btn');
        await settle();

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
        click('brief-download-btn');
        await settle();

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
        click('brief-print-btn');
        await settle();

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
        click('brief-print-btn');
        await settle();

        expect(printed.length).toBe(1);
        expect(printed[0]).toContain('<svg');
        expect(printed[0]).toContain('class="wg-bp-chart"');
        expect(printed[0]).toContain('class="wg-weight-chart"');
        // The doc restates the chart class contract with a fixed print palette,
        // because --wg-* tokens do not exist outside the app.
        expect(printed[0]).toContain('.wg-bp-chart__sys');
    });
});
