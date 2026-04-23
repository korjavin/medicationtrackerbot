import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function loadWGToggle() {
    const dom = new JSDOM('<!DOCTYPE html>', { url: 'https://example.test/', runScripts: 'outside-only' });
    const { window } = dom;
    const src = fs.readFileSync(
        path.join(REPO_ROOT, 'web/static/js/components/wg-toggle.js'),
        'utf8'
    );
    window.eval(src);
    return { window, cleanup: () => dom.window.close() };
}

describe('WGToggle', () => {
    it('exposes window.WGToggle.render', () => {
        const { window, cleanup } = loadWGToggle();
        try {
            expect(window.WGToggle).toBeDefined();
            expect(typeof window.WGToggle.render).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('renders a <label class="wg-toggle"> with hidden checkbox, track, and knob', () => {
        const { window, cleanup } = loadWGToggle();
        try {
            const el = window.WGToggle.render({ id: 'x-toggle' });
            expect(el.tagName).toBe('LABEL');
            expect(el.classList.contains('wg-toggle')).toBe(true);

            const input = el.querySelector('input[type="checkbox"]');
            expect(input).not.toBeNull();
            expect(input.classList.contains('wg-toggle__input')).toBe(true);
            expect(input.id).toBe('x-toggle');
            expect(input.checked).toBe(false);
            expect(input.disabled).toBe(false);

            const track = el.querySelector('.wg-toggle__track');
            expect(track).not.toBeNull();
            expect(track.getAttribute('aria-hidden')).toBe('true');

            const knob = el.querySelector('.wg-toggle__knob');
            expect(knob).not.toBeNull();
            expect(knob.getAttribute('aria-hidden')).toBe('true');
        } finally {
            cleanup();
        }
    });

    it('renders with checked=true reflected on the hidden input', () => {
        const { window, cleanup } = loadWGToggle();
        try {
            const el = window.WGToggle.render({ id: 'x', checked: true });
            const input = el.querySelector('input[type="checkbox"]');
            expect(input.checked).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('renders with disabled=true and applies the wg-toggle--disabled modifier', () => {
        const { window, cleanup } = loadWGToggle();
        try {
            const el = window.WGToggle.render({ id: 'x', disabled: true });
            const input = el.querySelector('input[type="checkbox"]');
            expect(input.disabled).toBe(true);
            expect(el.classList.contains('wg-toggle--disabled')).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('applies aria-label to the hidden input when ariaLabel is provided', () => {
        const { window, cleanup } = loadWGToggle();
        try {
            const el = window.WGToggle.render({ id: 'x', ariaLabel: 'Enable BP tracking' });
            const input = el.querySelector('input[type="checkbox"]');
            expect(input.getAttribute('aria-label')).toBe('Enable BP tracking');
        } finally {
            cleanup();
        }
    });

    it('dispatches onToggle(newChecked, event) when the hidden checkbox changes', () => {
        const { window, cleanup } = loadWGToggle();
        try {
            let received = null;
            const el = window.WGToggle.render({
                id: 'x',
                onToggle: (val, ev) => { received = { val, ev }; }
            });
            const input = el.querySelector('input[type="checkbox"]');
            input.checked = true;
            input.dispatchEvent(new window.Event('change'));
            expect(received).not.toBeNull();
            expect(received.val).toBe(true);
            expect(received.ev).toBeDefined();
        } finally {
            cleanup();
        }
    });

    it('clicking the label toggles the hidden checkbox (native label+input binding)', () => {
        const { window, cleanup } = loadWGToggle();
        try {
            const el = window.WGToggle.render({ id: 'x-click' });
            window.document.body.appendChild(el);
            const input = el.querySelector('input[type="checkbox"]');
            expect(input.checked).toBe(false);
            // jsdom implements the native label-for-control activation.
            input.click();
            expect(input.checked).toBe(true);
            input.click();
            expect(input.checked).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('omits id on the hidden input when no id is provided', () => {
        const { window, cleanup } = loadWGToggle();
        try {
            const el = window.WGToggle.render({});
            const input = el.querySelector('input[type="checkbox"]');
            expect(input.id).toBe('');
        } finally {
            cleanup();
        }
    });
});
