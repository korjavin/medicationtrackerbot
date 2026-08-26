# Competitor Research Brief

Research task for AGY (web search). Coordinator: Claude (same agterm session). Owner will read the synthesis in the morning — **comprehensiveness beats speed**; take the time you need.

## Our product, for positioning

Self-hosted health-tracking PWA covering medications (schedules, intake log, inventory/restock, reminders), blood pressure, weight, workouts (plans, rotation, per-set logging), sleep, vitals (HR/SpO2/stress, Mi Band import), food/nutrition (with AI parsing), and diary — built around a **zero-knowledge vault**: the browser holds the keys and plaintext, the server only stores encrypted sync state and runs a blind push relay. Passkey/WebAuthn key management, offline-first, optional AI/chat integrations, MCP agent surface, full encrypted export/import. Single-operator self-hosted deployment.

## What to research

Cover at least these categories; add competitors you discover along the way:

1. **Medication trackers**: Medisafe, MyTherapy, Round Health, Dosecast, MedM — and any strong newer entrants.
2. **General health/habit trackers with med features**: Apple Health, Google Health Connect ecosystem, Samsung Health.
3. **Open-source / self-hosted health apps**: wger, openScale, Waistline, Gadgetbridge, Loop Habit Tracker, Drip, Nightscout (as the self-hosted archetype), Home Assistant health integrations, Fasten Health, GNU Health — and anything else active.
4. **Privacy-first / E2EE health products**: anything claiming end-to-end encryption or zero-knowledge for health data.
5. **Multi-metric personal-health dashboards** (BP + weight + sleep + food in one place), commercial or OSS.

## Per-competitor file

One markdown file per competitor in this folder: `<slug>.md` (e.g. `medisafe.md`). Use exactly these sections so synthesis can be mechanical:

- **What it is** (2–3 sentences)
- **Platform**: iOS/Android/web/PWA/desktop; native vs web
- **Hosting model**: SaaS / self-hosted / local-only; open source? license?
- **Feature coverage**: for each of — medications (schedule/reminders/inventory), BP, weight, workouts, sleep, vitals/wearables, food/nutrition, diary/notes — say yes/no/partial with one clause of detail
- **Privacy & encryption**: where data lives, E2EE or server-side plaintext, what the vendor can see, data-sale/ads history if any
- **Data ownership**: export formats, import, API, lock-in
- **Reminders/notifications**: how delivered, does it work offline
- **Integrations**: wearables, EHR, AI features
- **Pricing / sustainability**: free/paid/subscription; for OSS: activity level (last release, contributor count)
- **Sources**: URLs for every non-obvious claim, with access date

## Rules

- Cite sources; mark anything uncertain as `(unverified)`.
- Prefer primary sources (official docs, repos, privacy policies) over blog listicles.
- Also write `_landscape.md`: cross-cutting notes — market gaps, who is closest to our zero-knowledge self-hosted positioning, notable dead/abandoned projects worth learning from.
- Don't write the summary/matrix — Claude synthesizes that from your files.
- Commit as you go or at the end, your choice; ping Claude via peer chat when the collection is complete (or if you want scope guidance mid-way).
