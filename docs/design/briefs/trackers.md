# Brief — User trackers

Short single-feature brief (claude-design skill, "Owner decisions"). Screens land in
`ui_kits/app-v2/screens-trackers.html`; beads reference them as `Spec: screens-trackers.html TRn`.

## What it does

User-defined "track anything" trackers on the Today screen: water 8/day, coffee ≤3/day,
no alcohol, stretching 3/week, vitamins. Two kinds only:

- **count**: each tap adds `step` (default 1) in an optional `unit` ("glass", "cup").
- **check**: done / not done for the day.

Each tracker has a target `{op: atLeast | atMost, value, period: day | week | month}`. atLeast
is a goal, atMost is a limit. It also has an optional `emoji`, an optional daily `reminder` time
(HH:MM), and `archived` (archiving is how you delete; history is kept). Day and week boundaries
follow the account time zone, and weeks are ISO weeks.

The domain module is already merged. For each tracker, the list API returns
`progress: {total, target, met}` for the current period. For atMost, an empty period counts as
met. There is also a `history(trackerId, days=30)` call that returns per-day totals, which is
what TR3 shows.

Owner decisions: v1 has no timer or rating kinds. Trackers get **habit strength only, with
no HP, score or ring awards**. The feature lives in a card on Today with a modal for
management, and adds **no new nav section**.

Beads:
- `med-1vy5`: epic (data model and owner decisions)
- `med-1vy5.2`: Today Trackers card
- `med-1vy5.3`: create/edit modal with templates
- `med-1vy5.4`: habit strength
- `med-1vy5.5`: reminders, which fire only when an atLeast target is unmet

## Screens wanted

**TR1: Today Trackers card** (sits in T1/T2, below the vitals strip, near Fuel/Sleep/Steps)
- One tile per non-archived tracker, showing the emoji (or icon), the name and the
  current-period progress.
- Card header: the title "Trackers" plus "+" (create) and "manage" affordances.
- States to draw:
  - count atLeast in progress: "5 / 8 glasses"
  - count atLeast met
  - count atMost under the limit: "2 / ≤3"
  - atMost at the limit
  - atMost **over the limit** (a distinct state, using danger/warn tokens)
  - check undone
  - check done
  - weekly tracker: "2 / 3 this week"
- Tap = +step (count) or toggle (check). Progress updates instantly, and an undo toast
  ("Water +1 · Undo") removes exactly that tap.
- Empty state: no trackers yet. Use a `wg-empty` with a CTA that opens TR2 on the template step.
- Offline: tiles still work from cache, as in T5.

**TR1b: Tracker log sheet** (opened by long-press or the secondary action on a tile)
- Enter a custom amount for count trackers.
- Today's logs as rows (time + amount), each with swipe-to-delete and undo, per kit rule 3.
- A link to edit the tracker (TR2) and to its history (TR3).

**TR2: Create / edit tracker** (sheet or pushed page; follow the M5/F8 form patterns)
- Create starts with a **template picker**:
  - Water: count, glass, ≥8/day
  - Coffee: count, cup, ≤3/day
  - No alcohol: check, ≥1/day
  - Stretching: check, ≥3/week
  - Vitamins: check, ≥1/day
  - Custom
- A template prefills the form, and the user can still change anything.
- Form fields:
  - name
  - emoji
  - kind (count | check)
  - unit and step (count only)
  - target: Goal (at least) vs Limit (at most), the value, and per day / week / month
  - reminder time (optional; atLeast only, see Q6)
- Header: X dismiss plus Save top-right (med-q7k2 convention).
- Inline validation errors.
- Edit mode adds **Archive** behind a `wg-dialog` confirm.
- Draw it in create-from-template, edit and validation-error states.

**TR3: Tracker detail / history** (optional, but `history()` already exists)
- The last 30 days as a strip or bars, with met/missed per day (or per week).
- The habit strength value (med-1vy5.4), shown as plain strength, not HP.
- The current period's progress, plus the Edit and Archive entry points.

## Sits next to (kit v2 ids)

- T1, T2, T4, T5 and T6 in `screens-today.html` (card placement, empty, offline, skeleton)
- T3 Log sheet (should trackers appear in it?)
- M5/M6 editor and F8 manual form (form patterns)
- F2 swipe + undo (log rows)
- J1 (strength display)

## Constraints

- Use `wg-*` kit tokens and components only (`tokens.css`, `components.css`, `icons.js`).
  Status colors come only from the ok / warn / danger / stale / pending tokens. No inline
  styles except `--p` / `--n`.
- Design at 390×844, in light and dark. Hit targets must be ≥ 44px.
- Kit rule 1: one sun-filled control per view. The tracker tiles must not compete with the
  Next-up action.
- No HP, score, ring or award visuals anywhere for trackers.
- No native dialogs, selects, checkboxes or time inputs as the visible control.
- English copy only.

## Open UX questions for the designer

1. **Emoji vs kit rule 4 ("No emoji").** The tracker model has a user `emoji` field. Options:
   allow it as user content on tiles only, map it to a `wg-ico`, or drop it.
2. **Tile vs row.** A tile grid (like Fuel/Sleep) or compact rows with a +/✓ button? How should
   the card handle 1 tracker versus 8?
3. **Over-limit tone.** When an atMost tracker goes past its limit, should it look like danger
   or a neutral warn? We need it non-judgemental but visible.
4. **Accidental taps.** Is an undo toast enough, or should the tap target be a separate "+"
   button so that tapping the tile body opens TR1b?
5. **Weekly / monthly display.** How should a weekly tracker show progress on a daily screen
   ("2/3 this week", days-left hint)?
6. **Reminder field for atMost.** Reminders only fire for unmet atLeast trackers. Should the
   field be hidden or disabled for limits?
7. **Card position and Log sheet.** Where should the card sit relative to the vitals strip and
   the Goal Line? Should T3 also list trackers?
8. **Archived trackers.** Is a "Show archived" list in manage enough, or is a restore flow needed?

## Owner answers (2026-10-11)

1. Emoji: allowed as user content on trackers (exception to kit rule 4).
2. Tiles (plates), not rows.
3. Over limit: soft warning, not danger.
4. Undo toast is enough; no separate "+" button.
5. Weekly/monthly progress on the daily screen: designer decides.
6. Reminder field for atMost trackers: designer decides.
7. Card sits above the Goal Line.
8. Restore of archived trackers: later; v1 needs no restore flow.

## Prompt for Claude Design

```
Read briefs/trackers.md (user trackers: count/check with goals or limits, a card on Today,
a create/edit modal with templates). Use ui_kits/app-v2/ as the source of truth: tokens.css,
components.css, icons.js and README.md for the kit rules; screens-today.html (T1–T6) for
the Today screen the card sits in; screens-meds.html M5/M6 and screens-food.html F2/F8 for
form, swipe and undo patterns.

First, give a short critical review of the brief: what's missing, what conflicts with the
kit rules (especially emoji vs "No emoji" and one sun control per view), and your answer
to each open question with a recommendation. Then design screens TR1 (Today Trackers card
in all listed states, inside a T1-style Today frame, plus the empty state), TR1b (tracker
log sheet), TR2 (create/edit with the template picker, edit, validation error and archive
confirm) and TR3 (tracker detail/history). Use only wg-* tokens and components, 390×844
phone frames, light and dark, no HP/score visuals, English copy. Put them in a new
ui_kits/app-v2/screens-trackers.html in the same board format as screens-today.html
(kit-cap captions with the TR ids), link it from ui_kits/app-v2/index.html, and add any
new component to components.css/components.html rather than inline styles.
```
