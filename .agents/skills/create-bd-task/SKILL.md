---
name: create-bd-task
description: Create and prioritize bd (beads) tasks/issues/epics for this project the way the maintainer expects. Trigger whenever the user asks to create, file, or add a bd task, issue, epic, or backlog item here — including "make a task for…", "add a bd issue…", "create an epic…".
---

# Creating bd tasks for this project

The user files a lot of bd tasks here and is tired of restating the house rules every time. Follow them whenever you create or modify a bd issue.

## Execution model (why the rules are what they are)

- An **orchestrator or agent picks tasks off the bd queue later** and executes them, often unsupervised. You are usually filling the backlog, not executing now.
- Because execution happens later, **the situation may have changed by then** — file layout, APIs, priorities. So a task written now should describe *intent and acceptance*, not a step-by-step plan that will be stale on arrival.

## Plan now, or don't

**Default: do NOT write a detailed step-by-step plan.** Just create a well-described issue (why it exists + what "done" looks like). The executor plans at execution time against the codebase as it exists then.

**Exception — plan now** when the user says "plan this now", "plan it now", "fully plan this", or otherwise signals the later execution will be **truly unsupervised** and can't stop to think. Then:

1. Write the plan to `docs/plans/YYYYMMDD-slug.md` (match the existing naming — date prefix + kebab slug; `docs/plans/completed/` holds finished ones).
2. Link the plan's path from the bd issue's `--design` (or `--notes`) field so the executor finds it.

## POC first, polish later

The user prioritizes getting a working proof-of-concept before hardening. Encode this on **both** axes:

- **Priority (P0–P4):** POC-path work gets high priority (P0–P1). Polish, hardening, edge cases, and nice-to-haves get low priority (P3–P4).
- **Label:** tag POC work `poc` and follow-up work `polish` (`--label`).

So the natural POC/polish split is one high-priority `poc` issue plus a low-priority `polish` follow-up (often `bd dep add <polish> <poc>` so polish stays blocked until the POC lands). Cloud mode (`cmd/cloud`) is the product; bot mode is legacy maintenance, so don't file bot-mode parity or backport work.

## Multi-user dolt sync — REQUIRED around every bd state change

bd runs in **multi-user mode** here, so local state goes stale. Any command that changes bd state (`create`, `update`, `close`, `dep add`, `remember`, …) must be bracketed with sync:

```bash
bd dolt pull                 # BEFORE: get fresh state
# ... bd create / update / close / dep add ...
bd dolt pull && bd dolt push # AFTER: reconcile, then publish
```

Skipping the pull-before risks acting on a stale queue; skipping the push-after strands your change on this machine.

## Recipe

```bash
bd dolt pull

# POC issue (high priority, poc label)
bd create --title="<what>" --type=feature|task|bug|epic --priority=1 --label=poc \
  --description="Why this exists + what done looks like. Intent, not step-by-step."

# Polish follow-up (low priority, polish label), optionally blocked on the POC
bd create --title="Polish: <what>" --type=task --priority=3 --label=polish \
  --description="..."
bd dep add <polish-id> <poc-id>

bd dolt pull && bd dolt push
```

Use `--parent=<epic-id>` for hierarchy (children inherit parent labels). Prefix (`med-`) is auto-assigned. Don't use `bd edit` — it opens $EDITOR and blocks agents.

## Don't

- Don't attach a detailed step-by-step plan unless the user asked to plan now (see above).
- Don't use TodoWrite / markdown TODO lists for tracking — bd only.
- Don't change bd state without the pull-before / pull-push-after bracket.
