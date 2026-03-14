# CORS Policy

## Overview
The application currently does **not** implement any specific Cross-Origin Resource Sharing (CORS) middleware or headers.

By default, without an explicit `Access-Control-Allow-Origin` header on responses, modern browsers will enforce the same-origin policy and prevent third-party websites from making cross-origin requests to this application's API.

## Why is this the correct default?
As a self-hosted, single-user application designed primarily as a Telegram Mini App and Progressive Web App (PWA), all valid frontend requests naturally originate from the same domain as the backend server.

Not defining CORS headers effectively prevents third-party origins from reading sensitive application data via cross-origin script access. (Note: CSRF protection is handled separately, such as via SameSite cookie attributes).

## Future Considerations
If integrations with third-party web domains or decoupled frontend architectures are required in the future, CORS headers will need to be explicitly configured.

If this happens, the implementation should:
- Use a strict whitelist of allowed origins (e.g., specific domains).
- **Never** use a wildcard (`*`) for authenticated endpoints.
- Require specific pre-flight handling (`OPTIONS` requests).
- Allow only necessary headers and methods (`GET`, `POST`, `PUT`, `DELETE`, etc.).