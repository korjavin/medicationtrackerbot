import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function loadWGSettings() {
    const dom = new JSDOM('<!DOCTYPE html>', { url: 'https://example.test/', runScripts: 'outside-only' });
    const { window } = dom;
    const src = fs.readFileSync(
        path.join(REPO_ROOT, 'web/static/js/components/wg-settings.js'),
        'utf8'
    );
    window.eval(src);
    return { window, cleanup: () => dom.window.close() };
}

describe('WGSettings.section', () => {
    it('exposes window.WGSettings with section/row/infoRow factories', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            expect(window.WGSettings).toBeDefined();
            expect(typeof window.WGSettings.section).toBe('function');
            expect(typeof window.WGSettings.row).toBe('function');
            expect(typeof window.WGSettings.infoRow).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('renders a <section class="wg-card wg-settings-section"> with a row-list child', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.section({ title: 'Sync' });
            expect(el.tagName).toBe('SECTION');
            expect(el.classList.contains('wg-card')).toBe(true);
            expect(el.classList.contains('wg-settings-section')).toBe(true);
            const list = el.querySelector('.wg-settings-row-list');
            expect(list).not.toBeNull();
        } finally {
            cleanup();
        }
    });

    it('renders a mono title from the title option', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.section({ title: 'Notifications' });
            const title = el.querySelector('.wg-settings-section__title');
            expect(title).not.toBeNull();
            expect(title.textContent).toBe('Notifications');
        } finally {
            cleanup();
        }
    });

    it('renders an uppercase eyebrow when the eyebrow option is provided', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.section({ eyebrow: 'SETTINGS', title: 'Features' });
            const eyebrow = el.querySelector('.wg-settings-section__eyebrow');
            expect(eyebrow).not.toBeNull();
            expect(eyebrow.classList.contains('wg-section-label')).toBe(true);
            expect(eyebrow.textContent).toContain('SETTINGS');
        } finally {
            cleanup();
        }
    });

    it('omits the eyebrow element when no eyebrow is provided', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.section({ title: 'Features' });
            expect(el.querySelector('.wg-settings-section__eyebrow')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('renders a muted description when the description option is provided', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.section({
                title: 'Features',
                description: 'Enable or disable sections'
            });
            const desc = el.querySelector('.wg-settings-section__desc');
            expect(desc).not.toBeNull();
            expect(desc.textContent).toBe('Enable or disable sections');
        } finally {
            cleanup();
        }
    });

    it('omits the description element when no description is provided', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.section({ title: 'Features' });
            expect(el.querySelector('.wg-settings-section__desc')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('appends a single child node into the row-list container', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const child = window.document.createElement('p');
            child.id = 'only-child';
            const el = window.WGSettings.section({ title: 'X', children: child });
            const list = el.querySelector('.wg-settings-row-list');
            expect(list.querySelector('#only-child')).not.toBeNull();
        } finally {
            cleanup();
        }
    });

    it('appends an array of child nodes into the row-list container in order', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const a = window.document.createElement('p');
            a.id = 'a';
            const b = window.document.createElement('p');
            b.id = 'b';
            const el = window.WGSettings.section({ title: 'X', children: [a, b] });
            const list = el.querySelector('.wg-settings-row-list');
            expect(list.children.length).toBe(2);
            expect(list.children[0].id).toBe('a');
            expect(list.children[1].id).toBe('b');
        } finally {
            cleanup();
        }
    });

    it('handles no args gracefully (empty section with just a row-list)', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.section();
            expect(el.classList.contains('wg-settings-section')).toBe(true);
            expect(el.querySelector('.wg-settings-section__title')).toBeNull();
            expect(el.querySelector('.wg-settings-row-list')).not.toBeNull();
        } finally {
            cleanup();
        }
    });

    it('escapes text content (no HTML injection via title/description)', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.section({
                title: '<img src=x onerror=pwn>',
                description: '<script>alert(1)</script>'
            });
            const title = el.querySelector('.wg-settings-section__title');
            expect(title.querySelector('img')).toBeNull();
            expect(title.textContent).toContain('<img');
            const desc = el.querySelector('.wg-settings-section__desc');
            expect(desc.querySelector('script')).toBeNull();
        } finally {
            cleanup();
        }
    });
});

