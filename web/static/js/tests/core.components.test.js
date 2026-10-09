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
        'web/static/js/components/wg-row-actions.js',
        'web/static/js/components/wg-icons.js',
        'web/static/js/components/wg-chip.js',
    ]) {
        const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
        window.eval(`${src}\n//# sourceURL=file://${path.join(REPO_ROOT, relPath)}`);
    }
    return { window, cleanup: () => dom.window.close() };
}

describe('createEmptyState / createOfflineEmptyState / createErrorState / createSkeleton', () => {
    it('renders the kit .wg-empty anatomy: icon, title, body, actions', () => {
        const { window, cleanup } = loadComponents();
        try {
            let clicked = 0;
            const el = window.createEmptyState({
                icon: 'heart', title: 'No readings yet', body: 'Log your first reading.',
                actions: [{ label: 'Log reading', icon: 'plus', onClick: () => { clicked++; } }],
            });
            expect(el.tagName).toBe('DIV');
            expect(el.className).toBe('wg-empty');
            expect(el.querySelector('.wg-empty__icon svg')).not.toBeNull();
            expect(el.querySelector('.wg-empty__title').textContent).toBe('No readings yet');
            expect(el.querySelector('.wg-empty__body').textContent).toBe('Log your first reading.');
            const btn = el.querySelector('.wg-empty__acts > button.wg-btn');
            // Plain .wg-btn by default: the view's toolbar owns the one sun primary.
            expect(btn.classList.contains('wg-btn--primary')).toBe(false);
            expect(btn.textContent).toBe('Log reading');
            btn.click();
            expect(clicked).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('inline + tag: .wg-empty--inline <li>, no body/actions when omitted', () => {
        const { window, cleanup } = loadComponents();
        try {
            const el = window.createEmptyState({ title: 'Nothing', inline: true, tag: 'li' });
            expect(el.tagName).toBe('LI');
            expect(el.classList.contains('wg-empty--inline')).toBe(true);
            expect(el.querySelector('.wg-empty__icon')).toBeNull();
            expect(el.querySelector('.wg-empty__body')).toBeNull();
            expect(el.querySelector('.wg-empty__acts')).toBeNull();
            expect(el.textContent).toBe('Nothing');
        } finally {
            cleanup();
        }
    });

    it('offline cold-start state is one shared wording', () => {
        const { window, cleanup } = loadComponents();
        try {
            const el = window.createOfflineEmptyState({ tag: 'li' });
            expect(el.tagName).toBe('LI');
            expect(el.classList.contains('wg-empty')).toBe(true);
            expect(el.textContent).toContain('No cached data');
        } finally {
            cleanup();
        }
    });

    it('createErrorState renders .wg-error with an optional Retry', () => {
        const { window, cleanup } = loadComponents();
        try {
            expect(window.createErrorState('Boom').querySelector('button')).toBeNull();
            let retried = 0;
            const el = window.createErrorState('Failed to load', () => { retried++; });
            expect(el.className).toBe('wg-error');
            expect(el.getAttribute('role')).toBe('alert');
            el.querySelector('button').click();
            expect(retried).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('createSkeleton renders count .wg-skel--<kind> blocks in an aria-busy stack', () => {
        const { window, cleanup } = loadComponents();
        try {
            const el = window.createSkeleton('card', 2);
            expect(el.getAttribute('aria-busy')).toBe('true');
            const blocks = el.querySelectorAll('.wg-skel.wg-skel--card');
            expect(blocks.length).toBe(2);
        } finally {
            cleanup();
        }
    });
});

describe('WGRowActions', () => {
    it('swipeIntent: horizontal travel past 40px opens (left) or closes (right); vertical or short travel is no intent', () => {
        const { window, cleanup } = loadComponents();
        try {
            const { swipeIntent } = window.WGRowActions;
            expect(swipeIntent(-60, 5)).toBe('open');
            expect(swipeIntent(60, -5)).toBe('close');
            expect(swipeIntent(-39, 0)).toBeNull();
            expect(swipeIntent(-60, 70)).toBeNull(); // a scroll, not a swipe
            expect(swipeIntent(-50, 50)).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('a touch swipe opens the row (one at a time) and swallows the click that follows; a tap closes it', () => {
        const { window, cleanup } = loadComponents();
        try {
            const { document } = window;
            const make = () => {
                const row = document.createElement('div');
                document.body.appendChild(row);
                return window.WGRowActions.attach(row, { onEdit: () => {}, onDelete: () => {} });
            };
            const a = make();
            const b = make();
            let rowClicks = 0;
            a.addEventListener('click', () => { rowClicks += 1; });
            const swipe = (row, dx) => {
                row.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 10 }));
                row.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: 200 + dx, clientY: 12 }));
                row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
            };

            expect(Array.from(a.querySelectorAll('.wg-swipe__act')).map((x) => x.textContent)).toEqual(['Edit', 'Delete']);
            expect(a.querySelector('.wg-swipe__acts').getAttribute('aria-hidden')).toBe('true');

            swipe(a, -80);
            expect(a.classList.contains('wg-swipe--open')).toBe(true);
            expect(rowClicks).toBe(0);

            swipe(b, -80);
            expect(b.classList.contains('wg-swipe--open')).toBe(true);
            expect(a.classList.contains('wg-swipe--open')).toBe(false);

            swipe(b, 0); // a tap on an open row closes it, without acting
            expect(b.classList.contains('wg-swipe--open')).toBe(false);

            swipe(a, 0); // a tap on a closed row is an ordinary click
            expect(rowClicks).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('opts.swipe replaces the Edit/Delete tray; the menu still lists every action', () => {
        const { window, cleanup } = loadComponents();
        try {
            const { document } = window;
            const copied = [];
            const copy = { label: 'Copy', icon: 'copy', onClick: () => copied.push('copy') };
            const remove = { label: 'Remove', icon: 'trash', danger: true, onClick: () => copied.push('remove') };
            const row = document.createElement('div');
            document.body.appendChild(row);
            window.WGRowActions.attach(row, { onEdit: () => {}, extra: [copy, remove], swipe: [copy, remove] });

            const acts = Array.from(row.querySelectorAll('.wg-swipe__act'));
            expect(acts.map((x) => x.textContent)).toEqual(['Copy', 'Remove']);
            expect(acts[1].classList.contains('wg-swipe__act--danger')).toBe(true);
            expect(Array.from(row.querySelectorAll('.wg-menu__item')).map((x) => x.textContent)).toEqual(['Edit', 'Copy', 'Remove']);
            acts[0].click();
            expect(copied).toEqual(['copy']);
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
