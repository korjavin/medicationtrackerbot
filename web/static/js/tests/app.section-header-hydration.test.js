/**
 * Task 3 — Section header hydration via switchTab.
 *
 * Each non-Today section view in index.html contains a placeholder
 *   <div class="section-header-mount" data-title="…">…</div>
 * which switchTab() hydrates into a real <header class="section-header">.
 *
 * These tests verify:
 *   - switchTab hydrates the mount exactly once (no duplicates on re-entry)
 *   - the generated header carries the right title and a working back button
 *   - food-view's experimental badge renders in the right slot
 *   - Today view itself doesn't grow an inline mount-based header (its header
 *     comes from renderToday, not from hydrateSectionHeader)
 */
import { describe, it, expect, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const SECTION_TITLES = {
    meds: 'Medications',
    bp: 'Blood Pressure',
    weight: 'Weight',
    workouts: 'Workouts',
    food: 'Food Intake',
    health: 'Health',
    settings: 'Settings'
};

describe('Section header hydration — switchTab', () => {
    it('every section view ships with a .section-header-mount placeholder', () => {
        const { document, cleanup } = loadFrontendEnv();
        try {
            for (const tab of Object.keys(SECTION_TITLES)) {
                const view = document.getElementById(`${tab}-view`);
                expect(view, `#${tab}-view exists`).not.toBeNull();
                const mount = view.querySelector('.section-header-mount');
                expect(mount, `${tab}-view has a .section-header-mount placeholder`).not.toBeNull();
                expect(mount.dataset.title).toBe(SECTION_TITLES[tab]);
            }
        } finally {
            cleanup();
        }
    });

    it('switching to a section replaces the mount with a rendered section header', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.loadBPReadings = vi.fn();

            window.switchTab('bp');

            const view = document.getElementById('bp-view');
            const mount = view.querySelector('.section-header-mount');
            expect(mount).toBeNull();
            const header = view.querySelector('.section-header');
            expect(header).not.toBeNull();
            const title = header.querySelector('.section-title');
            expect(title.textContent).toBe('Blood Pressure');
        } finally {
            cleanup();
        }
    });

    it('switching away and back does not duplicate the section header', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.loadBPReadings = vi.fn();
            window.loadWeightLogs = vi.fn();

            window.switchTab('bp');
            window.switchTab('weight');
            window.switchTab('bp');

            const view = document.getElementById('bp-view');
            const headers = view.querySelectorAll('.section-header');
            expect(headers.length).toBe(1);
            const mounts = view.querySelectorAll('.section-header-mount');
            expect(mounts.length).toBe(0);
        } finally {
            cleanup();
        }
    });

    it('back button on a section header returns to Today', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.loadBPReadings = vi.fn();

            window.switchTab('bp');
            const view = document.getElementById('bp-view');
            const back = view.querySelector('.section-header .section-back');
            expect(back).not.toBeNull();

            back.click();

            const todayView = document.getElementById('today-view');
            expect(todayView.classList.contains('active')).toBe(true);
            expect(view.classList.contains('active')).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('food-view hydration places an experimental badge in the right slot', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.loadFoodLogs = vi.fn();
            window.featureSettings = { food: true, bp: true, weight: true, medication: true, workout: true, health: true };

            window.switchTab('food');
            const view = document.getElementById('food-view');
            const header = view.querySelector('.section-header');
            expect(header).not.toBeNull();
            const badge = header.querySelector('.section-header-right .badge');
            expect(badge).not.toBeNull();
            expect(badge.classList.contains('badge-experimental')).toBe(true);
            expect(badge.textContent).toBe('experimental');
        } finally {
            cleanup();
        }
    });

    it('workouts section title drops the emoji prefix', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.loadWorkouts = vi.fn();

            window.switchTab('workouts');
            const view = document.getElementById('workouts-view');
            const title = view.querySelector('.section-header .section-title');
            expect(title).not.toBeNull();
            expect(title.textContent).toBe('Workouts');
            expect(title.textContent).not.toMatch(/🏋/);
        } finally {
            cleanup();
        }
    });

    it('today-view never gets a mount-based section header injected by switchTab', () => {
        const { document, cleanup } = loadFrontendEnv();
        try {
            const todayView = document.getElementById('today-view');
            // today-view has no .section-header-mount placeholder — it's built
            // by renderToday, not by hydrateSectionHeader.
            expect(todayView.querySelector('.section-header-mount')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('section header sits above any sub-tab group in the view', () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            // Stub loaders to avoid async DOM access after test teardown.
            window.loadMeds = vi.fn(async () => {});
            window.loadHistory = vi.fn(async () => {});
            window.reloadCurrentTab = vi.fn();
            window.switchTab('meds');

            const view = document.getElementById('meds-view');
            const header = view.querySelector('.section-header');
            const medTabs = view.querySelector('.med-tabs');
            expect(header).not.toBeNull();
            expect(medTabs).not.toBeNull();

            // header should precede .med-tabs in DOM order
            const pos = header.compareDocumentPosition(medTabs);
            // DOCUMENT_POSITION_FOLLOWING === 4
            expect(pos & 4).toBe(4);
        } finally {
            cleanup();
        }
    });
});
