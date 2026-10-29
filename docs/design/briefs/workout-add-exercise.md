# Brief: add an exercise mid-workout (epic med-okwf, beads .2 .3 .4)

Developer (2026-10-27): an added exercise lands as done; the add button hides behind the
progress bar (overview); the dialog asks sets/reps/weight like a log-after-the-fact form; Next ›
could lead to "add exercise" with a few logical suggestions.

## Today (origin/master)
- `features/workout/sessions.js` `_sessionAddExerciseButton` (~421): "+ Exercise" only in the
  overview (tap the progress bar) and in the empty session. Footer (~2391) is Prev / Next only,
  rendered when n > 1; Next is disabled on the last exercise.
- Add sheet `#workout-add-exercise-to-session-modal` (`index.html` ~2008): name + inline
  suggestions, then Sets / Reps / Weight / Notes and Save; title becomes "Log set · <name>".
- A new exercise is appended at the end and the takeover jumps to it (~3094).

## Screens (ids WA1–WA6, new)
- **WA1** Exercise screen with the footer add button (.2).
- **WA2** Overview with "Add exercise" as the last row of the list (.2).
- **WA3** Add sheet: "Up next" suggestions + search; tap a row = added (.3, shares WA5's list).
- **WA4** Landed: the new exercise current, one pending set pre-filled (last / default / empty),
  Undo toast (.3).
- **WA5** Next › on the last exercise: the "What's next?" step in the takeover (.4).
- **WA6** Step with no history: search + library picks only (.4).

## Open questions (my recommendation in brackets)
1. Where's the button? (Footer, every exercise screen: `Saved · [+ Exercise] · ‹ · Next ›`.
   Overview: last row of the list. The top bar keeps only Finish, as med-t5s6 set it.)
2. Save button in the add sheet? (No: tapping a row adds it. A typed name not in the list gets
   a row "Add "<name>"".)
3. The pre-filled set? (It is a normal pending set: ghost values with a small "last" or
   "default" label, ticked like a planned set. No values → empty cells.)
4. Sheet and Next-step content? (The same: up to 3 suggestions with a reason line, then search.
   One component, two places.)
5. Suggestions as chips or rows? (Rows with a reason: "Usually after Bench press", "Back not
   trained today", "Last done Mon". Chips can't carry the reason.)
6. Undo after adding? (Yes, a toast "Added Lateral raise · Undo"; Undo removes it, nothing logged.)
7. Order: the new exercise goes to the end, like today (no reordering model needed).

## Answers (Developer, 2026-10-29)
1 yes, but Prev/Next become equal labelled buttons and the add button is a plus icon on the left. 2 no Save. 3 ok. 4 ok. 5 no reasons at all. 6 no Undo. 7 yes. Added: delete a set, with a confirm (WA7, WA7b; med-okwf.6). Frames: `ui_kits/app-v2/screens-workout-add.html`.
