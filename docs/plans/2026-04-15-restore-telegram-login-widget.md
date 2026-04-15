# Restore Telegram Login Widget Using Redirect Mode

## Overview

The Telegram Login Widget was removed because the callback mode (`data-onauth`) requires `unsafe-eval` in CSP. Re-add the widget using redirect mode (`data-auth-url`), which sends auth data as URL query params via GET redirect - no eval needed, no CSP relaxation.

## Context

- Files involved: `internal/server/server.go`, `web/static/js/app.js`, `internal/server/auth.go`, `internal/server/auth_test.go`
- Root cause: commit 5c7e719 removed the widget because CSP blocked eval. The redirect flow avoids this entirely.
- The backend handler `handleTelegramCallback` exists but only accepts POST with JSON. Needs a GET path for redirect flow.
- `ValidateTelegramLoginWidget` in auth.go works for both flows (same hash algorithm).

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add GET handler for Telegram Login Widget redirect flow

**Files:**
- Modify: `internal/server/server.go`

- [x] Update `handleTelegramCallback` to accept both GET (redirect flow) and POST (existing callback flow)
- [x] For GET: parse `id`, `first_name`, `last_name`, `username`, `photo_url`, `auth_date`, `hash` from URL query parameters into `TelegramLoginData`
- [x] After successful validation and cookie set, respond with HTTP redirect (302) to `/` instead of JSON
- [x] Keep the existing POST path unchanged for backwards compatibility
- [x] Update CSP header: add `frame-src 'self' https://oauth.telegram.org` to allow the widget iframe
- [x] Write tests: GET with valid query params returns 302 + cookie, GET with invalid hash returns 401, GET with wrong user returns 403
- [x] Run project test suite - must pass before task 2

### Task 2: Re-add Telegram Login Widget with redirect mode in frontend

**Files:**
- Modify: `web/static/js/app.js`

- [ ] In the login screen section (around line 533), replace the "open in Telegram" hint with the Telegram Login Widget script injection
- [ ] Use redirect mode: `data-auth-url` pointing to `/auth/telegram/callback` instead of `data-onauth`
- [ ] Set attributes: `data-telegram-login` = `window.BOT_USERNAME`, `data-size` = `large`, `data-auth-url` = current origin + `/auth/telegram/callback`, `data-request-access` = `write`
- [ ] Keep the "Open in Telegram" link as a fallback below the widget (for users who prefer the native app)
- [ ] Remove the comment about unsafe-eval since redirect mode does not require it
- [ ] The existing `window.onTelegramAuth` callback function (lines 598-618) can be removed since we no longer use callback mode
- [ ] Run architecture tests to ensure no design token violations: `node web/static/js/tests/architecture.design-tokens.test.js`
- [ ] Run project test suite - must pass before task 3

### Task 3: Verify acceptance criteria

- [ ] Run full test suite: `go test ./...`
- [ ] Verify CSP header includes `frame-src` for oauth.telegram.org
- [ ] Verify the widget loads without CSP violations (no console errors about eval or frame blocking)
- [ ] Verify redirect flow: widget auth -> GET /auth/telegram/callback?params -> 302 to / -> authenticated session