describe('WGSettings.row', () => {
    it('renders a <div class="wg-settings-row"> with content + control columns', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.row({ title: 'Blood pressure' });
            expect(el.tagName).toBe('DIV');
            expect(el.classList.contains('wg-settings-row')).toBe(true);
            expect(el.querySelector('.wg-settings-row__content')).not.toBeNull();
            expect(el.querySelector('.wg-settings-row__control')).not.toBeNull();
        } finally {
            cleanup();
        }
    });

    it('renders the mono title and muted description in the content column', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.row({
                title: 'Medications',
                description: 'Track intakes and refills'
            });
            const title = el.querySelector('.wg-settings-row__title');
            const desc = el.querySelector('.wg-settings-row__desc');
            expect(title).not.toBeNull();
            expect(title.textContent).toBe('Medications');
            expect(desc).not.toBeNull();
            expect(desc.textContent).toBe('Track intakes and refills');
        } finally {
            cleanup();
        }
    });

    it('omits the description when not provided', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.row({ title: 'Only title' });
            expect(el.querySelector('.wg-settings-row__title')).not.toBeNull();
            expect(el.querySelector('.wg-settings-row__desc')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('appends a toggle-like control node into the control slot', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const control = window.document.createElement('mt-setting-toggle');
            control.id = 'x-toggle';
            const el = window.WGSettings.row({ title: 'X', control });
            const slot = el.querySelector('.wg-settings-row__control');
            expect(slot.firstElementChild).toBe(control);
        } finally {
            cleanup();
        }
    });

    it('appends a button control into the control slot', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const btn = window.document.createElement('button');
            btn.className = 'wg-gloss';
            btn.textContent = 'Save';
            const el = window.WGSettings.row({ title: 'Targets', control: btn });
            const slot = el.querySelector('.wg-settings-row__control');
            expect(slot.firstElementChild).toBe(btn);
        } finally {
            cleanup();
        }
    });

    it('appends an input-wrap control into the control slot', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const wrap = window.document.createElement('label');
            wrap.className = 'wg-gloss--inset';
            const input = window.document.createElement('input');
            input.type = 'number';
            wrap.appendChild(input);
            const el = window.WGSettings.row({ title: 'Calories', control: wrap });
            expect(el.querySelector('.wg-settings-row__control > .wg-gloss--inset')).toBe(wrap);
        } finally {
            cleanup();
        }
    });

    it('renders an empty control slot when no control is provided', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.row({ title: 'No control' });
            const slot = el.querySelector('.wg-settings-row__control');
            expect(slot.children.length).toBe(0);
        } finally {
            cleanup();
        }
    });

    it('handles no args gracefully (empty row with both columns)', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.row();
            expect(el.classList.contains('wg-settings-row')).toBe(true);
            expect(el.querySelector('.wg-settings-row__content')).not.toBeNull();
            expect(el.querySelector('.wg-settings-row__control')).not.toBeNull();
        } finally {
            cleanup();
        }
    });
});

describe('WGSettings.infoRow', () => {
    it('renders a <div class="wg-settings-info-row"> with label + value spans', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.infoRow({ label: 'Saved Timezone', value: 'Europe/Berlin' });
            expect(el.tagName).toBe('DIV');
            expect(el.classList.contains('wg-settings-info-row')).toBe(true);

            const label = el.querySelector('.wg-settings-info-row__label');
            const value = el.querySelector('.wg-settings-info-row__value');
            expect(label).not.toBeNull();
            expect(label.textContent).toBe('Saved Timezone');
            expect(value).not.toBeNull();
            expect(value.textContent).toBe('Europe/Berlin');
        } finally {
            cleanup();
        }
    });

    it('applies the mono-display class on the value span so it reads as JetBrains Mono', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.infoRow({ label: 'Server Time', value: '2026-04-23 12:00' });
            const value = el.querySelector('.wg-settings-info-row__value');
            expect(value.classList.contains('wg-mono-display')).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('coerces non-string values via String() without crashing', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.infoRow({ label: 'N', value: 42 });
            const value = el.querySelector('.wg-settings-info-row__value');
            expect(value.textContent).toBe('42');
        } finally {
            cleanup();
        }
    });

    it('renders empty value text when value is null/undefined', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.infoRow({ label: 'Empty' });
            const value = el.querySelector('.wg-settings-info-row__value');
            expect(value.textContent).toBe('');
        } finally {
            cleanup();
        }
    });

    it('escapes text content (no HTML injection via label/value)', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.infoRow({
                label: '<b>Label</b>',
                value: '<img src=x onerror=pwn>'
            });
            const label = el.querySelector('.wg-settings-info-row__label');
            const value = el.querySelector('.wg-settings-info-row__value');
            expect(label.querySelector('b')).toBeNull();
            expect(value.querySelector('img')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('handles no args gracefully (empty label + value)', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.infoRow();
            expect(el.classList.contains('wg-settings-info-row')).toBe(true);
            expect(el.querySelector('.wg-settings-info-row__label').textContent).toBe('');
            expect(el.querySelector('.wg-settings-info-row__value').textContent).toBe('');
        } finally {
            cleanup();
        }
    });
});

describe('WGSettings composition', () => {
    it('composes a section containing rows containing controls end-to-end', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const toggle = window.document.createElement('mt-setting-toggle');
            toggle.id = 'bp-feature-toggle';
            const row = window.WGSettings.row({
                title: 'Blood Pressure',
                description: 'Show the BP tracking section',
                control: toggle,
            });
            const section = window.WGSettings.section({
                title: 'Features',
                description: 'Enable or disable sections',
                children: [row],
            });
            const list = section.querySelector('.wg-settings-row-list');
            expect(list.children.length).toBe(1);
            expect(list.firstElementChild).toBe(row);
            expect(row.querySelector('#bp-feature-toggle')).toBe(toggle);
        } finally {
            cleanup();
        }
    });
});
