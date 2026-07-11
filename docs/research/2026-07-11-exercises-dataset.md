# Research: `hasaneyldrm/exercises-dataset` — what we can reuse

**Bead:** med-spf.1 (under epic med-prk — Workouts UX rework)
**Date:** 2026-07-11
**Repo:** https://github.com/hasaneyldrm/exercises-dataset (11k★, actively updated, powers the "LogPress" app)

## TL;DR

Reuse the **text metadata** (names + rich categorization + English instructions) as a **bundled static reference catalog** to power exercise autocomplete and auto-categorization. It fills the exact gap med-prk.2 exposes: our `exercise_library` is free-text `name` only, with **no** body-part / muscle / equipment data.

**Do NOT ship the media.** The ~1,300 GIFs (85% of the repo's 30 MB) are © Gym Visual under a *separate* commercial license, not MIT. Text is safe; images are not.

Treat it as a **read-only seed asset**, not per-user data — never load 1,324 rows into every user's DB or (worse) every encrypted cloud vault.

## What's in it

- **1,324 exercises**, single `data/exercises.json` (~15.9 MB), array of records.
- Real record shape (verbatim first entry, truncated instructions):
  ```json
  {
    "id": "0001",
    "name": "3/4 sit-up",
    "category": "waist",
    "body_part": "waist",
    "equipment": "body weight",
    "instructions": { "en": "Lie flat on your back...", "it": "...", "tr": "...", "es": "...", "ru": "...", "zh": "...", "hi": "...", "pl": "...", "ko": "..." },
    "muscle_group": "...", "secondary_muscles": "...", "target": "...",
    "image": "...", "gif_url": "videos/0001-....gif",
    "attribution": "© Gym visual — https://gymvisual.com/"
  }
  ```
- **Instructions in 9 languages** (en, es, it, tr, ru, zh, hi, pl, ko), both full text and ordered step arrays.
- **Categorization**: `body_part`/`category`, `equipment`, `muscle_group`, `secondary_muscles`, `target`.
- Body-part distribution: Upper Arms 292, Upper Legs 227, Back 203, Waist 169, Chest 163, Shoulders 143, rest (Lower Legs/Arms, Cardio, Neck) ~85.
- **~1,300 GIF animations** + 180×180 thumbnails under `videos/`.

## Licensing — the deciding constraint

GitHub classifies the repo as **NOASSERTION** (mixed license), confirmed by the README:

- **MIT** — code, tooling, dataset *structure*, and **instruction text**. Free to reuse.
- **Media (images + GIFs)** — "© Gym visual — https://gymvisual.com/", redistributed *with permission* at 180×180. README: *"Reuse is governed by Gym visual's Terms & Conditions; obtain your own license there before reusing the media."* Attribution string must stay intact.

For a self-hosted, privacy-first app we ship to users: **use the MIT text, skip the Gym-Visual media.** Bundling or hotlinking the GIFs would put someone else's commercial IP in our distribution. If we ever want visuals, that's a separate licensing decision (buy a Gym Visual license, or source CC-licensed art e.g. wger/GymWorkoutPlanner) — out of scope here.

## Fit against our model (feeds med-prk.2)

Current `exercise_library` (migration 028): `name`, `default_sets`, `default_reps_{min,max}`, `default_weight_kg`, `notes`, per-user (`UNIQUE(user_id, name)`). **No categorization at all.** med-prk.2 makes this the single source of truth via `exercise_library_id` references.

The dataset complements that cleanly:

| Dataset field | Use |
|---|---|
| `name` | Canonical names → autocomplete + dedupe when a user types an exercise (avoids near-duplicate "Bench press" vs "Barbell bench press"). |
| `body_part`, `muscle_group`, `secondary_muscles`, `target`, `equipment` | New optional columns / metadata to categorize the library (filter/group the Exercises tab by muscle — directly relevant to the med-prk IA rework). |
| `instructions.en` | Optional "how to perform" text on an exercise. |
| `id` (`"0001"`) | A stable external key to link a user's library row to the canonical entry (nullable `external_ref`), so re-imports stay idempotent. |
| GIFs / thumbnails | **Excluded** (Gym Visual license). |

Gaps / mismatches:
- Dataset has **no** default sets/reps/weight — those stay user-specific (fine; they're personal).
- Our library is **per-user**; the dataset is a **global catalog**. Don't duplicate 1,324 rows per user. Ship it as a **static bundled JSON asset** (frontend + Go-embedded) used for lookup/autocomplete; only *materialize* a library row when a user actually adds that exercise. Cloud mode: same — a static asset the browser reads, **never** written into the encrypted vault.
- 15.9 MB is too big to ship whole. Strip to **English-only + metadata** (drop 8 languages + media paths) → a few hundred KB. A tiny build-time script (like `cmd/genmcpcatalog`) can regenerate the trimmed asset.

## Recommendation

1. **Adopt** as a **build-time-derived, English-only, media-free static catalog** (canonical names + categorization + optional instructions). Keep the `© Gym visual` attribution only if we ever include media (we shouldn't).
2. **Wire into med-prk.2**: when the library becomes the source of truth, back autocomplete + the Exercises-tab grouping with this catalog; add nullable `external_ref` + categorization columns so a user's library row can link to a canonical entry without importing the whole set.
3. **Explicitly exclude the media.** Revisit only as a separate, licensed decision.
4. Vendor a **pinned copy** of the trimmed JSON (don't fetch at runtime) — the upstream is active and could change field shapes.

## Not doing (YAGNI)

- No 9-language instructions (English only until localization is a real ask).
- No GIFs/thumbnails (license).
- No per-user seeding of the full 1,324-row set.
