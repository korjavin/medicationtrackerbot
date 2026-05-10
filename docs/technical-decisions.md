# Technical Decisions

## Why polling instead of SSE for change detection

SSE (Server-Sent Events) over HTTP/2 behind reverse proxies like Traefik and nginx is unreliable. When the server closes the stream it sends an HTTP/2 `RST_STREAM` frame that browsers surface as `ERR_HTTP2_PROTOCOL_ERROR`, causing spurious reconnection loops and error noise. Polling every 30 seconds with a cursor-based `GET /api/changes?since=` is lightweight (empty responses are ~50 bytes) and works reliably through any proxy stack.

## Why only three endpoints support offline writes

Adding offline write support requires: IndexedDB schema, optimistic UI rendering, conflict resolution on sync, and error handling for rejected writes. We limit this to the three most time-sensitive health actions (BP readings, weight logs, medication confirmations) where missing a data point is worse than the implementation complexity. Other writes (editing medications, creating workouts) are infrequent and can wait for connectivity.

## Why 5xx responses are treated as "offline"

When the app runs behind Traefik (or any reverse proxy), `navigator.onLine` stays `true` even when the backend Go process is down — the browser has a TCP connection to Traefik, just not to the app. HTTP 502/503/504 from the proxy are functionally identical to being offline, so the SW and sync layer treat them the same way: serve cached responses for reads, queue writes locally.

The frontend read-resilience helper `cachedFetch` (`web/static/js/cached-fetch.js`) inherits this policy via `isServerError` from `sync.js`: a 5xx falls through to the same cached-with-`isStale`-flag branch as a true offline read, and a missing cache raises `OfflineNoCacheError` for the consumer to render an explicit empty state. See [frontend.md → Local-First Read Resilience](frontend.md#local-first-read-resilience) for the full behaviour matrix and per-section freshness windows.

## Why IndexedDB is a write-ahead queue, not a full replica

After successful sync, records are deleted from IndexedDB rather than kept as "synced" copies. This keeps the local store small and avoids the complexity of bidirectional sync and conflict resolution. The SW cache and `api_cache` in IndexedDB already provide read-only offline access to previously fetched data.

## Why vanilla JS instead of a framework

The app is single-user, self-hosted, and runs primarily inside Telegram's WebView. A framework would add bundle size and build complexity for little benefit. The four-layer local-first architecture (SW → IndexedDB → SyncManager → SWR DataStore) is straightforward to implement with vanilla JS and Dexie.js.
