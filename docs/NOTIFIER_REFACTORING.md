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
- **Why keep `*bot.Bot` on Server?** — `UpdateWorkoutMessage` and `StartWorkoutFlowFromWeb` are inherently Telegram-interactive (editing inline keyboards, triggering reply chains). These don't fit the send/delete abstraction. *(Resolved in Phase 3 via `WorkoutInteractor` interface.)*

---

## Phase 3 (Complete): Full Server Decoupling

Removed all `internal/bot` and `internal/webpush` imports from `internal/server/`. The server package now has zero knowledge of Telegram or WebPush implementation details.

### What Changed

- **`WorkoutInteractor` interface** — narrow interface in `server.go` with `UpdateWorkoutMessage()` and `StartWorkoutFlowFromWeb()`. `*bot.Bot` satisfies it implicitly.
- **`*bot.Bot` field removed** — replaced with `workout WorkoutInteractor` field + `SetWorkoutInteractor()` setter.
- **`*webpush.Service` creation moved** — from inside `server.New()` to `cmd/bot/main.go`. Server no longer creates or holds a webpush.Service.
- **`VAPIDConfig` struct removed** — replaced with a simple `vapidPublicKey string` field (only the public key is needed for the VAPID endpoint).
- **`GetWebPushService()` removed** — callers build webpush.Service and notifiers independently.
- **`bot.DeleteMessage()` call** — the direct call inside `handleStartWorkoutSession` replaced with `s.deleteNotification()` (consistent with Phase 2 pattern).
- **`server.New()` signature simplified** — removed `*bot.Bot` and `VAPIDConfig` params, added `vapidPublicKey string`.

### Files Modified

| File | Change |
|------|--------|
| `internal/server/server.go` | Defined `WorkoutInteractor` interface; removed `bot`/`webPush`/`vapidConfig` fields; added `workout`/`vapidPublicKey` fields; removed `VAPIDConfig` type, `GetWebPushService()`; added `SetWorkoutInteractor()`; updated `New()` signature; removed bot/webpush imports |
| `internal/server/workout_handlers.go` | Replaced `s.bot` → `s.workout`; used `s.deleteNotification()` for notification cleanup |
| `cmd/bot/main.go` | Created `webpush.Service` before server; updated `server.New()` call; added `srv.SetWorkoutInteractor(tgBot)` |
| `internal/server/*_test.go` (6 files) | Updated `New()` calls to match new signature |

### Import Verification

```
internal/server/ → zero imports of internal/bot or internal/webpush ✅
internal/scheduler/ → zero imports of internal/bot or internal/webpush ✅
```

The only packages that import `internal/bot` or `internal/webpush` are:
- `cmd/bot/main.go` — wiring layer (expected)
- `internal/notifier/` — adapter implementations (expected)
