// Wandergeek BP history render tests (Phase 3, Task 5).
//
// Covers renderBPReadings(readings): a `.wg-bp-history` list with day-group
// headers (`.wg-section-label`), `.wg-card` rows per reading (mono sys/dia
// values, status tag, optional pulse tag), and a trailing `.wg-icon-btn`
// delete that reuses the existing `deleteBPReading` handler. Offline-pending
// and rejected states surface as `.wg-tag--mono` variants.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSS_PATH = path.resolve(__dirname, '../../../../web/static/css/styles.css');

function midnightToday() {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    return d;
}

function midnight(daysAgo) {
    const d = midnightToday();
    d.setDate(d.getDate() - daysAgo);
    return d;
}

describe('renderBPReadings (Phase 3, Task 5)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('renders .wg-bp-history container classed on the #bp-list element', () => {
        const { document, window } = env;
        window.renderBPReadings([]);
        const list = document.getElementById('bp-list');
        expect(list.classList.contains('wg-bp-history')).toBe(true);
        expect(list.children.length).toBe(0);
    });

    it('groups readings into Today / Yesterday / older day buckets in descending order', () => {
        const { document, window } = env;
        const twoDaysAgo = midnight(2);
        window.renderBPReadings([
            { id: 1, measured_at: midnight(0).toISOString(), systolic: 122, diastolic: 78, pulse: 64 },
            { id: 2, measured_at: midnight(1).toISOString(), systolic: 128, diastolic: 82, pulse: 66 },
            { id: 3, measured_at: twoDaysAgo.toISOString(), systolic: 135, diastolic: 84, pulse: 70 }
        ]);

        const headers = document.querySelectorAll(
            '#bp-list .wg-bp-history__group .wg-bp-history__group-label'
        );
        expect(headers.length).toBe(3);
        expect(headers[0].textContent).toBe('Today');
        expect(headers[1].textContent).toBe('Yesterday');
        // The third header is produced by `dayStart.toLocaleDateString(undefined, ...)`
        // inside bp.js, so separators, digit order, numeral script, and even the
        // calendar era depend on the runtime locale (ar-EG arabic-indic digits,
        // th-TH Buddhist year 2569, etc.). Mirror the exact production call so the
        // expectation tracks the locale rather than pinning a Gregorian ASCII shape.
        const dayStart = new Date(twoDaysAgo);
        dayStart.setHours(0, 0, 0, 0);
        const expectedHeader = dayStart.toLocaleDateString(undefined, {
            day: '2-digit', month: '2-digit', year: 'numeric'
        });
        expect(headers[2].textContent).toBe(expectedHeader);
    });

    it('renders one .wg-card reading row per reading with mono sys/dia and status tag', () => {
        const { document, window } = env;
        window.renderBPReadings([
            { id: 42, measured_at: midnight(0).toISOString(), systolic: 132, diastolic: 86, pulse: 72 }
        ]);

        const row = document.querySelector('#bp-list .wg-bp-reading-row');
        expect(row).not.toBeNull();
        expect(row.classList.contains('wg-card')).toBe(true);
        expect(row.getAttribute('data-reading-id')).toBe('42');

        const value = row.querySelector('.wg-bp-reading-row__value');
        expect(value.classList.contains('wg-mono-display')).toBe(true);
        expect(value.querySelector('.wg-bp-reading-row__sys').textContent).toBe('132');
        expect(value.querySelector('.wg-bp-reading-row__dia').textContent).toBe('/86');

        // 132/86 → highnormal per ISH classifier.
        const tag = row.querySelector('.wg-bp-status');
        expect(tag.classList.contains('wg-bp-status--highnormal')).toBe(true);
        expect(tag.classList.contains('wg-tag')).toBe(true);
    });

    it('renders a .wg-tag--mono pulse tag when pulse is present and omits it when absent', () => {
        const { document, window } = env;
        window.renderBPReadings([
            { id: 1, measured_at: midnight(0).toISOString(), systolic: 120, diastolic: 78, pulse: 68 },
            { id: 2, measured_at: midnight(0).toISOString(), systolic: 118, diastolic: 76, pulse: null }
        ]);

        const rows = document.querySelectorAll('#bp-list .wg-bp-reading-row');
        const pulseTags = Array.from(rows).map((r) => r.querySelector('.wg-bp-reading-row__pulse'));
        // Exactly one row has a pulse tag.
        expect(pulseTags.filter((t) => t !== null).length).toBe(1);
        const present = pulseTags.find((t) => t !== null);
        expect(present.classList.contains('wg-tag')).toBe(true);
        expect(present.classList.contains('wg-tag--mono')).toBe(true);
        expect(present.textContent).toBe('68 bpm');
    });

    it('maps status classes for each ISH category', () => {
        const { document, window } = env;
        window.renderBPReadings([
            { id: 1, measured_at: midnight(0).toISOString(), systolic: 115, diastolic: 75, pulse: 60 },
            { id: 2, measured_at: midnight(0).toISOString(), systolic: 132, diastolic: 86, pulse: 60 },
            { id: 3, measured_at: midnight(0).toISOString(), systolic: 145, diastolic: 92, pulse: 60 },
            { id: 4, measured_at: midnight(0).toISOString(), systolic: 170, diastolic: 105, pulse: 60 }
        ]);

        const tags = document.querySelectorAll('#bp-list .wg-bp-status');
        const classes = Array.from(tags).map((t) =>
            Array.from(t.classList).find((c) => c.startsWith('wg-bp-status--'))
        );
        // Rows render newest-first; all four rows are "today", so order matches input
        // reversed (delete semantic: Array.sort with identical timestamps is stable).
        // We just care that every status class is represented.
        expect(classes).toEqual(expect.arrayContaining([
            'wg-bp-status--normal',
            'wg-bp-status--highnormal',
            'wg-bp-status--grade1',
            'wg-bp-status--grade2'
        ]));
    });

    it('surfaces offline-pending readings with a .wg-tag--pending badge and row modifier', () => {
        const { document, window } = env;
        window.renderBPReadings([
            {
                id: 'local_7', localId: 7, measured_at: midnight(0).toISOString(),
                systolic: 124, diastolic: 80, pulse: 70, isLocal: true
            }
        ]);

        const row = document.querySelector('#bp-list .wg-bp-reading-row');
        expect(row.classList.contains('wg-bp-reading-row--pending')).toBe(true);

        const badge = row.querySelector('.wg-tag--pending');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-tag')).toBe(true);
        expect(badge.classList.contains('wg-tag--mono')).toBe(true);
        expect(badge.textContent).toBe('Pending');
    });

    it('surfaces rejected readings with a .wg-tag--rejected badge + errorMessage tooltip', () => {
        const { document, window } = env;
        window.renderBPReadings([
            {
                id: 'local_8', localId: 8, measured_at: midnight(0).toISOString(),
                systolic: 126, diastolic: 82, pulse: 70,
                isLocal: true, isRejected: true, errorMessage: 'HTTP 400: Bad Request'
            }
        ]);

        const row = document.querySelector('#bp-list .wg-bp-reading-row');
        expect(row.classList.contains('wg-bp-reading-row--rejected')).toBe(true);

        const badge = row.querySelector('.wg-tag--rejected');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('Failed');
        expect(badge.title).toBe('HTTP 400: Bad Request');

        // A rejected row does NOT also render the pending badge.
        expect(row.querySelector('.wg-tag--pending')).toBeNull();
    });

    it('renders a .wg-icon-btn trailing delete that invokes deleteBPReading with the reading id', () => {
        const { document, window } = env;
        const deleteSpy = vi.fn();
        window.deleteBPReading = deleteSpy;

        window.renderBPReadings([
            { id: 99, measured_at: midnight(0).toISOString(), systolic: 122, diastolic: 80, pulse: 70 }
        ]);

        const btn = document.querySelector('#bp-list .wg-bp-reading-row__delete');
        expect(btn).not.toBeNull();
        expect(btn.classList.contains('wg-icon-btn')).toBe(true);
        expect(btn.querySelector('.wg-gloss')).not.toBeNull();
        expect(btn.querySelector('svg[data-wg-icon="trash"]')).not.toBeNull();

        btn.click();
        expect(deleteSpy).toHaveBeenCalledTimes(1);
        expect(deleteSpy).toHaveBeenCalledWith('99');
    });

    it('sorts readings within a day newest-first', () => {
        const { document, window } = env;
        const morning = new Date(midnight(0));
        morning.setHours(8, 0, 0, 0);
        const evening = new Date(midnight(0));
        evening.setHours(20, 0, 0, 0);

        window.renderBPReadings([
            { id: 'morning', measured_at: morning.toISOString(), systolic: 118, diastolic: 76, pulse: 64 },
            { id: 'evening', measured_at: evening.toISOString(), systolic: 124, diastolic: 80, pulse: 68 }
        ]);

        const rows = document.querySelectorAll('#bp-list .wg-bp-reading-row');
        expect(rows[0].getAttribute('data-reading-id')).toBe('evening');
        expect(rows[1].getAttribute('data-reading-id')).toBe('morning');
    });

    it('clears previously rendered rows on re-render', () => {
        const { document, window } = env;
        window.renderBPReadings([
            { id: 1, measured_at: midnight(0).toISOString(), systolic: 120, diastolic: 78, pulse: 62 }
        ]);
        expect(document.querySelectorAll('#bp-list .wg-bp-reading-row').length).toBe(1);

        window.renderBPReadings([]);
        expect(document.querySelectorAll('#bp-list .wg-bp-reading-row').length).toBe(0);
        // Container class is preserved.
        expect(document.getElementById('bp-list').classList.contains('wg-bp-history')).toBe(true);
    });

    // Phase 3, Task 4 — day-group headers render on the deep-teal stage.
    // .wg-section-label uses --wg-fg-4 (42% white) which is invisible on
    // the paper-white body; #bp-view must opt into .wg-screen-stage so
    // the headers resolve against --wg-bg-stage instead.
    it('emits day-header <div> with .wg-section-label + .wg-bp-history__group-label inside the staged #bp-view', () => {
        const { document, window } = env;
        window.renderBPReadings([
            { id: 1, measured_at: midnight(0).toISOString(), systolic: 120, diastolic: 78, pulse: 62 },
            { id: 2, measured_at: midnight(1).toISOString(), systolic: 124, diastolic: 80, pulse: 64 }
        ]);

        const bpView = document.getElementById('bp-view');
        expect(bpView.classList.contains('wg-screen-stage')).toBe(true);

        const headers = bpView.querySelectorAll('.wg-bp-history__group .wg-bp-history__group-label');
        expect(headers.length).toBe(2);
        for (const h of headers) {
            expect(h.tagName).toBe('DIV');
            expect(h.classList.contains('wg-section-label')).toBe(true);
            expect(h.classList.contains('wg-bp-history__group-label')).toBe(true);
        }
    });

    it('styles.css .wg-screen-stage rule references --wg-bg-stage (not paper-white) so 42%-white labels stay legible', () => {
        // jsdom does not parse the stylesheet (index.html loads it via <link>),
        // so assert against the rule text — mirrors the pattern used in
        // architecture.wg-primitives.test.js.
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const m = css.match(/\.wg-screen-stage\s*\{([^}]+)\}/);
        expect(m, 'expected .wg-screen-stage rule in styles.css').not.toBeNull();
        expect(m[1]).toMatch(/var\(--wg-bg-stage\)/);
        expect(m[1]).not.toMatch(/var\(--wg-paper\)/);
    });
});
