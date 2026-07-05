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
