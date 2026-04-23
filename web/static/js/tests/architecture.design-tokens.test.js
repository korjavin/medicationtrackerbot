/**
 * architecture.design-tokens.test.js
 *
 * Validates that the :root block in styles.css contains all expected
 * design tokens. This ensures tokens are not accidentally removed
 * and that the design system foundation remains complete.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');

/**
 * Extract the first :root { ... } block from the CSS source.
 */
function extractRootBlock(css) {
    const match = css.match(/:root\s*\{([^}]+)\}/);
    return match ? match[1] : '';
}

/**
 * Extract all custom property names (--foo) from a CSS block.
 */
function extractCustomProperties(block) {
    const props = new Set();
    const re = /(--[\w-]+)\s*:/g;
    let m;
    while ((m = re.exec(block)) !== null) {
        props.add(m[1]);
    }
    return props;
}

/** All design tokens that must exist in :root */
const REQUIRED_TOKENS = [
    // Semantic colors
    '--color-success',
    '--color-warning',
    '--color-danger',
    '--color-info',

    // BP classification colors
    '--color-bp-optimal',
    '--color-bp-normal',
    '--color-bp-high-normal',
    '--color-bp-grade1',
    '--color-bp-grade2',
    '--color-bp-grade3',

    // Chart colors
    '--color-chart-primary',
    '--color-chart-secondary',
    '--color-chart-accent',
    '--color-chart-highlight',

    // Hero card gradient stops
    '--color-hero-pink-start',
    '--color-hero-pink-end',
    '--color-hero-blue-start',
    '--color-hero-blue-end',

    // Sync status colors
    '--color-sync-pending',
    '--color-sync-success',
    '--color-sync-error',

    // Toast colors
    '--color-toast-success-bg',
    '--color-toast-success-text',
    '--color-toast-warning-bg',
    '--color-toast-warning-text',
    '--color-toast-error-bg',
    '--color-toast-error-text',
    '--color-toast-info-bg',
    '--color-toast-info-text',

    // Overlay colors
    '--color-overlay',
    '--color-overlay-light',

    // BP category badge colors
    '--color-bp-category-grade1-bg',
    '--color-bp-category-grade1-text',

    // Chart extra colors
    '--color-chart-plan',

    // Inventory badge
    '--color-inventory-ok',

    // Workout card gradients
    '--color-workout-card-bg-start',
    '--color-workout-card-bg-end',
    '--color-workout-today-start',
    '--color-workout-today-end',
    '--color-workout-skipped-start',
    '--color-workout-skipped-end',
    '--color-workout-skipped-accent',

    // Status bar colors
    '--color-status-offline-bg-start',
    '--color-status-offline-bg-end',
    '--color-status-offline-text',
    '--color-status-offline-border',
    '--color-status-syncing-bg-start',
    '--color-status-syncing-bg-end',
    '--color-status-syncing-text',
    '--color-status-syncing-border',
    '--color-status-pending-bg-start',
    '--color-status-pending-bg-end',
    '--color-status-pending-text',
    '--color-status-pending-border',

    // Sync toast solid backgrounds
    '--color-toast-info-solid',
    '--color-toast-success-solid',
    '--color-toast-error-solid',

    // Data refresh banner
    '--color-refresh-btn',

    // UI / borders
    '--color-border-divider',
    '--color-toggle-inactive',

    // Autocomplete
    '--color-autocomplete-delete',
    '--color-autocomplete-delete-light',

    // Food search status
    '--color-food-status-success',
    '--color-food-status-empty',
    '--color-food-status-error',

    // Workout action button colors
    '--color-workout-stop-bg',
    '--color-workout-stop-text',
    '--color-workout-stop-border',
    '--color-workout-skip-bg',
    '--color-workout-skip-text',
    '--color-workout-skip-border',

    // Mi Band / outdoor workout colors
    '--color-miband-badge-bg',
    '--color-miband-badge-text',
    '--color-miband-badge-border',
    '--color-miband-chip-bg',
    '--color-miband-chip-text',

    // Scanner
    '--color-scanner-bg',

    // Spacing tokens
    '--space-xs',
    '--space-sm',
    '--space-md',
    '--space-lg',
    '--space-xl',
    '--space-2xl',

    // Border radius tokens
    '--radius-sm',
    '--radius-md',
    '--radius-lg',
    '--radius-xl',
    '--radius-pill',

    // Shadow tokens
    '--shadow-sm',
    '--shadow-md',
    '--shadow-lg',

    // Typography tokens
    '--font-size-xs',
    '--font-size-sm',
    '--font-size-md',
    '--font-size-lg',
    '--font-size-xl',
    '--font-weight-normal',
    '--font-weight-medium',
    '--font-weight-bold',

    // Z-index tokens
    '--z-dropdown',
    '--z-overlay',
    '--z-modal',
    '--z-popover',
    '--z-toast',
];

/**
 * Wandergeek design system tokens (deep-teal / gloss / sun accent).
 * Added in the wandergeek-design-rewrite plan. All wg-* tokens live on :root
 * and are CSS-only — no JS reference allowed.
 */
