---
# Add Diary Notes (Telegram /note + Web Section + MCP Access)

## Overview
Add a personal diary notes feature: users can add free-text notes via the Telegram /note command or via a new "Notes" section in the Health Overview web tab. Notes are timestamped and exposed via a new MCP tool so AI assistants can read mood/self-feeling context.

## Context
- Files involved: internal/store/migrations/, internal/store/store.go, internal/server/, internal/bot/, internal/mcp/tools.go, internal/mcp/mcp.go, web/static/js/app.js, web/static/index.html
- Related patterns: BP handler pattern (create/list/delete), bot food commands pattern, MCP get_sleep_logs tool pattern
- Dependencies: none new

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Database migration and store layer

**Files:**
- Create: `internal/store/migrations/040_add_diary_notes.sql`
- Modify: `internal/store/store.go`

- [x] Create migration 040 with diary_notes table: id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, content TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
- [x] Add DiaryNote struct to store.go with JSON tags
- [x] Add CreateDiaryNote(ctx, userID int64, content string) (*DiaryNote, error) method
- [x] Add ListDiaryNotes(ctx, userID int64, since time.Time, limit int) ([]DiaryNote, error) method
- [x] Add DeleteDiaryNote(ctx, userID, noteID int64) error method
- [x] Write store tests in internal/store/ using in-memory SQLite
- [x] run go test ./internal/store - must pass before task 2

### Task 2: HTTP handlers

**Files:**
- Create: `internal/server/notes_handlers.go`
- Modify: `internal/server/store_interfaces.go`
- Modify: `internal/server/server.go`

- [x] Define DiaryNotesStore narrow interface in store_interfaces.go with the three methods
- [x] Add DiaryNotesStore field to Server struct
- [x] Implement handleListNotes (GET /api/notes, query param ?limit=50)
- [x] Implement handleCreateNote (POST /api/notes, body: {content: string})
- [x] Implement handleDeleteNote (DELETE /api/notes/{id})
- [x] Register routes in server.go
- [x] Wire DiaryNotesStore in server constructor call (cmd/bot/main.go)
- [x] Write handler tests in internal/server/ using httptest
- [x] run go test ./internal/server - must pass before task 3

### Task 3: Telegram /note command

**Files:**
- Create: `internal/bot/note_commands.go`
- Modify: `internal/bot/bot.go`
- Modify: `internal/bot/handlers.go`

- [x] Define NoteStore narrow interface in bot package with CreateDiaryNote
- [x] Add NoteStore field to Bot struct
- [x] Implement handleNoteCommand: parse text after /note, save to store, reply "Note saved"
- [x] Register /note command in the message handler switch/dispatch
- [x] Wire NoteStore in bot constructor (cmd/bot/main.go)
- [x] Write bot note command test
- [x] run go test ./internal/bot - must pass before task 4

### Task 4: MCP tool get_diary_notes

**Files:**
- Modify: `internal/mcp/mcp.go`
- Modify: `internal/mcp/tools.go`

- [x] Add get_diary_notes tool registration in mcp.go with input schema: start_date, end_date, limit (optional, default 50)
- [x] Implement handleGetDiaryNotes in tools.go: resolve date range, query store, return array of {id, content, created_at}
- [x] Add DiaryNotesStore interface to MCP server struct (or extend existing store interface)
- [x] Write MCP tool test
- [x] run go test ./internal/mcp - must pass before task 5

### Task 5: Frontend notes section in Health Overview

**Files:**
- Modify: `web/static/js/app.js`
- Modify: `web/static/index.html`

- [x] Add notes section HTML in index.html inside the health overview tab panel: heading "My Notes", add-note textarea + save button, scrollable notes list
- [x] In app.js loadHealthOverview (or separate loadNotes function): fetch GET /api/notes and render list with timestamps
- [x] Implement addNote(): POST /api/notes with textarea content, clear textarea, refresh list
- [x] Implement deleteNote(id): DELETE /api/notes/:id, refresh list
- [x] Use DataStore.loadSWR with tags: ['notes'] for caching; invalidate on create/delete

### Task 6: Verify acceptance criteria

- [x] run go test ./...
- [x] run go vet ./...
- [x] manual smoke test (skipped - not automatable): /note command saves and bot replies; web section shows notes; MCP tool returns notes with timestamps

### Task 7: Update documentation

- [x] Add /note to bot commands section in README.md if one exists
- [x] Add DiaryNotes to CLAUDE.md database schema section
- [x] Add GET/POST/DELETE /api/notes to CLAUDE.md API endpoints table
- [x] Move this plan to docs/plans/completed/
