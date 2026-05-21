---------------------------- MODULE IntakeStateMachine ----------------------------
(***************************************************************************)
(* Models the medication-intake state machine and the TOCTOU race in      *)
(* SilenceIntake that was patched in commit 6dfa23a0.                      *)
(*                                                                          *)
(* The domain operation medicationService.SilenceIntake is two steps:     *)
(*                                                                          *)
(*   1. GetIntake; check intake.Status == "PENDING"                        *)
(*   2. SnoozeIntake -> UPDATE intake_log SET snoozed_until = ?            *)
(*                      WHERE id = ? [AND status = 'PENDING']               *)
(*                                                                          *)
(* The fix added the bracketed WHERE-clause guard. Without it, a           *)
(* concurrent ConfirmIntake or SkipIntake firing between steps 1 and 2     *)
(* still let the snooze UPDATE succeed, leaving snoozed_until set on an    *)
(* already-finalized intake AND telling the user "Silenced for 24h".       *)
(*                                                                          *)
(* Two configurations exercise the model:                                  *)
(*   Buggy.cfg  - BuggySnooze = TRUE: pre-fix unguarded UPDATE.            *)
(*                TLC must report NoFalseSilence VIOLATED.                 *)
(*   Fixed.cfg  - BuggySnooze = FALSE: post-fix guarded UPDATE.            *)
(*                TLC must report NoFalseSilence HOLDS.                    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Actors,        \* set of concurrent actors (e.g. two bot callbacks racing)
  BuggySnooze    \* TRUE = pre-fix unguarded UPDATE; FALSE = post-fix guarded UPDATE

VARIABLES
  status,        \* "PENDING" | "TAKEN" | "SKIPPED" - the intake_log row's status
  snoozed,       \* "NONE" | "SET" - whether snoozed_until has a value
  pc,            \* Actors -> "idle" | "silenceRead" | "done"
  badSnooze      \* TRUE iff a SilenceWrite ever took effect on a finalized intake

vars == <<status, snoozed, pc, badSnooze>>

Status  == {"PENDING", "TAKEN", "SKIPPED"}
SnoozeV == {"NONE", "SET"}
PCs     == {"idle", "silenceRead", "done"}

TypeOK ==
  /\ status \in Status
  /\ snoozed \in SnoozeV
  /\ pc \in [Actors -> PCs]
  /\ badSnooze \in BOOLEAN

Init ==
  /\ status = "PENDING"
  /\ snoozed = "NONE"
  /\ pc = [a \in Actors |-> "idle"]
  /\ badSnooze = FALSE

(***************************************************************************)
(* Step 1 of SilenceIntake: the domain layer reads the intake and sees    *)
(* PENDING. Corresponds to medicationService.SilenceIntake's GetIntake.    *)
(* From here the actor commits to issuing the snooze UPDATE.               *)
(***************************************************************************)
SilenceRead(a) ==
  /\ pc[a] = "idle"
  /\ status = "PENDING"
  /\ pc' = [pc EXCEPT ![a] = "silenceRead"]
  /\ UNCHANGED <<status, snoozed, badSnooze>>

(***************************************************************************)
(* Step 2: the SQL UPDATE.                                                  *)
(*                                                                          *)
(* In the FIXED version the WHERE clause makes the UPDATE a no-op when    *)
(* status has changed since SilenceRead. Domain code observes              *)
(* RowsAffected()==0 and returns ErrNotPending - no false success.        *)
(*                                                                          *)
(* In the BUGGY version (no WHERE-clause guard) the UPDATE always         *)
(* sets snoozed_until and reports success, even on a finalized intake.    *)
(* badSnooze records that this happened: the bot told the user the        *)
(* intake was silenced when in reality another action had finalized it.   *)
(***************************************************************************)
SilenceWrite(a) ==
  /\ pc[a] = "silenceRead"
  /\ pc' = [pc EXCEPT ![a] = "done"]
  /\ UNCHANGED status
  /\ \/ /\ status = "PENDING"                              \* legitimate snooze
        /\ snoozed' = "SET"
        /\ UNCHANGED badSnooze
     \/ /\ status \in {"TAKEN","SKIPPED"} /\ BuggySnooze   \* the TOCTOU bug fires
        /\ snoozed' = "SET"
        /\ badSnooze' = TRUE
     \/ /\ status \in {"TAKEN","SKIPPED"} /\ ~BuggySnooze  \* fix: WHERE clause filters
        /\ UNCHANGED <<snoozed, badSnooze>>

(***************************************************************************)
(* Atomic confirm and skip mirror their UPDATE ... WHERE status='PENDING'  *)
(* SQL statements - they execute in one shot at the database layer.       *)
(***************************************************************************)
Confirm(a) ==
  /\ pc[a] = "idle"
  /\ status = "PENDING"
  /\ status' = "TAKEN"
  /\ pc' = [pc EXCEPT ![a] = "done"]
  /\ UNCHANGED <<snoozed, badSnooze>>

Skip(a) ==
  /\ pc[a] = "idle"
  /\ status = "PENDING"
  /\ status' = "SKIPPED"
  /\ pc' = [pc EXCEPT ![a] = "done"]
  /\ UNCHANGED <<snoozed, badSnooze>>

Next ==
  \E a \in Actors :
    \/ SilenceRead(a)
    \/ SilenceWrite(a)
    \/ Confirm(a)
    \/ Skip(a)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Safety property the fix establishes:                                    *)
(*                                                                          *)
(*   No SilenceWrite ever takes effect on a finalized intake. The bot      *)
(*   never reports "Silenced 24h" for an intake that another action has    *)
(*   confirmed or skipped first.                                           *)
(*                                                                          *)
(* Note: a state where status \in {"TAKEN","SKIPPED"} AND snoozed = "SET" *)
(* is reachable even in the fixed model (silence first, then confirm/skip *)
(* later). That sequence is benign - snoozed_until is only consulted for  *)
(* PENDING rows. The bug is specifically the false-success report, which  *)
(* badSnooze captures.                                                    *)
(***************************************************************************)
NoFalseSilence == badSnooze = FALSE

==============================================================================
