// Wandergeek Weight history render tests (Phase 6, Task 5).
//
// Covers renderWeightLogs(logs): a `.wg-weight-history` list with day-group
// headers (`.wg-section-label`), `.wg-card` rows per log (mono weight value,
// ISO-local time), offline-pending + rejected badges as `.wg-tag--mono`
// variants, and a trailing `.wg-icon-btn` cluster (edit + delete) that
// reuses the existing `editWeightLog` / `deleteWeightLog` handlers. Also
// verifies the full-width `.wg-weight-add-cta` CTA at the bottom of the
// `#weight-view` and that the view opts into the shared `.wg-screen-stage`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSS_PATH = path.resolve(__dirname, '../../../../web/static/css/styles.css');
const INDEX_PATH = path.resolve(__dirname, '../../../../web/static/index.html');

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

describe('renderWeightLogs (Phase 6, Task 5)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('renders .wg-weight-history container classed on #weight-list', () => {
        const { document, window } = env;
        window.renderWeightLogs([]);
        const list = document.getElementById('weight-list');
        expect(list.classList.contains('wg-weight-history')).toBe(true);
        // Empty logs → container holds no group items.
        expect(list.querySelectorAll('.wg-weight-history__group').length).toBe(0);
    });

    it('groups logs into Today / Yesterday / older day buckets in descending order', () => {
        const { document, window } = env;
        const twoDaysAgo = midnight(2);
        window.renderWeightLogs([
            { id: 1, measured_at: midnight(0).toISOString(), weight: 80.2 },
            { id: 2, measured_at: midnight(1).toISOString(), weight: 80.6 },
            { id: 3, measured_at: twoDaysAgo.toISOString(), weight: 81.0 }
        ]);

        const headers = document.querySelectorAll(
            '#weight-list .wg-weight-history__group .wg-weight-history__group-label'
        );
        expect(headers.length).toBe(3);
        expect(headers[0].textContent).toBe('Today');
        expect(headers[1].textContent).toBe('Yesterday');

        // Locale-sensitive: mirror the production toLocaleDateString call shape
        // so the expectation tracks runtime locale instead of pinning ASCII.
        const dayStart = new Date(twoDaysAgo);
        dayStart.setHours(0, 0, 0, 0);
        const expectedHeader = dayStart.toLocaleDateString(undefined, {
            day: '2-digit', month: '2-digit', year: 'numeric'
        });
        expect(headers[2].textContent).toBe(expectedHeader);
    });

    it('renders one .wg-card row per log with mono weight + kg unit suffix', () => {
        const { document, window } = env;
        window.renderWeightLogs([
            { id: 42, measured_at: midnight(0).toISOString(), weight: 75.4 }
        ]);

        const row = document.querySelector('#weight-list .wg-weight-history-row');
        expect(row).not.toBeNull();
        expect(row.classList.contains('wg-card')).toBe(true);
        expect(row.getAttribute('data-weight-id')).toBe('42');

        const value = row.querySelector('.wg-weight-history-row__value');
        expect(value.classList.contains('wg-mono-display')).toBe(true);
        expect(value.querySelector('.wg-weight-history-row__weight').textContent).toBe('75.4');
        expect(value.querySelector('.wg-weight-history-row__unit').textContent).toBe('kg');
    });

    it('renders the time stamp as .wg-weight-history-row__time', () => {
        const { document, window } = env;
        window.renderWeightLogs([
            { id: 1, measured_at: midnight(0).toISOString(), weight: 70.0 }
        ]);

        const time = document.querySelector('#weight-list .wg-weight-history-row__time');
        expect(time).not.toBeNull();
        expect(time.textContent.length).toBeGreaterThan(0);
    });

    it('surfaces offline-pending logs with a .wg-tag--pending badge + row modifier', () => {
        const { document, window } = env;
        window.renderWeightLogs([
            {
                id: 'local_7', localId: 7, measured_at: midnight(0).toISOString(),
                weight: 79.5, isLocal: true
            }
        ]);

        const row = document.querySelector('#weight-list .wg-weight-history-row');
        expect(row.classList.contains('wg-weight-history-row--pending')).toBe(true);

        const badge = row.querySelector('.wg-tag--pending');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-tag')).toBe(true);
        expect(badge.classList.contains('wg-tag--mono')).toBe(true);
        expect(badge.textContent).toBe('Pending');
    });

    it('surfaces rejected logs with a .wg-tag--rejected badge + errorMessage tooltip', () => {
        const { document, window } = env;
        window.renderWeightLogs([
            {
                id: 'local_8', localId: 8, measured_at: midnight(0).toISOString(),
                weight: 79.5, isLocal: true, isRejected: true,
                errorMessage: 'HTTP 400: Bad Request'
            }
        ]);

        const row = document.querySelector('#weight-list .wg-weight-history-row');
        expect(row.classList.contains('wg-weight-history-row--rejected')).toBe(true);

        const badge = row.querySelector('.wg-tag--rejected');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('Failed');
        expect(badge.title).toBe('HTTP 400: Bad Request');

        // A rejected row does NOT also render the pending badge.
        expect(row.querySelector('.wg-tag--pending')).toBeNull();
    });

    it('renders trailing .wg-icon-btn edit + delete that invoke the existing handlers', () => {
        const { document, window } = env;
        const deleteSpy = vi.fn();
        const editSpy = vi.fn();
        window.deleteWeightLog = deleteSpy;
        window.editWeightLog = editSpy;

        window.renderWeightLogs([
            { id: 99, measured_at: midnight(0).toISOString(), weight: 82.3, notes: 'hi' }
        ]);

        const editBtn = document.querySelector('#weight-list .wg-weight-history-row__edit');
        expect(editBtn).not.toBeNull();
        expect(editBtn.classList.contains('wg-icon-btn')).toBe(true);
        expect(editBtn.querySelector('.wg-gloss')).not.toBeNull();
        expect(editBtn.querySelector('svg[data-wg-icon="pencil"]')).not.toBeNull();

        const delBtn = document.querySelector('#weight-list .wg-weight-history-row__delete');
        expect(delBtn).not.toBeNull();
        expect(delBtn.classList.contains('wg-icon-btn')).toBe(true);
        expect(delBtn.querySelector('.wg-gloss')).not.toBeNull();
        expect(delBtn.querySelector('svg[data-wg-icon="trash"]')).not.toBeNull();

        editBtn.click();
        expect(editSpy).toHaveBeenCalledTimes(1);
        // The first arg is the log object; assert id + weight round-trip.
        const firstArg = editSpy.mock.calls[0][0];
        expect(firstArg.id).toBe(99);
        expect(firstArg.weight).toBe(82.3);

        delBtn.click();
        expect(deleteSpy).toHaveBeenCalledTimes(1);
        expect(deleteSpy).toHaveBeenCalledWith('99');
    });

    it('sorts logs within a day newest-first', () => {
        const { document, window } = env;
        const morning = new Date(midnight(0));
        morning.setHours(8, 0, 0, 0);
        const evening = new Date(midnight(0));
        evening.setHours(20, 0, 0, 0);

        window.renderWeightLogs([
            { id: 'morning', measured_at: morning.toISOString(), weight: 81.0 },
            { id: 'evening', measured_at: evening.toISOString(), weight: 80.5 }
        ]);

        const rows = document.querySelectorAll('#weight-list .wg-weight-history-row');
        expect(rows[0].getAttribute('data-weight-id')).toBe('evening');
        expect(rows[1].getAttribute('data-weight-id')).toBe('morning');
    });

    it('clears previously rendered rows on re-render and preserves container class', () => {
        const { document, window } = env;
        window.renderWeightLogs([
            { id: 1, measured_at: midnight(0).toISOString(), weight: 80.0 }
        ]);
        expect(document.querySelectorAll('#weight-list .wg-weight-history-row').length).toBe(1);

        window.renderWeightLogs([]);
        expect(document.querySelectorAll('#weight-list .wg-weight-history-row').length).toBe(0);
        expect(document.getElementById('weight-list').classList.contains('wg-weight-history')).toBe(true);
    });

    it('filters to the active range (30d) so entries older than the window are dropped', () => {
        const { document, window } = env;
        // 45 logs at 24h spacing from a fixed anchor (avoids DST drift that
        // plain `new Date().setDate(-n)` would introduce). The 30d range
        // should drop entries older than the 30-day cutoff.
        const base = Date.now();
        const dayMs = 86400000;
        const dailyLogs = [];
        for (let i = 0; i < 45; i += 1) {
            dailyLogs.push({ id: i, measured_at: new Date(base - i * dayMs).toISOString(), weight: 80 + (i % 5) * 0.1 });
        }
        window.renderWeightLogs(dailyLogs, '30d');
        const dailyRows = document.querySelectorAll('#weight-list .wg-weight-history-row');
        // i=0..29 fall inside the 30d cutoff; i=30..44 are dropped.
        expect(dailyRows.length).toBe(30);

        // 105 logs at 1-hour spacing all fall inside any range; the 100-row
        // DOM cap protects the list from running away on 'all'.
        const denseLogs = [];
        for (let i = 0; i < 105; i += 1) {
            denseLogs.push({ id: `d${i}`, measured_at: new Date(base - i * 3600000).toISOString(), weight: 80.0 });
        }
        window.renderWeightLogs(denseLogs, 'all');
        const denseRows = document.querySelectorAll('#weight-list .wg-weight-history-row');
        expect(denseRows.length).toBe(100);
    });

    it('#weight-view opts into the shared .wg-screen-stage backdrop', () => {
        const { document } = env;
        const view = document.getElementById('weight-view');
        expect(view.classList.contains('wg-screen-stage')).toBe(true);
    });

    it('renders the full-width .wg-weight-add-cta at the bottom of #weight-view', () => {
        const { document } = env;
        const cta = document.getElementById('add-weight-btn');
        expect(cta).not.toBeNull();
        expect(cta.classList.contains('wg-weight-add-cta')).toBe(true);
        expect(cta.classList.contains('wg-gloss')).toBe(true);
        expect(cta.classList.contains('wg-gloss--sun')).toBe(true);
        // CTA sits AFTER the weight-list in the weight-view.
        const view = document.getElementById('weight-view');
        const children = Array.from(view.children);
        const listIdx = children.findIndex((el) => el.id === 'weight-list');
        const ctaIdx = children.findIndex((el) => el.id === 'add-weight-btn');
        expect(ctaIdx).toBeGreaterThan(listIdx);
    });

    it('index.html does NOT declare the paper-era FAB button classes on #add-weight-btn', () => {
        const html = fs.readFileSync(INDEX_PATH, 'utf8');
        const m = html.match(/<button[^>]*id="add-weight-btn"[^>]*>/);
        expect(m, 'expected #add-weight-btn declaration in index.html').not.toBeNull();
        expect(m[0]).not.toMatch(/btn-fab/);
        expect(m[0]).not.toMatch(/btn-pill/);
        expect(m[0]).toMatch(/wg-gloss--sun/);
        expect(m[0]).toMatch(/wg-weight-add-cta/);
    });

    it('styles.css registers the .wg-weight-history and .wg-weight-add-cta rules', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        expect(css).toMatch(/\.wg-weight-history\s*\{/);
        expect(css).toMatch(/\.wg-weight-history-row\s*\{/);
        expect(css).toMatch(/\.wg-weight-add-cta\s*\{/);
    });

    it('editWeightLog prefills the weight modal with the log values', () => {
        const { document, window } = env;
        const when = new Date(midnight(0));
        when.setHours(14, 30, 0, 0);
        window.editWeightLog({
            id: 7,
            measured_at: when.toISOString(),
            weight: 78.4,
            notes: 'after run'
        });
        expect(document.getElementById('weight-value').value).toBe('78.4');
        expect(document.getElementById('weight-notes').value).toBe('after run');
        const dt = document.getElementById('weight-datetime').value;
        expect(dt.startsWith(`${when.getFullYear()}-`)).toBe(true);
        expect(dt.endsWith('14:30')).toBe(true);
    });
});
