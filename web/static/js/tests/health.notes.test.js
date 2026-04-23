// Wandergeek Health Notes sub-tab render tests (Phase 8, Task 7).
//
// Covers renderNotes / appendNotes: a `.wg-health-notes__list` ul with
// day-group headers (`.wg-section-label`), `.wg-card` rows per note (mono
// timestamp + body), offline-pending + rejected badges as `.wg-tag--mono`
// variants, trailing `.wg-icon-btn` cluster (edit + delete) wiring through
// `editNote(note)` / `deleteNote(id)`, the full-width `.wg-gloss` "Load more"
// pagination footer at exactly NOTES_PAGE_SIZE rows, and the empty-state
// `.wg-card` placeholder. Also pins the new compose markup
// (`.wg-gloss--inset` textarea wrap + `.wg-gloss--sun` Save CTA) in
// index.html so the paper-era classes don't sneak back.

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

describe('Health Notes render (Phase 8, Task 7)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders the empty-state card when no notes exist', () => {
        const { document, window } = env;
        const list = document.getElementById('notes-list');
        window.renderNotes(list, []);

        const empty = list.querySelector('.wg-health-notes__empty');
        expect(empty).not.toBeNull();
        expect(empty.classList.contains('wg-card')).toBe(true);
        expect(empty.textContent).toMatch(/No notes yet/i);
        // No day-group items mixed in.
        expect(list.querySelectorAll('.wg-health-notes__group').length).toBe(0);
    });

    it('groups notes by day with date+weekday headers in source order', () => {
        const { document, window } = env;
        const list = document.getElementById('notes-list');
        const todayMs = midnight(0).getTime();
        const yesterdayMs = midnight(1).getTime();
        const olderMs = midnight(3).getTime();
        window.renderNotes(list, [
            { id: 1, created_at: new Date(todayMs).toISOString(), content: 't1' },
            { id: 2, created_at: new Date(todayMs + 1000).toISOString(), content: 't2' },
            { id: 3, created_at: new Date(yesterdayMs).toISOString(), content: 'y1' },
            { id: 4, created_at: new Date(olderMs).toISOString(), content: 'o1' }
        ]);

        const groups = list.querySelectorAll('.wg-health-notes__group');
        expect(groups.length).toBe(3);

        const headers = list.querySelectorAll('.wg-health-notes__group-label');
        // Date prefix (DD.MM.YYYY style — locale-sensitive) + middle dot + weekday name.
        expect(headers[0].textContent).toMatch(/\u00B7\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
        expect(headers[1].textContent).toMatch(/\u00B7\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
        expect(headers[2].textContent).toMatch(/\u00B7\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);

        const todayRows = groups[0].querySelectorAll('.wg-health-notes-row');
        expect(todayRows.length).toBe(2);
        const yesterdayRows = groups[1].querySelectorAll('.wg-health-notes-row');
        expect(yesterdayRows.length).toBe(1);
        const olderRows = groups[2].querySelectorAll('.wg-health-notes-row');
        expect(olderRows.length).toBe(1);
    });

    it('renders each note as a .wg-card row with mono time + body', () => {
        const { document, window } = env;
        const list = document.getElementById('notes-list');
        const when = new Date(midnight(0));
        when.setHours(14, 30, 0, 0);
        window.renderNotes(list, [
            { id: 42, created_at: when.toISOString(), content: 'felt good after run' }
        ]);

        const row = list.querySelector('.wg-health-notes-row');
        expect(row).not.toBeNull();
        expect(row.classList.contains('wg-card')).toBe(true);
        expect(row.getAttribute('data-note-id')).toBe('42');

        const time = row.querySelector('.wg-health-notes-row__time');
        expect(time).not.toBeNull();
        expect(time.classList.contains('wg-mono-display')).toBe(true);
        expect(time.textContent.length).toBeGreaterThan(0);

        const body = row.querySelector('.wg-health-notes-row__content');
        expect(body).not.toBeNull();
        expect(body.textContent).toBe('felt good after run');
    });

    it('surfaces offline-pending notes with a .wg-tag--pending badge + row modifier', () => {
        const { document, window } = env;
        const list = document.getElementById('notes-list');
        window.renderNotes(list, [
            {
                id: 'local_5', created_at: midnight(0).toISOString(),
                content: 'queued', isLocal: true
            }
        ]);

        const row = list.querySelector('.wg-health-notes-row');
        expect(row.classList.contains('wg-health-notes-row--pending')).toBe(true);

        const badge = row.querySelector('.wg-tag--pending');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-tag')).toBe(true);
        expect(badge.classList.contains('wg-tag--mono')).toBe(true);
        expect(badge.textContent).toBe('Pending');
    });

    it('surfaces rejected notes with a .wg-tag--rejected badge + errorMessage tooltip', () => {
        const { document, window } = env;
        const list = document.getElementById('notes-list');
        window.renderNotes(list, [
            {
                id: 'local_6', created_at: midnight(0).toISOString(),
                content: 'will fail', isLocal: true, isRejected: true,
                errorMessage: 'HTTP 500: Server Error'
            }
        ]);

        const row = list.querySelector('.wg-health-notes-row');
        expect(row.classList.contains('wg-health-notes-row--rejected')).toBe(true);

        const badge = row.querySelector('.wg-tag--rejected');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('Failed');
        expect(badge.title).toBe('HTTP 500: Server Error');

        // A rejected row does NOT also render the pending badge.
        expect(row.querySelector('.wg-tag--pending')).toBeNull();
    });

    it('renders trailing .wg-icon-btn edit + delete that invoke editNote / deleteNote', () => {
        const { document, window } = env;
        const editSpy = vi.fn();
        const deleteSpy = vi.fn();
        window.editNote = editSpy;
        window.deleteNote = deleteSpy;

        const list = document.getElementById('notes-list');
        window.renderNotes(list, [
            { id: 99, created_at: midnight(0).toISOString(), content: 'hi' }
        ]);

        const editBtn = list.querySelector('.wg-health-notes-row__edit');
        expect(editBtn).not.toBeNull();
        expect(editBtn.classList.contains('wg-icon-btn')).toBe(true);
        expect(editBtn.querySelector('.wg-gloss')).not.toBeNull();
        expect(editBtn.querySelector('svg[data-wg-icon="pencil"]')).not.toBeNull();

        const delBtn = list.querySelector('.wg-health-notes-row__delete');
        expect(delBtn).not.toBeNull();
        expect(delBtn.classList.contains('wg-icon-btn')).toBe(true);
        expect(delBtn.querySelector('.wg-gloss')).not.toBeNull();
        expect(delBtn.querySelector('svg[data-wg-icon="trash"]')).not.toBeNull();

        editBtn.click();
        expect(editSpy).toHaveBeenCalledTimes(1);
        const firstArg = editSpy.mock.calls[0][0];
        expect(firstArg.id).toBe(99);
        expect(firstArg.content).toBe('hi');

        delBtn.click();
        expect(deleteSpy).toHaveBeenCalledTimes(1);
        expect(deleteSpy).toHaveBeenCalledWith(99);
    });

    it('renders the .wg-gloss "Load more" footer when notes.length === NOTES_PAGE_SIZE', () => {
        const { document, window } = env;
        const list = document.getElementById('notes-list');
        const PAGE = 50; // matches NOTES_PAGE_SIZE in features/health.js
        const notes = [];
        for (let i = 0; i < PAGE; i += 1) {
            const ts = new Date(midnight(0));
            ts.setHours(12, 0, 0, i);
            notes.push({ id: i + 1, created_at: ts.toISOString(), content: `n${i}` });
        }
        window.renderNotes(list, notes);

        const more = list.querySelector('.wg-health-notes__load-more');
        expect(more).not.toBeNull();
        const btn = more.querySelector('.wg-health-notes__load-more-btn');
        expect(btn).not.toBeNull();
        expect(btn.classList.contains('wg-gloss')).toBe(true);
        expect(btn.textContent).toBe('Load more');

        // Calling the button triggers loadMoreNotes — stub it to assert dispatch.
        const loadMoreSpy = vi.fn();
        window.loadMoreNotes = loadMoreSpy;
        // Re-render so the new handler is bound (handler captured at row build time).
        window.renderNotes(list, notes);
        list.querySelector('.wg-health-notes__load-more-btn').click();
        expect(loadMoreSpy).toHaveBeenCalledTimes(1);
    });

    it('omits the "Load more" footer when notes.length < NOTES_PAGE_SIZE', () => {
        const { document, window } = env;
        const list = document.getElementById('notes-list');
        window.renderNotes(list, [
            { id: 1, created_at: midnight(0).toISOString(), content: 'a' },
            { id: 2, created_at: midnight(0).toISOString(), content: 'b' }
        ]);
        expect(list.querySelector('.wg-health-notes__load-more')).toBeNull();
    });

    it('clears previously rendered groups on re-render', () => {
        const { document, window } = env;
        const list = document.getElementById('notes-list');
        window.renderNotes(list, [
            { id: 1, created_at: midnight(0).toISOString(), content: 'first' }
        ]);
        expect(list.querySelectorAll('.wg-health-notes-row').length).toBe(1);

        window.renderNotes(list, []);
        expect(list.querySelectorAll('.wg-health-notes-row').length).toBe(0);
        expect(list.querySelector('.wg-health-notes__empty')).not.toBeNull();
    });

    it('index.html replaces the paper-era compose markup with .wg-gloss--inset wrap + .wg-gloss--sun Save', () => {
        const html = fs.readFileSync(INDEX_PATH, 'utf8');
        const composeMatch = html.match(/<div class="wg-health-notes-compose"[\s\S]*?<\/div>\s*<\/div>/);
        expect(composeMatch, 'expected #wg-health-notes-compose markup in index.html').not.toBeNull();
        expect(composeMatch[0]).toMatch(/wg-gloss--inset/);
        expect(composeMatch[0]).toMatch(/id="notes-textarea"/);

        const saveMatch = html.match(/<button[^>]*id="notes-save-btn"[^>]*>/);
        expect(saveMatch, 'expected #notes-save-btn declaration in index.html').not.toBeNull();
        expect(saveMatch[0]).toMatch(/wg-gloss--sun/);
        expect(saveMatch[0]).toMatch(/wg-health-notes-compose__save/);
        // Paper-era classes are gone.
        expect(saveMatch[0]).not.toMatch(/btn-primary/);
    });

    it('index.html notes-list ul carries .wg-health-notes__list and #notes-list keeps its id', () => {
        const html = fs.readFileSync(INDEX_PATH, 'utf8');
        const listMatch = html.match(/<ul[^>]*id="notes-list"[^>]*>/);
        expect(listMatch, 'expected #notes-list ul in index.html').not.toBeNull();
        expect(listMatch[0]).toMatch(/wg-health-notes__list/);
    });

    it('styles.css registers the .wg-health-notes-* rules', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        expect(css).toMatch(/\.wg-health-notes\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-compose\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-compose__textarea\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-compose__save\s*\{/);
        expect(css).toMatch(/\.wg-health-notes__list\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-row\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-row--pending\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-row--rejected\s*\{/);
        expect(css).toMatch(/\.wg-health-notes__load-more-btn\s*\{/);
        expect(css).toMatch(/\.wg-health-notes__empty\s*\{/);
    });
});
