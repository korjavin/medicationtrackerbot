# Wandergeek Design Arc — Retrospective

Closing note for the per-screen Wandergeek rewrite (Phases 1–9). Captures the final
token surface, primitive inventory, and the follow-up work that the arc surfaced
but intentionally deferred.

## Arc summary

| Phase | Scope | Plan |
|-------|-------|------|
| 1 | Primitives (cards, gloss, icons, bottom nav, phone chrome) | `docs/plans/completed/2026-04-20-wandergeek-design-rewrite.md` |
| 2 | Token palette + architecture tests | same plan |
| 3 | BP screen + fixes rounds | `2026-04-20-wandergeek-phase3-bp*.md` |
| 4 | Food screen + fixes | `2026-04-22-wandergeek-phase4-food-fixes.md` |
| 5 | Medications screen | `2026-04-XX-wandergeek-phase5-meds.md` |
| 6 | Weight screen | `2026-04-XX-wandergeek-phase6-weight.md` |
| 7 | Workouts screen | `2026-04-XX-wandergeek-phase7-workouts.md` |
| 8 | Health screen (Overview + Notes) | `2026-04-XX-wandergeek-phase8-health.md` |
| 9 | Settings screen + `WGToggle` primitive | this plan |

Every non-Today view is now Wandergeek-native. The canonical bottom nav routes
to eight first-class sections (`today, bp, food, meds, weight, workouts, health,
settings`); there is no "More" aggregator.

## Final token surface

Authoritative list: `WANDERGEEK_TOKENS` in
`web/static/js/tests/architecture.design-tokens.test.js`. Groups:

- Palette — raw primitives (`--wg-paper*`, `--wg-ink*` alphas, `--wg-teal*`,
  `--wg-mint*`, `--wg-sun*`, `--wg-clay*`).
- Semantic — role aliases (`--wg-bg-*`, `--wg-fg-1..5`, `--wg-border-*`).
- Gloss material — gradients + shadows for the convex tile look
  (`--wg-gloss-bg*`, `--wg-gloss-shadow*`).
- Status tags — per-severity triplets (`--wg-tag-{normal,high,alert}-{bg,fg,border}`).
- Typography — `--wg-font-{display,ui,mono}` and per-role size tokens.
- Dimensional — radii, padding, component sizing, nav/app-header/phone-chrome
  dimensions, chart inner geometry.
- Input state (introduced in Phase 9) — `--wg-toggle-{bg,bg-on,knob,knob-on,
  border,border-focus,border-disabled}` plus `--wg-settings-*` layout tokens.

Rule (enforced by `architecture.wg-primitives.test.js`): every `.wg-*` class
block sources colors/gradients/shadows from `var(--wg-*)`. Hex literals inside
`.wg-*` blocks fail CI. Tokens live in CSS only; JS sets class names.

## Primitive inventory

Located in `web/static/js/components/`:

- Shell — `wg-phone-chrome.js` (primitive; not yet mounted runtime-wide),
  `wg-bottom-nav.js`, `wg-icons.js`, `section-header.js` (app header / back pill).
- Tiles + layout — `stat-card.js`, `action-row.js`, `empty-state.js`,
  `mt-elements.js` (`<mt-modal>`, `<mt-setting-toggle>`).
- Charts — `wg-sparkline.js`, `wg-bp-chart.js`, `wg-weight-chart.js`,
  `wg-workout-chart.js`, `wg-macro-bar.js`, `wg-sleep-chart.js`,
  `wg-steps-chart.js`, `wg-vitals-chart.js`.
- Inputs — `wg-toggle.js` (new in Phase 9; used by `<mt-setting-toggle>`).
- Section helpers — `wg-settings.js` (sectioned card + row + info-row + number
  field helpers).

Shared modal + field shell lives in `styles.css` as utility classes (`.wg-modal*`,
`.wg-field*`, `.wg-label`, `.wg-input`, `.wg-select`, `.wg-gloss*`, `.wg-fab`).
Future sections reuse these rather than introducing scoped variants.

## Follow-ups (explicitly deferred)

Named but not scheduled; each is a future phase or standalone ticket.

- **Shared chart base (`WGChart`)** — six chart primitives duplicate axis /
  grid / tick logic. Extract only if per-chart drift stays small enough to keep
  the abstraction thin. Tracked as Phase 11 in the Phase 9 plan.
- **Dark theme** — palette tokens are structured for a `prefers-color-scheme:
  dark` variant but no dark values are defined. Tracked as Phase 10.
- **Reduced-motion parity** — `:active` transforms on gloss tiles, chart
  draw-in animations, and modal transitions should respect
  `prefers-reduced-motion`. Tracked as Phase 10.
- **A11y audit** — minimum-touch-target, contrast on status tags + webpush
  messages, form-label association, keyboard focus order on the Settings long
  form. Tracked as Phase 10.
- **Phone-chrome runtime mount** — `<wg-phone-chrome>` exists as a primitive
  but is not wrapped around screens at runtime. Wrapping it in is a separate
  decision (visual effect vs. viewport cost on real devices).
- **Tab-order editor UI** — `tab_order` persists to the server but no
  reorderable surface exposes it. Inert until a surface lands.

## Open questions (not blockers)

- Does the webpush status tag need a distinct "pending" variant alongside
  success / alert / muted, or is muted sufficient? Phase 9 shipped with muted.
- When `<wg-phone-chrome>` does mount at runtime, should Today mount inside it
  too, or stay full-bleed? Not decided.

## References

- Token rules + architecture tests: `docs/frontend.md` §Wandergeek tokens.
- Per-screen plans: `docs/plans/completed/2026-04-*-wandergeek-*.md`.
- Plan sequence + follow-up phases: end of
  `docs/plans/completed/2026-04-XX-wandergeek-phase9-settings.md`.
