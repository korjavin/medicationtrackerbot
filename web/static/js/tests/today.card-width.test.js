// Round-2 defects — #1: the Today "Next up" meds card had a wider inline
// footprint than its sibling cards (kcal/fuel, workout+sleep).
//
// Root cause: `.wg-next-action-card` is rendered on a <div>, which defaults
// to `box-sizing: content-box` — so `width: 100%` measured the content box
// only and the padding extended *outside* the Today-stage gutter. The sibling
// `.wg-fuel-card` renders on a <button> and picks up `box-sizing: border-box`
// from the UA stylesheet, so the two cards disagreed on edge alignment.
//
// This test pins the fix by asserting every Today card class declares
// `box-sizing: border-box` in `css/styles.css` — making the layout UA-agnostic
// and keeping the meds card inside the same gutter as its siblings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const STYLES_CSS = path.join(REPO_ROOT, 'web/static/css/styles.css');
const EMPTY_STATE_JS = path.join(REPO_ROOT, 'web/static/js/components/empty-state.js');
const WG_ICONS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');
const TODAY_JS = path.join(REPO_ROOT, 'web/static/js/features/today.js');

// Return the body of the FIRST `selector { ... }` block in css. We match the
// opening brace that immediately follows the selector (not a nested rule)
// by anchoring on a line boundary before the selector token.
function ruleBody(css, selector) {
    const needle = `\n${selector} {`;
    const startIdx = css.indexOf(needle);
    if (startIdx === -1) return null;
    const bodyStart = startIdx + needle.length;
    const bodyEnd = css.indexOf('\n}', bodyStart);
    if (bodyEnd === -1) return null;
    return css.slice(bodyStart, bodyEnd);
}

function presentState(now) {
    return {
        greeting: { value: 'Good morning', deeplink: null, status: 'ok' },
        nextMed: {
            value: { scheduledAt: new Date(now.getTime() + 45 * 60000).toISOString(), names: ['Aspirin'] },
            deeplink: 'meds',
            status: 'ok'
        },
        bpLatest: {
            value: { systolic: 120, diastolic: 78, measured_at: new Date(now.getTime() - 30 * 60000).toISOString() },
            deeplink: 'bp',
            status: 'ok'
        },
        bpTrend7d: { value: null, deeplink: 'bp', status: 'missing' },
        weightLatest: {
            value: { weight: 80, measured_at: new Date(now.getTime() - 24 * 60 * 60000).toISOString() },
            deeplink: 'weight',
            status: 'ok'
        },
        weightTrend7d: { value: null, deeplink: 'weight', status: 'missing' },
        caloriesToday: { value: 1200, deeplink: 'food', status: 'ok' },
        caloriesTarget: { value: 2000, deeplink: 'food', status: 'ok' },
        macrosToday: { value: { protein: 60, carbs: 140, fat: 40 }, deeplink: 'food', status: 'ok' },
        macrosTarget: { value: { protein: 120, carbs: 220, fat: 60 }, deeplink: 'food', status: 'ok' },
        nextWorkout: {
            value: { scheduled_date: '2026-04-25', scheduled_time: '18:00', group_name: 'Pull day', is_today: true },
            deeplink: 'workouts',
            status: 'ok'
        },
        sleepLastNight: { value: { hours: 7.5, day: '2026-04-24' }, deeplink: 'health', status: 'ok' }
    };
}

describe('Round-2 defect #1 — Today "Next up" card width parity', () => {
    it('every Today card class declares box-sizing: border-box in styles.css', () => {
        const css = fs.readFileSync(STYLES_CSS, 'utf8');
        const classes = [
            '.wg-next-action-card',
            '.wg-fuel-card',
            '.wg-metric-tile',
            '.wg-plan-tile',
            '.wg-shortcut-tile'
        ];
        for (const sel of classes) {
            const body = ruleBody(css, sel);
            expect(body, `missing rule body for ${sel}`).not.toBeNull();
            expect(body, `${sel} must declare box-sizing: border-box`).toMatch(/box-sizing\s*:\s*border-box/);
        }
    });

    describe('rendered Today DOM', () => {
        let dom;
        let document;
        let render;

        beforeEach(() => {
            dom = new JSDOM('<!DOCTYPE html><html><body><div id="today-content"></div></body></html>', {
                url: 'https://example.test/',
                pretendToBeVisual: true,
                runScripts: 'outside-only'
            });
            const { window } = dom;
            window.eval(fs.readFileSync(EMPTY_STATE_JS, 'utf8') + '\nwindow.createEmptyState = createEmptyState;');
            window.eval(fs.readFileSync(WG_ICONS_JS, 'utf8'));
            window.eval(fs.readFileSync(WG_SPARKLINE_JS, 'utf8'));
            window.eval(fs.readFileSync(TODAY_JS, 'utf8'));
            document = window.document;
            render = window.TodayDashboard.renderToday;
        });

        afterEach(() => { dom?.window.close(); dom = null; });

        it('meds card lives inside the Today root and the fuel card is a <button> sibling', () => {
            const root = document.getElementById('today-content');
            const now = new Date('2026-04-25T09:00:00Z');
            render(presentState(now), root, { now });

            const fuelCard = root.querySelector('.wg-fuel-card');
            const medsCard = root.querySelector('.wg-today-meds');

            expect(fuelCard).not.toBeNull();
            expect(medsCard).not.toBeNull();

            // Both cards sit as direct children of the Today root — no extra
            // wrapper with different padding can slip between them and skew
            // the inline gutter.
            expect(fuelCard.parentElement).toBe(root);
            expect(medsCard.parentElement).toBe(root);

            // Meds card must carry `.wg-next-action-card` so the shared
            // border-box rule from Task 3 applies; otherwise the meds-only
            // `.wg-today-meds` class would leave width sizing to content-box.
            expect(medsCard.classList.contains('wg-next-action-card')).toBe(true);
        });
    });
});
