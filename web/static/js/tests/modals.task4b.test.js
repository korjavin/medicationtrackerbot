// Task 4b audit — BP modal + Take-meds (medication confirm) modal.
//
// Both modals were rebuilt to match the Anthropic mockup's shared vocabulary
// (dual-line eyebrow/title header, gloss-inset input wraps, primary = sun
// gloss with 2× flex). This file pins the structural contract so a regression
// shows up immediately instead of hiding inside a larger feature test.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_PATH = path.resolve(__dirname, '../../../../web/static/index.html');
const CSS_PATH = path.resolve(__dirname, '../../../../web/static/css/styles.css');

describe('BP modal — Task 4b audit', () => {
    let env;
    beforeEach(() => { env = loadFrontendEnv(); });
    afterEach(() => { env.cleanup(); env = null; });

    it('opens with the New-entry eyebrow + Blood-pressure mono title', () => {
        env.window.showBPRecordModal();
        const eyebrow = env.document.getElementById('bp-modal-eyebrow');
        const title = env.document.getElementById('bp-modal-title');
        expect(eyebrow.textContent).toBe('New entry');
        expect(title.textContent).toBe('Blood pressure');
        expect(eyebrow.classList.contains('wg-bp-modal__eyebrow')).toBe(true);
        expect(title.classList.contains('wg-mono-display')).toBe(true);
    });

    it('lays out Systolic / Diastolic / Pulse as a single 3-up reading row', () => {
        const html = fs.readFileSync(INDEX_PATH, 'utf8');
        const block = html.match(/<mt-modal[^>]*id="bp-modal"[\s\S]*?<\/mt-modal>/)[0];
        const rowMatch = block.match(/wg-bp-modal__row--readings[\s\S]*?(?=wg-bp-modal__row--meta|wg-bp-modal__actions)/);
        expect(rowMatch, 'expected the sys/dia/pulse readings row').not.toBeNull();
        expect(rowMatch[0]).toMatch(/id="bp-systolic"/);
        expect(rowMatch[0]).toMatch(/id="bp-diastolic"/);
        expect(rowMatch[0]).toMatch(/id="bp-pulse"/);
        // Each reading input carries the 20px reading modifier.
        const readingInputs = rowMatch[0].match(/wg-bp-modal__input--reading/g) || [];
        expect(readingInputs.length).toBe(3);
    });

    it('wraps Site + Position selects in gloss-inset wraps', () => {
        const html = fs.readFileSync(INDEX_PATH, 'utf8');
        const block = html.match(/<mt-modal[^>]*id="bp-modal"[\s\S]*?<\/mt-modal>/)[0];
        expect(block).toMatch(/id="bp-site"[^>]*class="[^"]*wg-bp-modal__select/);
        expect(block).toMatch(/id="bp-position"[^>]*class="[^"]*wg-bp-modal__select/);
        // Both selects sit under a wg-gloss--inset input-wrap parent.
        expect(block).toMatch(/wg-gloss--inset[^"]*wg-bp-modal__input-wrap[\s\S]*?id="bp-site"/);
    });

    it('styles.css defines the header-actions row + header-btn sizing (Cancel/Save moved out of body footer to keep them above the mobile keyboard)', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        expect(css).toMatch(/\.wg-bp-modal__header-actions\s*\{[^}]*display:\s*flex/);
        expect(css).toMatch(/\.wg-bp-modal__header-btn\s*\{[^}]*min-height:\s*36px/);
        expect(css).toMatch(/\.wg-bp-modal__header-btn--save\s*\{[^}]*padding:/);
    });

    it('close button is wired to closeBPRecordModal', () => {
        env.window.showBPRecordModal();
        const modal = env.document.getElementById('bp-modal');
        expect(modal.classList.contains('hidden')).toBe(false);
        env.document.getElementById('bp-modal-close-btn').click();
        expect(modal.classList.contains('hidden')).toBe(true);
    });
});

