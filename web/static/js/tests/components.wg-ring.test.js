// Tests for the WGRing component (Plan 5 "clarity", Task 3) — the
// documented component-test exception to integration-first testing
// (CLAUDE.md rule 8). Covers the arc-geometry math: progress=0 renders an
// empty arc, progress=1/closed renders a full ring + done state, and a mid
// value renders a proportionally offset arc.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WG_RING_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-ring.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only',
    });
    dom.window.eval(fs.readFileSync(WG_RING_JS, 'utf8'));
    return {
        window: dom.window,
        api: dom.window.WGRing,
        cleanup: () => dom.window.close(),
    };
}

describe('WGRing.render', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('exposes WGRing on window with a render function and the geometry constants', () => {
        expect(typeof env.api).toBe('object');
        expect(typeof env.api.render).toBe('function');
        expect(env.api.CIRCUMFERENCE).toBe(100);
        expect(env.api.RADIUS).toBeCloseTo(15.9155, 3);
    });

    it('returns an svg.wg-ring with a track circle and a progress circle', () => {
        const svg = env.api.render({ progress: 0.5, label: 'Adherence' });
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(svg.classList.contains('wg-ring')).toBe(true);
        expect(svg.querySelector('.wg-ring__track')).not.toBeNull();
        expect(svg.querySelector('.wg-ring__progress')).not.toBeNull();
    });

    it('progress=0 renders an empty arc (dashoffset reads as the full circumference)', () => {
        const svg = env.api.render({ progress: 0, label: 'Adherence' });
        const arc = svg.querySelector('.wg-ring__progress');
        expect(arc.style.getPropertyValue('--ring-progress')).toBe('0');
        expect(arc.getAttribute('stroke-dasharray')).toBe('100');
    });

    it('a mid progress value renders a proportionally offset arc', () => {
        const svg = env.api.render({ progress: 0.42, label: 'Movement' });
        const arc = svg.querySelector('.wg-ring__progress');
        expect(arc.style.getPropertyValue('--ring-progress')).toBe('42');
    });

    it('progress=1 renders a full circle without the closed state', () => {
        const svg = env.api.render({ progress: 1, label: 'Vitals' });
        const arc = svg.querySelector('.wg-ring__progress');
        expect(arc.style.getPropertyValue('--ring-progress')).toBe('100');
        expect(svg.classList.contains('wg-ring--closed')).toBe(false);
        expect(svg.querySelector('.wg-ring__check')).toBeNull();
    });

    it('closed=true forces a full ring, the closed class, and a check mark — regardless of progress', () => {
        const svg = env.api.render({ progress: 0.1, closed: true, label: 'Nourishment' });
        const arc = svg.querySelector('.wg-ring__progress');
        expect(arc.style.getPropertyValue('--ring-progress')).toBe('100');
        expect(svg.classList.contains('wg-ring--closed')).toBe(true);
        expect(svg.querySelector('.wg-ring__check')).not.toBeNull();
    });

    it('clamps out-of-range and non-finite progress into [0,1]', () => {
        const over = env.api.render({ progress: 1.5, label: 'Mind' });
        expect(over.querySelector('.wg-ring__progress').style.getPropertyValue('--ring-progress')).toBe('100');

        const under = env.api.render({ progress: -0.3, label: 'Mind' });
        expect(under.querySelector('.wg-ring__progress').style.getPropertyValue('--ring-progress')).toBe('0');

        const nan = env.api.render({ progress: NaN, label: 'Mind' });
        expect(nan.querySelector('.wg-ring__progress').style.getPropertyValue('--ring-progress')).toBe('0');
    });

    it('builds the accessible name from label + value, and falls back to label alone', () => {
        const withValue = env.api.render({ progress: 0.73, label: 'Adherence', value: '73%' });
        expect(withValue.getAttribute('aria-label')).toBe('Adherence: 73%');

        const withoutValue = env.api.render({ progress: 0.73, label: 'Adherence' });
        expect(withoutValue.getAttribute('aria-label')).toBe('Adherence');
    });

    it('defaults to a 36x36 viewBox and a 36px rendered size, honoring an explicit size override', () => {
        const svg = env.api.render({ progress: 0.5, label: 'Adherence' });
        expect(svg.getAttribute('viewBox')).toBe('0 0 36 36');
        expect(svg.getAttribute('width')).toBe('36');
        expect(svg.getAttribute('height')).toBe('36');

        const sized = env.api.render({ progress: 0.5, label: 'Adherence', size: 64 });
        expect(sized.getAttribute('width')).toBe('64');
        expect(sized.getAttribute('height')).toBe('64');
    });

    it('sets no inline color — only the neutral --ring-progress custom property', () => {
        const svg = env.api.render({ progress: 0.5, label: 'Adherence' });
        expect(svg.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}/);
        const arc = svg.querySelector('.wg-ring__progress');
        expect(arc.getAttribute('style')).toBe('--ring-progress: 50;');
    });
});
