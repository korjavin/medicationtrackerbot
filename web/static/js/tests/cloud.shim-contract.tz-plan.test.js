// Plan 2026-07-05 cloud-c2b, Task 8 — shim-mode contract run of the TZ
// transition plan banner (web/static/js/features/tz-plan-banner.js) over
// web/domain/tzplan.js. Drives the real window.TZPlanBanner.refresh() /
// mountCard() through window.apiCall, which routes to the cloud shim
// (web/cloud/js/apishim.js) instead of the network — same pattern as
// cloud.shim-contract.bp.test.js.
import {
    afterEach, beforeEach, describe, expect, it, vi
} from 'vitest';
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';
import { planDosesWithTzPlan } from '../../../domain/tzplan.js';

function seedPendingPlan(overrides = {}) {
    return {
        recordId: 'tzplan-current',
        clientTs: Date.now(),
        deleted: false,
        old_tz: 'America/New_York',
        new_tz: 'Asia/Tokyo',
        status: 'PENDING_APPROVAL',
        created_at: new Date().toISOString(),
        steps: [
            {
                medicationId: 1, medName: 'Metformin', stepNumber: 1, totalSteps: 2, scheduledAtMs: Date.now() + 3600_000, note: 'Shift dose 1h'
            },
            {
                medicationId: 1, medName: 'Metformin', stepNumber: 2, totalSteps: 2, scheduledAtMs: Date.now() + 7200_000, note: 'Shift dose 2h'
            }
        ],
        ...overrides
    };
}

describe('cloud shim contract — TZ plan banner (features/tz-plan-banner.js over web/domain/tzplan.js)', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv({ seedRecords: { tzplan: [seedPendingPlan()] } });
        env.window.reloadCurrentTab = vi.fn();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('renders the pending plan as an actionable card with Apply/Cancel', async () => {
        const { window, document } = env;

        await window.TZPlanBanner.refresh();
        const root = document.createElement('div');
        const card = window.TZPlanBanner.mountCard(root);

        expect(card).not.toBeNull();
        expect(card.querySelector('.wg-tz-plan-card__value').textContent).toContain('America/New_York');
        expect(card.querySelector('.wg-tz-plan-card__value').textContent).toContain('Asia/Tokyo');
        expect(card.querySelectorAll('button')).toHaveLength(2);
    });

    it('Apply approves the plan and updates settings.timezone', async () => {
        const { window, document } = env;

        await window.TZPlanBanner.refresh();
        const root = document.createElement('div');
        const card = window.TZPlanBanner.mountCard(root);
        const applyBtn = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Apply');

        applyBtn.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(window.reloadCurrentTab).toHaveBeenCalled();
        const { plan } = await window.apiCall('/api/tz-plan/current');
        expect(plan.status).toBe('APPROVED');
        const settings = await window.apiCall('/api/settings');
        expect(settings.timezone).toBe('Asia/Tokyo');
    });

    it('Cancel rejects the plan and reverts settings.timezone', async () => {
        const { window, document } = env;

        await window.TZPlanBanner.refresh();
        const root = document.createElement('div');
        const card = window.TZPlanBanner.mountCard(root);
        const cancelBtn = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');

        cancelBtn.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(window.reloadCurrentTab).toHaveBeenCalled();
        const { plan } = await window.apiCall('/api/tz-plan/current');
        expect(plan.status).toBe('REJECTED');
        const settings = await window.apiCall('/api/settings');
        expect(settings.timezone).toBe('America/New_York');
    });
});

// planDosesWithTzPlan suppression rule — mirrors the server's
// MedsWithFuturePendingTZStepsForPlan gate: a med's normal doses are only
// dropped while that med still has a FUTURE step. In a multi-med plan an
// early-finishing med must resume its normal schedule even though the plan is
// still APPROVED because another med has steps left.
describe('planDosesWithTzPlan — per-med future-step suppression (web/domain/tzplan.js)', () => {
    it('resumes an early-finishing med\'s normal doses while a later med still has future steps', () => {
        const now = Date.UTC(2026, 0, 15, 6, 0); // 06:00 UTC
        const window = 12 * 3600_000; // 12h forecast
        const timeZone = 'UTC';

        // Both meds dose daily at 12:00 UTC → next dose is now+6h (in window).
        const medications = [
            { id: 1, name: 'MedA', schedule: '12:00' },
            { id: 2, name: 'MedB', schedule: '12:00' }
        ];

        const tzPlan = {
            recordId: 'tzplan-current',
            status: 'APPROVED',
            steps: [
                // MedA finished: its only step is already in the past.
                { medicationId: 1, medName: 'MedA', scheduledAtMs: now - 3600_000, stepNumber: 1 },
                // MedB still transitioning: a step 9h out, i.e. its transition
                // is still running when its normal now+6h dose would land.
                { medicationId: 2, medName: 'MedB', scheduledAtMs: now + 9 * 3600_000, stepNumber: 1 }
            ]
        };

        const targets = planDosesWithTzPlan({
            medications, timeZone, now, window, tzPlan
        });

        const medANormal = targets.filter((t) => t.medicationId === 1 && t.source === 'normal_schedule');
        const medBNormal = targets.filter((t) => t.medicationId === 2 && t.source === 'normal_schedule');
        const medBStep = targets.filter((t) => t.medicationId === 2 && t.source === 'tz_step');

        // MedA (no future step) resumes its normal schedule...
        expect(medANormal).toHaveLength(1);
        // ...while MedB (mid-transition) stays suppressed and shows its step.
        expect(medBNormal).toHaveLength(0);
        expect(medBStep).toHaveLength(1);
    });

    // The suppression is judged per TARGET, not once against `now`. Judging it
    // once meant a forecast dropped every normal dose in the window as soon as
    // the med had any future step — including doses landing well AFTER the
    // last step, which materializeDueDoses will create when that instant
    // arrives. The forecast then under-reported reality and the reminder
    // horizon skipped a real dose.
    it('keeps a normal dose that lands after the medication\'s last step', () => {
        const now = Date.UTC(2026, 0, 15, 0, 0);
        const timeZone = 'UTC';
        const medications = [{ id: 1, name: 'MedA', schedule: '20:00' }];
        const tzPlan = {
            recordId: 'tzplan-current',
            status: 'APPROVED',
            steps: [{ medicationId: 1, medName: 'MedA', scheduledAtMs: now + 2 * 3600_000, stepNumber: 1, totalSteps: 1 }]
        };

        const targets = planDosesWithTzPlan({
            medications, timeZone, now, window: 24 * 3600_000, tzPlan
        });

        expect(targets.map((t) => [t.source, t.scheduledAtMs - now])).toEqual([
            ['tz_step', 2 * 3600_000],
            ['normal_schedule', 20 * 3600_000]
        ]);
    });

    // Fire mode is unchanged: every target is at-or-before `now`, so any step
    // still ahead covers them all and the med stays fully suppressed.
    it('still suppresses a due normal dose while a step is ahead of it (fire mode)', () => {
        const now = Date.UTC(2026, 0, 15, 21, 0);
        const targets = planDosesWithTzPlan({
            medications: [{ id: 1, name: 'MedA', schedule: '20:00' }],
            timeZone: 'UTC',
            now,
            window: 0,
            tzPlan: {
                recordId: 'tzplan-current',
                status: 'APPROVED',
                steps: [{ medicationId: 1, medName: 'MedA', scheduledAtMs: now + 2 * 3600_000, stepNumber: 1 }]
            }
        });

        expect(targets).toEqual([]);
    });
});
