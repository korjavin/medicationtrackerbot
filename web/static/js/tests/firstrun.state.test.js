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
// sessionStorage; the flow restarts from "features" (the W1 picker,
// bd med-ta2n.1) — intentional per the plan's resume-semantics analysis.

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
    it('defaults to "features" when sessionStorage is empty', () => {
        const { window, cleanup } = loadState();
        try {
            expect(window.WGFirstRun.state.getStep()).toBe('features');
        } finally { cleanup(); }
    });

    it('setStep persists a valid step to sessionStorage under wg-firstrun-step', () => {
        const { window, cleanup } = loadState();
        try {
            window.WGFirstRun.state.setStep('trial');
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBe('trial');
            expect(window.WGFirstRun.state.getStep()).toBe('trial');
        } finally { cleanup(); }
    });

    // bd med-ta2n.2 renamed 'integrations' to 'trial': a session stored before
    // the rename resumes on the trial step, and the old name is not settable.
    it('getStep maps a stored pre-rename "integrations" to "trial"', () => {
        const { window, cleanup } = loadState();
        try {
            window.sessionStorage.setItem('wg-firstrun-step', 'integrations');
            expect(window.WGFirstRun.state.getStep()).toBe('trial');
            window.WGFirstRun.state.clear();
            window.WGFirstRun.state.setStep('integrations');
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBeNull();
        } finally { cleanup(); }
    });

    it('setStep ignores unknown step names (defensive against caller typos)', () => {
        const { window, cleanup } = loadState();
        try {
            window.WGFirstRun.state.setStep('trial');
            window.WGFirstRun.state.setStep('not-a-real-step');
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBe('trial');
        } finally { cleanup(); }
    });

    // A session that was mid-flow on the pre-v3 overlay holds one of the
    // removed steps: it lands on the picker, not on an empty panel.
    it('getStep falls back to default for an invalid or removed step name', () => {
        const { window, cleanup } = loadState();
        try {
            for (const stale of ['corrupted', 'welcome', 'done']) {
                window.sessionStorage.setItem('wg-firstrun-step', stale);
                expect(window.WGFirstRun.state.getStep()).toBe('features');
            }
        } finally { cleanup(); }
    });

    it('clear() removes the key so the next getStep returns the default', () => {
        const { window, cleanup } = loadState();
        try {
            window.WGFirstRun.state.setStep('trial');
            window.WGFirstRun.state.clear();
            expect(window.sessionStorage.getItem('wg-firstrun-step')).toBeNull();
            expect(window.WGFirstRun.state.getStep()).toBe('features');
        } finally { cleanup(); }
    });

    it('exposes the canonical step list under VALID_STEPS', () => {
        const { window, cleanup } = loadState();
        try {
            expect(Array.from(window.WGFirstRun.state.VALID_STEPS)).toEqual(['features', 'trial']);
        } finally { cleanup(); }
    });
});
