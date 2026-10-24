---
name: claude-design
description: Design or redesign the app's UI in the repo's UI kit (docs/design/claude-design/ui_kits/app-v2/) — brief, draw the frames as kit HTML, render and check them, get the owner's approval, then hand specs to the beads. Trigger on "design this screen / redesign X", "the UI drifted from the design", "use claude design", a UI bead that needs a design before a developer is spawned, or a claude.ai/design/p/<id> link (the older source of the kit).
---

# Design loop

**Since 2026-10-24 the designer draws the frames in the repo.** The owner decided that the
designer agent (Iris) does the design work herself: no brief pasted into claude.ai/design, no
round trip through DesignSync. Standalone Claude Design also closes on 2026-12-14. The kit in
`docs/design/claude-design/ui_kits/app-v2/` is now the source, not a frozen mirror.

## Project facts

- **Kit:** `docs/design/claude-design/INDEX.md` is the entry point. It covers what ships (only
  `tokens.css`, `components.css` and `icons.js`), the kit rules 1–8, the screen → spec → code
  table and the changelog. Screen ids (T1, F4, M2, BM1, …) are what beads cite.
- **Kit pages:** `screens-*.html` are spec only. `kit.css` / `kit.js` are presentation (phone
  frames, fake keyboard, board layout) and never ship.
- **Inputs:** `docs/design/CAPABILITIES.md`, `docs/design/UX-AUDIT.md`, briefs in
  `docs/design/briefs/`.
- **Real screenshots:** the `ios-visual` label / workflow artifacts (`ios-visual-390`,
  `ios-visual-440`: one PNG per screen, iPhone 16e and 17 Pro Max) show what ships. For
  real-data screens, ask the owner; don't fake them.
- **Older source:** the Claude Design project `medtrackerbot`
  (`bcedc9b7-2339-487d-9822-f69bb7a86608`) holds the original Wandergeek handoff and the inputs
  of the 2026-10 runs. Read it with DesignSync (`ToolSearch select:DesignSync`, `list_files` /
  `get_file`) only when you need something that isn't in the repo.

## The loop, per task

1. **Topic.** `design: <short name> <bead-id>` in the owner's channel (the designer works with
   the owner directly).
2. **Brief.** Write `docs/design/briefs/<name>.md`: what the feature does (link the bead or epic),
   the screens wanted with planned ids, which kit screens it sits next to, constraints (`wg-*` kit,
   390×844, dark only) and open UX questions, each with a recommended answer. Agree it with the
   owner in the topic. A one-screen tweak needs a few lines, not a file.
3. **Read before drawing.** The surface's current code (file:line), the neighbouring kit frames,
   and a current screenshot of the screen. Design against what ships.
4. **Draw.** Write `ui_kits/app-v2/screens-<name>.html` in the style of the existing pages:
   - the same `<head>` (tokens, components and kit CSS; icons and kit JS) and the `kit-top` nav,
     with the new page added to the nav of `index.html` too;
   - `kit-group` sections, one `kit-frame` per screen with a `data-screen-label`, iOS and Android
     phone frames where the platforms differ;
   - a caption per frame that says what it decides, and an "Answers to the open questions"
     section so the decisions sit next to the frames;
   - unused two-letter screen ids;
   - only kit components. A new component goes into `components.css` (and `components.html`)
     and is called out in INDEX. Page-only helpers go in the page's style block. Inline SVG
     colours in mock charts are presentation; say in INDEX what the code uses instead.
5. **Render and check.** Open the page with agent-browser at 390×844, screenshot each frame,
   and look at it: overflow, clipping, more than one sun control, native controls, status not
   on a token, wrong copy. Fix, then post the shots in the topic and ask the owner to approve.
6. **On approval, open a docs-only PR:** the page, the brief, and INDEX (a table row and a
   changelog entry with the decisions, especially any that change filed scope). Merge it with
   `gh pr merge --merge`. Worktree developers branch from `origin/master` and won't see the spec
   otherwise.
7. **Hand off.** Prepend `Spec: <screens-*.html> <screen ids>` to each UI bead (pass the text through a
   scratch file: backticks in a double-quoted bd argument get executed), remove `needs-spec`, run `bd dolt push`, and mention
   the architect and the platform orchestrators with the decisions that change their beads.
   For a large redesign the architect files the epic: every bead's description starts with the
   `Spec:` line, then the pain points it addresses, current code file:line, target, acceptance
   criteria and non-goals.
8. **Verify what ships.** Compare the PR's `ios-visual` screenshots with the frames before the
   orchestrator merges. Ask for shots of states the run doesn't cover. Accept existing layout the
   frame didn't mean to change.

## Gotchas and owner corrections

- **`/design-sync` (the bundled skill) is the wrong tool.** It uploads a component-library repo
  as a design system.
- **Don't fake real-data screenshots.** Ask the owner. Agent-made shots are fine for empty states.
- **Nothing private** goes into frames, briefs or the repo: no prod hostnames, tokens, bot
  handles or real user data.
- **No local frontend test runs** at any stage, including in subagent briefs.
- **Regressions the owner spots after a rollout** become new child beads under the same epic.
- **Code-side deviations** agreed with a developer (a control the code can't build, copy the
  code already has) go into the INDEX changelog as "code-side deltas", so the frames and the
  shipped app don't silently disagree.
- **Not the claude.ai Artifact "design" type** or design-system artifacts: the kit lives in the
  repo.
