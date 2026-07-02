// Tests for the WGRingStack component (Plan 7 "concentric rings", Task 1)
// — the documented component-test exception to integration-first testing
// (CLAUDE.md rule 8). Covers the arc-geometry math: radii for 5 rings don't
// overlap, progress→dash-offset mapping is per-arc, closed forces a full
// arc, and sync-pending renders no progress arc at all.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const WG_RING_STACK_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-ring-stack.js');

function loadEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://example.test/',
        pretendToBeVisual: true,
        runScripts: 'outside-only',
    });
    dom.window.eval(fs.readFileSync(WG_RING_STACK_JS, 'utf8'));
    return {
        window: dom.window,
        api: dom.window.WGRingStack,
        cleanup: () => dom.window.close(),
    };
}

const CANONICAL_RINGS = ['adherence', 'movement', 'vitals', 'nourishment', 'mind'];

describe('WGRingStack.render', () => {
    let env;
    beforeEach(() => { env = loadEnv(); });
    afterEach(() => { env.cleanup(); });

    it('exposes WGRingStack on window with a render function and the geometry constants', () => {
        expect(typeof env.api).toBe('object');
        expect(typeof env.api.render).toBe('function');
        expect(env.api.CIRCUMFERENCE).toBe(100);
        expect(env.api.MAX_RINGS).toBe(5);
    });

    it('radii for 5 rings are monotonically decreasing and never overlap given the stroke width', () => {
        const radii = CANONICAL_RINGS.map((_, i) => env.api.ringRadius(i));
        for (let i = 0; i < radii.length; i++) {
            expect(radii[i]).toBeGreaterThan(0);
            // Outer edge of the outermost ring must stay inside the viewBox.
            expect(radii[i] + env.api.STROKE_WIDTH / 2).toBeLessThanOrEqual(env.api.VIEWBOX_SIZE / 2);
        }
        for (let i = 1; i < radii.length; i++) {
            expect(radii[i - 1]).toBeGreaterThan(radii[i]);
            // Adjacent stroke bands (each extends STROKE_WIDTH/2 either side
            // of its centerline) must not intersect.
            expect(radii[i - 1] - radii[i]).toBeGreaterThan(env.api.STROKE_WIDTH);
        }
    });

    it('returns a wrapper div containing an svg with one track + arc pair per open ring', () => {
        const rings = CANONICAL_RINGS.map((key) => ({ key, progress: 0.5 }));
        const el = env.api.render({ rings });
        expect(el.classList.contains('wg-ring-stack')).toBe(true);
        const svg = el.querySelector('.wg-ring-stack__svg');
        expect(svg).not.toBeNull();
        expect(svg.querySelectorAll('.wg-ring-stack__track').length).toBe(5);
        expect(svg.querySelectorAll('.wg-ring-stack__arc').length).toBe(5);
    });

    it('renders rings outer→inner in input order with decreasing radius', () => {
        const rings = CANONICAL_RINGS.map((key) => ({ key, progress: 0.5 }));
        const el = env.api.render({ rings });
        const tracks = [...el.querySelectorAll('.wg-ring-stack__track')];
        const radii = tracks.map((t) => Number(t.getAttribute('r')));
        for (let i = 1; i < radii.length; i++) {
            expect(radii[i]).toBeLessThan(radii[i - 1]);
        }
    });

    it('progress=0 renders an empty arc (dashoffset reads as the full circumference)', () => {
        const el = env.api.render({ rings: [{ key: 'adherence', progress: 0 }] });
        const arc = el.querySelector('.wg-ring-stack__arc');
        expect(arc.style.getPropertyValue('--ring-progress')).toBe('0');
        expect(arc.getAttribute('stroke-dasharray')).toBe('100');
        expect(arc.getAttribute('pathLength')).toBe('100');
    });

    it('a mid progress value renders a proportionally offset arc, independent of ring radius', () => {
        const el = env.api.render({
            rings: [
                { key: 'adherence', progress: 0.42 },
                { key: 'mind', progress: 0.42 },
            ],
        });
        const arcs = [...el.querySelectorAll('.wg-ring-stack__arc')];
        expect(arcs[0].style.getPropertyValue('--ring-progress')).toBe('42');
        expect(arcs[1].style.getPropertyValue('--ring-progress')).toBe('42');
    });

    it('closed=true forces a full arc and the closed class — regardless of progress', () => {
        const el = env.api.render({ rings: [{ key: 'movement', progress: 0.1, closed: true }] });
        const arc = el.querySelector('.wg-ring-stack__arc');
        expect(arc.style.getPropertyValue('--ring-progress')).toBe('100');
        expect(arc.classList.contains('wg-ring-stack__arc--closed')).toBe(true);
        expect(arc.classList.contains('wg-ring-stack__arc--movement')).toBe(true);
    });

    it('syncPending renders the dimmed track only — no progress arc element at all', () => {
        const el = env.api.render({ rings: [{ key: 'vitals', progress: 0.7, syncPending: true }] });
        expect(el.querySelector('.wg-ring-stack__arc')).toBeNull();
        const track = el.querySelector('.wg-ring-stack__track');
        expect(track).not.toBeNull();
        expect(track.classList.contains('wg-ring-stack__track--sync-pending')).toBe(true);
    });

    it('clamps out-of-range and non-finite progress into [0,1]', () => {
        const over = env.api.render({ rings: [{ key: 'mind', progress: 1.5 }] });
        expect(over.querySelector('.wg-ring-stack__arc').style.getPropertyValue('--ring-progress')).toBe('100');

        const under = env.api.render({ rings: [{ key: 'mind', progress: -0.3 }] });
        expect(under.querySelector('.wg-ring-stack__arc').style.getPropertyValue('--ring-progress')).toBe('0');

        const nan = env.api.render({ rings: [{ key: 'mind', progress: NaN }] });
        expect(nan.querySelector('.wg-ring-stack__arc').style.getPropertyValue('--ring-progress')).toBe('0');
    });

    it('caps rendering at MAX_RINGS even if more rings are passed', () => {
        const rings = [...CANONICAL_RINGS, 'extra'].map((key) => ({ key, progress: 0.5 }));
        const el = env.api.render({ rings });
        expect(el.querySelectorAll('.wg-ring-stack__track').length).toBe(5);
    });

    it('centerLabel accepts a string and renders it as text', () => {
        const el = env.api.render({ rings: [], centerLabel: '3/5' });
        expect(el.querySelector('.wg-ring-stack__center').textContent).toBe('3/5');
    });

    it('centerLabel accepts a Node and appends it as-is', () => {
        const dom = env.window.document;
        const node = dom.createElement('span');
        node.textContent = 'check';
        const el = env.api.render({ rings: [], centerLabel: node });
        expect(el.querySelector('.wg-ring-stack__center').firstChild).toBe(node);
    });

    it('sets no inline color — only the neutral --ring-progress custom property', () => {
        const el = env.api.render({ rings: [{ key: 'adherence', progress: 0.5 }] });
        expect(el.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}/);
        const arc = el.querySelector('.wg-ring-stack__arc');
        expect(arc.getAttribute('style')).toBe('--ring-progress: 50;');
    });
});
