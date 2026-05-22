# Mobile Phase 2b: Native plugin JS abstractions

## Status

Stub. Captured as a follow-up to `docs/plans/2026-05-22-mobile-phase2a-android-go-embedding.md`. **Do not start until 2a has shipped to a real device and baked for at least one week** — plugin work depends on having a working embedded shell to ride on.

## Overview

Phase 2a stands up the embedded Go binary inside an Android Capacitor shell and proves the WebView can talk to it over localhost. What it does not do is replace the web-platform APIs the frontend currently uses for camera, geolocation, barcode scanning, and local notifications. Those still flow through browser-style APIs that are either unreliable (BarcodeDetector is Chrome-only), low-fidelity (file-input camera), or unavailable on iOS in a WebView context (Web Push).

This plan introduces a thin JS abstraction layer in `web/static/js/native/` that the frontend code calls instead of touching the web platform directly. At runtime, the abstraction picks the right implementation: web for browsers, Capacitor for the mobile shell. Backend handlers (food upload, barcode lookup, tz endpoint, reminder enqueue) remain identical.

## Goals

- **Camera + photo picker** — `window.MediaCapture.takePhoto()` and `pickPhoto()`. Web impl uses `<input type=file>` + `getUserMedia`. Capacitor impl uses `@capacitor/camera`.
- **Geolocation** — `window.Geolocation.getCurrentPosition()`. Used by tz-detection. Web impl uses `navigator.geolocation`. Capacitor impl uses `@capacitor/geolocation`.
- **Barcode scanning** — `window.Barcode.scan()`. Web impl uses `BarcodeDetector` with ZXing JS fallback. Capacitor impl uses `@capacitor-mlkit/barcode-scanning` (native, fast, all phones — much higher accuracy than the web fallback).
- **Local notifications** — `window.Reminders.schedule(reminders)`. Web impl uses Web Push (existing path, unchanged for browser users). Capacitor impl polls `GET /api/reminders/upcoming` on foreground and hands the next N to `@capacitor/local-notifications`. The Go scheduler's `LocalNotificationSink` (shipped in Phase 1) already produces this queue.
- **Runtime selection** — `Capacitor.isNativePlatform()` picks the implementation at app startup. Single import surface in feature code; no per-feature branching.

## Out of scope (intentional)

- iOS support — Phase 2a is Android-only; iOS gets its own phase once 2a is mature.
- Anything that needs a Go-side change. The abstraction is pure frontend; the Go HTTP endpoints it consumes (`/api/food/...`, `/api/reminders/upcoming`, etc.) already exist.

## Approach (sketch)

1. Create `web/static/js/native/index.js` that exports `MediaCapture`, `Geolocation`, `Barcode`, `Reminders` after picking implementations based on `Capacitor?.isNativePlatform?.()`.
2. Implement web variants in `web/static/js/native/web/*.js` by lifting existing inline code from feature modules (no new behavior, just relocation behind the abstraction).
3. Implement Capacitor variants in `web/static/js/native/capacitor/*.js` calling the relevant Capacitor plugins.
4. Add `@capacitor/camera`, `@capacitor/geolocation`, `@capacitor-mlkit/barcode-scanning`, `@capacitor/local-notifications` to `capacitor/package.json`.
5. Refactor existing feature code (food scanner, food photo flow, tz prompt) to call the abstraction instead of platform APIs directly.
6. Wire the reminder-pre-schedule loop in the Capacitor shell: on `resume`, fetch `/api/reminders/upcoming?limit=64`, call `Reminders.schedule(...)`. On native-side notification tap, deep link into the relevant section via Capacitor's URL handling.

## Risks

- **`window.*` allowlist** — each abstraction adds a new global. Architecture test (`tests/architecture.globals.test.js`) needs entries with justification.
- **Permissions** — camera, geolocation, and notifications all require Android runtime permission dialogs. The first-run flow (Phase 2c) needs to coordinate which permissions to request when; for now, request lazily on first use of each feature.
- **MLKit binary size** — `@capacitor-mlkit/barcode-scanning` pulls in MLKit which can add 5–10 MB to the APK. Acceptable but worth measuring against the Task 1 numbers from 2a.
- **Notification accuracy under Doze** — Android's Doze mode can delay scheduled local notifications by minutes. Document the tolerance in the reminder UX. iOS later will have similar but stricter constraints.

## Estimate

About 2–3 weeks across ~4 PRs (one per capability), assuming Phase 2a has shipped and the embedded shell is stable. The single biggest task is the reminder pre-schedule loop — everything else is a straight port-behind-an-interface job.

## Open questions

- Should `Reminders.schedule` reconcile a server-side schedule diff (replace existing scheduled notifications when the queue changes) or always replace-all? Lean toward replace-all for simplicity; revisit if the user sees duplicate notifications.
- Does the barcode scanner abstraction expose a continuous-scan mode (for rapid product entry) or single-shot only? Lean single-shot; existing flow doesn't need continuous.
- Should the geolocation abstraction cache the last-known position to avoid permission prompts on every tz-detection tick? Lean yes, with a 1h TTL.
