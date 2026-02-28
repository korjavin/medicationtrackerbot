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

## Phase 2 (Complete): Server Decoupling

Migrated 12 delete call sites and 3 send call sites in `internal/server/` from direct `*bot.Bot` + `*webpush.Service` to `[]notifier.Notifier`, matching the scheduler pattern.

### What Changed

- **Server struct** — added `notifiers []notifier.Notifier` field, `SetNotifiers()` method, `deleteNotification()` and `notify()` helpers
- **`cmd/bot/main.go`** — calls `srv.SetNotifiers(notifiers)` after building the shared notifiers slice
- **12 delete sites** — all `if s.bot != nil { s.bot.DeleteMessage(msgID) }` replaced with `s.deleteNotification(ctx, msgID)`
- **3 send sites** — `webPush.SendBPReminderNotification()`, `webPush.SendEarlyIntakeConfirmation()`, `webPush.SendMedicationNotification()` replaced with `s.notify(ctx, notifier.Notification{...})`
- **2 bot-specific calls kept** — `bot.UpdateWorkoutMessage()` and `bot.StartWorkoutFlowFromWeb()` remain as direct `s.bot` calls (Telegram-interactive, not fire-and-forget)

### Files Modified

| File | Change |
|------|--------|
| `internal/server/server.go` | Added `notifiers` field, `SetNotifiers()`, `deleteNotification()`/`notify()` helpers; replaced 2 delete + 1 send sites |
| `internal/server/medication_handlers.go` | Replaced 3 delete + 1 send sites |
| `internal/server/bp_handlers.go` | Replaced 3 delete + 1 send sites |
| `internal/server/weight_handlers.go` | Replaced 3 delete sites |
| `internal/server/workout_handlers.go` | Replaced 3 delete sites (kept 2 bot-specific) |
| `cmd/bot/main.go` | Added `srv.SetNotifiers(notifiers)` call |

### Decision Log

- **Why `SetNotifiers()` instead of constructor param?** — The webpush.Service is created inside `server.New()`, but the WebPush notifier wraps it. Using a setter avoids the chicken-and-egg dependency.
- **Why keep `*bot.Bot` on Server?** — `UpdateWorkoutMessage` and `StartWorkoutFlowFromWeb` are inherently Telegram-interactive (editing inline keyboards, triggering reply chains). These don't fit the send/delete abstraction.
