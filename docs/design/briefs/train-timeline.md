# Train timeline (Workouts rethink)

Developer 2026-11-04 (Zulip 13666, brief by Miles 13668): the History list isn't liked; the next-workout card is hard to read. "Ad hoc" and "Next Day" confuse people.

**Success:** without explanation a first-time user can (1) start today's planned workout, (2) start one outside the plan, (3) pick a different plan day, (4) see the last weeks at a glance.

**Screens:** `ui_kits/app-v2/screens-train-timeline.html` WN1–WN7. Neighbours: session takeover W1–W4 / WA / WS (unchanged), Plans P1–P3, meds timeline v2 (TL, the show-more pattern).

**Must not break:** `workouts` section id and deeplinks, sub-tab id `history`, per-set logging, PRs/1RM, plan rotation, Telegram `/workout`, Telegram/voice-logged sessions, gym switch.

**Decisions:** see INDEX changelog 2026-11-04. Round 2 (Developer, 7-day plan with long day names): the inline day segments became a plan line plus an "Other plan day" sheet.

**Out of scope:** new workout features; Plans tab redesign (separate task).
