import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function loadComponents() {
    const dom = new JSDOM('<!DOCTYPE html>', { url: 'https://example.test/', runScripts: 'outside-only' });
    const { window } = dom;
    for (const relPath of [
        'web/static/js/components/empty-state.js',
        'web/static/js/components/stat-card.js',
        'web/static/js/components/action-row.js',
        'web/static/js/components/wg-icons.js',
        'web/static/js/components/wg-chip.js',
    ]) {
        const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${path.join(REPO_ROOT, relPath)}`);
    }
    return { window, cleanup: () => dom.window.close() };
}

describe('createEmptyState', () => {
    it('creates a <li> by default with centered style and message', () => {
        const { window, cleanup } = loadComponents();
        try {
            const el = window.createEmptyState('No data');
            expect(el.tagName).toBe('LI');
            expect(el.textContent).toBe('No data');
            expect(el.className).toContain('empty-state-msg');
        } finally {
            cleanup();
        }
    });

    it('supports custom tag', () => {
        const { window, cleanup } = loadComponents();
        try {
            const el = window.createEmptyState('Empty', { tag: 'p' });
            expect(el.tagName).toBe('P');
            expect(el.textContent).toBe('Empty');
        } finally {
            cleanup();
        }
    });

    it('applies optional className', () => {
        const { window, cleanup } = loadComponents();
        try {
            const el = window.createEmptyState('Nothing', { className: 'my-class' });
            expect(el.classList.contains('my-class')).toBe(true);
        } finally {
            cleanup();
        }
    });
});

describe('createStatItem', () => {
    it('creates div with label and value spans using default classes', () => {
        const { window, cleanup } = loadComponents();
        try {
            const item = window.createStatItem('Trend', '80.0 kg');
            expect(item.tagName).toBe('DIV');
            expect(item.className).toBe('stat-item');
            const spans = item.querySelectorAll('span');
            expect(spans[0].className).toBe('stat-label');
            expect(spans[0].textContent).toBe('Trend');
            expect(spans[1].className).toBe('stat-value');
            expect(spans[1].textContent).toBe('80.0 kg');
        } finally {
            cleanup();
        }
    });

    it('uses custom class names for BP avg item', () => {
        const { window, cleanup } = loadComponents();
        try {
            const item = window.createStatItem('14d (14d)', '120/80', {
                className: 'bp-avg-item',
                labelClass: 'bp-avg-label',
                valueClass: 'bp-avg-value',
            });
            expect(item.className).toBe('bp-avg-item');
            expect(item.querySelector('.bp-avg-label').textContent).toBe('14d (14d)');
            expect(item.querySelector('.bp-avg-value').textContent).toBe('120/80');
        } finally {
            cleanup();
        }
    });

    it('inserts separator text node between label and value', () => {
        const { window, cleanup } = loadComponents();
        try {
            const item = window.createStatItem('Rate:', '+0.5 kg/week', { separator: ' ' });
            // Should have 3 child nodes: span, text, span
            expect(item.childNodes.length).toBe(3);
            expect(item.childNodes[1].textContent).toBe(' ');
        } finally {
            cleanup();
        }
    });

    it('omits separator when not provided', () => {
        const { window, cleanup } = loadComponents();
        try {
            const item = window.createStatItem('Goal', '75 kg');
            expect(item.childNodes.length).toBe(2);
        } finally {
            cleanup();
        }
    });
});

describe('createDeleteButton', () => {
    it('creates a button with correct type, class, title, and text', () => {
        const { window, cleanup } = loadComponents();
        try {
            const btn = window.createDeleteButton(() => {});
            expect(btn.tagName).toBe('BUTTON');
            expect(btn.type).toBe('button');
            expect(btn.className).toBe('icon-action-btn delete');
            expect(btn.title).toBe('Delete');
            expect(btn.getAttribute('aria-label')).toBe('Delete');
            expect(btn.querySelector('svg').getAttribute('data-wg-icon')).toBe('trash');
            expect(btn.textContent).toBe('');
        } finally {
            cleanup();
        }
    });

    it('calls the onDelete handler on click', () => {
        const { window, cleanup } = loadComponents();
        try {
            let called = false;
            const btn = window.createDeleteButton(() => { called = true; });
            btn.click();
            expect(called).toBe(true);
        } finally {
            cleanup();
        }
    });
});

describe('WGChip', () => {
    it('create renders a state chip with plain text and an optional icon', () => {
        const { window, cleanup } = loadComponents();
        try {
            const chip = window.WGChip.create({ text: 'Taken', state: 'ok', small: true, icon: 'check' });
            expect(chip.tagName).toBe('SPAN');
            expect(Array.from(chip.classList)).toEqual(['wg-chip', 'wg-chip--ok', 'wg-chip--sm']);
            expect(chip.textContent).toBe('Taken');
            expect(chip.querySelector('.wg-ico svg').getAttribute('data-wg-icon')).toBe('check');
            expect(window.WGChip.create({ text: 'flat' }).className).toBe('wg-chip');
            expect(() => window.WGChip.create({ text: 'x', state: 'alert' })).toThrow(/unknown state/);
        } finally {
            cleanup();
        }
    });

    it('sync maps row sync state to one chip: rejected wins over pending, synced → null', () => {
        const { window, cleanup } = loadComponents();
        try {
            for (const row of [{ isLocal: true }, { pending: true }, { _optimistic: true }]) {
                const chip = window.WGChip.sync(row);
                expect(chip.classList.contains('wg-chip--pending')).toBe(true);
                expect(chip.textContent).toBe('Pending');
            }
            const failed = window.WGChip.sync({ isLocal: true, isRejected: true, errorMessage: 'HTTP 400' });
            expect(failed.classList.contains('wg-chip--danger')).toBe(true);
            expect(failed.textContent).toBe('Sync failed');
            expect(failed.title).toBe('HTTP 400');
            expect(window.WGChip.sync({ id: 1 })).toBeNull();
            expect(window.WGChip.sync(null)).toBeNull();
        } finally {
            cleanup();
        }
    });
});
