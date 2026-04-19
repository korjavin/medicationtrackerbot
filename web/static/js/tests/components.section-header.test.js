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

    it('produces a header with back button, title, and right slot container', () => {
        const { window, cleanup } = loadSectionHeader();
        try {
            const header = window.SectionHeader.create({
                title: 'Blood Pressure',
                onBack: () => {}
            });
            expect(header.tagName).toBe('HEADER');
            expect(header.classList.contains('section-header')).toBe(true);
            expect(header.classList.contains('no-back')).toBe(false);

            const back = header.querySelector('.section-back');
            expect(back).not.toBeNull();
            expect(back.tagName).toBe('BUTTON');
            expect(back.getAttribute('aria-label')).toBe('Back to Today');
            // Visible pill label (plan spec: "<svg…/> Today")
            const label = back.querySelector('.section-back-label');
            expect(label).not.toBeNull();
            expect(label.textContent).toBe('Today');

            const title = header.querySelector('.section-title');
            expect(title).not.toBeNull();
            expect(title.textContent).toBe('Blood Pressure');

            const right = header.querySelector('.section-header-right');
            expect(right).not.toBeNull();
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

    it('adds .no-back class and skips back handler when onBack is null', () => {
        const { window, cleanup } = loadSectionHeader();
        try {
            const header = window.SectionHeader.create({ title: 'Today', onBack: null });
            expect(header.classList.contains('no-back')).toBe(true);
            const back = header.querySelector('.section-back');
            expect(back).not.toBeNull();
            // click should not throw (no handler attached)
            expect(() => back.click()).not.toThrow();
        } finally {
            cleanup();
        }
    });

    it('slots an Element rightSlot into .section-header-right', () => {
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
            const right = header.querySelector('.section-header-right');
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
            const right = header.querySelector('.section-header-right');
            expect(right.textContent).toBe('experimental');
        } finally {
            cleanup();
        }
    });

    it('produces an empty right container when rightSlot is omitted', () => {
        const { window, cleanup } = loadSectionHeader();
        try {
            const header = window.SectionHeader.create({ title: 'Meds', onBack: () => {} });
            const right = header.querySelector('.section-header-right');
            expect(right.children.length).toBe(0);
            expect(right.textContent).toBe('');
        } finally {
            cleanup();
        }
    });
});
