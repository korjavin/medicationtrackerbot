# Notifier Interface Refactoring

## Phase 1 (Complete): Scheduler Decoupling

Introduced `internal/notifier/` package with a `Notifier` interface that abstracts notification sending/deleting. The scheduler now depends on `[]notifier.Notifier` instead of concrete `*bot.Bot` + `*webpush.Service` types.

### What Changed

- **New package** `internal/notifier/` — `Notifier` interface, `Notification`/`Action` types, `StripMarkdown` helper
- **`notifier.Telegram`** — wraps `*bot.Bot`, delegates to `SendMarkdownNotification()`/`DeleteMessage()`
- **`notifier.WebPush`** — wraps `*webpush.Service`, strips markdown for body, returns 0 for message ID
- **Scheduler** — uses `[]notifier.Notifier` with `notify()` (async) and `deleteNotification()` helpers
- **BP/Weight reminders** — iterate notifiers synchronously to preserve "at least one success" semantics
- **No DB migration** — message ID columns stay as `int`

### Interface

```go
type Notifier interface {
    Send(ctx context.Context, userID int64, n Notification) (int, error)
    Delete(ctx context.Context, userID int64, msgID int) error
}
```

---

## Phase 2 (Planned): Server Decoupling

### Goal

Replace direct `*bot.Bot` and `*webpush.Service` usage in `internal/server/` with `[]notifier.Notifier`, matching the pattern established in the scheduler.

### Current Server Usage

The server uses bot/webpush directly in these scenarios:

**1. Notification Deletion (most common — 12 call sites)**

When the user acts via the web UI, the server deletes the corresponding Telegram notification:

| File | Context |
|------|---------|
| `medication_handlers.go:121,258,382` | Confirming medication intake → delete reminder message |
| `bp_handlers.go:55,314,339` | Recording BP / snoozing / dismissing → delete BP reminder |
| `weight_handlers.go:64,293,316` | Recording weight / snoozing / dismissing → delete weight reminder |
| `workout_handlers.go:1172,1304,1424` | Starting / skipping / finishing workout → delete workout notification |
| `server.go:783,825` | Medication confirm-all / snooze callbacks → delete reminder |

All of these are simple `s.bot.DeleteMessage(msgID)` calls that map directly to `notifier.Delete()`.

**2. Notification Sending (3 call sites)**

| File | What it sends |
|------|---------------|
| `bp_handlers.go:362` | `webPush.SendBPReminderNotification()` — test BP reminder push |
| `medication_handlers.go:431` | `webPush.SendEarlyIntakeConfirmation()` — early intake confirmation push |
| `server.go:934` | `webPush.SendMedicationNotification()` — web-triggered medication reminder |

**3. Bot-Specific Methods (2 call sites)**

| File | What it does |
|------|--------------|
| `workout_handlers.go:1358` | `bot.UpdateWorkoutMessage()` — edit existing Telegram message in-place |
| `workout_handlers.go:1367` | `bot.StartWorkoutFlowFromWeb()` — trigger Telegram exercise-by-exercise flow |

These are Telegram-specific interactive features that don't map to the generic `Notifier` interface.

### Implementation Plan

**Step 1: Add `[]notifier.Notifier` to `Server` struct**

```go
type Server struct {
    store     *store.Store
    bot       *bot.Bot       // keep for bot-specific methods
    notifiers []notifier.Notifier
    // ...
}
```

**Step 2: Replace `DeleteMessage` calls**

Replace all 12 `s.bot.DeleteMessage(msgID)` calls with a server helper:

```go
func (s *Server) deleteNotification(ctx context.Context, userID int64, msgID int) {
    for _, nr := range s.notifiers {
        go func(nr notifier.Notifier) {
            _ = nr.Delete(ctx, userID, msgID)
        }(nr)
    }
}
```

**Step 3: Replace WebPush-only sends**

The 3 WebPush send calls need to go through the notifier loop. This requires building `notifier.Notification` structs with appropriate metadata:

- `SendBPReminderNotification` → same Notification struct as scheduler's `sendBPReminder`
- `SendEarlyIntakeConfirmation` → new Notification struct with early-intake metadata
- `SendMedicationNotification` → same Notification struct as scheduler's medication notification

**Step 4: Keep bot-specific methods as-is**

`UpdateWorkoutMessage()` and `StartWorkoutFlowFromWeb()` are Telegram-interactive features (editing messages, triggering exercise flow). These remain as direct `s.bot` calls. The `Notifier` interface is for fire-and-forget notifications, not interactive flows.

### What Does NOT Change in Phase 2

- `internal/bot/` — callback handlers, commands, exercise flow
- `internal/webpush/` — still used by server for `SendEarlyIntakeConfirmation` (or we add to Notifier)
- DB schema — no migration needed
- `internal/scheduler/` — already done in Phase 1

### Estimated Scope

- ~12 `DeleteMessage` → `deleteNotification` replacements (mechanical)
- ~3 WebPush send → `notifier.Notification` conversions
- 2 bot-specific calls stay unchanged
- Server struct gains `notifiers` field, `cmd/bot/main.go` passes it through
- Server tests may need mock notifier (same pattern as scheduler tests)

### Decision Log

- **Why keep `*bot.Bot` on Server?** — `UpdateWorkoutMessage` and `StartWorkoutFlowFromWeb` are inherently Telegram-interactive (editing inline keyboards, triggering reply chains). These don't fit the send/delete abstraction.
- **Why not Phase 2 now?** — Phase 1 covers the scheduler (where all automated notifications originate). Server notification usage is reactive (user-triggered deletions) and less critical for adding new channels.
