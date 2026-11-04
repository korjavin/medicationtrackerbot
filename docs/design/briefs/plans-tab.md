# Plans tab redesign

Developer, 2026-11-04 (design: train timeline, 13714): "reconsider Plan tab also", timing left to Iris; started after the timeline spec was handed off (epic med-soo0).

## Problem (what ships)
- `features/workout/groups.js` `_buildWorkoutGroupRow`: the tab is a list of plan names ("Mon, Wed, Fri · 18:00 · Rotating"). It says nothing about the days or what's next.
- A tap opens `openWorkoutPlanPage` with Save in the bar: reading a plan means entering the editor.
- Day rows (`variants.js` `buildWorkoutDayRow`) append the full description to the meta line, so long descriptions run as mono lines (owner's 7-day plan).
- "Add plan" is a sun in the app bar on a tab that is mostly read.

## Screens (`ui_kits/app-v2/screens-plans.html`)
PL1 the plan card with every day, PL2 a read-only day page with Start this day, PL3 the editor (P1 with small changes), PL4 two active plans, PL5 no plan, PL6 the Share or print sheet. Neighbours: WN1/WN7 (Timeline), P1–P3 (editor pages).

## Open questions (recommended answer first)
1. Open the plan read-first, editor behind Edit? **Yes.**
2. "Start this day" on the day page (uses med-soo0.1's set-variant)? **Yes.**
3. Descriptions only on the day page, not in rows? **Yes.**
4. Add plan → New plan / Import plan rows at the end; no sun on the tab when a plan exists? **Yes.**
5. "Rotate through days" → "Take days in turn"? **Yes.**

## Data notes for Archie
Per-day last-done date for every active plan (soo0.1 adds it to getNext for the current plan only); per-exercise last performance on the day page (exists for the session's "last" ghost values). Web only, WebView everywhere.
