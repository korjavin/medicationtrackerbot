---
name: claude-design
description: Re-sync or redesign the app's UI with Claude Design (claude.ai/design) via the DesignSync tool. Feed the design project the app's current capabilities, a UX audit and screenshots; the owner redesigns there; once approved, mirror the result into docs/design/claude-design/, then architect files the beads and orchestrate delivers them. Trigger on "use claude design", "design this screen / redesign X", "the UI drifted from the design", "sync the design", a claude.ai/design/p/<id> link, or a UI bead that needs a design before a developer is spawned.
---

# Claude Design loop

This skill is based on one run in this repo: session `adcfedca` (2026-10-09), which produced epic `med-xso6`, App UI kit v2. That run copied an earlier run in german-conjuctions-trainer (`93e17ed9`, 2026-10-08). The owner's decisions on what those runs left open are at the end.

## Project facts (reuse these)

- **Design project:** `medtrackerbot`, id `bcedc9b7-2339-487d-9822-f69bb7a86608`, https://claude.ai/design/p/bcedc9b7-2339-487d-9822-f69bb7a86608.
  - It is `PROJECT_TYPE_PROJECT`, not a design system, and `canEdit` is true.
  - Root files hold the original Wandergeek handoff (`Medtracker.html`, `design_handoff_vitals/`, `Food Redesign.html`).
  - `current/` and `briefs/` hold the inputs from the 2026-10 run. `ui_kits/app-v2/` holds the approved kit.
- **Repo mirror:** `docs/design/claude-design/INDEX.md` is the entry point. It covers what ships (only `tokens.css`, `components.css` and `icons.js`), the kit rules, and a screen → spec → code table. Screen ids (T1, F4, M2, …) are what beads cite.
- **Inputs:** `docs/design/CAPABILITIES.md` and `docs/design/UX-AUDIT.md`, plus the older `docs/design/DESIGN.md` (Wandergeek).

## The loop

1. **Get access.** Load the tool with `ToolSearch select:DesignSync`.
   - If DesignSync answers "needs design-system authorization", ask the owner to run `/design-login`.
   - `list_projects` lists only design-system projects, so it won't show `medtrackerbot`. Use the id above, or ask the owner for the link. Check it with `get_project` and `list_files`.
2. **Snapshot what the app does now.** Have a background subagent write `docs/design/CAPABILITIES.md`, organised by surface.
   - Tag each item [H] (was in the original handoff) or [NEW] (added since).
   - End with a "Known visual debt" section that cites file paths.
   - Code is the source of truth. Include no hosts, emails or tokens.
3. **Collect screenshots.**
   - **Empty, onboarding and offline states:** a background subagent runs `go run ./cmd/cloud` locally on a scratch DB with agent-browser and a CDP virtual authenticator (passkeys work headless). Save to the scratchpad under `shots/`.
   - **Real-data screens:** the owner provides these. An empty vault looks bad, and the owner prefers to capture them rather than have them faked. Give the owner a numbered list of screens to capture at mobile size (see the message in `adcfedca`).
   - **Redact before upload:** connector URLs, private or prod hosts, bot handles and tokens. Check each image visually after redacting.
   - Rename shots to `NN-<screen>.png`.
4. **Write `docs/design/UX-AUDIT.md`.**
   - List the pain points P1–Pn and the options (A minimal / B recommended / C bolder).
   - End with a section headed "Ask for Claude Design" for the chosen option.
   - Show it to the owner. **The owner picks the option and approves the upload.** If the option conflicts with a CLAUDE.md rule, the owner decides; in this run the owner revoked rule 6.
5. **Upload, additive only.** Stage the files in a scratch `cd-bundle/`, then:
   - `DesignSync finalize_plan {projectId, writes:["current/**","briefs/**"], deletes:[], localDir:<bundle>}` returns a `planId`.
   - `DesignSync write_files {projectId, planId, files:[{path, localPath}]}`. `localPath` is relative to `localDir`.
   - Never delete or overwrite the original design files.
6. **The owner redesigns in the claude.ai/design web UI.** Claude Code does not drive the design agent; it hands over a paste-ready prompt. The prompt:
   - points the design agent at `briefs/UX-AUDIT.md`, `current/CAPABILITIES.md` and `current/screenshots/` (with `test-vault/` for the empty states), and at the original design in the root files;
   - asks for a critical review, then a kit for the chosen option at 390×844;
   - says where the output goes (`ui_kits/app-v2/`).

   Then wait for the owner to say it's approved.
7. **Mirror the approved design locally, in the main session.** Subagents have no DesignSync, so do this yourself.
   - Run `list_files`, then `get_file` for each file. Write each one verbatim into `docs/design/claude-design/…`.
   - Genericize any real bot handle or URL that appears in a file.
   - Write or update `INDEX.md`: what ships and what doesn't, the kit rules, and the screen → spec → code table.
8. **Merge the mirror first.** Put `docs/design/*` and any CLAUDE.md change in a docs-only PR and merge it. Worktree developers branch from `origin/master` and won't see the spec otherwise.
9. **File the beads.** Spawn the architect: `Agent`, `model: "fable"`, `architect` skill. The architect files one epic plus children.
   - Every bead's description starts with `Spec: <screens-*.html> <screen ids>` and the pain points it addresses, then current code file:line, the target, acceptance criteria and non-goals.
   - Label the epic `ui-kit-v2`; children inherit it.
   - The architect resolves open questions with recommended defaults and records them in the epic notes.
10. **Deliver.** Run `Skill orchestrate` on the epic. Developers read the local mirror; they never read Claude Design.

## Gotchas and owner corrections

- **`/design-sync` (the bundled skill) is the wrong tool for this.** It uploads a component-library repo as a design system. When it was offered, the owner corrected: "find the initial design in claude design… feed current capabilities… critically think… do this work in claude design… return a brief to claude code… (after I approve)". That is this loop.
- **Don't fake real-data screenshots.** Ask the owner for them. The agent's shots are fine for empty states.
- **Nothing private goes into the design project or the repo.** Never commit prod hostnames.
- **No local frontend test runs** at any stage, including in subagent briefs.
- **Regressions the owner spots after the rollout** become new child beads under the same epic, for example `med-xso6.34` and `.35`.

## Owner decisions (2026-10-11)

- **A single UI bead or small feature gets a short brief, not a full audit.**
  - Write `docs/design/briefs/<feature>.md`: what the feature does (link the bead or epic), the screens wanted, which kit v2 screens it sits next to (ids from `INDEX.md`), constraints (`wg-*` kit, 390×844) and open UX questions.
  - The owner approves it, then upload it to `briefs/` (step 5).
  - The owner designs it into `ui_kits/app-v2/` in the web UI, then mirror only the new or changed files (step 7).
  - Add `Spec: <file> <screen ids>` to the UI beads before a developer is claimed. Until then the orchestrator holds those beads.
- **DesignSync plus `medtrackerbot` is the only channel.** Don't use the claude.ai Artifact "design" type or design-system artifacts.
- **The mirror is frozen at approval.** Code-side kit changes are not pushed back to `ui_kits/app-v2/`.
- **Converting `medtrackerbot` into a design-system project:** later, as a separate task.
