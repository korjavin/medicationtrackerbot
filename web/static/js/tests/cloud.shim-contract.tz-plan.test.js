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
import { createTzPlanDomain, planDosesWithTzPlan } from '../../../domain/tzplan.js';

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

// bd med-gut.3 — an APPROVED plan used to vanish from the UI while its steps
// kept shifting dose times, so the user saw "something happened but what
// exactly is unclear". The card now stays on Today, read-only, until
// refreshPlanStatus flips the plan to COMPLETED.
describe('TZ plan banner — approved plan in progress (bd med-gut.3)', () => {
    let env;

    function seedApprovedPlan() {
        const nowMs = Date.now();
        return seedPendingPlan({
            status: 'APPROVED',
            approved_at: new Date(nowMs).toISOString(),
            steps: [
                {
                    medicationId: 1, medName: 'Metformin', stepNumber: 1, totalSteps: 3, scheduledAtMs: nowMs - 3600_000, note: 'Metformin: step 1/3 — done'
                },
                {
                    medicationId: 1, medName: 'Metformin', stepNumber: 2, totalSteps: 3, scheduledAtMs: nowMs + 3600_000, note: 'Metformin: step 2/3 — 08:00 EST old / 22:00 JST new'
                },
                {
                    medicationId: 1, medName: 'Metformin', stepNumber: 3, totalSteps: 3, scheduledAtMs: nowMs + 7200_000, note: 'Metformin: step 3/3 — 09:00 EST old / 23:00 JST new'
                }
            ]
        });
    }

    beforeEach(() => {
        env = loadCloudShimFrontendEnv({ seedRecords: { tzplan: [seedApprovedPlan()] } });
        env.window.reloadCurrentTab = vi.fn();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('renders a read-only in-progress card with direction, progress, next dose and remaining steps', async () => {
        const { window, document } = env;

        await window.TZPlanBanner.refresh();
        const root = document.createElement('div');
        const card = window.TZPlanBanner.mountCard(root);

        expect(card).not.toBeNull();
        expect(card.querySelector('.wg-next-action-card__kicker').textContent).toBe('Transition in progress');

        const value = card.querySelector('.wg-tz-plan-card__value').textContent;
        expect(value).toContain('America/New_York');
        expect(value).toContain('Asia/Tokyo');

        const details = [...card.querySelectorAll('.wg-tz-plan-card__detail')].map((el) => el.textContent);
        expect(details[0]).toBe('1 of 3 steps done');
        expect(details[1]).toContain('Next shifted dose:');
        expect(details[1]).toContain('Metformin');

        // Read-only: no Apply/Cancel on an already-approved plan.
        expect(card.querySelectorAll('button')).toHaveLength(0);

        // Only the two future steps are "remaining"; the past one is dropped.
        expect(card.querySelector('.wg-tz-plan-card__details-summary').textContent)
            .toBe('2 transition doses left');
        const notes = [...card.querySelectorAll('.wg-tz-plan-card__details-list li')]
            .map((li) => li.textContent);
        expect(notes).toEqual([
            'Metformin: step 2/3 — 08:00 EST old / 22:00 JST new',
            'Metformin: step 3/3 — 09:00 EST old / 23:00 JST new'
        ]);
    });

    it('drops the card once every step is past and refreshPlanStatus flips the plan to COMPLETED', async () => {
        const { window, document } = env;

        await window.TZPlanBanner.refresh();
        expect(window.TZPlanBanner.mountCard(document.createElement('div'))).not.toBeNull();
        window.reloadCurrentTab.mockClear();

        // Same call the shim's materialization sweep makes, on a clock past the
        // last step — driven explicitly so the flip is deterministic.
        const afterAllSteps = Date.now() + 24 * 3600_000;
        await createTzPlanDomain({
            records: env.records, now: () => afterAllSteps, timeZone: 'UTC'
        }).refreshPlanStatus();

        const { plan } = await window.apiCall('/api/tz-plan/current');
        expect(plan.status).toBe('COMPLETED');

        await window.TZPlanBanner.refresh();
        expect(window.TZPlanBanner.mountCard(document.createElement('div'))).toBeNull();
        expect(window.reloadCurrentTab).toHaveBeenCalled();
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
                // MedB still transitioning: a step 3h out (inside the window).
                { medicationId: 2, medName: 'MedB', scheduledAtMs: now + 3 * 3600_000, stepNumber: 1 }
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
        // ...while MedB (future step) stays suppressed and shows its step.
        expect(medBNormal).toHaveLength(0);
        expect(medBStep).toHaveLength(1);
    });
});
