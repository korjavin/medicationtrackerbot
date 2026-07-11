# Design: Workouts IA rework — simpler plans, honest rotation

**Bead:** med-prk.1 (epic med-prk — Workouts UX rework)
**Date:** 2026-07-11 · **Status:** agreed with owner (decisions below)
**Follow-ups:** implementation-plan bead (this doc → plan); feeds med-prk.2 (library-by-reference).

## Problem

The Workouts section overloads users with a four-part model — **group → variant → exercise**, plus a **separate exercise library**, plus **ad-hoc** sessions. Two concrete symptoms:

1. **The variant layer is dead weight for the common case.** A *non-rotating* group can't own exercises directly (`workout_exercises.variant_id` is NOT NULL), so the UI silently auto-creates a hidden variant named "Main" just to hang exercises on it (`web/static/js/features/workout/groups.js:315-343`, duplicated at `groups.js:369-391` and `exercises.js:120-148`). The model itself admits the layer is unnecessary here.
2. **"Three exercise lists."** The same conceptual "list of exercises" appears in three UIs backed by different tables: the **Exercises/Library** tab (`exercise_library`, `library.js`), **plan exercises** per variant (`workout_exercises`, `exercises.js`), and **ad-hoc/in-session** adds (`workout_exercise_logs`, picker in `sessions.js`). Places 1 and 3 already treat the library as the master (both use it as their autocomplete source); only place 2 writes a separate copy. Users perceive three lists where there should be one.

Both modes share the `web/static` frontend, so IA changes are mode-agnostic; `web/domain/workout.js` mirrors the same model for cloud and must move in lockstep (any `/api` contract change lands in Go **and** `web/domain/workout.js` together).

## Decisions (agreed with owner, 2026-07-11)

| # | Decision |
|---|---|
| D1 | **Rotation stays first-class.** The owner relies on A/B/C rotation; the engine auto-picking the next day is core. We do **not** cut variants — we stop *faking* them in the simple case. |
| D2 | **Simple is the default.** Creating a workout defaults to a single flat exercise list with **no** rotation/variant UI **and no phantom "Main" row**. Rotation is an explicit opt-in toggle. |
| D3 | **"Group" → "Plan".** The schedulable container (days-of-week, time, notifications) is a **Plan**. Tab "Groups" → "Plans". |
| D4 | **"Variant" → "Day".** In rotating mode the cycling sub-units are **Days** (Push Day / Pull Day / Leg Day). To avoid collision with the plan's schedule, scheduling copy changes from "days of week" to **"Repeats on: Mon / Wed / Fri"**. |
| D5 | **One master, one picker.** The **Exercises** tab stays as the master catalog (the library = single source of truth). Every add-exercise flow — plan editing *and* in-session — uses the **same picker**: search the library, or "create new" which adds to the library. This is the IA-level statement that **med-prk.2** enforces in the data layer via references (and un-empties the Exercises tab, closing med-spp). |

## Target IA

Tabs: **History · Plans · Exercises · Stats** (unchanged set; "Groups"→"Plans").

### Plans tab

```
Plans
 ├ "Upper Body"      (simple)   → flat exercise list
 ├ "Full Body"       (simple)   → flat exercise list
 └ "My Split"        (rotating) → cycles Days
      ├ Day A: Push
      ├ Day B: Pull
      └ Day C: Legs
    Repeats on: Mon / Wed / Fri · 18:00
```

- **Create Plan** → name + exercise list. That's it. No rotation words on screen.
- **"Rotate through multiple days"** toggle (off by default). On → reveals the Days editor; the plan's single list becomes "Day A", and the user adds Day B/C. The rotation engine (`AdvanceRotation`, `internal/store/workout/repo.go:685`) drives "next Day".
- Turning rotation **off** on a multi-day plan is a destructive/merge choice — flag for the implementation plan (keep Day A, warn the rest are dropped, or block while >1 Day exists). Not decided here.

### Exercises tab (master library)

- Browse / rename / clean up the canonical catalog. Rename propagates to plans & history once med-prk.2 lands (a link is a link — surface that in copy).
- The **only** place exercises are *managed*; plans and sessions *reference* it.

### Add-exercise (one shared path)

- A single picker component used by (a) editing a plan's list and (b) adding mid-session. Behaviour: type to search the library → pick, or "Add '<typed name>' as new" → creates a library entry and references it. Removes the current split where `sessions.js:911` refuses names not already in the library.

## Flows (happy path)

1. **New simple plan:** Plans → New → "Upper Body" → add exercises (picker) → save. Zero rotation/variant/"Main" concepts surfaced.
2. **Upgrade to rotating:** open plan → toggle "Rotate through days" → existing list becomes Day A → add Day B/C → set "Repeats on" → save.
3. **Run + log:** start today's session (rotation picks the Day) → log sets → optionally add an exercise via the same picker (lands in the library + this session).
4. **Manage catalog:** Exercises tab → rename/merge/clean; changes reflect everywhere (post med-prk.2).

## Out of scope / hand to implementation plan

- **Schema question:** does a simple plan keep one hidden variant server-side (smallest change; keep `workout_exercises.variant_id`) or do we allow group-owned exercises (bigger migration)? The design only requires that **the user never sees "variant/Day" until rotation is on**. Recommend the hidden-single-variant route unless med-prk.2's reference work makes group-ownership cheap — decide in the plan.
- Rotation **off**-switch semantics (D-note above).
- Naming migration: user-facing strings only (Group→Plan, Variant→Day, "days of week"→"Repeats on"); internal ids/tables/`is_rotating`/`rotation_order` stay to avoid churn. The Vitals-slot precedent (label changes, internal id stays) applies.
- Cloud parity: mirror every contract change in `web/domain/workout.js`; contract-parity test per med-prk.2.

## Next step

File the **implementation-plan bead** under med-prk from this doc (IA + the two deferred decisions), sequenced with med-prk.2 (library-by-reference) since both touch the same tables.
