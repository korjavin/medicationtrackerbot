# Mobile Phase 2c: First-run setup + secrets storage

## Status

Stub. Captured as a follow-up to `docs/plans/2026-05-22-mobile-phase2a-android-go-embedding.md` and `docs/plans/2026-05-22-mobile-phase2b-native-plugins.md`. **Do not start until 2a and 2b are both shipped and stable** — first-run is the user's *first* impression and should sit on top of polished plumbing, not be the thing that smokes it out.

## Overview

A fresh install of the mobile app launches into an empty SQLite database, no API keys configured, no user provisioned, no permissions granted. Phase 2a's `LocalUserResolver` returns a fixed user id but doesn't *create* the user row. Phase 2b's permission dialogs fire lazily on first use, which is functional but feels haphazard. The Settings repo on a fresh device has zero entries — features that depend on OpenAI keys (photo meal logging, food NL parsing) currently render an empty "Configure to enable" state with no path to actually configure.

This plan introduces a guided first-run flow that runs once after install, provisions the local user, prompts for optional configuration (OpenAI, Food DB), requests permissions proactively where it makes sense, and seeds enough defaults that the app feels alive from the first tap. It also addresses the secrets-storage question that Phase 2a punted on: do we keep API keys in SQLite plaintext, or move them to `EncryptedSharedPreferences` / Android Keystore?

## Goals

- **Guided first-run** — a 3–4 screen flow on first launch: welcome → permissions → optional API key setup → done. Skippable at every step; the app is fully functional even if every step is skipped.
- **User provisioning** — ensure a `users` row exists with id matching what `LocalUserResolver` returns. Idempotent (subsequent launches no-op).
- **Secrets decision** — pick one of: (a) keep API keys in SQLite plaintext, document the threat model and move on; (b) move secrets to Android Keystore via `EncryptedSharedPreferences`, with a Go-side init endpoint that the shell calls on launch to hand over the decrypted keys. Lean (a) for MVP — user's device, user's data, no network exposure — with a written decision so it can be revisited.
- **Default seeding** — on first launch, seed the medication / workout catalogs with empty-but-explained states (e.g. "Tap + to add your first medication") instead of blank screens.
- **Permissions choreography** — request notifications + camera proactively during first-run if the user enables the relevant features. Lazy request for the rest.

## Out of scope (intentional)

- Multi-profile support — single-user device, no need. Locked in by `LocalUserResolver` design.
- Onboarding tutorial / feature tour — first-run is *setup*, not *teaching*. Tutorial is a separate concern if needed at all.
- Migration from server-mode export — users moving from a self-hosted server to mobile would need an import flow. Punt; file as future plan.

## Approach (sketch)

1. Add a `first_run_complete` flag in the settings table; gate the flow on its absence.
2. Build the first-run screens as a small `web/static/js/features/firstrun/` module. Pure frontend; reads/writes settings via existing endpoints. Designed to feel native (full-screen, no chrome) without being its own technology stack.
3. Add a `POST /api/firstrun/complete` endpoint that sets the flag, provisions the user row, and seeds defaults. Idempotent.
4. Wire the Capacitor shell so first-run screens use native permission prompts at the right moments (notifications on the reminder step, camera on the photo-meal step).
5. Document the secrets decision in `docs/local-mode.md` under the existing "Secrets storage" subsection; either keep the plaintext-SQLite path (with a written justification) or implement the Keystore handoff (more work, separate task list).

## Risks

- **Skippability vs guidance** — if every step is skippable, users may land in a blank app and bounce. Need at least one "you're done" affirmation that the app works without further setup.
- **Settings-flag race** — if the user kills the app mid-first-run, the next launch should resume cleanly, not crash or restart from scratch. Use per-step flags, not just a single done bit.
- **Keystore handoff fragility** — if we go that route, the Go binary needs to wait for the shell to push secrets before starting (or before unlocking features), introducing startup ordering risk. The Phase 2a embedded-shell plan does not currently model this. Stick with plaintext-SQLite unless threat model demands otherwise.

## Estimate

About 1–2 weeks if secrets stays plaintext-SQLite; +1 week if Keystore handoff is in scope. Total: 1–3 weeks across 2–3 PRs.

## Open questions

- Should the first-run flow be triggered server-side (`/api/bootstrap` returns `needs_first_run: true`) or client-side (frontend checks settings)? Lean client-side — simpler, and the bootstrap path is already chatty.
- Does the secrets decision (a) or (b) require a follow-up plan, or can it be one task inside this plan? If we pick (a), it's a paragraph in docs. If we pick (b), it's a full sub-plan.
- Should the first-run flow gate access to the rest of the app, or sit alongside it (user can dismiss to Today and configure later)? Lean alongside — gating creates friction without protecting anything.
- Do we want analytics / opt-in telemetry on first-run completion rates? Probably no for a self-hosted-philosophy app, but worth recording the decision.