const WANDERGEEK_TOKENS = [
    // Raw palette
    '--wg-paper',
    '--wg-paper-deep',
    '--wg-paper-soft',
    '--wg-ink',
    '--wg-ink-85',
    '--wg-ink-70',
    '--wg-ink-55',
    '--wg-ink-35',
    '--wg-ink-15',
    '--wg-ink-08',
    '--wg-teal',
    '--wg-teal-stage',
    '--wg-teal-sage',
    '--wg-mint',
    '--wg-mint-soft',
    '--wg-sun',
    '--wg-sun-deep',
    '--wg-sun-soft',
    '--wg-clay',
    '--wg-clay-soft',

    // Semantic aliases
    '--wg-bg-stage',
    '--wg-bg-card',
    '--wg-bg-card-inset',
    '--wg-fg-1',
    '--wg-fg-2',
    '--wg-fg-3',
    '--wg-fg-4',
    '--wg-fg-5',
    '--wg-border-hairline',
    '--wg-border-strong',

    // Status tag triplets
    '--wg-tag-normal-bg',
    '--wg-tag-normal-fg',
    '--wg-tag-normal-border',
    '--wg-tag-high-bg',
    '--wg-tag-high-fg',
    '--wg-tag-high-border',
    '--wg-tag-alert-bg',
    '--wg-tag-alert-fg',
    '--wg-tag-alert-border',

    // Type families
    '--wg-font-display',
    '--wg-font-ui',
    '--wg-font-mono',

    // Gloss gradients
    '--wg-gloss-bg',
    '--wg-gloss-bg-sun',
    '--wg-gloss-bg-clay',
    '--wg-gloss-bg-inset',

    // Gloss shadows
    '--wg-gloss-shadow',
    '--wg-gloss-shadow-sun',
    '--wg-gloss-shadow-inset',

    // Dimensional tokens (added in Task 2 alongside the .wg-* primitives)
    '--wg-radius-gloss',
    '--wg-radius-icon',
    '--wg-radius-card',
    '--wg-card-pad',
    '--wg-icon-btn-size',
    '--wg-font-size-tag',
    '--wg-section-label-pad-top',

    // Phone chrome tokens (added in Task 3 alongside .wg-phone, .wg-status-bar, etc.)
    '--wg-phone-pad',
    '--wg-phone-radius',
    '--wg-phone-screen-radius',
    '--wg-phone-shadow',
    '--wg-dynamic-island-radius',
    '--wg-status-bar-pad-bottom',
    '--wg-status-bar-font-size',
    '--wg-radius-pill',

    // App header tokens (added in Task 4 alongside .wg-app-header)
    '--wg-app-header-title-size',
    '--wg-app-header-subtitle-size',

    // Bottom nav tokens (added in Task 5 alongside .wg-bottom-nav)
    '--wg-bottom-nav-pad-top',
    '--wg-bottom-nav-pad-x',
    '--wg-bottom-nav-pad-bottom',
    '--wg-bottom-nav-inner-radius',
    '--wg-bottom-nav-inner-pad',
    '--wg-bottom-nav-gap',
    '--wg-nav-item-radius',
    '--wg-nav-item-pad-y',
    '--wg-nav-item-pad-x',
    '--wg-nav-item-gap',
    '--wg-nav-item-font-size',
    '--wg-nav-icon-size',
    '--wg-bottom-nav-z',
    '--wg-bottom-nav-reserved',
    '--wg-z-fab',

    // Today screen tokens (added in Task 7 alongside .wg-next-action-card,
    // .wg-metric-tile, .wg-fuel-card, .wg-plan-tile, .wg-streak-card).
    '--wg-today-gap',
    '--wg-tile-pad-block',
    '--wg-tile-pad-inline',
    '--wg-next-action-pad-block',
    '--wg-next-action-pad-inline',
    '--wg-fuel-card-pad-block',
    '--wg-fuel-card-pad-inline',
    '--wg-section-label-gap',
    '--wg-font-size-metric-value',
    '--wg-font-size-fuel-value',
    '--wg-font-size-plan-value',
    '--wg-font-size-streak-value',
    '--wg-streak-bar-height',
    '--wg-font-size-mini',
    '--wg-font-size-caps',
    '--wg-next-action-bg',
    '--wg-next-action-border',
    '--wg-next-action-icon-bg',
    '--wg-next-action-icon-border',
    '--wg-metric-tile-bg',
    '--wg-mini-bar-track-bg',
    '--wg-mini-bar-track-shadow',

    // BP screen tokens (Phase 3, Task 1) — current-reading card, range
    // selector, chart geometry, averages, history row.
    '--wg-bp-reading-value-size',
    '--wg-bp-range-selector-height',
    '--wg-bp-range-selector-pad',
    '--wg-bp-chart-width',
    '--wg-bp-chart-height',
    '--wg-bp-chart-band-alpha',
    '--wg-bp-chart-guide-dasharray',
    '--wg-bp-chart-guide-stroke-width',
    '--wg-bp-chart-line-stroke-width',
    '--wg-bp-chart-last-point-radius',
    '--wg-bp-chart-last-stroke-width',
    '--wg-bp-average-value-size',
    '--wg-bp-current-card-pad',
    '--wg-bp-history-row-pad',

    // BP status aliases — wrap the tag triplets; classifier returns the
    // status key (normal / highnormal / grade1 / grade2) and the renderer
    // applies `.wg-bp-status--<key>` without duplicating tag styles.
    '--wg-bp-status-normal-bg',
    '--wg-bp-status-normal-fg',
    '--wg-bp-status-normal-border',
    '--wg-bp-status-highnormal-bg',
    '--wg-bp-status-highnormal-fg',
    '--wg-bp-status-highnormal-border',
    '--wg-bp-status-grade1-bg',
    '--wg-bp-status-grade1-fg',
    '--wg-bp-status-grade1-border',
    '--wg-bp-status-grade2-bg',
    '--wg-bp-status-grade2-fg',
    '--wg-bp-status-grade2-border',

    // Food screen tokens (Phase 4, Task 1) — daily macros card, macro bars,
    // sub-tab strip, day navigator, meal list, edit-food modal.
    '--wg-food-kcal-display-size',
    '--wg-food-kcal-unit-size',
    '--wg-food-macro-bar-height',
    '--wg-food-macro-row-cols',
    '--wg-food-macro-row-gap',
    '--wg-food-subtab-pad-y',
    '--wg-food-subtab-pad-x',
    '--wg-food-subtab-gap',
    '--wg-food-day-nav-icon-size',
    '--wg-food-day-nav-title-size',
    '--wg-food-meal-header-gap',
    '--wg-food-item-row-pad',
    '--wg-food-total-kcal-input',

    // Edit-food modal tokens (Phase 4, Task 6) — eyebrow size + mono title
    // size + row/section gaps + input padding + action-bar gap.
    '--wg-food-modal-eyebrow-size',
    '--wg-food-modal-title-size',
    '--wg-food-modal-row-gap',
    '--wg-food-modal-section-gap',
    '--wg-food-modal-input-pad-y',
    '--wg-food-modal-input-pad-x',
    '--wg-food-modal-action-gap',

    // Food macro color aliases — map Energy / Protein / Carbs / Fat variants
    // to existing sun / mint / teal-sage / clay-soft palette tokens.
    '--wg-food-macro-energy',
    '--wg-food-macro-protein',
    '--wg-food-macro-carbs',
    '--wg-food-macro-fat',

    // Meds screen tokens (Phase 5, Task 1) — next-action card pad/type,
    // hour header, schedule row layout, inventory count display, sub-tab strip.
    '--wg-meds-next-card-pad',
    '--wg-meds-next-subtitle-size',
    '--wg-meds-next-names-size',
    '--wg-meds-hour-header-size',
    '--wg-meds-row-cols',
    '--wg-meds-row-gap',
    '--wg-meds-row-pad',
    '--wg-meds-name-size',
    '--wg-meds-dosage-size',
    '--wg-meds-inventory-count-size',
    '--wg-meds-subtab-pad-y',
    '--wg-meds-subtab-pad-x',
    '--wg-meds-subtab-gap',

    // Meds inventory status aliases (Phase 5, Task 1) — wrap the existing
    // --wg-tag-* triplets so the inventory classifier (ok / low / out) can
    // return a token-group name without duplicating tag styles.
    '--wg-meds-status-ok-bg',
    '--wg-meds-status-ok-fg',
    '--wg-meds-status-ok-border',
    '--wg-meds-status-low-bg',
    '--wg-meds-status-low-fg',
    '--wg-meds-status-low-border',
    '--wg-meds-status-out-bg',
    '--wg-meds-status-out-fg',
    '--wg-meds-status-out-border',

    // Meds history sub-tab tokens (Phase 5, Task 5) — filter-strip geometry,
    // day-group label, log-row padding, trailing time + status sizes, and
    // the muted next-intake link row.
    '--wg-meds-filter-gap',
    '--wg-meds-filter-field-pad-y',
    '--wg-meds-filter-field-pad-x',
    '--wg-meds-filter-label-size',
    '--wg-meds-history-row-pad',
    '--wg-meds-history-row-gap',
    '--wg-meds-history-day-size',
    '--wg-meds-history-time-size',
    '--wg-meds-history-name-size',
    '--wg-meds-next-intake-pad-y',
    '--wg-meds-next-intake-pad-x',

    // Meds inventory sub-tab tokens (Phase 5, Task 6) — card padding and
    // gap, dosage / count-label / refilled-row type sizes, refill input gap.
    '--wg-meds-inventory-card-pad',
    '--wg-meds-inventory-card-gap',
    '--wg-meds-inventory-dosage-size',
    '--wg-meds-inventory-count-label-size',
    '--wg-meds-inventory-refilled-size',
    '--wg-meds-inventory-refill-gap',

    // Edit-medication modal tokens (Phase 5, Task 7) — dual-line header,
    // gloss-inset input wraps, schedule-pill strip, times layout, action bar.
    '--wg-meds-modal-eyebrow-size',
    '--wg-meds-modal-title-size',
    '--wg-meds-modal-row-gap',
    '--wg-meds-modal-section-gap',
    '--wg-meds-modal-input-pad-y',
    '--wg-meds-modal-input-pad-x',
    '--wg-meds-modal-action-gap',
    '--wg-meds-modal-pill-gap',
    '--wg-meds-modal-pill-pad-y',
    '--wg-meds-modal-pill-pad-x',
    '--wg-meds-modal-pill-size',
    '--wg-meds-modal-label-size',
    '--wg-meds-modal-rx-size',
    '--wg-meds-modal-day-size',
    '--wg-meds-modal-time-row-gap',
    '--wg-meds-modal-toggle-gap',

    // Weight screen tokens (Phase 6, Task 1) — current-weight card, trend
    // arrow + delta, optional goal card + progress bar, range selector,
    // single-series chart geometry, day-grouped history rows.
    '--wg-weight-current-value-size',
    '--wg-weight-current-unit-size',
    '--wg-weight-current-card-pad',
    '--wg-weight-trend-size',
    '--wg-weight-trend-icon-size',
    '--wg-weight-goal-card-pad',
    '--wg-weight-goal-value-size',
    '--wg-weight-goal-bar-height',
    '--wg-weight-goal-delta-size',
    '--wg-weight-range-selector-height',
    '--wg-weight-range-selector-pad',
    '--wg-weight-chart-width',
    '--wg-weight-chart-height',
    '--wg-weight-chart-line-stroke-width',
    '--wg-weight-chart-goal-stroke-width',
    '--wg-weight-chart-goal-dasharray',
    '--wg-weight-chart-last-point-radius',
    '--wg-weight-chart-last-stroke-width',
    '--wg-weight-history-row-cols',
    '--wg-weight-history-row-gap',
    '--wg-weight-history-row-pad',
    '--wg-weight-history-weight-size',
    '--wg-weight-history-time-size',
    '--wg-weight-history-day-size',

    // Weight trend aliases (Phase 6, Task 1) — wrap the shared sun / alert /
    // mint tag triplets so the JS classifier can return good / bad / flat
    // relative to goal direction. Mirrors the --wg-bp-status-* pattern.
    '--wg-weight-trend-good-bg',
    '--wg-weight-trend-good-fg',
    '--wg-weight-trend-good-border',
    '--wg-weight-trend-bad-bg',
    '--wg-weight-trend-bad-fg',
    '--wg-weight-trend-bad-border',
    '--wg-weight-trend-flat-bg',
    '--wg-weight-trend-flat-fg',
    '--wg-weight-trend-flat-border',

    // Edit-weight modal tokens (Phase 6, Task 6) — dual-line header, gloss
    // input wraps, kg/lb unit-toggle pill pair, Cancel/Save action bar with
    // 2× flex on Save per modal-button-order convention.
    '--wg-weight-modal-eyebrow-size',
    '--wg-weight-modal-title-size',
    '--wg-weight-modal-section-gap',
    '--wg-weight-modal-input-pad-y',
    '--wg-weight-modal-input-pad-x',
    '--wg-weight-modal-weight-row-gap',
    '--wg-weight-modal-unit-toggle-pad',
    '--wg-weight-modal-unit-toggle-gap',
    '--wg-weight-modal-unit-btn-pad-y',
    '--wg-weight-modal-unit-btn-pad-x',
    '--wg-weight-modal-unit-btn-size',
    '--wg-weight-modal-unit-btn-min-w',
    '--wg-weight-modal-label-size',
    '--wg-weight-modal-action-gap',

    // Workouts screen tokens (Phase 7, Task 1) — sub-tab strip, today's-
    // workout card, rotation-slot tag, day-grouped history rows, session-
    // detail view with set-by-set rows, groups/exercises list rows, stat
    // tiles + chart geometry.
    '--wg-workouts-subtab-pad-y',
    '--wg-workouts-subtab-pad-x',
    '--wg-workouts-subtab-gap',
    '--wg-workouts-today-card-pad',
    '--wg-workouts-today-subtitle-size',
    '--wg-workouts-today-names-size',
    '--wg-workouts-today-duration-size',
    '--wg-workouts-slot-tag-pad-y',
    '--wg-workouts-slot-tag-pad-x',
    '--wg-workouts-slot-tag-size',
    '--wg-workouts-history-day-size',
    '--wg-workouts-history-row-cols',
    '--wg-workouts-history-row-gap',
    '--wg-workouts-history-row-pad',
    '--wg-workouts-history-duration-size',
    '--wg-workouts-history-count-size',
    '--wg-workouts-session-header-size',
    '--wg-workouts-session-meta-size',
    '--wg-workouts-session-set-row-min-h',
    '--wg-workouts-session-set-row-gap',
    '--wg-workouts-session-set-row-size',
    '--wg-workouts-session-action-gap',
    '--wg-workouts-groups-row-cols',
    '--wg-workouts-groups-row-gap',
    '--wg-workouts-groups-row-pad',
    '--wg-workouts-groups-name-size',
    '--wg-workouts-groups-count-size',
    '--wg-workouts-exercises-row-cols',
    '--wg-workouts-exercises-row-gap',
    '--wg-workouts-exercises-row-pad',
    '--wg-workouts-exercises-name-size',
    '--wg-workouts-stats-tile-pad',
    '--wg-workouts-stats-tile-gap',
    '--wg-workouts-stats-tile-value-size',
    '--wg-workouts-stats-tile-label-size',
    '--wg-workouts-stats-range-height',
    '--wg-workouts-stats-range-pad',
    '--wg-workouts-chart-width',
    '--wg-workouts-chart-height',
    '--wg-workouts-chart-line-stroke-width',
    '--wg-workouts-chart-last-point-radius',
    '--wg-workouts-chart-last-stroke-width',

    // Workouts modal tokens (Phase 7, Task 1) — log-set / edit-exercise /
    // edit-group / edit-library modals share the same mono header, gloss
    // inset input wraps, label sizes, and Cancel/Save action bar.
    '--wg-workouts-modal-eyebrow-size',
    '--wg-workouts-modal-title-size',
    '--wg-workouts-modal-row-gap',
    '--wg-workouts-modal-section-gap',
    '--wg-workouts-modal-input-pad-y',
    '--wg-workouts-modal-input-pad-x',
    '--wg-workouts-modal-label-size',
    '--wg-workouts-modal-action-gap',

    // Workouts rotation-slot aliases (Phase 7, Task 1) — wrap the shared
    // sun / normal / mint tag triplets so the rotation-slot classifier
    // (PUSH / PULL / LEGS / REST / AD-HOC) can return a token-group name
    // without duplicating tag styles. Mirrors the --wg-bp-status-* /
    // --wg-meds-status-* / --wg-weight-trend-* pattern.
    '--wg-workouts-slot-push-bg',
    '--wg-workouts-slot-push-fg',
    '--wg-workouts-slot-push-border',
    '--wg-workouts-slot-pull-bg',
    '--wg-workouts-slot-pull-fg',
    '--wg-workouts-slot-pull-border',
    '--wg-workouts-slot-legs-bg',
    '--wg-workouts-slot-legs-fg',
    '--wg-workouts-slot-legs-border',
    '--wg-workouts-slot-rest-bg',
    '--wg-workouts-slot-rest-fg',
    '--wg-workouts-slot-rest-border',
    '--wg-workouts-slot-adhoc-bg',
    '--wg-workouts-slot-adhoc-fg',
    '--wg-workouts-slot-adhoc-border',

    // Health screen tokens (Phase 8, Task 1) — sub-tab strip, summary tile
    // row, range selector, sleep / steps / vitals card shells + chart
    // geometry, notes row + compose-wrap + edit modal.
    '--wg-health-subtab-pad-y',
    '--wg-health-subtab-pad-x',
    '--wg-health-subtab-gap',
    '--wg-health-summary-tile-pad',
    '--wg-health-summary-tile-gap',
    '--wg-health-summary-tile-value-size',
    '--wg-health-summary-tile-label-size',
    '--wg-health-summary-tile-trend-size',
    '--wg-health-range-selector-height',
    '--wg-health-range-selector-pad',
    '--wg-health-chart-width',
    '--wg-health-chart-height',
    '--wg-health-chart-tall-height',
    '--wg-health-chart-line-stroke-width',
    '--wg-health-chart-last-point-radius',
    '--wg-health-chart-last-stroke-width',
    '--wg-health-card-pad',
    '--wg-health-card-header-size',
    '--wg-health-card-stat-size',
    '--wg-health-legend-badge-size',
    '--wg-health-legend-gap',
    '--wg-health-notes-row-cols',
    '--wg-health-notes-row-gap',
    '--wg-health-notes-row-pad',
    '--wg-health-notes-day-size',
    '--wg-health-notes-time-size',
    '--wg-health-notes-body-size',
    '--wg-health-notes-compose-pad-y',
    '--wg-health-notes-compose-pad-x',

    // Edit-note modal tokens (Phase 8, Task 1 / rewired Task 8) — mono
    // header, gloss-inset textarea wrap, Cancel + Save bar with 2× flex
    // on Save per modal-button-order convention.
    '--wg-health-modal-eyebrow-size',
    '--wg-health-modal-title-size',
    '--wg-health-modal-row-gap',
    '--wg-health-modal-section-gap',
    '--wg-health-modal-input-pad-y',
    '--wg-health-modal-input-pad-x',
    '--wg-health-modal-label-size',
    '--wg-health-modal-action-gap',

    // Sleep-stage color tokens (Phase 8, Task 1) — stacked-bar fills for
    // deep / light / rem / awake plus the HR overlay line + dot + label.
    '--wg-health-sleep-deep',
    '--wg-health-sleep-light',
    '--wg-health-sleep-rem',
    '--wg-health-sleep-awake',
    '--wg-health-sleep-hr',

    // Steps chart color tokens (Phase 8, Task 1) — bar fill + rotated
    // in-bar count label contrast.
    '--wg-health-steps-bar',
    '--wg-health-steps-label-inside',

    // Vitals chart color tokens (Phase 8, Task 1) — one line color per
    // vital; the WGVitalsChart component (Task 6) keys off these.
    '--wg-health-vitals-hr-line',
    '--wg-health-vitals-spo2-line',
    '--wg-health-vitals-stress-line',

    // Settings screen tokens (Phase 9, Task 1) — sectioned cards, canonical
    // row grid (left column title+description, right column control),
    // token'd row hairline divider, info-grid for the Timezone card,
    // number-field input geometry for Food Targets, action-row gap.
    '--wg-settings-section-pad',
    '--wg-settings-section-gap',
    '--wg-settings-row-cols',
    '--wg-settings-row-gap',
    '--wg-settings-row-pad-y',
    '--wg-settings-row-pad-x',
    '--wg-settings-row-divider',
    '--wg-settings-title-size',
    '--wg-settings-desc-size',
    '--wg-settings-info-grid-cols',
    '--wg-settings-info-grid-gap',
    '--wg-settings-info-label-size',
    '--wg-settings-info-value-size',
    '--wg-settings-number-field-height',
    '--wg-settings-number-field-pad-x',
    '--wg-settings-number-field-label-size',
    '--wg-settings-action-row-gap',
    '--wg-settings-version-size',
    '--wg-settings-version-pad',

    // Toggle primitive tokens (Phase 9, Task 1) — the new WGToggle
    // primitive draws an unchecked pill (--wg-toggle-bg) that flips to
    // --wg-toggle-bg-on (sun gradient) when checked; knob / border /
    // focus / disabled states are all tokenized.
    '--wg-toggle-width',
    '--wg-toggle-height',
    '--wg-toggle-knob-size',
    '--wg-toggle-knob-pad',
    '--wg-toggle-bg',
    '--wg-toggle-bg-on',
    '--wg-toggle-knob',
    '--wg-toggle-knob-on',
    '--wg-toggle-border',
    '--wg-toggle-border-focus',
    '--wg-toggle-border-disabled',
];

