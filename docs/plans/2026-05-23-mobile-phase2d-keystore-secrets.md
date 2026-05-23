# Mobile Phase 2d: Keystore migration for provider secrets

## Status

Stub. Captured as a deferred follow-up to `docs/plans/2026-05-23-mobile-phase2c-firstrun-secrets.md`. **Do not start until Phase 2c has shipped to a real device and baked for at least one week without first-run regressions** — moving secrets out of SQLite is defense-in-depth, not a fix for a known incident. Until the real-device threat model contradicts the Phase 2c decision, this plan stays a stub.

## Overview

Phase 2c shipped the first-run setup overlay and explicitly decided to keep provider API keys (OpenAI, Food DB, ElevenLabs) in the SQLite `settings` table as plaintext. The threat-model justification (single-user device, app sandbox, no network exposure for the DB file) is captured in `docs/local-mode.md`'s "Secrets storage" subsection. This plan tracks the *future* migration to Android `EncryptedSharedPreferences` (and iOS Keychain when iOS ships) — a defense-in-depth step that is worth taking eventually but is not load-bearing today.

The migration changes the trust topology: the Capacitor shell owns the keys, the Go binary never persists them, and the frontend reads them via a native bridge on session start and forwards them via HTTP headers on AI-bound requests.

## Goals

- **Provider secrets at rest live in `EncryptedSharedPreferences`** (Android) — same backing the Phase 2a `SESSION_SECRET` uses (`androidx.security:security-crypto` under `MainActivity.kt`). Each key is a separate entry (`provider_openai_api_key_v1`, `provider_food_api_key_v1`, `provider_elevenlabs_api_key_v1`).
- **`MedtrackerNative.getProviderSecret(name)`** — `@JavascriptInterface` method on the existing native bridge, sticky across WebView navigations (per Phase 2a's constraint). Returns the decrypted value or empty string. iOS gets an equivalent bridge if/when iOS ships.
- **Frontend reads on session start** (via the bootstrap-warming path) and caches in JS memory for the lifetime of the WebView. Re-read on `appStateChange` resume.
- **AI-bound API calls forward via headers** (e.g. `X-Medtracker-Provider-OpenAI-Key`) on requests where the Go server needs the key — `/api/food/analyze`, `/api/elevenlabs/*`, etc. The server reads the header per-request rather than from `cfg.OpenAI.APIKey`.
- **Migration path** — on first launch after the Phase 2d binary ships, the Go server detects keys present in `settings` rows but no longer expected to be there (or vice versa), copies them up to the shell via a one-shot `POST /api/secrets/migrate-to-shell` (called by the shell on first launch after the upgrade), then wipes the SQLite values.

## Out of scope (intentional)

- iOS-specific Keychain wiring — captured here for design coherence, but the actual implementation lands with the iOS phase.
- Per-secret encryption strength tiers — `EncryptedSharedPreferences` defaults are sufficient.
- Multi-profile key namespacing — single-user device, no need.

## Approach (sketch)

1. Extend the native bridge in `capacitor/android-overlay/app/src/main/java/.../NativeBridge.kt` with `getProviderSecret(name)` / `setProviderSecret(name, value)`.
2. Update `web/static/js/features/settings/integrations.js` (and the firstrun integrations screen) to write secrets via the bridge when `Capacitor.isNativePlatform()` is true; otherwise continue using `PATCH /api/settings/integrations`.
3. Add a header-injection middleware on the frontend's `apiCall` wrapper that reads cached secrets and adds the headers to AI-bound requests.
4. Add a Go-side `headerOrSettings(r, cfg.OpenAI.APIKey, "X-Medtracker-Provider-OpenAI-Key")` helper that prefers the request header when present, falling back to the settings-table value (for the server build).
5. Add the one-shot migration endpoint and the corresponding shell-side bootstrap call.
6. Update `docs/local-mode.md`'s "Secrets storage" subsection to reflect the new state.

## Risks

- **Bridge fragility** — Phase 2a established that JS-side state must survive `loadUrl` navigations (`@JavascriptInterface` + inline shim). The provider-secret cache must follow the same pattern; a regression here would silently break AI features without surfacing an error.
- **Header forwarding leaks** — the Go server's access log must not include the new headers. Verify the access-log middleware redacts `X-Medtracker-Provider-*` by default.
- **Migration race** — the one-shot `/api/secrets/migrate-to-shell` call could race against a user editing settings in the UI. Gate the migration on a feature flag the shell sets only after `getProviderSecret` confirms the keys are persisted, and only wipe SQLite values after the next bootstrap confirms the headers are present.
- **Server-build regression** — the server build (Telegram deployment) must continue reading from `cfg.OpenAI.APIKey` unchanged. The header-fallback helper is mobile-only behavior; on server the header is never sent and the settings value wins.

## Estimate

About 1–2 weeks if scoped narrowly (Android only, OpenAI key only). +1 week if Food DB + ElevenLabs migrations land in the same PR. iOS Keychain wiring is bundled with whichever iOS phase ships.

## Open questions

- Does the bridge expose individual `getProviderSecret(name)` calls, or one `getProviderSecrets()` returning all of them in a single payload? Lean individual to keep cache invalidation per-key, but a single call is fewer JNI hops on launch.
- Should the header use a fixed name (`X-Medtracker-Provider-OpenAI-Key`) or a generic name (`X-Medtracker-Secret: openai_api_key=...`)? Lean fixed — easier to redact in the access log and easier to grep for.
- Do we want a "secrets export" UX in Settings for users who want to back up their keys manually? Out of scope for Phase 2d itself, but worth flagging.
- Does `android:allowBackup="false"` interact with `EncryptedSharedPreferences`? Confirm: backup excludes by default for encrypted preferences, but the manifest setting is still the simpler defense.
