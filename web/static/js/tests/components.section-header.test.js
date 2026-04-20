import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function loadSectionHeader() {
    const dom = new JSDOM('<!DOCTYPE html>', { url: 'https://example.test/', runScripts: 'outside-only' });
    const { window } = dom;
    const src = fs.readFileSync(
        path.join(REPO_ROOT, 'web/static/js/components/section-header.js'),
        'utf8'
    );
    window.eval(src);
    return { window, cleanup: () => dom.window.close() };
}

describe('createSectionHeader', () => {
    it('exposes window.SectionHeader.create', () => {
        const { window, cleanup } = loadSectionHeader();
        try {
            expect(window.SectionHeader).toBeDefined();
            expect(typeof window.SectionHeader.create).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('produces a header with Wandergeek app-header markup, back pill, title, and right slot container', () => {
        const { window, cleanup } = loadSectionHeader();
        try {
            const header = window.SectionHeader.create({
                title: 'Blood Pressure',
                onBack: () => {}
            });
            expect(header.tagName).toBe('HEADER');
            // Dual-classed: legacy .section-header + new .wg-app-header.
            expect(header.classList.contains('section-header')).toBe(true);
            expect(header.classList.contains('wg-app-header')).toBe(true);
            expect(header.classList.contains('no-back')).toBe(false);
            expect(header.classList.contains('wg-app-header--no-back')).toBe(false);

            const back = header.querySelector('.section-back');
            expect(back).not.toBeNull();
            expect(back.tagName).toBe('BUTTON');
            expect(back.classList.contains('wg-icon-btn')).toBe(true);
            expect(back.getAttribute('aria-label')).toBe('Back to Today');
            // New icon-only gloss pill — chevron SVG wrapped in .wg-gloss, no visible label.
            const gloss = back.querySelector('.wg-gloss');
            expect(gloss).not.toBeNull();
            const svg = gloss.querySelector('svg');
            expect(svg).not.toBeNull();
            expect(svg.getAttribute('aria-hidden')).toBe('true');
            expect(back.querySelector('.section-back-label')).toBeNull();

            const title = header.querySelector('.section-title');
            expect(title).not.toBeNull();
            expect(title.classList.contains('wg-app-header__title')).toBe(true);
            expect(title.textContent).toBe('Blood Pressure');
            // No subtitle rendered when the prop is omitted.
            expect(title.querySelector('small')).toBeNull();

            const right = header.querySelector('.section-header-right');
            expect(right).not.toBeNull();
            expect(right.classList.contains('wg-app-header__right')).toBe(true);
            expect(right.children.length).toBe(0);
        } finally {
            cleanup();
        }
    });

    it('invokes onBack when the back button is clicked', () => {
        const { window, cleanup } = loadSectionHeader();
        try {
            let called = 0;
            const header = window.SectionHeader.create({
                title: 'Weight',
                onBack: () => { called += 1; }
            });
            const back = header.querySelector('.section-back');
            back.click();
            expect(called).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('adds .no-back and .wg-app-header--no-back classes and skips back handler when onBack is null', () => {
        const { window, cleanup } = loadSectionHeader();
        try {
            const header = window.SectionHeader.create({ title: 'Today', onBack: null });
            expect(header.classList.contains('no-back')).toBe(true);
            expect(header.classList.contains('wg-app-header--no-back')).toBe(true);
            const back = header.querySelector('.section-back');
            expect(back).not.toBeNull();
            // click should not throw (no handler attached)
            expect(() => back.click()).not.toThrow();
        } finally {
            cleanup();
        }
    });

    it('slots an Element rightSlot into .wg-app-header__right', () => {
        const { window, cleanup } = loadSectionHeader();
        try {
            const gear = window.document.createElement('button');
            gear.className = 'gear-btn';
            gear.textContent = '⚙';
            const header = window.SectionHeader.create({
                title: 'Today',
                onBack: null,
                rightSlot: gear
            });
            const right = header.querySelector('.wg-app-header__right');
            expect(right.children.length).toBe(1);
            expect(right.firstElementChild).toBe(gear);
        } finally {
            cleanup();
        }
    });

    it('slots a string rightSlot as text', () => {
        const { window, cleanup } = loadSectionHeader();
        try {
            const header = window.SectionHeader.create({
                title: 'Food',
                onBack: () => {},
                rightSlot: 'experimental'
            });
            const right = header.querySelector('.wg-app-header__right');
            expect(right.textContent).toBe('experimental');
        } finally {
            cleanup();
        }
    });

    it('produces an empty right container when rightSlot is omitted', () => {
        const { window, cleanup } = loadSectionHeader();
        try {
            const header = window.SectionHeader.create({ title: 'Meds', onBack: () => {} });
            const right = header.querySelector('.wg-app-header__right');
            expect(right.children.length).toBe(0);
            expect(right.textContent).toBe('');
        } finally {
            cleanup();
        }
    });

    it('renders a subtitle <small> inside the title when subtitle is provided', () => {
        const { window, cleanup } = loadSectionHeader();
        try {
            const header = window.SectionHeader.create({
                title: 'Blood Pressure',
                subtitle: 'last 14 days',
                onBack: () => {}
            });
            const title = header.querySelector('.wg-app-header__title');
            expect(title).not.toBeNull();
            // Title text comes first, then the <small> line.
            expect(title.firstChild.nodeType).toBe(window.Node.TEXT_NODE);
            expect(title.firstChild.textContent).toBe('Blood Pressure');
            const small = title.querySelector('small');
            expect(small).not.toBeNull();
            expect(small.textContent).toBe('last 14 days');
        } finally {
            cleanup();
        }
    });

    it('omits the subtitle <small> when the subtitle prop is an empty string', () => {
        const { window, cleanup } = loadSectionHeader();
        try {
            const header = window.SectionHeader.create({
                title: 'Weight',
                subtitle: '',
                onBack: () => {}
            });
            const title = header.querySelector('.wg-app-header__title');
            expect(title.querySelector('small')).toBeNull();
        } finally {
            cleanup();
        }
    });
});
