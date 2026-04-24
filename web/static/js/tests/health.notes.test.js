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
        // Phase 8 / Task 7 wraps the composer in a `.wg-card` card with a
        // header row (title + tag chips) and a footer row (char count +
        // Add-note CTA), so match any class-set that contains
        // `wg-health-notes-compose` at the composer card's root.
        const composeMatch = html.match(/<div class="[^"]*wg-health-notes-compose[^"]*"[\s\S]*?id="notes-save-btn"[^>]*>/);
        expect(composeMatch, 'expected #wg-health-notes-compose markup in index.html').not.toBeNull();
        expect(composeMatch[0]).toMatch(/wg-gloss--inset/);
        expect(composeMatch[0]).toMatch(/id="notes-textarea"/);
        // The composer card itself carries `.wg-card` (Task 7 spec).
        expect(composeMatch[0]).toMatch(/wg-card[^"]*wg-health-notes-compose/);

        const saveMatch = html.match(/<button[^>]*id="notes-save-btn"[^>]*>/);
        expect(saveMatch, 'expected #notes-save-btn declaration in index.html').not.toBeNull();
        expect(saveMatch[0]).toMatch(/wg-gloss--sun/);
        expect(saveMatch[0]).toMatch(/wg-health-notes-compose__save/);
        // Paper-era classes are gone.
        expect(saveMatch[0]).not.toMatch(/btn-primary/);
    });

    it('index.html renders the 6 tag chips (SLEEP / STRESS / HR / SPO2 / STEPS / NOTE) inside the composer', () => {
        const html = fs.readFileSync(INDEX_PATH, 'utf8');
        const tagsMatch = html.match(/<div [^>]*id="notes-compose-tags"[\s\S]*?<\/div>/);
        expect(tagsMatch, 'expected #notes-compose-tags container in index.html').not.toBeNull();
        const block = tagsMatch[0];
        ['SLEEP', 'STRESS', 'HR', 'SPO2', 'STEPS', 'NOTE'].forEach((tag) => {
            const re = new RegExp(`data-tag="${tag}"`);
            expect(block, `expected chip for ${tag}`).toMatch(re);
        });
        // Each chip is a `.wg-tag` + `.wg-health-notes-compose__tag` button.
        // Require an explicit class-token boundary so the outer
        // `.wg-health-notes-compose__tags` container doesn't leak into the
        // match.
        const chipCount = (block.match(/class="[^"]*\bwg-health-notes-compose__tag\b[^"]*"/g) || []).length;
        expect(chipCount).toBe(6);
        expect(block).toMatch(/role="radiogroup"/);
    });

    it('index.html renders the char-count span + "+ Add note" CTA label in the composer footer', () => {
        const html = fs.readFileSync(INDEX_PATH, 'utf8');
        const countMatch = html.match(/<span[^>]*id="notes-compose-count"[^>]*>[^<]*<\/span>/);
        expect(countMatch, 'expected #notes-compose-count span in index.html').not.toBeNull();
        expect(countMatch[0]).toMatch(/wg-health-notes-compose__count/);

        const saveMatch = html.match(/<button[^>]*id="notes-save-btn"[^>]*>([^<]*)<\/button>/);
        expect(saveMatch).not.toBeNull();
        // Task 7 spec: CTA label is "+ Add note" (replaces paper-era "Save note").
        expect(saveMatch[1]).toMatch(/\+\s*Add note/);
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
        expect(css).toMatch(/\.wg-health-notes-compose__header\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-compose__tags\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-compose__tag\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-compose__textarea\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-compose__footer\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-compose__count\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-compose__save\s*\{/);
        expect(css).toMatch(/\.wg-health-notes__list\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-row\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-row--pending\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-row--rejected\s*\{/);
        expect(css).toMatch(/\.wg-health-notes-row__tag\s*\{/);
        expect(css).toMatch(/\.wg-health-notes__load-more-btn\s*\{/);
        expect(css).toMatch(/\.wg-health-notes__empty\s*\{/);
        expect(css).toMatch(/\.wg-tag--sun\s*\{/);
    });
});

describe('Health Notes composer tag chips (Phase 8, Task 7)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('chip click toggles .wg-tag--sun active state; second click on same chip clears it', () => {
        const { document, window } = env;
        // The composer binds on DOMContentLoaded via loadNotes(), but in this
        // isolated env we just call loadNotes-adjacent wiring by triggering a
        // click through the delegated listener — it self-binds on the first
        // event because loadNotes runs after DOMContentLoaded in production.
        // Force the bind by calling the exposed helper.
        if (typeof window.bindNotesComposer === 'function') window.bindNotesComposer();

        const container = document.getElementById('notes-compose-tags');
        expect(container, 'expected #notes-compose-tags in harness DOM').not.toBeNull();

        const sleepChip = container.querySelector('[data-tag="SLEEP"]');
        const stressChip = container.querySelector('[data-tag="STRESS"]');
        expect(sleepChip).not.toBeNull();
        expect(stressChip).not.toBeNull();

        // Initially none active.
        expect(sleepChip.classList.contains('wg-tag--sun')).toBe(false);
        expect(sleepChip.getAttribute('aria-checked')).toBe('false');

        sleepChip.click();
        expect(sleepChip.classList.contains('wg-tag--sun')).toBe(true);
        expect(sleepChip.getAttribute('aria-checked')).toBe('true');
        expect(stressChip.classList.contains('wg-tag--sun')).toBe(false);

        // Picking STRESS deactivates SLEEP (single-select).
        stressChip.click();
        expect(sleepChip.classList.contains('wg-tag--sun')).toBe(false);
        expect(sleepChip.getAttribute('aria-checked')).toBe('false');
        expect(stressChip.classList.contains('wg-tag--sun')).toBe(true);

        // Clicking the active chip again clears the selection.
        stressChip.click();
        expect(stressChip.classList.contains('wg-tag--sun')).toBe(false);
        expect(stressChip.getAttribute('aria-checked')).toBe('false');
    });

    it('textarea input updates the char-count pill and toggles #notes-save-btn disabled', () => {
        const { document, window } = env;
        if (typeof window.bindNotesComposer === 'function') window.bindNotesComposer();

        const textarea = document.getElementById('notes-textarea');
        const count = document.getElementById('notes-compose-count');
        const save = document.getElementById('notes-save-btn');

        expect(count.textContent).toBe('empty');
        expect(save.hasAttribute('disabled')).toBe(true);

        textarea.value = 'hello';
        textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
        expect(count.textContent).toBe('5 chars');
        expect(save.hasAttribute('disabled')).toBe(false);

        textarea.value = '   ';
        textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
        // Non-empty length counts, but whitespace-only disables submit.
        expect(count.textContent).toBe('3 chars');
        expect(save.hasAttribute('disabled')).toBe(true);

        textarea.value = '';
        textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
        expect(count.textContent).toBe('empty');
        expect(save.hasAttribute('disabled')).toBe(true);
    });

    it('addNote POSTs {content, tag} with selected chip and clears composer on success', async () => {
        const { document, window } = env;
        if (typeof window.bindNotesComposer === 'function') window.bindNotesComposer();

        const calls = [];
        window.apiCall = async (url, method, body) => {
            calls.push({ url, method, body });
            if (url === '/api/notes' && method === 'POST') {
                return { id: 99, content: body.content, tag: body.tag || null, created_at: new Date().toISOString() };
            }
            return [];
        };
        window.DataStore = { invalidateTags: async () => {}, loadSWR: async () => {} };

        const textarea = document.getElementById('notes-textarea');
        textarea.value = 'slept 8h';
        textarea.dispatchEvent(new window.Event('input', { bubbles: true }));

        const sleepChip = document.getElementById('notes-compose-tags').querySelector('[data-tag="SLEEP"]');
        sleepChip.click();

        await window.addNote();

        const post = calls.find((c) => c.url === '/api/notes' && c.method === 'POST');
        expect(post, 'expected POST /api/notes').toBeDefined();
        expect(post.body).toEqual({ content: 'slept 8h', tag: 'SLEEP' });

        // Composer resets on success.
        expect(textarea.value).toBe('');
        expect(sleepChip.classList.contains('wg-tag--sun')).toBe(false);
        expect(document.getElementById('notes-compose-count').textContent).toBe('empty');
    });

    it('addNote omits tag key when no chip is selected', async () => {
        const { document, window } = env;
        if (typeof window.bindNotesComposer === 'function') window.bindNotesComposer();

        const calls = [];
        window.apiCall = async (url, method, body) => {
            calls.push({ url, method, body });
            if (url === '/api/notes' && method === 'POST') {
                return { id: 1, content: body.content, tag: null, created_at: new Date().toISOString() };
            }
            return [];
        };
        window.DataStore = { invalidateTags: async () => {}, loadSWR: async () => {} };

        const textarea = document.getElementById('notes-textarea');
        textarea.value = 'quick note';
        textarea.dispatchEvent(new window.Event('input', { bubbles: true }));

        await window.addNote();

        const post = calls.find((c) => c.url === '/api/notes' && c.method === 'POST');
        expect(post).toBeDefined();
        expect(post.body).toEqual({ content: 'quick note' });
        expect('tag' in post.body).toBe(false);
    });

    it('renders a sun tag pill on listed notes when note.tag is a valid enum value', () => {
        const { document, window } = env;
        const list = document.getElementById('notes-list');
        const when = new Date();
        when.setHours(12, 0, 0, 0);
        window.renderNotes(list, [
            { id: 7, created_at: when.toISOString(), content: 'feeling rested', tag: 'SLEEP' },
            { id: 8, created_at: when.toISOString(), content: 'no tag row', tag: null },
            { id: 9, created_at: when.toISOString(), content: 'bogus tag', tag: 'FROG' }
        ]);

        const rows = list.querySelectorAll('.wg-health-notes-row');
        expect(rows.length).toBe(3);

        const sleepRow = list.querySelector('[data-note-id="7"]');
        const sleepTag = sleepRow.querySelector('.wg-health-notes-row__tag');
        expect(sleepTag).not.toBeNull();
        expect(sleepTag.classList.contains('wg-tag')).toBe(true);
        expect(sleepTag.classList.contains('wg-tag--high')).toBe(true);
        expect(sleepTag.getAttribute('data-tag')).toBe('SLEEP');
        expect(sleepTag.textContent).toBe('SLEEP');

        // No pill when note.tag is absent.
        const nullRow = list.querySelector('[data-note-id="8"]');
        expect(nullRow.querySelector('.wg-health-notes-row__tag')).toBeNull();

        // No pill when note.tag is not one of the 6 valid enum values.
        const bogusRow = list.querySelector('[data-note-id="9"]');
        expect(bogusRow.querySelector('.wg-health-notes-row__tag')).toBeNull();
    });
});

// Round-2 Task 9 — Vitals → Notes tag-chip interactivity + post-add list
// refresh. The chip behavior + addNote payload shape are already covered
// above; these cases pin the design-token discipline (no inline styles on
// chip toggle) and the #12b regression (list must reflect the new note
// after addNote, with the "Loading notes…" indicator cleared, without a
// full page reload).
describe('Vitals → Notes — Round-2 Task 9 (#12a + #12b)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('chip toggle never writes inline styles — selected state is class-driven only', () => {
        const { document, window } = env;
        if (typeof window.bindNotesComposer === 'function') window.bindNotesComposer();

        const chip = document.getElementById('notes-compose-tags').querySelector('[data-tag="SLEEP"]');
        expect(chip).not.toBeNull();
        // Baseline: no inline style attribute before the click.
        expect(chip.getAttribute('style') || '').toBe('');

        chip.click();
        expect(chip.classList.contains('wg-tag--sun')).toBe(true);
        // Selected state must come from the class, not inline style — guards
        // CLAUDE.md rule #3 (no inline style assignments in frontend code).
        expect(chip.getAttribute('style') || '').toBe('');

        chip.click();
        expect(chip.classList.contains('wg-tag--sun')).toBe(false);
        expect(chip.getAttribute('style') || '').toBe('');
    });

    it('after addNote the list shows the new note without a full reload and clears the loading indicator', async () => {
        const { document, window } = env;
        if (typeof window.bindNotesComposer === 'function') window.bindNotesComposer();

        // Track GET vs POST; the refresh chain should perform at least one
        // GET /api/notes after the POST and paint its result into #notes-list.
        const serverState = [];
        let getCount = 0;
        let postCount = 0;
        window.apiCall = async (url, method, body) => {
            if (url.startsWith('/api/notes') && method === 'GET') {
                getCount += 1;
                return serverState.slice();
            }
            if (url === '/api/notes' && method === 'POST') {
                postCount += 1;
                const row = {
                    id: 101,
                    content: body && body.content,
                    tag: (body && body.tag) || null,
                    created_at: new Date().toISOString()
                };
                serverState.unshift(row);
                return row;
            }
            return null;
        };

        const list = document.getElementById('notes-list');
        const loading = document.getElementById('notes-loading');
        // Start with an empty list so we can prove the post-add refresh painted
        // the new note rather than leaving a stale render behind.
        window.renderNotes(list, []);
        expect(list.querySelector('.wg-health-notes__empty')).not.toBeNull();

        const textarea = document.getElementById('notes-textarea');
        textarea.value = 'post-add refresh works';
        textarea.dispatchEvent(new window.Event('input', { bubbles: true }));

        const stressChip = document.getElementById('notes-compose-tags').querySelector('[data-tag="STRESS"]');
        stressChip.click();

        // window.addNote is the feature-module export; its signature is (no args).
        await window.addNote();
        // addNote fires loadNotes() without awaiting; let microtasks drain so
        // the SWR chain (fetcher → onFresh → paintNotes) settles.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(postCount).toBe(1);
        expect(getCount).toBeGreaterThanOrEqual(1);

        // The composer resets on success: textarea cleared, chip deselected,
        // char-count back to "empty".
        expect(textarea.value).toBe('');
        expect(stressChip.classList.contains('wg-tag--sun')).toBe(false);
        expect(document.getElementById('notes-compose-count').textContent).toBe('empty');

        // The new note is rendered into the list without a full page reload.
        const rows = list.querySelectorAll('.wg-health-notes-row');
        expect(rows.length).toBe(1);
        const row = list.querySelector('[data-note-id="101"]');
        expect(row).not.toBeNull();
        expect(row.querySelector('.wg-health-notes-row__content').textContent)
            .toBe('post-add refresh works');

        // #12b: "Loading notes…" must NOT be left visible after the refresh
        // chain completes — previously blocked by the SW ConstraintError that
        // Task 1 resolved. Guard here so a future regression in the onFresh /
        // onError completion path is caught by the suite.
        expect(loading.style.display).toBe('none');
    });
});
