# Consolidate Markdown Documentation into Two Primary Files

## Overview
Merge all overlapping markdown documentation into README.md (user-facing) and CLAUDE.md (contributors/AI agents). Delete the seven now-redundant files.

## Context
- Files to merge into README.md: `install.md`, `docs/installer.md`
- Files to merge into CLAUDE.md: `ARCHITECTURE.md`, `docs/TESTING_PATTERNS.md`, `docs/frontend-architecture.md`, `docs/mcp_setup.md`
- Files to keep: `README.md`, `CLAUDE.md`, `docs/plans/` (untouched)
- Orphaned images: `docs/img/` referenced by `docs/installer.md` — remove along with the source file
- Broken reference already in README.md + CLAUDE.md: `docs/WORKOUT_TRACKING.md` does not exist; fix as part of cleanup
- Content overlap inventory:
  - `ARCHITECTURE.md` duplicates the Architecture section in CLAUDE.md but adds: full API endpoint table, detailed data-flow diagrams, technical decisions rationale
  - `docs/frontend-architecture.md` is a completed refactor-tracking doc; its load-order list and global namespace table already appear in ARCHITECTURE.md → CLAUDE.md; rest is historical
  - `docs/TESTING_PATTERNS.md` is already a pointer-target from CLAUDE.md; full content can live inline
  - `docs/mcp_setup.md` is contributor/operator setup; belongs in CLAUDE.md
  - `install.md` and `docs/installer.md` both cover installation; installer.md is a superset of install.md; fold key steps into README.md Quick Start, drop the rest

## Development Approach
- Testing approach: N/A (documentation only, no code changes)
- Complete each task fully before moving to the next

## Implementation Steps

### Task 1: Merge ARCHITECTURE.md into CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`
- Delete: `ARCHITECTURE.md`

- [ ] Add to CLAUDE.md: full API endpoints table from ARCHITECTURE.md (currently absent)
- [ ] Add to CLAUDE.md: technical decisions section (SSE vs polling rationale, offline-write scope, IndexedDB as write-ahead queue, vanilla JS rationale)
- [ ] Add to CLAUDE.md: detailed data-flow diagrams (user action → offline path, page load SWR path)
- [ ] Verify all content unique to ARCHITECTURE.md is present in CLAUDE.md
- [ ] Delete ARCHITECTURE.md
- [ ] Remove reference to ARCHITECTURE.md in README.md (link in Local First bullet)

### Task 2: Merge docs/TESTING_PATTERNS.md into CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`
- Delete: `docs/TESTING_PATTERNS.md`

- [ ] Replace the "See docs/TESTING_PATTERNS.md" pointer in CLAUDE.md with the full inline content from that file
- [ ] Delete docs/TESTING_PATTERNS.md

### Task 3: Merge docs/frontend-architecture.md into CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`
- Delete: `docs/frontend-architecture.md`

- [ ] Review docs/frontend-architecture.md for any unique content not already in CLAUDE.md (load order, global namespace policy, modal architecture notes)
- [ ] The Global Namespace Policy table and script load order are already in ARCHITECTURE.md → being merged in Task 1; verify no duplication
- [ ] Delete docs/frontend-architecture.md (it is a completed refactor-tracking document; no unique surviving content)

### Task 4: Merge docs/mcp_setup.md into CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`
- Delete: `docs/mcp_setup.md`

- [ ] Add a "MCP Server Deployment" section to CLAUDE.md with the Docker Compose snippet, Pocket-ID client setup steps, and Claude Desktop config from docs/mcp_setup.md
- [ ] Delete docs/mcp_setup.md
- [ ] Update the reference in CLAUDE.md "See docs/mcp_setup.md" to the new inline section

### Task 5: Merge install.md + docs/installer.md into README.md

**Files:**
- Modify: `README.md`
- Delete: `install.md`, `docs/installer.md`, `docs/img/` (orphaned images)

- [ ] Expand README.md Quick Start section to include the full prerequisite list from install.md/installer.md (VPS requirements, domain A records, BotFather steps, Telegram User ID)
- [ ] Replace the simple wget one-liner in README.md with the current one from install.md (v0.1.7)
- [ ] Add the interactive walkthrough summary (install dir, domain, HTTPS, timezone, Telegram config, OIDC, Litestream)
- [ ] Add post-installation steps (Pocket-ID first-time setup, one-time-access-token command, OIDC client creation)
- [ ] Add troubleshooting section from docs/installer.md
- [ ] Remove the pointer links to install.md and docs/installer.md from README.md
- [ ] Delete install.md
- [ ] Delete docs/installer.md
- [ ] Delete docs/img/ directory (only referenced by the deleted file; verify no other references first)

### Task 6: Fix broken references and final cleanup

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] Remove broken link to `docs/WORKOUT_TRACKING.md` from README.md (file does not exist); replace with inline workout summary already present in README.md Features section
- [ ] Remove broken link to `docs/WORKOUT_TRACKING.md` from CLAUDE.md; incorporate the brief reference inline
- [ ] Audit README.md for any remaining links to deleted files
- [ ] Audit CLAUDE.md for any remaining links to deleted files
- [ ] Verify README.md reads coherently as a standalone user document
- [ ] Verify CLAUDE.md reads coherently as a standalone contributor/AI document

### Task 7: Move this plan to completed

- [ ] Move `docs/plans/2026-03-14-consolidate-markdown-documentation.md` to `docs/plans/completed/`
