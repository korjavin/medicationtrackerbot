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

    it('drops future-dated entries from ranged views so a mistyped log does not slip into "last N days"', () => {
        const { document, window } = env;
        const dayMs = 86400000;
        const now = Date.now();
        const logs = [
            { id: 'future', measured_at: new Date(now + 2 * dayMs).toISOString(), weight: 81.0 },
            { id: 'today', measured_at: new Date(now - 1000).toISOString(), weight: 80.0 },
            { id: 'recent', measured_at: new Date(now - 3 * dayMs).toISOString(), weight: 80.4 }
        ];
        window.renderWeightLogs(logs, '7d');
        const rows = document.querySelectorAll('#weight-list .wg-weight-history-row');
        // Future-dated 'future' is dropped; 'today' and 'recent' remain.
        expect(rows.length).toBe(2);
    });

    it('filters to the active range (30d) so entries older than the window are dropped', () => {
        const { document, window } = env;
        // 45 logs at 24h spacing. Offset the base by a few seconds so the
        // boundary log (i=30) lands clearly older than the cutoff the filter
        // computes from Date.now() — otherwise a sub-ms test runtime can
        // leave the boundary log exactly at cutoff and pass the `>=` check.
        const dayMs = 86400000;
        const base = Date.now() - 5000;
        const dailyLogs = [];
        for (let i = 0; i < 45; i += 1) {
            dailyLogs.push({ id: i, measured_at: new Date(base - i * dayMs).toISOString(), weight: 80 + (i % 5) * 0.1 });
        }
        window.renderWeightLogs(dailyLogs, '30d');
        const dailyRows = document.querySelectorAll('#weight-list .wg-weight-history-row');
        // i=0..29 fall inside the 30d cutoff; i=30..44 are dropped.
        expect(dailyRows.length).toBe(30);

        // 'all' renders every entry the server returned (loadWeightLogs
        // already caps the fetch at 1000), so older rows stay editable
        // from the history list.
        const denseLogs = [];
        for (let i = 0; i < 105; i += 1) {
            denseLogs.push({ id: `d${i}`, measured_at: new Date(base - i * 3600000).toISOString(), weight: 80.0 });
        }
        window.renderWeightLogs(denseLogs, 'all');
        const denseRows = document.querySelectorAll('#weight-list .wg-weight-history-row');
        expect(denseRows.length).toBe(105);
    });

    it('#weight-view opts into the shared .wg-screen-stage backdrop', () => {
        const { document } = env;
        const view = document.getElementById('weight-view');
        expect(view.classList.contains('wg-screen-stage')).toBe(true);
    });

    it('renders the inline +Log button inside the range-toolbar row (Round-2 Task 12, defect #15)', () => {
        const { document, window } = env;
        // The button is generated by renderWeightRangeSelector, so it only
        // exists after the range selector is rendered. Seed it with the
        // default active range to mirror the real _renderWeightData path.
        window.renderWeightRangeSelector({ active: '30d' });
        const cta = document.getElementById('add-weight-btn');
        expect(cta).not.toBeNull();
        // Migrated to the shared .wg-toolbar-btn .wg-toolbar-btn--primary.
        expect(cta.classList.contains('wg-toolbar-btn')).toBe(true);
        expect(cta.classList.contains('wg-toolbar-btn--primary')).toBe(true);
        // Dead paper-era / Phase-5 one-offs must not reappear.
        expect(cta.classList.contains('wg-weight-header-row__add')).toBe(false);
        expect(cta.classList.contains('wg-gloss')).toBe(false);
        expect(cta.classList.contains('wg-gloss--sun')).toBe(false);
        expect(cta.classList.contains('wg-weight-add-cta')).toBe(false);

        // The CTA lives inside the .wg-weight-range-selector (BP-style
        // outer row: gloss-inset track + trailing primary-toolbar button).
        // The Phase-5 .wg-weight-header-row + #weight-current-card Latest
        // pane were deleted in Round-2 Task 12 (defect #15).
        const rangeRow = document.querySelector('#weight-view .wg-weight-range-selector');
        expect(rangeRow).not.toBeNull();
        expect(rangeRow.contains(cta)).toBe(true);
        expect(document.querySelector('#weight-view .wg-weight-header-row')).toBeNull();
        expect(document.querySelector('#weight-view #weight-current-card')).toBeNull();
    });

    it('index.html does NOT declare the paper-era FAB or Phase-5 header-row classes on #add-weight-btn', () => {
        const html = fs.readFileSync(INDEX_PATH, 'utf8');
        // Round-2 Task 12: #add-weight-btn is generated at runtime by
        // renderWeightRangeSelector (mirrors #add-bp-btn), so index.html
        // must not declare a static button element for it anymore.
        expect(html).not.toMatch(/id="add-weight-btn"/);
        // And the Phase-5 .wg-weight-header-row wrapper must be gone too.
        expect(html).not.toMatch(/class="wg-weight-header-row"/);
        expect(html).not.toMatch(/id="weight-current-card"/);
    });

    it('styles.css keeps .wg-weight-history rules and retires the Latest-pane + header-row rules', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        expect(css).toMatch(/\.wg-weight-history\s*\{/);
        expect(css).toMatch(/\.wg-weight-history-row\s*\{/);
        // Round-2 Task 12 (defect #15): the Latest-pane + header-row rules
        // were deleted; the range-selector now owns the trailing button.
        expect(css).not.toMatch(/\.wg-weight-header-row\s*\{/);
        expect(css).not.toMatch(/\.wg-weight-header-row__add\s*\{/);
        expect(css).not.toMatch(/\.wg-weight-current-card\s*\{/);
        expect(css).not.toMatch(/\.wg-weight-trend\s*\{/);
        // Paper-era full-width CTA rule was retired in Phase 5, Task 5.
        expect(css).not.toMatch(/\.wg-weight-add-cta\s*\{/);
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
