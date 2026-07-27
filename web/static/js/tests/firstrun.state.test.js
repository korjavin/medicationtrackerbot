import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const STATE_JS = path.join(REPO_ROOT, 'web/static/js/features/firstrun/state.js');

// features/firstrun/state.js — Task 3 of the mobile Phase 2c plan.
// The step tracker persists the current first-run screen to
// sessionStorage so a mid-flow process kill resumes at the last visible
// step on the next bootstrap. A full device power-cycle wipes
// sessionStorage; the flow restarts from "welcome" — intentional per
// the plan's resume-semantics analysis.

const SHELL_HTML = `<!doctype html><html><body></body></html>`;

function loadState() {
    const dom = new JSDOM(SHELL_HTML, {
        url: 'https://example.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const stateSrc = fs.readFileSync(STATE_JS, 'utf8');
    window.eval(`${stateSrc}\n//# sourceURL=file://${STATE_JS}`);
    return { window, cleanup: () => dom.window.close() };
}

describe('WGFirstRun.state — step tracker', () => {
    it('defaults to "welcome" when sessionStorage is empty', () => {
        const { window, cleanup } = loadState();
        try {
            expect(window.WGFirstRun.state.getStep()).toBe('welcome');
        } finally { cleanup(); }
    });

    it('setStep persists a valid step to sessionStorage under wg-firstrun-step', () => {
        const { window, cleanup } = loadState();
        try {
            window.WGFirstRun.state.setStep('features');
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBe('features');
            expect(window.WGFirstRun.state.getStep()).toBe('features');
        } finally { cleanup(); }
    });

    it('setStep ignores unknown step names (defensive against caller typos)', () => {
        const { window, cleanup } = loadState();
        try {
            window.WGFirstRun.state.setStep('welcome');
            window.WGFirstRun.state.setStep('not-a-real-step');
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBe('welcome');
            expect(window.WGFirstRun.state.getStep()).toBe('welcome');
        } finally { cleanup(); }
    });

    it('getStep falls back to default when sessionStorage holds an invalid value', () => {
        const { window, cleanup } = loadState();
        try {
            // Direct write bypasses setStep's validation — simulates a stale
            // entry from an older app version with different step names.
            window.sessionStorage.setItem('wg-firstrun-step', 'corrupted');
            expect(window.WGFirstRun.state.getStep()).toBe('welcome');
        } finally { cleanup(); }
    });

    it('clear() removes the key so the next getStep returns the default', () => {
        const { window, cleanup } = loadState();
        try {
            window.WGFirstRun.state.setStep('done');
            expect(window.WGFirstRun.state.getStep()).toBe('done');

            window.WGFirstRun.state.clear();
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBeNull();
            expect(window.WGFirstRun.state.getStep()).toBe('welcome');
        } finally { cleanup(); }
    });

    it('exposes the canonical step list under VALID_STEPS', () => {
        const { window, cleanup } = loadState();
        try {
            expect(Array.from(window.WGFirstRun.state.VALID_STEPS)).toEqual([
                'welcome', 'features', 'integrations', 'done',
            ]);
        } finally { cleanup(); }
    });

    it('round-trips every valid step', () => {
        const { window, cleanup } = loadState();
        try {
            for (const step of window.WGFirstRun.state.VALID_STEPS) {
                window.WGFirstRun.state.setStep(step);
                expect(window.WGFirstRun.state.getStep()).toBe(step);
            }
        } finally { cleanup(); }
    });
});
