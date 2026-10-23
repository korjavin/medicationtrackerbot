# Brief — Update stock (one sheet, added or counted)

Short single-feature brief. Screens land in `ui_kits/app-v2/screens-meds.html` as ST1…; beads
reference them as `Spec: screens-meds.html STn`. Bead med-wi09.13 (Phase 3 of the dose engine).

## What it does

Stock becomes a ledger: every change says whether pills were **added** (a refill, +n) or
**counted** (an absolute count). Current stock = the last count + refills since − doses taken
since. There is no single number to overwrite. The owner asked why that should mean two buttons
("Add refill" / "Count stock"). It doesn't: one **Update stock** action opens one sheet.

## Owner decisions (2026-10-23, msg 3572)

1. One "Update stock" sheet with an **Added | Counted** switch at the top (`.wg-seg--accent`:
   it is a mode switch in a sheet, kit rule 1). **Added** is the default.
2. Optional **pack size** on the medication (editor M6), so that a refill is one tap "+1 pack
   (28)". Draw it as optional: when no pack size is set, the "+1 pack" chip is absent.

## Screens wanted

- **ST1 Update stock · Added.** Preset chips +30 / +60 / +90, "+1 pack (28)" first when a
  pack size is set, and a stepper for any other amount. The primary previews the result:
  "Add 30 → 47".
- **ST2 Update stock · Counted.** "How many do you have now?" with a stepper prefilled with the
  app's current number. The primary says what changes: "Set to 45 (app had 47)".
- **ST3 Stock history.** In the same sheet, under the form: the last movements, newest first
  ("Counted 45 · 12 Oct", "+30 · 20 Oct"), with doses taken since summarised as "−14 taken
  since 12 Oct". A wrong entry is fixed by adding a new count, not by editing history.
- **ST4 M3 Stock list.** The existing M3 rows get one "Update" action per med (replacing the
  inline refill chips), and the Stock tab keeps "lasts N days".
- **ST5 M6 editor.** The optional "Pack size" row in the inventory section.

## Neighbouring kit screens

M3 Stock (inline refill chips today), M6 editor (inventory + advanced; stock stepper), M2 take
sheet (flow sheet pattern).

## Constraints

`wg-*` kit v2 at 390×844, dark only. Flows: the primary sits in `.wg-sheet__foot` (kit rule 2).
One sun-filled control per view. Status only via tokens; "Out · N over" for negative stock
(kit rule 4). No emoji.