describe('Take-meds modal — Task 4b audit', () => {
    let env;
    beforeEach(() => { env = loadFrontendEnv(); });
    afterEach(() => { env.cleanup(); env = null; });

    it('renders sun eyebrow + mono title + subtitle in confirm mode', () => {
        env.window.showMedicationConfirmModal(['1', '2'], ['Aspirin', 'Vitamin D'], '2026-02-27T10:00:00Z');

        const eyebrow = env.document.getElementById('med-confirm-eyebrow');
        const title = env.document.getElementById('med-confirm-title');
        const subtitle = env.document.getElementById('med-confirm-subtitle');
        expect(eyebrow.textContent).toBe('Time for meds');
        expect(eyebrow.classList.contains('wg-med-confirm-modal__eyebrow')).toBe(true);
        expect(title.classList.contains('wg-mono-display')).toBe(true);
        expect(subtitle.textContent).toMatch(/Scheduled for:/);
    });

    it('renders each med as a check row with the shared wg-med-confirm-modal vocabulary', () => {
        env.window.showMedicationConfirmModal(['1', '2'], ['Aspirin', 'Vitamin D'], '2026-02-27T10:00:00Z');
        const rows = env.document.querySelectorAll('#med-confirm-list .wg-med-confirm-modal__row');
        expect(rows.length).toBe(2);
        rows.forEach((row) => {
            expect(row.querySelector('.wg-med-confirm-modal__check')).not.toBeNull();
            expect(row.querySelector('.wg-med-confirm-modal__row-name')).not.toBeNull();
            expect(row.querySelector('input.med-confirm-check')).not.toBeNull();
        });
        // Both rows start selected → carry the --on modifier.
        expect(rows[0].classList.contains('wg-med-confirm-modal__row--on')).toBe(true);
        expect(rows[1].classList.contains('wg-med-confirm-modal__row--on')).toBe(true);
    });

    it('unchecking a row drops the --on modifier for that row only', () => {
        env.window.showMedicationConfirmModal(['1', '2'], ['Aspirin', 'Vitamin D'], '2026-02-27T10:00:00Z');
        const rows = env.document.querySelectorAll('#med-confirm-list .wg-med-confirm-modal__row');
        const input = rows[0].querySelector('input.med-confirm-check');
        input.checked = false;
        input.dispatchEvent(new env.window.Event('change', { bubbles: true }));

        expect(rows[0].classList.contains('wg-med-confirm-modal__row--on')).toBe(false);
        expect(rows[1].classList.contains('wg-med-confirm-modal__row--on')).toBe(true);
    });

    it('edit mode toggles the time-edit field visible and hides the secondary buttons via class, not inline style', () => {
        env.window.showMedicationConfirmModal(['1'], ['Aspirin'], '2026-02-28T09:30:00Z', 'edit', [100]);
        const timeEdit = env.document.getElementById('med-confirm-time-edit');
        const snoozeBtn = env.document.getElementById('med-confirm-snooze-btn');
        const skipBtn = env.document.getElementById('med-confirm-skip-btn');
        expect(timeEdit.classList.contains('hidden')).toBe(false);
        expect(snoozeBtn.classList.contains('hidden')).toBe(true);
        expect(skipBtn.classList.contains('hidden')).toBe(true);
        // No inline style leak.
        expect(timeEdit.getAttribute('style')).toBeNull();
        expect(snoozeBtn.getAttribute('style')).toBeNull();
    });

    it('index.html markup does not carry the pre-audit btn-secondary / btn-primary / inline style="..." leaks', () => {
        const html = fs.readFileSync(INDEX_PATH, 'utf8');
        const block = html.match(/<mt-modal[^>]*id="med-confirm-modal"[\s\S]*?<\/mt-modal>/)[0];
        expect(block).not.toMatch(/\bbtn-primary\b/);
        expect(block).not.toMatch(/\bbtn-secondary\b/);
        expect(block).not.toMatch(/\bbtn-danger-outline\b/);
        expect(block).not.toMatch(/style="[^"]*display:\s*none/);
        expect(block).not.toMatch(/style="[^"]*color:\s*#/);
    });

    it('styles.css defines the med-confirm sun eyebrow + primary full-width button + --on highlight', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        expect(css).toMatch(/\.wg-med-confirm-modal__eyebrow\s*\{[^}]*var\(--wg-sun\)/);
        expect(css).toMatch(/\.wg-med-confirm-modal__primary\s*\{[^}]*width:\s*100%/);
        expect(css).toMatch(/\.wg-med-confirm-modal__row--on\s*\{[^}]*var\(--wg-tag-high-bg\)/);
    });
});
