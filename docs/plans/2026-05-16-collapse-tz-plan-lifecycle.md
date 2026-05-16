# Collapse TZ-Transition Plan Lifecycle

## Status

Stub. Captured as a follow-up from `docs/plans/20260508-simplify-medication-scheduling-utc-and-pre-materialized-steps.md` (recommendations C + E from the original analysis). Not yet scheduled — start only after Track D of the parent plan has shipped and baked.

## Overview

The 2026-05-08 plan was a pure storage refactor: it canonicalised dose timestamps as UTC unix seconds and pre-materialised TZ-transition steps as `intake_log` rows, but **did not touch the plan-state machine**. `tz_transition_plans.status` still cycles through `PENDING_APPROVAL` → `NOTIFIED` → `APPROVED` → `COMPLETED` (plus `REJECTED`), driven by a notifier that nags the user, an HTTP/bot approve endpoint, and a scheduler tick that flips the plan to `COMPLETED` when no future-pending tz_step intake rows remain.

After Track D shipped, the four-state lifecycle is doing less work than it looks:

- `PENDING_APPROVAL` and `NOTIFIED` differ only in "did the bot send the prompt yet" — once the prompt path is reliable, the distinction collapses into a single timestamp.
- `APPROVED` is the only state where intake rows exist; the scheduler doesn't otherwise care about the lifecycle.
- `COMPLETED` is purely observability — once the steps are pre-materialised intake rows, "did this plan finish" is `COUNT(*) WHERE tz_plan_id = ? AND status = 'PENDING' = 0`, derivable on demand.

This plan collapses the state machine to **two timestamp columns** (`applied_at`, `acknowledged_at`) and lets the user opt out of the manual approve step entirely (recommendation E: auto-apply with an undo affordance).

## Goals

- **Recommendation C — collapse plan states into timestamps.** Replace `status` with two nullable timestamps: `applied_at_unix` (when intake rows were materialised) and `acknowledged_at_unix` (when the user explicitly confirmed they saw the plan). The four legacy states map to `(applied_at IS NULL, acknowledged_at IS NULL)` tuples; `REJECTED` becomes a deletion + audit event rather than a sticky status.
- **Recommendation E — auto-apply with undo.** Default behaviour: when a plan is created, materialise intake rows immediately and surface a notification with an "Undo" affordance valid for some window (e.g. 30 minutes). The user only needs to act if they disagree; the historical "approve every plan to make it real" friction goes away. Manual approval remains available as a per-user setting for users who want it.

## Out of scope

- The pre-materialisation model itself — already shipped by Track D of the parent plan.
- The TZ-detection heuristic that creates plans in the first place. Plan creation cadence is unchanged.
- Time-storage conventions (already canonicalised by Track A).

## Approach (sketch)

1. Add `applied_at_unix`, `acknowledged_at_unix` columns; backfill from the existing `status` + `approved_at_unix`.
2. Cut over readers (notifier, scheduler completion check, observability log lines) to derive lifecycle from the two timestamps. Keep `status` dual-written for one release.
3. Drop `status` via the standard SQLite table-rebuild pattern.
4. Introduce an `auto_apply` user setting (default off initially; flip to default-on after the undo path bakes).
5. Wire an undo affordance into the bot/web notification — calling undo within the window deletes the materialised intake rows and the plan, mirroring today's reject path.

## Risks

- **Undo window correctness.** The undo path must be safe to invoke after the user has *also* tapped "Confirm" on a materialised intake row — the row may be `TAKEN` by then. Decide whether undo is forbidden once any step has been confirmed, or whether confirmed steps survive the undo (preferred, but needs a clear UX).
- **Notifier idempotency under auto-apply.** Today's notifier guards on `status = NOTIFIED`. With timestamps replacing the state machine, the equivalent guard is "have we ever sent a notification for this plan" — needs a `notified_at_unix` column or a join through a `plan_notifications` audit table.
- **Lifecycle observability.** Existing slog lines and any future dashboard queries that group-by `status` need to migrate to the new shape.

## Estimate

About 1–2 weeks of work split across 3–4 PRs (schema + dual-write, reader cut-over, drop legacy column, auto-apply + undo). Comparable in shape to Track A of the parent plan.

## Open questions

- Should `auto_apply` be the default for new users, or stay opt-in indefinitely? Lean toward default-on once undo is proven; revisit after the first month of telemetry.
- Should "rejected" be a separate state or a deletion + audit log entry? Lean toward deletion: the plan no longer drives any behaviour, and an audit row in a generic `tz_events` table is more useful for debugging than a sticky `REJECTED` status.
- Does the auto-apply + undo model need a per-medication opt-out (e.g. for high-stakes meds where the user always wants to confirm)? Defer until there's a concrete user request.
