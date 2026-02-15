# Trigger Next Intake Feature

## Overview
Added a "Take Now" button in the medication history section that allows users to take their next scheduled medication early. This is useful when you need to take medication earlier than planned (e.g., scheduled for 21:30 but going to sleep early) and want to avoid getting notifications later.

**Key improvement**: After triggering early intake, you receive a confirmation notification with a "Cancel" button - matching the same notification flow as time-triggered intakes!

## Implementation Details

### Backend Changes

**File: `/internal/server/medication_handlers.go`**
- Added `handleTriggerNextIntake()` function:
  - logic same as before but checks **next 12 hours**
- Added `handleGetNextIntake()` function:
  - Returns the next scheduled intake for the UI
  - Filters out already TAKEN/SKIPPED intakes
  - Returns 204 No Content if nothing found

**File: `/internal/server/server.go`**
- Registered new endpoints:
  - `POST /api/medications/trigger-next-intake`
  - `GET /api/medications/next-intake`
  - `POST /api/medications/cancel-intake`

### Frontend Changes

**File: `/web/static/index.html`**
- Added `<div id="next-intake-trigger">` container

**File: `/web/static/js/app.js`**
- **`renderNextIntakeTrigger()`**: 
  - Calls `GET /api/medications/next-intake`
  - Renders the card if API returns data
  - Shows "Take Now" button
  
- **`triggerNextIntake()`**:
  - Calls `POST /api/medications/trigger-next-intake`
  - Reloads history on success

### Telegram Bot
- Added `/next` command to trigger the notification flow manually

## User Experience

1. **Visual Display**:
   - Checks next 12 hours only
   - Uses backend logic for consistency
   - Shows "Next scheduled intake" card

**File: `/web/static/sw.js`**
- Added handling for `medication_early_confirmed` notification type
- **`handleCancelIntake()`**: Handles the cancel action button
  1. Calls `/api/medications/cancel-intake` with intake IDs
  2. Shows a new notification confirming the cancellation
  3. Sends message to all clients to refresh UI
- Cancel button reverts intake to PENDING, allowing scheduled notification to fire

## User Experience & Flows

### Flow 1: Normal Trigger
1. **Visual Display**: A prominent purple gradient card appears at the top of the history tab showing:
   - "Next scheduled intake" header
   - Medication name(s) and scheduled time
   - "Take Now" button

2. **Taking Medication Early**:
   - Click "Take Now" button
   - Medication is marked as taken at current time (not scheduled time)
   - **Confirmation notification appears** (web push/Telegram)
   - Pending scheduled notifications are cancelled
   - Success confirmation shows both scheduled and actual times
   - History refreshes to show the newly taken medication

3. **Confirmation Notification**:
   - Title: "✅ Medication taken early"
   - Body: "Aspirin 100mg (scheduled for 21:30)"
   - Action button: "Cancel (Undo)"

### Flow 2: Accidental Trigger → Cancel
1. User clicks "Take Now" by mistake
2. Receives confirmation notification
3. User clicks "Cancel (Undo)" button on notification
4. **Intake reverted to PENDING**
5. Inventory restored (incremented back)
6. **Scheduled notification will STILL fire** at 21:30
7. New notification appears: "Intake Cancelled - Your medication has been unmarked. The scheduled notification will still arrive."

### Flow 3: Time-Triggered Intake (Normal)
1. Scheduler creates PENDING intake at scheduled time
2. Sends both Telegram + Web Push notifications
3. User confirms via notification action button
4. Intake marked as TAKEN
5. **This confirmation cancels the pending notification** (as before)

## Smart Logic Summary

| Action | Intake Status | Scheduled Notification | Inventory |
|--------|--------------|----------------------|-----------|
| **Trigger Next Intake** | PENDING → TAKEN | ❌ Cancelled | -1 |
| **Cancel After Trigger** | TAKEN → PENDING | ✅ Will fire at scheduled time | +1 (restored) |
| **Time-Triggered Normal** | Creates PENDING → TAKEN when confirmed | ✅ Fires, then cancelled when confirmed | -1 when confirmed |
| **Ignore Time-Triggered** | PENDING → MISSED (after timeout) | ❌ Cancelled after timeout | No change |

## Technical Notes

- The backend creates or updates intake logs with `scheduled_at` = original time and `taken_at` = current time
- This preserves the schedule history while recording the actual intake time
- Inventory tracking is properly decremented on confirm, incremented on cancel
- All notification cleanup is handled automatically
- Cancel endpoint verifies ownership and only allows cancelling TAKEN intakes
- Reverting to PENDING allows the scheduler's normal flow to continue
- Web Push and Telegram notifications work in parallel for maximum reliability

## Use Cases

- **Going to bed early**: Take evening medications earlier to avoid notifications while sleeping
- **Travel**: Take medications before leaving to avoid missing them while traveling
- **Schedule changes**: Adapt to unexpected schedule changes without missing doses
- **Convenience**: Simple one-tap way to stay compliant when timing changes
- **Mistake recovery**: Easy undo if triggered by accident - scheduled notification still fires!
