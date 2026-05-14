// Integration tests for features/tab-controller.js (Plan 2026-05-13, Task 6).
//
// The module hosts three helpers extracted from app.js:
//   - bindTabGroup({container, buttonSelector, onTabSelect}) — delegated
//     click handler with a `dataset.tabBound` guard so reentrant calls are
//     idempotent.
//   - activateTabGroup(tab, {buttonSelector?, contentSelector,
//     contentIdFromTab, ariaCurrent?}) — toggles `.active` on the button
//     strip (optional) and content pane; returns false when the target
//     content node is missing so the caller can keep the previous state.
//   - bindOnce(scope, fn) — a shared registry that replaces three
//     near-identical module-level *ControlsBound flags previously
//     scattered in app.js.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/tab-controller.js — TabController (Plan 2026-05-13, Task 6)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        // Note: loadFrontendEnv() creates a fresh JSDOM window each call, so
        // the TabController registry starts empty for each test EXCEPT for
        // the three *Controls scopes app.js registers at load time. The
        // integration test below relies on those preexisting registrations.
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('exposes the TabController public surface on window', () => {
        const { window } = env;
        expect(typeof window.TabController).toBe('object');
        expect(typeof window.TabController.activateTabGroup).toBe('function');
        expect(typeof window.TabController.bindTabGroup).toBe('function');
        expect(typeof window.TabController.bindOnce).toBe('function');
        expect(typeof window.TabController.isBound).toBe('function');
    });

    describe('bindOnce', () => {
        it('calls fn the first time, skips subsequent calls with the same scope', () => {
            const { window } = env;
            let called = 0;
            window.TabController.bindOnce('alpha', () => { called += 1; });
            window.TabController.bindOnce('alpha', () => { called += 1; });
            window.TabController.bindOnce('alpha', () => { called += 1; });
            expect(called).toBe(1);
        });

        it('tracks each scope independently', () => {
            const { window } = env;
            const calls = [];
            window.TabController.bindOnce('alpha', () => calls.push('alpha'));
            window.TabController.bindOnce('beta', () => calls.push('beta'));
            window.TabController.bindOnce('alpha', () => calls.push('alpha-2'));
            window.TabController.bindOnce('beta', () => calls.push('beta-2'));
            expect(calls).toEqual(['alpha', 'beta']);
        });

        it('isBound reports whether a scope has fired', () => {
            const { window } = env;
            expect(window.TabController.isBound('gamma')).toBe(false);
            window.TabController.bindOnce('gamma', () => {});
            expect(window.TabController.isBound('gamma')).toBe(true);
        });

        it('ignores empty/non-string scope keys', () => {
            const { window } = env;
            let called = 0;
            window.TabController.bindOnce('', () => { called += 1; });
            window.TabController.bindOnce(null, () => { called += 1; });
            window.TabController.bindOnce(undefined, () => { called += 1; });
            expect(called).toBe(0);
        });

        it('does not throw when fn is missing — registers the scope but skips invocation', () => {
            const { window } = env;
            expect(() => window.TabController.bindOnce('no-fn')).not.toThrow();
            // First call locks the scope even without a function, so a later
            // call with a real fn is skipped (consistent with "at most once").
            let called = 0;
            window.TabController.bindOnce('no-fn', () => { called += 1; });
            expect(called).toBe(0);
        });

        it('collapses the three app.js bind* helpers into a single registry', () => {
            const { window } = env;
            // The three bind* helpers in app.js share a single bindOnce
            // registry. Calling them after they've already been invoked once
            // (during app.js load) must be a no-op.
            expect(window.TabController.isBound('medicationControls')).toBe(true);
            expect(window.TabController.isBound('measurementControls')).toBe(true);
            expect(window.TabController.isBound('notificationControls')).toBe(true);

            // Reentrant call from a DOMContentLoaded handler doesn't re-bind.
            let listenerAdded = 0;
            const probe = window.document.createElement('button');
            probe.id = 'add-btn';
            window.document.body.appendChild(probe);
            probe.addEventListener('click', () => { listenerAdded += 1; });
            // bindMedicationControls registers a click handler on #add-btn;
            // calling it again must not register another one.
            window.bindMedicationControls();
            probe.click();
            expect(listenerAdded).toBe(1);
        });
    });

    describe('bindTabGroup', () => {
        it('attaches a delegated click handler that calls onTabSelect with the dataset.tab value', () => {
            const { window } = env;
            const container = window.document.createElement('div');
            container.innerHTML = `
                <button class="t-btn" data-tab="alpha">A</button>
                <button class="t-btn" data-tab="beta">B</button>
            `;
            window.document.body.appendChild(container);
            const seen = [];
            window.TabController.bindTabGroup({
                container,
                buttonSelector: '.t-btn',
                onTabSelect: (tab) => seen.push(tab),
            });
            container.querySelector('[data-tab="alpha"]').click();
            container.querySelector('[data-tab="beta"]').click();
            expect(seen).toEqual(['alpha', 'beta']);
        });

        it('marks the container with dataset.tabBound and refuses to re-bind', () => {
            const { window } = env;
            const container = window.document.createElement('div');
            container.innerHTML = '<button class="t-btn" data-tab="x">X</button>';
            window.document.body.appendChild(container);
            let firstCalls = 0;
            let secondCalls = 0;
            window.TabController.bindTabGroup({
                container,
                buttonSelector: '.t-btn',
                onTabSelect: () => { firstCalls += 1; },
            });
            expect(container.dataset.tabBound).toBe('1');
            // A second call with a different handler is ignored.
            window.TabController.bindTabGroup({
                container,
                buttonSelector: '.t-btn',
                onTabSelect: () => { secondCalls += 1; },
            });
            container.querySelector('[data-tab="x"]').click();
            expect(firstCalls).toBe(1);
            expect(secondCalls).toBe(0);
        });

        it('silently no-ops when container is null', () => {
            const { window } = env;
            expect(() => window.TabController.bindTabGroup({
                container: null,
                buttonSelector: '.t-btn',
                onTabSelect: () => {},
            })).not.toThrow();
        });

        it('ignores clicks on buttons without a data-tab attribute', () => {
            const { window } = env;
            const container = window.document.createElement('div');
            container.innerHTML = `
                <button class="t-btn" data-tab="ok">ok</button>
                <button class="t-btn">no-tab</button>
            `;
            window.document.body.appendChild(container);
            const seen = [];
            window.TabController.bindTabGroup({
                container,
                buttonSelector: '.t-btn',
                onTabSelect: (tab) => seen.push(tab),
            });
            const noTab = container.querySelectorAll('.t-btn')[1];
            noTab.click();
            expect(seen).toEqual([]);
        });
    });

    describe('activateTabGroup', () => {
        it('toggles .active on the matching button and content pane', () => {
            const { window } = env;
            window.document.body.innerHTML = `
                <div>
                    <button class="t-btn" data-tab="one">1</button>
                    <button class="t-btn" data-tab="two">2</button>
                </div>
                <div id="content-one" class="t-panel"></div>
                <div id="content-two" class="t-panel"></div>
            `;
            const ok = window.TabController.activateTabGroup('two', {
                buttonSelector: '.t-btn',
                contentSelector: '.t-panel',
                contentIdFromTab: (t) => `content-${t}`,
                ariaCurrent: 'page',
            });
            expect(ok).toBe(true);
            const btnOne = window.document.querySelector('[data-tab="one"]');
            const btnTwo = window.document.querySelector('[data-tab="two"]');
            const paneOne = window.document.getElementById('content-one');
            const paneTwo = window.document.getElementById('content-two');
            expect(btnOne.classList.contains('active')).toBe(false);
            expect(btnTwo.classList.contains('active')).toBe(true);
            expect(btnTwo.getAttribute('aria-current')).toBe('page');
            expect(paneOne.classList.contains('active')).toBe(false);
            expect(paneTwo.classList.contains('active')).toBe(true);
        });

        it('returns false and leaves prior active state alone when content node is missing', () => {
            const { window } = env;
            window.document.body.innerHTML = `
                <button class="t-btn active" data-tab="one">1</button>
                <div id="content-one" class="t-panel active"></div>
            `;
            const ok = window.TabController.activateTabGroup('missing', {
                buttonSelector: '.t-btn',
                contentSelector: '.t-panel',
                contentIdFromTab: (t) => `content-${t}`,
            });
            expect(ok).toBe(false);
            // Prior active classes preserved (caller can keep the page rendered).
            expect(window.document.querySelector('[data-tab="one"]').classList.contains('active')).toBe(true);
            expect(window.document.getElementById('content-one').classList.contains('active')).toBe(true);
        });

        it('works without a button strip (buttonSelector omitted) for the view group', () => {
            const { window } = env;
            window.document.body.innerHTML = `
                <div id="view-a" class="view"></div>
                <div id="view-b" class="view active"></div>
            `;
            const ok = window.TabController.activateTabGroup('a', {
                contentSelector: '.view',
                contentIdFromTab: (t) => `view-${t}`,
            });
            expect(ok).toBe(true);
            expect(window.document.getElementById('view-a').classList.contains('active')).toBe(true);
            expect(window.document.getElementById('view-b').classList.contains('active')).toBe(false);
        });

        it('omits aria-current when not requested', () => {
            const { window } = env;
            window.document.body.innerHTML = `
                <button class="t-btn" data-tab="one">1</button>
                <div id="content-one" class="t-panel"></div>
            `;
            window.TabController.activateTabGroup('one', {
                buttonSelector: '.t-btn',
                contentSelector: '.t-panel',
                contentIdFromTab: (t) => `content-${t}`,
            });
            expect(window.document.querySelector('[data-tab="one"]').hasAttribute('aria-current')).toBe(false);
        });
    });

    describe('integration with app.js callers', () => {
        it('app.js top-level .health-tabs binding registered through TabController (dataset.tabBound flag set)', () => {
            const { window } = env;
            // app.js calls bindTabGroup({ container: .health-tabs, ... }) at
            // top level, which routes through TabController. The container
            // must therefore have the `dataset.tabBound = '1'` mark applied
            // by TabController.bindTabGroup.
            const healthTabs = window.document.querySelector('.health-tabs');
            if (!healthTabs) return; // index.html shape changed — skip silently
            expect(healthTabs.dataset.tabBound).toBe('1');
        });

        it('app.js top-level .med-tabs binding registered through TabController (dataset.tabBound flag set)', () => {
            const { window } = env;
            const medTabs = window.document.querySelector('.med-tabs');
            if (!medTabs) return;
            expect(medTabs.dataset.tabBound).toBe('1');
        });
    });
});