describe('Architecture – design tokens', () => {
    it(':root block contains all required design tokens', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const rootBlock = extractRootBlock(css);
        expect(rootBlock).not.toBe('');

        const defined = extractCustomProperties(rootBlock);
        const missing = REQUIRED_TOKENS.filter(t => !defined.has(t));

        if (missing.length > 0) {
            throw new Error(
                `Missing design tokens in :root block of styles.css:\n\n` +
                missing.map(t => `  • ${t}`).join('\n')
            );
        }
    });

    it('no hardcoded hex colors outside :root (except allowlisted fallbacks)', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        // Split CSS into lines and track whether we are inside :root or
        // a @media dark-mode :root override block
        const lines = css.split('\n');
        let insideRoot = false;
        let braceDepth = 0;
        let insideDarkMediaRoot = false;
        let darkMediaDepth = 0;
        let inDarkMedia = false;

        const hexColorRe = /#(?:[0-9a-fA-F]{3,8})\b/g;
        // Hex colors that appear inside var() fallbacks are fine
        const varFallbackRe = /var\([^)]*#[0-9a-fA-F]{3,8}/;
        // Allowlisted generic colors (white/black keywords as hex)
        const allowlistedHex = new Set(['#fff', '#ffffff', '#000', '#000000']);

        const violations = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNum = i + 1;

            // Track :root block
            if (/^:root\s*\{/.test(line.trim())) {
                insideRoot = true;
                braceDepth = 1;
                continue;
            }
            if (insideRoot) {
                for (const ch of line) {
                    if (ch === '{') braceDepth++;
                    if (ch === '}') braceDepth--;
                }
                if (braceDepth <= 0) insideRoot = false;
                continue;
            }

            // Track @media (prefers-color-scheme: dark) { :root { ... } }
            if (/prefers-color-scheme:\s*dark/.test(line)) {
                inDarkMedia = true;
                darkMediaDepth = 0;
                for (const ch of line) {
                    if (ch === '{') darkMediaDepth++;
                    if (ch === '}') darkMediaDepth--;
                }
                continue;
            }
            if (inDarkMedia) {
                for (const ch of line) {
                    if (ch === '{') darkMediaDepth++;
                    if (ch === '}') darkMediaDepth--;
                }
                if (darkMediaDepth <= 0) inDarkMedia = false;
                continue;
            }

            // Skip lines that are CSS selectors containing # (e.g. #add-btn)
            if (/^\s*[#.\w[\]:>~+,\s-]+\s*[,{]?\s*$/.test(line) && !line.includes(':')) {
                continue;
            }

            // Check for hex colors
            const matches = line.match(hexColorRe);
            if (!matches) continue;

            // Skip if all hex values are inside var() fallbacks
            if (varFallbackRe.test(line)) {
                // Remove var() fallback portions and re-check
                const withoutFallbacks = line.replace(/var\([^)]*\)/g, '');
                const remaining = withoutFallbacks.match(hexColorRe);
                if (!remaining) continue;
                // Filter out allowlisted
                const real = remaining.filter(h => !allowlistedHex.has(h.toLowerCase()));
                if (real.length > 0) {
                    violations.push({ line: lineNum, text: line.trim(), colors: real });
                }
                continue;
            }

            const real = matches.filter(h => !allowlistedHex.has(h.toLowerCase()));
            if (real.length > 0) {
                violations.push({ line: lineNum, text: line.trim(), colors: real });
            }
        }

        if (violations.length > 0) {
            const report = violations
                .map(v => `  L${v.line}: ${v.colors.join(', ')} — ${v.text}`)
                .join('\n');
            throw new Error(
                `Found ${violations.length} lines with hardcoded hex colors outside :root:\n\n${report}\n\n` +
                `Replace these with CSS custom property tokens (var(--token-name)).`
            );
        }
    });

    it('button system classes are defined in CSS', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        const requiredButtonClasses = [
            '.btn',
            '.btn-primary',
            '.btn-secondary',
            '.btn-danger',
            '.btn-danger-outline',
            '.btn-ghost',
            '.btn-sm',
            '.btn-lg',
            '.btn-pill',
            '.btn-icon',
            '.btn-fab',
            '.btn-link',
        ];

        const missing = requiredButtonClasses.filter(cls => {
            // Match class selector at start of line or after comma/space
            const escaped = cls.replace('.', '\\.');
            const re = new RegExp(`(?:^|[,\\s])${escaped}(?:[\\s,.:{[>~+]|$)`, 'm');
            return !re.test(css);
        });

        if (missing.length > 0) {
            throw new Error(
                `Missing button system classes in styles.css:\n\n` +
                missing.map(c => `  • ${c}`).join('\n')
            );
        }
    });

    it('no legacy button class names remain in CSS', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        // Old button class names that should have been migrated
        const legacyClasses = [
            /(?:^|[,\s])\.primary(?=[\s,.:{[>~+]|$)/m,
            /(?:^|[,\s])\.secondary(?=[\s,.:{[>~+]|$)/m,
            /(?:^|[,\s])\.btn-add(?=[\s,.:{[>~+]|$)/m,
            /(?:^|[,\s])\.small-btn(?=[\s,.:{[>~+]|$)/m,
            /(?:^|[,\s])\.danger(?=[\s,.:{[>~+]|$)/m,
            /(?:^|[,\s])\.text-btn(?=[\s,.:{[>~+]|$)/m,
        ];

        const found = [];
        for (const re of legacyClasses) {
            const match = css.match(re);
            if (match) {
                found.push(match[0].trim());
            }
        }

        if (found.length > 0) {
            throw new Error(
                `Legacy button classes still defined in styles.css (should use new .btn system):\n\n` +
                found.map(c => `  • ${c}`).join('\n')
            );
        }
    });

    it('no legacy button class names in index.html (except as part of new system)', () => {
        const htmlPath = path.join(REPO_ROOT, 'web/static/index.html');
        const html = fs.readFileSync(htmlPath, 'utf8');

        // These old class names should not appear standalone in class attributes
        const legacyPatterns = [
            { name: 'class="primary"', re: /class="primary"/g },
            { name: 'class="secondary"', re: /class="secondary"/g },
            { name: 'class="danger"', re: /class="danger"/g },
            { name: 'class="text-btn"', re: /class="text-btn"/g },
            { name: 'class="small-btn"', re: /class="small-btn"/g },
            { name: 'class="btn-add"', re: /class="btn-add"/g },
        ];

        const violations = [];
        for (const { name, re } of legacyPatterns) {
            if (re.test(html)) {
                violations.push(name);
            }
        }

        if (violations.length > 0) {
            throw new Error(
                `Legacy button class patterns found in index.html:\n\n` +
                violations.map(v => `  • ${v}`).join('\n') +
                `\n\nMigrate to new .btn system (e.g. class="btn btn-primary").`
            );
        }
    });

    it('no hardcoded px values in spacing/radius/shadow/font-size/z-index properties outside :root', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const lines = css.split('\n');

        // Track whether we are inside :root or dark-mode :root override
        let insideRoot = false;
        let braceDepth = 0;
        let inDarkMedia = false;
        let darkMediaDepth = 0;

        // Properties that should use design tokens instead of hardcoded px values
        const spacingPropRe = /^\s*(padding|padding-(top|right|bottom|left)|margin|margin-(top|right|bottom|left)|gap)\s*:/i;
        const radiusPropRe = /^\s*border-radius\s*:/i;
        const shadowPropRe = /^\s*box-shadow\s*:/i;
        const fontSizePropRe = /^\s*font-size\s*:/i;
        const zIndexPropRe = /^\s*z-index\s*:/i;

        // Match hardcoded px values (but not 0px, or values inside var())
        const hardcodedPxRe = /(?<!\w)(\d+)px\b/g;

        // Allowlisted px values that don't have matching tokens or are acceptable
        const spacingAllowlist = new Set([0, 1, 2, 3, 5, 7, 28, 80, 90, 40, 100, 120, 200, 250, 400]);
        const radiusAllowlist = new Set([0, 2]);
        const fontSizeAllowlist = new Set([0, 48]); // 48px is a special display size
        const zIndexAllowlist = new Set([0, 10, 1003, 1200]); // local stacking, scanner, banner

        const violations = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNum = i + 1;

            // Track :root block
            if (/^:root\s*\{/.test(line.trim())) {
                insideRoot = true;
                braceDepth = 1;
                continue;
            }
            if (insideRoot) {
                for (const ch of line) {
                    if (ch === '{') braceDepth++;
                    if (ch === '}') braceDepth--;
                }
                if (braceDepth <= 0) insideRoot = false;
                continue;
            }

            // Track dark-mode :root
            if (/prefers-color-scheme:\s*dark/.test(line)) {
                inDarkMedia = true;
                darkMediaDepth = 0;
                for (const ch of line) {
                    if (ch === '{') darkMediaDepth++;
                    if (ch === '}') darkMediaDepth--;
                }
                continue;
            }
            if (inDarkMedia) {
                for (const ch of line) {
                    if (ch === '{') darkMediaDepth++;
                    if (ch === '}') darkMediaDepth--;
                }
                if (darkMediaDepth <= 0) inDarkMedia = false;
                continue;
            }

            // Skip lines that already use var() for the value
            if (/var\(--/.test(line)) {
                // Check if there are ALSO hardcoded px values mixed in (compound values)
                const withoutVars = line.replace(/var\([^)]*\)/g, '');
                if (!hardcodedPxRe.test(withoutVars)) continue;
                // Reset regex lastIndex for reuse below
                hardcodedPxRe.lastIndex = 0;
            }

            // Skip comment lines
            if (/^\s*\/?\*/.test(line) || /^\s*\/\//.test(line)) continue;

            // Check each property type
            let propType = null;
            let allowlist = null;

            if (spacingPropRe.test(line)) {
                propType = 'spacing';
                allowlist = spacingAllowlist;
            } else if (radiusPropRe.test(line)) {
                propType = 'border-radius';
                allowlist = radiusAllowlist;
            } else if (shadowPropRe.test(line)) {
                propType = 'box-shadow';
                allowlist = new Set([0]);
            } else if (fontSizePropRe.test(line)) {
                propType = 'font-size';
                allowlist = fontSizeAllowlist;
            } else if (zIndexPropRe.test(line)) {
                propType = 'z-index';
                allowlist = zIndexAllowlist;
            }

            if (!propType) continue;

            // For z-index, check raw numeric values (not px)
            if (propType === 'z-index') {
                const zMatch = line.match(/z-index\s*:\s*(\d+)/);
                if (zMatch && !allowlist.has(parseInt(zMatch[1], 10)) && !line.includes('var(')) {
                    violations.push({ line: lineNum, text: line.trim(), type: propType });
                }
                continue;
            }

            // For box-shadow, check if it has hardcoded rgba/px and isn't using var()
            // Allow colored shadows (non-black rgba) as they are design-specific
            if (propType === 'box-shadow') {
                if (!line.includes('var(') && /\d+px/.test(line) && line.trim() !== 'box-shadow: none;') {
                    // Skip colored shadows (rgba with non-zero R/G/B channels)
                    const rgbaMatch = line.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
                    if (rgbaMatch && (parseInt(rgbaMatch[1]) > 0 || parseInt(rgbaMatch[2]) > 0 || parseInt(rgbaMatch[3]) > 0)) {
                        continue;
                    }
                    violations.push({ line: lineNum, text: line.trim(), type: propType });
                }
                continue;
            }

            // Extract the value part (after the colon)
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            const valuePart = line.slice(colonIdx + 1).replace(/var\([^)]*\)/g, '');

            const matches = [...valuePart.matchAll(hardcodedPxRe)];
            const badValues = matches.filter(m => !allowlist.has(parseInt(m[1], 10)));

            if (badValues.length > 0) {
                violations.push({
                    line: lineNum,
                    text: line.trim(),
                    type: propType,
                    values: badValues.map(m => m[0]),
                });
            }
        }

        if (violations.length > 0) {
            const report = violations
                .map(v => `  L${v.line} [${v.type}]: ${v.text}`)
                .join('\n');
            throw new Error(
                `Found ${violations.length} lines with hardcoded values that should use design tokens:\n\n${report}\n\n` +
                `Replace these with CSS custom property tokens (e.g., var(--space-lg), var(--radius-md)).`
            );
        }
    });

    it('no inline style assignments in app.js (except style.display for show/hide)', () => {
        const appPath = path.join(REPO_ROOT, 'web/static/js/app.js');
        const appJs = fs.readFileSync(appPath, 'utf8');
        const lines = appJs.split('\n');

        // Patterns that indicate inline style assignments
        const styleCssTextRe = /\.style\.cssText\s*=/;
        const stylePropRe = /\.style\.\w+\s*=/;
        // Allowlisted patterns
        const displayRe = /\.style\.display\s*=/;
        const setPropertyRe = /\.style\.setProperty\(/;
        // Dynamic chart badge color (data-driven, cannot be CSS class)
        const backgroundDynamicRe = /\.style\.background\s*=\s*color/;

        const violations = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNum = i + 1;

            // Skip comments
            if (/^\s*\/\//.test(line) || /^\s*\/?\*/.test(line)) continue;

            // Check for style.cssText
            if (styleCssTextRe.test(line)) {
                violations.push({ line: lineNum, text: line.trim() });
                continue;
            }

            // Check for style.property = assignments
            if (stylePropRe.test(line)) {
                // Allow style.display (show/hide)
                if (displayRe.test(line)) continue;
                // Allow style.setProperty (CSS custom properties)
                if (setPropertyRe.test(line)) continue;
                // Allow dynamic background color for chart legend badges
                if (backgroundDynamicRe.test(line)) continue;

                violations.push({ line: lineNum, text: line.trim() });
            }
        }

        if (violations.length > 0) {
            const report = violations
                .map(v => `  L${v.line}: ${v.text}`)
                .join('\n');
            throw new Error(
                `Found ${violations.length} inline style assignments in app.js:\n\n${report}\n\n` +
                `Replace with CSS classes. Allowed exceptions: style.display (show/hide), ` +
                `style.setProperty (CSS custom props), style.background = color (dynamic chart data).`
            );
        }
    });

    it('no inline style assignments in food.js (except dynamic progress bar values)', () => {
        const foodPath = path.join(REPO_ROOT, 'web/static/js/features/food.js');
        const foodJs = fs.readFileSync(foodPath, 'utf8');
        const lines = foodJs.split('\n');

        const styleCssTextRe = /\.style\.cssText\s*=/;
        const stylePropRe = /\.style\.\w+\s*=/;
        // Allowlisted: dynamic progress bar width and background color
        const widthDynamicRe = /\.style\.width\s*=\s*`/;
        const backgroundDynamicRe = /\.style\.background\s*=/;

        const violations = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNum = i + 1;

            if (/^\s*\/\//.test(line) || /^\s*\/?\*/.test(line)) continue;

            if (styleCssTextRe.test(line)) {
                violations.push({ line: lineNum, text: line.trim() });
                continue;
            }

            if (stylePropRe.test(line)) {
                if (widthDynamicRe.test(line)) continue;
                if (backgroundDynamicRe.test(line)) continue;
                violations.push({ line: lineNum, text: line.trim() });
            }
        }

        if (violations.length > 0) {
            const report = violations
                .map(v => `  L${v.line}: ${v.text}`)
                .join('\n');
            throw new Error(
                `Found ${violations.length} inline style assignments in food.js:\n\n${report}\n\n` +
                `Replace with CSS classes. Allowed exceptions: style.width (dynamic progress), ` +
                `style.background (dynamic color).`
            );
        }
    });

    it('no inline style assignments in any JS file (except allowlisted dynamic values)', () => {
        const jsDir = path.join(REPO_ROOT, 'web/static/js');

        // Helper: scan a file for inline style violations
        function scanFile(filePath, allowRules = []) {
            const code = fs.readFileSync(filePath, 'utf8');
            const lines = code.split('\n');
            const styleCssTextRe = /\.style\.cssText\s*=/;
            const stylePropRe = /\.style\.\w+\s*=/;
            const styleReadRe = /\.style\.display\s*===?\s*/;
            const violations = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const lineNum = i + 1;

                // Skip comments
                if (/^\s*\/\//.test(line) || /^\s*\/?\*/.test(line)) continue;

                // cssText assignments are always violations
                if (styleCssTextRe.test(line)) {
                    violations.push({ line: lineNum, text: line.trim() });
                    continue;
                }

                // style property reads (comparisons) are not violations
                if (styleReadRe.test(line) && !stylePropRe.test(line)) continue;

                // style property assignments
                if (stylePropRe.test(line)) {
                    // style.display for show/hide is always allowed
                    if (/\.style\.display\s*=/.test(line)) continue;
                    // style.setProperty for CSS custom properties is always allowed
                    if (/\.style\.setProperty\(/.test(line)) continue;
                    // Check per-file allow rules
                    if (allowRules.some(re => re.test(line))) continue;

                    violations.push({ line: lineNum, text: line.trim() });
                }
            }

            return violations;
        }

        // Per-file allowlist rules for dynamic values that cannot be CSS classes
        const perFileRules = {
            'features/weight.js': [
                /\.style\.transform\s*=/, // ruler positioning
                /\.style\.left\s*=/,      // tick positioning
            ],
            'features/health.js': [
                /\.style\.background\s*=/, // dynamic legend badge colors
            ],
            'features/workout.js': [
                /\.style\.background\s*=/,    // dynamic data-driven colors (heatmap squares, legend swatches)
                /\.style\.width\s*=/,         // dynamic bar fill width
                /\.style\.opacity\s*=/,       // save button loading state
            ],
        };

        // Dynamically find all JS files (excluding tests/ and core/ directories)
        function collectJsFiles(dir, base) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            let files = [];
            for (const entry of entries) {
                const rel = base ? `${base}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    if (entry.name === 'tests' || entry.name === 'core') continue;
                    files = files.concat(collectJsFiles(path.join(dir, entry.name), rel));
                } else if (entry.name.endsWith('.js')) {
                    files.push(rel);
                }
            }
            return files;
        }

        const jsFiles = collectJsFiles(jsDir, '');
        // Exclude app.js and food.js — they have dedicated tests above
        const skipFiles = new Set(['app.js', 'features/food.js']);

        const allViolations = [];

        for (const relPath of jsFiles) {
            if (skipFiles.has(relPath)) continue;
            const fullPath = path.join(jsDir, relPath);
            const rules = perFileRules[relPath] || [];
            const violations = scanFile(fullPath, rules);
            if (violations.length > 0) {
                allViolations.push({ file: relPath, violations });
            }
        }

        if (allViolations.length > 0) {
            const report = allViolations
                .map(f => `\n  ${f.file}:\n` + f.violations.map(v => `    L${v.line}: ${v.text}`).join('\n'))
                .join('');
            throw new Error(
                `Found inline style assignments in JS files:${report}\n\n` +
                `Replace with CSS classes. Allowed exceptions: style.display (show/hide), ` +
                `style.setProperty (CSS custom props), and per-file dynamic value allowlists.`
            );
        }
    });

    it('no inline style= attributes in HTML strings in JS files', () => {
        const jsDir = path.join(REPO_ROOT, 'web/static/js');

        function collectJsFiles(dir, base) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            let files = [];
            for (const entry of entries) {
                const rel = base ? `${base}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    if (entry.name === 'tests' || entry.name === 'core') continue;
                    files = files.concat(collectJsFiles(path.join(dir, entry.name), rel));
                } else if (entry.name.endsWith('.js')) {
                    files.push(rel);
                }
            }
            return files;
        }

        const jsFiles = collectJsFiles(jsDir, '');
        const inlineStyleRe = /style\s*=\s*["']/;
        const allViolations = [];

        for (const relPath of jsFiles) {
            const fullPath = path.join(jsDir, relPath);
            const code = fs.readFileSync(fullPath, 'utf8');
            const lines = code.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (/^\s*\/\//.test(line) || /^\s*\/?\*/.test(line)) continue;
                if (inlineStyleRe.test(line)) {
                    allViolations.push({ file: relPath, line: i + 1, text: line.trim() });
                }
            }
        }

        if (allViolations.length > 0) {
            const report = allViolations
                .map(v => `  ${v.file}:${v.line}: ${v.text}`)
                .join('\n');
            throw new Error(
                `Found inline style= attributes in HTML strings:\n${report}\n\n` +
                `Use CSS classes instead of inline style attributes in innerHTML/template strings.`
            );
        }
    });

    it('utility and component CSS classes are defined in styles.css', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        const requiredClasses = [
            // Utility classes
            '.flex-row', '.flex-col', '.flex-center', '.flex-between',
            '.text-center', '.text-hint', '.text-danger', '.text-success', '.text-muted',
            '.cursor-pointer',
            '.gap-sm', '.gap-md',
            '.mb-xs', '.mb-sm', '.mb-md', '.mb-lg',
            '.mt-sm', '.mt-md', '.mt-xs',
            '.m-0', '.fw-medium', '.w-full',
            // Login components
            '.login-container', '.login-title', '.login-message',
            '.login-tg-container', '.login-tg-hint', '.login-tg-link',
            '.login-divider', '.login-divider-line', '.login-setup-link',
            '.btn-oidc',
            // Status
            '.status-success', '.status-error', '.status-muted',
            // Medication
            '.med-supplement-badge', '.med-normalized-name',
            '.med-action-icons', '.med-empty-text',
            // Next intake
            '.next-intake-card', '.next-intake-title',
            '.next-intake-countdown', '.next-intake-details', '.next-intake-action',
            // Charts
            '.chart-section', '.chart-container', '.chart-container-tall',
            '.chart-stat', '.chart-stat-spaced', '.chart-legend',
            '.chart-legend-item', '.chart-legend-badge', '.chart-legend-badge-line',
            '.chart-disclaimer',
            // SVG
            '.svg-chart',
            // Food log items
            '.food-checkbox-wrap', '.food-checkbox',
            // Food floating button
            '.food-floating-btn',
            // Food meal cards
            '.food-meal-header', '.food-meal-info', '.food-meal-name',
            '.food-meal-actions', '.food-nutrition-row',
            // Food summary
            '.food-summary-wrapper', '.food-summary-details', '.food-select-btn',
            // Food DB cards
            '.food-db-actions-row', '.food-db-info', '.food-db-name',
            '.food-db-macros', '.food-db-meta', '.food-meal-badge',
            // List reset
            '.list-reset',
            // Additional utilities
            '.flex-1', '.flex-wrap', '.text-xs', '.text-sm', '.text-error',
            '.mt-lg', '.mt-xl',
            // Empty/error state
            '.empty-state-msg', '.no-data-msg',
            // PWA update toast
            '.pwa-update-toast', '.pwa-update-btn',
            // Sync debug panel
            '.sync-debug-panel',
            // Workout components (paper-era classes still used as dual-class alongside wg-* equivalents)
            '.workout-pending-msg',
            '.workout-variant-card', '.workout-variant-desc',
            '.workout-exercise-card', '.workout-exercise-meta',
            '.workout-delete-btn-inline',
            '.workout-btn-row', '.workout-btn-stop', '.workout-btn-skip',
            '.workout-btn-full', '.workout-btn-full-secondary',
            '.exercise-log-header', '.exercise-log-delete-btn',
            // Food product link
            '.food-product-link',
            // Sync hint
            '.sync-hint-dim',
        ];

        const missing = requiredClasses.filter(cls => {
            const escaped = cls.replace('.', '\\.');
            const re = new RegExp(`(?:^|[,\\s])${escaped}(?:[\\s,.:{[>~+]|$)`, 'm');
            return !re.test(css);
        });

        if (missing.length > 0) {
            throw new Error(
                `Missing utility/component CSS classes in styles.css:\n\n` +
                missing.map(c => `  • ${c}`).join('\n')
            );
        }
    });

    it('bottom tab strip is absent — Today is the primary nav', () => {
        const htmlPath = path.join(REPO_ROOT, 'web/static/index.html');
        const html = fs.readFileSync(htmlPath, 'utf8');

        if (/<nav\s+id=["']tabs["']/i.test(html)) {
            throw new Error(
                'index.html still contains <nav id="tabs"> — the tab strip was removed in favor ' +
                'of Today-as-primary-nav. Section views are entered via Today cards or deep links.'
            );
        }
    });

    it('viewport meta tag does not contain user-scalable=no', () => {
        const htmlPath = path.join(REPO_ROOT, 'web/static/index.html');
        const html = fs.readFileSync(htmlPath, 'utf8');

        const viewportMatch = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/);
        expect(viewportMatch).not.toBeNull();

        if (viewportMatch[1].includes('user-scalable=no')) {
            throw new Error(
                'viewport meta tag still contains user-scalable=no — remove it for accessibility'
            );
        }
    });

    it('Telegram theme mirrors are preserved in :root', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const rootBlock = extractRootBlock(css);

        const telegramTokens = [
            '--bg-color',
            '--text-color',
            '--hint-color',
            '--link-color',
            '--button-color',
            '--button-text-color',
            '--secondary-bg-color',
        ];

        const defined = extractCustomProperties(rootBlock);
        const missing = telegramTokens.filter(t => !defined.has(t));

        if (missing.length > 0) {
            throw new Error(
                `Missing Telegram theme tokens in :root:\n\n` +
                missing.map(t => `  • ${t}`).join('\n')
            );
        }
    });
});

describe('Architecture – Wandergeek tokens', () => {
    it(':root block contains all Wandergeek (--wg-*) tokens', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const rootBlock = extractRootBlock(css);
        expect(rootBlock).not.toBe('');

        const defined = extractCustomProperties(rootBlock);
        const missing = WANDERGEEK_TOKENS.filter(t => !defined.has(t));

        if (missing.length > 0) {
            throw new Error(
                `Missing Wandergeek tokens in :root block of styles.css:\n\n` +
                missing.map(t => `  • ${t}`).join('\n') +
                `\n\nAdd them under the "Wandergeek Design System" comment block.`
            );
        }
    });

    it('no --wg-* tokens are referenced from JS source files (except structural allowlist)', () => {
        // Structural variables (not visual values) are allowed on a
        // per-file, per-token basis. Visual tokens (colors, gradients,
        // shadows, spacing) must stay CSS-only.
        //
        // --wg-nav-cols in wg-bottom-nav.js: items.length determines the
        //   grid's column count; it's a structural integer, not a visual
        //   value, and setting it via style.setProperty is the documented
        //   pattern from the design plan (Task 5).
        const ALLOWED_JS_TOKEN_REFS = {
            'web/static/js/components/wg-bottom-nav.js': new Set(['--wg-nav-cols']),
        };

        const jsDir = path.join(REPO_ROOT, 'web/static/js');
        const offenders = [];

        function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === 'tests' || entry.name === 'vendor') continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.isFile() && entry.name.endsWith('.js')) {
                    const content = fs.readFileSync(full, 'utf8');
                    const lines = content.split('\n');
                    const rel = path.relative(REPO_ROOT, full);
                    const allowedForFile = ALLOWED_JS_TOKEN_REFS[rel] || new Set();
                    lines.forEach((line, i) => {
                        const matches = line.match(/--wg-[a-z0-9-]+/gi);
                        if (!matches) return;
                        for (const m of matches) {
                            if (!allowedForFile.has(m)) {
                                offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
                                return;
                            }
                        }
                    });
                }
            }
        }

        if (fs.existsSync(jsDir)) walk(jsDir);

        if (offenders.length > 0) {
            throw new Error(
                `Wandergeek --wg-* tokens are CSS-only; found JS references:\n\n` +
                offenders.map(o => `  • ${o}`).join('\n') +
                `\n\nMove the color/gradient logic into a CSS class and reference the class from JS instead.`
            );
        }
    });

    it('BP status tokens give each classifier key a distinct underlying tag triplet', () => {
        // The BP classifier returns four keys (normal / highnormal / grade1 /
        // grade2); the Phase 3 alias layer must map them so Normal and
        // High-normal do not visually collapse.
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        const rootBlock = extractRootBlock(css);
        const aliasRe = /--wg-bp-status-(\w+)-bg:\s*var\((--wg-tag-[\w-]+-bg)\)/g;
        const mapping = new Map();
        let m;
        while ((m = aliasRe.exec(rootBlock)) !== null) {
            mapping.set(m[1], m[2]);
        }
        expect(mapping.get('normal')).toBeDefined();
        expect(mapping.get('highnormal')).toBeDefined();
        expect(mapping.get('normal')).not.toBe(mapping.get('highnormal'));
    });
});
